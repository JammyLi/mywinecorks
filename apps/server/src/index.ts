import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { createApp } from './app.ts';
import { startLogPurger } from './routes/admin.ts';
import { express } from './http.ts';

const cfg = loadConfig();
const { app, registry } = createApp(cfg);

// Serve the built web app (apps/web/dist) when present; in development Vite serves it.
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

startLogPurger(registry);

app.listen(cfg.port, () => {
  const n = registry.list().length;
  console.log(
    `MyWineCorks server (${cfg.mode}) on http://localhost:${cfg.port} — ${n} workspace(s), data in ${cfg.dataDir}`,
  );
  if (n === 0) console.log('No workspace yet. Create one with: pnpm --filter @mwc/server create-tenant');
});
