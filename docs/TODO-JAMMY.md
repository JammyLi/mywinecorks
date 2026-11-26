# Things only Jammy can do

Claude adds to this list whenever a milestone leaves something that needs you (an account, a
purchase, a decision, a test on real hardware). Tick items off here when done.

## Soon

- [ ] **Activate the license on your Mac copy** (from M5). Your copy started a 14-day trial when it
      first ran 0.5.0 on 26 Nov — activate by about **10 Dec 2026** or it locks:
      open http://localhost:3700/setup?t=… (link in `apps/hq/data/setup-link.txt`) → set the HQ
      password and 2-step code → add a client → subscription → "Issue license key" → paste it in the
      app under Settings › License.
- [ ] **Delete `apps/hq/.q.mjs`** on your Mac (a leftover file from my check; not part of the code).
- [ ] **Pull the latest code** on your Mac: stop the app (Ctrl+C), `git pull`, `pnpm install`,
      `./scripts/start.sh`.
- [ ] **Field test the phone app (M3)** in a real cellar with no signal: scan, move, stock-out,
      stocktake offline, then sync back at the office.

## Before the first real client install

- [ ] **Buy a Windows code-signing certificate** (BUILD-PLAN decision 5). Without it Windows shows
      "Windows protected your PC" when the installer runs.
- [ ] **Create the production HQ signing key:** `pnpm --filter @mwc/hq gen-signing-key <folder outside
      the repo>` → put `license-signing.pem` in the HQ secret store (`LICENSE_SIGNING_KEY`), delete the
      file, commit `installer/keys/hq-license-public.pem`. Release builds accept no license until this
      is done.
- [ ] **Try the customer portal on your own phone** (invite yourself as a customer): sign in,
      browse, send a request, see it arrive as a draft order.
- [ ] **Try "Update now" once on a real Windows PC** (CI tested install / upgrade / uninstall, not the
      in-app update on Windows).

## Before the cloud version / going live

- [ ] **Choose the cloud provider and regions** (BUILD-PLAN decision 2; default AWS Tokyo + US-West).
- [ ] **Create an S3-compatible bucket** for Litestream backups and its access key
      (`installer/cloud/.env.example`).
- [ ] **Domain, DNS and email sending** (BUILD-PLAN decision 3; default Cloudflare DNS + Postmark or
      SES): `hq.mywinecorks.com`, `app.mywinecorks.com`, and an SMTP account (`SMTP_URL`) so license,
      reminder and welcome emails are actually sent.
- [ ] **Deploy HQ** with a real PostgreSQL database (`DATABASE_URL`) and the production signing key.
- [ ] **Deploy the cloud server** (`installer/cloud`) and give HQ its address and token
      (`CLOUD_URL`, `CLOUD_PROVISION_TOKEN`).
- [ ] **Deploy the customer portal service** (`apps/portal-service`, PostgreSQL) at
      `portal.mywinecorks.com` with its production keys (`PORTAL_KEYS`) and the HQ public key
      (`LICENSE_PUBLIC_KEYS`); later a wildcard DNS record for `<client>.mywinecorks.com`
      (SPEC open question 4: custom domains at launch?).
- [ ] **Decide: customer sign-in** — keep email + password, or also magic links / LINE login
      (needs email sending first).
- [ ] **Check the alcohol-sale wording** in the portal (age confirmation, licence confirmation,
      "request, not a purchase") with someone who knows Taiwan / US rules.

## Later

- [ ] **Claude API key for the AI gateway** (M8; Getfocus account, separate key per environment).
- [ ] **Optional: a GitHub token for Claude** so it can open pull requests and read CI logs itself
      (`gh auth` currently fails in Claude's workspace; pushing works).
- [ ] **Move your brother's real MyWines data** when MyWineCorks replaces MyWines (M10 beta).
