import { z } from 'zod';
import { Api, perm } from '../http.ts';
import { perms, redact } from '../services/inventory.ts';

export function mountAudit(api: Api) {
  api.get('/audit', perm('audit', 'view'), (req) => {
    const q = z
      .object({
        category: z.string().optional(),
        q: z.string().trim().optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.category) (where.push('category = ?'), args.push(q.category));
    if (q.before) (where.push('id < ?'), args.push(q.before));
    if (q.q) {
      where.push('(obj_label LIKE ? OR user_label LIKE ? OR action LIKE ?)');
      args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`);
    }
    const rows = req.ctx
      .db!.prepare(
        `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, q.limit) as Record<string, unknown>[];
    // Cost and merchant details inside changes are hidden from roles that may not see them.
    return redact(
      rows.map((r) => ({ ...r, changes: r.changes ? JSON.parse(String(r.changes)) : null })),
      perms(req),
    );
  });
}
