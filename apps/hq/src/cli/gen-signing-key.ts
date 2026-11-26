/** Create the production license/update signing key pair (see installer/keys/README.md). */
import fs from 'node:fs';
import path from 'node:path';
import { newKeyPair } from '@mwc/license';

const dir = process.argv[2];
if (!dir) {
  console.error('Usage: pnpm --filter @mwc/hq gen-signing-key <folder outside the repository>');
  process.exit(1);
}
const repo = path.resolve(import.meta.dirname, '../../../..');
const out = path.resolve(dir);
if (out.startsWith(repo)) {
  console.error('Choose a folder outside the repository: the private key must never be committed.');
  process.exit(1);
}
const priv = path.join(out, 'license-signing.pem');
if (fs.existsSync(priv)) {
  console.error(`${priv} already exists.`);
  process.exit(1);
}
const k = newKeyPair();
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(priv, k.privateKey, { mode: 0o600 });
const pub = path.join(repo, 'installer/keys/hq-license-public.pem');
fs.writeFileSync(pub, k.publicKey);
console.log(
  `Private key: ${priv}\n  → put it in the HQ secret store as LICENSE_SIGNING_KEY, then delete this file.`,
);
console.log(`Public key:  ${pub}\n  → commit it; release builds trust it.`);
