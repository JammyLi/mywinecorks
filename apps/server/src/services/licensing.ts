/**
 * License on a self-hosted installation (SPEC §20): installation id, activation, daily check-in,
 * state (trial / active / grace / locked) and limits. Kept in registry.db because it covers the
 * whole installation, not one workspace. Cloud workspaces are licensed by HQ directly (M6).
 */
import crypto from 'node:crypto';
import os from 'node:os';
import {
  TRUSTED_LICENSE_KEYS,
  LicenseError,
  extractKey,
  licenseState,
  usage,
  verifyLicense,
  type LicensePayload,
  type LicenseStatus,
} from '@mwc/license';
import { APP_VERSION } from '@mwc/shared';
import type { Config } from '../config.ts';
import type { Registry } from '../db/registry.ts';
import { ApiError, badRequest } from '../errors.ts';

interface Row {
  key: string | null;
  revoked: number;
  last_checkin_at: string | null;
  last_checkin_ok: string | null;
  last_error: string | null;
  latest_version: string | null;
  notice: string | null;
}

export interface LicenseInfo extends LicenseStatus {
  mode: Config['mode'];
  installId: string;
  installedAt: string;
  version: string;
  license: Omit<LicensePayload, 'v'> | null;
  checkin: { lastAt: string | null; lastOk: string | null; error: string | null };
  latestVersion: string | null;
  notice: string | null;
  usage: {
    bottles: ReturnType<typeof usage>;
    ordersPerMonth: ReturnType<typeof usage>;
    users: ReturnType<typeof usage>;
  };
  modules: string[];
}

/** A hardware fingerprint: changes when the server is copied to other hardware (SPEC §20.1). */
export function fingerprint() {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && a.mac && a.mac !== '00:00:00:00:00:00')
    .map((a) => a!.mac)
    .sort();
  return crypto
    .createHash('sha256')
    .update([os.hostname(), os.platform(), os.arch(), os.cpus()[0]?.model ?? '', ...new Set(macs)].join('|'))
    .digest('hex')
    .slice(0, 32);
}

export class Licensing {
  private keyCache = { at: 0, keys: [] as string[] };
  /** Trusted public keys; development keys are re-read now and then (the dev HQ creates its key on first start). */
  private get keys() {
    const now = Date.now();
    if (now - this.keyCache.at > 30_000)
      this.keyCache = { at: now, keys: [...TRUSTED_LICENSE_KEYS, ...this.cfg.devLicenseKeys()] };
    return this.keyCache.keys;
  }
  /** For tests: a fixed clock. */
  now: () => Date = () => new Date();
  /** For tests: replace the HTTP call to HQ. */
  fetcher: typeof fetch = (...a) => fetch(...a);

  constructor(
    private cfg: Config,
    private registry: Registry,
  ) {
    const db = registry.db;
    db.exec(`CREATE TABLE IF NOT EXISTS install (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      install_id TEXT NOT NULL,
      installed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS license (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key TEXT,
      revoked INTEGER NOT NULL DEFAULT 0,
      last_checkin_at TEXT,
      last_checkin_ok TEXT,
      last_error TEXT,
      latest_version TEXT,
      notice TEXT
    );`);
    if (!db.prepare('SELECT 1 FROM install').get())
      db.prepare('INSERT INTO install (id, install_id, installed_at) VALUES (1, ?, ?)').run(
        'I-' + crypto.randomBytes(9).toString('base64url').toUpperCase(),
        this.now().toISOString(),
      );
    db.prepare('INSERT OR IGNORE INTO license (id) VALUES (1)').run();
  }

  private install() {
    return this.registry.db.prepare('SELECT install_id, installed_at FROM install WHERE id = 1').get() as {
      install_id: string;
      installed_at: string;
    };
  }
  private row() {
    return this.registry.db.prepare('SELECT * FROM license WHERE id = 1').get() as Row;
  }
  private payload(): { p: LicensePayload | null; invalid: boolean } {
    const r = this.row();
    if (!r.key) return { p: null, invalid: false };
    try {
      return { p: verifyLicense(r.key, this.keys), invalid: false };
    } catch {
      return { p: null, invalid: true };
    }
  }

  /** Counts across every workspace on this installation. */
  counts() {
    let bottles = 0;
    let orders = 0;
    let users = 0;
    const month = this.now().toISOString().slice(0, 7);
    for (const t of this.registry.list()) {
      const db = this.registry.tenantDb(t.slug);
      bottles += (
        db.prepare("SELECT COUNT(*) n FROM bottles WHERE status IN ('in_stock','reserved')").get() as {
          n: number;
        }
      ).n;
      orders += (
        db.prepare('SELECT COUNT(*) n FROM orders WHERE substr(created_at, 1, 7) = ?').get(month) as {
          n: number;
        }
      ).n;
      users += (db.prepare('SELECT COUNT(*) n FROM users WHERE active = 1').get() as { n: number }).n;
    }
    return { bottles, ordersThisMonth: orders, users };
  }

  status(): LicenseStatus {
    if (this.cfg.mode === 'cloud') return { state: 'active', daysLeft: null, warnings: [] };
    const { p, invalid } = this.payload();
    const i = this.install();
    const r = this.row();
    return licenseState({
      payload: p,
      invalid,
      installId: i.install_id,
      installedAt: i.installed_at,
      lastCheckinOk: r.last_checkin_ok,
      revoked: !!r.revoked,
      now: this.now(),
    });
  }
  locked() {
    return this.status().state === 'locked';
  }

  info(): LicenseInfo {
    const st = this.status();
    const { p } = this.payload();
    const i = this.install();
    const r = this.row();
    const c = this.counts();
    const lim = p?.limits ?? { bottles: null, ordersPerMonth: null, users: null };
    let lic: LicenseInfo['license'] = null;
    if (p) {
      const { v, ...rest } = p;
      void v;
      lic = rest;
    }
    return {
      ...st,
      mode: this.cfg.mode,
      installId: i.install_id,
      installedAt: i.installed_at,
      version: APP_VERSION,
      license: lic,
      checkin: { lastAt: r.last_checkin_at, lastOk: r.last_checkin_ok, error: r.last_error },
      latestVersion: r.latest_version,
      notice: r.notice,
      usage: {
        bottles: usage(lim.bottles, c.bottles),
        ordersPerMonth: usage(lim.ordersPerMonth, c.ordersThisMonth),
        users: usage(lim.users, c.users),
      },
      modules: p?.modules ?? ['inventory'],
    };
  }

  /** Block new bottles / orders / users at 100 % of the key's limit (SPEC §20.2). */
  assertRoom(kind: 'bottles' | 'ordersPerMonth' | 'users', adding = 1) {
    if (this.cfg.mode === 'cloud') return;
    const { p } = this.payload();
    const limit = p?.limits[kind] ?? null;
    if (limit == null) return;
    const c = this.counts();
    const used = kind === 'bottles' ? c.bottles : kind === 'users' ? c.users : c.ordersThisMonth;
    if (used + adding > limit) throw new ApiError(403, 'licenseLimit', { kind, limit, used, adding });
  }

  hasModule(m: string) {
    return this.cfg.mode === 'cloud' || (this.payload().p?.modules ?? ['inventory']).includes(m as never);
  }

  private save(key: string) {
    this.registry.db.prepare('UPDATE license SET key = ?, revoked = 0 WHERE id = 1').run(key);
  }

  /** Owner pastes a key or uploads a .mwclicense file. An unbound key is bound through HQ. */
  async activate(text: string): Promise<LicenseInfo> {
    const key = extractKey(text);
    let p: LicensePayload;
    try {
      p = verifyLicense(key, this.keys);
    } catch (e) {
      throw badRequest(e instanceof LicenseError ? e.code : 'licenseMalformed');
    }
    if (p.kind !== 'selfhost') throw badRequest('licenseNotSelfhost');
    const { install_id } = this.install();
    if (p.installId && p.installId !== install_id)
      throw badRequest('licenseOtherServer', { installId: p.installId });
    const cur = this.payload().p;
    if (cur && cur.lid === p.lid && p.serial < cur.serial) throw badRequest('licenseOlder');
    if (!p.installId) {
      // First activation: HQ binds the key to this installation and returns the bound key.
      const r = await this.call('/api/license/activate', {
        key,
        installId: install_id,
        fingerprint: fingerprint(),
      });
      if (!r.ok || !r.body.key) throw badRequest(r.body.error ?? 'licenseActivateFailed');
      const bound = verifyLicense(r.body.key, this.keys);
      if (bound.installId !== install_id) throw badRequest('licenseActivateFailed');
      this.save(r.body.key);
      this.registry.db
        .prepare(
          'UPDATE license SET last_checkin_at = ?, last_checkin_ok = ?, last_error = NULL WHERE id = 1',
        )
        .run(this.now().toISOString(), this.now().toISOString());
    } else this.save(key);
    return this.info();
  }

  private async call(
    path: string,
    body: object,
  ): Promise<{
    ok: boolean;
    body: { error?: string; key?: string; status?: string; latestVersion?: string; notice?: string };
  }> {
    try {
      const res = await this.fetcher(this.cfg.hqUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      return { ok: res.ok, body: (await res.json().catch(() => ({}))) as never };
    } catch (e) {
      return { ok: false, body: { error: 'hqUnreachable', notice: (e as Error).message } };
    }
  }

  /**
   * Daily check-in ("phone home"): license id, installation, version and counts only —
   * never wine, customer or price data. Picks up renewed keys, revocations and update notices.
   */
  async checkin(): Promise<LicenseInfo> {
    if (this.cfg.mode === 'cloud') return this.info();
    const r = this.row();
    const { p } = this.payload();
    const at = this.now().toISOString();
    if (!p || !r.key) {
      this.registry.db.prepare('UPDATE license SET last_checkin_at = ? WHERE id = 1').run(at);
      return this.info();
    }
    const { install_id } = this.install();
    const res = await this.call('/api/license/checkin', {
      licenseId: p.lid,
      serial: p.serial,
      installId: install_id,
      fingerprint: fingerprint(),
      version: APP_VERSION,
      counts: this.counts(),
    });
    const db = this.registry.db;
    if (!res.ok) {
      db.prepare('UPDATE license SET last_checkin_at = ?, last_error = ? WHERE id = 1').run(
        at,
        res.body.error ?? 'hqError',
      );
      return this.info();
    }
    const b = res.body;
    db.prepare(
      'UPDATE license SET last_checkin_at = ?, last_checkin_ok = ?, last_error = NULL, latest_version = ?, notice = ? WHERE id = 1',
    ).run(at, at, b.latestVersion ?? null, b.notice ?? null);
    if (b.status === 'revoked' || b.status === 'duplicate')
      db.prepare('UPDATE license SET revoked = 1 WHERE id = 1').run();
    if (b.key) {
      try {
        const n = verifyLicense(b.key, this.keys);
        if (n.lid === p.lid ? n.serial >= p.serial : true) {
          if (!n.installId || n.installId === install_id) this.save(b.key);
        }
      } catch {
        db.prepare('UPDATE license SET last_error = ? WHERE id = 1').run('licenseSignature');
      }
    }
    return this.info();
  }

  /** At start-up, then every 24 h (retry hourly after a failure). */
  start() {
    if (this.cfg.mode === 'cloud') return () => {};
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      const i = await this.checkin().catch(() => this.info());
      timer = setTimeout(run, i.checkin.error ? 3600_000 : 24 * 3600_000);
      timer.unref();
    };
    timer = setTimeout(run, 5000);
    timer.unref();
    return () => clearTimeout(timer);
  }
}
