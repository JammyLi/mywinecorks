import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Me } from '@mwc/shared';
import { can as canP, sees as seesP, type Module, type Visibility } from '@mwc/shared';
import { useI18n } from '@mwc/ui';
import { api } from './api.ts';

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  setMe: (m: Me | null) => void;
  refresh: () => Promise<void>;
  can: (m: Module, action: string) => boolean;
  sees: (v: Visibility) => boolean;
  /** Deleting, merging and clearing data are for the Owner only. */
  isOwner: boolean;
}
const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const { lang, setLang } = useI18n();
  const setMe = useCallback(
    (m: Me | null) => {
      setMeState(m);
      if (m && m.lang !== lang) setLang(m.lang);
    },
    [lang, setLang],
  );
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMeState(null);
    } finally {
      setLoading(false);
    }
  }, [setMe]);
  useEffect(() => {
    refresh();
  }, []);
  const value: SessionCtx = {
    me,
    loading,
    setMe,
    refresh,
    can: (m, a) => canP(me?.permissions, m, a),
    sees: (v) => seesP(me?.permissions, v),
    isOwner: !!me?.role.isOwner,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSession outside SessionProvider');
  return c;
}

type Theme = 'light' | 'dark';
const themeListeners = new Set<(t: Theme) => void>();
let currentTheme: Theme = (() => {
  try {
    return localStorage.getItem('mwc.theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
})();
document.documentElement.dataset.theme = currentTheme;

/** Shared light/dark theme; every component using it stays in sync. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setLocal] = useState<Theme>(currentTheme);
  useEffect(() => {
    themeListeners.add(setLocal);
    return () => {
      themeListeners.delete(setLocal);
    };
  }, []);
  const set = useCallback((t: Theme) => {
    currentTheme = t;
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem('mwc.theme', t);
    } catch {}
    themeListeners.forEach((l) => l(t));
  }, []);
  return [theme, set];
}
