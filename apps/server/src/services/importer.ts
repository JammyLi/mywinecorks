/**
 * Excel import (port of MyWines importer.js, extended): parse → preview (issues, merge suggestions) → commit.
 * Four kinds: inventory (wines + bottles + locations + cost + market price), storage, prices, merchants.
 * Headers may be Chinese or English, in any order; unknown columns are ignored.
 */
import ExcelJS from 'exceljs';
import { decimals, sees, toMinor, type Permissions } from '@mwc/shared';
import type { DB } from '../db/registry.ts';
import { nowIso } from '../db/registry.ts';
import { badRequest } from '../errors.ts';
import { audit, type Actor } from './audit.ts';
import {
  clean,
  inScope,
  nextBottleNo,
  nextWineNo,
  norm,
  searchKey,
  settings,
  today,
  wineKey,
} from './inventory.ts';

export const IMPORT_KINDS = ['inventory', 'storage', 'prices', 'merchants'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

// ---------------------------------------------------------------- columns
/** key → [zh header, en header, extra aliases…]. The first two are written in templates. */
type Col = {
  key: string;
  zh: string;
  en: string;
  aliases?: string[];
  required?: boolean;
  zhHelp: string;
  enHelp: string;
  example: (string | number)[];
};

const INVENTORY: Col[] = [
  {
    key: 'cellar',
    zh: '酒窖',
    en: 'Cellar',
    aliases: ['倉庫'],
    zhHelp: '酒窖名稱。空白＝「未指定酒窖」',
    enHelp: 'Cellar name. Blank = "Unassigned cellar"',
    example: ['內湖倉', '內湖倉', '淡水倉'],
  },
  {
    key: 'locker',
    zh: '位置',
    en: 'Locker',
    aliases: ['分儲空間'],
    zhHelp: '分儲空間代碼，例如 A31。代碼後加「?」代表位置待確認',
    enHelp: 'Locker code, e.g. A31. Add "?" if the location needs checking',
    example: ['A31', 'A32', 'B12?'],
  },
  {
    key: 'rack',
    zh: '架子',
    en: 'Rack',
    zhHelp: '架子名稱。空白＝該分儲空間的「未指定」架子',
    enHelp: "Rack. Blank = the locker's unassigned rack",
    example: ['上層', '', ''],
  },
  {
    key: 'caseNo',
    zh: '箱號',
    en: 'Case no.',
    aliases: ['編號', 'box', 'case'],
    zhHelp: '整箱入庫時填；散瓶留空',
    enHelp: 'Fill in for a case; leave blank for loose bottles',
    example: ['C-0001', 'C-0002', ''],
  },
  {
    key: 'country',
    zh: '國家',
    en: 'Country',
    zhHelp: '',
    enHelp: '',
    example: ['France', 'France', 'Italy'],
  },
  {
    key: 'winery',
    zh: '酒莊',
    en: 'Winery',
    required: true,
    zhHelp: '必填',
    enHelp: 'Required',
    example: ['Domaine Leroy', 'Krug', 'Gaja'],
  },
  {
    key: 'name',
    zh: '品名',
    en: 'Wine name',
    aliases: ['name'],
    required: true,
    zhHelp: '必填',
    enHelp: 'Required',
    example: ['Bourgogne Aligoté', 'Grande Cuvée 171ème Édition', 'Barbaresco'],
  },
  {
    key: 'region',
    zh: '產區',
    en: 'Region',
    zhHelp: '例如 Burgundy、Champagne',
    enHelp: 'e.g. Burgundy, Champagne',
    example: ['Burgundy', 'Champagne', 'Piedmont'],
  },
  {
    key: 'classification',
    zh: '分級',
    en: 'Classification',
    zhHelp: '例如 1er Cru',
    enHelp: 'e.g. 1er Cru',
    example: ['', '', 'DOCG'],
  },
  {
    key: 'vintage',
    zh: '年份',
    en: 'Vintage',
    zhHelp: '四位數年份，無年份填 NV',
    enHelp: '4-digit year, or NV',
    example: [2018, 'NV', 2019],
  },
  {
    key: 'type',
    zh: '種類',
    en: 'Type',
    zhHelp: '種類代碼，見「種類代碼」工作表',
    enHelp: 'Type code — see the "Type codes" sheet',
    example: ['W', 'CP', 'R'],
  },
  {
    key: 'qty',
    zh: '瓶數',
    en: 'Bottles',
    aliases: ['quantity', 'qty'],
    required: true,
    zhHelp: '必填，整數',
    enHelp: 'Required, whole number',
    example: [6, 6, 2],
  },
  {
    key: 'volume',
    zh: '容量',
    en: 'Size (ml)',
    aliases: ['volume', 'size'],
    zhHelp: 'ml，空白＝750；也可寫 1.5L',
    enHelp: 'ml, blank = 750; "1.5L" also works',
    example: [750, 750, '1.5L'],
  },
  {
    key: 'merchant',
    zh: '酒商',
    en: 'Merchant',
    aliases: ['supplier'],
    zhHelp: '向哪家酒商採購',
    enHelp: 'Who you bought from',
    example: ['示範酒商', '示範酒商', ''],
  },
  {
    key: 'cost',
    zh: '採購價格',
    en: 'Purchase price',
    aliases: ['cost'],
    zhHelp: '每瓶',
    enHelp: 'Per bottle',
    example: [3200, 6800, ''],
  },
  {
    key: 'currency',
    zh: '幣別',
    en: 'Currency',
    zhHelp: '採購價格的幣別，空白＝系統幣別',
    enHelp: 'Currency of the purchase price. Blank = your base currency',
    example: ['', '', ''],
  },
  {
    key: 'fxRate',
    zh: '匯率',
    en: 'Exchange rate',
    aliases: ['fx'],
    zhHelp: '外幣採購時必填：1 外幣 = ? 系統幣別',
    enHelp: 'Needed for foreign currency: 1 unit = ? base currency',
    example: ['', '', ''],
  },
  {
    key: 'purchaseDate',
    zh: '採購日期',
    en: 'Purchase date',
    zhHelp: 'YYYY-MM-DD',
    enHelp: 'YYYY-MM-DD',
    example: ['2025-06-10', '', ''],
  },
  {
    key: 'market',
    zh: '市場價格',
    en: 'Market price',
    aliases: ['國際均價', 'market value'],
    zhHelp: '每瓶市場價格',
    enHelp: 'Market price per bottle',
    example: [4500, 8200, ''],
  },
  {
    key: 'marketDate',
    zh: '查價日期',
    en: 'Price date',
    aliases: ['市場價格生效日期'],
    zhHelp: '市場價格的日期 YYYY-MM-DD，空白＝今天',
    enHelp: 'Date of the market price, YYYY-MM-DD. Blank = today',
    example: ['2026-11-01', '2026-11-01', ''],
  },
  {
    key: 'suggested',
    zh: '建議售價',
    en: 'Suggested price',
    aliases: ['銷售價格', 'selling price'],
    zhHelp: '每瓶',
    enHelp: 'Per bottle',
    example: ['', 9800, ''],
  },
  {
    key: 'grapes',
    zh: '葡萄品種',
    en: 'Grapes',
    zhHelp: '',
    enHelp: '',
    example: ['Aligoté', '', 'Nebbiolo'],
  },
  {
    key: 'drinkFrom',
    zh: '適飲開始',
    en: 'Drink from',
    zhHelp: '年份，例如 2025',
    enHelp: 'Year, e.g. 2025',
    example: ['', '', 2024],
  },
  {
    key: 'drinkTo',
    zh: '適飲結束',
    en: 'Drink until',
    zhHelp: '年份，例如 2040',
    enHelp: 'Year, e.g. 2040',
    example: ['', '', 2040],
  },
  {
    key: 'note',
    zh: '備註',
    en: 'Note',
    aliases: ['notes'],
    zhHelp: '可以有好幾欄（備註、備註1…），匯入時合併',
    enHelp: 'Several note columns are allowed and combined',
    example: ['', '', '散瓶，位置待確認'],
  },
];

const STORAGE: Col[] = [
  {
    key: 'cellar',
    zh: '酒窖',
    en: 'Cellar',
    required: true,
    zhHelp: '必填',
    enHelp: 'Required',
    example: ['內湖倉', '內湖倉', '淡水倉'],
  },
  {
    key: 'locker',
    zh: '分儲空間',
    en: 'Locker',
    aliases: ['位置'],
    zhHelp: '空白＝只建立酒窖',
    enHelp: 'Blank = create the cellar only',
    example: ['A31', 'A31', ''],
  },
  {
    key: 'rack',
    zh: '架子',
    en: 'Rack',
    zhHelp: '空白＝只建立分儲空間',
    enHelp: 'Blank = create the locker only',
    example: ['上層', '下層', ''],
  },
  {
    key: 'capacity',
    zh: '容量',
    en: 'Capacity',
    zhHelp: '可放瓶數（分儲空間或架子）',
    enHelp: 'Bottles it holds (locker or rack)',
    example: [48, 48, ''],
  },
  {
    key: 'address',
    zh: '地址',
    en: 'Address',
    zhHelp: '酒窖地址',
    enHelp: 'Cellar address',
    example: ['台北市內湖區', '', '新北市淡水區'],
  },
  {
    key: 'monthlyRent',
    zh: '每月租金',
    en: 'Monthly rent',
    zhHelp: '酒窖每月租金',
    enHelp: 'Cellar monthly rent',
    example: [12000, '', 8000],
  },
  {
    key: 'climate',
    zh: '溫濕度',
    en: 'Temperature / humidity',
    zhHelp: '',
    enHelp: '',
    example: ['13°C / 70%', '', ''],
  },
  { key: 'note', zh: '備註', en: 'Note', aliases: ['notes'], zhHelp: '', enHelp: '', example: ['', '', ''] },
];

const PRICES: Col[] = [
  {
    key: 'wineNo',
    zh: '酒款編號',
    en: 'Wine no.',
    zhHelp: '填酒款編號，或填酒莊＋品名＋年份',
    enHelp: 'Wine no., or winery + name + vintage',
    example: ['W-000001', '', ''],
  },
  { key: 'winery', zh: '酒莊', en: 'Winery', zhHelp: '', enHelp: '', example: ['', 'Krug', 'Gaja'] },
  {
    key: 'name',
    zh: '品名',
    en: 'Wine name',
    aliases: ['name'],
    zhHelp: '',
    enHelp: '',
    example: ['', 'Grande Cuvée 171ème Édition', 'Barbaresco'],
  },
  { key: 'vintage', zh: '年份', en: 'Vintage', zhHelp: '', enHelp: '', example: ['', 'NV', 2019] },
  {
    key: 'volume',
    zh: '容量',
    en: 'Size (ml)',
    aliases: ['volume'],
    zhHelp: '空白＝750',
    enHelp: 'Blank = 750',
    example: ['', '', '1.5L'],
  },
  {
    key: 'price',
    zh: '市場價格',
    en: 'Market price',
    aliases: ['國際均價', 'price'],
    required: true,
    zhHelp: '必填，每瓶',
    enHelp: 'Required, per bottle',
    example: [4600, 8300, 9100],
  },
  {
    key: 'date',
    zh: '查價日期',
    en: 'Price date',
    aliases: ['date', '日期'],
    zhHelp: 'YYYY-MM-DD，空白＝今天',
    enHelp: 'YYYY-MM-DD, blank = today',
    example: ['2026-11-20', '2026-11-20', ''],
  },
  {
    key: 'source',
    zh: '來源',
    en: 'Source',
    zhHelp: '',
    enHelp: '',
    example: ['Wine-Searcher', 'Wine-Searcher', ''],
  },
  { key: 'url', zh: '網址', en: 'Link', aliases: ['url'], zhHelp: '', enHelp: '', example: ['', '', ''] },
];

const MERCHANTS: Col[] = [
  {
    key: 'name',
    zh: '酒商',
    en: 'Merchant',
    aliases: ['name', '名稱'],
    required: true,
    zhHelp: '必填',
    enHelp: 'Required',
    example: ['示範酒商', 'Andy Wines', ''],
  },
  {
    key: 'contact',
    zh: '聯絡人',
    en: 'Contact',
    zhHelp: '',
    enHelp: '',
    example: ['王先生', 'Andy Chen', ''],
  },
  { key: 'phone', zh: '電話', en: 'Phone', zhHelp: '', enHelp: '', example: ['02-1234-5678', '', ''] },
  { key: 'email', zh: 'Email', en: 'Email', zhHelp: '', enHelp: '', example: ['', 'andy@example.com', ''] },
  { key: 'note', zh: '備註', en: 'Note', aliases: ['notes'], zhHelp: '', enHelp: '', example: ['', '', ''] },
];

export const COLUMNS: Record<ImportKind, Col[]> = {
  inventory: INVENTORY,
  storage: STORAGE,
  prices: PRICES,
  merchants: MERCHANTS,
};

// ---------------------------------------------------------------- parsing helpers
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined)
      return o.result instanceof Date ? o.result.toISOString().slice(0, 10) : String(o.result);
    return '';
  }
  return String(v);
}

function matchHeader(cols: Col[], h: string): string | null {
  const t = clean(h).toLowerCase();
  if (!t) return null;
  for (const c of cols) {
    const names = [c.zh, c.en, ...(c.aliases ?? [])].map((x) => x.toLowerCase());
    if (names.some((a) => t === a || t.startsWith(a))) return c.key;
  }
  return null;
}

const num = (s: string): number | null => {
  const x = clean(s)
    .replace(/[,，\s]/g, '')
    .replace(/^(NT\$|US\$|\$)/i, '');
  if (!x) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
};

function parseVintage(raw: string): { vintage: string; extra?: string } {
  const s = clean(raw);
  if (!s || /^nv$/i.test(s)) return { vintage: 'NV' };
  if (/^\d{4}(\.0+)?$/.test(s)) return { vintage: s.slice(0, 4) };
  const m = s.match(/(18|19|20)\d{2}/);
  return m ? { vintage: m[0], extra: s } : { vintage: 'NV', extra: s };
}

function parseDate(raw: string): string | null | undefined {
  const s = clean(raw);
  if (!s) return null;
  const m = s.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : undefined; // undefined = invalid
}

function parseVolume(raw: string): number {
  const s = clean(raw).toLowerCase();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 750;
  if (s.includes('l') && !s.includes('ml')) return Math.round(n * 1000);
  return Math.round(n);
}

function lev(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const REGION_SYNONYMS: Record<string, string> = {
  bourgogne: 'Burgundy',
  勃根地: 'Burgundy',
  布根地: 'Burgundy',
  波爾多: 'Bordeaux',
  香檳: 'Champagne',
};

// ---------------------------------------------------------------- preview model
export interface Issue {
  level: 'error' | 'warn' | 'info';
  code: string; // translated on the web as imp.<code>
  lines: number[]; // spreadsheet row numbers
  details: string[]; // the values concerned (case numbers, codes…), unique
}
export interface Suggestion {
  field: 'winery' | 'merchant' | 'region';
  kind: 'remembered' | 'spelling' | 'synonym' | 'similar';
  from: string;
  to: string;
  fromCount: number;
  toCount: number;
  auto: boolean;
  /** `to` is already used in this workspace */
  existing?: boolean;
}
type Row = Record<string, string> & { line: number };

export interface Parsed {
  kind: ImportKind;
  rows: Row[];
  missingColumns: string[];
  ignoredColumns: string[];
}

export async function parseWorkbook(kind: ImportKind, buf: Buffer): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw badRequest('notExcel');
  }
  const cols = COLUMNS[kind];
  // Use the first sheet whose header row matches the required columns.
  for (const ws of wb.worksheets) {
    const map: Record<number, string> = {};
    const ignored: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      const h = cellText(cell.value);
      const key = matchHeader(cols, h);
      if (key) map[col] = key;
      else if (clean(h)) ignored.push(clean(h));
    });
    const found = new Set(Object.values(map));
    const missing = cols.filter((c) => c.required && !found.has(c.key)).map((c) => c.key);
    if (missing.length && ws !== wb.worksheets.at(-1)) continue;
    const rows: Row[] = [];
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r === 1) return;
      const o: Row = { line: r } as Row;
      const notes: string[] = [];
      for (const [col, key] of Object.entries(map)) {
        const raw = cellText(row.getCell(Number(col)).value);
        // A cellar cell with several lines (MyWines sheets): first line is the cellar, the rest is ignored.
        const lines = raw.split(/\r?\n/).map(clean).filter(Boolean);
        const v = key === 'cellar' ? (lines[0] ?? '') : clean(raw);
        if (key === 'cellar' && lines.length > 1) o.cellarExtra = lines.slice(1).join(' ');
        if (key === 'note') {
          if (v) notes.push(v);
        } else if (!(key in o) || !o[key]) o[key] = v;
      }
      if (notes.length) o.note = notes.join(' / ');
      if (Object.entries(o).some(([k, v]) => k !== 'line' && v)) rows.push(o);
    });
    return { kind, rows, missingColumns: missing, ignoredColumns: ignored };
  }
  return {
    kind,
    rows: [],
    missingColumns: cols.filter((c) => c.required).map((c) => c.key),
    ignoredColumns: [],
  };
}

// ---------------------------------------------------------------- name merging (inventory)
type Field = 'winery' | 'merchant' | 'region';
const FIELDS: Field[] = ['winery', 'merchant', 'region'];
const hasHan = (s: string) => /\p{Script=Han}/u.test(s);

/** Names already in this workspace, with how often they are used. */
function knownNames(db: DB, field: Field): Map<string, number> {
  const sql =
    field === 'merchant'
      ? 'SELECT m.name n, (SELECT COUNT(*) FROM lots WHERE merchant_id = m.id) c FROM merchants m'
      : `SELECT ${field} n, COUNT(*) c FROM wines WHERE COALESCE(${field}, '') <> '' GROUP BY ${field}`;
  return new Map((db.prepare(sql).all() as { n: string; c: number }[]).map((r) => [r.n, r.c]));
}

export function aliasesOf(db: DB, field: Field): Map<string, string> {
  return new Map(
    (
      db.prepare('SELECT alias, canonical FROM name_aliases WHERE field = ?').all(field) as {
        alias: string;
        canonical: string;
      }[]
    ).map((r) => [r.alias.toLowerCase(), r.canonical]),
  );
}

/** Apply a remembered match to a typed name (merchant / winery). */
export function canonicalName(db: DB, field: Field, name: string): string {
  return aliasesOf(db, field).get(name.trim().toLowerCase()) ?? name;
}

/**
 * Could two names be the same thing spelled differently?
 * Chinese names are short, so 2 characters already count: 吉星 ≈ 吉興, 安迪 ≈ 安迪酒藏.
 */
export function looksSame(a: string, b: string): boolean {
  const [ka, kb] = [norm(a), norm(b)];
  if (!ka || !kb || ka === kb) return false;
  const short = Math.min(ka.length, kb.length);
  const dist = lev(ka, kb);
  if (hasHan(ka) || hasHan(kb)) {
    if (short >= 2 && (ka.startsWith(kb) || kb.startsWith(ka))) return true;
    return short >= 2 && ka[0] === kb[0] && dist <= 1 && Math.abs(ka.length - kb.length) <= 1;
  }
  const contains = short >= 3 && (ka.startsWith(kb) || kb.startsWith(ka));
  const near =
    (short >= 3 && short < 6 && dist <= 1 && ka.length === kb.length && ka[0] === kb[0]) ||
    (short >= 6 && dist <= 2);
  return contains || near;
}

/**
 * Name problems in an import file, compared within the file AND against names already in the workspace:
 * remembered matches and spelling variants are applied automatically; look-alikes are suggested.
 */
export function suggestMerges(rows: Row[], db?: DB): Suggestion[] {
  const out: Suggestion[] = [];
  for (const field of FIELDS) {
    const counts = new Map<string, number>();
    for (const r of rows) if (r[field]) counts.set(r[field], (counts.get(r[field]) ?? 0) + 1);
    const known = db ? knownNames(db, field) : new Map<string, number>();
    const aliases = db ? aliasesOf(db, field) : new Map<string, string>();
    const merged = new Map<string, string>();
    const total = (n: string) => (counts.get(n) ?? 0) + (known.get(n) ?? 0);

    // 0. Matches confirmed on an earlier import.
    for (const [name, n] of counts) {
      const to = aliases.get(name.toLowerCase());
      if (to && to !== name) {
        merged.set(name, to);
        out.push({
          field,
          kind: 'remembered',
          from: name,
          to,
          fromCount: n,
          toCount: total(to),
          auto: true,
          existing: known.has(to),
        });
      }
    }
    // 1. Same letters, different case / accents / spacing → merge automatically.
    //    Prefer a name already in the workspace, then accents / Chinese, then the most used.
    const byKey = new Map<string, string[]>();
    for (const name of new Set([...counts.keys(), ...known.keys()])) {
      if (merged.has(name)) continue;
      const k = norm(name);
      byKey.set(k, [...(byKey.get(k) ?? []), name]);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort(
        (a, b) =>
          Number(known.has(b)) - Number(known.has(a)) ||
          Number(/[^\x00-\x7f]/.test(b)) - Number(/[^\x00-\x7f]/.test(a)) ||
          total(b) - total(a),
      );
      const to = group[0];
      for (const name of group.slice(1)) {
        if (!counts.has(name)) continue;
        merged.set(name, to);
        out.push({
          field,
          kind: 'spelling',
          from: name,
          to,
          fromCount: counts.get(name)!,
          toCount: total(to),
          auto: true,
          existing: known.has(to),
        });
      }
    }
    if (field === 'region')
      for (const [name, n] of counts) {
        const syn = REGION_SYNONYMS[norm(name)];
        if (syn && syn !== name && !merged.has(name)) {
          merged.set(name, syn);
          out.push({
            field,
            kind: 'synonym',
            from: name,
            to: syn,
            fromCount: n,
            toCount: total(syn),
            auto: true,
            existing: known.has(syn),
          });
        }
      }
    // 2. Look-alikes → suggestion only; the user decides (and which spelling to keep).
    const fileNames = [...new Set([...counts.keys()].map((n) => merged.get(n) ?? n))];
    const candidates = [...new Set([...fileNames, ...known.keys()])];
    const seen = new Set<string>();
    for (const a of fileNames)
      for (const b of candidates) {
        if (a === b || !looksSame(a, b)) continue;
        const pair = [a, b].sort().join('\u0000');
        if (seen.has(pair)) continue;
        seen.add(pair);
        const [to, from] =
          known.has(b) && !known.has(a)
            ? [b, a]
            : known.has(a) && !known.has(b)
              ? [a, b]
              : total(a) >= total(b)
                ? [a, b]
                : [b, a];
        const fileCount = (n: string) =>
          [...counts].filter(([x]) => (merged.get(x) ?? x) === n).reduce((s, [, c]) => s + c, 0);
        out.push({
          field,
          kind: 'similar',
          from,
          to,
          fromCount: fileCount(from) || total(from),
          toCount: total(to),
          auto: false,
          existing: known.has(to),
        });
      }
  }
  return out;
}

export type Merges = Partial<Record<'winery' | 'merchant' | 'region', Record<string, string>>>;
/**
 * Merges to apply: automatic ones, plus look-alikes the user confirmed as "field|from|to".
 * The user may keep either spelling, so a confirmed pair may come in either direction.
 */
export function mergesFrom(s: Suggestion[], accepted: string[] = []): Merges {
  const m: Merges = {};
  for (const x of s) if (x.auto) (m[x.field] ??= {})[x.from] = x.to;
  for (const id of accepted) {
    const [field, from, to] = id.split('|') as [Field, string, string];
    const sug = s.find(
      (x) =>
        !x.auto &&
        x.field === field &&
        ((x.from === from && x.to === to) || (x.from === to && x.to === from)),
    );
    if (!sug) continue;
    // Reversed: keep the file's spelling instead of the existing one — only merchants can be renamed.
    if (sug.existing && sug.to === from && field !== 'merchant') continue;
    const fm = (m[field] ??= {});
    fm[from] = to;
    // Names that were already merged into `from` follow it.
    for (const [k, v] of Object.entries(fm)) if (v === from) fm[k] = to;
  }
  return m;
}

/**
 * When the user keeps the file's spelling for a merchant that already exists (安迪酒藏 → 安迪),
 * rename the existing merchant (or fold it into the chosen one) so there is a single merchant.
 */
export function renameMerchants(db: DB, s: Suggestion[], accepted: string[], who: Actor) {
  for (const id of accepted) {
    const [field, from, to] = id.split('|');
    if (field !== 'merchant') continue;
    const sug = s.find(
      (x) => !x.auto && x.field === 'merchant' && x.existing && x.from === to && x.to === from,
    );
    if (!sug) continue;
    const old = db.prepare('SELECT id FROM merchants WHERE name = ?').get(from) as { id: number } | undefined;
    if (!old) continue;
    const target = db.prepare('SELECT id FROM merchants WHERE name = ?').get(to) as
      { id: number } | undefined;
    if (target) {
      db.prepare('UPDATE lots SET merchant_id = ? WHERE merchant_id = ?').run(target.id, old.id);
      db.prepare('DELETE FROM merchants WHERE id = ?').run(old.id);
    } else db.prepare('UPDATE merchants SET name = ? WHERE id = ?').run(to, old.id);
    audit(db, who, {
      category: 'settings',
      action: 'merchantRenamed',
      objType: 'merchant',
      objId: target?.id ?? old.id,
      objLabel: to,
      changes: { name: [from, to] },
    });
  }
}

/** Remember confirmed look-alike matches for later imports and typing. */
export function rememberMerges(db: DB, s: Suggestion[], accepted: string[], userId: number | null) {
  const ins = db.prepare(
    'INSERT INTO name_aliases (field, alias, canonical, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(field, alias) DO UPDATE SET canonical = excluded.canonical',
  );
  for (const id of accepted) {
    const [field, from, to] = id.split('|');
    if (
      s.some(
        (x) =>
          !x.auto &&
          x.field === field &&
          ((x.from === from && x.to === to) || (x.from === to && x.to === from)),
      )
    )
      ins.run(field, from, to, userId, nowIso());
  }
}

// ---------------------------------------------------------------- validation + commit
const unassignedCellar = (db: DB) =>
  (db.prepare("SELECT value FROM settings WHERE key = 'defaultLang'").get() as { value: string } | undefined)
    ?.value === 'en'
    ? 'Unassigned cellar'
    : '未指定酒窖';

export interface Ctx {
  db: DB;
  p: Permissions;
  who: Actor;
  filename: string;
}

interface Plan {
  issues: Issue[];
  summary: Record<string, number>;
  apply: () => Record<string, unknown>;
}

/** One entry per problem type, listing every row and value concerned. */
const addIssue = (issues: Issue[], level: Issue['level'], code: string, line: number, detail?: string) => {
  let found = issues.find((i) => i.code === code && i.level === level);
  if (!found) issues.push((found = { level, code, lines: [], details: [] }));
  if (!found.lines.includes(line)) found.lines.push(line);
  if (detail && !found.details.includes(detail)) found.details.push(detail);
};

/** Find or plan storage. `create` is false during preview. */
function storageResolver(ctx: Ctx, issues: Issue[], create: boolean) {
  const { db, p } = ctx;
  const can = (a: string) => !!(p.functions.locations as string[] | undefined)?.includes(a);
  const pending = { cellars: new Set<string>(), lockers: new Set<string>(), racks: new Set<string>() };
  const cellarId = (name: string, line: number): number | null => {
    const c = db.prepare('SELECT id FROM cellars WHERE name = ?').get(name) as { id: number } | undefined;
    if (c) {
      if (!inScope(p, c.id)) return (addIssue(issues, 'error', 'cellarOutOfScope', line, name), null);
      return c.id;
    }
    if (!can('createCellar')) return (addIssue(issues, 'error', 'noCreateCellar', line, name), null);
    if (!create) return (pending.cellars.add(name), -1);
    const id = Number(
      db.prepare('INSERT INTO cellars (name, created_at) VALUES (?, ?)').run(name, nowIso()).lastInsertRowid,
    );
    audit(db, ctx.who, {
      category: 'locations',
      action: 'cellarCreated',
      objType: 'cellar',
      objId: id,
      objLabel: name,
      reason: ctx.filename,
    });
    return id;
  };
  const lockerId = (cId: number, cellarName: string, code: string, line: number): number | null => {
    const l =
      cId > 0
        ? (db.prepare('SELECT id FROM lockers WHERE cellar_id = ? AND code = ?').get(cId, code) as
            { id: number } | undefined)
        : undefined;
    if (l) return l.id;
    if (!can('edit'))
      return (addIssue(issues, 'error', 'noEditLocations', line, `${cellarName} › ${code}`), null);
    if (!create) return (pending.lockers.add(`${cellarName}|${code}`), -1);
    const id = Number(
      db.prepare('INSERT INTO lockers (cellar_id, code) VALUES (?, ?)').run(cId, code).lastInsertRowid,
    );
    db.prepare("INSERT INTO racks (locker_id, code, is_default) VALUES (?, '-', 1)").run(id);
    audit(db, ctx.who, {
      category: 'locations',
      action: 'lockerCreated',
      objType: 'locker',
      objId: id,
      objLabel: `${cellarName} › ${code}`,
      reason: ctx.filename,
    });
    return id;
  };
  const rackId = (lId: number, label: string, code: string, line: number): number | null => {
    if (lId < 0) {
      if (code) pending.racks.add(`${label}|${code}`);
      return -1;
    }
    if (!code)
      return (
        db.prepare('SELECT id FROM racks WHERE locker_id = ? AND is_default = 1').get(lId) as { id: number }
      ).id;
    const r = db.prepare('SELECT id FROM racks WHERE locker_id = ? AND code = ?').get(lId, code) as
      { id: number } | undefined;
    if (r) return r.id;
    if (!can('edit')) return (addIssue(issues, 'error', 'noEditLocations', line, `${label} › ${code}`), null);
    if (!create) return (pending.racks.add(`${label}|${code}`), -1);
    const id = Number(
      db.prepare('INSERT INTO racks (locker_id, code) VALUES (?, ?)').run(lId, code).lastInsertRowid,
    );
    audit(db, ctx.who, {
      category: 'locations',
      action: 'rackCreated',
      objType: 'rack',
      objId: id,
      objLabel: `${label} › ${code}`,
      reason: ctx.filename,
    });
    return id;
  };
  return { cellarId, lockerId, rackId, pending };
}

function inventoryPlan(ctx: Ctx, rows: Row[], merges: Merges, create: boolean): Plan {
  const { db, p } = ctx;
  const issues: Issue[] = [];
  const base = settings(db).currency;
  const canCost = sees(p, 'seeCost');
  const canMerchant = sees(p, 'seeMerchants');
  const canPrice = !!(p.functions.prices as string[] | undefined)?.includes('edit');
  const st = storageResolver(ctx, issues, create);
  const types = new Set(
    (db.prepare('SELECT code FROM wine_types').all() as { code: string }[]).map((r) => r.code),
  );
  const caseSeen = new Map<string, number>();
  const wineKeys = new Set<string>();
  const newWineKeys = new Set<string>();
  let bottles = 0,
    cases = 0,
    prices = 0,
    skipped = 0;
  const now = today(db);
  const results = { wines: 0, cases: 0, bottles: 0, prices: 0, skipped: 0, firstBottle: '', lastBottle: '' };
  let costIgnored = false,
    merchantIgnored = false,
    priceIgnored = false;

  for (const r0 of rows) {
    const line = r0.line;
    const r: Row = { ...r0 };
    for (const f of ['winery', 'merchant', 'region'] as const)
      if (r[f] && merges[f]?.[r[f]]) r[f] = merges[f]![r[f]];
    if (!r.winery || !r.name) {
      addIssue(issues, 'error', 'missingWineryName', line);
      skipped++;
      continue;
    }
    const qtyN = num(r.qty ?? '');
    if (qtyN === null || Number.isNaN(qtyN) || qtyN < 0 || !Number.isInteger(qtyN) || qtyN > 600) {
      addIssue(issues, 'error', 'badQty', line, r.qty);
      skipped++;
      continue;
    }
    const v = parseVintage(r.vintage ?? '');
    if (v.extra) addIssue(issues, 'warn', 'vintageText', line, v.extra);
    const volume = parseVolume(r.volume ?? '');
    let type = clean(r.type).toUpperCase() || null;
    if (!type) addIssue(issues, 'warn', 'noType', line);
    else if (!types.has(type)) addIssue(issues, 'warn', 'unknownType', line, type);
    // location
    let lockerCode = clean(r.locker);
    const uncertain = /[?？]/.test(lockerCode);
    lockerCode = lockerCode.replace(/[?？]/g, '').trim() || '-';
    if (uncertain) addIssue(issues, 'info', 'locationUncertain', line);
    if (r.cellarExtra) addIssue(issues, 'info', 'cellarExtraIgnored', line, r.cellarExtra);
    const cellarName = clean(r.cellar).split(/\r?\n/)[0] || unassignedCellar(db);
    if (!clean(r.cellar)) addIssue(issues, 'warn', 'noCellar', line);
    const caseNo = clean(r.caseNo);
    if (caseNo) {
      if (caseSeen.has(caseNo)) {
        addIssue(issues, 'error', 'duplicateCaseInFile', line, caseNo);
        skipped++;
        continue;
      }
      caseSeen.set(caseNo, line);
      if (db.prepare('SELECT 1 FROM cases WHERE case_no = ?').get(caseNo)) {
        addIssue(issues, 'error', 'caseExists', line, caseNo);
        skipped++;
        continue;
      }
    }
    // money
    const cur = clean(r.currency).toUpperCase() || base;
    const costN = num(r.cost ?? '');
    if (Number.isNaN(costN)) addIssue(issues, 'warn', 'badCost', line, r.cost);
    if (costN !== null && !Number.isNaN(costN) && !canCost) costIgnored = true;
    const fx = cur === base ? 1 : num(r.fxRate ?? '');
    if (canCost && costN !== null && !Number.isNaN(costN) && cur !== base && !(fx && fx > 0)) {
      addIssue(issues, 'error', 'fxMissing', line, cur);
      skipped++;
      continue;
    }
    if (r.merchant && !canMerchant) merchantIgnored = true;
    const marketN = num(r.market ?? '');
    if (Number.isNaN(marketN)) addIssue(issues, 'warn', 'badPrice', line, r.market);
    let marketDate = parseDate(r.marketDate ?? '');
    if (marketDate === undefined) addIssue(issues, 'warn', 'badDate', line, r.marketDate);
    if (marketN !== null && !Number.isNaN(marketN) && !marketDate) {
      if (r.marketDate === undefined || !r.marketDate) addIssue(issues, 'info', 'priceDateToday', line);
      marketDate = now;
    }
    if (marketN !== null && !Number.isNaN(marketN) && !canPrice) priceIgnored = true;
    const purchaseDate = parseDate(r.purchaseDate ?? '');
    if (purchaseDate === undefined) addIssue(issues, 'warn', 'badDate', line, r.purchaseDate);

    // storage (may add errors)
    const before = issues.filter((i) => i.level === 'error').length;
    const cId = st.cellarId(cellarName, line);
    const lId = cId === null ? null : st.lockerId(cId, cellarName, lockerCode, line);
    const rId = lId === null ? null : st.rackId(lId, `${cellarName} › ${lockerCode}`, clean(r.rack), line);
    if (rId === null || issues.filter((i) => i.level === 'error').length > before) {
      skipped++;
      continue;
    }

    const key = wineKey({ winery: r.winery, name: r.name, vintage: v.vintage, volume_ml: volume });
    wineKeys.add(key);
    const existing = db
      .prepare('SELECT id, wine_no, notes, name, vintage FROM wines WHERE match_key = ?')
      .get(key) as
      { id: number; wine_no: string; notes: string | null; name: string; vintage: string } | undefined;
    if (!existing) newWineKeys.add(key);
    bottles += qtyN;
    if (caseNo) cases++;
    if (marketN && canPrice) prices++;

    if (!create) continue;
    // ----- write
    if (type && !types.has(type)) {
      db.prepare('INSERT INTO wine_types (code, zh, en, mapped, pos) VALUES (?, ?, ?, 0, 99)').run(
        type,
        `待對應（${type}）`,
        `Unmapped (${type})`,
      );
      types.add(type);
    }
    let wineId = existing?.id;
    let wineNo = existing?.wine_no;
    const notes = [r.note, v.extra ? `${v.extra}` : ''].filter(Boolean).join(' / ');
    if (!wineId) {
      wineNo = nextWineNo(db);
      const toYear = (s?: string) => {
        const n = num(s ?? '');
        return n && Number.isInteger(n) && n > 1800 && n < 2200 ? n : null;
      };
      const sugg = num(r.suggested ?? '');
      const cols = {
        wine_no: wineNo,
        country: r.country || null,
        winery: r.winery,
        name: r.name,
        region: r.region || null,
        classification: r.classification || null,
        vintage: v.vintage,
        type_code: type,
        volume_ml: volume,
        grapes: r.grapes || null,
        drink_from: toYear(r.drinkFrom),
        drink_to: toYear(r.drinkTo),
        suggested_price:
          sugg !== null && !Number.isNaN(sugg) ? Math.round(sugg * 10 ** decimals(base)) : null,
        notes: notes || null,
        match_key: key,
        created_by: ctx.who.id,
        created_at: nowIso(),
      };
      wineId = Number(
        db
          .prepare(
            `INSERT INTO wines (${Object.keys(cols).join(',')}, search_key) VALUES (${Object.keys(cols)
              .map((k) => '@' + k)
              .join(',')}, @sk)`,
          )
          .run({ ...cols, sk: searchKey(cols) }).lastInsertRowid,
      );
      results.wines++;
      audit(db, ctx.who, {
        category: 'inventory',
        action: 'wineCreated',
        objType: 'wine',
        objId: wineNo,
        objLabel: `${r.name} ${v.vintage}`,
        reason: ctx.filename,
      });
      wineKeys.add(key);
    } else if (notes && !(existing!.notes ?? '').includes(notes)) {
      db.prepare('UPDATE wines SET notes = ? WHERE id = ?').run(
        existing!.notes ? `${existing!.notes}\n${notes}` : notes,
        wineId,
      );
    }
    if (qtyN > 0) {
      let caseId: number | null = null;
      if (caseNo) {
        caseId = Number(
          db
            .prepare(
              'INSERT INTO cases (case_no, rack_id, capacity, location_uncertain, note, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(caseNo, rId, qtyN, uncertain ? 1 : 0, r.note || null, nowIso()).lastInsertRowid,
        );
        results.cases++;
      }
      let merchantId: number | null = null;
      if (canMerchant && r.merchant) {
        merchantId =
          (
            db.prepare('SELECT id FROM merchants WHERE name = ?').get(r.merchant) as
              { id: number } | undefined
          )?.id ??
          Number(db.prepare('INSERT INTO merchants (name) VALUES (?)').run(r.merchant).lastInsertRowid);
      }
      const unit = canCost && costN !== null && !Number.isNaN(costN) ? toMinor(String(costN), cur) : null;
      const baseUnit =
        unit === null ? null : Math.round(unit * (fx as number) * 10 ** (decimals(base) - decimals(cur)));
      const lotId = Number(
        db
          .prepare(
            'INSERT INTO lots (wine_id, merchant_id, unit_cost, currency, fx_rate, base_unit_cost, purchase_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            wineId,
            merchantId,
            unit,
            cur,
            cur === base ? null : fx,
            baseUnit,
            purchaseDate ?? null,
            caseNo ? null : r.note || null,
            nowIso(),
          ).lastInsertRowid,
      );
      const ins = db.prepare(
        'INSERT INTO bottles (bottle_no, wine_id, lot_id, case_id, rack_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const nos: string[] = [];
      for (let i = 0; i < qtyN; i++) {
        const no = nextBottleNo(db);
        ins.run(no, wineId, lotId, caseId, rId, nowIso());
        nos.push(no);
      }
      results.bottles += qtyN;
      results.firstBottle ||= nos[0];
      results.lastBottle = nos.at(-1)!;
      audit(db, ctx.who, {
        category: 'inventory',
        action: 'stockIn',
        objType: 'wine',
        objId: wineNo,
        objLabel: `${r.name} ${v.vintage}`,
        changes: {
          qty: qtyN,
          bottles: `${nos[0]} – ${nos.at(-1)}`,
          ...(caseNo ? { case: caseNo } : {}),
          ...(unit !== null ? { unitCost: unit, currency: cur } : {}),
          ...(merchantId ? { merchant: r.merchant } : {}),
          ...(uncertain ? { location_uncertain: true } : {}),
          batch: ctx.filename,
        },
        reason: `${ctx.filename} #${line}`,
      });
      if (caseNo)
        audit(db, ctx.who, {
          category: 'inventory',
          action: 'caseCreated',
          objType: 'case',
          objId: caseNo,
          objLabel: caseNo,
          changes: { qty: qtyN },
          reason: ctx.filename,
        });
    }
    if (canPrice && marketN !== null && !Number.isNaN(marketN) && marketN > 0) {
      const price = toMinor(String(marketN), base)!;
      if (
        !db
          .prepare(
            'SELECT 1 FROM price_history WHERE wine_id = ? AND effective_date = ? AND price = ? AND voided = 0',
          )
          .get(wineId, marketDate, price)
      ) {
        db.prepare(
          "INSERT INTO price_history (wine_id, price, effective_date, source, created_by, created_at) VALUES (?, ?, ?, 'import', ?, ?)",
        ).run(wineId, price, marketDate, ctx.who.id, nowIso());
        results.prices++;
      }
    }
  }
  if (costIgnored) issues.push({ level: 'warn', code: 'costIgnored', lines: [], details: [] });
  if (merchantIgnored) issues.push({ level: 'warn', code: 'merchantIgnored', lines: [], details: [] });
  if (priceIgnored) issues.push({ level: 'warn', code: 'priceIgnored', lines: [], details: [] });
  results.skipped = skipped;
  return {
    issues,
    summary: {
      rows: rows.length,
      wines: wineKeys.size,
      newWines: newWineKeys.size,
      cases,
      bottles,
      prices,
      skipped,
      newCellars: st.pending.cellars.size,
      newLockers: st.pending.lockers.size,
      newRacks: st.pending.racks.size,
    },
    apply: () => results,
  };
}

function storagePlan(ctx: Ctx, rows: Row[], create: boolean): Plan {
  const { db } = ctx;
  const issues: Issue[] = [];
  const st = storageResolver(ctx, issues, create);
  const base = settings(db).currency;
  let skipped = 0;
  let updated = 0;
  for (const r of rows) {
    if (!r.cellar) {
      addIssue(issues, 'error', 'missingCellar', r.line);
      skipped++;
      continue;
    }
    const before = issues.filter((i) => i.level === 'error').length;
    const cId = st.cellarId(r.cellar, r.line);
    if (cId === null) {
      skipped++;
      continue;
    }
    const rent = num(r.monthlyRent ?? '');
    if (Number.isNaN(rent)) addIssue(issues, 'warn', 'badNumber', r.line, r.monthlyRent);
    if (create && cId > 0 && (r.address || r.climate || (rent !== null && !Number.isNaN(rent)))) {
      db.prepare(
        'UPDATE cellars SET address = COALESCE(?, address), climate = COALESCE(?, climate), monthly_rent = COALESCE(?, monthly_rent) WHERE id = ?',
      ).run(
        r.address || null,
        r.climate || null,
        rent !== null && !Number.isNaN(rent) ? Math.round(rent * 10 ** decimals(base)) : null,
        cId,
      );
      updated++;
    }
    if (!r.locker) continue;
    const lId = st.lockerId(cId, r.cellar, r.locker, r.line);
    if (lId === null) {
      skipped++;
      continue;
    }
    const cap = num(r.capacity ?? '');
    if (!r.rack) {
      if (create && lId > 0 && cap && !Number.isNaN(cap))
        db.prepare('UPDATE lockers SET capacity = ? WHERE id = ?').run(Math.round(cap), lId);
      continue;
    }
    const rId = st.rackId(lId, `${r.cellar} › ${r.locker}`, r.rack, r.line);
    if (rId === null || issues.filter((i) => i.level === 'error').length > before) {
      skipped++;
      continue;
    }
    if (create && rId > 0 && cap && !Number.isNaN(cap))
      db.prepare('UPDATE racks SET capacity = ? WHERE id = ?').run(Math.round(cap), rId);
  }
  return {
    issues,
    summary: {
      rows: rows.length,
      newCellars: st.pending.cellars.size,
      newLockers: st.pending.lockers.size,
      newRacks: st.pending.racks.size,
      skipped,
    },
    apply: () => ({ skipped, updated }),
  };
}

function pricesPlan(ctx: Ctx, rows: Row[], create: boolean): Plan {
  const { db, p } = ctx;
  const issues: Issue[] = [];
  const base = settings(db).currency;
  const now = today(db);
  const lim = p.limits.maxPriceChangePct;
  let ok = 0,
    skipped = 0;
  const results = { prices: 0, skipped: 0 };
  for (const r of rows) {
    const price = num(r.price ?? '');
    if (price === null || Number.isNaN(price) || price <= 0) {
      addIssue(issues, 'error', 'badPrice', r.line, r.price);
      skipped++;
      continue;
    }
    let wine: { id: number; wine_no: string; name: string; vintage: string } | undefined;
    if (r.wineNo)
      wine = db
        .prepare('SELECT id, wine_no, name, vintage FROM wines WHERE wine_no = ?')
        .get(r.wineNo.toUpperCase()) as typeof wine;
    else if (r.winery && r.name) {
      const v = parseVintage(r.vintage ?? '').vintage;
      wine = db
        .prepare('SELECT id, wine_no, name, vintage FROM wines WHERE match_key = ?')
        .get(
          wineKey({ winery: r.winery, name: r.name, vintage: v, volume_ml: parseVolume(r.volume ?? '') }),
        ) as typeof wine;
    }
    if (!wine) {
      addIssue(
        issues,
        'error',
        'wineNotFound',
        r.line,
        r.wineNo || `${r.winery} ${r.name} ${r.vintage ?? ''}`.trim(),
      );
      skipped++;
      continue;
    }
    const date = parseDate(r.date ?? '');
    if (date === undefined) {
      addIssue(issues, 'error', 'badDate', r.line, r.date);
      skipped++;
      continue;
    }
    const minor = Math.round(price * 10 ** decimals(base));
    const prev = db
      .prepare(
        'SELECT price FROM price_history WHERE wine_id = ? AND voided = 0 ORDER BY effective_date DESC, id DESC LIMIT 1',
      )
      .get(wine.id) as { price: number } | undefined;
    if (lim !== null && prev && Math.abs(minor - prev.price) / prev.price > lim / 100) {
      addIssue(issues, 'error', 'overPriceChangeLimit', r.line, wine.wine_no);
      skipped++;
      continue;
    }
    if (prev && Math.abs(minor - prev.price) / prev.price > 0.5)
      addIssue(issues, 'warn', 'bigPriceChange', r.line, wine.wine_no);
    ok++;
    if (!create) continue;
    db.prepare(
      'INSERT INTO price_history (wine_id, price, effective_date, source, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(wine.id, minor, date ?? now, r.source || 'import', r.url || null, ctx.who.id, nowIso());
    audit(db, ctx.who, {
      category: 'prices',
      action: 'marketPriceAdded',
      objType: 'wine',
      objId: wine.wine_no,
      objLabel: `${wine.name} ${wine.vintage}`,
      changes: { marketPrice: [prev?.price ?? null, minor], date: date ?? now, source: r.source || 'import' },
      reason: ctx.filename,
    });
    results.prices++;
  }
  results.skipped = skipped;
  return { issues, summary: { rows: rows.length, prices: ok, skipped }, apply: () => results };
}

function merchantsPlan(ctx: Ctx, rows: Row[], create: boolean): Plan {
  const { db } = ctx;
  const issues: Issue[] = [];
  let added = 0,
    updated = 0,
    skipped = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.name) {
      addIssue(issues, 'error', 'missingName', r.line);
      skipped++;
      continue;
    }
    if (seen.has(norm(r.name))) {
      addIssue(issues, 'warn', 'duplicateInFile', r.line, r.name);
      continue;
    }
    seen.add(norm(r.name));
    const ex = db.prepare('SELECT id FROM merchants WHERE name = ?').get(r.name) as
      { id: number } | undefined;
    if (ex) updated++;
    else added++;
    if (!create) continue;
    if (ex)
      db.prepare(
        'UPDATE merchants SET contact = COALESCE(?, contact), phone = COALESCE(?, phone), email = COALESCE(?, email), note = COALESCE(?, note) WHERE id = ?',
      ).run(r.contact || null, r.phone || null, r.email || null, r.note || null, ex.id);
    else {
      const id = Number(
        db
          .prepare('INSERT INTO merchants (name, contact, phone, email, note) VALUES (?, ?, ?, ?, ?)')
          .run(r.name, r.contact || null, r.phone || null, r.email || null, r.note || null).lastInsertRowid,
      );
      audit(db, ctx.who, {
        category: 'settings',
        action: 'merchantCreated',
        objType: 'merchant',
        objId: id,
        objLabel: r.name,
        reason: ctx.filename,
      });
    }
  }
  return {
    issues,
    summary: { rows: rows.length, newMerchants: added, updatedMerchants: updated, skipped },
    apply: () => ({ added, updated, skipped }),
  };
}

export function plan(kind: ImportKind, ctx: Ctx, rows: Row[], merges: Merges, create: boolean): Plan {
  if (kind === 'inventory') return inventoryPlan(ctx, rows, merges, create);
  if (kind === 'storage') return storagePlan(ctx, rows, create);
  if (kind === 'prices') return pricesPlan(ctx, rows, create);
  return merchantsPlan(ctx, rows, create);
}

// ---------------------------------------------------------------- templates
export async function template(
  kind: ImportKind,
  lang: 'zh-TW' | 'en',
  types: { code: string; zh: string; en: string }[],
  currency: string,
) {
  const zh = lang !== 'en';
  const cols = COLUMNS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyWineCorks';
  const sheetName = {
    inventory: zh ? '庫存' : 'Inventory',
    storage: zh ? '儲位' : 'Storage',
    prices: zh ? '市場價格' : 'Market prices',
    merchants: zh ? '酒商' : 'Merchants',
  }[kind];
  const ws = wb.addWorksheet(sheetName);
  const head = ws.addRow(cols.map((c) => (zh ? c.zh : c.en)));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((cell, i) => {
    const c = cols[i - 1];
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: c.required ? 'FF5E1A24' : 'FF6E6863' },
    };
    const help = zh ? c.zhHelp : c.enHelp;
    if (help) cell.note = help;
  });
  const n = Math.max(...cols.map((c) => c.example.length));
  for (let i = 0; i < n; i++) ws.addRow(cols.map((c) => c.example[i] ?? ''));
  cols.forEach(
    (c, i) =>
      (ws.getColumn(i + 1).width = Math.max(
        10,
        (zh ? c.zh : c.en).length * (zh ? 2.4 : 1.3),
        ...c.example.map((e) => String(e).length + 2),
      )),
  );
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const info = wb.addWorksheet(zh ? '說明' : 'How to');
  info.addRow([zh ? `${sheetName}匯入範本` : `${sheetName} import template`]).font = { bold: true, size: 14 };
  const lines = zh
    ? [
        '1. 在第一個工作表填資料。第一列是欄位名稱，請不要修改；深紅色欄位為必填。',
        '2. 範例資料請刪除或改成你的資料。',
        '3. 不需要的欄位可以整欄刪除，欄位順序可以調整；中文或英文欄位名稱都可以。',
        `4. 金額用系統幣別（${currency}），不用輸入貨幣符號。`,
        '5. 到 MyWineCorks「匯入」上傳檔案，先預覽問題，確認後才會寫入。',
        ...(kind === 'inventory'
          ? [
              '6. 一列＝同一款酒放在同一個位置的一批瓶數。酒莊＋品名＋年份＋容量相同就視為同一款酒。',
              '7. 已存在的箱號不會重複匯入。',
            ]
          : []),
      ]
    : [
        '1. Fill in the first sheet. Keep the header row; dark red columns are required.',
        '2. Delete the example rows or overwrite them.',
        '3. Delete columns you do not need and reorder as you like; Chinese or English headers both work.',
        `4. Amounts are in your base currency (${currency}), without currency symbols.`,
        '5. Upload in MyWineCorks › Import. You will see a preview of any problems before anything is saved.',
        ...(kind === 'inventory'
          ? [
              '6. One row = a batch of bottles of one wine in one place. Same winery + name + vintage + size = same wine.',
              '7. Case numbers that already exist are skipped.',
            ]
          : []),
      ];
  for (const l of lines) info.addRow([l]);
  info.addRow([]);
  info.addRow(zh ? ['欄位', '說明', '必填'] : ['Column', 'Notes', 'Required']).font = { bold: true };
  for (const c of cols) info.addRow([zh ? c.zh : c.en, zh ? c.zhHelp : c.enHelp, c.required ? '✓' : '']);
  info.getColumn(1).width = 18;
  info.getColumn(2).width = 70;
  if (kind === 'inventory') {
    const tw = wb.addWorksheet(zh ? '種類代碼' : 'Type codes');
    tw.addRow(zh ? ['代碼', '中文', 'English'] : ['Code', 'Chinese', 'English']).font = { bold: true };
    for (const t of types) tw.addRow([t.code, t.zh, t.en]);
    tw.getColumn(2).width = 16;
    tw.getColumn(3).width = 20;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
