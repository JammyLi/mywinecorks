#!/usr/bin/env node
/**
 * Clean-install check for a packaged server (Windows installer, Docker image):
 *   node scripts/release/smoke.mjs <base-url> <first-run.txt | first-run URL | --existing>
 * Waits for the server, completes first-run (company + Owner), sets the Owner password through the
 * setup link and signs in. With --existing it only checks that the Owner from an earlier run can
 * still sign in (upgrade / restart keeps the data).
 */
import fs from 'node:fs';

const [base, arg] = process.argv.slice(2);
const EMAIL = 'owner@example.com';
const PASSWORD = 'Smoke-test-password-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, body, cookie) => {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, cookie: r.headers.get('set-cookie')?.split(';')[0] };
};
const must = (cond, msg) => {
  if (!cond) {
    console.error('✗ ' + msg);
    process.exit(1);
  }
  console.log('✓ ' + msg);
};

let health;
for (let i = 0; i < 90; i++) {
  try {
    health = (await call('/api/health')).data;
    if (health.ok) break;
  } catch {
    /* starting */
  }
  await sleep(1000);
}
must(health?.ok, `server answers (${JSON.stringify(health)})`);
const page = await fetch(base + '/login');
must(page.ok && (await page.text()).includes('<div id="root">'), 'pages are served');

if (arg !== '--existing') {
  const fr = (await call('/api/public/first-run')).data;
  must(fr.needed === true, 'new server asks for first-run setup');
  let link = arg;
  for (let i = 0; i < 30 && !link.startsWith('http'); i++) {
    if (fs.existsSync(arg)) link = fs.readFileSync(arg, 'utf8').trim();
    else await sleep(1000);
  }
  const t = new URL(link).searchParams.get('t');
  must(!!t, 'first-run link found');
  const made = await call('/api/public/first-run', { t, company: 'Smoke Test Cellar', ownerEmail: EMAIL, ownerName: 'Owner', lang: 'en' });
  must(made.status === 200, `workspace created (${made.status} ${JSON.stringify(made.data)})`);
  const q = new URLSearchParams(made.data.setup.split('?')[1]);
  const setup = await call('/api/auth/setup', { workspace: q.get('w'), token: q.get('t'), password: PASSWORD });
  must(setup.status === 200, 'Owner password set');
}
const login = await call('/api/auth/login', { email: EMAIL, password: PASSWORD, client: 'web' });
must(login.status === 200, `Owner signs in (${login.status} ${login.data.error ?? ''})`);
const me = await call('/api/me', undefined, login.cookie);
must(me.data.role?.isOwner === true, 'session works');
must(me.data.license?.state === 'trial', `license state is trial (${me.data.license?.state})`);
console.log('\nSmoke test passed for ' + base);
