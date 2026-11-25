# MyWineCorks — notes for Claude Code

AI cellar management and private sales for wine collectors (MyWineCorks.com).
Launch markets: Taiwan and the US. Built by Jammy with Claude Code.

## Source of truth
- `docs/SPEC.md` — what to build (section numbers like §20 refer to it). Do not change
  product behaviour without updating the spec's decisions log.
- `docs/BUILD-PLAN.md` — architecture, stack, repo layout, milestones (M0–M10), local setup.
- Reference implementation: **MyWines v0.1.8** at
  `/Users/jammy9422/Documents/Getfocus/AIProjs/ai_products/mywines` (read-only; still in
  daily use by the first client — never modify it). Port logic and tests from it; keep its
  screen structure and flows.

## Stack
TypeScript · Node 22 · Express 5 · SQLite (better-sqlite3, one file per tenant) + Drizzle ·
PostgreSQL for cloud services · React 19 + Vite (PWA) · Astro (website) · pnpm workspaces ·
Vitest + Playwright.

## Layout
`apps/` server, web, portal, portal-service, hq, ai-gateway, website ·
`packages/` shared, ui, license, migrate-mywines · `installer/` · `docs/`.

## Rules
- **Permissions are enforced in the API**, never only in the UI. Every new endpoint gets a
  permission check and a test that it is denied without that permission.
- Respect data-visibility permissions: purchase cost, profit, merchants and customer
  prices only for roles allowed to see them — including in exports, PDFs, AI answers and
  data sent to phones.
- **Audit log is append-only.** Every change to inventory, prices, orders, settings,
  users or roles writes an audit entry (who, when, before/after, reason).
- The customer portal never receives cost, margin, merchants, locations, bottle/case
  numbers, other customers or their prices (§9.3).
- Keep MyWines bottle/case/wine number formats so existing printed labels keep working.
- All user-facing text goes through i18n with **zh-TW and en** keys; no hard-coded strings.
- Money stored as integer minor units with a currency code; dates stored in ISO format, UTC.
- Self-hosted servers only make outbound connections to cloud services.
- Secrets only in `.env` (never committed). No default passwords in code; first accounts
  are created by one-time setup links.
- AI never changes data without a user action; show the source of every AI suggestion.

## Brand
Logo set: `brand/MyWineCorks Logo Directions.zip` (direction 1d). Colors: burgundy
`#5e1a24`, gold `#b68235` / `#d4a560` on dark, cork `#e6d2ac`, ink `#201f1d`,
paper `#f3f2f2`, night `#1b1a18`. Fonts: Cormorant Garamond, Lora, Noto Sans/Serif TC.

## Working
- Commands: `pnpm install`, `pnpm dev` (all services), `pnpm test`, `pnpm lint`.
- Work milestone by milestone (BUILD-PLAN §5); one branch per task, PR into `main`.
- Update `CHANGELOG.md` at the end of each milestone.
