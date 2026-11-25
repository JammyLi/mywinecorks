/** Search conditions → FROM … WHERE (search, facets, lists, export, labels). Port of MyWines search.js. */
import { sees, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { daysAgo, latestDate, latestPrice, norm, scopeSql, settings } from './inventory.ts';

export interface SearchQuery {
  q?: string;
  type?: string | string[];
  region?: string;
  country?: string;
  cellar?: string | number;
  locker?: string | number;
  rack?: string | number;
  merchant?: string | number;
  vmin?: string;
  vmax?: string;
  nv?: string;
  pmin?: string | number; // minor units
  pmax?: string | number;
  stale?: string;
  uncertain?: string;
  nocost?: string;
  wineIds?: string | number[];
  caseNo?: string;
  status?: string; // default in_stock
}

export function buildSearch(db: DB, p: Permissions, q: SearchQuery) {
  const status = q.status === 'held' ? "b.status IN ('in_stock','reserved')" : "b.status = 'in_stock'";
  const where = [status, scopeSql(p, 'ce.id')];
  const args: Record<string, unknown> = {};
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v).split(',')).map(String).filter(Boolean);
  if (q.q && String(q.q).trim()) {
    args.q = '%' + norm(q.q) + '%';
    args.raw = '%' + String(q.q).trim() + '%';
    where.push('(w.search_key LIKE @q OR c.case_no LIKE @raw OR b.bottle_no LIKE @raw OR l.code LIKE @raw)');
  }
  if (q.type) {
    const t = list(q.type);
    where.push(`w.type_code IN (${t.map((_, i) => '@t' + i).join(',')})`);
    t.forEach((v, i) => (args['t' + i] = v));
  }
  if (q.region) ((args.region = q.region), where.push('w.region = @region'));
  if (q.country) ((args.country = q.country), where.push('w.country = @country'));
  if (q.cellar) ((args.cellar = Number(q.cellar)), where.push('ce.id = @cellar'));
  if (q.locker) ((args.locker = Number(q.locker)), where.push('l.id = @locker'));
  if (q.rack) ((args.rack = Number(q.rack)), where.push('k.id = @rack'));
  if (q.merchant && sees(p, 'seeMerchants'))
    ((args.merchant = Number(q.merchant)), where.push('lot.merchant_id = @merchant'));
  if (q.vmin || q.vmax) {
    const nv = q.nv === '1' ? " OR w.vintage = 'NV'" : '';
    const c: string[] = [];
    if (q.vmin) ((args.vmin = String(q.vmin)), c.push('w.vintage >= @vmin'));
    if (q.vmax) ((args.vmax = String(q.vmax)), c.push('w.vintage <= @vmax'));
    where.push(`((w.vintage <> 'NV' AND ${c.join(' AND ')})${nv})`);
  } else if (q.nv === '0') where.push("w.vintage <> 'NV'");
  if (q.pmin !== undefined && q.pmin !== '')
    ((args.pmin = Number(q.pmin)), where.push(`${latestPrice} >= @pmin`));
  if (q.pmax !== undefined && q.pmax !== '')
    ((args.pmax = Number(q.pmax)), where.push(`${latestPrice} <= @pmax`));
  if (q.stale === '1') {
    args.staleBefore = daysAgo(db, settings(db).staleDays);
    where.push(`(${latestDate} IS NULL OR ${latestDate} < @staleBefore)`);
  }
  if (q.uncertain === '1') where.push('c.location_uncertain = 1');
  if (q.nocost === '1' && sees(p, 'seeCost')) where.push('lot.unit_cost IS NULL');
  if (q.wineIds) {
    const ids = list(q.wineIds).map(Number).filter(Number.isInteger);
    where.push(ids.length ? `w.id IN (${ids.join(',')})` : '0=1');
  }
  if (q.caseNo) ((args.caseNo = q.caseNo), where.push('c.case_no = @caseNo'));
  const from = `FROM bottles b JOIN wines w ON w.id = b.wine_id JOIN racks k ON k.id = b.rack_id JOIN lockers l ON l.id = k.locker_id
    JOIN cellars ce ON ce.id = l.cellar_id LEFT JOIN cases c ON c.id = b.case_id LEFT JOIN lots lot ON lot.id = b.lot_id
    LEFT JOIN merchants m ON m.id = lot.merchant_id LEFT JOIN wine_types t ON t.code = w.type_code WHERE ${where.join(' AND ')}`;
  return { from, args };
}
