import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The customer portal: its own build, so no staff code ever reaches customers (BUILD-PLAN §2).
export default defineConfig({
  root: import.meta.dirname,
  publicDir: path.resolve(import.meta.dirname, '../web/public'),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
