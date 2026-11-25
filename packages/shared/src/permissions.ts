/**
 * Permission catalogue (SPEC §2.2). A role is a set of permissions in four dimensions:
 * function permissions, data visibility, location scope and limits.
 * Shared by server (enforcement) and web (showing/hiding UI).
 */

// Deleting anything (and merging, clearing data, change-log retention) is for the Owner only —
// it is not a role permission (decision 17).
export const MODULES = {
  inventory: ['view', 'create', 'edit'],
  locations: ['view', 'createCellar', 'edit'],
  prices: ['view', 'edit'],
  orders: ['view', 'create', 'edit', 'confirm', 'ship', 'cancel'],
  customers: ['view', 'create', 'edit'],
  catalogs: ['view', 'edit'],
  reports: ['view'],
  importExport: ['import', 'export'],
  labels: ['print'],
  settings: ['view', 'edit'],
  users: ['view', 'manage'],
  roles: ['view', 'manage'],
  audit: ['view'],
} as const;

export type Module = keyof typeof MODULES;
export type Action<M extends Module = Module> = (typeof MODULES)[M][number];

export const VISIBILITY = [
  'seeCost',
  'seeProfit',
  'seeMerchants',
  'seeCustomerPrices',
  'seeOthersOrders',
] as const;
export type Visibility = (typeof VISIBILITY)[number];

export interface Limits {
  /** Max order total (minor units) this role may confirm; null = no limit. */
  maxOrderConfirm: number | null;
  /** Max price change in percent per edit; null = no limit. */
  maxPriceChangePct: number | null;
  /** Max bottles per stock-out without approval; null = no limit. */
  maxStockout: number | null;
}

export interface Permissions {
  functions: { [M in Module]?: Action<M>[] };
  visibility: { [V in Visibility]?: boolean };
  /** 'all' or a list of cellar ids the role may see. */
  locationScope: 'all' | number[];
  limits: Limits;
  /** Which apps the role may use. */
  access: { backOffice: boolean; mobile: boolean };
}

export interface Role {
  id: number;
  name: string;
  /** Template key this role was created from (owner, admin, …) or null for custom. */
  template: string | null;
  isOwner: boolean;
  permissions: Permissions;
}

export const NO_LIMITS: Limits = { maxOrderConfirm: null, maxPriceChangePct: null, maxStockout: null };

export function allFunctions(): Permissions['functions'] {
  const f: Record<string, string[]> = {};
  for (const [m, actions] of Object.entries(MODULES)) f[m] = [...actions];
  return f as Permissions['functions'];
}

export function allVisibility(): Permissions['visibility'] {
  return Object.fromEntries(VISIBILITY.map((v) => [v, true]));
}

export function can(p: Permissions | null | undefined, module: Module, action: string): boolean {
  if (!p) return false;
  const list = p.functions[module] as string[] | undefined;
  return !!list && list.includes(action);
}

export function sees(p: Permissions | null | undefined, v: Visibility): boolean {
  return !!p?.visibility[v];
}

export function canSeeCellar(p: Permissions, cellarId: number): boolean {
  return p.locationScope === 'all' || p.locationScope.includes(cellarId);
}

/** Normalise untrusted input into a valid Permissions object (unknown keys dropped). */
export function sanitizePermissions(input: unknown): Permissions {
  const src = (input ?? {}) as Partial<Permissions>;
  const functions: Record<string, string[]> = {};
  for (const [m, actions] of Object.entries(MODULES)) {
    const given = (src.functions as Record<string, unknown> | undefined)?.[m];
    if (Array.isArray(given)) {
      const ok = given.filter(
        (a): a is string => typeof a === 'string' && (actions as readonly string[]).includes(a),
      );
      if (ok.length) functions[m] = [...new Set(ok)];
    }
  }
  const visibility: Record<string, boolean> = {};
  for (const v of VISIBILITY) visibility[v] = !!(src.visibility as Record<string, unknown> | undefined)?.[v];
  let locationScope: 'all' | number[] = 'all';
  if (Array.isArray(src.locationScope)) {
    locationScope = src.locationScope.filter((n) => Number.isInteger(n) && n > 0) as number[];
  }
  const lim = (src.limits ?? {}) as Partial<Limits>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const access = (src.access ?? {}) as Partial<Permissions['access']>;
  return {
    functions: functions as Permissions['functions'],
    visibility,
    locationScope,
    limits: {
      maxOrderConfirm: num(lim.maxOrderConfirm),
      maxPriceChangePct: num(lim.maxPriceChangePct),
      maxStockout: num(lim.maxStockout),
    },
    access: { backOffice: access.backOffice !== false, mobile: access.mobile !== false },
  };
}
