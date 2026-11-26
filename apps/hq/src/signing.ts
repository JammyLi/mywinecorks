/**
 * The license signing key (Ed25519) — the only thing that can create or extend a license.
 * Production: LICENSE_SIGNING_KEY from the secret store. Development: generated once into
 * data/license-signing.pem (git-ignored) with the public half in data/license-public.pem,
 * which development app servers trust automatically.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newKeyPair } from '@mwc/license';
import type { HqConfig } from './config.ts';

export interface Signing {
  privateKey: string;
  publicKey: string;
}

export function loadSigning(cfg: HqConfig): Signing {
  if (cfg.signingKey) {
    const pub = crypto.createPublicKey(cfg.signingKey).export({ type: 'spki', format: 'pem' }).toString();
    return { privateKey: cfg.signingKey, publicKey: pub };
  }
  if (cfg.production) throw new Error('LICENSE_SIGNING_KEY is required in production');
  const priv = path.join(cfg.dataDir, 'license-signing.pem');
  const pub = path.join(cfg.dataDir, 'license-public.pem');
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  if (!fs.existsSync(priv)) {
    const k = newKeyPair();
    fs.writeFileSync(priv, k.privateKey, { mode: 0o600 });
    fs.writeFileSync(pub, k.publicKey);
  }
  const privateKey = fs.readFileSync(priv, 'utf8');
  const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  if (!fs.existsSync(pub) || fs.readFileSync(pub, 'utf8') !== publicKey) fs.writeFileSync(pub, publicKey);
  return { privateKey, publicKey };
}
