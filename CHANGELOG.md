# Changelog

## 1.0.0-beta.1 — M10 Hardening (2026-11-26)
- **Security review** (`docs/SECURITY-REVIEW.md`): cross-site request guard, Content-Security-Policy
  on every app, sign-in limits per network address, photo files checked byte by byte, clean errors
  for oversized requests, no search-engine indexing of the apps. All dependencies updated; no known
  vulnerabilities, and CI now fails on new ones. A sweep test checks that no screen shows cost or
  merchants to a role that may not see them.
- **Faster with big cellars** (`docs/LOAD-TEST.md`, tested with 100,000 bottles): sales report 5 s →
  0.05 s, filter counts 6 s → 0.2 s, portal sync 10 s → 0.9 s and much smaller (compressed, and only
  changes are sent); all server responses compressed (phone sync about 10× smaller). Run it yourself
  with `pnpm --filter @mwc/server loadtest`.
- **Backups you can rely on** (Settings › Updates & backups): a backup every day (kept 7 days); a
  **second copy on another disk** (NAS, USB drive, network share) including the wine photos;
  **Restore** a workspace from any backup (typed word + password), with a safety backup first so it
  can be undone — numbers on printed labels are never given out twice.
- **Cloud backups fixed:** the Litestream version in use silently skipped workspace databases; it is
  now pinned to a version checked by the new monthly **restore drill** (`installer/cloud/restore-drill.sh`).
- **User manual** in Chinese and English on the website (mywinecorks.com/manual), linked from the
  ? button in the app.
- Version numbers with a pre-release part (1.0.0-beta.N) are now ordered correctly for updates.

## 0.9.0 — M9 Website (2026-11-26)
- **Website** (`apps/website`, Astro, static): home, features, pricing, request a demo / trial,
  FAQ, about, contact, client account, terms, privacy notice, software licence agreement — in
  Traditional Chinese (`/`) and English (`/en/`), with real screenshots of the app in each
  language, phone layout, sitemap, hreflang, social previews and no cookies or trackers.
- **Requests → HQ leads:** the demo / trial / contact form sends a lead to HQ (new
  *HQ › Website requests*: mark contacted, close, or create the client in one click), emails the
  requester a confirmation and tells HQ. Bots and floods are refused.
- **Client account:** sign in with a one-time email link, see your licences, download the licence
  file and the newest installer (published with `pnpm --filter @mwc/hq publish-download`), with
  install steps. Downloads use one-time links and are logged in HQ.
- The app, customer portals, HQ and the AI gateway now ask search engines not to index them.

## 0.8.0 — M8 AI features (2026-11-26)
- **AI gateway** (`apps/ai-gateway`, cloud): the only place with the Claude API key. Servers
  register with their license (needs the *AI* module) and sign each call; usage is counted per
  license with a monthly cap; prompts and answers are not stored. Without an API key it answers with
  fixed examples in development, so everything can be tried now.
- **New wine from label photos:** front/back label → producer, name, vintage, country, region,
  classification, type, size, grapes filled in; wines already in the cellar are shown.
- **Stock in from an invoice** (Import › Stock in from invoice; roles that see cost): PDF or photo →
  merchant, invoice no., date, currency, extra costs per bottle and each line matched to a wine
  (or created) → added to stock with cost after you check each line.
- **Search in your own words** on the stock search ("香檳 5000 以下", "2010 Bordeaux in Neihu") →
  the normal filters, shown and editable.
- **Drinking windows** page: entering this year / in window / past / too young / no window;
  AI suggests windows for wines without one, saved only when you click "Use this".
- **Ask your cellar:** questions about stock, purchases, value and sales, answered with figures
  calculated on your own server under the asking user's permissions; wines in the answer link to
  their page.
- **Price suggestion** (✦ beside an order line's price, roles that see customer prices) from the
  market price, suggested price, this customer's past prices and — only for roles that see cost —
  the cost.
- **Order from a message:** paste a LINE / WhatsApp / email message or add a photo of a handwritten
  list → customer, wines and quantities matched → check → draft order.
- **Order suggestions** (no AI cost): other vintages when a line is short, wines often bought
  together. **Overview suggestions:** wines past or entering their window, without a window, or
  without a recent market price.
- **Customer portal:** search in your own words and "Ask about this wine" — only that customer's
  wines and own price are sent.
- **Settings › AI:** switch each feature on or off; this month's usage. **HQ › AI usage:** tokens
  per client and feature, monthly caps.
- **Accuracy checks:** `pnpm --filter @mwc/ai-gateway eval` scores the prompts against test cases
  (real labels and invoices go in `apps/ai-gateway/eval/private/`, not committed).

## 0.7.0 — M7 Catalogs and the customer portal (2026-11-26)
- **Customer groups** (VIP, Restaurants, Friends…) under Customers › Groups.
- **Catalogs:** wines picked by hand, from a saved list, or by search conditions; shown to groups
  and/or single customers; price = suggested −X %, market +X %, fixed per wine, or "price on
  request", with the customer's own discount; stock shown exactly, as Available / Limited, or not
  at all; limit per customer; sold-out wines hidden or shown; active dates; priority when a wine is
  in two catalogs; "what a customer sees" preview. Staff orders now default to the catalog price
  after the customer's last price.
- **Customer portal** (`apps/portal`, served by the new `apps/portal-service`): invitation link
  (14 days, once) → password and age confirmation → browse and search the wines with photos and
  tasting notes, favorites, "notify me when available", order request with delivery or pick-up and
  a note, request history with the confirmed prices, profile (phone, language, addresses);
  zh-TW / en; phone layout. Not public: strangers can only ask for access.
- **Order requests become draft orders** (marked "From portal"); confirming, cancelling or shipping
  shows on the customer's request.
- **Access:** invite, suspend, revoke (with a reason in the change log; the customer is signed out
  at once and sees "access ended"), reactivate; access requests approved or declined by staff.
- **Settings › Customer portal:** address, welcome text, colour, market (age 18+ / 21+), US states
  you cannot ship to, alcohol-licence confirmation, sync status and "Sync now", and for servers
  without internet: download the portal package, import the order-requests file.
- **Sync:** the server connects out every few minutes and right after access changes, signed with
  the workspace's own key; it sends only public wine facts and each customer's own prices — never
  cost, merchants, locations, bottle/case numbers or other customers (tested).
- Wines have **tasting notes** for customers (internal notes stay internal).

## 0.6.0 — M6 Packaging, updates, cloud (2026-11-26)
- **Windows installer** (`installer/windows/build.sh`): Node 22 and the server bundled; runs as the
  "MyWineCorks" Windows service (starts with Windows, restarts after a crash); firewall opened for
  the office network only; data in `C:\ProgramData\MyWineCorks`; Start-menu shortcuts (app, phone
  setup, addresses, data folder); upgrade by running the new installer; uninstall keeps the data.
- **Docker image** (`installer/docker`) for Mac, Linux and NAS, with a compose file; `PUBLIC_IP`
  sets the address phones use.
- **First run without a default password:** a new server opens a one-time link — company and Owner,
  then the Owner sets a password.
- **Backups before updates:** every database is copied to `backups/` before a new version first
  starts. Settings › Updates & backups (Owner): version, check for updates, "Update now", back up now,
  list of backups.
- **In-app update:** packages are signed by HQ and only handed to a valid license on its own server;
  checksum and signature are checked, everything is backed up, the new version is unpacked beside the
  old one and started; if it fails to start three times the previous version comes back.
- **Release build** (`node scripts/release/build.mjs`): one minified server file per platform
  (win-x64, linux-x64, linux-arm64, darwin-arm64) with the HQ public key embedded; production builds
  never trust development keys. CI builds the installer and image and tests a clean install, an
  upgrade and an uninstall on Windows, and a clean install and restart in Docker.
- **HQ:** update packages per release (`publish-release`), update API for servers; **cloud
  workspaces** — create from a cloud subscription (license, workspace, Owner email), list with live
  usage, new Owner link; renew / grace / revoke reach the workspace at once.
- **Cloud server:** provisioning API (token), each workspace with its own license, Litestream
  continuous backup to S3-compatible storage (`installer/cloud`).

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
