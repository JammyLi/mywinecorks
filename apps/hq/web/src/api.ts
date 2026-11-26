export class HqApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new HqApiError(0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HqApiError(res.status, data.error ?? 'server', data.details);
  return data as T;
}

export const day = (v: string | Date | null | undefined) =>
  v ? new Date(v).toISOString().slice(0, 10) : '—';
export const dt = (v: string | null | undefined, lang: string) =>
  v
    ? new Date(v).toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
export const money = (minor: number | null | undefined, cur: string, lang: string) =>
  minor == null
    ? '—'
    : new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-TW', {
        style: 'currency',
        currency: cur,
        maximumFractionDigits: cur === 'TWD' ? 0 : 2,
      }).format(minor / 100);
