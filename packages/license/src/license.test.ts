import { describe, expect, it } from 'vitest';
import {
  licenseState,
  newKeyPair,
  signLicense,
  verifyLicense,
  licenseFile,
  usage,
  type LicensePayload,
} from './index.ts';

const k = newKeyPair();
const base: LicensePayload = {
  v: 1,
  lid: 'L-1',
  cid: 'C-1',
  client: '李氏酒窖',
  kind: 'selfhost',
  plan: 'inventory',
  modules: ['inventory'],
  limits: { bottles: 2000, ordersPerMonth: null, users: 5 },
  issuedAt: '2026-01-01T00:00:00Z',
  expiresAt: '2027-01-01T00:00:00Z',
  graceDays: 14,
  installId: 'I-1',
  serial: 1,
};

describe('license keys', () => {
  it('signs and verifies; any change breaks the signature', () => {
    const key = signLicense(base, k.privateKey);
    expect(verifyLicense(key, [k.publicKey]).client).toBe('李氏酒窖');
    expect(verifyLicense(licenseFile(key, base), [k.publicKey]).lid).toBe('L-1');
    const [a, body, sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ ...base, expiresAt: '2099-01-01T00:00:00Z' })).toString(
      'base64url',
    );
    expect(() => verifyLicense(`${a}.${forged}.${sig}`, [k.publicKey])).toThrow('licenseSignature');
    expect(() => verifyLicense(key, [newKeyPair().publicKey])).toThrow('licenseSignature');
    expect(() => verifyLicense('hello', [k.publicKey])).toThrow('licenseMalformed');
    void body;
  });

  it('active → expires soon → grace → locked; check-in and server rules', () => {
    const at = (iso: string) => new Date(iso);
    const s = (now: string, more: object = {}) =>
      licenseState({
        payload: base,
        installId: 'I-1',
        installedAt: '2026-01-01T00:00:00Z',
        lastCheckinOk: now,
        revoked: false,
        now: at(now),
        ...more,
      });
    expect(s('2026-06-01T00:00:00Z')).toMatchObject({ state: 'active', warnings: [] });
    expect(s('2026-12-20T00:00:00Z')).toMatchObject({ state: 'active', warnings: ['expiresSoon'] });
    expect(s('2027-01-05T00:00:00Z')).toMatchObject({ state: 'grace', daysLeft: 10 });
    expect(s('2027-01-16T00:00:00Z')).toMatchObject({ state: 'locked', reason: 'expired' });
    expect(s('2026-06-01T00:00:00Z', { lastCheckinOk: '2026-05-20T00:00:00Z' }).warnings).toContain(
      'checkinLate',
    );
    expect(s('2026-06-01T00:00:00Z', { lastCheckinOk: '2026-04-20T00:00:00Z' })).toMatchObject({
      state: 'locked',
      reason: 'checkinMissed',
    });
    expect(s('2026-06-01T00:00:00Z', { installId: 'I-2' })).toMatchObject({
      state: 'locked',
      reason: 'wrongServer',
    });
    expect(s('2026-06-01T00:00:00Z', { revoked: true })).toMatchObject({
      state: 'locked',
      reason: 'revoked',
    });
    expect(
      licenseState({
        payload: null,
        installId: 'I',
        installedAt: '2026-01-01T00:00:00Z',
        lastCheckinOk: null,
        revoked: false,
        now: at('2026-01-10T00:00:00Z'),
      }),
    ).toMatchObject({ state: 'trial', daysLeft: 5 });
    expect(
      licenseState({
        payload: null,
        installId: 'I',
        installedAt: '2026-01-01T00:00:00Z',
        lastCheckinOk: null,
        revoked: false,
        now: at('2026-01-20T00:00:00Z'),
      }),
    ).toMatchObject({ state: 'locked', reason: 'trialOver' });
  });

  it('usage warns at 90 % and blocks at 100 %', () => {
    expect(usage(null, 99)).toMatchObject({ warn: false, full: false });
    expect(usage(100, 89)).toMatchObject({ warn: false, full: false });
    expect(usage(100, 90)).toMatchObject({ warn: true, full: false });
    expect(usage(100, 100)).toMatchObject({ warn: true, full: true });
  });
});
