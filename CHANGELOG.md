# Changelog

## Unreleased — M1 Inventory
- Storage (cellars › lockers › racks), wines, purchase lots, bottles and cases with MyWines numbering.
- Receive stock, search with filters, wine / case / bottle pages, move, stock-out, market prices.
- Cost and merchant hidden from roles that may not see them; cellar scope and role limits enforced.
- **Excel import** for inventory, storage, market prices and merchants: example files in Chinese
  or English, preview with problems and merge suggestions before saving, reads MyWines Excel files.

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
