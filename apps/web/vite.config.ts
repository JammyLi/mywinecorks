import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
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

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5500,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${serverPort()}`, changeOrigin: false } },
  },
  preview: { port: 5500 },
});
