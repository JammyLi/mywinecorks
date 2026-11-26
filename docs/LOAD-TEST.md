# Load test — 100,000 bottles (M10)

Run it yourself: `pnpm --filter @mwc/server loadtest` (options `--bottles 100000 --runs 5 --keep`).
It builds a workspace in a temporary folder and times the requests people use most, through the
real HTTP API. It fails if a median is over its budget.

**Data:** 100,000 bottles (95 % in stock) of 5,000 wines in 10,000 original cases and loose, across
3 cellars › 30 lockers › 300 racks; 3 market prices per wine; 500 customers (100 on the portal with
every wine in their catalog); 3,000 past orders; a change log of 200,000 entries. Database: 65 MB.

**Machine:** a 2-core cloud VM (Xeon 2.1 GHz), Node 22 — slower than a typical office PC.

## Results (26 Nov 2026, version 1.0.0-beta.1)

```
request                                       median     max  budget   size
✓ Overview (dashboard)                         271ms   331ms   500ms   1 KB
✓ Search, no filter (page 1)                   261ms   315ms   800ms   14 KB
✓ Search by keyword                            119ms   138ms   800ms   14 KB
✓ Search type + vintage + price                 48ms    49ms   800ms   15 KB
✓ Search by case view                          435ms   448ms   800ms   12 KB
✓ Filter counts (facets)                       199ms   218ms  1500ms   7 KB
✓ Filter options                                 5ms     6ms   500ms   18 KB
✓ Wine detail                                    3ms     8ms   300ms   8 KB
✓ Case detail                                    3ms     3ms   300ms   1 KB
✓ Scan a bottle code                             1ms     2ms   200ms   0 KB
✓ Storage tree                                 169ms   185ms   800ms   37 KB
✓ Collection value report                     1326ms  1536ms  3000ms   2 KB
✓ Sales report                                  44ms    64ms  1500ms   0 KB
✓ Orders list                                   32ms    32ms   500ms   113 KB
✓ Customer detail                                4ms     8ms   500ms   5 KB
✓ Drinking windows                              81ms    89ms  1500ms   719 KB
✓ Overview suggestions                          59ms    72ms  1500ms   0 KB
✓ Phone offline snapshot                       477ms   477ms  5000ms   10547 KB
✓ Export 1,000 wines to Excel                  542ms   542ms 10000ms   139 KB
✓ Portal snapshot (all wines, 100 customers)   885ms   885ms 10000ms   37944 KB
```

## What the test found and what changed

| Found | Before | After | Fix |
|---|---|---|---|
| Sales report | 5.1 s | 0.04 s | One date formatter for all lines instead of one per line; index on `order_bottles(line_id, state)` and `orders(status, shipped_at)` |
| Filter counts with a type, region or country chosen | 5.9 s | 0.2 s | Indexes on `wines(type_code)`, `wines(region)`, `wines(country)`, `bottles(rack_id, status)` so the counts start from the bottles |
| Portal snapshot (5,000 wines × 100 customers) | 10 s | 0.9 s | Catalog wines and prices read once per sync instead of once per customer and wine |
| Default price of a staff order line for a portal customer | built the customer's whole catalog per line | one catalog lookup | `catalogPriceFor` works out one wine only |
| Portal sync size | 38 MB every 3 minutes | compressed (~10×), and only requests/acks when nothing changed (full copy at most hourly or after a change) | gzip + "unchanged" snapshots |
| Phone offline snapshot | 10.5 MB | about a tenth on the wire | HTTP compression on all server responses |
| Change-log entries of a wine or case | full scan of the log | index | `audit_log(obj_type, obj_id)` |

## Notes

- Everything a person waits for is under half a second except the collection value report
  (1.3 s: twelve month-end valuations of every bottle) — acceptable for a report.
- The phone offline snapshot is large by design (every bottle in the user's cellars) and is
  downloaded only when a phone syncs.
- Migration 9 adds the indexes; existing databases get them automatically at the next start
  (backed up first).
