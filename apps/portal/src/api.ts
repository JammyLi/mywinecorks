export class PApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

export async function call<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: BodyInit } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET'),
      headers:
        opts.raw !== undefined
          ? { 'Content-Type': 'application/octet-stream' }
          : opts.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : undefined,
      body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw new PApiError(0, 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PApiError(res.status, data.error ?? 'server', data.details);
  return data as T;
}
