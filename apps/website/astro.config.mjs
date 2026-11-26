import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static site: zh-TW at /, English at /en/. SITE sets the canonical address (production default).
export default defineConfig({
  site: process.env.SITE || 'https://mywinecorks.com',
  trailingSlash: 'always',
  build: { format: 'directory' },
  server: { port: 4400 },
  integrations: [
    sitemap({
      i18n: { defaultLocale: 'zh', locales: { zh: 'zh-TW', en: 'en' } },
      filter: (p) => !p.includes('/account/') && !p.includes('/404'),
    }),
  ],
});
