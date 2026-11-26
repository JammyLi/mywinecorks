# Changelog

## 0.5.0 — M5 Licensing + HQ (2026-11-26)
- License keys (`MWC1.…`, signed by HQ) carry the client, plan, modules, limits, expiry and grace
  period. Settings › License (Owner): paste a key or upload the `.mwclicense` file, check in now,
  usage against the limits, installation ID, and "Export my data" (Excel or the database file).
- New installations run a 14-day trial. The first activation binds the key to this server through
  HQ; the same key on a second server is refused. A daily check-in picks up renewals, plan changes,
  revocations and update notices (only license id, installation, version and counts are sent).
- Banners for trial, expiring soon, grace period and late check-in. When locked (trial over,
  expired after the grace period, 30 days without check-in, revoked) only the Owner can sign in,
  to the License screen and exports; staff and phones see a lock screen. Nothing is deleted.
- Limits: warning at 90 %, new bottles / orders / users blocked at 100 %.
- MyWineCorks HQ (`apps/hq`, port 3700): sign-in with required 2-step verification; clients
  (MWC-0001), subscriptions and payments entered by hand; issue / renew / grace / revoke / move
  licenses, download or email the key; installations with alerts (duplicate key, hardware changed,
  no check-in); releases with update notices; HQ staff and roles; dashboard (renewals due in
  30/60/90 days, alerts, clients near their limits); append-only audit log; renewal reminder emails
  30/14/7/1 days before expiry (zh-TW / en).
- `pnpm dev` now also runs HQ; development servers trust the development HQ's key automatically.

## 0.4.0 — M4 Orders (2026-11-26)
- Customers (C-0001 numbers like MyWines): person/company, tax ID, document language, default
  discount, delivery addresses, active/inactive; customer page with orders, amount bought and the
  prices they paid per wine.
- Orders (SO-YYYYMMDD-NNN): create from search results, a list, a wine page, a customer or blank;
  lines with quantity, unit price and discount; tax rate and shipping; default price is the
  customer's last price → suggested price → market price + markup (shown next to each price).
- Confirm holds specific bottles (loose bottles first, then fullest cases); back to draft or cancel
  (with a reason) releases them. Pick list (by location, with an ORDER: QR code) and customer copy
  in the order's language, printable as PDF.
- Pick / ship / hand over by scanning — on the desktop or on the phone (`/m/orders`): another bottle
  of the same wine replaces a held one, a wrong wine or another order's bottle is refused; a whole
  case can be scanned; or ship the held bottles directly.
- Invoice number, payments (transfer, cash, card, cheque; partial; refunds; void with a reason);
  shipped + fully paid closes the order; a void reopens it.
- Role rules: confirm limit per role, customer prices / cost / margin only for roles that may see
  them (including payments and exports), "see other users' orders"; deleting a draft order, a
  customer without orders or an address is Owner-only.
- Reports: collection value now and over 12 months, unrealized gain by type / country / region /
  cellar / locker / wine, storage rent vs value, and realized sales profit by month / customer / wine.
- Settings › Company: names, address, tax ID, default tax rate, order markup, payment instructions.
- Orders Excel export (orders + lines). Wine page shows "New order".
- MyWines migration now brings customers, addresses and orders too (with held bottles); bottles keep
  the date their wine was entered.

## 0.3.0 — M3 Phone app + offline (2026-11-25)
- Phone screens at `/m` (ported from MyWines): scan / look up, bottle, case, locker, wine, move
  (bottles, whole case, into a new case), stock-out with reason, scan to a list, stocktake, search,
  sync status and conflicts. Camera scanning (BarcodeDetector, jsQR fallback) or typed codes;
  MyWines QR formats.
- Works with no signal: the phone keeps a copy of the stock (IndexedDB) and a queue of changes;
  they sync automatically when back online. Each change is applied once (retries are safe) and
  the change log records the time it was made on the phone. If someone else changed the same
  bottle or case meanwhile, the phone shows a conflict: keep mine / keep the server's.
- The phone copy follows the role: only the cellars it may see, market price only with price
  access, never cost, merchants, customers or settings; cleared on sign-out or when another person
  signs in. Phones sign in as "mobile"; Picker-type roles go straight to the phone app.
- Installable app (manifest + service worker) that opens offline.
- Self-hosted HTTPS for phones on the office Wi-Fi: a local certificate authority is created on
  first start, the server certificate follows the computer's address; `/phone` guides installing
  it on iPhone / Android (zh-TW / en). Ports: 3500 (http), 5543 (https for phones).
- Scan-to-pick and ship come with orders (M4).

## 0.2.1 — Owner-only deleting (2026-11-25)
- Every delete is for the Owner only (decision 17); "delete" is removed from role permissions.
  Even an Admin gets 403; a test checks that every DELETE endpoint is Owner-only.
- New (from MyWines): merge merchants (purchases move, the old name is remembered for imports),
  delete unused merchants; merge / delete wine types.
- Settings › Data (資料管理): clear inventory, cellars, users or the change log — typed phrase
  (中文 or English) + password, the whole database is backed up first, numbers are never reused.
- Change-log retention: keep forever or 3 / 6 / 12 months, purged hourly; each purge is recorded.

## 0.2.0 — M2 MyWines migration (2026-11-25)
- `scripts/migrate-mywines.sh`: moves a MyWines 0.1.x database into an empty workspace. Dry run by
  default (full import, checks, report, then rolled back); `--commit` to save.
- Keeps wine, bottle and case numbers and the cellar/locker/rack ids, so MyWines labels
  (B-…, CASE:…, LOCKER:id, RACK:id, MW: prefix) keep scanning. New numbers continue after MyWines'.
- Brings over storage (with rent), merchants (case-only duplicates merged), wine types, wines, lots
  (cost), bottles (status, stock-out reason and time, label printed), market prices, lists, photos,
  stocktakes, label sizes and the full change log (shown with its original MyWines action).
- MyWines local times converted to UTC. MyWines users become staff with a chosen role and set a new
  password via a one-time link; an existing email (the Owner) is linked instead.
- MyWines is only read: its files are copied and the copy opened read-only. Customers/orders are
  counted and kept (copy of the database in the workspace) for M4.
- Checked against the real MyWines database: 1,026 bottles, 129 wines, 171 cases, 27 lockers,
  128 prices and 305 change-log entries; 50 random bottles match exactly.

## 0.1.0 — M1 Inventory (2026-11-25)
- Storage (cellars › lockers › racks), wines, purchase lots, bottles and cases with MyWines numbering.
- Receive stock, search with filters, wine / case / bottle pages, move, stock-out, market prices.
- Cost and merchant hidden from roles that may not see them; cellar scope and role limits enforced.
- **Excel import** for inventory, storage, market prices and merchants: example files in Chinese
  or English, preview with problems and merge suggestions before saving, reads MyWines Excel files.
- Ports moved to 3500 (server) / 5500 (web) to avoid MyWines; scripts migrate old settings.
- Password reset: "Forgot password?" email link (when SMTP is set), admin reset links, and
  `scripts/reset-password.sh` for a locked-out Owner. Resetting also unlocks the account.
- **Lists**: save search results or single wines to named lists; reorder, copy, rename, export, print.
- **QR labels**: bottle, case, locker and rack labels; label printer (TSC TTP-247 preset sizes) or
  A4/Letter sheets; print only unprinted bottles; printed bottles are marked. Same QR formats as MyWines.
- **Photos** on each wine: upload several, choose the main photo, delete.
- **Stocktakes**: scan or paste codes for a locker, compare with records (found / missing /
  recorded elsewhere / unknown), stock out shortages or move items here in one click; history.
- **Excel export** of search results or lists with chosen columns (cost columns only for roles that may see cost).

## 0.0.1 — M0 Foundations (2026-11-25)
- Monorepo: pnpm workspaces, TypeScript, Vitest, GitHub Actions CI.
- Workspaces: one SQLite database per client; self-hosted (one workspace) and cloud (many) modes;
  `create-tenant` command creates a workspace with the six role templates and an invited Owner.
- Sign-in: one-time setup links (no default passwords), Argon2 passwords (min. 10 characters),
  lockout after 5 failures for 15 minutes, 14-day sliding sessions, sign out everywhere.
- 2-step verification (authenticator app); required for Owner/Admin-type roles in cloud mode.
- Custom roles: functions × actions matrix, data visibility (cost, profit, merchants, customer
  prices, others' orders), cellar scope, limits, back-office/mobile access. Owner role locked;
  at least one active Owner; nobody can grant more than they have.
- Users: invite, edit, change role, deactivate (ends sessions immediately), new setup link.
- Change log: append-only at database level; every sign-in, user and role change recorded with before/after.
- Web app: MyWines layout (side nav / phone bottom tabs), brand from logo set 1d, light/dark,
  Traditional Chinese / English throughout.
- Tests: every endpoint checked for 401 (anonymous) and 403 (no permission); 22 tests in total.
