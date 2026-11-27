# Third-party services (reviewed 27 Nov 2026)

MyWineCorks is a Getfocus product. **Every account below is owned by Getfocus, not a person:**
- Signed up with a company address (e.g. `it@getfocus.com`).
- Paid with the Getfocus card.
- 2-step sign-in on.
- At least two admins (Jammy and one backup).

## Always running

| Service | Use | Cost (list price, 27 Nov 2026) | Owner set-up |
|-|-|-|-|
| AWS Lightsail, 8 GB instance | Cloud client workspaces | US$44/mo | Getfocus AWS Organization → member account "MyWineCorks" |
| AWS Lightsail, 4 GB instance | HQ, portal service, AI gateway | US$24/mo | same |
| AWS Lightsail managed PostgreSQL | HQ, portal, AI usage databases | US$15/mo standard (US$30 HA) | same |
| AWS S3 (Tokyo) | Litestream continuous backups | US$0.025/GB-month | same |
| AWS SES | Transactional email | US$0.10 per 1,000 (à la carte) | same |
| Cloudflare | DNS, Pages (website), proxy | free | Getfocus Cloudflare account |
| Anthropic Claude API | AI gateway | per use; capped per license (~US$8/client/mo max) | Getfocus organization, "MyWineCorks" workspace |
| Google Workspace | hello@ / support@ mailboxes | existing | Getfocus |
| GoDaddy | Registrar for mywinecorks.com | existing renewal | registrant must be Getfocus |
| GitHub | Code, CI, installer builds | free plan | Getfocus organization (move from JammyLi) |
| **Total before the first client** | | **≈ US$90–120/mo** | |

## When needed

| Service | When | Cost |
|-|-|-|
| Azure Artifact Signing (Windows installer) | First self-hosted Windows client | US$9.99/mo (Basic); check eligibility for a Taiwan company, else a yearly OV certificate |
| Video hosting (B3) | Support centre | to choose |
| Uptime monitoring | Launch | free tier |
| Penetration test, legal review | Before public launch | one-off quotes |
