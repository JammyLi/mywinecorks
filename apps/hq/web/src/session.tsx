import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';

export interface HqMe {
  id: number;
  email: string;
  name: string;
  role: 'superadmin' | 'sales' | 'support' | 'finance' | 'readonly';
  lang: 'zh-TW' | 'en';
  totpEnabled: boolean;
  needsTotp: boolean;
}
/** Mirrors HQ_PERMS on the server (the server enforces; this only hides buttons). */
const PERMS: Record<string, HqMe['role'][]> = {
  'clients.edit': ['superadmin', 'sales', 'support'],
  'subs.edit': ['superadmin', 'sales', 'finance'],
  'licenses.issue': ['superadmin', 'sales'],
  'licenses.revoke': ['superadmin'],
  'licenses.transfer': ['superadmin', 'support'],
  'payments.edit': ['superadmin', 'finance'],
  'releases.edit': ['superadmin'],
  'staff.manage': ['superadmin'],
  'audit.view': ['superadmin'],
};
interface Ctx {
  me: HqMe | null;
  loading: boolean;
  setMe: (m: HqMe | null) => void;
  can: (p: keyof typeof PERMS) => boolean;
}
const C = createContext<Ctx | null>(null);

export function HqSession({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<HqMe | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<HqMe>('/me')
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);
  const can = useCallback((p: string) => !!me && !me.needsTotp && (PERMS[p] ?? []).includes(me.role), [me]);
  return <C.Provider value={{ me, loading, setMe, can }}>{children}</C.Provider>;
}
export const useHq = () => useContext(C)!;
