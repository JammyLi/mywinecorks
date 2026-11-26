/**
 * AI features (SPEC §10). This server never holds the Claude API key: it calls the MyWineCorks AI
 * gateway (connecting OUT only), signed with the workspace key, and only sends the data each request
 * needs. Answers are suggestions; nothing changes until a user saves it.
 * Cellar Q&A runs its tools HERE, with the asking user's permissions.
 */
import crypto from 'node:crypto';
import {
  AI_SWITCHES,
  fromMinor,
  sees,
  serviceSigningText,
  type AiSwitch,
  type AskResponse,
  type Permissions,
} from '@mwc/shared';
import type { Config } from '../config.ts';
import type { DB, Registry } from '../db/registry.ts';
import { ApiError, badRequest } from '../errors.ts';
import { clean, latestPrice, norm, scopeSql, settings, today, wineKey } from './inventory.ts';
import type { LicenseView } from './licensing.ts';
import { tenantKey } from './portal.ts';
import { buildSearch, type SearchQuery } from './search.ts';

export type AiSettings = Record<AiSwitch, boolean>;
export function aiSettings(db: DB): AiSettings {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined;
  const v = r ? (JSON.parse(r.value) as Partial<AiSettings>) : {};
  return Object.fromEntries(AI_SWITCHES.map((k) => [k, v[k] ?? true])) as AiSettings;
}
export function saveAiSettings(db: DB, s: AiSettings) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(JSON.stringify(s));
}
const aiKey = (db: DB) =>
  (db.prepare("SELECT value FROM settings WHERE key = 'aiKey'").get() as { value: string } | undefined)
    ?.value ?? null;
const setAiKey = (db: DB, k: string | null) =>
  db
    .prepare(
      "INSERT INTO settings (key, value) VALUES ('aiKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(k ?? '');

const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

export class AiClient {
  /** For tests. */
  fetcher: typeof fetch = (...a) => fetch(...a);

  constructor(
    private cfg: Config,
    private registry: Registry,
    private license: (slug: string) => LicenseView,
    private licenseKey: (slug: string) => string | null,
  ) {}

  /** In the plan, not locked, and switched on for this feature. */
  check(slug: string, db: DB, sw?: AiSwitch) {
    const l = this.license(slug);
    if (l.locked()) throw new ApiError(423, 'licenseLocked');
    if (!l.hasModule('ai')) throw new ApiError(403, 'aiNotInPlan');
    if (sw && !aiSettings(db)[sw]) throw new ApiError(403, 'aiOff');
  }

  private async send<T>(
    db: DB,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    key = aiKey(db),
  ): Promise<T> {
    const data = Buffer.from(body === undefined ? '' : JSON.stringify(body));
    const ts = new Date().toISOString();
    const k = tenantKey(db);
    const sig = crypto
      .sign(null, Buffer.from(serviceSigningText(ts, method, path, sha256(data))), k.privateKey)
      .toString('base64url');
    let res: Response;
    try {
      res = await this.fetcher(this.cfg.aiUrl + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-mwc-key': key ?? '',
          'x-mwc-ts': ts,
          'x-mwc-sig': sig,
        },
        body: method === 'GET' ? undefined : new Uint8Array(data),
        signal: AbortSignal.timeout(150_000),
      });
    } catch {
      throw new ApiError(502, 'aiUnreachable');
    }
    const out = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) {
      const code = out.error ?? 'aiError';
      throw new ApiError([401, 403, 429, 503].includes(res.status) ? res.status : 502, code);
    }
    return out;
  }

  async register(slug: string, db: DB) {
    const key = this.licenseKey(slug);
    if (!key) throw badRequest('updateNeedsLicense');
    const r = await this.send<{ key: string }>(
      db,
      'POST',
      '/api/register',
      { licenseKey: key, publicKey: tenantKey(db).publicKey },
      '',
    );
    setAiKey(db, r.key);
    return r.key;
  }

  /** A signed call; registers first (or again, after a renewal or a lost registration). */
  async call<T>(slug: string, db: DB, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!aiKey(db)) await this.register(slug, db);
    try {
      return await this.send<T>(db, method, path, body);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && ['unknownClient', 'badSignature'].includes(e.code)) {
        await this.register(slug, db);
        return this.send<T>(db, method, path, body);
      }
      throw e;
    }
  }

  feature<T>(slug: string, db: DB, name: string, body: unknown) {
    return this.call<{ result: T; model: string }>(slug, db, 'POST', `/api/ai/${name}`, body);
  }

  /** Cellar Q&A: Claude asks for figures, this server answers them with the user's permissions. */
  async ask(slug: string, db: DB, p: Permissions, userId: number, question: string, lang: 'zh-TW' | 'en') {
    const cur = settings(db).currency;
    const messages: { role: 'user' | 'assistant'; content: unknown }[] = [
      { role: 'user', content: question },
    ];
    const used: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const r = await this.call<AskResponse>(slug, db, 'POST', '/api/ai/ask', {
        messages,
        lang,
        today: today(db),
        currency: cur,
      });
      const calls = r.content.filter((c) => c.type === 'tool_use');
      if (!calls.length || r.stopReason !== 'tool_use') {
        const answer = r.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join('\n')
          .trim();
        const nos = [...new Set(answer.match(/W-\d{6}/g) ?? [])];
        const wines = nos.length
          ? (db
              .prepare(
                `SELECT wine_no wineNo, winery, name, vintage FROM wines WHERE wine_no IN (${nos.map(() => '?').join(',')})`,
              )
              .all(...nos) as unknown[])
          : [];
        return { answer, tools: used, wines };
      }
      messages.push({ role: 'assistant', content: r.content });
      messages.push({
        role: 'user',
        content: calls.map((c) => {
          const tc = c as { id: string; name: string; input: Record<string, unknown> };
          used.push(tc.name);
          let content: string;
          try {
            content = JSON.stringify(runTool(db, p, userId, tc.name, tc.input));
          } catch (e) {
            content = JSON.stringify({ error: e instanceof ApiError ? e.code : 'toolFailed' });
          }
          return { type: 'tool_result', tool_use_id: tc.id, content };
        }),
      });
    }
    throw new ApiError(502, 'aiBadAnswer');
  }
}

// ---------------------------------------------------------------- cellar Q&A tools (local, permission-aware)

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
const lim = (v: unknown, d = 20) => Math.min(Math.max(Number(v) || d, 1), 50);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

export function runTool(
  db: DB,
  p: Permissions,
  userId: number,
  name: string,
  input: Record<string, unknown>,
) {
  const cur = settings(db).currency;
  const money = (m: number | null) => (m == null ? null : Math.round(fromMinor(m, cur) * 100) / 100);
  const f = (input.filters ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'stock_summary': {
      const q: SearchQuery = {
        q: str(f.q),
        type: str(f.type),
        country: str(f.country),
        region: str(f.region),
        vmin: str(f.vintage_from),
        vmax: str(f.vintage_to),
      };
      const { from, args } = buildSearch(db, p, q);
      const key =
        {
          type: "COALESCE(t.en, w.type_code, '?')",
          country: "COALESCE(w.country, '?')",
          region: "COALESCE(w.region, '?')",
          cellar: 'ce.name',
          vintage: 'w.vintage',
          wine: "w.wine_no || ' ' || w.winery || ' ' || w.name || ' ' || w.vintage",
        }[String(input.group_by)] ?? "COALESCE(t.en, w.type_code, '?')";
      const rows = db
        .prepare(
          `SELECT ${key} AS grp, COUNT(*) AS bottles, SUM(${latestPrice}) AS value, SUM(CASE WHEN ${latestPrice} IS NULL THEN 1 ELSE 0 END) AS unpriced ${from} GROUP BY grp ORDER BY bottles DESC LIMIT ${lim(input.limit)}`,
        )
        .all(args) as { grp: string; bottles: number; value: number | null; unpriced: number }[];
      const tot = db.prepare(`SELECT COUNT(*) n, SUM(${latestPrice}) v ${from}`).get(args) as {
        n: number;
        v: number | null;
      };
      return {
        currency: cur,
        totalBottles: tot.n,
        totalMarketValue: money(tot.v),
        groups: rows.map((r) => ({ ...r, value: money(r.value) })),
      };
    }
    case 'purchases': {
      if (!sees(p, 'seeCost')) return { error: 'noPermission', needs: 'seeCost' };
      const merchants = sees(p, 'seeMerchants');
      const key =
        {
          type: "COALESCE(t.en, w.type_code, '?')",
          country: "COALESCE(w.country, '?')",
          region: "COALESCE(w.region, '?')",
          merchant: merchants ? "COALESCE(m.name, '?')" : "'(hidden)'",
          month: 'substr(lot.purchase_date, 1, 7)',
          wine: "w.wine_no || ' ' || w.winery || ' ' || w.name || ' ' || w.vintage",
        }[String(input.group_by)] ?? 'substr(lot.purchase_date, 1, 7)';
      const where = [scopeSql(p, 'ce.id')];
      const args: Record<string, unknown> = {};
      if (date(input.from)) ((args.from = date(input.from)), where.push('lot.purchase_date >= @from'));
      if (date(input.to)) ((args.to = date(input.to)), where.push('lot.purchase_date <= @to'));
      if (str(f.q)) ((args.q = '%' + norm(f.q) + '%'), where.push('w.search_key LIKE @q'));
      for (const k of ['region', 'country'] as const)
        if (str(f[k])) ((args[k] = str(f[k])), where.push(`w.${k} = @${k}`));
      if (str(f.type)) ((args.type = str(f.type)), where.push('w.type_code = @type'));
      const rows = db
        .prepare(
          `SELECT ${key} AS grp, COUNT(*) AS bottles, SUM(lot.base_unit_cost) AS spent FROM bottles b JOIN lots lot ON lot.id = b.lot_id JOIN wines w ON w.id = b.wine_id
           JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id LEFT JOIN merchants m ON m.id = lot.merchant_id
           LEFT JOIN wine_types t ON t.code = w.type_code WHERE ${where.join(' AND ')} GROUP BY grp ORDER BY spent DESC LIMIT 50`,
        )
        .all(args) as { grp: string; bottles: number; spent: number | null }[];
      return { currency: cur, groups: rows.map((r) => ({ ...r, spent: money(r.spent) })) };
    }
    case 'value_change': {
      if (!sees(p, 'seeCost')) return { error: 'noPermission', needs: 'seeCost' };
      const { from, args } = buildSearch(db, p, {});
      const rows = db
        .prepare(
          `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, COUNT(*) bottles, AVG(lot.base_unit_cost) cost, ${latestPrice} market ${from}
           GROUP BY w.id HAVING cost > 0 AND market IS NOT NULL ORDER BY market * 1.0 / cost DESC LIMIT ${lim(input.limit)}`,
        )
        .all(args) as { cost: number; market: number }[];
      const min = Number(input.min_ratio) || 0;
      return {
        currency: cur,
        wines: rows
          .map((r) => ({
            ...r,
            cost: money(Math.round(r.cost)),
            market: money(r.market),
            ratio: Math.round((r.market / r.cost) * 100) / 100,
          }))
          .filter((r) => r.ratio >= min),
      };
    }
    case 'sales': {
      if (!sees(p, 'seeCustomerPrices')) return { error: 'noPermission', needs: 'seeCustomerPrices' };
      const key =
        {
          month: 'substr(o.order_date, 1, 7)',
          customer: "COALESCE(c.name, '?')",
          wine: "w.wine_no || ' ' || w.winery || ' ' || w.name || ' ' || w.vintage",
        }[String(input.group_by)] ?? 'substr(o.order_date, 1, 7)';
      const where = ["o.status IN ('shipped','closed')"];
      const args: Record<string, unknown> = {};
      if (date(input.from)) ((args.from = date(input.from)), where.push('o.order_date >= @from'));
      if (date(input.to)) ((args.to = date(input.to)), where.push('o.order_date <= @to'));
      if (!sees(p, 'seeOthersOrders')) ((args.me = userId), where.push('o.created_by = @me'));
      const rows = db
        .prepare(
          `SELECT ${key} AS grp, SUM(ol.qty) AS bottles, SUM(ROUND(ol.qty * COALESCE(ol.unit_price, 0) * (1 - ol.discount / 100.0))) AS revenue
           FROM order_lines ol JOIN orders o ON o.id = ol.order_id JOIN wines w ON w.id = ol.wine_id LEFT JOIN customers c ON c.id = o.customer_id
           WHERE ${where.join(' AND ')} GROUP BY grp ORDER BY revenue DESC LIMIT 50`,
        )
        .all(args) as { grp: string; bottles: number; revenue: number | null }[];
      return {
        currency: cur,
        note: 'ex-tax, after line discounts',
        groups: rows.map((r) => ({ ...r, revenue: money(r.revenue) })),
      };
    }
    case 'drinking_window':
      return {
        wines: drinkingStatus(db, p)
          .filter((w) => input.status === 'all' || !input.status || w.status === input.status)
          .slice(0, 50),
      };
    default:
      return { error: 'unknownTool' };
  }
}

// ---------------------------------------------------------------- local helpers (no AI call)

export interface DrinkingRow {
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  bottles: number;
  drinkFrom: number | null;
  drinkTo: number | null;
  status: 'entering' | 'peak' | 'past' | 'young' | 'unknown';
}
/** In-stock wines (in the user's cellars) by drinking window this year. */
export function drinkingStatus(db: DB, p: Permissions): DrinkingRow[] {
  const year = Number(today(db).slice(0, 4));
  const { from, args } = buildSearch(db, p, {});
  const rows = db
    .prepare(
      `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, COUNT(*) bottles, w.drink_from drinkFrom, w.drink_to drinkTo ${from} GROUP BY w.id ORDER BY w.drink_to IS NULL, w.drink_to, w.winery`,
    )
    .all(args) as Omit<DrinkingRow, 'status'>[];
  return rows.map((r) => ({
    ...r,
    status:
      r.drinkFrom == null && r.drinkTo == null
        ? 'unknown'
        : r.drinkTo != null && r.drinkTo < year
          ? 'past'
          : r.drinkFrom === year
            ? 'entering'
            : r.drinkFrom != null && r.drinkFrom > year
              ? 'young'
              : 'peak',
  }));
}

/** Wines that look like the one read from a label: same match key first, then same producer and name. */
export function similarWines(
  db: DB,
  x: { winery?: string | null; name?: string | null; vintage?: string | null; volumeMl?: number | null },
) {
  if (!x.winery && !x.name) return [];
  const out = new Map<string, Record<string, unknown>>();
  const qty = `(SELECT COUNT(*) FROM bottles b WHERE b.wine_id = w.id AND b.status = 'in_stock')`;
  if (x.winery && x.name) {
    const key = wineKey({
      winery: x.winery,
      name: x.name,
      vintage: x.vintage || 'NV',
      volume_ml: x.volumeMl || 750,
    });
    for (const r of db
      .prepare(
        `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, w.volume_ml volumeMl, ${qty} qty, 1 exact FROM wines w WHERE match_key = ?`,
      )
      .all(key) as { wineNo: string }[])
      out.set(r.wineNo, r);
  }
  const words = clean(`${x.winery ?? ''} ${x.name ?? ''}`)
    .split(' ')
    .map(norm)
    .filter((w) => w.length > 1)
    .slice(0, 6);
  if (words.length) {
    const rows = db
      .prepare(
        `SELECT w.wine_no wineNo, w.winery, w.name, w.vintage, w.volume_ml volumeMl, ${qty} qty, 0 exact FROM wines w WHERE ${words.map(() => 'w.search_key LIKE ?').join(' AND ')} ORDER BY w.vintage DESC LIMIT 8`,
      )
      .all(...words.map((w) => `%${w}%`)) as { wineNo: string }[];
    for (const r of rows) if (!out.has(r.wineNo)) out.set(r.wineNo, r);
  }
  return [...out.values()].slice(0, 8);
}

/** Match free text ("Krug 2008 x6") to wines: all words must appear. */
export function matchWines(db: DB, p: Permissions, text: string, limit = 5) {
  const words = clean(text)
    .split(' ')
    .map(norm)
    .filter((w) => (w.length > 1 && !/^\d+$/.test(w)) || /^(19|20)\d{2}$/.test(w))
    .slice(0, 6);
  if (!words.length) return [];
  const sc = scopeSql(p, 'ce.id');
  const qty = `(SELECT COUNT(*) FROM bottles b JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id JOIN cellars ce ON ce.id = l.cellar_id WHERE b.wine_id = w.id AND b.status = 'in_stock' AND ${sc})`;
  const run = (ws: string[]) =>
    db
      .prepare(
        `SELECT w.id wineId, w.wine_no wineNo, w.winery, w.name, w.vintage, ${qty} qty FROM wines w WHERE ${ws.map(() => 'w.search_key LIKE ?').join(' AND ')} ORDER BY qty DESC, w.vintage DESC LIMIT ${limit}`,
      )
      .all(...ws.map((w) => `%${w}%`)) as { wineId: number; wineNo: string; qty: number }[];
  let rows = run(words);
  // Without the vintage when nothing matched with it.
  const noYear = words.filter((w) => !/^(19|20)\d{2}$/.test(w)).slice(0, 4);
  if (!rows.length && noYear.length && noYear.length < words.length) rows = run(noYear);
  return rows;
}
