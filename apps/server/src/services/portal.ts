/**
 * Customer portal for this workspace (SPEC §9, §10.3). The portal runs in the cloud
 * (portal-service); this server feeds it by connecting OUT only: a signed snapshot of what each
 * customer may see, and in return new order requests, access requests and profile updates.
 * Without internet the same snapshot goes as an encrypted, signed package file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {
  lineAmount,
  PORTAL_PROTOCOL,
  portalSigningText,
  type PortalCustomer,
  type PortalInbound,
  type PortalRequestStatus,
  type PortalSnapshot,
} from '@mwc/shared';
import type { Config } from '../config.ts';
import type { DB, Registry, TenantRow } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { ApiError, badRequest } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import { availableByWine, customerEntries, newCatalogCache, fileHash, photoFiles, publicWine, wineRef } from './catalogs.ts';
import { settings } from './inventory.ts';
import { aiSettings } from './ai.ts';
import type { LicenseView } from './licensing.ts';
import { company, newOrderNo } from './orders.ts';

export interface PortalSettings {
  enabled: boolean;
  handle: string;
  intro: string | null;
  introEn: string | null;
  accent: string | null;
  country: 'TW' | 'US';
  blockedStates: string[];
  softHoldHours: number;
  /** The Owner confirmed holding any licence needed to sell alcohol (SPEC §3.1). */
  licenceConfirmedAt: string | null;
  licenceConfirmedBy: string | null;
}
export interface SyncState {
  registered: boolean;
  registeredKey: string | null;
  lastAt: string | null;
  lastOk: string | null;
  error: string | null;
  lastHash: string | null;
  /** When the last full copy was sent (unchanged copies in between only carry requests and acks). */
  lastFullAt?: string | null;
  lastSeq?: number;
  ack: { requests: string[]; access: string[]; profile: number[]; accepted: string[] };
  portalKeys: { encryption: string; signing: string } | null;
}

const SYS: Actor = { id: null, label: 'portal' };

const getJson = <T>(db: DB, key: string, def: T): T => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? { ...def, ...(JSON.parse(r.value) as T) } : def;
};
const setJson = (db: DB, key: string, v: unknown) =>
  db
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run(key, JSON.stringify(v));

export function portalSettings(db: DB, slug: string): PortalSettings {
  const cur = settings(db).currency;
  return getJson<PortalSettings>(db, 'portal', {
    enabled: false,
    handle: slug,
    intro: null,
    introEn: null,
    accent: null,
    country: cur === 'USD' ? 'US' : 'TW',
    blockedStates: [],
    softHoldHours: 0,
    licenceConfirmedAt: null,
    licenceConfirmedBy: null,
  });
}
export const savePortalSettings = (db: DB, s: PortalSettings) => setJson(db, 'portal', s);
export const syncState = (db: DB): SyncState =>
  getJson<SyncState>(db, 'portalSync', {
    registered: false,
    registeredKey: null,
    lastAt: null,
    lastOk: null,
    error: null,
    lastHash: null,
    ack: { requests: [], access: [], profile: [], accepted: [] },
    portalKeys: null,
  });
const saveSync = (db: DB, s: SyncState) => setJson(db, 'portalSync', s);

/** This workspace's own signing key (Ed25519); its public half is registered with the portal. */
export function tenantKey(db: DB) {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'portalKey'").get() as
    { value: string } | undefined;
  if (r) return JSON.parse(r.value) as { privateKey: string; publicKey: string };
  const k = crypto.generateKeyPairSync('ed25519');
  const v = {
    privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  db.prepare("INSERT INTO settings (key, value) VALUES ('portalKey', ?)").run(JSON.stringify(v));
  return v;
}

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const ageMin = (country: 'TW' | 'US') => (country === 'US' ? 21 : 18);

// ---------------------------------------------------------------- snapshot (what leaves the server)

function requestStatuses(db: DB): PortalRequestStatus[] {
  const orders = db
    .prepare(
      `SELECT id, order_no, request_ref, status, currency FROM orders WHERE source = 'portal' AND request_ref IS NOT NULL
       AND created_at >= ? ORDER BY id`,
    )
    .all(new Date(Date.now() - 180 * 86400_000).toISOString()) as {
    id: number;
    order_no: string;
    request_ref: string;
    status: string;
    currency: string;
  }[];
  const lines = db.prepare(
    `SELECT l.wine_id, l.qty, l.unit_price, l.discount, w.winery || ' ' || w.name || ' ' || w.vintage label FROM order_lines l JOIN wines w ON w.id = l.wine_id WHERE l.order_id = ? ORDER BY l.pos, l.id`,
  );
  return orders.map((o) => {
    const status: PortalRequestStatus['status'] =
      o.status === 'draft'
        ? 'received'
        : o.status === 'cancelled'
          ? 'declined'
          : o.status === 'shipped' || o.status === 'closed'
            ? 'shipped'
            : 'confirmed';
    const ls = lines.all(o.id) as {
      wine_id: number;
      qty: number;
      unit_price: number | null;
      discount: number;
      label: string;
    }[];
    const final = status !== 'received' && status !== 'declined';
    return {
      ref: o.request_ref,
      status,
      orderNo: o.order_no,
      // Final prices only once confirmed (a draft can still change).
      lines: ls.map((l) => ({
        w: wineRef(l.wine_id),
        name: l.label,
        qty: l.qty,
        price: final ? Math.round((l.unit_price ?? 0) * (1 - (l.discount || 0) / 100)) : null,
      })),
      total: final ? ls.reduce((s, l) => s + lineAmount(l), 0) : null,
      currency: o.currency,
    };
  });
}

/** The filtered copy for the portal: only portal customers, only their catalogs, public wine facts. */
export function buildSnapshot(
  cfg: Config,
  db: DB,
  tenant: TenantRow,
  aiPortal = false,
): { snapshot: PortalSnapshot; photos: Map<string, string> } {
  const ps = portalSettings(db, tenant.slug);
  const co = company(db);
  const avail = availableByWine(db);
  const custs = db
    .prepare(
      "SELECT * FROM customers WHERE portal_status IN ('invited','active','suspended','revoked') ORDER BY id",
    )
    .all() as {
    id: number;
    customer_no: string;
    name: string;
    email: string | null;
    portal_email: string | null;
    lang: string;
    portal_status: string;
    state: string | null;
  }[];
  const wines = new Set<number>();
  const cats = new Map<number, { id: number; name: string; nameEn: string | null; intro: string | null }>();
  const cache = newCatalogCache();
  const customers: PortalCustomer[] = custs.map((c) => {
    const { catalogs, entries } =
      c.portal_status === 'active' || c.portal_status === 'invited'
        ? customerEntries(db, c.id, avail, cache)
        : { catalogs: [], entries: [] };
    for (const k of catalogs) cats.set(k.id, { id: k.id, name: k.name, nameEn: k.name_en, intro: k.intro });
    for (const e of entries) wines.add(e.wineId);
    return {
      ref: c.customer_no,
      name: c.name,
      email: (c.portal_email ?? c.email)?.toLowerCase() ?? null,
      lang: c.lang === 'en' ? 'en' : 'zh-TW',
      status: c.portal_status as PortalCustomer['status'],
      state: c.state,
      addresses: db
        .prepare(
          'SELECT id, label, address FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, id',
        )
        .all(c.id) as PortalCustomer['addresses'],
      entries: entries.map((e) => ({
        w: wineRef(e.wineId),
        price: e.price,
        avail: e.availability,
        max: e.max,
        cats: e.catalogs,
      })),
    };
  });
  const photos = new Map<string, string>();
  const pw = [...wines].map((id) => {
    const files = photoFiles(cfg.dataDir, tenant.slug, db, id);
    const hashes = files.map((f) => {
      const h = fileHash(f);
      photos.set(h, f);
      return h;
    });
    return publicWine(db, id, hashes);
  });
  const st = syncState(db);
  return {
    snapshot: {
      v: PORTAL_PROTOCOL,
      seq: Date.now(),
      tenant: {
        name: co.name || tenant.name,
        nameEn: co.nameEn || null,
        intro: ps.intro,
        introEn: ps.introEn,
        accent: ps.accent,
        country: ps.country,
        currency: settings(db).currency,
        ageMin: ageMin(ps.country),
        blockedStates: ps.blockedStates,
        softHoldHours: ps.softHoldHours,
        ai: aiPortal,
      },
      catalogs: [...cats.values()],
      wines: pw,
      customers,
      requests: requestStatuses(db),
      ack: st.ack,
    },
    photos,
  };
}

// ---------------------------------------------------------------- what comes back

/** New order requests become draft orders (SPEC §8.3); access requests and profile changes wait for staff. */
export function applyInbound(db: DB, inb: PortalInbound) {
  const st = syncState(db);
  const ack = {
    requests: [] as string[],
    access: [] as string[],
    profile: [] as number[],
    accepted: [] as string[],
  };
  const made: string[] = [];
  db.transaction(() => {
    // Accepted invitations first: their requests in the same batch belong to active customers.
    for (const ref of inb.accepted ?? []) {
      ack.accepted.push(ref);
      const c = db
        .prepare("SELECT id, name FROM customers WHERE customer_no = ? AND portal_status = 'invited'")
        .get(ref) as { id: number; name: string } | undefined;
      if (!c) continue;
      db.prepare("UPDATE customers SET portal_status = 'active', updated_at = ? WHERE id = ?").run(
        nowIso(),
        c.id,
      );
      audit(db, SYS, {
        category: 'customers',
        action: 'portalAccepted',
        objType: 'customer',
        objId: c.id,
        objLabel: c.name,
        changes: { status: ['invited', 'active'] },
      });
    }
    for (const r of inb.requests) {
      ack.requests.push(r.ref);
      if (db.prepare('SELECT 1 FROM orders WHERE request_ref = ?').get(r.ref)) continue;
      const cust = db.prepare('SELECT * FROM customers WHERE customer_no = ?').get(r.customerRef) as
        { id: number; lang: string; portal_status: string } | undefined;
      if (!cust || cust.portal_status !== 'active') continue;
      const no = newOrderNo(db);
      const id = Number(
        db
          .prepare(
            `INSERT INTO orders (order_no, customer_id, order_date, delivery, lang, address, currency, tax_rate, created_label, created_at, source, request_ref, request_status, request_note, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'portal', ?, 'portal', ?, 'received', ?, ?)`,
          )
          .run(
            no,
            cust.id,
            nowIso().slice(0, 10),
            r.delivery === 'pickup' ? 'pickup' : 'ship',
            cust.lang,
            r.address,
            settings(db).currency,
            company(db).taxRate,
            nowIso(),
            r.ref,
            r.note,
            r.note,
          ).lastInsertRowid,
      );
      const ins = db.prepare(
        'INSERT INTO order_lines (order_id, wine_id, qty, unit_price, discount, pos) VALUES (?, ?, ?, ?, 0, ?)',
      );
      r.lines.forEach((l, i) => {
        const wid = parseInt(l.w.slice(1), 36);
        if (db.prepare('SELECT 1 FROM wines WHERE id = ?').get(wid))
          ins.run(id, wid, Math.max(1, Math.min(999, l.qty)), l.price, i + 1);
      });
      audit(db, SYS, {
        category: 'orders',
        action: 'portalRequestReceived',
        objType: 'order',
        objId: no,
        objLabel: r.customerRef,
        changes: { request: r.ref, lines: r.lines.length, delivery: r.delivery },
      });
      made.push(no);
    }
    for (const a of inb.accessRequests) {
      ack.access.push(a.ref);
      if (db.prepare('SELECT 1 FROM portal_access_requests WHERE ref = ?').get(a.ref)) continue;
      db.prepare(
        'INSERT INTO portal_access_requests (ref, name, email, phone, message, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(a.ref, a.name, a.email.toLowerCase(), a.phone, a.message, a.createdAt);
      audit(db, SYS, {
        category: 'customers',
        action: 'portalAccessRequested',
        objType: 'accessRequest',
        objId: a.ref,
        objLabel: a.email,
      });
    }
    for (const u of inb.profileUpdates) {
      ack.profile.push(u.id);
      const c = db
        .prepare('SELECT id, phone, lang FROM customers WHERE customer_no = ?')
        .get(u.customerRef) as { id: number; phone: string | null; lang: string } | undefined;
      if (!c) continue;
      const changes: Record<string, unknown> = {};
      if (u.phone != null && u.phone !== c.phone) {
        db.prepare('UPDATE customers SET phone = ?, updated_at = ? WHERE id = ?').run(
          u.phone,
          nowIso(),
          c.id,
        );
        changes.phone = [c.phone, u.phone];
      }
      if (u.lang && u.lang !== c.lang) {
        db.prepare('UPDATE customers SET lang = ?, updated_at = ? WHERE id = ?').run(u.lang, nowIso(), c.id);
        changes.lang = [c.lang, u.lang];
      }
      if (u.address) {
        db.prepare(
          'INSERT INTO customer_addresses (customer_id, label, address, is_default) VALUES (?, ?, ?, 0)',
        ).run(c.id, 'portal', u.address);
        changes.address = [null, u.address];
      }
      if (Object.keys(changes).length)
        audit(db, SYS, {
          category: 'customers',
          action: 'portalProfileUpdated',
          objType: 'customer',
          objId: c.id,
          objLabel: u.customerRef,
          changes,
        });
    }
    saveSync(db, { ...st, ack });
  })();
  return { orders: made, ack };
}

// ---------------------------------------------------------------- talking to portal-service

export class PortalClient {
  /** For tests. */
  fetcher: typeof fetch = (...a) => fetch(...a);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private cfg: Config,
    private registry: Registry,
    private license: (slug: string) => LicenseView,
    private licenseKey: (slug: string) => string | null,
  ) {}

  private async call<T>(
    db: DB,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    raw?: Buffer,
  ): Promise<T> {
    const data = raw ?? Buffer.from(body === undefined ? '' : JSON.stringify(body));
    const ts = new Date().toISOString();
    const k = tenantKey(db);
    const st = syncState(db);
    const sig = crypto
      .sign(null, Buffer.from(portalSigningText(ts, method, path, sha256(data))), k.privateKey)
      .toString('base64url');
    // Big snapshots travel compressed; the signature covers the uncompressed bytes.
    const zip = !raw && data.length > 64 * 1024;
    const wire = zip ? zlib.gzipSync(data) : data;
    let res: Response;
    try {
      res = await this.fetcher(this.cfg.portalUrl + path, {
        method,
        headers: {
          ...(zip ? { 'content-encoding': 'gzip' } : {}),
          'content-type': raw ? 'application/octet-stream' : 'application/json',
          'x-mwc-key': st.registeredKey ?? '',
          'x-mwc-ts': ts,
          'x-mwc-sig': sig,
        },
        body: method === 'GET' ? undefined : new Uint8Array(wire),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ApiError(502, 'portalUnreachable');
    }
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok)
      throw new ApiError(
        res.status === 409 ? 409 : res.status === 403 ? 403 : 502,
        out.error ?? 'portalError',
      );
    return out;
  }

  /** The portal is a cloud service: it needs a valid license that includes it (SPEC §20.1). */
  private check(slug: string) {
    const l = this.license(slug);
    if (l.locked()) throw new ApiError(423, 'licenseLocked');
    if (!l.hasModule('portal')) throw badRequest('portalNotInPlan');
  }

  /** Register this workspace with the portal (first time, or after the key or handle changed). */
  async register(t: TenantRow) {
    const db = this.registry.tenantDb(t.slug);
    this.check(t.slug);
    const ps = portalSettings(db, t.slug);
    const key = this.licenseKey(t.slug);
    if (!key) throw badRequest('updateNeedsLicense');
    const k = tenantKey(db);
    const r = await this.call<{ key: string; keys: SyncState['portalKeys'] }>(
      db,
      'POST',
      '/api/tenant/register',
      {
        licenseKey: key,
        publicKey: k.publicKey,
        handle: ps.handle,
      },
    );
    saveSync(db, {
      ...syncState(db),
      registered: true,
      registeredKey: r.key,
      portalKeys: r.keys,
      error: null,
    });
  }

  /** Send the snapshot, upload missing photos, bring back requests. */
  private chains = new Map<string, Promise<unknown>>();
  /** One sync at a time per workspace (timer, "Sync now" and access changes can overlap). */
  sync(t: TenantRow): ReturnType<PortalClient['syncNow']> {
    const next = (this.chains.get(t.slug) ?? Promise.resolve()).catch(() => undefined).then(() => this.syncNow(t));
    this.chains.set(t.slug, next);
    return next;
  }

  private async syncNow(t: TenantRow) {
    const db = this.registry.tenantDb(t.slug);
    const ps = portalSettings(db, t.slug);
    if (!ps.enabled) return { skipped: true as const };
    this.check(t.slug);
    let st = syncState(db);
    try {
      if (!st.registered) {
        await this.register(t);
        st = syncState(db);
      }
      const { snapshot, photos } = buildSnapshot(
        this.cfg,
        db,
        t,
        this.license(t.slug).hasModule('ai') && aiSettings(db).portal,
      );
      snapshot.licenseKey = this.licenseKey(t.slug) ?? undefined;
      // Always newer than the last one sent, even within the same millisecond.
      if (st.lastSeq && snapshot.seq <= st.lastSeq) snapshot.seq = st.lastSeq + 1;
      const hash = sha256(JSON.stringify({ ...snapshot, seq: 0, requests: [], ack: null }));
      // Same as last time (and sent in full within the hour): send only requests and acknowledgements.
      const same =
        hash === st.lastHash && !!st.lastFullAt && Date.now() - Date.parse(st.lastFullAt) < 3600_000;
      const send: PortalSnapshot = same
        ? { ...snapshot, unchanged: true, catalogs: [], wines: [], customers: [] }
        : snapshot;
      const inb = await this.call<PortalInbound>(db, 'POST', '/api/tenant/sync', send);
      for (const h of inb.photosMissing.slice(0, 50)) {
        const f = photos.get(h);
        if (f) await this.call(db, 'POST', `/api/tenant/photo/${h}`, undefined, fs.readFileSync(f));
      }
      const r = applyInbound(db, inb);
      const now = nowIso();
      saveSync(db, {
        ...syncState(db),
        lastAt: now,
        lastOk: now,
        error: null,
        lastHash: hash,
        lastFullAt: same ? st.lastFullAt : now,
        lastSeq: snapshot.seq,
      });
      return { ...r, sent: { customers: snapshot.customers.length, wines: snapshot.wines.length } };
    } catch (e) {
      saveSync(db, { ...syncState(db), lastAt: nowIso(), error: (e as ApiError).code ?? 'portalError' });
      throw e;
    }
  }

  /** Suspend / revoke / reactivate reaches the portal at once (all the customer's sessions end). */
  async access(t: TenantRow, customerRef: string, status: string, reason: string | null) {
    const db = this.registry.tenantDb(t.slug);
    if (!syncState(db).registered) await this.register(t);
    return this.call(db, 'POST', '/api/tenant/access', { customerRef, status, reason });
  }

  /** One-time invitation link for a customer. */
  async invite(t: TenantRow, c: { ref: string; email: string; name: string; lang: string }) {
    const db = this.registry.tenantDb(t.slug);
    this.check(t.slug);
    if (!syncState(db).registered) await this.register(t);
    // The customer must exist on the portal before the invitation: send a snapshot first.
    await this.sync(t);
    return this.call<{ url: string; code: string; emailed: boolean }>(db, 'POST', '/api/tenant/invite', {
      customerRef: c.ref,
      email: c.email,
      name: c.name,
      lang: c.lang,
    });
  }

  /** Soon after a change (debounced), and every few minutes. */
  soon(slug: string, ms = 5000) {
    clearTimeout(this.timers.get(slug));
    const t = setTimeout(() => {
      try {
        const row = this.registry.get(slug);
        if (row) this.sync(row).catch(() => undefined);
      } catch {
        /* shutting down */
      }
    }, ms);
    t.unref();
    this.timers.set(slug, t);
  }

  start(everyMs = 3 * 60_000) {
    const run = () => {
      for (const t of this.registry.list())
        if (t.status === 'active') {
          const db = this.registry.tenantDb(t.slug);
          if (portalSettings(db, t.slug).enabled) this.sync(t).catch(() => undefined);
        }
    };
    const a = setTimeout(run, 15_000);
    const b = setInterval(run, everyMs);
    a.unref();
    b.unref();
    return () => (clearTimeout(a), clearInterval(b));
  }
}

// ---------------------------------------------------------------- package file (no internet)

/**
 * Encrypted (X25519 + AES-256-GCM, to the portal's key) and signed (this workspace's key)
 * copy of the snapshot, for servers without internet. The Owner uploads it in a browser.
 */
export function exportPackage(
  cfg: Config,
  db: DB,
  t: TenantRow,
  licenseKey: string,
  portalKeys: { encryption: string } | null,
) {
  if (!portalKeys) throw badRequest('portalKeysMissing');
  const ps = portalSettings(db, t.slug);
  const k = tenantKey(db);
  const { snapshot } = buildSnapshot(cfg, db, t);
  const inner = Buffer.from(
    JSON.stringify({
      v: PORTAL_PROTOCOL,
      licenseKey,
      publicKey: k.publicKey,
      handle: ps.handle,
      snapshot,
      ts: new Date().toISOString(),
    }),
  );
  const sig = crypto.sign(null, Buffer.from(sha256(inner)), k.privateKey).toString('base64url');
  const plain = Buffer.from(JSON.stringify({ payload: inner.toString('base64'), sig }));
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({
    privateKey: eph.privateKey,
    publicKey: crypto.createPublicKey(portalKeys.encryption),
  });
  const key = Buffer.from(
    crypto.hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.from('mwc-portal-package'), 32),
  );
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return JSON.stringify({
    mwcPortalPackage: PORTAL_PROTOCOL,
    epk: eph.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

/** The requests file the portal gives back after a package upload (signed by the portal). */
export function importRequestsFile(db: DB, text: string, portalKeys: { signing: string } | null) {
  if (!portalKeys) throw badRequest('portalKeysMissing');
  let f: { mwcPortalRequests: number; payload: string; sig: string };
  try {
    f = JSON.parse(text);
  } catch {
    throw badRequest('portalFileInvalid');
  }
  if (!f.mwcPortalRequests || !f.payload || !f.sig) throw badRequest('portalFileInvalid');
  const payload = Buffer.from(f.payload, 'base64');
  if (!crypto.verify(null, Buffer.from(sha256(payload)), portalKeys.signing, Buffer.from(f.sig, 'base64url')))
    throw badRequest('portalFileSignature');
  return applyInbound(db, JSON.parse(payload.toString()) as PortalInbound);
}
