/** In-memory rate limits per key (one server process). */
import { ApiError } from '../errors.ts';

const hits = new Map<string, number[]>();
/** At most `n` calls per `minutes` for this key, otherwise 429 tooMany. */
export function limit(key: string, n: number, minutes: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < minutes * 60_000);
  if (list.length >= n) throw new ApiError(429, 'tooMany');
  list.push(now);
  hits.set(key, list);
  if (hits.size > 50_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3600_000)) hits.delete(k);
}
export const resetLimits = () => hits.clear();
