import { z } from 'zod';
import { MODULES, VISIBILITY, type Permissions, type Role, sanitizePermissions } from '@mwc/shared';
import { Api, OWNER, actor, perm, type UserRow } from '../http.ts';
import { nowIso, type DB } from '../db/registry.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { audit, diff } from '../services/audit.ts';
import { getRole, listRoles } from '../services/roles.ts';
import { issueSetupToken, setupUrl } from '../services/workspace.ts';

/** True if every permission in `p` is also held by `holder` (prevents granting more than you have). */
export function isSubset(p: Permissions, holder: Permissions): boolean {
  for (const m of Object.keys(MODULES) as (keyof typeof MODULES)[]) {
    const mine = new Set<string>((holder.functions[m] as string[] | undefined) ?? []);
    for (const a of (p.functions[m] as string[] | undefined) ?? []) if (!mine.has(a)) return false;
  }
  for (const v of VISIBILITY) if (p.visibility[v] && !holder.visibility[v]) return false;
  if (holder.locationScope !== 'all') {
    if (p.locationScope === 'all') return false;
    if (p.locationScope.some((c) => !(holder.locationScope as number[]).includes(c))) return false;
  }
  return true;
}

const publicUser = (u: UserRow, roleName?: string) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  roleId: u.role_id,
  roleName,
  lang: u.lang,
  active: !!u.active,
  invited: !u.pw_hash,
  totpEnabled: !!u.totp_secret,
  lastLogin: u.last_login,
  createdAt: u.created_at,
});

function activeOwnerCount(db: DB, exceptUserId?: number) {
  return (
    db
      .prepare(
        'SELECT COUNT(*) n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_owner = 1 AND u.active = 1 AND u.id <> ?',
      )
      .get(exceptUserId ?? 0) as { n: number }
  ).n;
}

/** Non-owners may only hand out roles that do not exceed their own permissions. */
function checkAssignable(actorRole: Role, target: Role) {
  if (actorRole.isOwner) return;
  if (target.isOwner || !isSubset(target.permissions, actorRole.permissions)) throw forbidden('roleTooHigh');
}

export function mountUsers(api: Api) {
  api.get('/users', perm('users', 'view'), (req) => {
    const db = req.ctx.db!;
    const roles = new Map(listRoles(db).map((r) => [r.id, r.name]));
    const rows = db.prepare('SELECT * FROM users ORDER BY active DESC, name, email').all() as UserRow[];
    return rows.map((u) => publicUser(u, roles.get(u.role_id)));
  });

  api.post('/users', perm('users', 'manage'), (req) => {
    const body = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().max(80).default(''),
        roleId: z.number().int(),
        lang: z.enum(['zh-TW', 'en']).default('zh-TW'),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const role = getRole(db, body.roleId);
    if (!role) throw badRequest();
    checkAssignable(req.ctx.role!, role);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email)) throw conflict('emailTaken');
    let id = 0;
    let token = '';
    db.transaction(() => {
      id = Number(
        db
          .prepare('INSERT INTO users (email, name, role_id, lang, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(body.email, body.name, body.roleId, body.lang, nowIso()).lastInsertRowid,
      );
      token = issueSetupToken(db, id, 'invite');
      audit(db, actor(req), {
        category: 'users',
        action: 'userInvited',
        objType: 'user',
        objId: id,
        objLabel: body.email,
        changes: { name: body.name, role: role.name, lang: body.lang },
      });
    })();
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return {
      user: publicUser(u, role.name),
      setupUrl: setupUrl(req.ctx.cfg.publicUrl, req.ctx.tenant!.slug, token),
    };
  });

  api.patch('/users/:id', perm('users', 'manage'), (req) => {
    const body = z
      .object({
        name: z.string().trim().max(80).optional(),
        roleId: z.number().int().optional(),
        lang: z.enum(['zh-TW', 'en']).optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    const me = req.ctx.user!;
    const myRole = req.ctx.role!;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id)) as
      UserRow | undefined;
    if (!u) throw notFound();
    const curRole = getRole(db, u.role_id)!;
    if (curRole.isOwner && !myRole.isOwner) throw forbidden('ownerLocked');
    const newRole = body.roleId !== undefined ? getRole(db, body.roleId) : curRole;
    if (!newRole) throw badRequest();
    if (body.roleId !== undefined && body.roleId !== u.role_id) checkAssignable(myRole, newRole);
    if (body.active === false && u.id === me.id) throw badRequest('cannotDeactivateSelf');
    const losingOwner = curRole.isOwner && (body.active === false || !newRole.isOwner);
    if (losingOwner && activeOwnerCount(db, u.id) === 0) throw conflict('lastOwner');

    const next = {
      name: body.name ?? u.name,
      role_id: newRole.id,
      lang: body.lang ?? u.lang,
      active: body.active === undefined ? u.active : body.active ? 1 : 0,
    };
    db.transaction(() => {
      db.prepare(
        'UPDATE users SET name = ?, role_id = ?, lang = ?, active = ?, updated_at = ? WHERE id = ?',
      ).run(next.name, next.role_id, next.lang, next.active, nowIso(), u.id);
      // Deactivation or a role change ends the user's sessions immediately.
      if (next.active === 0 || next.role_id !== u.role_id)
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      const changes = diff(
        { name: u.name, role: curRole.name, lang: u.lang, active: !!u.active },
        { name: next.name, role: newRole.name, lang: next.lang, active: !!next.active },
      );
      if (Object.keys(changes).length)
        audit(db, actor(req), {
          category: 'users',
          action: 'userUpdated',
          objType: 'user',
          objId: u.id,
          objLabel: u.email,
          changes,
        });
    })();
    return publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as UserRow, newRole.name);
  });

  /** New one-time setup link (invite again or reset password). */
  api.post('/users/:id/setup-link', perm('users', 'manage'), (req) => {
    const db = req.ctx.db!;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id)) as
      UserRow | undefined;
    if (!u) throw notFound();
    if (getRole(db, u.role_id)!.isOwner && !req.ctx.role!.isOwner) throw forbidden('ownerLocked');
    const token = issueSetupToken(db, u.id, u.pw_hash ? 'reset' : 'invite');
    audit(db, actor(req), {
      category: 'users',
      action: 'setupLinkIssued',
      objType: 'user',
      objId: u.id,
      objLabel: u.email,
    });
    return { setupUrl: setupUrl(req.ctx.cfg.publicUrl, req.ctx.tenant!.slug, token) };
  });

  api.post('/users/:id/sign-out-all', perm('users', 'manage'), (req) => {
    const db = req.ctx.db!;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id)) as
      UserRow | undefined;
    if (!u) throw notFound();
    if (getRole(db, u.role_id)!.isOwner && !req.ctx.role!.isOwner) throw forbidden('ownerLocked');
    const n = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id).changes;
    audit(db, actor(req), {
      category: 'users',
      action: 'userSignedOutEverywhere',
      objType: 'user',
      objId: u.id,
      objLabel: u.email,
      changes: { sessions: n },
    });
    return { ok: true, ended: n };
  });

  // ---------- Roles ----------
  const RoleBody = z.object({ name: z.string().trim().min(1).max(60), permissions: z.unknown() });

  api.get('/roles', perm('roles', 'view'), (req) => listRoles(req.ctx.db!));

  api.post('/roles', perm('roles', 'manage'), (req) => {
    const body = RoleBody.extend({ template: z.string().nullish() }).parse(req.body);
    const db = req.ctx.db!;
    const p = sanitizePermissions(body.permissions);
    if (!req.ctx.role!.isOwner && !isSubset(p, req.ctx.role!.permissions)) throw forbidden('roleTooHigh');
    if (db.prepare('SELECT 1 FROM roles WHERE name = ?').get(body.name)) throw conflict('roleNameTaken');
    const id = Number(
      db
        .prepare(
          'INSERT INTO roles (name, template, is_owner, permissions, created_at) VALUES (?, ?, 0, ?, ?)',
        )
        .run(body.name, null, JSON.stringify(p), nowIso()).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'roles',
      action: 'roleCreated',
      objType: 'role',
      objId: id,
      objLabel: body.name,
      changes: { permissions: p },
    });
    return getRole(db, id);
  });

  api.patch('/roles/:id', perm('roles', 'manage'), (req) => {
    const body = RoleBody.partial().parse(req.body);
    const db = req.ctx.db!;
    const role = getRole(db, Number(req.params.id));
    if (!role) throw notFound();
    if (role.isOwner) throw forbidden('ownerLocked');
    const myRole = req.ctx.role!;
    if (!myRole.isOwner && !isSubset(role.permissions, myRole.permissions)) throw forbidden('roleTooHigh');
    const p = body.permissions !== undefined ? sanitizePermissions(body.permissions) : role.permissions;
    if (!myRole.isOwner && !isSubset(p, myRole.permissions)) throw forbidden('roleTooHigh');
    const name = body.name ?? role.name;
    if (
      name.toLowerCase() !== role.name.toLowerCase() &&
      db.prepare('SELECT 1 FROM roles WHERE name = ?').get(name)
    )
      throw conflict('roleNameTaken');
    db.transaction(() => {
      db.prepare('UPDATE roles SET name = ?, permissions = ?, updated_at = ? WHERE id = ?').run(
        name,
        JSON.stringify(p),
        nowIso(),
        role.id,
      );
      const changes = diff({ name: role.name, ...flat(role.permissions) }, { name, ...flat(p) });
      if (Object.keys(changes).length)
        audit(db, actor(req), {
          category: 'roles',
          action: 'roleUpdated',
          objType: 'role',
          objId: role.id,
          objLabel: name,
          changes,
        });
    })();
    return getRole(db, role.id);
  });

  api.delete('/roles/:id', OWNER, (req) => {
    const db = req.ctx.db!;
    const role = getRole(db, Number(req.params.id));
    if (!role) throw notFound();
    if (role.isOwner) throw forbidden('ownerLocked');
    if (!req.ctx.role!.isOwner && !isSubset(role.permissions, req.ctx.role!.permissions))
      throw forbidden('roleTooHigh');
    if (db.prepare('SELECT 1 FROM users WHERE role_id = ?').get(role.id)) throw conflict('roleInUse');
    db.prepare('DELETE FROM roles WHERE id = ?').run(role.id);
    audit(db, actor(req), {
      category: 'roles',
      action: 'roleDeleted',
      objType: 'role',
      objId: role.id,
      objLabel: role.name,
    });
    return { ok: true };
  });
}

/** Flatten permissions for readable audit diffs: "functions.orders": [...], "visibility.seeCost": true … */
function flat(p: Permissions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of Object.keys(MODULES))
    out[`functions.${m}`] = [...((p.functions as Record<string, string[]>)[m] ?? [])].sort();
  for (const v of VISIBILITY) out[`visibility.${v}`] = !!p.visibility[v];
  out.locationScope = p.locationScope;
  out.limits = p.limits;
  out.access = p.access;
  return out;
}
