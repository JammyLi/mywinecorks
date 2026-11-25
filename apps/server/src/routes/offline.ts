/** Phone offline mode: snapshot download, queued-operation sync, conflicts (ported from MyWines m3.js). */
import { z } from 'zod';
import { Api, actor, perm } from '../http.ts';
import { perms } from '../services/inventory.ts';
import { OP_TYPES, conflicts, resolve, snapshot, sync, type Op } from '../services/offline.ts';

const OpSchema = z.object({
  id: z.string().min(8).max(64),
  ts: z.string().datetime(),
  type: z.enum(OP_TYPES),
  payload: z.record(z.string(), z.unknown()),
  base: z.record(z.string(), z.unknown()).optional(),
});

export function mountOffline(api: Api) {
  api.get('/offline/snapshot', perm('inventory', 'view'), (req) => snapshot(req.ctx.db!, perms(req)));

  // Each operation checks its own permission (move / stock-out / stocktake need inventory.edit).
  api.post('/offline/sync', perm('inventory', 'view'), (req) => {
    const b = z
      .object({ device: z.string().max(64).nullable().optional(), ops: z.array(OpSchema).max(500) })
      .parse(req.body);
    const results = sync(req.ctx.db!, perms(req), actor(req), b.device ?? null, b.ops as Op[]);
    return { results, conflicts: results.filter((r) => r.status === 'conflict').length };
  });

  api.get('/offline/conflicts', perm('inventory', 'view'), (req) => conflicts(req.ctx.db!, req.ctx.user!.id));

  api.post('/offline/resolve', perm('inventory', 'edit'), (req) => {
    const b = z.object({ id: z.string(), choice: z.enum(['mine', 'server']) }).parse(req.body);
    return resolve(req.ctx.db!, perms(req), actor(req), req.ctx.user!.id, b.id, b.choice);
  });
}
