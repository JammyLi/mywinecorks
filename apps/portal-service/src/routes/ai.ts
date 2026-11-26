/**
 * Customers' AI search and wine questions (SPEC §10.3). Answered by the AI gateway with only what
 * this customer can already see: their own wines and their own price. Metered to the workspace.
 */
import { z } from 'zod';
import { fromMinor } from '@mwc/shared';
import { Api, PError } from '../http.ts';

/** Per customer: at most 30 AI calls an hour. */
const recent = new Map<number, number[]>();
function limit(customerId: number) {
  const now = Date.now();
  const list = (recent.get(customerId) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= 30) throw new PError(429, 'aiTooMany');
  list.push(now);
  recent.set(customerId, list);
}

export function mountAi(api: Api) {
  async function gateway(req: Parameters<Parameters<Api['post']>[2]>[0], feature: string, body: unknown) {
    const { cfg, tenant, customer } = req.p;
    if (!tenant!.info.ai || !cfg.aiServiceToken) throw new PError(404, 'aiOff');
    limit(customer!.id);
    let res: Response;
    try {
      res = await (mountAi.fetcher ?? fetch)(`${cfg.aiUrl}/api/portal-ai/${feature}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.aiServiceToken}`,
          'x-mwc-lid': tenant!.lid,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new PError(502, 'aiUnreachable');
    }
    const out = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (!res.ok)
      throw new PError(
        res.status === 429 ? 429 : 502,
        out.error === 'aiLimitReached' ? 'aiBusy' : (out.error ?? 'aiError'),
      );
    return out.result;
  }
  const lang = (l: string) => (l === 'en' ? 'en' : 'zh-TW');

  api.post('/p/:handle/ai/search', 'shopper', async (req) => {
    const b = z.object({ text: z.string().trim().min(1).max(300) }).parse(req.body);
    const { sql, tenant, customer } = req.p;
    const refs = customer!.entries.map((e) => e.w);
    const rows = await sql.q<{ ref: string; data: Record<string, unknown> }>(
      'SELECT ref, data FROM wines WHERE tenant_id = $1 AND ref = ANY($2::text[])',
      [tenant!.id, refs],
    );
    const label = (d: Record<string, unknown>) =>
      [
        d.winery,
        d.name,
        d.vintage,
        d.region,
        d.country,
        (d.type as { en?: string; zh?: string } | undefined)?.en,
        (d.type as { zh?: string } | undefined)?.zh,
        d.grapes,
      ]
        .filter(Boolean)
        .join(' · ');
    const r = (await gateway(req, 'portalSearch', {
      text: b.text,
      wines: rows.slice(0, 800).map((w) => ({ ref: w.ref, label: label(w.data) })),
      lang: lang(customer!.lang),
    })) as { refs: string[]; explanation: string };
    const mine = new Set(refs);
    return { refs: r.refs.filter((x) => mine.has(x)), explanation: r.explanation };
  });

  api.post('/p/:handle/ai/qa', 'shopper', async (req) => {
    const b = z
      .object({ ref: z.string().max(20), question: z.string().trim().min(2).max(500) })
      .parse(req.body);
    const { sql, tenant, customer } = req.p;
    const entry = customer!.entries.find((e) => e.w === b.ref);
    if (!entry) throw new PError(404, 'notFound');
    const w = await sql.one<{ data: Record<string, unknown> }>(
      'SELECT data FROM wines WHERE tenant_id = $1 AND ref = $2',
      [tenant!.id, b.ref],
    );
    if (!w) throw new PError(404, 'notFound');
    const { photos: _p, ref: _r, ...facts } = w.data;
    const cur = tenant!.info.currency ?? 'TWD';
    const r = (await gateway(req, 'portalQa', {
      question: b.question,
      wine: { ...facts, price: entry.price == null ? 'on request' : `${fromMinor(entry.price, cur)} ${cur}` },
      lang: lang(customer!.lang),
    })) as { answer: string };
    return { answer: r.answer };
  });
}
/** For tests. */
mountAi.fetcher = undefined as typeof fetch | undefined;
