/**
 * MyWineCorks license keys (SPEC §20). A key is
 *   MWC1.<base64url(JSON payload)>.<base64url(Ed25519 signature of the payload part)>
 * Signed only in HQ with the private key; verified everywhere with the public key(s).
 * Nothing here can extend or forge a key without the private key.
 */
import crypto from 'node:crypto';

export const LICENSE_MODULES = ['inventory', 'portal', 'ai'] as const;
export type LicenseModule = (typeof LICENSE_MODULES)[number];

export interface LicenseLimits {
  /** Bottles in stock (in stock + held); null = no limit. */
  bottles: number | null;
  ordersPerMonth: number | null;
  /** Active staff users. */
  users: number | null;
}

export interface LicensePayload {
  v: 1;
  /** License id (HQ). */
  lid: string;
  /** Client id and name (HQ). */
  cid: string;
  client: string;
  kind: 'selfhost' | 'cloud';
  plan: string;
  modules: LicenseModule[];
  limits: LicenseLimits;
  /** ISO times. */
  issuedAt: string;
  expiresAt: string;
  graceDays: number;
  /** Installation the key is bound to; null = not yet activated. */
  installId: string | null;
  /** Increments every time HQ re-issues the key (renewal, transfer…); newer wins. */
  serial: number;
}

const b64u = (b: Buffer) => b.toString('base64url');
export const PREFIX = 'MWC1';

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(`${PREFIX}.${body}`), crypto.createPrivateKey(privateKeyPem));
  return `${PREFIX}.${body}.${b64u(sig)}`;
}

export class LicenseError extends Error {
  constructor(public code: 'licenseMalformed' | 'licenseSignature' | 'licenseVersion') {
    super(code);
  }
}

/** Read a key (or a .mwclicense file's text) and check its signature against any trusted public key. */
export function verifyLicense(text: string, publicKeysPem: string[]): LicensePayload {
  const key = extractKey(text);
  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new LicenseError('licenseMalformed');
  const ok = publicKeysPem.some((pem) => {
    try {
      return crypto.verify(
        null,
        Buffer.from(`${parts[0]}.${parts[1]}`),
        crypto.createPublicKey(pem),
        Buffer.from(parts[2], 'base64url'),
      );
    } catch {
      return false;
    }
  });
  if (!ok) throw new LicenseError('licenseSignature');
  let p: LicensePayload;
  try {
    p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new LicenseError('licenseMalformed');
  }
  if (p.v !== 1) throw new LicenseError('licenseVersion');
  return p;
}

/** A .mwclicense file is JSON { key } (with a readable summary); a bare key is accepted too. */
export function extractKey(text: string): string {
  const s = String(text ?? '').trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s) as { key?: string };
      if (j.key) return j.key.trim();
    } catch {
      /* fall through */
    }
  }
  return s.replace(/\s+/g, '');
}

export function licenseFile(key: string, p: LicensePayload): string {
  return JSON.stringify(
    {
      product: 'MyWineCorks',
      client: p.client,
      plan: p.plan,
      modules: p.modules,
      expires: p.expiresAt.slice(0, 10),
      installId: p.installId,
      key,
    },
    null,
    2,
  );
}

export function newKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

// ---------------- state on an installation ----------------
export type LicenseState = 'unlicensed' | 'trial' | 'active' | 'grace' | 'locked';
export interface LicenseStatus {
  state: LicenseState;
  /** Why it is locked / warning, as i18n codes. */
  reason?: 'expired' | 'trialOver' | 'checkinMissed' | 'revoked' | 'wrongServer' | 'invalid';
  daysLeft: number | null;
  warnings: string[];
}
const DAY = 86400_000;
export const TRIAL_DAYS = 14;
export const CHECKIN_WARN_DAYS = 7;
export const CHECKIN_LOCK_DAYS = 30;

/**
 * State of an installation from its verified key (or none), install id, last successful check-in
 * and a revoked flag. Pure, so the server and tests use the same rules (SPEC §20.3, §20.4).
 */
export function licenseState(x: {
  payload: LicensePayload | null;
  invalid?: boolean;
  installId: string;
  installedAt: string;
  lastCheckinOk: string | null;
  revoked: boolean;
  now?: Date;
}): LicenseStatus {
  const now = (x.now ?? new Date()).getTime();
  const days = (iso: string) => Math.ceil((new Date(iso).getTime() - now) / DAY);
  if (x.invalid) return { state: 'locked', reason: 'invalid', daysLeft: null, warnings: [] };
  if (!x.payload) {
    const left = TRIAL_DAYS - Math.floor(Math.max(0, now - new Date(x.installedAt).getTime()) / DAY);
    return left > 0
      ? { state: 'trial', daysLeft: left, warnings: ['notActivated'] }
      : { state: 'locked', reason: 'trialOver', daysLeft: 0, warnings: [] };
  }
  const p = x.payload;
  if (x.revoked) return { state: 'locked', reason: 'revoked', daysLeft: null, warnings: [] };
  if (p.installId && p.installId !== x.installId)
    return { state: 'locked', reason: 'wrongServer', daysLeft: null, warnings: [] };
  const warnings: string[] = [];
  if (p.kind === 'selfhost') {
    const since = x.lastCheckinOk ?? x.installedAt;
    const missed = Math.floor((now - new Date(since).getTime()) / DAY);
    if (missed >= CHECKIN_LOCK_DAYS)
      return { state: 'locked', reason: 'checkinMissed', daysLeft: 0, warnings: [] };
    if (missed >= CHECKIN_WARN_DAYS) warnings.push('checkinLate');
  }
  const left = days(p.expiresAt);
  if (left > 0) {
    if (left <= 30) warnings.push('expiresSoon');
    return { state: 'active', daysLeft: left, warnings };
  }
  const graceLeft = left + p.graceDays;
  if (graceLeft > 0)
    return { state: 'grace', reason: 'expired', daysLeft: graceLeft, warnings: [...warnings, 'expired'] };
  return { state: 'locked', reason: 'expired', daysLeft: 0, warnings: [] };
}

/** Usage against the key's limits: warn at 90 %, block new ones at 100 % (SPEC §20.2). */
export function usage(limit: number | null, used: number) {
  if (limit == null) return { limit, used, pct: null as number | null, warn: false, full: false };
  const pct = limit ? Math.round((used / limit) * 100) : 100;
  return { limit, used, pct, warn: pct >= 90, full: used >= limit };
}
export * from './trusted.ts';
