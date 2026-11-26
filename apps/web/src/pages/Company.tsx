/** Settings › Company: details printed on order documents, default tax rate and order price markup. */
import { useEffect, useState } from 'react';
import { Field, useI18n, useToast } from '@mwc/ui';
import { api } from '../api.ts';
import { useApi } from '../hooks.ts';
import { useSession } from '../session.tsx';
import { ErrorBox } from '../inv.tsx';

type Company = Record<
  'name' | 'nameEn' | 'taxId' | 'phone' | 'email' | 'address' | 'addressEn' | 'bank',
  string
> & {
  taxRate: number;
  orderMarkup: number;
};

export function CompanySettings() {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useSession();
  const { data } = useApi<Company>('/settings/company');
  const [f, setF] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    if (data) setF(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v ?? '')])));
  }, [data]);
  if (!data) return <div className="muted">{t('loading')}</div>;
  const ro = !can('settings', 'edit');
  const inp = (k: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input
        className="input"
        disabled={ro}
        value={f[k] ?? ''}
        onChange={(e) => setF({ ...f, [k]: e.target.value })}
      />
    </Field>
  );
  const save = async () => {
    setErr(null);
    try {
      await api('/settings/company', {
        method: 'PATCH',
        body: { ...f, taxRate: Number(f.taxRate) || 0, orderMarkup: Number(f.orderMarkup) || 0 },
      });
      toast(t('saved'));
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 760 }}>
      <p className="muted" style={{ margin: 0 }}>
        {t('co.intro')}
      </p>
      <div className="grid g2">
        {inp('name', t('co.name'))}
        {inp('nameEn', t('co.nameEn'))}
        {inp('address', t('co.address'))}
        {inp('addressEn', t('co.addressEn'))}
        {inp('phone', t('cu.phone'))}
        {inp('email', t('cu.email'))}
        {inp('taxId', t('co.taxId'))}
        {inp('taxRate', t('co.taxRate'), t('co.taxRateHint'))}
        {inp('orderMarkup', t('co.markup'), t('co.markupHint'))}
      </div>
      <Field label={t('co.bank')} hint={t('co.bankHint')}>
        <textarea
          className="input"
          rows={3}
          disabled={ro}
          value={f.bank ?? ''}
          onChange={(e) => setF({ ...f, bank: e.target.value })}
        />
      </Field>
      <ErrorBox error={err} />
      {!ro && (
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={save}>
          {t('save')}
        </button>
      )}
    </div>
  );
}
