import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sees } from '@mwc/shared';
import { Api, actor, perm } from '../http.ts';
import { ApiError, badRequest, forbidden, notFound } from '../errors.ts';
import { audit } from '../services/audit.ts';
import { perms, settings } from '../services/inventory.ts';
import {
  IMPORT_KINDS,
  mergesFrom,
  parseWorkbook,
  plan,
  suggestMerges,
  template,
  type ImportKind,
  type Parsed,
  type Suggestion,
} from '../services/importer.ts';

const MAX_ROWS = 5000;
const TTL = 30 * 60_000;
const previews = new Map<
  string,
  {
    tenant: string;
    userId: number;
    parsed: Parsed;
    suggestions: Suggestion[];
    filename: string;
    expires: number;
  }
>();

function kindOf(raw: unknown): ImportKind {
  const k = String(raw);
  if (!(IMPORT_KINDS as readonly string[]).includes(k)) throw notFound();
  return k as ImportKind;
}

/** Extra permission each kind needs on top of importExport.import. */
function checkKind(req: Parameters<Parameters<Api['get']>[2]>[0], kind: ImportKind) {
  const p = perms(req);
  const has = (m: string, a: string) =>
    !!(p.functions as Record<string, string[] | undefined>)[m]?.includes(a);
  const ok =
    kind === 'inventory'
      ? has('inventory', 'create')
      : kind === 'storage'
        ? has('locations', 'edit') || has('locations', 'createCellar')
        : kind === 'prices'
          ? has('prices', 'edit')
          : has('settings', 'edit') && sees(p, 'seeMerchants');
  if (!ok) throw forbidden();
}

export function mountImport(api: Api) {
  api.get('/import/:kind/template', perm('importExport', 'import'), async (req, res) => {
    const kind = kindOf(req.params.kind);
    checkKind(req, kind);
    const lang = req.query.lang === 'en' ? 'en' : 'zh-TW';
    const db = req.ctx.db!;
    const types = db
      .prepare('SELECT code, zh, en FROM wine_types WHERE mapped = 1 ORDER BY pos, code')
      .all() as { code: string; zh: string; en: string }[];
    const buf = await template(kind, lang, types, settings(db).currency);
    const name = `MyWineCorks-${kind}-template${lang === 'en' ? '' : '-zh'}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buf);
  });

  /** Upload (raw .xlsx body) → issues, suggestions, summary. Nothing is written. */
  api.post('/import/:kind/preview', perm('importExport', 'import'), async (req) => {
    const kind = kindOf(req.params.kind);
    checkKind(req, kind);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('notExcel');
    const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'import.xlsx')).slice(0, 120);
    const parsed = await parseWorkbook(kind, req.body);
    if (parsed.missingColumns.length)
      throw new ApiError(400, 'missingColumns', { columns: parsed.missingColumns });
    if (!parsed.rows.length) throw badRequest('emptySheet');
    if (parsed.rows.length > MAX_ROWS) throw new ApiError(400, 'tooManyRows', { max: MAX_ROWS });
    const suggestions = kind === 'inventory' ? suggestMerges(parsed.rows) : [];
    const ctx = { db: req.ctx.db!, p: perms(req), who: actor(req), filename };
    const pl = plan(kind, ctx, parsed.rows, mergesFrom(suggestions), false);
    for (const [id, v] of previews) if (v.expires < Date.now()) previews.delete(id);
    const id = randomBytes(12).toString('base64url');
    previews.set(id, {
      tenant: req.ctx.tenant!.slug,
      userId: req.ctx.user!.id,
      parsed,
      suggestions,
      filename,
      expires: Date.now() + TTL,
    });
    return {
      previewId: id,
      kind,
      filename,
      currency: settings(req.ctx.db!).currency,
      summary: pl.summary,
      issues: pl.issues,
      suggestions,
      ignoredColumns: parsed.ignoredColumns,
      sample: parsed.rows.slice(0, 15),
    };
  });

  /** Re-check with the chosen merges and write. Rows with errors are skipped. */
  api.post('/import/:kind/commit', perm('importExport', 'import'), (req) => {
    const kind = kindOf(req.params.kind);
    checkKind(req, kind);
    const body = z
      .object({ previewId: z.string(), accepted: z.array(z.string()).max(500).default([]) })
      .parse(req.body);
    const pv = previews.get(body.previewId);
    if (
      !pv ||
      pv.tenant !== req.ctx.tenant!.slug ||
      pv.userId !== req.ctx.user!.id ||
      pv.parsed.kind !== kind ||
      pv.expires < Date.now()
    )
      throw notFound('previewExpired');
    const db = req.ctx.db!;
    const ctx = { db, p: perms(req), who: actor(req), filename: pv.filename };
    const result = db.transaction(() => {
      const pl = plan(kind, ctx, pv.parsed.rows, mergesFrom(pv.suggestions, body.accepted), true);
      const r = pl.apply();
      audit(db, ctx.who, {
        category: 'import',
        action: 'importDone',
        objType: 'import',
        objId: kind,
        objLabel: pv.filename,
        changes: { kind, ...r, rows: pv.parsed.rows.length },
      });
      return { ...r, issues: pl.issues };
    })();
    previews.delete(body.previewId);
    return result;
  });
}
