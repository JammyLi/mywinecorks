#!/usr/bin/env node
/**
 * Build a packaged MyWineCorks server for one platform (SPEC §10.2, §20.1 "compiled build").
 *
 *   node scripts/release/build.mjs --platform win-x64 --trust hq-public.pem [--trust old.pem] [--out release]
 *
 * Output in <out>/<platform>/:
 *   launcher.mjs            stays installed; picks the version to run (see installer/launcher.mjs)
 *   app/                    server.mjs (one bundled file), cli/*.mjs, web/ (pages), node_modules (native only)
 *   MyWineCorks-<ver>-<platform>.tar.gz   the app/ folder as an in-app update package
 *   node.exe                (win-x64 only) the Node runtime the installer ships
 *
 * Platforms: win-x64, linux-x64, linux-arm64, darwin-arm64. Native modules (SQLite, Argon2) are
 * the official prebuilt binaries for that platform and Node 22.
 */
import { execFileSync, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '../..');
const NODE_VERSION = '22.23.5'; // runtime shipped with the Windows installer (ABI 127)
const NODE_ABI = 127;
const PLATFORMS = {
  'win-x64': { sqlite: 'win32-x64', argon2: 'win32-x64-msvc' },
  'linux-x64': { sqlite: 'linux-x64', argon2: 'linux-x64-gnu' },
  'linux-arm64': { sqlite: 'linux-arm64', argon2: 'linux-arm64-gnu' },
  'darwin-arm64': { sqlite: 'darwin-arm64', argon2: 'darwin-arm64' },
};

const { values } = parseArgs({
  options: {
    platform: { type: 'string', default: `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}` },
    trust: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: path.join(ROOT, 'release') },
    'skip-web': { type: 'boolean', default: false },
  },
});
const platform = values.platform;
const plat = PLATFORMS[platform];
if (!plat) throw new Error(`Unknown platform ${platform}. Use one of: ${Object.keys(PLATFORMS).join(', ')}`);
const trusted = values.trust.map((f) => fs.readFileSync(f, 'utf8').trim());
if (!trusted.length) {
  console.error('Give the HQ public key the build should trust: --trust <hq-license-public.pem>');
  process.exit(1);
}
for (const k of trusted) if (!k.includes('BEGIN PUBLIC KEY')) throw new Error('--trust must be a PEM public key');

const version = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'packages/shared/src/version.ts'), 'utf8'))[1];
const OUT = path.join(path.resolve(values.out), platform);
const APP = path.join(OUT, 'app');
const CACHE = path.join(ROOT, 'release/.cache');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });
const step = (s) => console.log(`\n▸ ${s}`);

step(`MyWineCorks ${version} for ${platform}`);

// 1. Pages
if (!values['skip-web']) {
  step('Building the web app');
  execSync('pnpm --filter @mwc/web build', { cwd: ROOT, stdio: 'inherit' });
}
fs.cpSync(path.join(ROOT, 'apps/web/dist'), path.join(APP, 'web'), { recursive: true });

// 2. Server: one bundled, minified file per entry point. Only the native modules stay outside.
step('Bundling the server');
const banner = [
  "import { createRequire as __mwcReq } from 'node:module';",
  "import { fileURLToPath as __mwcUrl } from 'node:url';",
  "import { dirname as __mwcDir } from 'node:path';",
  'const require = __mwcReq(import.meta.url);',
  'const __filename = __mwcUrl(import.meta.url);',
  'const __dirname = __mwcDir(__filename);',
].join('\n');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  legalComments: 'none',
  external: ['better-sqlite3', '@node-rs/argon2'],
  banner: { js: banner },
  define: { __MWC_RELEASE__: 'true', __MWC_TRUSTED_KEYS__: JSON.stringify(trusted) },
  logLevel: 'warning',
};
await build({ ...common, entryPoints: [path.join(ROOT, 'apps/server/src/index.ts')], outfile: path.join(APP, 'server.mjs') });
for (const cli of ['reset-password', 'create-tenant'])
  await build({ ...common, entryPoints: [path.join(ROOT, `apps/server/src/cli/${cli}.ts`)], outfile: path.join(APP, `cli/${cli}.mjs`) });
fs.writeFileSync(
  path.join(APP, 'package.json'),
  JSON.stringify({ name: 'mywinecorks-server', version, private: true, type: 'module', main: 'server.mjs', platform }, null, 2),
);

// 3. Native modules for the target platform
step('Adding native modules');
const nm = path.join(APP, 'node_modules');
const srcNm = path.join(ROOT, 'apps/server/node_modules');
const real = (p) => fs.realpathSync(p);
const copyPkg = (from, to, files) => {
  fs.mkdirSync(to, { recursive: true });
  for (const f of files) if (fs.existsSync(path.join(from, f))) fs.cpSync(path.join(from, f), path.join(to, f), { recursive: true });
};
const bs3 = real(path.join(srcNm, 'better-sqlite3'));
const bs3v = JSON.parse(fs.readFileSync(path.join(bs3, 'package.json'), 'utf8')).version;
copyPkg(bs3, path.join(nm, 'better-sqlite3'), ['package.json', 'lib', 'LICENSE']);
const bindings = real(path.join(bs3, '..', 'bindings'));
copyPkg(bindings, path.join(nm, 'bindings'), ['package.json', 'bindings.js', 'LICENSE.md']);
copyPkg(real(path.join(bindings, '..', 'file-uri-to-path')), path.join(nm, 'file-uri-to-path'), ['package.json', 'index.js', 'LICENSE']);
const tgz = path.join(CACHE, `better-sqlite3-v${bs3v}-node-v${NODE_ABI}-${plat.sqlite}.tar.gz`);
if (!fs.existsSync(tgz))
  execFileSync('curl', ['-fsSL', '-o', tgz, `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bs3v}/better-sqlite3-v${bs3v}-node-v${NODE_ABI}-${plat.sqlite}.tar.gz`], { stdio: 'inherit' });
execFileSync('tar', ['-xzf', tgz, '-C', path.join(nm, 'better-sqlite3')]);

const a2 = real(path.join(srcNm, '@node-rs/argon2'));
const a2v = JSON.parse(fs.readFileSync(path.join(a2, 'package.json'), 'utf8')).version;
copyPkg(a2, path.join(nm, '@node-rs/argon2'), ['package.json', 'index.js', 'browser.js', 'LICENSE']);
const a2pkg = `@node-rs/argon2-${plat.argon2}`;
const a2tgz = path.join(CACHE, `node-rs-argon2-${plat.argon2}-${a2v}.tgz`);
if (!fs.existsSync(a2tgz)) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-pack-'));
  execFileSync('npm', ['pack', `${a2pkg}@${a2v}`, '--silent'], { cwd: tmp });
  fs.renameSync(path.join(tmp, fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'))), a2tgz);
}
const a2dir = path.join(nm, a2pkg);
fs.mkdirSync(a2dir, { recursive: true });
execFileSync('tar', ['-xzf', a2tgz, '-C', a2dir, '--strip-components=1']);

// 4. Launcher (+ Node for Windows)
fs.copyFileSync(path.join(ROOT, 'installer/launcher.mjs'), path.join(OUT, 'launcher.mjs'));
if (platform === 'win-x64') {
  step(`Adding Node ${NODE_VERSION} for Windows`);
  const exe = path.join(CACHE, `node-${NODE_VERSION}.exe`);
  if (!fs.existsSync(exe)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwc-node-'));
    execFileSync('npm', ['pack', `node-win-x64@${NODE_VERSION}`, '--silent'], { cwd: tmp });
    const t = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
    execFileSync('tar', ['-xzf', t, 'package/bin/node.exe'], { cwd: tmp });
    fs.renameSync(path.join(tmp, 'package/bin/node.exe'), exe);
  }
  fs.copyFileSync(exe, path.join(OUT, 'node.exe'));
}

// 5. Update package
step('Packing the update package');
const pkg = path.join(OUT, `MyWineCorks-${version}-${platform}.tar.gz`);
execFileSync('tar', ['-czf', pkg, '-C', APP, '.']);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(pkg)).digest('hex');
fs.writeFileSync(path.join(OUT, 'release.json'), JSON.stringify({ version, platform, file: path.basename(pkg), sha256, size: fs.statSync(pkg).size }, null, 2));
console.log(`\n✓ ${OUT}\n  ${path.basename(pkg)}  ${(fs.statSync(pkg).size / 1e6).toFixed(1)} MB  sha256 ${sha256.slice(0, 16)}…`);
