import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Me } from '@mwc/shared';
import { Api, AUTH, PUBLIC, SESSION, SESSION_COOKIE, SESSION_DAYS, actor, type UserRow } from '../http.ts';
import { nowIso, type DB } from '../db/registry.ts';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../errors.ts';
import { MIN_PASSWORD, hashPassword, newToken, sha256, verifyPassword } from '../services/crypto.ts';
import { audit } from '../services/audit.ts';
import { getRole, isAdminLike } from '../services/roles.ts';
import { checkTotp, newTotpSecret, totpSetupInfo } from '../services/totp.ts';
import { sendMail } from '../services/mail.ts';
import { issueSetupToken, setupUrl, SETUP_TOKEN_DAYS } from '../services/workspace.ts';

/** At most 3 reset emails per address per hour. */
const forgotLog = new Map<string, number[]>();

export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;

const LoginBody = z.object({
  workspace: z.string().trim().toLowerCase().optional(),
  email: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
  code: z.string().trim().optional(),
  client: z.enum(['web', 'mobile']).default('web'),
});

const SetupBody = z.object({
  workspace: z.string().trim().toLowerCase(),
  token: z.string().min(10),
  password: z.string(),
  name: z.string().trim().max(80).optional(),
});

export function mustUse2fa(req: Request, user: UserRow): boolean {
  const role = getRole(req.ctx.db!, user.role_id);
  return !!role && req.ctx.cfg.require2faAdmins && isAdminLike(role) && !user.totp_secret;
}

/** Which workspace a public request is for. Self-hosted servers have exactly one. */
function resolveWorkspace(req: Request, slug?: string) {
  const { cfg, registry } = req.ctx;
  let tenant = slug ? registry.get(slug) : undefined;
  if (!tenant && cfg.mode === 'selfhost') tenant = registry.list()[0];
  if (!tenant || tenant.status !== 'active') return undefined;
  return { tenant, db: registry.tenantDb(tenant.slug) };
}

function licenseSummary(req: Request): Me['license'] {
  const l = req.ctx.licensing;
  if (!l) return { state: 'active', daysLeft: null, warnings: [], modules: ['inventory', 'portal', 'ai'] };
  const s = l.status();
  return {
    state: s.state,
    reason: s.reason,
    daysLeft: s.daysLeft,
    warnings: s.warnings,
    modules: l.info().modules,
  };
}

export function meOf(req: Request): Me {
  const { user, role, tenant, session, cfg, db } = req.ctx;
  const company = JSON.parse(
    (db!.prepare("SELECT value FROM settings WHERE key = 'company'").get() as { value: string } | undefined)
      ?.value ?? '{}',
  );
  return {
    id: user!.id,
    email: user!.email,
    name: user!.name,
    lang: user!.lang === 'en' ? 'en' : 'zh-TW',
    totpEnabled: !!user!.totp_secret,
    mustEnrollTotp: !!session?.mustEnrollTotp,
    role: { id: role!.id, name: role!.name, isOwner: role!.isOwner, template: role!.template },
    permissions: role!.permissions,
    tenant: { slug: tenant!.slug, name: company.name || tenant!.name, mode: cfg.mode },
    license: licenseSummary(req),
  };
}

function setSessionCookie(req: Request, res: Response, slug: string, token: string) {
  res.cookie(SESSION_COOKIE, `${slug}.${token}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.ctx.cfg.secureCookies,
    maxAge: SESSION_DAYS * 86400_000,
    path: '/',
  });
}

function recordFailure(db: DB, user: UserRow, req: Request, reason: string) {
  const failed = user.failed_count + 1;
  const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null;
  db.prepare('UPDATE users SET failed_count = ?, locked_until = ? WHERE id = ?').run(
    lock ? 0 : failed,
    lock,
    user.id,
  );
  audit(
    db,
    { id: user.id, label: user.name || user.email, ip: req.ip },
    {
      category: 'auth',
      action: lock ? 'accountLocked' : 'signInFailed',
      objType: 'user',
      objId: user.id,
      objLabel: user.email,
      reason,
    },
  );
}

export function mountAuth(api: Api) {
  api.post('/auth/login', PUBLIC, async (req, res) => {
    const body = LoginBody.parse(req.body);
    const ws = resolveWorkspace(req, body.workspace);
    if (!ws) throw unauthorized('badLogin');
    const { db, tenant } = ws;
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(body.email) as
      UserRow | undefined;
    if (!user || !user.pw_hash) {
      await verifyPassword(null, body.password); // keep timing similar
      throw unauthorized('badLogin');
    }
    if (user.locked_until && user.locked_until > nowIso()) throw unauthorized('locked');
    if (!(await verifyPassword(user.pw_hash, body.password))) {
      recordFailure(db, user, req, 'password');
      throw unauthorized('badLogin');
    }
    if (user.totp_secret) {
      if (!body.code) throw unauthorized('totpNeeded');
      if (!checkTotp(user.totp_secret, body.code)) {
        recordFailure(db, user, req, 'totp');
        throw unauthorized('badCode');
      }
    }
    const role = getRole(db, user.role_id)!;
    // License locked: only the Owner may sign in, to renew or export (SPEC §20.4).
    if (req.ctx.install?.scope(tenant.slug).locked() && !role.isOwner)
      throw new ApiError(423, 'licenseLocked');
    if (body.client === 'web' && !role.permissions.access.backOffice) throw forbidden('noBackOffice');
    if (body.client === 'mobile' && !role.permissions.access.mobile) throw forbidden('noMobile');

    req.ctx = { ...req.ctx, db, tenant };
    const mustEnroll = mustUse2fa(req, user);
    const token = newToken();
    const now = nowIso();
    db.prepare(
      `INSERT INTO sessions (token_hash, user_id, client, must_enroll_totp, created_at, expires_at, last_seen, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha256(token),
      user.id,
      body.client,
      mustEnroll ? 1 : 0,
      now,
      new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(),
      now,
      String(req.headers['user-agent'] ?? '').slice(0, 200),
    );
    db.prepare('UPDATE users SET failed_count = 0, locked_until = NULL, last_login = ? WHERE id = ?').run(
      now,
      user.id,
    );
    audit(
      db,
      { id: user.id, label: user.name || user.email, ip: req.ip },
      {
        category: 'auth',
        action: 'signedIn',
        objType: 'user',
        objId: user.id,
        objLabel: user.email,
        changes: { client: body.client },
      },
    );
    setSessionCookie(req, res, tenant.slug, token);
    req.ctx.user = user;
    req.ctx.role = role;
    req.ctx.session = { tokenHash: sha256(token), client: body.client, mustEnrollTotp: mustEnroll };
    return meOf(req);
  });

  /**
   * "Forgot password?" — emails a one-time reset link when email is set up.
   * Always answers the same way, so it never reveals whether an address has an account.
   */
  api.post('/auth/forgot', PUBLIC, async (req) => {
    const body = z
      .object({
        workspace: z.string().trim().toLowerCase().optional(),
        email: z.string().trim().toLowerCase().min(3),
      })
      .parse(req.body);
    const { cfg } = req.ctx;
    if (!cfg.smtpUrl) return { ok: true, email: false };
    const ws = resolveWorkspace(req, body.workspace);
    const key = `${ws?.tenant.slug}|${body.email}`;
    const recent = (forgotLog.get(key) ?? []).filter((t) => t > Date.now() - 3600_000);
    if (ws && recent.length < 3) {
      forgotLog.set(key, [...recent, Date.now()]);
      const user = ws.db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(body.email) as
        UserRow | undefined;
      if (user) {
        const link = setupUrl(
          cfg.publicUrl,
          ws.tenant.slug,
          issueSetupToken(ws.db, user.id, user.pw_hash ? 'reset' : 'invite'),
        );
        const en = user.lang === 'en';
        const subject = en ? 'Reset your MyWineCorks password' : '重設你的 MyWineCorks 密碼';
        const text = en
          ? `Someone asked to reset the password for ${user.email}.\n\nOpen this link to choose a new password (works once, valid ${SETUP_TOKEN_DAYS} days):\n${link}\n\nIf this wasn't you, ignore this email — your password stays the same.`
          : `有人要求重設 ${user.email} 的密碼。\n\n請開啟以下連結設定新密碼（只能使用一次，${SETUP_TOKEN_DAYS} 天內有效）：\n${link}\n\n如果不是你本人，請忽略這封信，密碼不會改變。`;
        const sent = await sendMail(cfg, user.email, subject, text);
        audit(
          ws.db,
          { id: user.id, label: user.name || user.email, ip: req.ip },
          {
            category: 'auth',
            action: 'resetRequested',
            objType: 'user',
            objId: user.id,
            objLabel: user.email,
            changes: { emailSent: sent },
          },
        );
      }
    }
    return { ok: true, email: true };
  });

  api.post('/auth/logout', PUBLIC, (req, res) => {
    const { db, session, user } = req.ctx;
    if (db && session) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
      audit(db, actor(req), {
        category: 'auth',
        action: 'signedOut',
        objType: 'user',
        objId: user!.id,
        objLabel: user!.email,
      });
    }
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Public: check a setup link before showing the form. */
  api.get('/auth/setup', PUBLIC, (req) => {
    const ws = resolveWorkspace(req, String(req.query.w ?? ''));
    const token = String(req.query.t ?? '');
    const row = ws && findSetupToken(ws.db, token);
    if (!ws || !row) throw notFound('tokenInvalid');
    const user = ws.db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.user_id) as {
      email: string;
      name: string;
    };
    return { email: user.email, name: user.name, purpose: row.purpose, workspace: ws.tenant.slug };
  });

  api.post('/auth/setup', PUBLIC, async (req) => {
    const body = SetupBody.parse(req.body);
    if (body.password.length < MIN_PASSWORD) throw badRequest('passwordShort');
    const ws = resolveWorkspace(req, body.workspace);
    const row = ws && findSetupToken(ws.db, body.token);
    if (!ws || !row) throw notFound('tokenInvalid');
    const hash = await hashPassword(body.password);
    ws.db.transaction(() => {
      ws.db
        .prepare('UPDATE setup_tokens SET used_at = ? WHERE token_hash = ?')
        .run(nowIso(), sha256(body.token));
      ws.db
        .prepare(
          `UPDATE users SET pw_hash = ?, failed_count = 0, locked_until = NULL, updated_at = ?
           ${body.name ? ', name = ?' : ''} WHERE id = ?`,
        )
        .run(
          ...([hash, nowIso(), ...(body.name ? [body.name] : []), row.user_id] as [
            string,
            string,
            ...unknown[],
          ]),
        );
      // A password reset ends all existing sessions.
      ws.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      const u = ws.db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.user_id) as {
        email: string;
        name: string;
      };
      audit(
        ws.db,
        { id: row.user_id, label: u.name || u.email, ip: req.ip },
        {
          category: 'auth',
          action: row.purpose === 'invite' ? 'accountSetUp' : 'passwordReset',
          objType: 'user',
          objId: row.user_id,
          objLabel: u.email,
        },
      );
    })();
    return { ok: true, workspace: ws.tenant.slug };
  });

  api.get('/me', SESSION, (req) => meOf(req));

  api.patch('/me', SESSION, (req) => {
    const body = z
      .object({ name: z.string().trim().max(80).optional(), lang: z.enum(['zh-TW', 'en']).optional() })
      .parse(req.body);
    const { db, user } = req.ctx;
    db!
      .prepare(
        'UPDATE users SET name = COALESCE(?, name), lang = COALESCE(?, lang), updated_at = ? WHERE id = ?',
      )
      .run(body.name ?? null, body.lang ?? null, nowIso(), user!.id);
    req.ctx.user = db!.prepare('SELECT * FROM users WHERE id = ?').get(user!.id) as UserRow;
    return meOf(req);
  });

  api.post('/me/password', AUTH, async (req) => {
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const { db, user, session } = req.ctx;
    if (!(await verifyPassword(user!.pw_hash, body.current))) throw badRequest('badLogin');
    if (body.next.length < MIN_PASSWORD) throw badRequest('passwordShort');
    db!
      .prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?')
      .run(await hashPassword(body.next), nowIso(), user!.id);
    // Keep this session, end all others.
    db!
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .run(user!.id, session!.tokenHash);
    audit(db!, actor(req), {
      category: 'auth',
      action: 'passwordChanged',
      objType: 'user',
      objId: user!.id,
      objLabel: user!.email,
    });
    return { ok: true };
  });

  api.post('/me/totp/setup', SESSION, async (req) => {
    const { db, user, tenant } = req.ctx;
    if (user!.totp_secret) throw badRequest('totpAlreadyOn');
    const secret = newTotpSecret();
    db!.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(secret, user!.id);
    return totpSetupInfo(secret, `${user!.email} (${tenant!.slug})`);
  });

  api.post('/me/totp/enable', SESSION, (req) => {
    const { code } = z.object({ code: z.string().trim() }).parse(req.body);
    const { db, user, session } = req.ctx;
    const pending = (
      db!.prepare('SELECT totp_pending FROM users WHERE id = ?').get(user!.id) as {
        totp_pending: string | null;
      }
    ).totp_pending;
    if (!pending) throw badRequest();
    if (!checkTotp(pending, code)) throw badRequest('badCode');
    db!
      .prepare('UPDATE users SET totp_secret = ?, totp_pending = NULL, updated_at = ? WHERE id = ?')
      .run(pending, nowIso(), user!.id);
    db!.prepare('UPDATE sessions SET must_enroll_totp = 0 WHERE token_hash = ?').run(session!.tokenHash);
    audit(db!, actor(req), {
      category: 'auth',
      action: 'totpEnabled',
      objType: 'user',
      objId: user!.id,
      objLabel: user!.email,
    });
    req.ctx.user = db!.prepare('SELECT * FROM users WHERE id = ?').get(user!.id) as UserRow;
    req.ctx.session = { ...session!, mustEnrollTotp: false };
    return meOf(req);
  });

  api.post('/me/totp/disable', AUTH, async (req) => {
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const { db, user, role, cfg } = req.ctx;
    if (cfg.require2faAdmins && isAdminLike(role!)) throw forbidden('totpRequiredForRole');
    if (!(await verifyPassword(user!.pw_hash, password))) throw badRequest('badLogin');
    db!
      .prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL, updated_at = ? WHERE id = ?')
      .run(nowIso(), user!.id);
    audit(db!, actor(req), {
      category: 'auth',
      action: 'totpDisabled',
      objType: 'user',
      objId: user!.id,
      objLabel: user!.email,
    });
    return { ok: true };
  });

  api.post('/me/sign-out-others', AUTH, (req) => {
    const { db, user, session } = req.ctx;
    const n = db!
      .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')
      .run(user!.id, session!.tokenHash).changes;
    audit(db!, actor(req), {
      category: 'auth',
      action: 'signedOutOthers',
      objType: 'user',
      objId: user!.id,
      objLabel: user!.email,
      changes: { sessions: n },
    });
    return { ok: true, ended: n };
  });
}

function findSetupToken(db: DB, token: string) {
  if (!token) return undefined;
  return db
    .prepare('SELECT * FROM setup_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .get(sha256(token), nowIso()) as { user_id: number; purpose: 'invite' | 'reset' } | undefined;
}
