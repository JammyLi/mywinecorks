import { z } from 'zod';
import { toMinor } from '@mwc/shared';
import { Api, actor, perm } from '../http.ts';
import { nowIso, type DB } from '../db/registry.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { audit, diff } from '../services/audit.ts';
import { clean, inScope, perms, scopeSql, settings } from '../services/inventory.ts';

const str = z.string().trim().max(200).optional().nullable();
const CellarBody = z.object({
  name: z.string().trim().min(1).max(80),
  kind: str,
  address: str,
  monthlyRent: z.union([z.string(), z.number()]).optional().nullable(),
  climate: str,
  note: str,
});
const LockerBody = z.object({
  cellarId: z.number().int(),
  code: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(0).nullable().optional(),
  note: str,
});
const RackBody = z.object({
  lockerId: z.number().int(),
  code: z.string().trim().min(1).max(40),
  capacity: z.number().int().min(0).nullable().optional(),
  note: str,
});

const lockerCellar = (db: DB, id: number) =>
  (db.prepare('SELECT cellar_id c FROM lockers WHERE id = ?').get(id) as { c: number } | undefined)?.c;

function rent(db: DB, v: unknown): number | null {
  const m = toMinor(v as string, settings(db).currency);
  if (m !== null && (Number.isNaN(m) || m < 0)) throw badRequest('badNumber');
  return m;
}

export function mountLocations(api: Api) {
  /** Storage tree with bottle counts, limited to the role's cellars. */
  api.get('/locations', perm('locations', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const cellars = db
      .prepare(`SELECT * FROM cellars WHERE ${scopeSql(p, 'id')} ORDER BY name`)
      .all() as Record<string, unknown>[];
    const lockers = db
      .prepare(
        `SELECT l.*, (SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id WHERE k.locker_id = l.id AND b.status IN ('in_stock','reserved')) bottles,
          (SELECT COUNT(*) FROM cases c JOIN racks k ON k.id = c.rack_id WHERE k.locker_id = l.id AND c.location_uncertain = 1) uncertain
         FROM lockers l`,
      )
      .all() as Record<string, unknown>[];
    lockers.sort((a, b) => String(a.code).localeCompare(String(b.code), 'zh-Hant', { numeric: true }));
    const racks = db
      .prepare(
        `SELECT k.*, (SELECT COUNT(*) FROM bottles b WHERE b.rack_id = k.id AND b.status IN ('in_stock','reserved')) bottles,
          (SELECT COUNT(*) FROM cases c WHERE c.rack_id = k.id AND EXISTS (SELECT 1 FROM bottles b WHERE b.case_id = c.id AND b.status IN ('in_stock','reserved'))) cases
         FROM racks k ORDER BY is_default DESC, code`,
      )
      .all() as Record<string, unknown>[];
    return cellars.map((c) => {
      const ls = lockers
        .filter((l) => l.cellar_id === c.id)
        .map((l) => ({ ...l, racks: racks.filter((r) => r.locker_id === l.id) }));
      return {
        ...c,
        bottles: ls.reduce((s, l) => s + Number((l as Record<string, unknown>).bottles), 0),
        lockers: ls,
      };
    });
  });

  // ----- cellars: Owner creates (locations.createCellar), edit/delete need locations.edit/delete
  api.post('/cellars', perm('locations', 'createCellar'), (req) => {
    const b = CellarBody.parse(req.body);
    const db = req.ctx.db!;
    if (db.prepare('SELECT 1 FROM cellars WHERE name = ?').get(b.name)) throw conflict('nameTaken');
    const id = Number(
      db
        .prepare(
          'INSERT INTO cellars (name, kind, address, monthly_rent, climate, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          b.name,
          clean(b.kind) || 'general',
          clean(b.address) || null,
          rent(db, b.monthlyRent),
          clean(b.climate) || null,
          clean(b.note) || null,
          nowIso(),
        ).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'locations',
      action: 'cellarCreated',
      objType: 'cellar',
      objId: id,
      objLabel: b.name,
    });
    return { id };
  });

  api.patch('/cellars/:id', perm('locations', 'edit'), (req) => {
    const b = CellarBody.partial().parse(req.body);
    const db = req.ctx.db!;
    const old = db.prepare('SELECT * FROM cellars WHERE id = ?').get(Number(req.params.id)) as
      Record<string, unknown> | undefined;
    if (!old || !inScope(perms(req), Number(old.id))) throw notFound();
    const next = {
      name: b.name ?? old.name,
      kind: 'kind' in b ? clean(b.kind) || 'general' : old.kind,
      address: 'address' in b ? clean(b.address) || null : old.address,
      monthly_rent: 'monthlyRent' in b ? rent(db, b.monthlyRent) : old.monthly_rent,
      climate: 'climate' in b ? clean(b.climate) || null : old.climate,
      note: 'note' in b ? clean(b.note) || null : old.note,
    };
    const changes = diff(
      {
        name: old.name,
        kind: old.kind,
        address: old.address,
        monthly_rent: old.monthly_rent,
        climate: old.climate,
        note: old.note,
      },
      next,
    );
    if (!Object.keys(changes).length) return { changed: 0 };
    if (
      next.name !== old.name &&
      db.prepare('SELECT 1 FROM cellars WHERE name = ? AND id <> ?').get(next.name, old.id)
    )
      throw conflict('nameTaken');
    db.prepare(
      'UPDATE cellars SET name=@name, kind=@kind, address=@address, monthly_rent=@monthly_rent, climate=@climate, note=@note WHERE id=@id',
    ).run({ ...next, id: old.id });
    audit(db, actor(req), {
      category: 'locations',
      action: 'cellarUpdated',
      objType: 'cellar',
      objId: Number(old.id),
      objLabel: String(next.name),
      changes,
    });
    return { changed: Object.keys(changes).length };
  });

  api.delete('/cellars/:id', perm('locations', 'delete'), (req) => {
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM cellars WHERE id = ?').get(id) as { name: string } | undefined;
    if (!old || !inScope(perms(req), id)) throw notFound();
    if (db.prepare('SELECT 1 FROM lockers WHERE cellar_id = ?').get(id)) throw conflict('notEmpty');
    db.prepare('DELETE FROM cellars WHERE id = ?').run(id);
    audit(db, actor(req), {
      category: 'locations',
      action: 'cellarDeleted',
      objType: 'cellar',
      objId: id,
      objLabel: old.name,
    });
    return { ok: true };
  });

  // ----- lockers (Admin): every locker gets an "Unassigned" default rack
  api.post('/lockers', perm('locations', 'edit'), (req) => {
    const b = LockerBody.parse(req.body);
    const db = req.ctx.db!;
    const cellar = db.prepare('SELECT * FROM cellars WHERE id = ?').get(b.cellarId) as
      { id: number; name: string } | undefined;
    if (!cellar || !inScope(perms(req), cellar.id)) throw badRequest();
    if (db.prepare('SELECT 1 FROM lockers WHERE cellar_id = ? AND code = ?').get(b.cellarId, b.code))
      throw conflict('codeTaken');
    const id = Number(
      db
        .prepare('INSERT INTO lockers (cellar_id, code, capacity, note) VALUES (?, ?, ?, ?)')
        .run(b.cellarId, b.code, b.capacity ?? null, clean(b.note) || null).lastInsertRowid,
    );
    db.prepare('INSERT INTO racks (locker_id, code, is_default) VALUES (?, ?, 1)').run(id, '-');
    audit(db, actor(req), {
      category: 'locations',
      action: 'lockerCreated',
      objType: 'locker',
      objId: id,
      objLabel: `${cellar.name} › ${b.code}`,
    });
    return { id };
  });

  api.patch('/lockers/:id', perm('locations', 'edit'), (req) => {
    const b = LockerBody.omit({ cellarId: true }).partial().parse(req.body);
    const db = req.ctx.db!;
    const old = db.prepare('SELECT * FROM lockers WHERE id = ?').get(Number(req.params.id)) as
      Record<string, unknown> | undefined;
    if (!old || !inScope(perms(req), Number(old.cellar_id))) throw notFound();
    const next = {
      code: b.code ?? old.code,
      capacity: 'capacity' in b ? (b.capacity ?? null) : old.capacity,
      note: 'note' in b ? clean(b.note) || null : old.note,
    };
    if (
      next.code !== old.code &&
      db
        .prepare('SELECT 1 FROM lockers WHERE cellar_id = ? AND code = ? AND id <> ?')
        .get(old.cellar_id, next.code, old.id)
    )
      throw conflict('codeTaken');
    const changes = diff({ code: old.code, capacity: old.capacity, note: old.note }, next);
    if (!Object.keys(changes).length) return { changed: 0 };
    db.prepare('UPDATE lockers SET code=@code, capacity=@capacity, note=@note WHERE id=@id').run({
      ...next,
      id: old.id,
    });
    audit(db, actor(req), {
      category: 'locations',
      action: 'lockerUpdated',
      objType: 'locker',
      objId: Number(old.id),
      objLabel: String(next.code),
      changes,
    });
    return { changed: Object.keys(changes).length };
  });

  api.delete('/lockers/:id', perm('locations', 'delete'), (req) => {
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM lockers WHERE id = ?').get(id) as
      { code: string; cellar_id: number } | undefined;
    if (!old || !inScope(perms(req), old.cellar_id)) throw notFound();
    const used = (
      db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id WHERE k.locker_id = ?) + (SELECT COUNT(*) FROM cases c JOIN racks k ON k.id = c.rack_id WHERE k.locker_id = ?) n',
        )
        .get(id, id) as { n: number }
    ).n;
    if (used) throw conflict('notEmpty');
    db.prepare('DELETE FROM racks WHERE locker_id = ?').run(id);
    db.prepare('DELETE FROM lockers WHERE id = ?').run(id);
    audit(db, actor(req), {
      category: 'locations',
      action: 'lockerDeleted',
      objType: 'locker',
      objId: id,
      objLabel: old.code,
    });
    return { ok: true };
  });

  // ----- racks (Admin)
  api.post('/racks', perm('locations', 'edit'), (req) => {
    const b = RackBody.parse(req.body);
    const db = req.ctx.db!;
    const cellarId = lockerCellar(db, b.lockerId);
    if (!cellarId || !inScope(perms(req), cellarId)) throw badRequest();
    if (db.prepare('SELECT 1 FROM racks WHERE locker_id = ? AND code = ?').get(b.lockerId, b.code))
      throw conflict('codeTaken');
    const id = Number(
      db
        .prepare('INSERT INTO racks (locker_id, code, capacity, note) VALUES (?, ?, ?, ?)')
        .run(b.lockerId, b.code, b.capacity ?? null, clean(b.note) || null).lastInsertRowid,
    );
    audit(db, actor(req), {
      category: 'locations',
      action: 'rackCreated',
      objType: 'rack',
      objId: id,
      objLabel: b.code,
    });
    return { id };
  });

  api.patch('/racks/:id', perm('locations', 'edit'), (req) => {
    const b = RackBody.omit({ lockerId: true }).partial().parse(req.body);
    const db = req.ctx.db!;
    const old = db.prepare('SELECT * FROM racks WHERE id = ?').get(Number(req.params.id)) as
      Record<string, unknown> | undefined;
    if (!old || !inScope(perms(req), lockerCellar(db, Number(old.locker_id))!)) throw notFound();
    if (old.is_default && b.code) throw forbidden('defaultRack');
    const next = {
      code: b.code ?? old.code,
      capacity: 'capacity' in b ? (b.capacity ?? null) : old.capacity,
      note: 'note' in b ? clean(b.note) || null : old.note,
    };
    if (
      next.code !== old.code &&
      db
        .prepare('SELECT 1 FROM racks WHERE locker_id = ? AND code = ? AND id <> ?')
        .get(old.locker_id, next.code, old.id)
    )
      throw conflict('codeTaken');
    const changes = diff({ code: old.code, capacity: old.capacity, note: old.note }, next);
    if (!Object.keys(changes).length) return { changed: 0 };
    db.prepare('UPDATE racks SET code=@code, capacity=@capacity, note=@note WHERE id=@id').run({
      ...next,
      id: old.id,
    });
    audit(db, actor(req), {
      category: 'locations',
      action: 'rackUpdated',
      objType: 'rack',
      objId: Number(old.id),
      objLabel: String(next.code),
      changes,
    });
    return { changed: Object.keys(changes).length };
  });

  api.delete('/racks/:id', perm('locations', 'delete'), (req) => {
    const db = req.ctx.db!;
    const id = Number(req.params.id);
    const old = db.prepare('SELECT * FROM racks WHERE id = ?').get(id) as
      { code: string; locker_id: number; is_default: number } | undefined;
    if (!old || !inScope(perms(req), lockerCellar(db, old.locker_id)!)) throw notFound();
    if (old.is_default) throw forbidden('defaultRack');
    const used = (
      db
        .prepare(
          'SELECT (SELECT COUNT(*) FROM bottles WHERE rack_id = ?) + (SELECT COUNT(*) FROM cases WHERE rack_id = ?) n',
        )
        .get(id, id) as { n: number }
    ).n;
    if (used) throw conflict('notEmpty');
    db.prepare('DELETE FROM racks WHERE id = ?').run(id);
    audit(db, actor(req), {
      category: 'locations',
      action: 'rackDeleted',
      objType: 'rack',
      objId: id,
      objLabel: old.code,
    });
    return { ok: true };
  });
}
