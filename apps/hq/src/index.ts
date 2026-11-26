import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createHq, ensureFirstAdmin } from './app.ts';
import { loadConfig } from './config.ts';
import { startJobs } from './jobs.ts';

const cfg = loadConfig();
const { app, sql } = await createHq(cfg);

// Pages: built UI (web/dist) when present, otherwise Vite in middleware mode (development).
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'web/dist');
if (fs.existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: { port: 24700 } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

const link = await ensureFirstAdmin(cfg, sql);
startJobs(cfg, sql);
app.listen(cfg.port, () => {
  console.log(
    `MyWineCorks HQ on ${cfg.publicUrl} (${cfg.databaseUrl ? 'PostgreSQL' : 'embedded PostgreSQL in ' + cfg.dataDir})`,
  );
  if (link) {
    fs.writeFileSync(path.join(cfg.dataDir, 'setup-link.txt'), link + '\n', { mode: 0o600 });
    console.log(
      `\nFirst Super Admin ${cfg.firstAdmin}: set the password and 2-step verification here (valid 7 days):\n${link}\n`,
    );
  }
});
