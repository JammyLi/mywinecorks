/** Phone setup (self-hosted; ported from MyWines server/setup.js): install the office CA once, then open /m. */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { BottleMark, Seg, useI18n } from '@mwc/ui';
import { useApi } from '../hooks.ts';

function Qr({ value }: { value: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    void QRCode.toString(value, { type: 'svg', margin: 1 }).then(setSvg);
  }, [value]);
  return <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function PhoneSetup() {
  const { t, lang, setLang } = useI18n();
  const { data } = useApi<{ mode: string; httpsPort: number; ip: string; ca: boolean }>(
    '/public/phone-setup',
  );
  const here = `${location.protocol}//${location.host}`;
  const httpsUrl = data?.httpsPort ? `https://${data.ip}:${data.httpsPort}/m` : `${here}/m`;
  const caUrl = `${here}/api/public/ca.crt`;
  return (
    <div className="phone-setup">
      <div className="row between">
        <div className="row" style={{ gap: 10 }}>
          <BottleMark size={30} />
          <h1 style={{ margin: 0 }}>{t('ph2.title')}</h1>
        </div>
        <Seg
          value={lang}
          onChange={(v) => setLang(v as 'zh-TW' | 'en')}
          options={[
            { value: 'zh-TW', label: '中文' },
            { value: 'en', label: 'EN' },
          ]}
        />
      </div>
      <p className="muted">{t('ph2.intro')}</p>
      <div className="card row" style={{ gap: 20 }}>
        <Qr value={`${here}/phone`} />
        <div>
          <b>{t('ph2.openOnPhone')}</b>
          <div className="muted small">{t('ph2.openOnPhoneHint')}</div>
        </div>
      </div>
      {data?.mode === 'selfhost' && data.ca ? (
        <>
          <div className="card stack">
            <h2>{t('ph2.step1')}</h2>
            <div className="muted small">{t('ph2.step1Hint')}</div>
            <a className="btn primary" style={{ alignSelf: 'flex-start' }} href={caUrl}>
              {t('ph2.download')}
            </a>
          </div>
          <div className="card stack">
            <h2>{t('ph2.iphone')}</h2>
            <ol>
              <li>{t('ph2.iphone1')}</li>
              <li>{t('ph2.iphone2')}</li>
              <li>{t('ph2.iphone3')}</li>
            </ol>
          </div>
          <div className="card stack">
            <h2>{t('ph2.android')}</h2>
            <ol>
              <li>{t('ph2.android1')}</li>
              <li>{t('ph2.android2')}</li>
              <li>{t('ph2.android3')}</li>
            </ol>
          </div>
        </>
      ) : null}
      <div className="card row" style={{ gap: 20 }}>
        <Qr value={httpsUrl} />
        <div className="stack" style={{ gap: 6 }}>
          <h2 style={{ margin: 0 }}>{t('ph2.step3')}</h2>
          <a className="btn primary" style={{ alignSelf: 'flex-start' }} href={httpsUrl}>
            {httpsUrl}
          </a>
          <div className="muted small">{t('ph2.addHome')}</div>
        </div>
      </div>
      <div className="card stack">
        <h2>{t('ph2.faq')}</h2>
        <ol>
          <li>{t('ph2.faq1')}</li>
          <li>{t('ph2.faq2')}</li>
          <li>{t('ph2.faq3')}</li>
        </ol>
      </div>
    </div>
  );
}
