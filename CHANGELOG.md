# Changelog

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
