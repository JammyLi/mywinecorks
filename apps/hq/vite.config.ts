import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The HQ server serves this UI itself (Vite middleware in development, web/dist when built).
export default defineConfig({
  root: import.meta.dirname,
  publicDir: path.resolve(import.meta.dirname, '../web/public'),
  plugins: [react()],
  build: { outDir: 'web/dist', emptyOutDir: true },
});
