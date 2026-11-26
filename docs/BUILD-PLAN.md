# MyWineCorks — Release 1 Build Plan

**Version:** 0.1 · **Date:** 2026-11-25 · Companion to `SPEC.md` (section numbers below refer to it)

---

## 1. Architecture

```
                          mywinecorks.com (cloud)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  website (marketing)     hq (HQ back office)     license/check-in API │
 │                                                                      │
 │  portal (customer web)  ◄── portal-service ──►  ai-gateway (Claude)  │
 │                                ▲    ▲                   ▲            │
 │  cloud app (multi-tenant) ─────┘    │                   │            │
 │   one SQLite file per client        │                   │            │
 └─────────────────────────────────────┼───────────────────┼────────────┘
                                       │ outbound HTTPS only
 Client's office (self-hosted)         │                   │
 ┌─────────────────────────────────────┴───────────────────┴──────┐
 │  app server (single tenant, same code as cloud app)            │
 │  SQLite + photos   ·   staff web (laptop/tablet)   ·  mobile PWA│
 └────────────────────────────────────────────────────────────────┘
```

- **One app server codebase** runs in two modes: `MODE=cloud` (many tenants, one database
  file each) or `MODE=selfhost` (one tenant). Everything a client uses daily lives here.
- **Cloud-only services** (portal-service, ai-gateway, license API, HQ) are what a licence
  unlocks (§20.1). Self-hosted servers only ever connect *out* to them.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** everywhere | Same as MyWines (JS) but safer for a larger team/codebase |
| App server | Node 22 + Express 5 (or Fastify) | MyWines stack; easy reuse |
| Client database | **SQLite** (better-sqlite3), one file per tenant, plain SQL migrations | Same in cloud and self-hosted; simple backup; MyWines migration is file-to-file |
| Cloud databases | PostgreSQL for HQ, licences, portal-service | Shared, multi-client data |
| Staff web + mobile | React 19 + Vite, PWA, React Router | MyWines stack; reuse screens, scanner, offline store |
| Customer portal | React + Vite (separate app, own build) | Never ships staff code to customers |
| Website | Astro (static, zh-TW / en) | Fast, SEO-friendly, simple |
| Auth | Argon2 passwords, TOTP 2-step, server sessions | §12 |
| AI | Claude API via ai-gateway (vision for labels/invoices, structured output) | §11; keys never on client servers |
| Licence signing | Ed25519 (`@noble/ed25519`) | §20 |
| Backups (cloud) | Litestream → object storage | Continuous SQLite backup, point-in-time restore |
| Packaging | Node single-executable + NSIS Windows service (as MyWines); Docker image | §10.2, §20.1 compiled build |
| Hosting | One cloud provider, regions for Taiwan (Tokyo/Taipei) and US | Decide in M0 |
| Tests | Vitest (unit), Playwright (web + mobile flows) | |
| CI/CD | GitHub Actions: test, build, sign releases | |

## 3. Repository layout (monorepo, pnpm workspaces)

```
mywinecorks/
├─ apps/
│  ├─ server/          app server (cloud + self-host modes), API, sync, licence client
│  ├─ web/             staff back office + mobile PWA (/m)
│  ├─ portal/          customer portal frontend
│  ├─ portal-service/  cloud API for portals, sync endpoint
│  ├─ hq/              HQ back office (frontend + API)
│  ├─ ai-gateway/      cloud AI proxy, usage metering
│  └─ website/         mywinecorks.com marketing site
├─ packages/
│  ├─ shared/          types, permission catalogue, validation, money/date utils
│  ├─ ui/              design system: brand tokens (§16), components, zh-TW/en i18n
│  ├─ license/         key format, sign (HQ only) / verify (everywhere)
│  └─ (MyWines importer lives in apps/server/src/services/mywines.ts)
├─ installer/          Windows (NSIS), Docker
├─ docs/               SPEC.md, BUILD-PLAN.md, decisions
└─ .github/workflows/
```

## 4. Reuse from MyWines

| MyWines part | Reuse plan |
|---|---|
| `schema.sql` (cellars → bottles, lots, price history, orders, audit) | Basis for the new schema; add tenant, roles, catalogs, condition fields, currency |
| `src/offline/store.js`, `m/Scanner.jsx`, `m/MobilePages.jsx` | Port to TS; keep op-log + conflict design |
| `server/orders.js` (reserve / swap-on-scan / ship) | Port logic and its tests |
| `server/importer.js` (Excel merge suggestions) | Port |
| Labels / print pages, PDF layouts | Port; restyle to new brand |
| `server/tls.js` (local CA for phones) | Reuse; simplify setup flow |
| UI screens & navigation | Same structure and flows; new design system |
| Tests (`test/*.test.js`) | Port as regression tests — same behaviour expected |

## 5. Milestones

Sizes: S ≈ 1–2 weeks, M ≈ 2–4 weeks, L ≈ 4–6 weeks (one full-stack developer with AI
assistance; scale with team).

| # | Milestone | Content | Done when | Size |
|---|---|---|---|---|
| **M0** ✅ | Foundations | Monorepo, CI, design system + brand, zh-TW/en, tenant model, auth + 2-step, **custom roles/permissions**, audit log, settings shell | Owner signs in, creates roles and users; permission checks enforced in API with tests | M |
| **M1** ✅ | Inventory core | Cellars/lockers/racks/cases, wines, lots, bottles, prices & history, search & filters, moves, stock-out, stocktake, labels, Excel import/export | All MyWines inventory tests pass against the new server | L |
| **M2** ✅ | **MyWines migration** | Importer with dry-run report; keeps bottle/case/wine numbers | Brother's real database imports cleanly; spot-check 50 bottles; labels scan correctly | S |
| **M3** ✅ (field test pending) | Mobile + offline | PWA, scanner, offline lookup/move/stock-out/stocktake/pick, sync + conflicts | Field test in a real cellar with no signal | M |
| **M4** ✅ | Orders | Draft → confirm/reserve → pick list → scan-to-ship; payment status; PDFs; reports (value, profit) | MyWines order tests pass; full order done on phone | M |
| **M5** ✅ | Licensing + HQ basic | Licence package, check-in API, limits, grace + strict lock, server binding; HQ: clients, subscriptions (manual), licences, installations, releases, support access, HQ staff (first Super Admin jammy.li@getfocus.com) | Issue key in HQ → self-host install activates → expiry locks → renewal unlocks | M |
| **M6** ✅ | Packaging + updates | Compiled build, Windows installer, Docker image, in-app update with pre-update backup; cloud provisioning + Litestream | Clean install on Windows and Docker; cloud workspace created from HQ | S |
| **M7** ✅ | Catalogs + portal | Catalogs, customer groups, price rules; portal app; invitations/revoke; order requests; portal-service; outbound sync; package-file fallback; TW/US compliance | Self-hosted client publishes catalog; customer requests order; it appears as draft; revoke is instant | L |
| **M8** | AI | ai-gateway + metering; label photo, invoice to stock, NL search, drinking windows, cellar Q&A, price suggestion, order from message, suggestions, portal NL search; per-feature switches | Each feature has an accuracy test set (e.g. 100 real labels ≥ 90% correct fields) | L |
| **M9** | Website | Marketing pages zh/en, pricing ("contact us"), demo/trial request → HQ leads, client download area | Live on mywinecorks.com | S |
| **M10** | Hardening + beta | Security review, load test (100k bottles), backup/restore drills, docs & user manual zh/en, beta with first client | First client runs on MyWineCorks; MyWines retired | M |

Order and parallel work:
```
M0 → M1 → M2 → M3 → M4 ─┬─→ M7 ─┬─→ M10
                         ├─→ M5 → M6 ┤
                         └─→ M8 ─────┤
                              M9 ────┘ (any time after M0 design system)
```
Total ≈ 8–11 months for one developer with Claude Code (the chosen setup); milestones run
in sequence, M9 can slot in whenever a break from the app is useful.

## 6. M0 — first tasks

1. Set up monorepo (pnpm, TypeScript, ESLint/Prettier, Vitest, GitHub Actions).
2. `packages/ui`: brand tokens from logo set 1d (burgundy, gold, cork, ink, paper, night;
   Cormorant Garamond / Lora / Noto TC), light + dark theme, base components (button,
   input, table, dialog, toast, tabs, bottom nav), i18n with zh-TW and en.
3. `packages/shared`: permission catalogue (§2.2 four dimensions), role templates.
4. `apps/server`: tenant registry, per-tenant SQLite with Drizzle migrations, auth
   (Argon2 + TOTP), sessions, permission middleware, append-only audit log.
5. `apps/web`: app shell (sidebar desktop / bottom tabs mobile, as MyWines), sign-in,
   2-step setup, Settings › Users & Roles (role editor with permission matrix).
6. Tests: permission matrix (every endpoint denies without permission), audit immutability.

## 7. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Team | **Jammy + Claude Code** (one developer with AI) — use the one-developer estimates |
| 2 | Environment | **Local dev environment on Jammy's Mac first**; cloud provider chosen later (before M6; default AWS Tokyo + US-West) |
| 3 | Domain/DNS & email sending | Open — needed by M5 (emails) / M9 (website). Default: Cloudflare DNS + Postmark or SES |
| 4 | Claude API account for ai-gateway | **Getfocus account**, separate key per environment (dev key in local `.env`, never committed) |
| 5 | Code-signing certificate for Windows installer | Buy before M6 |

## 7a. Local development environment (Mac)

| Need | Tool |
|---|---|
| Node 22 LTS + pnpm | `brew install node@22 pnpm` (or nvm) |
| PostgreSQL (HQ, licences, portal-service) | Docker Desktop running `postgres:16` via `docker compose`, or Postgres.app |
| SQLite | built in via better-sqlite3 (no install) |
| Mail testing | Mailpit in docker compose (catches all outgoing email locally) |
| HTTPS for phone testing | App server's local CA (from MyWines `tls.js`), same as MyWines |
| Secrets | `.env` per app from `.env.example`; Claude API key only in `apps/ai-gateway/.env` |

All cloud services (portal-service, ai-gateway, HQ, license API, website) run locally on
separate ports during development, so the full self-hosted ↔ cloud flow can be tested on one
Mac. One command — `pnpm dev` — starts everything. Ports avoid 3000/3200/5173, which MyWines
and other common tools use.

| Service | Local URL |
|---|---|
| app server (API) | http://localhost:3500 · phones: https://<Mac IP>:3543 |
| staff web (dev) | http://localhost:5500 |
| portal | http://localhost:3600 |
| portal-service | http://localhost:3601 |
| hq | http://localhost:3700 |
| license API (in hq) | http://localhost:3700/api/license |
| ai-gateway | http://localhost:3800 |
| website | http://localhost:4500 |
| Mailpit | http://localhost:8025 |

## 8. Ways of working
- Branch per milestone task, pull request into `main`, CI must pass.
- Every milestone ends with a short demo and an updated `CHANGELOG.md`.
- `docs/SPEC.md` is the source of truth; changes go through its decisions log.
