import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createPortal } from './app.ts';
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const { app } = await createPortal(cfg);

// The customer portal pages (apps/portal): built files when present, otherwise Vite (development).
const root = path.resolve(import.meta.dirname, '../../portal');
const dist = path.join(root, 'dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { port: 24701 } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
app.listen(cfg.port, () => console.log(`MyWineCorks portal service on ${cfg.publicUrl}`));
