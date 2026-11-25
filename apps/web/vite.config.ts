import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Use the same server port as apps/server/.env (default 3500). */
function serverPort(): number {
  try {
    const env = fs.readFileSync(path.resolve(import.meta.dirname, '../server/.env'), 'utf8');
    const m = env.match(/^PORT=(\d+)/m);
    if (m) return Number(m[1]);
  } catch {}
  return 3500;
}

/** Writes dist/sw.js listing every built file, so the phone app opens offline (ported from MyWines). */
function serviceWorker(): Plugin {
  return {
    name: 'mwc-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const pub = fs.readdirSync(path.resolve(import.meta.dirname, 'public')).map((f) => '/' + f);
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map')).map((f) => '/' + f);
      const assets = ['/', ...new Set([...files.filter((f) => f !== '/index.html'), ...pub])];
      const tpl = fs.readFileSync(path.resolve(import.meta.dirname, 'pwa/sw-template.js'), 'utf8');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: tpl.replace('__VERSION__', Date.now().toString(36)).replace('__ASSETS__', JSON.stringify(assets)),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5500,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${serverPort()}`, changeOrigin: false } },
  },
  preview: { port: 5500 },
});
