/**
 * The portal's own keys: Ed25519 signs the order-request files it hands out; X25519 receives the
 * encrypted package files from servers without internet. Their public halves are published at
 * /api/keys and built into release servers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PortalConfig } from './config.ts';

export interface PortalKeys {
  signing: string;
  encryption: string;
  public: { signing: string; encryption: string };
}

const pub = (k: string) => crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' }).toString();

export function loadKeys(cfg: PortalConfig): PortalKeys {
  let priv: { signing: string; encryption: string };
  if (cfg.portalKeys) priv = JSON.parse(cfg.portalKeys.replace(/\\n/g, '\n'));
  else {
    if (cfg.production) throw new Error('PORTAL_KEYS is required in production');
    const f = path.join(cfg.dataDir, 'portal-keys.json');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    if (!fs.existsSync(f)) {
      const s = crypto.generateKeyPairSync('ed25519');
      const e = crypto.generateKeyPairSync('x25519');
      fs.writeFileSync(
        f,
        JSON.stringify({
          signing: s.privateKey.export({ type: 'pkcs8', format: 'pem' }),
          encryption: e.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        }),
        { mode: 0o600 },
      );
    }
    priv = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const k = { ...priv, public: { signing: pub(priv.signing), encryption: pub(priv.encryption) } };
  // Development servers read this to make package files.
  if (!cfg.production)
    fs.writeFileSync(path.join(cfg.dataDir, 'portal-public.json'), JSON.stringify(k.public, null, 2));
  return k;
}
