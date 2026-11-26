import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import httpProxy from 'http-proxy';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { express } from './http.ts';
import { startLogPurger } from './routes/admin.ts';
import { ensureTls, lanAddresses, type Tls } from './services/tls.ts';

const cfg = loadConfig();
const { app, registry, licensing } = createApp(cfg);

// Pages: the built web app (apps/web/dist) when present; otherwise (development) forward to Vite,
// so phones on the HTTPS port get the same app. API requests never reach this.
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
const dev = !fs.existsSync(path.join(webDist, 'index.html'));
const proxy = dev
  ? httpProxy.createProxyServer({ target: cfg.webDevUrl, ws: true, changeOrigin: false })
  : null;
proxy?.on('error', (_e, _req, res) => {
  if (res && 'writeHead' in res && !res.headersSent)
    res.writeHead(502).end('Web app is starting… reload in a moment.');
});
if (!dev) {
  app.use(express.static(webDist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}
const pages = (req: http.IncomingMessage, res: http.ServerResponse) => {
  if (proxy && !req.url?.startsWith('/api/')) return proxy.web(req, res);
  app(req as never, res as never);
};

startLogPurger(registry);
licensing.start();

const busy = (port: number) => (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(
    `\nPort ${port} is already in use by another program (maybe MyWineCorks is already running).`,
  );
  console.error('Stop that program, or set another port in apps/server/.env (PORT / HTTPS_PORT).\n');
  process.exit(1);
};

let tls: Tls | null = null;
if (cfg.mode === 'selfhost' && cfg.httpsPort) {
  try {
    tls = ensureTls(path.join(cfg.dataDir, 'tls'));
  } catch (e) {
    console.error('Could not create the HTTPS certificate:', (e as Error).message);
  }
}

const plain = http.createServer(pages).on('error', busy(cfg.port));
if (proxy) plain.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
plain.listen(cfg.port, () => {
  const n = registry.list().length;
  console.log(
    `MyWineCorks server (${cfg.mode}) on http://localhost:${cfg.port} — ${n} workspace(s), data in ${cfg.dataDir}`,
  );
  if (n === 0) console.log('No workspace yet. Create one with: pnpm --filter @mwc/server create-tenant');
  if (!tls) return;
  const srv = https.createServer({ key: tls.key, cert: tls.cert }, pages).on('error', busy(cfg.httpsPort));
  if (proxy) srv.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head));
  srv.listen(cfg.httpsPort, () => {
    for (const ip of lanAddresses()) {
      console.log(`Phones (scan, offline):  https://${ip}:${cfg.httpsPort}/m`);
      console.log(`Phone setup, first time: http://${ip}:${cfg.port}/phone`);
    }
    if (tls!.fresh) console.log('(New HTTPS certificate issued for the current office-network address.)');
  });
});
