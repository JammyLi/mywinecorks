# What a client costs us (input for the price list)

Estimates from 27 Nov 2026. They are based on our own load test (100,000 bottles → 65 MB database), the
first client's Excel (about 8 bottles per wine) and list prices on that date: AWS Lightsail and S3
Tokyo, and the Claude API. Check them against the real AWS bill and HQ › AI usage after the beta.

## 1. Fixed platform cost (no matter how many clients)

| Item | US$ / month |
|-|-|
| Cloud server for client workspaces (Lightsail 8 GB, 160 GB SSD) | 44 |
| HQ + portal service + AI gateway (Lightsail 4 GB) | 24 |
| PostgreSQL for HQ, portal and AI gateway (managed, small) | ~15–30 |
| S3 for Litestream backups, email sending, monitoring | ~15–25 |
| **Total** | **≈ 100–125** |

One 8 GB server holds dozens of small workspaces (one SQLite file each). Add a second one when it
passes about 70 % CPU or disk.

## 2. Space per workspace

| Bottles | Wines (÷ 8) | Database | Photos now (2 × 3 MB per wine) | Photos after B2 (2 × 0.3 MB) |
|-|-|-|-|-|
| up to 5,000 | 625 | ~5 MB | 3.8 GB | 0.4 GB |
| 5–10K | 1,250 | ~10 MB | 7.5 GB | 0.8 GB |
| 10–25K | 3,125 | ~25 MB | 19 GB | 1.9 GB |
| 25–50K | 6,250 | ~50 MB | 38 GB | 3.8 GB |
| over 50K (100K) | 12,500 | ~100 MB | 75 GB | 7.5 GB |

The database is always small. **Space is almost all photos**, and it depends on wines and photos rather
than bottles. Backups roughly double it, but they sit in S3 at US$0.025/GB, so they cost cents.

## 3. Marginal hosting cost per cloud workspace (after B2)

Share of the server (CPU, RAM and SSD at about US$0.28/GB) plus backups and transfer:

| Bottles | US$ / month |
|-|-|
| up to 5,000 | ~1 |
| 5–10K | ~2 |
| 10–25K | ~3 |
| 25–50K | ~5 |
| over 50K | ~8 |

Without B2 the big tiers use 10× the SSD (the 100K tier alone needs half a 160 GB server), so build B2
before selling cloud to large cellars.

## 4. AI cost (Claude API, Sonnet 5.5 at US$2 in / US$10 out per million tokens)

| Use | Tokens (approx.) | US$ each |
|-|-|-|
| Read a label (front + back photo) | ~5,000 in / 600 out | ~0.016 |
| Read a merchant invoice (1–2 pages) | ~8,000 in / 1,500 out | ~0.03 |
| Ask your cellar (one question) | ~10,000 in / 800 out | ~0.03 |
| Portal search by a customer (Haiku 5.5) | ~3,000 in / 300 out | <0.001 |

The monthly cap per license (default 3 M tokens) limits what one client can cost us to about **US$8 a
month**. AI costs the same for local and cloud clients, because all AI goes through our gateway.

## 5. What this means for the price list

- **Price by bottle tier, not by GB.** Clients understand bottles; our real cost difference between tiers
  is small (US$1–8), so the tiers mainly reflect value and support load.
- **The real costs are support, AI and the fixed platform**, not storage. Price the cloud add-on to cover
  the fixed ~US$100–125 per month across your first clients, plus support time.
- **AI as an add-on with an included allowance** (e.g. 3 M tokens ≈ 200 label reads a month), with a
  higher allowance on the big tiers.
- Most collectors have fewer than 2,000 bottles (the first client has 1,026), so consider a lower first
  tier (e.g. up to 2,000) for the Collector plan.
- Local (own server) costs us only HQ, updates, AI and support, so its price can sit below cloud by
  roughly the hosting share and our backup responsibility.

## 6. Draft price list (27 Nov 2026 — structure agreed, numbers to be finalised by Jammy)

NT$ per month, billed yearly. Base price includes running on the client's own PC, updates and email support.

| Bottles | Collector | Merchant | Merchant + Portal |
|-|-|-|-|
| up to 2,000 | 390 | 1,290 | 1,990 |
| 2,000–5,000 | 590 | 1,790 | 2,690 |
| 5,000–10,000 | 890 | 2,490 | 3,490 |
| 10,000–25,000 | 1,290 | 3,490 | 4,690 |
| 25,000–50,000 | 1,890 | 4,690 | 5,990 |
| over 50,000 | quote | quote | quote |

Add-ons: cloud +300 (≤10K bottles) / +600 (above); AI with our key +390 (≈200 label reads a month) or
+990 (heavy use); AI with the client's own Claude key free (assumed, not yet confirmed); monthly billing
+20 %; optional one-time setup and import NT$3,000 (collector) / NT$8,000 (merchant, on-site).
Limits: users 2 / 5 / 10; orders none / 200 / 500 a month.
Competitor anchors on 27 Nov 2026: CellarTracker US$160 (≤1,000 bottles) to US$500 (>2,500) a year;
InVintory Prestige US$99.99 a year; Digiwin A1 cloud inventory NT$800 a month.
