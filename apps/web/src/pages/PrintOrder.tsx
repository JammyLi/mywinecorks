/** Order document (customer copy, in the order's language) and pick list (ported from MyWines PrintOrder.jsx). */
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { fmtMoney, lineAmount } from '@mwc/shared';
import { translate, useI18n } from '@mwc/ui';
import { api } from '../api.ts';
import type { OrderDetail } from './Orders.tsx';

function Qr({ value, size }: { value: string; size: number }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    void QRCode.toString(value, { type: 'svg', margin: 0 }).then(setSvg);
  }, [value]);
  return <div style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PrintOrderPage() {
  const { no = '' } = useParams();
  const [sp] = useSearchParams();
  const kind = sp.get('kind') === 'pick' ? 'pick' : 'customer';
  const { t: tUi, lang: uiLang } = useI18n();
  const [d, setD] = useState<OrderDetail | null>(null);
  useEffect(() => {
    void api<OrderDetail>('/orders/' + no).then((x) => {
      setD(x);
      setTimeout(() => window.print(), 700);
    });
  }, [no]);
  if (!d) return <div className="page muted">…</div>;
  const o = d.order;
  const co = d.company;
  const c = d.customer;
  // The customer copy is in the order's language; the pick list in the user's.
  const lang = kind === 'pick' ? uiLang : o.lang;
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const m = (v: number | null | undefined) => fmtMoney(v, o.currency, lang);
  return (
    <div className="doc">
      <div className="no-print row card" style={{ marginBottom: 16, justifyContent: 'space-between' }}>
        <span>{tUi('doc.savePdfHint')}</span>
        <div className="row">
          <button className="btn" onClick={() => window.close()}>
            {tUi('close')}
          </button>
          <button className="btn primary" onClick={() => window.print()}>
            {tUi('doc.printNow')}
          </button>
        </div>
      </div>
      <div className="hd">
        <div>
          <div className="big">{lang === 'en' ? co.nameEn || co.name : co.name}</div>
          <div className="sub">
            {[
              lang === 'en' ? co.addressEn || co.address : co.address,
              co.phone && `${t('doc.tel')} ${co.phone}`,
              co.email,
              co.taxId && `${t('doc.taxId')} ${co.taxId}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="big">{kind === 'pick' ? t('doc.pickList') : t('doc.order')}</div>
          <div>{o.orderNo}</div>
        </div>
        {kind === 'pick' && <Qr value={'ORDER:' + o.orderNo} size={64} />}
      </div>
      <div className="meta">
        <div>
          <span className="sub">{t('doc.customer')}</span>
          <div>
            <b>{c?.name ?? '—'}</b>
            {c?.phone ? ` · ${c.phone}` : ''}
          </div>
          {c?.taxId && (
            <div className="sub">
              {t('doc.taxId')} {c.taxId}
            </div>
          )}
        </div>
        <div>
          <span className="sub">{o.delivery === 'pickup' ? t('doc.pickup') : t('doc.deliverTo')}</span>
          <div>{o.delivery === 'pickup' ? t('doc.pickupAtCellar') : (o.address ?? '—')}</div>
        </div>
        <div>
          <span className="sub">{t('doc.date')}</span>
          <div>{o.orderDate}</div>
        </div>
        <div>
          <span className="sub">{t('doc.deliveryDate')}</span>
          <div>{o.deliveryDate ?? '—'}</div>
        </div>
      </div>
      {kind === 'customer' ? (
        <>
          <table>
            <thead>
              <tr>
                <th>{t('doc.wine')}</th>
                <th>{t('doc.vintage')}</th>
                <th className="r">{t('doc.qty')}</th>
                <th className="r">{t('doc.price')}</th>
                <th className="r">{t('doc.disc')}</th>
                <th className="r">{t('doc.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <b>{l.name}</b>
                    <div className="sub">
                      {l.winery} · {l.volumeMl} ml
                    </div>
                  </td>
                  <td>{l.vintage}</td>
                  <td className="r">{l.qty}</td>
                  <td className="r">{m(l.unitPrice)}</td>
                  <td className="r">{l.discount ? `${l.discount}%` : ''}</td>
                  <td className="r">
                    {m(
                      lineAmount({ qty: l.qty, unit_price: l.unitPrice ?? null, discount: l.discount ?? 0 }),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="tot">
            <span>{t('doc.subtotal')}</span>
            <span className="r">{m(d.totals.subtotal)}</span>
            <span>
              {t('doc.tax')} {o.taxRate}%
            </span>
            <span className="r">{m(d.totals.tax)}</span>
            {(d.totals.shipping ?? 0) > 0 && (
              <>
                <span>{t('doc.shipping')}</span>
                <span className="r">{m(d.totals.shipping)}</span>
              </>
            )}
            <b>{t('doc.total')}</b>
            <b className="r" style={{ fontSize: '12pt' }}>
              {m(d.totals.total)}
            </b>
            {(d.totals.paid ?? 0) !== 0 && (
              <>
                <span>{t('doc.paid')}</span>
                <span className="r">{m(d.totals.paid)}</span>
                <b>{t('doc.due')}</b>
                <b className="r">{m(d.totals.due)}</b>
              </>
            )}
          </div>
          {o.note && (
            <div style={{ marginTop: 14 }}>
              <span className="sub">{t('doc.note')}</span>
              <div>{o.note}</div>
            </div>
          )}
          {co.bank && (
            <div style={{ marginTop: 14, whiteSpace: 'pre-wrap' }}>
              <span className="sub">{t('doc.payTo')}</span>
              <div>{co.bank}</div>
            </div>
          )}
          <div className="sub" style={{ marginTop: 24 }}>
            {t('doc.thanks')}
          </div>
        </>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <th style={{ width: 24 }} />
                <th>{t('doc.wine')}</th>
                <th>{t('doc.location')}</th>
                <th className="r">{t('doc.qty')}</th>
                <th>{t('doc.bottles')}</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.flatMap((l) => {
                const groups = new Map<string, string[]>();
                for (const b of l.held) {
                  const k = b.location + (b.caseNo ? ' › ' + b.caseNo : '');
                  groups.set(k, [...(groups.get(k) ?? []), b.bottleNo]);
                }
                return [...groups.entries()].map(([loc, nos], i) => (
                  <tr key={l.id + loc}>
                    <td>
                      <span className="box" />
                    </td>
                    <td>
                      {i === 0 && (
                        <>
                          <b>{l.name}</b> {l.vintage}
                        </>
                      )}
                    </td>
                    <td>{loc}</td>
                    <td className="r">{nos.length}</td>
                    <td className="sub">{nos.join(', ')}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 24, justifyContent: 'space-between' }}>
            <span>{t('doc.totalBottles', { n: d.totals.bottles })}</span>
            <span>{t('doc.pickedBy')}</span>
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            {t('doc.pickHint')}
          </div>
        </>
      )}
    </div>
  );
}
