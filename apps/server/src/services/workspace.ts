import type { Registry } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { newToken, sha256 } from './crypto.ts';
import { ownerRoleId, seedRoles } from './roles.ts';
import { audit } from './audit.ts';
import type { DB } from '../db/registry.ts';

export const SETUP_TOKEN_DAYS = 7;

export interface NewWorkspace {
  slug: string;
  name: string;
  lang: 'zh-TW' | 'en';
  ownerEmail: string;
  ownerName?: string;
}

/** Create a client workspace: database, role templates, company settings and an invited Owner. */
export function createWorkspace(registry: Registry, w: NewWorkspace) {
  registry.create(w.slug, w.name);
  const db = registry.tenantDb(w.slug);
  const sys = { id: null, label: 'system' };
  let ownerId = 0;
  db.transaction(() => {
    seedRoles(db, w.lang);
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    set.run('company', JSON.stringify({ name: w.name, nameEn: w.name }));
    set.run('defaultLang', w.lang);
    ownerId = Number(
      db
        .prepare('INSERT INTO users (email, name, role_id, lang, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(w.ownerEmail.trim().toLowerCase(), w.ownerName ?? '', ownerRoleId(db), w.lang, nowIso()).lastInsertRowid,
    );
    audit(db, sys, { category: 'settings', action: 'workspaceCreated', objType: 'workspace', objId: w.slug, objLabel: w.name });
    audit(db, sys, { category: 'users', action: 'userInvited', objType: 'user', objId: ownerId, objLabel: w.ownerEmail });
  })();
  const token = issueSetupToken(db, ownerId, 'invite');
  return { db, ownerId, token };
}

/** One-time setup link token (invite or password reset). Older unused tokens are revoked. */
export function issueSetupToken(db: DB, userId: number, purpose: 'invite' | 'reset'): string {
  const token = newToken(24);
  const exp = new Date(Date.now() + SETUP_TOKEN_DAYS * 86400_000).toISOString();
  db.prepare('UPDATE setup_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowIso(), userId);
  db.prepare('INSERT INTO setup_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    purpose,
    exp,
  );
  return token;
}

export const setupUrl = (publicUrl: string, slug: string, token: string) =>
  `${publicUrl.replace(/\/$/, '')}/setup?w=${encodeURIComponent(slug)}&t=${encodeURIComponent(token)}`;
