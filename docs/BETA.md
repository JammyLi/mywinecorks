# Beta with the first client (M10)

Goal (BUILD-PLAN M10 exit): **the first client runs on MyWineCorks and MyWines is retired.**
The first client is the cellar MyWines was built for. Version: **1.0.0-beta.1**.

Everything below that needs a person on site, accounts or a decision is marked **(Jammy)** and is
also in `docs/TODO-JAMMY.md`.

## 1. Choose how they run it (Jammy)

- **Own server** (closest to today: a PC in the office) — needs the code-signed Windows installer,
  or the unsigned beta installer from CI with a SmartScreen warning explained in person.
- **Cloud** — needs HQ, the cloud server and portal service deployed (TODO-JAMMY › Cloud).

## 2. Rehearsal (no risk to MyWines)

MyWines is only ever read; the migration takes a snapshot of its database first.

1. Copy MyWines' `data` folder (database and photos) to a USB drive or your Mac.
2. Dry run — imports everything, checks it, and rolls back:
   ```bash
   pnpm --filter @mwc/server migrate-mywines --from /path/to/mywines/data \
     --user jammy=<email>:owner --user <name>=<email>:employee
   ```
   It prints counts (wines, bottles, cases, storage, customers, orders, prices) and every problem.
3. Fix or accept each problem, then run it with `--commit` into a test workspace.
4. Check side by side with MyWines (both open):
   - totals on the Overview (bottles, value) and in Reports › Collection value;
   - 20 random bottles: scan the printed label → same wine, same place;
   - 5 cases: same bottles;
   - 5 customers: same history and open balance;
   - the newest 10 orders.
5. Delete the test workspace.

## 3. Training (about 2 hours, on site)

Use the manual (mywinecorks.com/manual) and their own data in the test workspace:
- everyone: sign in with 2-step, phone setup, scan / move / stock-out, offline in the cellar;
- office: stock-in with cost, labels, orders → pick → ship → payment, customer copy PDF;
- Owner: users and roles, Settings › Updates & backups (**set the second backup copy**), Settings ›
  AI, the change log.

## 4. Cut-over day

1. Evening before: stop using MyWines for changes (it stays open for looking things up).
2. Final migration with `--commit` into the real workspace; repeat the checks in step 2.4.
3. Owner sets the second backup copy and makes a manual backup.
4. Phones: run Phone setup on each staff phone.
5. MyWines stays installed, read-only, for 30 days.

## 5. Beta period (4 weeks)

- Daily use for everything; problems to Jammy (LINE group) with a screenshot.
- Week 1: on-site visit at the end of the week; week 2–4: weekly call.
- Watch in HQ: daily check-in and version; on the server (Settings › Updates & backups): backups and their second copy.
- Hot fixes go out as 1.0.0-beta.N through "Update now".

## 6. Done when (exit criteria)

- 4 weeks with all daily work in MyWineCorks and **no data lost or wrong** that was not caught and
  fixed the same day;
- a stocktake of at least one locker matches;
- a backup has been restored once on a spare PC (the drill in the manual, *Running your own
  server › Restoring*);
- the client agrees MyWines can be retired → MyWines folder archived (kept, not deleted).

Then: version 1.0.0, and Release 1 for new clients.
