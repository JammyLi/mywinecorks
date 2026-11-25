import { useI18n } from '@mwc/ui';
import { useSession } from '../session.tsx';

export function Overview() {
  const { t } = useI18n();
  const { me } = useSession();
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('overview.welcome', { name: me?.name || me?.email || '' })}</h1>
      </div>
      <div className="card">
        <p style={{ margin: 0 }}>{t('overview.intro')}</p>
      </div>
      <div className="grid g3">
        <div className="card">
          <div className="muted small">{t('workspace')}</div>
          <b>{me?.tenant.name}</b>
        </div>
        <div className="card">
          <div className="muted small">{t('users.role')}</div>
          <b>{me?.role.name}</b>
        </div>
        <div className="card">
          <div className="muted small">{t('totpTitle')}</div>
          <b>{me?.totpEnabled ? t('yes') : t('no')}</b>
        </div>
      </div>
    </div>
  );
}

export function ComingSoon() {
  const { t } = useI18n();
  return (
    <div className="page">
      <div className="card muted">{t('comingSoon')}</div>
    </div>
  );
}
