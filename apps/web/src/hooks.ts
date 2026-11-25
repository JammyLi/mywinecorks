import { useCallback, useEffect, useState } from 'react';
import { fmtMoney } from '@mwc/shared';
import { useI18n } from '@mwc/ui';
import { api, ApiError } from './api.ts';

/** Load JSON from the API; reloads when the path changes. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load };
}

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
};

/** Money and number formatting in the current language. */
export function useFmt() {
  const { lang } = useI18n();
  return {
    money: (minor: number | null | undefined, cur: string) => fmtMoney(minor, cur, lang),
    num: (n: number | null | undefined) =>
      n === null || n === undefined ? '—' : n.toLocaleString(lang === 'en' ? 'en-US' : 'zh-TW'),
    date: (d: string | null | undefined) => d ?? '—',
  };
}
