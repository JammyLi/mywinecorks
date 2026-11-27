# Things only Jammy can do

Claude adds to this list whenever a milestone leaves something that needs you (an account, a
purchase, a decision, a test on real hardware). Tick items off here when done.

## Soon

- [x] ~~Activate the license on your Mac copy~~ — done 27 Nov (HQ set up, key issued and activated).
- [ ] **Delete `apps/hq/.q.mjs`** on your Mac (a leftover file from my check; not part of the code).
- [ ] **Field test the phone app (M3)** in a real cellar with no signal: scan, move, stock-out,
      stocktake offline, then sync back at the office.

## Before the first real client install

- [ ] **Buy a Windows code-signing certificate** (BUILD-PLAN decision 5). Without it Windows shows
      "Windows protected your PC" when the installer runs.
- [ ] **Create the production HQ signing key:** `pnpm --filter @mwc/hq gen-signing-key <folder outside
      the repo>` → put `license-signing.pem` in the HQ secret store (`LICENSE_SIGNING_KEY`), delete the
      file, commit `installer/keys/hq-license-public.pem`. Release builds accept no license until this
      is done.
- [ ] **Finish the customer portal test** (started 27 Nov: portal on, customer J6212 invited, catalog
      made). Next: on your phone, sign in as the customer, browse, send a request, and check it arrives
      as a draft order in Orders.
- [ ] **Read the three manuals** and tell me what is unclear: HQ › 使用手冊, the website `/manual/`,
      and the portal's 使用說明 (`/my-cellar/help`).
- [ ] **Backup to a file / folder and restore from it:** development item B1 in `docs/BACKLOG.md`.
      Meanwhile on your Mac, set the second copy folder in Settings › Updates & backups (none set yet).
- [ ] **Try "Update now" once on a real Windows PC** (CI tested install / upgrade / uninstall, not the
      in-app update on Windows).

## Before the cloud version / going live

- [ ] **Choose the cloud provider and regions** (BUILD-PLAN decision 2; default AWS Tokyo + US-West).
- [ ] **Create an S3-compatible bucket** for Litestream backups and its access key
      (`installer/cloud/.env.example`).
- [ ] **DNS and email sending** (domain MyWineCorks.com: bought ✓) (BUILD-PLAN decision 3; default Cloudflare DNS + Postmark or
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

## Beta with the first client (M10) — see `docs/BETA.md`

- [ ] **Decide own server or cloud** for the first client.
- [x] ~~Send me their Excel inventory~~ — done 27 Nov; rehearsal matched (129 wines, 1,026 bottles).
- [ ] **Answer the 5 Excel questions** from the rehearsal: merchant name spellings (安迪酒藏/安迪,
      吉興/吉星, 歐選/歐地; is 永興 a merchant; 17 rows without one), what "V01" means in 酒窖 (12 rows),
      location 右下 (row 103), vintages for rows 70 and 97, the missing market price on row 127; and
      whether to strip the producer from wine names on import.
- [ ] **Training and cut-over day** on site (≈ 2 hours + the evening of the move).
- [ ] On their server: **set the second backup copy** (Settings › Updates & backups) to a NAS or USB
      drive — and check now and then that "last copied" is recent.
- [ ] After a week or two: **restore a backup on a spare PC** once (manual › Running your own server).
- [ ] After 4 good weeks → I tag 1.0.0.
- [ ] Before public launch: an **outside penetration test** of the cloud on a staging copy.
- [ ] Cloud: run `installer/cloud/restore-drill.sh` monthly once the cloud is live.

## Website (M9)

- [ ] **Decide the price list** (plans × bottle tiers, cloud and AI add-ons) — cost model in
      `docs/PRICING-COSTS.md`; then I update the pricing page and HQ plan names.
- [ ] **Support videos** (backlog B3): record short screen videos per function; I write the scripts first.
- [ ] **AI pricing decision** (backlog B4): AI add-on price, and whether "bring your own Claude key"
      costs anything.
- [ ] **Read the website copy** (both languages) and tell me what to change — especially the
      claims on the home, features, pricing and about pages, and the plan names (Collector /
      Merchant / Merchant + Portal).
- [ ] **Legal pages:** have the terms, privacy notice and software licence agreement checked by a
      lawyer (Taiwan and US); tell me the company's legal name and address to put in them. Until
      then they show a "draft" note (build with `PUBLIC_LEGAL_REVIEWED=1` to remove it).
- [ ] **Contact email:** create e.g. hello@mywinecorks.com and set `PUBLIC_CONTACT_EMAIL`; replies to
      website requests come from `MAIL_FROM` in HQ, so that mailbox should exist too.
- [ ] **Publish the site** (needs the domain, decision 3): a static host such as Cloudflare Pages
      (build `pnpm --filter @mwc/website build`, folder `apps/website/dist`, env `SITE`,
      `PUBLIC_HQ_URL=https://hq.mywinecorks.com`). In HQ set `WEBSITE_URL=https://mywinecorks.com`.
- [ ] **Publish the Windows installer for clients** once it is code-signed:
      `pnpm --filter @mwc/hq publish-download MyWineCorks-Setup-<ver>.exe --kind windows --version <ver>`.
      Docker for Mac / NAS clients needs an image registry first (e.g. Docker Hub or GitHub Packages —
      decide which).
- [ ] **Real photos (optional):** the site uses app screenshots; a few photos of a real cellar or
      labels would help the home page.

## AI (M8)

- [ ] **Claude API key:** in the Claude Console (console.anthropic.com, Getfocus organisation; a
      Max/Team plan's monthly API credit can be used by linking it) create a key per environment and
      put it in `apps/ai-gateway/.env` as `ANTHROPIC_API_KEY=…` on your Mac (never in chat or git).
      Until then every AI feature answers with fixed examples.
- [ ] **Accuracy test sets:** collect about **100 real label photos** (front + back) and **20–30 real
      merchant invoices** (PDF or photo) with the correct answers; I will turn them into test cases in
      `apps/ai-gateway/eval/private/` (kept out of git) and tune the prompts until labels reach ≥ 90 %
      correct fields (BUILD-PLAN M8 exit check).
- [ ] **Issue licenses with the AI module** in HQ for clients who should have AI (trial installs have
      none). Decide the monthly token allowance per plan (default 3 M tokens ≈ a few hundred label
      reads).
- [ ] **Deploy the AI gateway** (`apps/ai-gateway`, PostgreSQL) at `ai.mywinecorks.com` with the API
      key, the HQ public key (`LICENSE_PUBLIC_KEYS`) and two random tokens: `AI_SERVICE_TOKEN` (same
      value in portal-service) and `AI_ADMIN_TOKEN` (same value in HQ, with `AI_URL`). On your Mac
      `./scripts/start.sh` creates these tokens by itself.

## Later

- [ ] **Optional: a GitHub token for Claude** so it can open pull requests and read CI logs itself
      (`gh auth` currently fails in Claude's workspace; pushing works).
- [x] ~~Move your brother's MyWines data~~ — not needed: MyWines was only a test; he starts from his Excel (see Beta).
