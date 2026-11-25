import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '@mwc/ui';
import { snapshot, useOffline, type Op, type Snapshot, rackLabel, lockerLabel } from '../offline/store.ts';

export function useSnap(): [Snapshot | null, ReturnType<typeof useOffline>] {
  const st = useOffline();
  const [s, setS] = useState<Snapshot | null>(null);
  useEffect(() => {
    void snapshot().then(setS);
  }, [st.snap?.at, st.pending]);
  return [s, st];
}

const hhmm = (iso: string | null, lang: string) =>
  iso ? new Date(iso).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

export function SyncPill() {
  const { t, lang } = useI18n();
  const st = useOffline();
  const cls = !st.online ? 'pill off' : st.conflicts ? 'pill err' : 'pill';
  return (
    <Link to="/m/sync" className={cls} title={t('m.sync')}>
      <span className="dot" />
      {!st.online ? t('m.offline') : st.syncing ? t('m.syncing') : t('m.online')}
      {st.pending > 0 && <> · {t('m.pendingN', { n: st.pending })}</>}
      {st.conflicts > 0 && <> · {t('m.conflictsN', { n: st.conflicts })}</>}
      {!st.pending && st.lastSync && <> · {hhmm(st.lastSync, lang)}</>} ›
    </Link>
  );
}

export function MHead({
  title,
  back = true,
  right,
}: {
  title: ReactNode;
  back?: boolean;
  right?: ReactNode;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  return (
    <div className="mhead">
      {back && (
        <button className="back" onClick={() => nav(-1)} aria-label={t('back')}>
          ‹
        </button>
      )}
      <h1>{title}</h1>
      {right}
    </div>
  );
}

export function ManualInput({ onCode, placeholder }: { onCode: (c: string) => void; placeholder?: string }) {
  const { t } = useI18n();
  const [v, setV] = useState('');
  return (
    <form
      className="row"
      style={{ flexWrap: 'nowrap' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) {
          onCode(v.trim());
          setV('');
        }
      }}
    >
      <input
        className="input"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder ?? t('m.typeCode')}
        autoCapitalize="characters"
      />
      <button className="btn">{t('m.go')}</button>
    </form>
  );
}

export function NoData() {
  const { t } = useI18n();
  const st = useOffline();
  return <div className="card">{st.online ? t('m.downloading') : t('m.noDataYet')}</div>;
}

export type Flash = { kind: 'ok' | 'warn' | 'err'; text: string } | null;
export const FlashBox = ({ f }: { f: Flash }) =>
  f ? <div className={'flash ' + f.kind}>{f.text}</div> : null;

/** What a queued operation does, in words (Sync screen, conflicts). */
export function useDescribeOp() {
  const { t } = useI18n();
  const un = t('unassigned');
  return (s: Snapshot | null, op: Pick<Op, 'type' | 'payload'>) => {
    const p = op.payload;
    const few = (a: string[]) => a.slice(0, 3).join(', ') + (a.length > 3 ? '…' : '');
    if (op.type === 'moveBottles') {
      const to =
        p.dest.mode === 'case'
          ? t('m.caseN', { no: p.dest.caseNo })
          : (p.dest.mode === 'newcase' ? t('m.newCaseAt') : '') +
            (s ? rackLabel(s, Number(p.dest.rackId), un) : '');
      return { title: t('m.moveN', { n: p.bottleNos.length }), sub: `${few(p.bottleNos)} → ${to}` };
    }
    if (op.type === 'moveCase')
      return {
        title: t('m.moveCaseNo', { no: p.caseNo }),
        sub: '→ ' + (s ? rackLabel(s, Number(p.rackId), un) : ''),
      };
    if (op.type === 'stockout')
      return {
        title: t('m.stockoutN', { n: p.bottleNos.length }),
        sub: `${t(`rs.${p.reason}`)}${p.note ? ': ' + p.note : ''} · ${few(p.bottleNos)}`,
      };
    if (op.type === 'listCreate')
      return { title: t('m.newList', { name: p.name }), sub: t('m.itemsN', { n: p.codes.length }) };
    if (op.type === 'count')
      return {
        title: t('m.countAt', { locker: s ? lockerLabel(s, Number(p.lockerId)) : '' }),
        sub: t('m.countScanned', { n: p.codes.length }),
      };
    return { title: op.type, sub: '' };
  };
}

const RECENT = 'mwc.recentScans';
export const pushRecent = (code: string) => {
  try {
    const r = (JSON.parse(localStorage.getItem(RECENT) || '[]') as string[]).filter((x) => x !== code);
    r.unshift(code);
    localStorage.setItem(RECENT, JSON.stringify(r.slice(0, 8)));
  } catch {
    /* */
  }
};
export const getRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) || '[]');
  } catch {
    return [];
  }
};
export const clearRecent = () => {
  try {
    localStorage.removeItem(RECENT);
  } catch {
    /* */
  }
};
