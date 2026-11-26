/** Calls from HQ to the cloud server's provisioning API (create workspaces, push licenses). */
import type { HqConfig } from './config.ts';
import type { Sql } from './db.ts';
import { HqError } from './http.ts';

export const cloud = {
  /** Replaced in tests. */
  fetcher: ((...a) => fetch(...a)) as typeof fetch,
};

export async function cloudCall<T = Record<string, unknown>>(
  cfg: HqConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<T> {
  if (!cfg.cloudUrl || !cfg.cloudToken) throw new HqError(400, 'cloudNotConfigured');
  let res: Response;
  try {
    res = await cloud.fetcher(cfg.cloudUrl + '/api/provision' + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.cloudToken}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HqError(502, 'cloudUnreachable');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw new HqError(
      res.status === 409 ? 409 : 502,
      data.error === 'workspaceExists' ? 'slugTaken' : 'cloudError',
    );
  return data;
}

/** After a cloud license changes (renew, grace, revoke): send the new key to its workspace. */
export async function pushCloudLicense(cfg: HqConfig, sql: Sql, licenseId: number) {
  const w = await sql.one<{ id: number; slug: string; key: string; status: string }>(
    `SELECT w.id, w.slug, l.key, l.status FROM cloud_workspaces w JOIN licenses l ON l.id = w.license_id WHERE l.id = $1`,
    [licenseId],
  );
  if (!w) return null;
  try {
    await cloudCall(cfg, 'POST', `/workspaces/${encodeURIComponent(w.slug)}/license`, {
      key: w.key,
      revoked: w.status !== 'active',
    });
    await sql.q('UPDATE cloud_workspaces SET last_push = now(), push_error = NULL WHERE id = $1', [w.id]);
    return true;
  } catch (e) {
    await sql.q('UPDATE cloud_workspaces SET push_error = $2 WHERE id = $1', [
      w.id,
      (e as HqError).code ?? 'cloudError',
    ]);
    return false;
  }
}
