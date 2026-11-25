# MyWineCorks

AI cellar management and private sales for wine collectors — MyWineCorks.com
Launch markets: Taiwan and the United States (Traditional Chinese / English).

- `docs/SPEC.md` — product specification
- `docs/BUILD-PLAN.md` — architecture, milestones, local setup
- `CLAUDE.md` — rules for building with Claude Code
- `brand/MyWineCorks Logo Directions.zip` — official logo set (direction 1d)

## Run it on your Mac

Needs Node 22 and pnpm (`brew install node@22 pnpm`).

```bash
pnpm install
cp apps/server/.env.example apps/server/.env     # self-hosted mode, data in apps/server/data

# Create your workspace (once) — prints a one-time setup link for the Owner
pnpm --filter @mwc/server create-tenant --slug my-cellar --name "我的酒窖" --owner you@example.com

pnpm dev          # server on :3000 + web app on :5173
```

Open the setup link, choose a password, then sign in at http://localhost:5173.
To try cloud mode (workspace field on sign-in, 2-step verification required for Owner/Admin),
set `MODE=cloud` in `apps/server/.env`.

Other commands: `pnpm test` (all tests), `pnpm typecheck`, `pnpm --filter @mwc/web build`
(after a build, `pnpm --filter @mwc/server start` serves the app on :3000 by itself).

## Status

| Milestone | State |
|---|---|
| M0 Foundations — sign-in, 2-step verification, custom roles, users, change log, brand, zh-TW/en | ✅ done |
| M1 Inventory core | next |
