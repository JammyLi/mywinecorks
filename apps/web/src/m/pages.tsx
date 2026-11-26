/** Phone screens (ported from MyWines src/m/MobilePages.jsx). They work from the phone copy, offline too. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { STOCKOUT_REASONS } from '@mwc/shared';
import { Dialog, Field, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { useFmt } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';
import {
  clearLocal,
  lockerLabel,
  queueOp,
  rackLabel,
  refreshSnapshot,
  resolveLocal,
  sync,
  useOffline,
  type Resolved,
  type Snapshot,
} from '../offline/store.ts';
import { Scanner } from './Scanner.tsx';
import {
  FlashBox,
  MHead,
  ManualInput,
  NoData,
  SyncPill,
  getRecent,
  pushRecent,
  useDescribeOp,
  useSnap,
  type Flash,
} from './common.tsx';

const useUn = () => useI18n().t('unassigned');
const linkOf = (r: Resolved) =>
  r.type === 'bottle'
    ? '/m/b/' + r.bottleNo
    : r.type === 'case'
      ? '/m/c/' + encodeURIComponent(r.caseNo)
      : r.type === 'wine'
        ? '/m/w/' + r.wineNo
        : r.type === 'rack'
          ? '/m/l/' + r.rack.lockerId
          : '/m/l/' + r.id;

function Modes({ on }: { on: string }) {
  const { t } = useI18n();
  const { can } = useSession();
  const tabs: [string, string, boolean][] = [
    ['/m', t('m.lookup'), true],
    ['/m/move', t('nav.move'), can('inventory', 'edit')],
    ['/m/list', t('m.list'), true],
    ['/m/count', t('m.count'), can('inventory', 'edit')],
    ['/m/search', t('nav.search'), true],
    ['/m/orders', t('m.toShip'), can('orders', 'ship')],
  ];
  return (
    <div className="modes">
      {tabs
        .filter((x) => x[2])
        .map(([to, label]) => (
          <Link key={to} to={to} className={to === on ? 'on' : ''}>
            {label}
          </Link>
        ))}
    </div>
  );
}

function ReasonPicker(p: {
  reason: string;
  setReason: (r: string) => void;
  note: string;
  setNote: (n: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Field label={t('f.stockoutReason')}>
        <select className="input" value={p.reason} onChange={(e) => p.setReason(e.target.value)}>
          <option value="">{t('dest.choose')}</option>
          {STOCKOUT_REASONS.map((r) => (
            <option key={r} value={r}>
              {t(`rs.${r}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('f.note')}>
        <input className="input" value={p.note} onChange={(e) => p.setNote(e.target.value)} />
      </Field>
    </>
  );
}

// ===================== Scan home =====================
export function MHome() {
  const { t } = useI18n();
  const nav = useNavigate();
  const un = useUn();
  const [s] = useSnap();
  const [msg, setMsg] = useState<Flash>(null);
  const go = (code: string) => {
    const ord = code.trim().match(/^ORDER:(.+)$/i);
    if (ord) return nav('/m/pick/' + ord[1].toUpperCase());
    if (!s) return;
    const r = resolveLocal(s, code, un);
    if (!r) return setMsg({ kind: 'err', text: t('m.notFound', { code }) });
    pushRecent(code);
    nav(linkOf(r));
  };
  const recent = s
    ? (getRecent()
        .map((c) => [c, resolveLocal(s, c, un)] as const)
        .filter(([, r]) => r) as [string, Resolved][])
    : [];
  return (
    <div className="mpage">
      <MHead title={t('nav.scan')} back={false} right={<SyncPill />} />
      <Modes on="/m" />
      {!s ? (
        <NoData />
      ) : (
        <>
          <Scanner onCode={go} />
          <div className="muted small center">{t('m.pointAt')}</div>
          <FlashBox f={msg} />
          <ManualInput onCode={go} />
          {recent.length > 0 && (
            <>
              <b>{t('m.recent')}</b>
              <div className="mlist">
                {recent.map(([c, r]) => (
                  <Link key={c} to={linkOf(r)}>
                    <span>
                      <b>
                        {r.type === 'case'
                          ? t('m.caseN', { no: r.caseNo })
                          : r.type === 'bottle'
                            ? r.bottleNo
                            : r.label}
                      </b>
                      <div className="muted small">
                        {r.type === 'bottle' || r.type === 'case' ? (r.wine?.name ?? '') : ''}
                        {r.type === 'case' ? ` · ${t('m.btlN', { n: r.bottles.length })}` : ''}
                      </div>
                    </span>
                    <span className="muted small">›</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ===================== Bottle =====================
export function MBottle() {
  const { t } = useI18n();
  const { no = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const f = useFmt();
  const { can, sees } = useSession();
  const un = useUn();
  const [s, st] = useSnap();
  const [live, setLive] = useState<{
    cost?: number | null;
    merchant?: string | null;
    currency?: string;
  } | null>(null);
  const [dlg, setDlg] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Cost only when online and only for roles allowed to see it; never stored on the phone.
    if (st.online && (sees('seeCost') || sees('seeMerchants')))
      api<{ cost?: number | null; merchant?: string | null; currency: string }>(`/bottles/${no}`)
        .then(setLive)
        .catch(() => {});
  }, [no, st.online]);
  if (!s)
    return (
      <div className="mpage">
        <MHead title={no} />
        <NoData />
      </div>
    );
  const b = s.byBottle.get(no);
  if (!b)
    return (
      <div className="mpage">
        <MHead title={no} />
        <div className="card">{t('m.bottleNotOnPhone')}</div>
      </div>
    );
  const w = s.byWineId.get(b.wineId);
  const wineN = s.bottles.filter((x) => x.wineId === b.wineId && x.status === 'in_stock').length;
  const caseN = b.caseNo
    ? s.bottles.filter((x) => x.caseNo === b.caseNo && x.status === 'in_stock').length
    : 0;
  const edit = can('inventory', 'edit');
  const mark = async () => {
    await queueOp('stockout', { bottleNos: [no], reason, note });
    setDlg(false);
    toast(st.online ? t('m.doneSyncing') : t('m.doneLater'));
  };
  const photo = async (file?: File) => {
    if (!file || !w) return;
    const r = await fetch(`/api/wines/${w.wineNo}/photos`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file,
    });
    toast(r.ok ? t('m.photoUploaded') : t('err.server'));
  };
  return (
    <div className="mpage">
      <MHead
        title={no}
        right={
          <span className={'tag ' + (b.status === 'in_stock' ? 'ok' : 'warn')}>{t(`st.${b.status}`)}</span>
        }
      />
      <SyncPill />
      <div className="card stack" style={{ gap: 6 }}>
        <b style={{ fontSize: 17 }}>{w?.name}</b>
        <span className="muted">
          {w?.winery} · {w?.vintage} · {w?.volumeMl} ml
        </span>
        {w && <Link to={'/m/w/' + w.wineNo}>{t('m.wineWithN', { n: wineN })} ›</Link>}
      </div>
      <div className="card">
        <dl className="dl">
          <dt>{t('f.location')}</dt>
          <dd>{rackLabel(s, b.rackId, un)}</dd>
          <dt>{t('f.case')}</dt>
          <dd>
            {b.caseNo ? <Link to={'/m/c/' + encodeURIComponent(b.caseNo)}>{b.caseNo}</Link> : t('m.loose')}
            {b.caseNo ? ` (${t('m.btlN', { n: caseN })})` : ''}
          </dd>
          {w?.price !== undefined && (
            <>
              <dt>{t('f.marketPrice')}</dt>
              <dd>
                {f.money(w.price, s.currency)} <span className="muted small">{w.priceDate}</span>
              </dd>
            </>
          )}
          {live && sees('seeCost') && (
            <>
              <dt>{t('f.cost')}</dt>
              <dd>
                {f.money(live.cost, live.currency ?? s.currency)}{' '}
                <span className="muted small">{live.merchant}</span>
              </dd>
            </>
          )}
        </dl>
        {sees('seeCost') && !live && <div className="muted small">{t('m.costOnline')}</div>}
      </div>
      {edit && (b.status === 'in_stock' || b.status === 'reserved') && (
        <button className="btn primary bigbtn" onClick={() => nav('/m/move?b=' + no)}>
          {t('m.moveThis')}
        </button>
      )}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        {edit && b.status === 'in_stock' && (
          <button className="btn bigbtn" onClick={() => setDlg(true)}>
            {t('nav.stockout')}
          </button>
        )}
        {edit && (
          <button className="btn bigbtn" disabled={!st.online} onClick={() => fileRef.current?.click()}>
            {t('m.takePhoto')}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void photo(e.target.files?.[0])}
        />
      </div>
      {edit && !st.online && <div className="muted small">{t('m.photoOnline')}</div>}
      {dlg && (
        <Dialog
          title={`${t('nav.stockout')} ${no}`}
          onClose={() => setDlg(false)}
          footer={
            <>
              <button className="btn" onClick={() => setDlg(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn primary"
                disabled={!reason || (reason === 'other' && !note.trim())}
                onClick={mark}
              >
                {t('so.submit')}
              </button>
            </>
          }
        >
          <ReasonPicker reason={reason} setReason={setReason} note={note} setNote={setNote} />
        </Dialog>
      )}
    </div>
  );
}

// ===================== Case =====================
export function MCase() {
  const { t } = useI18n();
  const { no = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useSession();
  const un = useUn();
  const [s, st] = useSnap();
  const [out, setOut] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  if (!s)
    return (
      <div className="mpage">
        <MHead title={no} />
        <NoData />
      </div>
    );
  const c = s.byCase.get(no);
  if (!c)
    return (
      <div className="mpage">
        <MHead title={no} />
        <div className="card">{t('err.caseNotFound')}</div>
      </div>
    );
  const bottles = s.bottles.filter((b) => b.caseNo === no);
  const inStock = bottles.filter((b) => b.status === 'in_stock');
  const wines = [...new Set(bottles.map((b) => b.wineId))].map((id) => s.byWineId.get(id)).filter(Boolean);
  const edit = can('inventory', 'edit');
  return (
    <div className="mpage">
      <MHead title={t('m.caseN', { no })} />
      <SyncPill />
      <div className="card">
        <dl className="dl">
          <dt>{t('f.location')}</dt>
          <dd>
            {rackLabel(s, c.rackId, un)}
            {c.uncertain ? (
              <span className="tag warn" style={{ marginLeft: 6 }}>
                {t('f.location_uncertain')}
              </span>
            ) : null}
          </dd>
          <dt>{t('m.bottles')}</dt>
          <dd>
            {inStock.length}
            {c.capacity ? ' / ' + c.capacity : ''}
          </dd>
          <dt>{t('m.wine')}</dt>
          <dd>
            {wines.map((w) => (
              <div key={w!.id}>
                <Link to={'/m/w/' + w!.wineNo}>{w!.name}</Link> {w!.vintage}
              </div>
            ))}
          </dd>
        </dl>
      </div>
      {edit && (
        <button className="btn primary bigbtn" onClick={() => nav('/m/move?case=' + encodeURIComponent(no))}>
          {t('m.moveCase')}
        </button>
      )}
      {edit && inStock.length > 0 && (
        <button className="btn bigbtn" onClick={() => setOut(true)}>
          {t('m.stockoutCase')}
        </button>
      )}
      {out && (
        <Dialog
          title={`${t('m.stockoutCase')} ${no}`}
          onClose={() => setOut(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOut(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn primary"
                disabled={!reason || (reason === 'other' && !note.trim())}
                onClick={async () => {
                  await queueOp('stockout', { bottleNos: inStock.map((b) => b.bottleNo), reason, note });
                  setOut(false);
                  toast(st.online ? t('m.doneSyncing') : t('m.doneLater'));
                }}
              >
                {t('m.confirmStockoutN', { n: inStock.length })}
              </button>
            </>
          }
        >
          <ReasonPicker reason={reason} setReason={setReason} note={note} setNote={setNote} />
        </Dialog>
      )}
      <div className="mlist">
        {bottles.map((b) => (
          <Link key={b.bottleNo} to={'/m/b/' + b.bottleNo}>
            <span>{b.bottleNo}</span>
            <span className="muted small">{t(`st.${b.status}`)} ›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ===================== Locker =====================
export function MLocker() {
  const { t } = useI18n();
  const { id } = useParams();
  const { can } = useSession();
  const [s] = useSnap();
  if (!s)
    return (
      <div className="mpage">
        <MHead title="…" />
        <NoData />
      </div>
    );
  const l = s.byLocker.get(Number(id));
  if (!l)
    return (
      <div className="mpage">
        <MHead title="?" />
        <div className="card">{t('err.notFound')}</div>
      </div>
    );
  const racks = s.racks.filter((r) => r.lockerId === l.id);
  return (
    <div className="mpage">
      <MHead title={lockerLabel(s, l.id)} />
      {can('inventory', 'edit') && (
        <div className="row">
          <Link className="btn" to={'/m/count?locker=' + l.id}>
            {t('m.countHere')}
          </Link>
        </div>
      )}
      {racks.map((r) => {
        const cases = s.cases.filter((c) => c.rackId === r.id);
        const loose = s.bottles.filter((b) => b.rackId === r.id && !b.caseNo && b.status === 'in_stock');
        return (
          <div key={r.id}>
            <b>
              {t('m.rack')} {r.isDefault ? t('unassigned') : r.code}
            </b>
            <div className="mlist" style={{ marginTop: 6 }}>
              {cases.map((c) => {
                const bs = s.bottles.filter((b) => b.caseNo === c.caseNo && b.status === 'in_stock');
                return (
                  <Link key={c.caseNo} to={'/m/c/' + encodeURIComponent(c.caseNo)}>
                    <span>
                      <b>{c.caseNo}</b>
                      <div className="muted small">
                        {s.byWineId.get(bs[0]?.wineId)?.name ?? t('m.emptyCase')}
                      </div>
                    </span>
                    <span className="muted small">{t('m.btlN', { n: bs.length })} ›</span>
                  </Link>
                );
              })}
              {loose.map((b) => (
                <Link key={b.bottleNo} to={'/m/b/' + b.bottleNo}>
                  <span>
                    {b.bottleNo}
                    <div className="muted small">{s.byWineId.get(b.wineId)?.name}</div>
                  </span>
                  <span className="tag">{t('m.loose')}</span>
                </Link>
              ))}
              {!cases.length && !loose.length && <div className="muted small">{t('m.empty')}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ===================== Wine =====================
export function MWine() {
  const { t, lang } = useI18n();
  const { no = '' } = useParams();
  const f = useFmt();
  const un = useUn();
  const [s] = useSnap();
  if (!s)
    return (
      <div className="mpage">
        <MHead title={no} />
        <NoData />
      </div>
    );
  const w = s.byWineNo.get(no);
  if (!w)
    return (
      <div className="mpage">
        <MHead title={no} />
        <div className="card">{t('err.notFound')}</div>
      </div>
    );
  const bottles = s.bottles.filter((b) => b.wineId === w.id && b.status === 'in_stock');
  const groups = new Map<string, typeof bottles>();
  for (const b of bottles) {
    const k = b.caseNo || 'R' + b.rackId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(b);
  }
  const type = s.types.find((x) => x.code === w.typeCode);
  return (
    <div className="mpage">
      <MHead title={w.name} />
      <div className="card">
        <dl className="dl">
          <dt>{t('f.winery')}</dt>
          <dd>{w.winery}</dd>
          <dt>{t('f.vintage')}</dt>
          <dd>{w.vintage}</dd>
          <dt>{t('f.type')}</dt>
          <dd>{type ? (lang === 'en' ? type.en : type.zh) : '—'}</dd>
          <dt>{t('wine.inStock')}</dt>
          <dd>{t('m.btlN', { n: bottles.length })}</dd>
          {w.price !== undefined && (
            <>
              <dt>{t('f.marketPrice')}</dt>
              <dd>
                {f.money(w.price, s.currency)} <span className="muted small">{w.priceDate}</span>
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="mlist">
        {[...groups.entries()].map(([k, bs]) => (
          <Link
            key={k}
            to={bs[0].caseNo ? '/m/c/' + encodeURIComponent(bs[0].caseNo) : '/m/b/' + bs[0].bottleNo}
          >
            <span>
              <b>{bs[0].caseNo ? t('m.caseN', { no: bs[0].caseNo }) : t('m.loose')}</b>
              <div className="muted small">{rackLabel(s, bs[0].rackId, un)}</div>
            </span>
            <span className="muted small">{t('m.btlN', { n: bs.length })} ›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ===================== Move =====================
export function MMove() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const un = useUn();
  const [sp] = useSearchParams();
  const [s] = useSnap();
  const [items, setItems] = useState<string[]>([]);
  const [wholeCase, setWholeCase] = useState(sp.get('case') || '');
  const [dest, setDest] = useState<
    { kind: 'rack'; rackId: number } | { kind: 'case'; caseNo: string } | null
  >(null);
  const [newCase, setNewCase] = useState(false);
  const [note, setNote] = useState('');
  const [step, setStep] = useState(sp.get('b') || sp.get('case') ? 2 : 1);
  const [msg, setMsg] = useState<Flash>(null);
  const [pickLocker, setPickLocker] = useState<number | null>(null);
  useEffect(() => {
    if (sp.get('b')) setItems([sp.get('b')!]);
  }, [sp]);
  if (!s)
    return (
      <div className="mpage">
        <MHead title={t('nav.move')} />
        <NoData />
      </div>
    );
  const onSource = (code: string) => {
    const r = resolveLocal(s, code, un);
    if (!r) return setMsg({ kind: 'err', text: t('m.notFound', { code }) });
    if (r.type === 'bottle') {
      if (r.b.status !== 'in_stock' && r.b.status !== 'reserved')
        return setMsg({ kind: 'err', text: t('m.notInStock', { no: r.bottleNo }) });
      if (items.includes(r.bottleNo))
        return setMsg({ kind: 'warn', text: t('m.alreadyAdded', { no: r.bottleNo }) });
      setWholeCase('');
      setItems([...items, r.bottleNo]);
      setMsg({ kind: 'ok', text: `${r.bottleNo} · ${r.wine?.name ?? ''}` });
    } else if (r.type === 'case') {
      if (!items.length) {
        setWholeCase(r.caseNo);
        setMsg({ kind: 'ok', text: t('m.wholeCase', { no: r.caseNo, n: r.bottles.length }) });
      } else {
        const add = r.bottles.map((b) => b.bottleNo).filter((x) => !items.includes(x));
        setItems([...items, ...add]);
        setMsg({ kind: 'ok', text: t('m.addedN', { n: add.length }) });
      }
    } else setMsg({ kind: 'err', text: t('m.scanBottleOrCase') });
  };
  const onDest = (code: string) => {
    const r = resolveLocal(s, code, un);
    if (!r) return setMsg({ kind: 'err', text: t('m.notFound', { code }) });
    if (r.type === 'rack') {
      setDest({ kind: 'rack', rackId: r.id });
      setMsg(null);
    } else if (r.type === 'locker') {
      setPickLocker(r.id);
      setMsg(null);
    } else if (r.type === 'case' && !wholeCase) {
      setDest({ kind: 'case', caseNo: r.caseNo });
      setMsg(null);
    } else setMsg({ kind: 'err', text: wholeCase ? t('m.scanRack') : t('m.scanRackOrCase') });
  };
  const from = wholeCase
    ? rackLabel(s, s.byCase.get(wholeCase)?.rackId, un)
    : [
        ...new Set(
          items.map((no) => s.byBottle.get(no)).map((b) => b?.caseNo || rackLabel(s, b?.rackId, un)),
        ),
      ].join(', ');
  const destCase = dest?.kind === 'case' ? s.byCase.get(dest.caseNo) : undefined;
  const destLabel = !dest
    ? ''
    : dest.kind === 'case'
      ? `${t('m.caseN', { no: dest.caseNo })} @ ${rackLabel(s, destCase?.rackId, un)}`
      : (newCase && !wholeCase ? t('m.newCaseAt') : '') + rackLabel(s, dest.rackId, un);
  const destCount = destCase
    ? s.bottles.filter((b) => b.caseNo === destCase.caseNo && b.status === 'in_stock').length
    : 0;
  const n = wholeCase
    ? s.bottles.filter((b) => b.caseNo === wholeCase && b.status === 'in_stock').length
    : items.length;
  const confirm = async () => {
    if (!dest) return;
    if (wholeCase) {
      if (dest.kind !== 'rack') return;
      await queueOp('moveCase', { caseNo: wholeCase, rackId: dest.rackId, note });
    } else
      await queueOp('moveBottles', {
        bottleNos: items,
        dest:
          dest.kind === 'case'
            ? { mode: 'case', caseNo: dest.caseNo }
            : { mode: newCase ? 'newcase' : 'loose', rackId: dest.rackId, capacity: 6 },
        note,
      });
    toast(navigator.onLine ? t('m.movedSyncing', { n }) : t('m.movedLater', { n }));
    nav(wholeCase ? '/m/c/' + encodeURIComponent(wholeCase) : '/m');
  };
  return (
    <div className="mpage">
      <MHead title={t('nav.move')} right={<SyncPill />} />
      {step === 1 ? (
        <>
          <b>{t('m.step1')}</b>
          <Scanner onCode={onSource} />
          <FlashBox f={msg} />
          <ManualInput onCode={onSource} placeholder={t('m.bottleOrCase')} />
        </>
      ) : (
        <div className="row between">
          <b>{t('m.step1')}</b>
          <button className="btn sm" onClick={() => setStep(1)}>
            ＋ {t('m.scanMore')}
          </button>
        </div>
      )}
      <div className="mlist">
        {wholeCase ? (
          <div>
            <span>
              <b>{t('m.wholeCaseNo', { no: wholeCase })}</b>
              <div className="muted small">
                {t('m.btlN', { n })} · {t('m.now')} {from}
              </div>
            </span>
            <button className="btn ghost sm" onClick={() => setWholeCase('')} aria-label={t('m.remove')}>
              ×
            </button>
          </div>
        ) : (
          items.map((no) => {
            const b = s.byBottle.get(no);
            return (
              <div key={no}>
                <span>
                  <b>{no}</b>
                  <div className="muted small">
                    {s.byWineId.get(b?.wineId ?? -1)?.name} · {t('m.now')}{' '}
                    {b?.caseNo ?? rackLabel(s, b?.rackId, un)}
                  </div>
                </span>
                <button
                  className="btn ghost sm"
                  onClick={() => setItems(items.filter((x) => x !== no))}
                  aria-label={t('m.remove')}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
        {!wholeCase && !items.length && <div className="muted small">{t('m.moveHint')}</div>}
      </div>
      {step === 1 && n > 0 && (
        <button
          className="btn primary bigbtn"
          onClick={() => {
            setStep(2);
            setMsg(null);
          }}
        >
          {t('m.nextDest')}
        </button>
      )}
      {step === 2 && n > 0 && (
        <>
          <b>{t('m.step2')}</b>
          {!dest ? (
            <>
              <Scanner onCode={onDest} />
              <div className="muted small center">{wholeCase ? t('m.scanRack') : t('m.scanRackOrCase')}</div>
              <FlashBox f={msg} />
              <ManualInput onCode={onDest} placeholder="RACK:12 / 12-06-23-07" />
              <select
                className="input"
                value=""
                onChange={(e) => e.target.value && setPickLocker(Number(e.target.value))}
              >
                <option value="">{t('m.orPickLocker')}</option>
                {s.lockers.map((l) => (
                  <option key={l.id} value={l.id}>
                    {lockerLabel(s, l.id)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <div className="flash ok">
                <b>{t('m.destination')}</b>
                <div>{destLabel}</div>
                {destCase && (
                  <div className="small">
                    ({destCount} → {destCount + n}
                    {destCase.capacity ? ' / ' + destCase.capacity : ''})
                  </div>
                )}
              </div>
              {destCase?.capacity && destCount + n > destCase.capacity ? (
                <div className="flash warn">{t('m.overCapacity')}</div>
              ) : null}
              {dest.kind === 'rack' && !wholeCase && (
                <label className="check">
                  <input type="checkbox" checked={newCase} onChange={(e) => setNewCase(e.target.checked)} />
                  {t('m.intoNewCase')}
                </label>
              )}
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setDest(null)}>
                {t('m.change')}
              </button>
              <Field label={t('f.note')}>
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <button className="btn primary bigbtn" onClick={confirm}>
                {t('m.confirmMove', { n })}
              </button>
            </>
          )}
        </>
      )}
      {pickLocker && (
        <Dialog title={t('m.pickRack')} onClose={() => setPickLocker(null)}>
          <div className="stack">
            {s.racks
              .filter((r) => r.lockerId === pickLocker)
              .map((r) => (
                <button
                  key={r.id}
                  className="btn"
                  onClick={() => {
                    setDest({ kind: 'rack', rackId: r.id });
                    setPickLocker(null);
                  }}
                >
                  {rackLabel(s, r.id, un)}
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ===================== Scan to list =====================
export function MScanList() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const un = useUn();
  const [s, st] = useSnap();
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState<Flash>(null);
  const [name, setName] = useState('');
  const [lists, setLists] = useState<{ id: number; name: string }[] | null>(null);
  if (!s)
    return (
      <div className="mpage">
        <MHead title={t('m.scanToList')} />
        <NoData />
      </div>
    );
  const items = codes.map((c) => [c, resolveLocal(s, c, un)!] as const);
  const bottles = items.reduce(
    (n, [, r]) =>
      n +
      (r.type === 'case'
        ? r.bottles.length
        : r.type === 'bottle'
          ? 1
          : r.type === 'locker'
            ? s.bottles.filter((b) => s.byRack.get(b.rackId)?.lockerId === r.id && b.status === 'in_stock')
                .length
            : 0),
    0,
  );
  const add = (code: string) => {
    const r = resolveLocal(s, code, un);
    if (!r || r.type === 'rack') return setMsg({ kind: 'err', text: t('m.cannotAdd', { code }) });
    const key =
      r.type === 'case'
        ? r.caseNo
        : r.type === 'bottle'
          ? r.bottleNo
          : r.type === 'wine'
            ? r.wineNo
            : 'LOCKER:' + r.id;
    if (codes.includes(key)) return setMsg({ kind: 'warn', text: t('m.alreadyAdded', { no: key }) });
    setCodes([...codes, key]);
    setMsg({ kind: 'ok', text: t('m.itemsN', { n: codes.length + 1 }) });
  };
  const save = async () => {
    await queueOp('listCreate', { name, codes });
    toast(st.online ? t('m.listSaved') : t('m.doneLater'));
    nav(st.online ? '/lists' : '/m');
  };
  const addExisting = async (id: number) => {
    // Existing list: wines from scanned bottles / cases / lockers (needs a connection).
    const wineNos = [
      ...new Set(
        items.flatMap(([, r]) =>
          r.type === 'wine'
            ? [r.wineNo]
            : r.type === 'bottle'
              ? [r.wine?.wineNo]
              : r.type === 'case'
                ? r.bottles.map((b) => s.byWineId.get(b.wineId)?.wineNo)
                : r.type === 'locker'
                  ? s.bottles
                      .filter((b) => s.byRack.get(b.rackId)?.lockerId === r.id && b.status === 'in_stock')
                      .map((b) => s.byWineId.get(b.wineId)?.wineNo)
                  : [],
        ),
      ),
    ].filter(Boolean) as string[];
    try {
      const r = await api<{ added: number }>(`/lists/${id}/items`, { body: { wineNos } });
      toast(t('lists.added', { n: r.added, name: lists?.find((l) => l.id === id)?.name ?? '' }));
      nav('/lists/' + id);
    } catch {
      toast(t('err.server'));
    }
  };
  return (
    <div className="mpage">
      <MHead title={t('m.scanToList')} right={<span className="tag">{t('m.continuous')}</span>} />
      <SyncPill />
      <Scanner onCode={add} />
      <div className="muted small center">{t('m.scanListHint')}</div>
      <FlashBox f={msg} />
      <ManualInput onCode={add} />
      <div className="muted">{t('m.itemsBottles', { n: codes.length, b: bottles })}</div>
      <div className="mlist">
        {items.map(([c, r]) => (
          <div key={c}>
            <span>
              <span className="tag" style={{ marginRight: 6 }}>
                {t(`m.kind.${r.type}`)}
              </span>
              <b>{r.type === 'locker' ? r.label : c}</b>
              <div className="muted small">
                {r.type === 'bottle' || r.type === 'case'
                  ? (r.wine?.name ?? '')
                  : r.type === 'wine'
                    ? r.w.name
                    : ''}
                {r.type === 'case' ? ` · ${t('m.btlN', { n: r.bottles.length })}` : ''}
              </div>
            </span>
            <button
              className="btn ghost sm"
              onClick={() => setCodes(codes.filter((x) => x !== c))}
              aria-label={t('m.remove')}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {codes.length > 0 && (
        <>
          <Field label={t('m.listName')}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button className="btn primary bigbtn" disabled={!name.trim()} onClick={save}>
            {t('m.saveList')}
          </button>
          {st.online && (
            <button className="btn bigbtn" onClick={async () => setLists(await api('/lists'))}>
              {t('m.addToExisting')}
            </button>
          )}
        </>
      )}
      {lists && (
        <Dialog title={t('m.addToExisting')} onClose={() => setLists(null)}>
          <div className="stack">
            {lists.map((l) => (
              <button key={l.id} className="btn" onClick={() => addExisting(l.id)}>
                {l.name}
              </button>
            ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

// ===================== Count (stocktake) =====================
export function MCount() {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const un = useUn();
  const [sp] = useSearchParams();
  const [s] = useSnap();
  const [locker, setLocker] = useState<number | null>(sp.get('locker') ? Number(sp.get('locker')) : null);
  const [codes, setCodes] = useState<string[]>([]);
  const [msg, setMsg] = useState<Flash>(null);
  const started = useRef(new Date().toISOString());
  const expected = useMemo(() => {
    if (!s || !locker) return [];
    const racks = new Set(s.racks.filter((r) => r.lockerId === locker).map((r) => r.id));
    return s.cases.filter(
      (c) => racks.has(c.rackId) && s.bottles.some((b) => b.caseNo === c.caseNo && b.status === 'in_stock'),
    );
  }, [s, locker]);
  if (!s)
    return (
      <div className="mpage">
        <MHead title={t('m.count')} />
        <NoData />
      </div>
    );
  const pickByScan = (code: string) => {
    const r = resolveLocal(s, code, un);
    if (r?.type === 'locker') setLocker(r.id);
    else if (r?.type === 'rack') setLocker(r.rack.lockerId);
    else setMsg({ kind: 'err', text: t('m.scanLockerFirst') });
  };
  const scan = (code: string) => {
    const r = resolveLocal(s, code, un);
    if (!r) {
      if (!codes.includes(code)) setCodes([...codes, code]);
      return setMsg({ kind: 'err', text: t('m.unknownCode', { code }) });
    }
    if (r.type === 'locker' || r.type === 'rack' || r.type === 'wine') return;
    const key = r.type === 'case' ? r.caseNo : r.bottleNo;
    if (codes.includes(key)) return setMsg({ kind: 'warn', text: t('m.alreadyScanned', { no: key }) });
    setCodes([...codes, key]);
    const here =
      r.type === 'case'
        ? expected.some((c) => c.caseNo === r.caseNo)
        : s.byRack.get(r.b.rackId)?.lockerId === locker;
    setMsg(
      here
        ? { kind: 'ok', text: `${key} ✓` }
        : { kind: 'warn', text: t('m.recordedAt', { no: key, at: r.label }) },
    );
  };
  const found = new Set(
    codes
      .map((c) => {
        const r = resolveLocal(s, c, un);
        return r?.type === 'case' ? r.caseNo : r?.type === 'bottle' ? r.b.caseNo : null;
      })
      .filter(Boolean),
  );
  const finish = async () => {
    await queueOp('count', { lockerId: locker, codes, startedAt: started.current });
    toast(t('m.countSaved'));
    nav('/m/sync');
  };
  return (
    <div className="mpage">
      <MHead title={t('m.count')} right={<SyncPill />} />
      {!locker ? (
        <>
          <div className="muted">{t('m.countIntro')}</div>
          <Scanner onCode={pickByScan} />
          <FlashBox f={msg} />
          <select className="input" value="" onChange={(e) => setLocker(Number(e.target.value))}>
            <option value="">{t('m.pickLocker')}</option>
            {s.lockers.map((x) => (
              <option key={x.id} value={x.id}>
                {lockerLabel(s, x.id)}
              </option>
            ))}
          </select>
        </>
      ) : (
        <>
          <div className="card row between">
            <b>{lockerLabel(s, locker)}</b>
            <span className="muted">
              {t('m.foundOf', { n: expected.filter((c) => found.has(c.caseNo)).length, of: expected.length })}
            </span>
          </div>
          <Scanner onCode={scan} />
          <FlashBox f={msg} />
          <ManualInput onCode={scan} />
          <div className="mlist">
            {expected.map((c) => (
              <div key={c.caseNo}>
                <span>
                  {c.caseNo}
                  <div className="muted small">
                    {s.byWineId.get(s.bottles.find((b) => b.caseNo === c.caseNo)?.wineId ?? -1)?.name}
                  </div>
                </span>
                {found.has(c.caseNo) ? (
                  <span className="tag ok">✓</span>
                ) : (
                  <span className="tag">{t('m.notYet')}</span>
                )}
              </div>
            ))}
          </div>
          <button className="btn primary bigbtn" disabled={!codes.length} onClick={finish}>
            {t('m.finishCount', { n: codes.length })}
          </button>
        </>
      )}
    </div>
  );
}

// ===================== Search (offline too) =====================
export function MSearch() {
  const { t, lang } = useI18n();
  const f = useFmt();
  const [s] = useSnap();
  const [q, setQ] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  if (!s)
    return (
      <div className="mpage">
        <MHead title={t('nav.search')} back={false} />
        <NoData />
      </div>
    );
  const norm = (x: unknown) =>
    String(x ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase();
  const nq = norm(q).trim();
  const counts = new Map<number, number>();
  const cases = new Map<number, Set<string>>();
  const lockers = new Map<number, Set<string>>();
  for (const b of s.bottles)
    if (b.status === 'in_stock') {
      counts.set(b.wineId, (counts.get(b.wineId) ?? 0) + 1);
      if (b.caseNo) {
        if (!cases.has(b.wineId)) cases.set(b.wineId, new Set());
        cases.get(b.wineId)!.add(b.caseNo);
      }
      const lk = s.byLocker.get(s.byRack.get(b.rackId)?.lockerId ?? -1)?.code;
      if (!lockers.has(b.wineId)) lockers.set(b.wineId, new Set());
      if (lk) lockers.get(b.wineId)!.add(lk);
    }
  const rows = s.wines
    .filter(
      (w) =>
        counts.get(w.id) &&
        (!types.length || types.includes(w.typeCode ?? '')) &&
        (!nq ||
          norm(`${w.wineNo} ${w.winery} ${w.name} ${w.region} ${w.country} ${w.vintage}`).includes(nq) ||
          [...(lockers.get(w.id) ?? [])].some((x) => norm(x) === nq)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const totalB = rows.reduce((n, w) => n + (counts.get(w.id) ?? 0), 0);
  const totalC = rows.reduce((n, w) => n + (cases.get(w.id)?.size ?? 0), 0);
  const typeList = s.types.filter((x) => s.wines.some((w) => w.typeCode === x.code && counts.get(w.id)));
  return (
    <div className="mpage">
      <MHead title={t('nav.search')} back={false} right={<SyncPill />} />
      <Modes on="/m/search" />
      <input
        className="input"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('m.searchHint')}
      />
      <div className="chips">
        {typeList.map((x) => (
          <button
            key={x.code}
            className={'chip' + (types.includes(x.code) ? ' on' : '')}
            onClick={() =>
              setTypes(types.includes(x.code) ? types.filter((y) => y !== x.code) : [...types, x.code])
            }
          >
            {lang === 'en' ? x.en : x.zh}
          </button>
        ))}
      </div>
      <div className="muted small">{t('m.totals', { w: rows.length, c: totalC, b: totalB })}</div>
      <div className="mlist">
        {rows.slice(0, 200).map((w) => (
          <Link key={w.id} to={'/m/w/' + w.wineNo}>
            <span>
              <b>{w.name}</b>
              <div className="muted small">
                {w.vintage} · {[...(lockers.get(w.id) ?? [])].join(', ')}
              </div>
            </span>
            <span style={{ textAlign: 'right' }}>
              {t('m.btlN', { n: counts.get(w.id) ?? 0 })}
              {w.price !== undefined && <div className="muted small">{f.money(w.price, s.currency)}</div>}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// ===================== Sync =====================
export function MSync() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const st = useOffline();
  const [s] = useSnap();
  const describe = useDescribeOp();
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const run = async (fn: () => Promise<{ online?: boolean; error?: string } | unknown>) => {
    setBusy(true);
    try {
      const r = (await fn()) as { online?: boolean; error?: string } | undefined;
      if (r && r.online === false) toast(t('m.cannotReach'));
      else if (r?.error)
        toast(t(`err.${r.error}`) === `err.${r.error}` ? t('err.server') : t(`err.${r.error}`));
    } catch {
      toast(t('err.network'));
    } finally {
      setBusy(false);
    }
  };
  const when = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleString(lang, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '—';
  return (
    <div className="mpage">
      <MHead title={t('m.sync')} />
      <div className={'flash ' + (st.online ? 'ok' : 'warn')}>
        <b>{st.online ? t('m.connected') : t('m.offline')}</b>
        <div className="small">
          {t('m.lastSync')} {when(st.lastSync)}
        </div>
        {!st.online && <div className="small">{t('m.uploadsLater')}</div>}
      </div>
      {st.errors.length > 0 && (
        <div className="flash err">
          {t('m.someRefused')}{' '}
          {[...new Set(st.errors)].map((e) => (t(`err.${e}`) === `err.${e}` ? e : t(`err.${e}`))).join(' · ')}
        </div>
      )}
      {st.conflicts > 0 && (
        <Link className="btn primary bigbtn" to="/m/conflicts">
          {t('m.reviewConflicts', { n: st.conflicts })}
        </Link>
      )}
      <b>{t('m.pendingN', { n: st.pending })}</b>
      <div className="mlist">
        {st.ops.map((op) => {
          const d = describe(s, op);
          return (
            <div key={op.id}>
              <span className="muted small" style={{ minWidth: 44 }}>
                {when(op.ts).split(' ').pop()}
              </span>
              <span style={{ flex: 1 }}>
                <b>{d.title}</b>
                <div className="muted small">{d.sub}</div>
              </span>
            </div>
          );
        })}
        {!st.ops.length && <div className="muted small">{t('m.nothingPending')}</div>}
      </div>
      <button className="btn primary bigbtn" disabled={busy || st.syncing} onClick={() => run(() => sync())}>
        {st.syncing ? t('m.syncing') : t('m.syncNow')}
      </button>
      <div className="card stack">
        <b>{t('m.dataOnPhone')}</b>
        {st.snap ? (
          <div className="small">
            {t('m.snapInfo', {
              w: st.snap.wines,
              b: st.snap.bottles,
              c: st.snap.cases,
              at: when(st.snap.at),
            })}
          </div>
        ) : (
          <div className="small muted">—</div>
        )}
        <div className="muted small">{t('m.snapNote')}</div>
        <div className="row">
          <button
            className="btn sm"
            disabled={busy || !st.online}
            onClick={() => run(() => refreshSnapshot())}
          >
            {t('m.redownload')}
          </button>
          <button className="btn sm" disabled={busy} onClick={() => setConfirmClear(true)}>
            {t('m.clearPhone')}
          </button>
          <Link className="btn sm ghost" to="/phone">
            {t('m.phoneSetup')}
          </Link>
        </div>
      </div>
      {confirmClear && (
        <Dialog
          title={t('m.clearPhone')}
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmClear(false)}>
                {t('cancel')}
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await clearLocal();
                  setConfirmClear(false);
                  nav('/m/sync');
                }}
              >
                {t('m.clearPhone')}
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            {st.pending ? t('m.clearPendingWarn', { n: st.pending }) : t('m.clearInfo')}
          </p>
        </Dialog>
      )}
    </div>
  );
}

// ===================== Conflicts =====================
interface Conflict {
  id: string;
  type: string;
  ts: string;
  user: string;
  payload: Record<string, unknown>;
  conflict: {
    diffs: { code: string; was: string; now: string; status: string }[];
    by: { ts: string; user: string; action: string } | null;
  };
}
export function MConflicts() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const describe = useDescribeOp();
  const [list, setList] = useState<Conflict[] | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [s] = useSnap();
  useEffect(() => {
    api<Conflict[]>('/offline/conflicts').then(setList).catch(setErr);
  }, []);
  const when = (iso?: string) =>
    iso
      ? new Date(iso).toLocaleString(lang, {
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : '';
  if (err)
    return (
      <div className="mpage">
        <MHead title={t('m.conflicts')} />
        <ErrorBox error={err} />
      </div>
    );
  if (!list)
    return (
      <div className="mpage">
        <MHead title={t('m.conflicts')} />
        <div className="muted">{t('loading')}</div>
      </div>
    );
  if (!list.length)
    return (
      <div className="mpage">
        <MHead title={t('m.conflicts')} />
        <div className="flash ok">{t('m.noConflicts')}</div>
        <Link className="btn bigbtn" to="/m">
          {t('m.backToScan')}
        </Link>
      </div>
    );
  const c = list[0];
  const d = describe(s, { type: c.type as never, payload: c.payload });
  const choose = async (choice: 'mine' | 'server') => {
    try {
      await api('/offline/resolve', { body: { id: c.id, choice } });
      toast(t('m.resolved'));
      await sync();
      const left = list.filter((x) => x.id !== c.id);
      setList(left);
      if (!left.length) nav('/m/sync');
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="mpage">
      <MHead title={t('m.conflicts')} right={<span className="muted">1 / {list.length}</span>} />
      <div className="muted">{t('m.conflictIntro')}</div>
      {c.conflict.diffs.map((x) => (
        <div className="card" key={x.code}>
          <b>{x.code}</b>
          <div className="muted small">
            {t('m.before')} {x.was}
          </div>
        </div>
      ))}
      <div className="card stack" style={{ borderColor: 'var(--accent)', gap: 4 }}>
        <b>{t('m.yourChange')}</b>
        <div className="muted small">
          {c.user} · {when(c.ts)} ({t('m.offline')})
        </div>
        <div>{d.title}</div>
        <div className="muted small">{d.sub}</div>
      </div>
      <div className="card stack" style={{ gap: 4 }}>
        <b>{t('m.serverNow')}</b>
        {c.conflict.by && (
          <div className="muted small">
            {c.conflict.by.user} · {when(c.conflict.by.ts)} · {t(`audit.act.${c.conflict.by.action}`)}
          </div>
        )}
        {c.conflict.diffs.map((x) => (
          <div key={x.code}>
            {x.code}: {x.now}
            {x.status !== 'in_stock' ? ` · ${t(`st.${x.status}`)}` : ''}
          </div>
        ))}
      </div>
      <button className="btn primary bigbtn" onClick={() => choose('mine')}>
        {t('m.keepMine')}
      </button>
      <button className="btn bigbtn" onClick={() => choose('server')}>
        {t('m.keepServer')}
      </button>
    </div>
  );
}

export type { Snapshot };
