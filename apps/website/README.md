# mywinecorks.com

Static website (Astro). Traditional Chinese at `/`, English at `/en/`.

- Development: `pnpm --filter @mwc/website dev` → http://localhost:4400 (also part of `pnpm dev`).
  Forms post to the local HQ (http://localhost:3700); requests appear in HQ › Website requests.
- Build: `pnpm --filter @mwc/website build` → `dist/` (any static host). Settings in `.env.example`.
- Strings: `src/i18n/{zh-TW,en}.ts` (same keys, checked by `pnpm test`); long texts (features, FAQ,
  legal) are in the page files, one block per language.
- Screenshots: `public/img/shots/{zh,en}/*.webp`, taken from the app with demo data.
