/**
 * AI features (SPEC §10). Each route checks the user's permission here, sends only what the
 * feature needs to the AI gateway, and returns a suggestion. Nothing is saved by these routes
 * except the explicit "create order from message" and Settings › AI; saving AI suggestions
 * otherwise goes through the normal routes (wine form, stock in, price, order).
 */
import { z } from 'zod';
import {
  AI_SWITCHES,
  fromMinor,
  sees,
  toMinor,
  type DrinkingResult,
  type InvoiceResult,
  type LabelResult,
  type OrderMessageResult,
  type PriceResult,
  type SearchResult,
} from '@mwc/shared';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { AUTH, Api, actor, perm } from '../http.ts';
import { audit } from '../services/audit.ts';
import {
  aiSettings,
  drinkingStatus,
  matchWines,
  saveAiSettings,
  similarWines,
  type AiSettings,
} from '../services/ai.ts';
import { canonicalName, looksSame } from '../services/importer.ts';
import { perms, scopeSql, settings, today, wineKey } from '../services/inventory.ts';
import { createOrder, defaultPrice, mayOpen, orderByNo, updateOrder } from '../services/orders.ts';

const Img = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  data: z.string().min(4).max(14_000_000),
});
const lang = (req: { ctx: { user?: { lang?: string } } }) => (req.ctx.user?.lang === 'en' ? 'en' : 'zh-TW');

export function mountAi(api: Api) {
  const ai = (req: Parameters<Parameters<Api['get']>[2]>[0], sw?: (typeof AI_SWITCHES)[number]) => {
    const c = req.ctx.ai;
    if (!c) throw new ApiError(503, 'aiNotConfigured');
    c.check(req.ctx.tenant!.slug, req.ctx.db!, sw);
    return c;
  };

  /** What the UI should offer: in the plan, switched on, and allowed for this user. */
  api.get('/ai/status', AUTH, (req) => {
    const l = req.ctx.licensing!;
    return { inPlan: l.hasModule('ai') && !l.locked(), switches: aiSettings(req.ctx.db!) };
  });

  api.get('/ai/usage', perm('settings', 'view'), async (req) => {
    const r = await ai(req).call<{ used: number; cap: number; calls: number; configured: boolean }>(
      req.ctx.tenant!.slug,
      req.ctx.db!,
      'GET',
      '/api/usage',
    );
    return { used: r.used, cap: r.cap, calls: r.calls, configured: r.configured };
  });

  api.patch('/ai/settings', perm('settings', 'edit'), (req) => {
    const b = z
      .object(Object.fromEntries(AI_SWITCHES.map((k) => [k, z.boolean().optional()])))
      .parse(req.body) as Partial<AiSettings>;
    const db = req.ctx.db!;
    const old = aiSettings(db);
    const next = { ...old, ...b };
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of AI_SWITCHES) if (old[k] !== next[k]) changes[k] = [old[k], next[k]];
    if (!Object.keys(changes).length) return { changed: 0 };
    db.transaction(() => {
      saveAiSettings(db, next);
      audit(db, actor(req), {
        category: 'settings',
        action: 'aiSettingsChanged',
        objType: 'settings',
        objId: 'ai',
        changes,
      });
    })();
    // The portal shows or hides its AI search with the next snapshot.
    if (changes.portal) req.ctx.portal?.soon(req.ctx.tenant!.slug, 500);
    return { changed: Object.keys(changes).length };
  });

  // ---------------------------------------------------------------- new wine from label photos
  api.post('/ai/label', perm('inventory', 'create'), async (req) => {
    const b = z.object({ images: z.array(Img).min(1).max(4) }).parse(req.body);
    const db = req.ctx.db!;
    const types = db.prepare('SELECT code, en FROM wine_types WHERE mapped = 1 ORDER BY pos').all() as {
      code: string;
      en: string;
    }[];
    const r = await ai(req, 'label').feature<LabelResult>(req.ctx.tenant!.slug, db, 'label', {
      images: b.images,
      types,
    });
    const f = r.result;
    if (f.typeCode && !types.some((t) => t.code === f.typeCode)) f.typeCode = null;
    if (f.vintage && !/^(\d{4}|NV)$/.test(f.vintage)) f.vintage = null;
    return { fields: f, matches: similarWines(db, f), source: { kind: 'ai', model: r.model } };
  });

  // ---------------------------------------------------------------- purchase invoice → stock-in draft
  api.post('/ai/invoice', perm('inventory', 'create'), async (req) => {
    const p = perms(req);
    if (!sees(p, 'seeCost')) throw forbidden('noCostAccess');
    const b = z.object({ file: Img }).parse(req.body);
    const db = req.ctx.db!;
    const r = await ai(req, 'invoice').feature<InvoiceResult>(req.ctx.tenant!.slug, db, 'invoice', {
      file: b.file,
    });
    const inv = r.result;
    const cur = settings(db).currency;
    const currency = inv.currency && /^[A-Z]{3}$/.test(inv.currency) ? inv.currency : cur;
    let merchant: { id: number | null; name: string } | null = null;
    if (inv.merchant && sees(p, 'seeMerchants')) {
      const name = canonicalName(db, 'merchant', inv.merchant);
      const all = db.prepare('SELECT id, name FROM merchants').all() as { id: number; name: string }[];
      const hit =
        all.find((m) => m.name.toLowerCase() === name.toLowerCase()) ??
        all.find((m) => looksSame(m.name, name));
      merchant = hit ? { id: hit.id, name: hit.name } : { id: null, name };
    }
    const totalBottles = inv.lines.reduce((s, l) => s + l.qty, 0);
    const lines = inv.lines.map((l) => {
      const vintage = l.vintage && /^(\d{4}|NV)$/i.test(l.vintage) ? l.vintage.toUpperCase() : null;
      const exact =
        l.winery && vintage
          ? (db
              .prepare('SELECT wine_no wineNo, winery, name, vintage FROM wines WHERE match_key = ?')
              .get(wineKey({ winery: l.winery, name: l.name, vintage, volume_ml: l.volumeMl || 750 })) as
              Record<string, unknown> | undefined)
          : undefined;
      return {
        ...l,
        vintage,
        unitCost: l.unitPrice == null ? null : toMinor(l.unitPrice, currency),
        match: exact ?? null,
        candidates: exact ? [] : matchWines(db, p, `${l.winery ?? ''} ${l.name} ${vintage ?? ''}`, 4),
      };
    });
    // Extra costs spread over the bottles, per bottle.
    const extra = inv.extraCosts && totalBottles ? toMinor(inv.extraCosts / totalBottles, currency) : null;
    return {
      merchant,
      invoiceNo: inv.invoiceNo,
      date: inv.date && /^\d{4}-\d{2}-\d{2}$/.test(inv.date) ? inv.date : null,
      currency,
      baseCurrency: cur,
      extraPerBottle: extra,
      lines,
      source: { kind: 'ai', model: r.model },
    };
  });

  // ---------------------------------------------------------------- natural-language stock search
  api.post('/ai/search', perm('inventory', 'view'), async (req) => {
    const b = z.object({ text: z.string().trim().min(1).max(500) }).parse(req.body);
    const db = req.ctx.db!;
    const p = perms(req);
    const cur = settings(db).currency;
    const cellars = db.prepare(`SELECT id, name FROM cellars c WHERE ${scopeSql(p, 'c.id')}`).all() as {
      id: number;
      name: string;
    }[];
    const types = db.prepare('SELECT code, zh, en FROM wine_types WHERE mapped = 1').all() as {
      code: string;
      zh: string;
      en: string;
    }[];
    const distinct = (col: string) =>
      (
        db
          .prepare(
            `SELECT DISTINCT ${col} v FROM wines WHERE COALESCE(${col},'') <> '' ORDER BY ${col} LIMIT 300`,
          )
          .all() as { v: string }[]
      ).map((r) => r.v);
    const r = await ai(req, 'search').feature<SearchResult>(req.ctx.tenant!.slug, db, 'search', {
      text: b.text,
      currency: cur,
      types,
      cellars: cellars.map((c) => c.name),
      countries: distinct('country').slice(0, 100),
      regions: distinct('region'),
    });
    const s = r.result;
    const query: Record<string, string> = {};
    if (s.q) query.q = s.q;
    const okTypes = s.types.filter((t) => types.some((x) => x.code === t));
    if (okTypes.length) query.type = okTypes.join(',');
    if (s.country) query.country = s.country;
    if (s.region) query.region = s.region;
    if (s.vintageFrom && /^\d{4}$/.test(s.vintageFrom)) query.vmin = s.vintageFrom;
    if (s.vintageTo && /^\d{4}$/.test(s.vintageTo)) query.vmax = s.vintageTo;
    if (s.priceMin != null) query.pmin = String(toMinor(s.priceMin, cur));
    if (s.priceMax != null) query.pmax = String(toMinor(s.priceMax, cur));
    const cellar = s.cellar && cellars.find((c) => c.name === s.cellar);
    if (cellar) query.cellar = String(cellar.id);
    return { query, explanation: s.explanation, source: { kind: 'ai', model: r.model } };
  });

  // ---------------------------------------------------------------- drinking windows
  api.get('/ai/drinking', perm('inventory', 'view'), (req) => {
    const rows = drinkingStatus(req.ctx.db!, perms(req));
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      year: Number(today(req.ctx.db!).slice(0, 4)),
      counts: {
        entering: count('entering'),
        peak: count('peak'),
        past: count('past'),
        young: count('young'),
        unknown: count('unknown'),
      },
      wines: rows,
    };
  });

  /** Suggested windows for wines without one; saved only when the user accepts each (PATCH /wines/:no). */
  api.post('/ai/drinking/suggest', perm('inventory', 'edit'), async (req) => {
    const b = z.object({ wineNos: z.array(z.string().max(12)).min(1).max(40) }).parse(req.body);
    const db = req.ctx.db!;
    const wines = db
      .prepare(
        `SELECT wine_no ref, winery, name, vintage, region, classification, type_code type FROM wines WHERE wine_no IN (${b.wineNos.map(() => '?').join(',')})`,
      )
      .all(...b.wineNos) as { ref: string }[];
    if (!wines.length) throw notFound('wineNotFound');
    const r = await ai(req, 'drinking').feature<DrinkingResult>(req.ctx.tenant!.slug, db, 'drinking', {
      wines,
    });
    const known = new Set(wines.map((w) => w.ref));
    return {
      suggestions: r.result.wines
        .filter((w) => known.has(w.ref))
        .map((w) => ({ wineNo: w.ref, drinkFrom: w.drinkFrom, drinkTo: w.drinkTo, reason: w.reason })),
      source: { kind: 'ai', model: r.model },
    };
  });

  // ---------------------------------------------------------------- cellar Q&A
  api.post('/ai/ask', perm('inventory', 'view'), async (req) => {
    const b = z.object({ question: z.string().trim().min(2).max(1000) }).parse(req.body);
    const out = await ai(req, 'ask').ask(
      req.ctx.tenant!.slug,
      req.ctx.db!,
      perms(req),
      req.ctx.user!.id,
      b.question,
      lang(req),
    );
    return { ...out, source: { kind: 'ai', model: 'claude' } };
  });

  // ---------------------------------------------------------------- price for a customer
  api.post('/ai/price', perm('orders', 'create'), async (req) => {
    const p = perms(req);
    if (!sees(p, 'seeCustomerPrices')) throw forbidden('noPriceAccess');
    const b = z
      .object({ wineNo: z.string().max(12), customerId: z.number().int().nullable().optional() })
      .parse(req.body);
    const db = req.ctx.db!;
    const cur = settings(db).currency;
    const w = db
      .prepare('SELECT id, winery, name, vintage, suggested_price FROM wines WHERE wine_no = ?')
      .get(b.wineNo) as
      | { id: number; winery: string; name: string; vintage: string; suggested_price: number | null }
      | undefined;
    if (!w) throw notFound('wineNotFound');
    const whole = (m: number | null) => (m == null ? null : fromMinor(m, cur));
    const market = (
      db
        .prepare(
          'SELECT effective_date date, price FROM price_history WHERE wine_id = ? AND voided = 0 ORDER BY effective_date DESC LIMIT 12',
        )
        .all(w.id) as { date: string; price: number }[]
    ).map((x) => ({ date: x.date, price: whole(x.price)! }));
    const customerPrices = b.customerId
      ? (
          db
            .prepare(
              `SELECT o.order_date date, l.unit_price price FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE l.wine_id = ? AND o.customer_id = ?
               AND o.status NOT IN ('draft','cancelled') AND l.unit_price IS NOT NULL ORDER BY o.order_date DESC LIMIT 10`,
            )
            .all(w.id, b.customerId) as { date: string; price: number }[]
        ).map((x) => ({ date: x.date, price: whole(x.price)! }))
      : [];
    // Cost only for roles that may see it (never sent otherwise).
    let cost: number | null = null;
    if (sees(p, 'seeCost')) {
      const c = db
        .prepare(
          "SELECT AVG(lot.base_unit_cost) c FROM bottles b JOIN lots lot ON lot.id = b.lot_id WHERE b.wine_id = ? AND b.status IN ('in_stock','reserved')",
        )
        .get(w.id) as { c: number | null };
      cost = c.c == null ? null : whole(Math.round(c.c));
    }
    const r = await ai(req, 'price').feature<PriceResult>(req.ctx.tenant!.slug, db, 'price', {
      wine: { winery: w.winery, name: w.name, vintage: w.vintage },
      currency: cur,
      market,
      suggested: whole(w.suggested_price),
      customerPrices,
      cost,
      targetMarginPct: null,
      lang: lang(req),
    });
    return {
      price: toMinor(r.result.price, cur),
      reason: r.result.reason,
      basis: { default: defaultPrice(db, w.id, b.customerId ?? null), usedCost: cost != null },
      source: { kind: 'ai', model: r.model },
    };
  });

  // ---------------------------------------------------------------- order from a customer's message
  api.post('/ai/order-message', perm('orders', 'create'), async (req) => {
    const b = z.object({ text: z.string().max(10000).optional(), image: Img.optional() }).parse(req.body);
    if (!b.text?.trim() && !b.image) throw badRequest('aiNothingToRead');
    const db = req.ctx.db!;
    const p = perms(req);
    const customers = db
      .prepare('SELECT id, customer_no no, name FROM customers WHERE active = 1 ORDER BY name LIMIT 500')
      .all() as { id: number; no: string; name: string }[];
    const r = await ai(req, 'orderMessage').feature<OrderMessageResult>(
      req.ctx.tenant!.slug,
      db,
      'orderMessage',
      {
        text: b.text,
        image: b.image,
        customers: customers.map((c) => c.name),
      },
    );
    const m = r.result;
    const customer = m.customer
      ? (customers.find((c) => c.name === m.customer) ??
        customers.find((c) => looksSame(c.name, m.customer!)) ??
        null)
      : null;
    return {
      customer,
      customerText: m.customer,
      delivery: m.delivery,
      note: m.note,
      lines: m.lines.map((l) => ({
        ...l,
        matches: matchWines(db, p, [l.winery, l.name, l.vintage].filter(Boolean).join(' ') || l.text, 4),
      })),
      source: { kind: 'ai', model: r.model },
    };
  });

  /** The user's checked draft becomes a normal draft order (prices from the usual defaults). */
  api.post('/ai/order-message/create', perm('orders', 'create'), (req) => {
    const b = z
      .object({
        customerId: z.number().int().nullable(),
        delivery: z.enum(['ship', 'pickup']).nullable().optional(),
        note: z.string().max(2000).nullable().optional(),
        lines: z
          .array(z.object({ wineNo: z.string().max(12), qty: z.number().int().min(1).max(10000) }))
          .min(1)
          .max(100),
      })
      .parse(req.body);
    const db = req.ctx.db!;
    return db.transaction(() => {
      const ids = b.lines.map((l) => {
        const w = db.prepare('SELECT id FROM wines WHERE wine_no = ?').get(l.wineNo) as
          { id: number } | undefined;
        if (!w) throw badRequest('wineNotFound', { wineNo: l.wineNo });
        return w.id;
      });
      req.ctx.licensing?.assertRoom('ordersPerMonth', 1);
      const o = createOrder(db, actor(req), req.ctx.user!, ids, { customerId: b.customerId });
      updateOrder(db, perms(req), actor(req), o, {
        delivery: b.delivery ?? undefined,
        note: b.note ?? undefined,
        lines: b.lines.map((l) => ({ wineNo: l.wineNo, qty: l.qty })),
      });
      return { orderNo: o.order_no };
    })();
  });

  /** For a draft order: other vintages of short wines, and what other customers bought with these wines (local). */
  api.get('/ai/order-suggestions/:no', perm('orders', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const o = orderByNo(db, String(req.params.no));
    if (!o) throw notFound('orderNotFound');
    mayOpen(p, req.ctx.user!, o);
    const sc = scopeSql(p, 'ce.id');
    const inStock = `(SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE b.wine_id = w.id AND b.status = 'in_stock' AND ${sc})`;
    const lines = db
      .prepare(
        `SELECT ol.wine_id id, ol.qty, w.winery, w.name, w.vintage, w.volume_ml, ${inStock} avail FROM order_lines ol JOIN wines w ON w.id = ol.wine_id WHERE ol.order_id = ?`,
      )
      .all(o.id) as {
      id: number;
      qty: number;
      winery: string;
      name: string;
      vintage: string;
      volume_ml: number;
      avail: number;
    }[];
    if (!lines.length) return { substitutes: [], alsoBought: [] };
    const ids = lines.map((l) => l.id);
    const substitutes = lines
      .filter((l) => l.avail < l.qty)
      .map((l) => ({
        for: (db.prepare('SELECT wine_no FROM wines WHERE id = ?').get(l.id) as { wine_no: string }).wine_no,
        wines: db
          .prepare(
            `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, ${inStock} qty FROM wines w WHERE w.winery = ? AND w.name = ? AND w.volume_ml = ? AND w.id <> ? AND ${inStock} > 0 ORDER BY ABS(CAST(w.vintage AS INTEGER) - CAST(? AS INTEGER)) LIMIT 4`,
          )
          .all(l.winery, l.name, l.volume_ml, l.id, l.vintage),
      }))
      .filter((x) => x.wines.length);
    const alsoBought = db
      .prepare(
        `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, COUNT(DISTINCT o2.customer_id) customers, ${inStock} qty
         FROM order_lines a JOIN orders o1 ON o1.id = a.order_id JOIN order_lines b2 ON b2.order_id = a.order_id
         JOIN orders o2 ON o2.id = b2.order_id JOIN wines w ON w.id = b2.wine_id
         WHERE a.wine_id IN (${ids.join(',')}) AND b2.wine_id NOT IN (${ids.join(',')}) AND o1.id <> ? AND o1.status NOT IN ('draft','cancelled')
         GROUP BY w.id HAVING ${inStock} > 0 ORDER BY customers DESC, ${inStock} DESC LIMIT 5`,
      )
      .all(o.id);
    return { substitutes, alsoBought };
  });

  // ---------------------------------------------------------------- suggestions (local, no AI call)
  api.get('/ai/suggestions', perm('inventory', 'view'), (req) => {
    const db = req.ctx.db!;
    const p = perms(req);
    const rows = drinkingStatus(db, p);
    const out: { kind: string; count: number; link: string }[] = [];
    const past = rows.filter((r) => r.status === 'past');
    const entering = rows.filter((r) => r.status === 'entering');
    const unknown = rows.filter((r) => r.status === 'unknown');
    if (past.length) out.push({ kind: 'pastWindow', count: past.length, link: '/drinking?status=past' });
    if (entering.length)
      out.push({ kind: 'enteringWindow', count: entering.length, link: '/drinking?status=entering' });
    if (unknown.length)
      out.push({ kind: 'noWindow', count: unknown.length, link: '/drinking?status=unknown' });
    const staleBefore = new Date(Date.now() - settings(db).staleDays * 86400_000).toISOString().slice(0, 10);
    const stale = db
      .prepare(
        `SELECT COUNT(DISTINCT w.id) n FROM wines w JOIN bottles b ON b.wine_id = w.id AND b.status = 'in_stock'
         WHERE COALESCE((SELECT MAX(effective_date) FROM price_history ph WHERE ph.wine_id = w.id AND ph.voided = 0), '') < ?`,
      )
      .get(staleBefore) as { n: number };
    if (stale.n) out.push({ kind: 'stalePrices', count: stale.n, link: '/?stale=1' });
    return out;
  });
}
