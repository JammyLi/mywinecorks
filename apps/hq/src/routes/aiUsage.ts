/** AI usage per license (from the AI gateway's admin API) and monthly caps. */
import { z } from 'zod';
import { Api, HqError, hqAudit } from '../http.ts';
import type { HqConfig } from '../config.ts';

export const aiAdmin = {
  /** Replaced in tests. */
  fetcher: ((...a) => fetch(...a)) as typeof fetch,
};

async function aiCall<T>(cfg: HqConfig, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  if (!cfg.aiUrl || !cfg.aiAdminToken) throw new HqError(400, 'aiNotConfigured');
  let res: Response;
  try {
    res = await aiAdmin.fetcher(cfg.aiUrl + '/api/admin' + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.aiAdminToken}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HqError(502, 'aiUnreachable');
  }
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw new HqError(502, 'aiError');
  return data;
}

export function mountAiUsage(api: Api) {
  api.get('/ai-usage', 'view', async (req) => {
    if (!req.hq.cfg.aiUrl || !req.hq.cfg.aiAdminToken) return { configured: false };
    const d = await aiCall<{
      defaultCap: number;
      configured: boolean;
      clients: { lid: string; client: string }[];
      caps: { lid: string; monthly_tokens: number }[];
      rows: {
        lid: string;
        client: string;
        month: string;
        feature: string;
        tokens: number;
        calls: number;
        failed: number;
      }[];
    }>(req.hq.cfg, 'GET', '/usage');
    return { ...d, configured: true, keySet: d.configured };
  });

  api.post('/ai-usage/cap', 'subs.edit', async (req) => {
    const b = z
      .object({
        lid: z.string().max(60),
        monthlyTokens: z.number().int().min(0).max(2_000_000_000).nullable(),
      })
      .parse(req.body);
    const by = req.hq.staff?.email ?? 'hq';
    await aiCall(req.hq.cfg, 'POST', '/cap', { ...b, by });
    await hqAudit(req, 'aiCapSet', {
      objType: 'license',
      objId: b.lid,
      changes: { monthlyTokens: b.monthlyTokens },
    });
  });
}
