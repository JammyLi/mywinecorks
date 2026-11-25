/**
 * Phone offline mode (ported from MyWines src/offline/store.js):
 * a copy of the stock in IndexedDB + a queue of operations + sync.
 * The copy never holds cost, merchants, customers or settings and is cleared on sign-out.
 */
import { useEffect, useState } from 'react';

export interface SCellar {
  id: number;
  name: string;
}
export interface SLocker {
  id: number;
  cellarId: number;
  code: string;
}
export interface SRack {
  id: number;
  lockerId: number;
  code: string;
  isDefault: number;
}
export interface SCase {
  caseNo: string;
  rackId: number;
  capacity: number | null;
  uncertain: number;
}
export interface SWine {
  id: number;
  wineNo: string;
  winery: string;
  name: string;
  vintage: string;
  region: string | null;
  country: string | null;
  volumeMl: number;
  typeCode: string | null;
  price?: number | null;
  priceDate?: string | null;
}
export interface SBottle {
  bottleNo: string;
  wineId: number;
  caseNo: string | null;
  rackId: number;
  status: string;
}
export interface SType {
  code: string;
  zh: string;
  en: string;
}
export interface SnapshotData {
  version: number;
  at: string;
  currency: string;
  cellars: SCellar[];
  lockers: SLocker[];
  racks: SRack[];
  cases: SCase[];
  wines: SWine[];
  bottles: SBottle[];
  types: SType[];
}
export interface Snapshot extends SnapshotData {
  byBottle: Map<string, SBottle>;
  byWineId: Map<number, SWine>;
  byWineNo: Map<string, SWine>;
  byCase: Map<string, SCase>;
  byRack: Map<number, SRack>;
  byLocker: Map<number, SLocker>;
  byCellar: Map<number, SCellar>;
}
export type OpType = 'moveBottles' | 'moveCase' | 'stockout' | 'listCreate' | 'count';
export interface Op {
  id: string;
  ts: string;
  type: OpType;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  base: Record<string, unknown>;
}

const DB = 'mywinecorks';
let dbp: Promise<IDBDatabase> | null = null;
function idb() {
  if (!dbp)
    dbp = new Promise((ok, no) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('ops', { keyPath: 'id' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
  return dbp;
}
async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
) {
  const d = await idb();
  return new Promise<T>((ok, no) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => ok((out ? out.result : undefined) as T);
    t.onerror = () => no(t.error);
  });
}
const kvGet = <T>(k: string) => tx<T>('kv', 'readonly', (s) => s.get(k));
const kvSet = (k: string, v: unknown) => tx('kv', 'readwrite', (s) => s.put(v, k));
const opsAll = () => tx<Op[]>('ops', 'readonly', (s) => s.getAll());
const opPut = (op: Op) => tx('ops', 'readwrite', (s) => s.put(op));
const opDel = (id: string) => tx('ops', 'readwrite', (s) => s.delete(id));

const LS = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  del: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* */
    }
  },
};
const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2);
export function deviceId() {
  let id = LS.get('mwc.device');
  if (!id) LS.set('mwc.device', (id = uuid()));
  return id;
}

// ---------- state for screens ----------
export interface OfflineState {
  online: boolean;
  pending: number;
  ops: Op[];
  lastSync: string | null;
  conflicts: number;
  syncing: boolean;
  snap: { at: string; bottles: number; cases: number; wines: number } | null;
  /** Error codes (err.<code>) from the last sync, if any operation was refused. */
  errors: string[];
}
const state: OfflineState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  ops: [],
  lastSync: LS.get('mwc.lastSync'),
  conflicts: Number(LS.get('mwc.conflicts') || 0),
  syncing: false,
  snap: null,
  errors: [],
};
const subs = new Set<(s: OfflineState) => void>();
const emit = () => subs.forEach((f) => f({ ...state }));
export function useOffline() {
  const [s, set] = useState<OfflineState>({ ...state });
  useEffect(() => {
    subs.add(set);
    set({ ...state });
    return () => {
      subs.delete(set);
    };
  }, []);
  return s;
}

let snapCache: Snapshot | null = null;
function index(d: SnapshotData): Snapshot {
  const s = d as Snapshot;
  s.byBottle = new Map(s.bottles.map((b) => [b.bottleNo, b]));
  s.byWineId = new Map(s.wines.map((w) => [w.id, w]));
  s.byWineNo = new Map(s.wines.map((w) => [w.wineNo, w]));
  s.byCase = new Map(s.cases.map((c) => [c.caseNo, c]));
  s.byRack = new Map(s.racks.map((r) => [r.id, r]));
  s.byLocker = new Map(s.lockers.map((l) => [l.id, l]));
  s.byCellar = new Map(s.cellars.map((c) => [c.id, c]));
  return s;
}
const plain = (s: Snapshot): SnapshotData => {
  const { byBottle, byWineId, byWineNo, byCase, byRack, byLocker, byCellar, ...rest } = s;
  void [byBottle, byWineId, byWineNo, byCase, byRack, byLocker, byCellar];
  return rest;
};
const summary = (s: Snapshot) => ({
  at: s.at,
  bottles: s.bottles.length,
  cases: s.cases.length,
  wines: s.wines.length,
});

export async function snapshot(): Promise<Snapshot | null> {
  if (snapCache) return snapCache;
  const d = await kvGet<SnapshotData>('snapshot').catch(() => undefined);
  if (d) {
    snapCache = index(d);
    state.snap = summary(snapCache);
  }
  return snapCache;
}

async function ping(): Promise<'ok' | 'auth' | 'down'> {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('/api/me', { signal: ctl.signal, cache: 'no-store', credentials: 'same-origin' });
    clearTimeout(tm);
    return r.status === 200 ? 'ok' : r.status === 401 ? 'auth' : 'down';
  } catch {
    return 'down';
  }
}

export async function refreshSnapshot() {
  const r = await fetch('/api/offline/snapshot', { cache: 'no-store', credentials: 'same-origin' });
  if (!r.ok) throw new Error('download');
  const s = index((await r.json()) as SnapshotData);
  // Re-apply operations not yet synced, so screens show the phone's latest state.
  for (const op of (await opsAll()).sort((a, b) => a.ts.localeCompare(b.ts))) applyLocal(s, op);
  await kvSet('snapshot', plain(s));
  snapCache = s;
  state.snap = summary(s);
  emit();
  return s;
}

/** Apply on the phone first, so screens are right even with no signal. */
function applyLocal(s: Snapshot, op: Op) {
  const p = op.payload;
  if (op.type === 'moveBottles') {
    for (const no of p.bottleNos as string[]) {
      const b = s.byBottle.get(no);
      if (!b) continue;
      if (p.dest.mode === 'case') {
        const c = s.byCase.get(p.dest.caseNo);
        if (c) Object.assign(b, { caseNo: c.caseNo, rackId: c.rackId });
      } else if (p.dest.mode === 'newcase') Object.assign(b, { caseNo: '+', rackId: Number(p.dest.rackId) });
      else Object.assign(b, { caseNo: null, rackId: Number(p.dest.rackId) });
    }
  } else if (op.type === 'moveCase') {
    const c = s.byCase.get(p.caseNo);
    if (c) Object.assign(c, { rackId: Number(p.rackId), uncertain: 0 });
    for (const b of s.bottles) if (b.caseNo === p.caseNo) b.rackId = Number(p.rackId);
  } else if (op.type === 'stockout') {
    for (const no of p.bottleNos as string[]) {
      const b = s.byBottle.get(no);
      if (b) b.status = p.reason === 'broken' ? 'broken' : 'out';
    }
  }
}

export async function queueOp(type: OpType, payload: Op['payload']) {
  const s = await snapshot();
  let base: Op['base'] = {};
  if (s && (type === 'moveBottles' || type === 'stockout'))
    base = {
      bottles: Object.fromEntries(
        (payload.bottleNos as string[]).map((no) => {
          const b = s.byBottle.get(no);
          return [no, b ? { rackId: b.rackId, caseNo: b.caseNo, status: b.status } : null];
        }),
      ),
    };
  if (s && type === 'moveCase') base = { rackId: s.byCase.get(payload.caseNo)?.rackId };
  const op: Op = { id: uuid(), ts: new Date().toISOString(), type, payload, base };
  await opPut(op);
  if (s) {
    applyLocal(s, op);
    await kvSet('snapshot', plain(s));
  }
  await loadOps();
  void sync();
  return op;
}

async function loadOps() {
  state.ops = (await opsAll().catch(() => [] as Op[])).sort((a, b) => a.ts.localeCompare(b.ts));
  state.pending = state.ops.length;
  emit();
}

interface SyncOut {
  online: boolean;
  applied?: number;
  conflicts?: number;
  errors?: string[];
  error?: string;
}
let syncing: Promise<SyncOut> | null = null;
export function sync({ refresh = true } = {}): Promise<SyncOut> {
  if (syncing) return syncing;
  syncing = (async () => {
    state.syncing = true;
    emit();
    try {
      const p = await ping();
      state.online = p !== 'down';
      if (p !== 'ok') return { online: state.online, error: p === 'auth' ? 'unauthorized' : undefined };
      const ops = (await opsAll()).sort((a, b) => a.ts.localeCompare(b.ts));
      let conflicts = 0;
      let applied = 0;
      const errors: string[] = [];
      if (ops.length) {
        const r = await fetch('/api/offline/sync', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device: deviceId(), ops }),
        });
        if (!r.ok)
          throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || 'server');
        const { results } = (await r.json()) as { results: { id: string; status: string; error?: string }[] };
        for (const x of results) {
          await opDel(x.id);
          if (x.status === 'conflict') conflicts++;
          else if (x.status === 'rejected') errors.push(x.error ?? 'server');
          else applied++;
        }
      }
      const cr = await fetch('/api/offline/conflicts', { cache: 'no-store', credentials: 'same-origin' });
      state.conflicts = cr.ok ? ((await cr.json()) as unknown[]).length : conflicts;
      LS.set('mwc.conflicts', String(state.conflicts));
      if (refresh) await refreshSnapshot();
      state.lastSync = new Date().toISOString();
      LS.set('mwc.lastSync', state.lastSync);
      state.errors = errors;
      await loadOps();
      return { online: true, applied, conflicts, errors };
    } catch (e) {
      state.errors = [(e as Error).message];
      return { online: state.online, error: (e as Error).message };
    } finally {
      state.syncing = false;
      syncing = null;
      emit();
    }
  })();
  return syncing;
}

/** Remove everything this phone keeps (on sign-out, or from the Sync screen). */
export async function clearLocal() {
  const d = await idb();
  await new Promise<void>((ok) => {
    const t = d.transaction(['kv', 'ops'], 'readwrite');
    t.objectStore('kv').clear();
    t.objectStore('ops').clear();
    t.oncomplete = () => ok();
    t.onerror = () => ok();
  });
  snapCache = null;
  Object.assign(state, { snap: null, pending: 0, ops: [], lastSync: null, conflicts: 0, errors: [] });
  LS.del('mwc.lastSync');
  LS.del('mwc.conflicts');
  emit();
}

let started = false;
export function startOffline() {
  if (started) return;
  started = true;
  void loadOps()
    .then(snapshot)
    .then(() => sync());
  window.addEventListener('online', () => void sync());
  window.addEventListener('offline', () => {
    state.online = false;
    emit();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && (state.pending || !state.online))
      void sync({ refresh: state.pending > 0 || !state.online });
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const stale = !state.lastSync || Date.now() - new Date(state.lastSync).getTime() > 120000;
    void sync({ refresh: stale || state.pending > 0 });
  });
}

// ---------- lookups on the phone copy ----------
export function rackLabel(s: Snapshot, rackId: number | undefined, unassigned = '-') {
  const r = rackId != null ? s.byRack.get(rackId) : undefined;
  if (!r) return '—';
  const l = s.byLocker.get(r.lockerId);
  const c = l && s.byCellar.get(l.cellarId);
  return `${c?.name ?? ''} › ${l?.code ?? ''} › ${r.isDefault ? unassigned : r.code}`;
}
export const lockerLabel = (s: Snapshot, id: number) => {
  const l = s.byLocker.get(id);
  return l ? `${s.byCellar.get(l.cellarId)?.name ?? ''} › ${l.code}` : '—';
};
export type Resolved =
  | { type: 'rack'; id: number; rack: SRack; label: string }
  | { type: 'locker'; id: number; locker: SLocker; label: string }
  | { type: 'case'; caseNo: string; c: SCase; bottles: SBottle[]; label: string; wine?: SWine }
  | { type: 'bottle'; bottleNo: string; b: SBottle; wine?: SWine; label: string }
  | { type: 'wine'; wineNo: string; w: SWine; label: string };

/** Scanned / typed code → object, from the phone copy (works with no signal). MyWines QR formats. */
export function resolveLocal(s: Snapshot, raw: string, unassigned = '-'): Resolved | null {
  const code = String(raw || '')
    .trim()
    .replace(/^MW:/i, '');
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^(?:RACK|R):(\d+)$/i))) {
    const r = s.byRack.get(Number(m[1]));
    return r ? { type: 'rack', id: r.id, rack: r, label: rackLabel(s, r.id, unassigned) } : null;
  }
  if ((m = code.match(/^(?:LOCKER|L):(\d+)$/i))) {
    const l = s.byLocker.get(Number(m[1]));
    return l ? { type: 'locker', id: l.id, locker: l, label: lockerLabel(s, l.id) } : null;
  }
  const c = s.byCase.get(code.replace(/^(?:CASE|C):/i, ''));
  if (c) {
    const bottles = s.bottles.filter((b) => b.caseNo === c.caseNo && b.status === 'in_stock');
    return {
      type: 'case',
      caseNo: c.caseNo,
      c,
      bottles,
      label: rackLabel(s, c.rackId, unassigned),
      wine: s.byWineId.get(bottles[0]?.wineId),
    };
  }
  const b = s.byBottle.get(code.toUpperCase());
  if (b)
    return {
      type: 'bottle',
      bottleNo: b.bottleNo,
      b,
      wine: s.byWineId.get(b.wineId),
      label: rackLabel(s, b.rackId, unassigned),
    };
  const w = s.byWineNo.get(code.toUpperCase());
  if (w) return { type: 'wine', wineNo: w.wineNo, w, label: `${w.name} ${w.vintage}` };
  return null;
}
