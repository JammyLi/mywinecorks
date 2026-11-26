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

**Phones:** on the same Wi-Fi, open `http://<Mac IP>:3500/phone` on the phone once and follow the
steps (install the office certificate). Then use `https://<Mac IP>:5543/m` — camera scanning, and it
keeps working in the cellar with no signal; changes sync when the phone is back on the Wi-Fi.
`start.sh` prints both addresses. A fixed IP for the Mac is best.

**Moving from MyWines:** the move needs an empty workspace (same currency as MyWines, TWD).
To start over, stop the app, rename `apps/server/data` to keep it as a backup, and run `./start.sh`
again to create a fresh workspace. Then:

```bash
./scripts/migrate-mywines.sh --user jammy=you@example.com:owner --user larry=larry@example.com:employee
```

That is a dry run: it imports everything, checks it, prints a report and saves nothing. When it looks
right, stop MyWines and run the same command with `--commit`. Bottle, case and wine numbers and the
locker/rack ids stay the same, so labels already printed by MyWines keep scanning. Each MyWines user you
list gets a link to set a new password (an email that already exists, like the Owner, is linked
instead). MyWines' files are copied first and only the copy is read. Customers and orders come over
with the orders release (M4); a copy of the MyWines database is kept in the workspace for that.

Manual steps, if you prefer: `pnpm install`, copy `apps/server/.env.example` to `.env`,
`pnpm --filter @mwc/server create-tenant --slug my-cellar --name "我的酒窖" --owner you@example.com`, `pnpm dev`.
Set `MODE=cloud` in `apps/server/.env` to try cloud mode (workspace field on sign-in,
2-step verification required for Owner/Admin).

**License (development):** a new installation runs a 14-day trial. `pnpm dev` / `start.sh` also run
MyWineCorks HQ at http://localhost:3700. The first time, open the setup link printed in the
Terminal (also saved in `apps/hq/data/setup-link.txt`), set a password and 2-step verification,
add a client, a subscription and "Issue license key", then paste the key in the app under
Settings › License. HQ's signing key is created in `apps/hq/data/` (never committed). Lost the
HQ setup link? `pnpm --filter @mwc/hq create-admin you@example.com` prints a new one.

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm --filter @mwc/web build`
(after a build, `pnpm --filter @mwc/server start` serves everything on :3500).

## Status

| Milestone | State |
|---|---|
| M0 Foundations — sign-in, 2-step verification, custom roles, users, change log, brand, zh-TW/en | ✅ done |
| M1 Inventory core — storage, wines, stock, search, moves, stock-out, prices, Excel import, lists, labels, photos, stocktakes | ✅ done |
| M2 MyWines migration | ✅ done |
| M3 Phone app + offline | ✅ done (field test pending) |
| M4 Customers, orders, reports | ✅ done |
| M5 Licensing + HQ | ✅ done |
| M6 Packaging (installer, updates, backups), cloud | next |
