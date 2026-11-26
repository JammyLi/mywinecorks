#!/usr/bin/env node
/**
 * MyWineCorks launcher (installed once; not replaced by in-app updates).
 *
 * Runs the newest of: the version that came with the installer / image (./app) and the version
 * installed by an in-app update (<DATA_DIR>/app/<version>, chosen in current.json). If an updated
 * version fails to start three times in a row, it goes back to the previous one. Exit code 75 from
 * the server means "updated — start the new version now".
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const appRoot = path.join(dataDir, 'app');
const curFile = path.join(appRoot, 'current.json');
const bundled = path.join(here, 'app');

const ver = (dir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
};
function cmp(a, b) {
  const split = (v) => {
    const [main, pre = ''] = v.split('-', 2);
    return { main: main.split('.').map((x) => Number(x) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.main[i] ?? 0) !== (y.main[i] ?? 0)) return (x.main[i] ?? 0) - (y.main[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) - (y.pre.length ? -1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    if (!np && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
const readCur = () => {
  try {
    return JSON.parse(fs.readFileSync(curFile, 'utf8'));
  } catch {
    return null;
  }
};
const writeCur = (c) => {
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(curFile, JSON.stringify(c, null, 2));
};

function pick() {
  const cur = readCur();
  const installed = ver(bundled);
  if (cur?.version) {
    const dir = path.join(appRoot, cur.version);
    const ok = fs.existsSync(path.join(dir, 'server.mjs'));
    if (ok && (cur.tries ?? 0) >= 3) {
      console.error(
        `[launcher] ${cur.version} did not start 3 times — going back to ${cur.previous ?? installed}`,
      );
      writeCur({
        version: cur.previous,
        previous: null,
        tries: 0,
        failed: cur.version,
        at: new Date().toISOString(),
      });
      return pick();
    }
    // A newer installer / image wins over an older in-app update.
    if (ok && cmp(cur.version, installed) > 0) {
      writeCur({ ...cur, tries: (cur.tries ?? 0) + 1 });
      return { dir, version: cur.version, updated: true };
    }
  }
  return { dir: bundled, version: installed, updated: false };
}

let stopping = false;
let child = null;
function start() {
  const { dir, version, updated } = pick();
  console.log(`[launcher] starting MyWineCorks ${version}${updated ? ' (updated)' : ''}`);
  child = fork(path.join(dir, 'server.mjs'), [], {
    cwd: dir,
    env: { ...process.env, DATA_DIR: dataDir, MWC_LAUNCHED: '1', NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  child.on('message', (m) => {
    if (m && m.mwc === 'ready' && updated) {
      const c = readCur();
      if (c && c.version === version) writeCur({ ...c, tries: 0 });
    }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === 75) return start(); // updated: start the new version right away
    // Anything else: let the service manager (Windows service / Docker restart policy) restart us.
    process.exit(code ?? (signal ? 1 : 0));
  });
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'])
  process.on(s, () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    else process.exit(0);
    setTimeout(() => process.exit(0), 10_000).unref();
  });
start();
