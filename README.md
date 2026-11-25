# MyWineCorks

AI cellar management and private sales for wine collectors — MyWineCorks.com
Launch markets: Taiwan and the United States (Traditional Chinese / English).

- `docs/SPEC.md` — product specification
- `docs/BUILD-PLAN.md` — architecture, milestones, local setup
- `CLAUDE.md` — rules for building with Claude Code
- `brand/MyWineCorks Logo Directions.zip` — official logo set (direction 1d)

## Run it on your Mac

In Terminal, in this folder:

```bash
./scripts/setup-mac.sh     # first time: installs Node 22 + pnpm if needed, creates your workspace, starts the app
./scripts/start.sh         # every time after that
```

The first run asks for your company name, workspace id and Owner email, then opens your
one-time setup link in the browser. Choose a password and you are in.
The app runs at http://localhost:5500 (phones on the same Wi-Fi: http://<Mac IP>:5500).
Stop it with Ctrl+C. Your data is in `apps/server/data/` — back it up by copying that folder.

**Ports:** the server uses 3500 and the web app 5500 (MyWines uses 3000/3200). `start.sh` moves older
settings automatically and tells you if another program is using a port.

**Forgotten password:** an Owner/Admin can create a reset link in Settings › Users. If the Owner is
locked out: `./scripts/reset-password.sh you@example.com` prints a reset link. To email reset links
from the sign-in page instead, set `SMTP_URL` in `apps/server/.env`.

Manual steps, if you prefer: `pnpm install`, copy `apps/server/.env.example` to `.env`,
`pnpm --filter @mwc/server create-tenant --slug my-cellar --name "我的酒窖" --owner you@example.com`, `pnpm dev`.
Set `MODE=cloud` in `apps/server/.env` to try cloud mode (workspace field on sign-in,
2-step verification required for Owner/Admin).

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm --filter @mwc/web build`
(after a build, `pnpm --filter @mwc/server start` serves everything on :3500).

## Status

| Milestone | State |
|---|---|
| M0 Foundations — sign-in, 2-step verification, custom roles, users, change log, brand, zh-TW/en | ✅ done |
| M1 Inventory core — storage, wines, stock, search, moves, stock-out, prices, Excel import | 🟡 in progress (lists, labels, photos, stocktakes next) |
