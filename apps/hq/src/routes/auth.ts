/** HQ staff sign-in: password + 2-step verification (required for everyone), setup links. */
import { hash, verify } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  Api,
  COOKIE,
  HqError,
  SESSION_HOURS,
  bad,
  hqAudit,
  missing,
  sha256,
  token,
  type Staff,
} from '../http.ts';
import type { Request, Response } from 'express';
import type { Sql } from '../db.ts';

const totpOf = (secret: string, email: string) =>
  new OTPAuth.TOTP({
    issuer: 'MyWineCorks HQ',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
const okCode = (secret: string, email: string, code: string) =>
  totpOf(secret, email).validate({ token: code.replace(/\s/g, ''), window: 1 }) !== null;

export async function issueSetup(sql: Sql, staffId: number, publicUrl: string) {
  const t = token();
  await sql.q(
    "INSERT INTO staff_tokens (token_hash, staff_id, purpose, expires_at) VALUES ($1, $2, 'setup', now() + interval '7 days')",
    [sha256(t), staffId],
  );
  return `${publicUrl}/setup?t=${t}`;
}

export const meOf = (s: Staff, totpOk: boolean) => ({
  id: s.id,
  email: s.email,
  name: s.name,
  role: s.role,
  lang: s.lang,
  totpEnabled: !!s.totp_secret,
  needsTotp: !totpOk,
});

async function startSession(req: Request, res: Response, staff: Staff, totpOk: boolean) {
  const t = token();
  await req.hq.sql.q(
    `INSERT INTO staff_sessions (token_hash, staff_id, totp_ok, expires_at) VALUES ($1, $2, $3, now() + interval '${SESSION_HOURS} hours')`,
    [sha256(t), staff.id, totpOk],
  );
  res.cookie(COOKIE, t, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.hq.cfg.secureCookies,
    maxAge: SESSION_HOURS * 3600_000,
    path: '/',
  });
}

export function mountAuth(api: Api) {
  api.post('/auth/login', 'public', async (req, res) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase(), password: z.string(), code: z.string().optional() })
      .parse(req.body);
    const { sql } = req.hq;
    const s = await sql.one<Staff>('SELECT * FROM staff WHERE email = $1 AND active', [b.email]);
    if (!s || !s.pw_hash) throw new HqError(401, 'badLogin');
    if (s.locked_until && new Date(s.locked_until) > new Date()) throw new HqError(401, 'locked');
    if (!(await verify(s.pw_hash, b.password))) {
      await sql.q(
        "UPDATE staff SET failed_count = failed_count + 1, locked_until = CASE WHEN failed_count + 1 >= 5 THEN now() + interval '15 minutes' END WHERE id = $1",
        [s.id],
      );
      throw new HqError(401, 'badLogin');
    }
    let totpOk = false;
    if (s.totp_secret) {
      if (!b.code) throw new HqError(401, 'totpNeeded');
      if (!okCode(s.totp_secret, s.email, b.code)) throw new HqError(401, 'badCode');
      totpOk = true;
    }
    await sql.q('UPDATE staff SET failed_count = 0, locked_until = NULL, last_login = now() WHERE id = $1', [
      s.id,
    ]);
    await startSession(req, res, s, totpOk);
    req.hq.staff = s;
    await hqAudit(req, 'signedIn', { objType: 'staff', objId: s.id, objLabel: s.email });
    return meOf(s, totpOk);
  });

  api.post('/auth/logout', 'session', async (req, res) => {
    await req.hq.sql.q('DELETE FROM staff_sessions WHERE token_hash = $1', [req.hq.session!.tokenHash]);
    res.clearCookie(COOKIE, { path: '/' });
  });

  api.get('/me', 'session', (req) => meOf(req.hq.staff!, req.hq.session!.totpOk));

  api.get('/auth/setup', 'public', async (req) => {
    const t = String(req.query.t ?? '');
    const r = await req.hq.sql.one<{ email: string }>(
      'SELECT s.email FROM staff_tokens k JOIN staff s ON s.id = k.staff_id WHERE k.token_hash = $1 AND k.used_at IS NULL AND k.expires_at > now()',
      [sha256(t)],
    );
    if (!r) throw missing('setupLinkInvalid');
    return r;
  });

  api.post('/auth/setup', 'public', async (req, res) => {
    const b = z.object({ t: z.string(), password: z.string().min(12).max(200) }).parse(req.body);
    const { sql } = req.hq;
    const k = await sql.one<{ staff_id: number }>(
      'SELECT staff_id FROM staff_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [sha256(b.t)],
    );
    if (!k) throw missing('setupLinkInvalid');
    const s = await sql.tx(async (t) => {
      await t.q('UPDATE staff_tokens SET used_at = now() WHERE token_hash = $1', [sha256(b.t)]);
      await t.q('UPDATE staff SET pw_hash = $2, failed_count = 0, locked_until = NULL WHERE id = $1', [
        k.staff_id,
        await hash(b.password),
      ]);
      await t.q('DELETE FROM staff_sessions WHERE staff_id = $1', [k.staff_id]);
      return (await t.one<Staff>('SELECT * FROM staff WHERE id = $1', [k.staff_id]))!;
    });
    // Signed in, but 2-step verification must be set up (or entered) before anything else.
    await startSession(req, res, s, false);
    req.hq.staff = s;
    await hqAudit(req, 'passwordSet', { objType: 'staff', objId: s.id, objLabel: s.email });
    return meOf(s, false);
  });

  /** Start 2-step setup: a new secret and its QR code (only when not set yet). */
  api.post('/auth/totp/start', 'session', async (req) => {
    const s = req.hq.staff!;
    if (s.totp_secret) throw bad('totpAlreadyOn');
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await req.hq.sql.q('UPDATE staff SET totp_pending = $2 WHERE id = $1', [s.id, secret]);
    const uri = totpOf(secret, s.email).toString();
    return { secret, uri, qr: await QRCode.toString(uri, { type: 'svg', margin: 1 }) };
  });

  api.post('/auth/totp/confirm', 'session', async (req) => {
    const b = z.object({ code: z.string() }).parse(req.body);
    const s = req.hq.staff!;
    if (!s.totp_pending || !okCode(s.totp_pending, s.email, b.code)) throw bad('badCode');
    await req.hq.sql.q('UPDATE staff SET totp_secret = totp_pending, totp_pending = NULL WHERE id = $1', [
      s.id,
    ]);
    await req.hq.sql.q('UPDATE staff_sessions SET totp_ok = true WHERE token_hash = $1', [
      req.hq.session!.tokenHash,
    ]);
    await hqAudit(req, 'totpEnabled', { objType: 'staff', objId: s.id, objLabel: s.email });
    return meOf({ ...s, totp_secret: s.totp_pending }, true);
  });

  /** A signed-in session that has a 2-step code set up but was opened without it (after setup). */
  api.post('/auth/totp/verify', 'session', async (req) => {
    const b = z.object({ code: z.string() }).parse(req.body);
    const s = req.hq.staff!;
    if (!s.totp_secret || !okCode(s.totp_secret, s.email, b.code)) throw bad('badCode');
    await req.hq.sql.q('UPDATE staff_sessions SET totp_ok = true WHERE token_hash = $1', [
      req.hq.session!.tokenHash,
    ]);
    return meOf(s, true);
  });
}
