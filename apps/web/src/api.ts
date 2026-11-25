export class ApiError extends Error {
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
    throw new ApiError(0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'server', data.details);
  return data as T;
}

/** Translate an error to a user-facing message via `err.<code>` keys. */
export function errText(t: (k: string) => string, e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'server';
  const key = `err.${code}`;
  const s = t(key);
  return s === key ? t('err.server') : s;
}

export const fmtDateTime = (iso: string | null | undefined, lang: string) =>
  iso
    ? new Date(iso).toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
