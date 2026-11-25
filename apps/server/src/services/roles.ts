import { ROLE_TEMPLATES, sanitizePermissions, type Permissions, type Role } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';

interface RoleRow {
  id: number;
  name: string;
  template: string | null;
  is_owner: number;
  permissions: string;
}

export function toRole(r: RoleRow): Role {
  const owner = ROLE_TEMPLATES.find((t) => t.key === 'owner')!;
  return {
    id: r.id,
    name: r.name,
    template: r.template,
    isOwner: !!r.is_owner,
    // The Owner role always gets the full, current permission set (new modules included).
    permissions: r.is_owner ? owner.permissions : sanitizePermissions(JSON.parse(r.permissions)),
  };
}

export function getRole(db: DB, id: number): Role | undefined {
  const r = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as RoleRow | undefined;
  return r && toRole(r);
}

export function listRoles(db: DB): (Role & { userCount: number })[] {
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.active = 1) AS user_count
       FROM roles r ORDER BY r.is_owner DESC, r.id`,
    )
    .all() as (RoleRow & { user_count: number })[];
  return rows.map((r) => ({ ...toRole(r), userCount: r.user_count }));
}

/** Template role names are stored in the workspace language chosen at creation. */
const TEMPLATE_NAMES: Record<string, Record<string, string>> = {
  'zh-TW': {
    owner: '擁有者',
    admin: '管理員',
    manager: '經理／業務',
    employee: '員工',
    picker: '揀貨員',
    viewer: '檢視者／會計',
  },
  en: {
    owner: 'Owner',
    admin: 'Admin',
    manager: 'Manager / Sales',
    employee: 'Employee',
    picker: 'Picker',
    viewer: 'Viewer / Accountant',
  },
};

export function seedRoles(db: DB, lang: 'zh-TW' | 'en') {
  const ins = db.prepare(
    'INSERT INTO roles (name, template, is_owner, permissions, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const t of ROLE_TEMPLATES) {
    ins.run(TEMPLATE_NAMES[lang][t.key], t.key, t.isOwner ? 1 : 0, JSON.stringify(t.permissions), nowIso());
  }
}

export function ownerRoleId(db: DB): number {
  return (db.prepare('SELECT id FROM roles WHERE is_owner = 1').get() as { id: number }).id;
}

/** Does this role need 2-step verification under the admin policy? */
export function isAdminLike(role: Role): boolean {
  const f = role.permissions.functions;
  return role.isOwner || !!f.users?.includes('manage') || !!f.roles?.includes('manage');
}

export type { Permissions };
