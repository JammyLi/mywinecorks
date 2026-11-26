/** Phone: pick and ship an order by scanning (needs a connection, so stock and payments stay exact). */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { useApi } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';
import { useOffline } from '../offline/store.ts';
import { OrderStatus, type OrderDetail } from '../pages/Orders.tsx';
import { Scanner } from './Scanner.tsx';
import { FlashBox, MHead, ManualInput, type Flash } from './common.tsx';

export function MPick() {
  const { no = '' } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const st = useOffline();
  const { data, error, reload } = useApi<OrderDetail>(st.online ? '/orders/' + no : null);
  const [scanned, setScanned] = useState<string[]>([]);
  const [msg, setMsg] = useState<Flash>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!st.online)
    return (
      <div className="mpage">
        <MHead title={no} />
        <div className="flash warn">{t('m.pickOnline')}</div>
      </div>
    );
  if (error)
    return (
      <div className="mpage">
        <MHead title={no} />
        <ErrorBox error={error} />
      </div>
    );
  if (!data)
    return (
      <div className="mpage">
        <MHead title={no} />
        <div className="muted">{t('loading')}</div>
      </div>
    );
  const o = data.order;
  const heldNos = new Set(data.lines.flatMap((l) => l.held.map((b) => b.bottleNo)));
  const caseOf = new Map(
    data.lines.flatMap((l) => l.held.filter((b) => b.caseNo).map((b) => [b.bottleNo, b.caseNo!] as const)),
  );
  const counted = (l: OrderDetail['lines'][number]) =>
    l.held.filter((b) => scanned.includes(b.bottleNo) || (b.caseNo && scanned.includes('CASE:' + b.caseNo)))
      .length;
  const extra = scanned.filter((c) => !c.startsWith('CASE:') && !heldNos.has(c)).length;
  const onCode = (raw: string) => {
    let c = raw.trim().replace(/^MW:/i, '').toUpperCase();
    if (/^\d\d-\d\d-\d\d-\d+$/.test(c) || [...caseOf.values()].includes(c))
      c = 'CASE:' + c.replace(/^CASE:/, '');
    if (scanned.includes(c)) return setMsg({ kind: 'warn', text: t('m.alreadyScanned', { no: c }) });
    setScanned([...scanned, c]);
    setMsg(
      heldNos.has(c) || c.startsWith('CASE:')
        ? { kind: 'ok', text: `${c} ✓` }
        : { kind: 'warn', text: t('m.notHeldWillSwap', { no: c }) },
    );
  };
  const total = data.lines.reduce((s, l) => s + l.qty, 0);
  const done = data.lines.reduce((s, l) => s + Math.min(l.qty, counted(l)), 0) + extra;
  const go = async (path: 'pick' | 'ship', useHeld = false) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/orders/${no}/${path}`, { body: { bottleNos: scanned, useHeld } });
      toast(
        path === 'pick'
          ? t('ord.pickedDone')
          : o.delivery === 'pickup'
            ? t('ord.handedOver')
            : t('ord.shippedDone'),
      );
      if (path === 'ship') nav('/m');
      else {
        setScanned([]);
        reload();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const ready = o.status === 'confirmed' || o.status === 'picked';
  return (
    <div className="mpage">
      <MHead title={no} right={<OrderStatus s={o.status} />} />
      <div className="card">
        <b>{data.customer?.name}</b>
        <div className="muted small">
          {[o.delivery === 'pickup' ? t('ord.deliveryPickup') : o.address, o.deliveryDate]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      {!ready ? (
        <div className="flash warn">{t('m.orderNotReady')}</div>
      ) : (
        <>
          {o.status === 'confirmed' && <Scanner onCode={onCode} />}
          <FlashBox f={msg} />
          {o.status === 'confirmed' && <ManualInput onCode={onCode} />}
          <div className="row between">
            <b>{t('m.scannedOf', { n: done, of: total })}</b>
            {scanned.length > 0 && (
              <button className="btn ghost sm" onClick={() => setScanned([])}>
                {t('ord.clearScans')}
              </button>
            )}
          </div>
          <div className="mlist">
            {data.lines.map((l) => {
              const n = counted(l);
              const locs = [
                ...new Set(
                  l.held.map(
                    (b) => b.location.split(' › ').slice(1).join(' › ') + (b.caseNo ? ' › ' + b.caseNo : ''),
                  ),
                ),
              ];
              return (
                <div key={l.id}>
                  <span>
                    <b>{l.name}</b> {l.vintage}
                    <div className="muted small">{locs.join(' · ')}</div>
                  </span>
                  <span className={'tag ' + (n >= l.qty || o.status === 'picked' ? 'ok' : '')}>
                    {o.status === 'picked' ? l.qty : Math.min(n, l.qty)} / {l.qty}
                  </span>
                </div>
              );
            })}
          </div>
          <ErrorBox error={err} />
          {can('orders', 'ship') && o.status === 'confirmed' && (
            <button className="btn bigbtn" disabled={busy || !scanned.length} onClick={() => go('pick')}>
              {t('ord.markPicked')}
            </button>
          )}
          {can('orders', 'ship') && (
            <button
              className="btn primary bigbtn"
              disabled={busy || (o.status === 'confirmed' && !scanned.length)}
              onClick={() => go('ship', o.status === 'picked')}
            >
              {o.delivery === 'pickup' ? t('ord.confirmHandOver') : t('ord.confirmShip')}
            </button>
          )}
        </>
      )}
      <Link className="btn ghost" to={'/orders/' + no}>
        {t('m.orderDetails')} ›
      </Link>
    </div>
  );
}

/** Phone: orders waiting to be picked or shipped. */
export function MOrders() {
  const { t } = useI18n();
  const st = useOffline();
  const { data } = useApi<{
    rows: {
      orderNo: string;
      customer: string | null;
      status: string;
      bottles: number;
      deliveryDate: string | null;
    }[];
  }>(st.online ? '/orders' : null);
  const rows = data?.rows.filter((r) => r.status === 'confirmed' || r.status === 'picked') ?? [];
  return (
    <div className="mpage">
      <MHead title={t('m.toShip')} />
      {!st.online && <div className="flash warn">{t('m.pickOnline')}</div>}
      <div className="mlist">
        {rows.map((r) => (
          <Link key={r.orderNo} to={'/m/pick/' + r.orderNo}>
            <span>
              <b>{r.customer ?? r.orderNo}</b>
              <div className="muted small">{[r.orderNo, r.deliveryDate].filter(Boolean).join(' · ')}</div>
            </span>
            <span>
              <OrderStatus s={r.status} /> {t('m.btlN', { n: r.bottles })}
            </span>
          </Link>
        ))}
        {data && !rows.length && <div className="muted small">{t('m.nothingToShip')}</div>}
      </div>
    </div>
  );
}
