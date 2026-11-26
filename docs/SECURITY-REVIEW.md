# Security review (M10, 26 Nov 2026)

Scope: the client server (`apps/server`), web app and phone screens, customer portal and portal
service, HQ, AI gateway, website, installers and the release/update path. Method: reading the code
for each area below, `pnpm audit`, and new automated tests (`apps/server/test/security.test.ts`,
`backup.test.ts`, the permissions and visibility tests). Not done: an outside penetration test
(see "Still to do").

## Fixed in this milestone

| # | Finding | Risk | Fix |
|---|---|---|---|
| 1 | Dependencies with known issues: zod < 4.6.6 (memory exhaustion on huge collections), nodemailer < 9 (header injection; 4 advisories), astro < 7.4.13 (dev-server file read and others), uuid via exceljs, vite/esbuild in vitest 3 (dev only) | high | zod 4, nodemailer 10, astro 7, vitest 4, `uuid` override. `pnpm audit` now reports nothing; CI fails on any new high/critical advisory in shipped packages |
| 2 | No CSRF guard beyond `SameSite=Lax` cookies; portals and the app share the parent domain in the cloud, so "same-site" is wider than one app | medium | Every non-GET API request must come from this app's own origin (when the browser sends `Origin`) and carry a body type a plain HTML form cannot send (JSON, or raw bytes for uploads). 403 / 415 otherwise. HQ already required JSON; portal cookies are `Strict` |
| 3 | No Content-Security-Policy | medium | CSP on the app, portal service and HQ: own scripts, styles, images, fonts and API only; no framing (`frame-ancestors 'none'`), no plugins, no `<base>` tricks. HSTS on the cloud (real certificate) |
| 4 | Oversized request bodies answered 500 (server, HQ, portal service) | low | 413 `fileTooLarge`; malformed JSON 400 — no stack traces |
| 5 | Photos: the declared type was checked, the bytes were not | low (served with `nosniff` and an image type, no SVG accepted) | The first bytes must match the declared image type |
| 6 | Sign-in: each account locks after 5 wrong passwords, but one address could try many accounts | low | Also 30 sign-ins / 15 minutes per address (setup links: 20) |
| 7 | Search engines could index the app, portals and services | low (all need sign-in) | `X-Robots-Tag: noindex` everywhere except the website |
| 8 | Report SQL built a date into a string (`priceAt`) — server-generated today, but one careless call away from injection | low | Strict `YYYY-MM-DD` check |
| 9 | Restoring a backup would have handed out wine / bottle / case numbers again, so a printed label could point at a different bottle | medium (data integrity) | Counters keep the highest value of before and after the restore (test) |
| 10 | Cloud backups: the pinned Litestream (`0.5` floating tag, then 0.5.2) ignored the `dir:` entry — new workspaces were **not** being backed up | high (data loss) | Pinned to 0.5.8, verified by the restore drill (`installer/cloud/restore-drill.sh`) |
| 11 | Self-hosted backups only lived on the server's own disk, without the photos | high (data loss on disk failure) | Daily backups (kept 7), a second copy to another folder (NAS / USB / share) including photos, with "last copied" and errors shown to the Owner |

## Checked and found in order

- **Permissions in the API, not the UI.** Every route declares a guard; the permissions test walks
  all routes; every DELETE / merge / clear is Owner-only. New: a sweep logs in as a role with every
  function but no cost / merchant visibility and calls **every GET endpoint** with real ids — none
  returns the cost or the merchant (36+ endpoints).
- **Customer portal isolation** (§9.3): only public wine facts, the customer's own price and
  availability leave the server; tests check cost, merchants, locations, bottle/case numbers and
  other customers never appear, also in AI requests.
- **SQL**: all values are bound parameters; the remaining `${…}` pieces in SQL text are fixed
  fragments, whitelisted sort/group keys or ids from the database (reviewed one by one).
- **Passwords** argon2id; session, setup, invite, sign-in-link and file tokens are random and stored
  only as SHA-256; 2-step sign-in for every staff user; password change and reset end other sessions.
- **Files**: photo and download paths are built from database values, never from request paths;
  backup names must be one of the listed backups (`..` refused, test).
- **Signed things**: licences and update packages are Ed25519-signed by HQ; packages are checked
  (signature, size, SHA-256) before they are unpacked; portal and AI gateway calls are signed with
  the workspace key over method, path, time and body hash; service and admin tokens compared in
  constant time.
- **Secrets**: none in the repository (checked); `.env` ignored; no default passwords; the first
  account always comes from a one-time link.
- **AI**: the gateway alone holds the API key; prompts treat photo / message text as data; outputs
  are schema-checked; Q&A tools run on the client server with the asking user's permissions; usage
  capped per licence.
- **Website**: no cookies or trackers; client account answers the same for unknown emails; links
  are one-time and short-lived; CORS only for the website's own origin.

## Accepted for now (and why)

- **Office network uses plain HTTP on port 3500** for desktop browsers (phones use HTTPS on 5543
  with the server's own certificate). Inside an office LAN this is common, but passwords cross the
  network unencrypted. Recommendation in the manual: use the HTTPS address where possible. A later
  release can make HTTPS the default for desktops too.
- **Rate limits are in memory** — fine for one server process (self-hosted and today's cloud); a
  multi-process cloud would need a shared store.
- **TOTP codes can be reused within their 30-second window.** Low risk with passwords + lockout.
- **TOTP secrets are stored unencrypted in the workspace database.** Anyone who can read that file
  can read everything else too; encrypting them would need a key outside the database.

## Still to do (Jammy)

- An **outside penetration test** of the cloud before public launch (staging environment).
- Production **signing keys** on an offline machine (already in TODO-JAMMY), and the **code-signing
  certificate** for the Windows installer.
