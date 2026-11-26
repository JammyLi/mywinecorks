# MyWineCorks — Product Specification

**Version:** 0.2 (draft) · **Date:** 2026-11-25 · **Status:** For review
**Product:** MyWineCorks.com — AI cellar management and private sales for wine collectors
**Reference app:** MyWines v0.1.8 (internal tool built for the first client)

Legend used throughout:
- **[Carry]** — proven in MyWines; keep the behavior and the UI pattern
- **[Change]** — exists in MyWines but must be reworked
- **[New]** — not in MyWines

---

## 1. Summary

MyWineCorks is a private cellar management system for serious wine collectors and small
wine businesses, with an optional, invite-only portal where the collector's own customers
can browse and request bottles. It is **not** a public e-commerce store: inventory is never
public, payment happens offline, and the collector decides who sees what, at what price,
and can cut off access at any time.

Every bottle is tracked individually with a QR label, from purchase (cost and date) through
market-value history to final sale (price and date). AI is built into the everyday
workflows: adding wine from a label photo, searching in plain language, drafting orders
from a customer's message, and suggesting prices.

It runs either in the cloud (hosted by us) or on the client's own server (self-hosted),
from the same codebase.

### 1.1 Goals
1. Know exactly what is in the cellar, where each bottle is, and what it is worth.
2. Know the full money story of every bottle: bought for, worth now, sold for, when.
3. Make picking and shipping error-free (scan-to-confirm).
4. Let the collector sell privately to approved customers without exposing the cellar.
5. Respect clients who will not put their collection in the cloud.

### 1.2 Non-goals (version 1)
- Public storefront, SEO, open sign-up for customers
- Online payment, payment gateways, e-invoice issuing
- Shipping-carrier integrations
- Accounting / ERP (export only)
- Wine auctions or marketplace between clients

---

## 2. Users

### 2.1 Client (tenant)
The person or company that subscribes to MyWineCorks and owns the wine. Each client is a
fully separate workspace: its own data, users, customers, settings and branding.

### 2.2 Staff users (client's team) — custom roles **[New]**
MyWines has no roles (every user can do everything). MyWineCorks uses role-based access
where the **Owner can create custom roles**.

Built-in role templates (Owner can copy and edit all except Owner):

| Role | Intended for | Default access |
|---|---|---|
| **Owner** | The collector / business owner | Everything, including billing, cellars, roles, data deletion. Cannot be edited or removed; at least one Owner must exist. |
| **Admin** | Cellar or office manager | Lockers, racks, users (except Owner), customers, catalogs, settings |
| **Manager / Sales** | Person who sells | Customers, catalogs, prices, confirm orders; no location setup |
| **Employee** | Cellar staff | Add wine, receive, move, label, search, create orders, pack/ship, update market price |
| **Picker** | Part-time / warehouse | Mobile only: scan, look up, move, pick, ship, stocktake |
| **Viewer / Accountant** | Family member, accountant | Read-only, including financial reports if allowed |

A role is a set of permissions in four dimensions:

1. **Function permissions** — per module, with actions *view / create / edit / delete /
   approve* (Inventory, Locations, Prices, Orders, Customers, Catalogs, Reports, Import/Export,
   Labels, Settings, Users & Roles, Audit log, Data deletion).
2. **Data visibility** — separate switches: *see purchase cost*, *see profit/margin*,
   *see merchants*, *see customer prices*, *see other users' orders*.
3. **Location scope** — all cellars, or only selected cellars/lockers.
4. **Limits** — e.g. can confirm orders up to NT$X; can change a price by at most ±Y%;
   can stock-out up to N bottles without approval.

Users can hold one role. Every permission is enforced on the server (API), not only hidden
in the UI. Mobile offline data respects the role (e.g. no cost data downloaded — **[Carry]**).

### 2.3 Customers (client's customers) — portal **[New]**
- Never public. A customer can sign in only after the client **invites** them or
  **approves** their request.
- The client can **suspend or revoke** access at any time; effect is immediate (all
  sessions end, portal returns "access ended").
- Customers see only the **catalogs** assigned to them (see §7), at their prices.
- They can browse, search, save favorites, and send **order requests**. They never see
  cost, location, bottle numbers, other customers or other customers' prices.

---

## 3. Platforms and devices

| Surface | Devices | Primary use |
|---|---|---|
| **Back office** | Laptop, tablet (responsive) | Everything: setup, inventory, prices, orders, customers, catalogs, reports |
| **Staff mobile** | Phone (installable web app / PWA) | Stock taking, search & review, receive, move, pick and ship by QR scan, stock-out |
| **Customer portal** | Phone, tablet, laptop (responsive web, installable) | Browse catalogs, search, favorites, order requests, order history |

- Responsive design with three layouts: phone (<640px), tablet (640–1100px), desktop.
- Staff mobile keeps MyWines' camera scanning, offline mode and sync **[Carry]**.
- **Launch markets: Taiwan and the United States.**
- Languages: Traditional Chinese (zh-TW) and English (en-US) first, for UI, documents,
  portal, marketing site and emails **[Carry]**; structure ready for more. Per-user and
  per-customer language **[Carry]**.
- Currency: TWD and USD at launch; client chooses base currency; purchase prices may be
  recorded in a foreign currency with the exchange rate on that date **[New]**.
- Region settings per client: date/number format, tax label (營業稅 / Sales tax), units.

### 3.1 Market compliance (client's responsibility, app provides the tools) **[New]**
| Topic | Taiwan | United States |
|---|---|---|
| Portal age gate | 18+ | 21+ |
| Shipping restrictions | — | Client can block US states it cannot ship to; portal hides "deliver" for those addresses (pick-up only or blocked) |
| Tax on client's orders | 5% business tax default **[Carry]** | Per-state sales-tax rate field on order (no automatic calculation in v1) |
| Disclaimer | Client confirms in setup that it holds any licence required to sell alcohol in its jurisdiction | Same |

---

## 4. Locations and stock structure **[Carry, with changes]**

```
Client
 └─ Cellar  (Owner creates)        e.g. "Neihu warehouse", monthly rent, address
     └─ Locker  (Admin creates)    e.g. "L-03" (storage unit / room / fridge)
         └─ Rack  (Admin creates)  e.g. "R2"   (default "Unassigned" rack per locker)
             ├─ Case  (OWC/box, own QR, case no.)
             │    └─ Bottle
             └─ Bottle  (loose on the rack)
```

- **Cellar**: name, type, address, monthly rent **[Carry]**, temperature/humidity notes,
  active flag. Only roles with *Locations: create cellar* (Owner by default) can add.
- **Locker / Rack**: code, capacity (optional), notes; optional slot/position text **[New]**.
- **Case**: case no., kind (OWC 6/12, carton, custom), capacity, "location uncertain" flag
  **[Carry]**.
- Label printing (QR) for bottles, cases, lockers and racks **[Carry]**: label printer
  (default TSC TTP-247) and A4/Letter sheets with cut lines **[Carry]**.

---

## 5. Inventory

### 5.1 Data model

| Entity | Key fields | Notes |
|---|---|---|
| **Wine** (label) | wine no., producer, name, vintage/NV, country, region, appellation/classification, type (red, white, sparkling…), grapes, bottle size (ml), drinking window (from/to) **[New]**, critic scores **[New]**, tasting notes, photos, suggested price | One record per label + vintage + size; duplicate detection by match key **[Carry]** and AI **[New]** |
| **Lot** (purchase) | wine, merchant, purchase price per bottle, currency + rate **[New]**, purchase date, invoice no. **[New]**, extra costs (shipping/duty) **[New]** | Cost basis lives here **[Carry]** |
| **Bottle** | bottle no. (QR), wine, lot, case, rack, status, condition (fill level, label, capsule) **[New]**, provenance notes **[New]**, label printed date | One row per physical bottle **[Carry]** |
| **Market price** | wine, price, date, source, URL, voided flag | History, never overwritten **[Carry]** |
| **Sale** | order line → bottles, sale price, sale date, customer | Final price per bottle derived from order **[Carry]** |

Bottle statuses: `in_stock`, `reserved` (held by an order), `shipped`/sold, `out`
(stock-out with reason), `broken`. **[Carry]**

### 5.2 Functions
| Function | Detail | Tag |
|---|---|---|
| Add wine & receive | Create wine, lot, bottles; auto bottle no. and case no.; print labels | Carry |
| **Add from label photo** | Snap label(s) → AI fills producer, name, vintage, region, type, size; matches existing wine to avoid duplicates; user confirms | New (AI) |
| **Add from invoice** | Upload merchant invoice/PDF/photo → AI drafts lots and bottles; user confirms | New (AI) |
| Excel import | Template download, merge suggestions, warnings | Carry |
| Search | By wine or by case; filters (type, country, region, vintage range, price range, cellar › locker › rack, merchant, status) with live counts **[Carry]** | Carry |
| **Natural-language search** | "Champagne 2010–2016 under NT$3,000 in Neihu" → filters applied and shown so the user can adjust | New (AI) |
| Wine / case / bottle detail | Photos, stock by location, price history, movement history | Carry |
| Move | Whole case, some bottles, loose bottles into a case; by scan or from screen | Carry |
| Stock-out (not via order) | Reasons: own use, gift, tasting, broken, stocktake shortage, entry error, other (note required); batch and by scan; offline | Carry |
| Stocktake | Scan a locker; discrepancy report; resolve | Carry |
| My lists | Build from search or scan; sort; copy; turn into order or catalog | Carry / Change |
| **Drinking-window alerts** | Wines entering, at, or past peak; per-cellar digest | New (AI) |
| **Cellar insights** | Plain-language Q&A: "What did I spend on Burgundy this year?", "Which wines doubled in value?" (respects data visibility permissions) | New (AI) |
| Audit log | Append-only, cannot be edited or deleted; retention setting | Carry |

---

## 6. Prices and valuation

Every bottle carries four price facts. All are dated.

| Price | Where it comes from | Who can see |
|---|---|---|
| **Purchase price** + date | Lot (per bottle, incl. optional extra costs) | Roles with *see cost* |
| **Market price** history | Manual entry, Excel upload, price-helper bookmarklet (Wine-Searcher, user's own browser, rate-limited) **[Carry]**; future: licensed data feed | All staff |
| **Asking / suggested price** | Per wine; or per catalog price rule (§7) | Staff with *see customer prices* |
| **Sale price** + date | Order line, per bottle | Staff with *see customer prices* |

Functions:
- Price list screen with batch entry, Excel upload, price helper, ±20% change confirmation **[Carry]**.
- **AI price suggestion** **[New]**: when pricing an order or a catalog, suggest a price from
  latest market price, trend, this customer's past prices, and the client's target margin;
  always shows the reasoning and the source; never applied without a user click.
- Reports **[New]**: collection value (cost vs. market) over time; unrealized gain by wine,
  region, cellar; realized profit by period/customer/wine; storage cost (cellar rent) vs. value.

---

## 7. Catalogs (what each customer sees) **[New]**

A **Catalog** is a list of wines plus an audience plus a pricing rule.

| Setting | Options |
|---|---|
| Content | Pick wines manually, from a saved list, or by rule (e.g. "all Champagne in stock, market ≥ NT$5,000") |
| Audience | Individual customers and/or **customer groups** (e.g. VIP, Restaurants, Friends) |
| Price rule | Fixed per wine · market price +X% · suggested price −customer discount · "price on request" |
| Stock display | Exact quantity · "Available / Limited (≤N)" · hidden |
| Limits | Max bottles per customer per wine (optional) |
| Active dates | Optional start/end (e.g. year-end offer) |

Rules:
- A customer sees the union of their catalogs. If a wine appears in two catalogs, the
  catalog with higher **priority** decides the price (set by Owner/Manager).
- Out-of-stock wines hide automatically (option: show as "sold out").
- Bottles reserved for confirmed orders are not counted as available.
- Changing a catalog updates the portal at the next sync (cloud: immediately).

---

## 8. Orders

### 8.1 Staff orders **[Carry]**
1. Create from a list, search results, scan, or blank; choose customer.
2. Lines: wine, qty, unit price (ex-tax), discount. Default price: customer's last price →
   catalog price → suggested price → latest market price, with source shown **[Carry/Change]**.
   Cost and margin shown to permitted roles only.
3. **Confirm** → system reserves specific bottles.
4. **Pick list** → go to the cellar; **ship by scanning** each bottle/case; a different bottle
   of the same wine is swapped in automatically; wrong wine is blocked with a clear warning.
5. Shipping deducts stock; everything is written to the audit log.
6. Customer PDF in customer's language (company header, tax, shipping fee, total) **[Carry]**.

### 8.2 Payment and status **[Change]**
Payment stays offline (bank transfer, cash, invoice). Order tracks:
`Request → Draft → Confirmed (reserved) → Invoiced → Paid → Picked → Shipped/Picked up → Closed`,
plus `Cancelled` (releases bottles). Payment record: date, method, amount, reference, note.
Partial payments allowed.

### 8.3 Customer order requests **[New]**
- Customer adds wines to a request in the portal and submits with a note and preferred
  delivery/pick-up.
- Request arrives as a **draft order** for staff; staff adjust and confirm. The customer is
  told the request is "received", then "confirmed" (with final prices) or "declined".
- A request does not reserve stock (prevents fake holds); optional setting: soft-hold for N hours.

### 8.4 AI in orders **[New]**
- **Order from message**: paste a customer's LINE/WhatsApp/email text (or a photo of a
  handwritten list) → AI matches wines, quantities and the customer → draft order.
- **Suggestions**: "customers who bought this also bought", alternatives when out of stock,
  same wine other vintage.
- **Pick-route**: pick list sorted by cellar › locker › rack › case to minimize walking.

---

## 9. Customer portal **[New]**

### 9.1 Access
- Invitation by email or LINE link with one-time code; or customer requests access and
  staff approve.
- Sign-in: email + password or passwordless magic link; optional 2-step verification.
- Revoke/suspend: immediate; reason kept in audit log; customer sees a neutral message.
- Each client's portal is branded (logo, colors, intro text) at
  `<client>.mywinecorks.com` or a custom domain.
- Age confirmation on first sign-in: 18+ for Taiwan clients, 21+ for US clients (§3.1) **[New]**.

### 9.2 Customer functions
- Browse catalogs, filter, search (including natural language), wine detail with photos,
  tasting notes, drinking window, price.
- Favorites / wish list; "notify me when available".
- Order request, request history, order status, downloadable order PDF.
- Profile: contact info, delivery addresses, language.

### 9.3 What the portal never receives
Purchase cost, margin, merchants, locations, bottle/case numbers, other customers, other
customers' prices, staff names, audit log.

---

## 10. Deployment

Same codebase, two modes. Each client's data lives in its **own database** (one SQLite file
per client is sufficient for expected scale; PostgreSQL optional for large cloud clients).

### 10.1 Cloud (hosted by MyWineCorks)
- `app.mywinecorks.com` for staff, `<client>.mywinecorks.com` for portal.
- Daily encrypted backups, point-in-time restore, automatic updates.
- AI features available out of the box.

### 10.2 Self-hosted (client's own server)
- Installer for Windows (service) **[Carry]**, Docker image for Mac/Linux/NAS **[New]**.
- Works on the office network with no internet; local HTTPS for phones **[Carry]**
  (simplified setup **[Change]**).
- Backups: scheduled local copies + optional copy to NAS/USB **[Carry/Change]**.
- Updates: in-app "update available" with one-click update and automatic pre-update backup.
- Licensed by a signed license key — see §20.

### 10.3 Customer portal for self-hosted clients
The portal always runs in the cloud; the client's server feeds it.

**Primary — API sync (outbound only)**
- The local server connects *out* to the portal over HTTPS every few minutes (and
  immediately on changes). No inbound ports, no firewall change.
- Sends: catalog snapshot/changes (wine details, photos, availability, each customer's
  price), customer list and access status.
- Receives: new order requests, customer profile updates, access requests.
- Signed with the client's key; the portal stores only what it is sent.
- Revocation is done in the portal itself, so it works even when the local server is off.

**Fallback — portal package file**
- For servers without internet: Owner clicks *Export portal package* (signed, encrypted
  file) and uploads it at the portal admin page in a browser; order requests are downloaded
  the same way as a file and imported.
- Email delivery is not used (one-way, size limits, security risk).

### 10.4 AI in self-hosted mode
- AI features call the AI service through MyWineCorks' cloud gateway.
- Each AI feature can be switched on/off per client; when on, only the data needed for
  that request is sent (e.g. a label photo, or wine names for a search) — never cost or
  customer data unless the user's own question requires it, and only if the setting allows.
- With AI off, every feature still works manually.

---

## 11. AI features — summary (all in version 1)

| Area | Feature | Input → Output | Human confirms? |
|---|---|---|---|
| Inventory | Label recognition | Photo(s) → wine fields + duplicate match | Yes |
| Inventory | Invoice to stock | Invoice PDF/photo → lots & bottles draft | Yes |
| Inventory | Natural-language search | Text → filters | Shown, editable |
| Inventory | Drinking-window alerts | Wine data → status & digest | n/a |
| Inventory | Cellar Q&A | Question → answer with numbers and links | n/a (read-only) |
| Prices | Price suggestion | Market history, customer history, margin → price + reason | Yes |
| Orders | Order from message | Text/photo → draft order | Yes |
| Orders | Suggestions & substitutes | Order/cart → wines | Yes |
| Portal | Customer NL search & wine Q&A | Text → results / answer from that customer's catalog only | n/a |

Rules: AI never changes data without a user action; every AI suggestion shows its source;
AI answers respect the user's permissions (no cost data to roles without *see cost*;
customers only ever reach their own catalog).

---

## 12. Security and audit
- Staff sign-in: email/login + password (min 10 chars) with 2-step verification
  (required for Owner/Admin in cloud) **[Change: replaces 6-digit PIN]**; optional
  quick PIN unlock on a trusted phone.
- Lockout after repeated failures **[Carry]**; session list and "sign out everywhere".
- All permissions checked server-side; customer portal data is a separate, filtered copy.
- Append-only audit log for every change (who, when, before/after, reason) **[Carry]**;
  retention setting **[Carry]**.
- Data deletion: typed confirmation + password, automatic backup first **[Carry]**.
- Mobile offline data cleared on sign-out **[Carry]**.

---

## 13. Settings (back office)
Company (names zh/en, tax ID, address, logo), users & roles, customers & groups, merchants,
wine types, locations, catalogs, price-helper limits, label printer & sizes, tax rate &
shipping defaults, portal branding & sync status, AI switches, backups & updates (self-hosted),
data import/export/clear. **[Carry + New]**

---

## 14. Migration from MyWines **[New]**
One-click import of a MyWines database (`mywines.db` + `photos/`):
- Keeps bottle numbers, case numbers and wine numbers so **printed labels keep working**.
- Imports cellars/lockers/racks (with rent), wines, lots, bottles, price history, lists,
  customers & addresses, orders, stocktakes, and the audit log (marked "imported").
- Existing MyWines users become staff users with a chosen role; they set new passwords.
- Dry run with a report before committing.

---

## 15. Non-functional requirements
- **Performance**: search results < 1s for 50,000 bottles; scan-to-result < 0.5s on phone.
- **Offline**: staff mobile fully usable offline for lookup, move, stock-out, stocktake,
  pick/ship scanning; conflict resolution on sync **[Carry]**.
- **Scale target**: up to 100,000 bottles and 30 staff per client; 1,000 portal customers.
- **Availability (cloud)**: 99.5%; portal can serve read-only if a self-hosted server is offline.
- **Accessibility**: WCAG 2.1 AA for portal; large scan targets on mobile.
- **Privacy**: client owns its data; full export (Excel + database) at any time.

---

## 16. Design direction
- Keep MyWines' screen structure and flows so existing users have nothing to relearn:
  sidebar navigation on desktop, bottom tabs on mobile, search-first inventory screens,
  same order and scan screens.
- **Brand: logo set "direction 1d"** (`brand/MyWineCorks Logo Directions.zip`) — tilted
  bottle with gold outline and cork; lockup "My Wine / Corks" with tagline
  "Collector's Cellar". Name written as one word "MyWineCorks" in text; spaced in the lockup.
- Colors: Burgundy `#5e1a24` (primary), Gold `#b68235` on light / `#d4a560` on dark,
  Cork `#e6d2ac`, Ink `#201f1d`, Paper `#f3f2f2`, Night `#1b1a18`.
- Type: Cormorant Garamond (brand name, headings), Lora (tagline, body accents); UI body
  text in a readable sans for tables and forms; Noto Sans TC / Noto Serif TC for Chinese.
- Look: upscale and calm (collector's cellar), light and dark themes; the dark "Night"
  theme suits the portal and evening use.
- Portal looks like the client's private cellar list, not a shop: elegant, calm, no
  marketing banners.

---

## 17. Release plan

**Release 1 — the product (v1.0)** ships everything below together; the steps are build order.

| Step | Content |
|---|---|
| Now – Dec 2026 | MyWines stays in use by the first client; bug fixes only |
| 1a Core | Tenant model, custom roles, inventory, locations, prices, labels, mobile offline, orders, audit, MyWines migration, cloud + self-hosted packaging |
| 1b Portal | Catalogs, customer groups, portal, invitations/revocation, order requests, API sync + package fallback, TW/US compliance tools |
| 1c AI | All §11 features, switches, gateway |
| 1d Licensing & HQ (basic) | License keys, check-in, lock, server binding (§20); HQ back office with clients, licenses, installations, cloud workspaces, releases, support access, HQ staff (§21) — **billing handled manually** (invoice/bank transfer recorded in HQ; staff issue/renew keys) |
| 1e Website (basic) | Marketing pages, features, FAQ, "Request a demo / trial" form (§22) — no online checkout |

**Release 2 — selling online** (after pricing and payment are decided)

| Content |
|---|
| Pricing model and plans (§23); price page with live prices |
| Online order/checkout; credit-card payment with card stored by the payment provider; recurring billing; automatic renewal → new license key issued automatically |
| 2-week trial on request with card required upfront |
| Payment providers: Taiwan (ECPay / NewebPay / TapPay, with Taiwan e-invoice) and US (Stripe) — depends on billing entity |
| Coupons, upgrades/downgrades, proration, failed-payment retries (dunning), tax (Taiwan 5% VAT, US sales tax) |
| HQ revenue reports (MRR, churn, renewals, trial conversion) |

---

## 18. Decisions log
| # | Decision | Date |
|---|---|---|
| 1 | New product/codebase "MyWineCorks"; MyWines kept as interim app and design reference | 2026-11-24 |
| 2 | Customer portal required for self-hosted clients; API sync (outbound) primary, file package fallback; no email transport | 2026-11-24 |
| 3 | Per-customer catalogs via Catalogs + customer groups | 2026-11-24 |
| 4 | Payment offline for v1 | 2026-11-24 |
| 5 | Owner can create custom roles | 2026-11-24 |
| 6 | All AI features in v1 (inventory and orders first in priority) | 2026-11-24 |
| 7 | Brand: logo set "direction 1d" (tilted bottle, burgundy + gold, "Collector's Cellar") | 2026-11-24 |
| 8 | Launch markets Taiwan and US; zh-TW and English first; TWD and USD | 2026-11-25 |
| 9 | Self-hosted protection: signed license key + daily check-in + cloud-only services + compiled build + licence agreement | 2026-11-25 |
| 10 | **Strict lock** after expiry grace period (§20.4) | 2026-11-25 |
| 11 | HQ back office + marketing website on mywinecorks.com; first Super Admin jammy.li@getfocus.com | 2026-11-25 |
| 12 | Clients pay by credit card (Release 2); 2-week trial on request, card required upfront | 2026-11-25 |
| 13 | Pricing dimensions: bottle count, order transactions, Inventory-only vs Inventory + Client Portal | 2026-11-25 |
| 14 | Online payment, checkout and final pricing moved to Release 2; Release 1 billing is manual | 2026-11-25 |
| 15 | Owner keeps "Export my data" while locked | 2026-11-25 |
| 16 | MyWines migration (M2) moves inventory, storage, prices, lists, photos, stocktakes, users and the change log now; customers, addresses and orders follow with M4 from a copy of the MyWines database kept in the workspace. Migration only into an empty workspace; ids kept so LOCKER:/RACK: labels still scan | 2026-11-25 |
| 17 | All deleting is Owner-only (MyWines had no roles): delete wine, photo, list, cellar/locker/rack, role, merchant, wine type, remembered import matches; merge merchants / wine types; clear data (typed phrase + password, automatic backup, numbers not reused); change-log retention 3/6/12 months or forever. "Delete" is no longer a role permission. The change log stays append-only apart from Owner clear / retention, each of which leaves an entry | 2026-11-25 |
| 18 | Phone app (M3) is the same web app at /m, installable (PWA), with its own offline copy and queue, as in MyWines. Self-hosted servers serve HTTPS on the office network (local CA, phone installs it once via /phone) because camera scanning and offline need HTTPS. Scan-to-pick/ship moves to M4 with orders | 2026-11-25 |
| 19 | Orders (M4): status is fulfilment only — draft → confirmed (bottles held) → picked → shipped → closed, or cancelled; invoice number and payments (partial, refunds, voids) are tracked beside it, and a shipped order closes itself when fully paid. Prices are ex-tax with a tax rate and shipping per order. Default price: customer's last price → suggested price → market price + markup. Phone pick/ship needs a connection (stock and payments stay exact). MyWines customers and orders are moved with the rest (M2 tool) | 2026-11-26 |
| 20 | Licensing (M5): keys are signed (Ed25519) by HQ only; an unactivated self-hosted install runs a 14-day trial; the first activation needs internet and binds the key to that installation (a second server is refused and flagged in HQ); daily check-in sends only license id, installation, version and counts. No check-in for 7 days → warning, 30 days → lock. Expiry → 14-day grace (HQ can change it per license) → strict lock: only the Owner can sign in, to the License screen, and can still export (Excel and the database file); nothing is deleted. Limits warn at 90 % and block new bottles / orders / users at 100 %. Renewals and plan changes reach the server at its next check-in. Moving to a new server: HQ unbinds (max 2 per year unless a Super Admin) | 2026-11-26 |
| 21 | HQ (M5): own app on PostgreSQL (embedded PGlite in development), staff roles Super Admin / Sales / Support / Finance / Read-only, 2-step verification required for every HQ user, first Super Admin from a one-time setup link (FIRST_ADMIN), append-only HQ audit log. Subscriptions and payments are entered by hand (no card billing yet). Support access to a client's server is deferred until there is a cloud channel for it (M6+); cloud workspaces are licensed directly by HQ in M6. Production builds trust only the embedded HQ public key (added with packaging, M6) | 2026-11-26 |
| 22 | Packaging and updates (M6): self-hosted servers ship as a bundled, minified build with the HQ public key embedded (Windows installer with a Windows service; Docker image for Mac / Linux / NAS). No default password: a new server writes a one-time setup link (opened by the installer) that creates the workspace and its Owner. Every database is backed up automatically before a new version first starts and before an in-app update; the Owner updates from Settings › Updates & backups — packages come from HQ signed, only for a valid license bound to that server, and a version that fails to start three times is rolled back. Installers are unsigned until the code-signing certificate is bought (decision 5 of the build plan) | 2026-11-26 |
| 23 | Cloud (M6): one cloud server per region runs all cloud workspaces (one SQLite file each), continuously backed up with Litestream to S3-compatible storage. HQ creates cloud workspaces through a token-protected provisioning API, licenses each one (bound to "cloud:<workspace id>") and pushes renewals, grace changes and revocations at once — no check-in. Expiry, grace, strict lock and limits behave as on self-hosted servers. Cloud provider still to be chosen (default AWS Tokyo + US-West) | 2026-11-26 |
| 24 | Catalogs and portal (M7): a customer sees the union of their catalogs (for them or their groups); when a wine is in two, the higher-priority catalog sets its price, stock display and per-customer limit. Prices: suggested −X %, market +X %, fixed per wine, or "price on request"; the customer's own discount applies unless switched off. Reserved bottles are never shown as available. Order requests arrive as draft orders without holding stock (soft-hold setting kept for later); the customer sees received → confirmed (final prices) / declined / shipped. Access changes (invite accepted, suspend, revoke) reach the portal at once when the server is online, otherwise with the next sync or package file; a customer who is no longer sent loses access. Customers sign in with email + password (magic links and customer 2-step later). Wines carry separate *tasting notes* for customers; internal notes never leave the server | 2026-11-26 |
| 25 | Portal service (M7): one cloud service for all portals at `/<address>` (subdomains via PORTAL_DOMAIN later); a portal needs an HQ-signed license with the *portal* module, and every call from a client server is signed with that workspace's own key. Servers without internet use an encrypted, signed package file (uploaded at /package) and import the signed order-requests file it returns; photos travel only with online syncs. Compliance: age confirmation 18+ (Taiwan) / 21+ (US) at first sign-in, US states the client cannot ship to (pick-up only), and the Owner confirms holding an alcohol licence before the portal opens | 2026-11-26 |
| 26 | AI (M8): one cloud AI gateway holds the Claude API key, the prompts and the output formats; servers register with an HQ license that includes the *ai* module and sign every call with the workspace key; the portal service calls it with a service token. Each call sends only what that feature needs (photo, wine names, figures already allowed for that user); prompts and answers are not stored, only token counts per license, with a monthly cap per license (default 3 M tokens, HQ can change it). Answers are structured and checked before use. Nothing is saved by AI: the user saves through the normal form (wine, stock-in, drinking window, price, draft order). Cellar Q&A: Claude asks for figures through five fixed tools that run on the client's own server with the asking user's permissions (cost, merchants, customer prices, other users' orders, cellar scope). Each feature can be switched off in Settings › AI; trial installs have no AI (the license must include it). Models: Claude Sonnet for photos, invoices, windows and Q&A; Claude Haiku for search, prices and the portal | 2026-11-26 |
| 27 | AI suggestions without AI (M8): drinking-window status (entering / in window / past / too young / unknown), stale market prices, other vintages when an order line is short, and "often bought with" are worked out on the server from the client's own data — no AI call, no AI cost | 2026-11-26 |
| 28 | Website (M9): a static site (`apps/website`, Astro) in Traditional Chinese at `/` and English at `/en/`, with no cookies, analytics or trackers. Pages: home, features, pricing (plans described — Collector, Merchant, Merchant + Portal, AI as an add-on — "contact us for pricing"), demo / trial / contact request, FAQ, about, contact, client account, terms, privacy, software licence agreement. Requests become HQ leads (new → contacted → client created / closed) with a confirmation email to the requester and a notice to HQ; spam is stopped by a hidden field and a per-IP limit. Client account: sign in with a one-time email link (30 minutes) for anyone whose email is a client's or a cloud workspace Owner's (the answer never shows whether an email is known); the session lasts 12 hours in that browser tab; it lists active licences, the licence file and the newest installer per kind (published from HQ), each download through a one-time 2-minute link, all logged. The app, portals, HQ and the AI gateway send `noindex` | 2026-11-26 |
| 29 | Hardening (M10): changes must come from the app's own origin with a JSON or raw body (CSRF guard); CSP on every app; per-address sign-in limits; photo bytes must match their type. Self-hosted backups: daily (kept 7), before updates and restores, manual; an optional second copy to another folder (NAS / USB / share) that also mirrors photos, with its status shown to the Owner. Restore is Owner-only, self-hosted, from Settings › Updates & backups (typed word + password), takes a safety backup first, and never lowers the wine / bottle / case / order counters, so printed labels stay unique. Cloud: Litestream pinned to a version verified by the monthly restore drill. Versions follow semver including pre-releases (1.0.0-beta.N) for updates | 2026-11-26 |

## 19. Open questions
1. Market-price data: stay with manual + price helper, or budget for a licensed feed?
2. Billing entity (Taiwan company, US company, or both) — decides payment providers (Release 2).
3. Final price levels, billing period (monthly/annual), and whether self-hosted is priced
   differently (Release 2).
4. Custom domain for each client's portal — needed at launch?
5. Native app store apps later, or installable web app only?

---

## 20. Licensing and protection of the self-hosted version **[New]**

### 20.1 Principle
Code installed on a client's server cannot be made impossible to copy. Protection is layered
so that copying is hard and not worth it:

| Layer | What it does |
|---|---|
| **Signed license key** | Contains client ID, plan, modules (Inventory / Client Portal / AI), limits (bottles, orders per month, staff users), issue and expiry dates, bound server ID. Signed with MyWineCorks' private key (Ed25519) held only in HQ; app verifies with the embedded public key. Cannot be forged or extended. |
| **Daily check-in ("phone home")** | App sends license ID, server ID, version, counts (bottles, orders, users) — no wine, customer or price data. Receives renewed keys, revocations and update notices. |
| **Cloud-only services** | Customer portal, AI gateway and updates require a valid, checked-in license. A copied install loses them. |
| **Server binding** | Key bound to one installation ID (+ hardware fingerprint). Transfer to a new server via HQ or self-service (max 2 per year). Same key seen on two servers → alert in HQ, second one blocked. |
| **Compiled build** | Ship bundled, minified and obfuscated code (server compiled to a single executable / bytecode); no source in the installer or Docker image; integrity check at start-up. |
| **Legal** | End-user licence agreement (no copying, modifying, reselling, reverse engineering), copyright notices, MyWineCorks trademark. |

Cloud clients use the same license record, managed automatically by HQ.

### 20.2 Limits enforced by the key
- Bottle count and orders per month: warn at 90%; at 100% new bottles/orders are blocked
  until upgrade (existing data unaffected).
- Modules not in the plan are hidden (e.g. no Client Portal on an Inventory-only plan).

### 20.3 Offline tolerance
Self-hosted servers may be offline. Check-in failures allowed for **30 days**; warnings from
day 7. After 30 days without check-in the app behaves as expired (§20.4) until it checks in
or an offline license file is uploaded.

### 20.4 Expiry and strict lock
| When | What happens |
|---|---|
| 30, 14, 7, 1 days before expiry | In-app banner for Owner/Admin + email to client |
| Expiry → +14 days (grace) | Everything works; red banner on every screen |
| After grace — **Locked** | All staff sign-in blocked except Owner; mobile apps stop; customer portal shows "temporarily unavailable"; portal sync and AI stop. Owner sees only the **License screen**: renew online, enter/upload new key, contact MyWineCorks, and **Export my data** (Excel + database). |
| Renewal | HQ issues a new key; app picks it up at next check-in (within minutes) or Owner pastes/uploads it; unlocks immediately. |

Data is never deleted by locking. Export stays available to the Owner because the data
belongs to the client (legal and goodwill reasons) — confirmed 2026-11-25.

### 20.5 Key delivery
- Online: automatic via check-in.
- Offline: license file (`.mwclicense`) downloaded from HQ/client account page, uploaded by Owner.

---

## 21. MyWineCorks HQ — back office **[New]**
Separate web app at `hq.mywinecorks.com`, for MyWineCorks staff only.

### 21.1 Release 1
| Module | Functions |
|---|---|
| **Clients** | Company, contacts, country (TW/US), language, notes, status: lead · trial · active · past due · locked · cancelled |
| **Subscriptions (manual)** | Plan, modules, limits, start/renewal dates, billing period; record invoice and payment received (bank transfer, cheque, manual card) |
| **Licenses** | Issue, renew, extend grace, revoke, transfer server, download license file; view key contents |
| **Installations** | Every self-hosted install: version, last check-in, usage vs limits, server ID; alerts for missed check-ins, duplicate keys, near limits |
| **Cloud workspaces** | Create, suspend, restore backup, export, close and delete (with waiting period) |
| **Support access** | View a client's workspace only when the client grants time-limited access from its Settings; every action logged and visible to the client |
| **Releases** | Versions, release notes (zh/en), update channels (stable/beta), minimum supported version |
| **AI usage** | Usage and cost per client; per-plan caps |
| **Leads** | Demo/trial requests from the website; convert to client |
| **Email** | Templates (zh/en): welcome, license issued, renewal reminders, locked, trial ending |
| **HQ staff & roles** | Super Admin, Sales, Support, Finance, Read-only; 2-step verification required; sessions; audit log of all HQ actions |
| **Reports (basic)** | Clients by status/plan/country, renewals due in 30/60/90 days, installs out of date |

**First account:** `jammy.li@getfocus.com` as Super Admin, created by a one-time setup
link; sets own password and 2-step verification at first sign-in. No default password in code.

### 21.2 Release 2
Online payments and recurring billing, card on file (tokenised by provider; we never store
card numbers), automatic invoices/receipts and Taiwan e-invoice, refunds, dunning, coupons,
upgrades/downgrades with proration, trial management, revenue reports (MRR, churn, conversion).

---

## 22. Website — mywinecorks.com **[New]**
| Page | Release 1 | Release 2 |
|---|---|---|
| Home | Product story, screenshots, cloud vs self-hosted | — |
| Features | Inventory, prices, orders, mobile scan, client portal, AI | — |
| Pricing | Plans described, "contact us for pricing" | Live prices, plan comparison, monthly/annual toggle |
| Request demo / trial | Form → HQ lead | 2-week trial on request, card upfront |
| Order / checkout | — | Choose plan → account → card payment → cloud workspace created or self-hosted key + download sent |
| Client account | Sign in to download installer and license file | Billing, invoices, card, plan changes |
| FAQ, About, Contact, Terms, Privacy, Licence agreement | ✓ | ✓ |

Bilingual zh-TW / en with language switch; brand per §16; SEO for the marketing pages only
(the client app and portals are never indexed).

---

## 23. Pricing model (to finalise in Release 2) **[New]**
Dimensions agreed:
1. **Bottle count** — tiers by bottles in stock.
2. **Order transactions** — orders per month included; above that, next tier or per-order fee.
3. **Modules** — *Inventory* (inventory, prices, orders, mobile) or *Inventory + Client Portal*.
4. Deployment — cloud or self-hosted (open question 3).

The license key (§20.2) already carries these limits so Release 1 works with manually set plans.
