import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';

export interface Actor {
  id: number | null;
  label: string;
  ip?: string;
}

export interface AuditEntry {
  category: 'auth' | 'users' | 'roles' | 'settings' | string;
  action: string;
  objType?: string;
  objId?: string | number;
  objLabel?: string;
  changes?: unknown;
  reason?: string;
}

/** Append one entry to the tenant's change log. */
export function audit(db: DB, actor: Actor, e: AuditEntry) {
  db.prepare(
    `INSERT INTO audit_log (ts, user_id, user_label, category, action, obj_type, obj_id, obj_label, changes, reason, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    actor.id,
    actor.label,
    e.category,
    e.action,
    e.objType ?? null,
    e.objId != null ? String(e.objId) : null,
    e.objLabel ?? null,
    e.changes !== undefined ? JSON.stringify(e.changes) : null,
    e.reason ?? null,
    actor.ip ?? null,
  );
}

/** Field-level diff: { field: [before, after] } for fields that changed. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}
