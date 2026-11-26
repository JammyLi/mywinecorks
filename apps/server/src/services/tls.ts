/**
 * Office-network HTTPS for self-hosted servers (ported from MyWines tls.js).
 * First start creates a local certificate authority (CA); a server certificate is then issued for this
 * computer's LAN addresses and re-issued when they change. A phone installs the CA once; after that the
 * camera scanner and offline mode (both need HTTPS) work on https://<lan-ip>:<httpsPort>.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';

// Only the office network: skip virtual adapters (VMs, Docker, VPN tunnels…).
const VIRTUAL =
  /^(bridge|vmnet|vboxnet|docker|br-|veth|virbr|utun|tun|tap|awdl|llw|anpi|ap\d|vEthernet|VirtualBox|VMware|Hyper-V|ZeroTier|tailscale|wg)/i;
export function lanAddresses(): string[] {
  // Docker and other containers see their own address; PUBLIC_IP names the host's office-network address(es).
  const fixed = (process.env.PUBLIC_IP ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
  if (fixed.length) return fixed;
  const all: string[] = [];
  const real: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      all.push(a.address);
      if (!VIRTUAL.test(name)) real.push(a.address);
    }
  return real.length ? real : all;
}

function keypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey),
    publicKey: forge.pki.publicKeyFromPem(publicKey),
  };
}
const serial = () => '01' + crypto.randomBytes(15).toString('hex');

export interface Tls {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
  caPath: string;
  fresh: boolean;
  ips: string[];
}

export function ensureTls(dir: string, ips = lanAddresses()): Tls {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n: string) => path.join(dir, n);
  let caCert: forge.pki.Certificate;
  let caKey: forge.pki.PrivateKey;
  if (fs.existsSync(f('ca.crt')) && fs.existsSync(f('ca.key'))) {
    caCert = forge.pki.certificateFromPem(fs.readFileSync(f('ca.crt'), 'utf8'));
    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(f('ca.key'), 'utf8'));
  } else {
    const k = keypair();
    caCert = forge.pki.createCertificate();
    caCert.publicKey = k.publicKey;
    caCert.serialNumber = serial();
    caCert.validity.notBefore = new Date(Date.now() - 86400e3);
    caCert.validity.notAfter = new Date(Date.now() + 10 * 365 * 86400e3);
    const attrs = [
      { name: 'commonName', value: `MyWineCorks Local CA (${os.hostname().replace(/[^\x20-\x7e]/g, '')})` },
      { name: 'organizationName', value: 'MyWineCorks' },
    ];
    caCert.setSubject(attrs);
    caCert.setIssuer(attrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    caCert.sign(k.privateKey, forge.md.sha256.create());
    caKey = k.privateKey;
    fs.writeFileSync(f('ca.crt'), forge.pki.certificateToPem(caCert));
    fs.writeFileSync(f('ca.key'), forge.pki.privateKeyToPem(caKey), { mode: 0o600 });
  }
  const host = os.hostname().replace(/\.local$/, '');
  const names = ['localhost', host, host + '.local'];
  const allIps = ['127.0.0.1', ...ips];
  const want = JSON.stringify({ names, ips: allIps });
  const have = fs.existsSync(f('server.json')) ? fs.readFileSync(f('server.json'), 'utf8') : '';
  let fresh = false;
  if (want !== have || !fs.existsSync(f('server.crt'))) {
    const k = keypair();
    const c = forge.pki.createCertificate();
    c.publicKey = k.publicKey;
    c.serialNumber = serial();
    c.validity.notBefore = new Date(Date.now() - 86400e3);
    c.validity.notAfter = new Date(Date.now() + 800 * 86400e3); // iPhone accepts at most 825 days
    c.setSubject([{ name: 'commonName', value: allIps[1] || host }]);
    c.setIssuer(caCert.subject.attributes);
    c.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [...names.map((value) => ({ type: 2, value })), ...allIps.map((ip) => ({ type: 7, ip }))],
      },
    ]);
    c.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
    fs.writeFileSync(f('server.crt'), forge.pki.certificateToPem(c));
    fs.writeFileSync(f('server.key'), forge.pki.privateKeyToPem(k.privateKey), { mode: 0o600 });
    fs.writeFileSync(f('server.json'), want);
    fresh = true;
  }
  return {
    key: fs.readFileSync(f('server.key')),
    cert: fs.readFileSync(f('server.crt')),
    ca: fs.readFileSync(f('ca.crt')),
    caPath: f('ca.crt'),
    fresh,
    ips,
  };
}
