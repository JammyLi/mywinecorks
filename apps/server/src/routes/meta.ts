import { MODULES, ROLE_TEMPLATES, VISIBILITY } from '@mwc/shared';
import { Api, PUBLIC, perm } from '../http.ts';

export const VERSION = '0.0.1';

export function mountMeta(api: Api) {
  api.get('/health', PUBLIC, (req) => ({ ok: true, version: VERSION, mode: req.ctx.cfg.mode }));

  /** Public info for the sign-in page (workspace field shown only in cloud mode). */
  api.get('/public/info', PUBLIC, (req) => {
    const { cfg, registry } = req.ctx;
    if (cfg.mode === 'selfhost') {
      const t = registry.list()[0];
      const db = t && registry.tenantDb(t.slug);
      const company = db && JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'company'").get() as { value: string } | undefined)?.value ?? '{}');
      return { mode: cfg.mode, version: VERSION, workspace: t?.slug ?? null, company: company?.name ?? null };
    }
    return { mode: cfg.mode, version: VERSION, workspace: null, company: null };
  });

  api.get('/meta/permissions', perm('roles', 'view'), () => ({ modules: MODULES, visibility: VISIBILITY, templates: ROLE_TEMPLATES }));
}
