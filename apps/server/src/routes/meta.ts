import { MODULES, ROLE_TEMPLATES, VISIBILITY } from '@mwc/shared';
import fs from 'node:fs';
import path from 'node:path';
import { Api, PUBLIC, perm } from '../http.ts';
import { notFound } from '../errors.ts';
import { lanAddresses } from '../services/tls.ts';

export const VERSION = '0.0.1';

export function mountMeta(api: Api) {
  /** Phone setup page (self-hosted): office-network addresses and whether the local CA exists. */
  api.get('/public/phone-setup', PUBLIC, (req) => {
    const { cfg } = req.ctx;
    const ca = cfg.mode === 'selfhost' && fs.existsSync(path.join(cfg.dataDir, 'tls', 'ca.crt'));
    const host = String(req.headers.host ?? '').split(':')[0];
    const ips = lanAddresses();
    return {
      mode: cfg.mode,
      httpsPort: ca ? cfg.httpsPort : 0,
      ip: /^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== '127.0.0.1' ? host : (ips[0] ?? host),
      ips,
      ca,
    };
  });

  /** The local CA certificate a phone installs once (public part only; the key never leaves the server). */
  api.get('/public/ca.crt', PUBLIC, (req, res) => {
    const f = path.join(req.ctx.cfg.dataDir, 'tls', 'ca.crt');
    if (req.ctx.cfg.mode !== 'selfhost' || !fs.existsSync(f)) throw notFound();
    res.locals.raw = true;
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="mywinecorks-ca.crt"');
    res.send(fs.readFileSync(f));
  });

  api.get('/health', PUBLIC, (req) => ({ ok: true, version: VERSION, mode: req.ctx.cfg.mode }));

  /** Public info for the sign-in page (workspace field shown only in cloud mode). */
  api.get('/public/info', PUBLIC, (req) => {
    const { cfg, registry } = req.ctx;
    if (cfg.mode === 'selfhost') {
      const t = registry.list()[0];
      const db = t && registry.tenantDb(t.slug);
      const company =
        db &&
        JSON.parse(
          (
            db.prepare("SELECT value FROM settings WHERE key = 'company'").get() as
              { value: string } | undefined
          )?.value ?? '{}',
        );
      return {
        mode: cfg.mode,
        version: VERSION,
        workspace: t?.slug ?? null,
        company: company?.name ?? null,
        email: !!cfg.smtpUrl,
      };
    }
    return { mode: cfg.mode, version: VERSION, workspace: null, company: null, email: !!cfg.smtpUrl };
  });

  api.get('/meta/permissions', perm('roles', 'view'), () => ({
    modules: MODULES,
    visibility: VISIBILITY,
    templates: ROLE_TEMPLATES,
  }));
}
