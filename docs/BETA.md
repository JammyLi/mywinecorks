# Beta with the first client (M10)

Goal (BUILD-PLAN M10 exit): **the first client runs on MyWineCorks.**
The first client is the cellar MyWines was built for (MyWines itself was only a test, never live). Version: **1.0.0-beta.1**.

Everything below that needs a person on site, accounts or a decision is marked **(Jammy)** and is
also in `docs/TODO-JAMMY.md`.

## 1. Choose how they run it (Jammy)

- **Own server** (closest to today: a PC in the office) — needs the code-signed Windows installer,
  or the unsigned beta installer from CI with a SmartScreen warning explained in person.
- **Cloud** — needs HQ, the cloud server and portal service deployed (TODO-JAMMY › Cloud).

## 2. Rehearsal with their Excel

MyWines was only ever used for testing, so there is nothing to move from it: the first client's
data comes from their **Excel inventory**.

1. Import the Excel into a **test workspace** (Import › wines and stock; storage and market prices
   if they are separate sheets). The import lists every problem before anything is saved —
   missing vintages, unknown racks, prices that are not numbers, names spelled two ways.
2. Fix the problems in a copy of the Excel (or map them in the import) until the preview is clean,
   then save.
3. Check against the Excel: total bottles and value on the Overview; 20 random rows → same wine,
   quantity and place; every cellar / locker / rack present.
4. Print labels for one locker and try scanning them on a phone.
5. Delete the test workspace (or keep it for training).

## 3. Training (about 2 hours, on site)

Use the manual (mywinecorks.com/manual) and their own data in the test workspace:
- everyone: sign in with 2-step, phone setup, scan / move / stock-out, offline in the cellar;
- office: stock-in with cost, labels, orders → pick → ship → payment, customer copy PDF;
- Owner: users and roles, Settings › Updates & backups (**set the second backup copy**), Settings ›
  AI, the change log.

## 4. Cut-over day

1. Evening before: freeze the Excel (no more changes in it).
2. Import the final Excel into the real workspace; repeat the checks in step 2.3; print labels.
3. Owner sets the second backup copy and makes a manual backup.
4. Phones: run Phone setup on each staff phone.
5. Keep the final Excel as the record of the starting stock.

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
- the client is happy to keep working in MyWineCorks (and stops using the Excel).

Then: version 1.0.0, and Release 1 for new clients.
