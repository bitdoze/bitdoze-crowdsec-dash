# Benchmarks (Phase 12)

Measured with `npm run bench` — a real built server on a scratch data dir,
real WAL-mode SQLite, deterministic fixtures. **These are query/ingest-level
numbers on one host, not a production-capacity claim.** Re-run on your own
hardware (`BENCH_SCALE=2 npm run bench` for a larger fixture).

## Environment of record

- Host: linux x86_64, AMD EPYC-Rome ×8, 16 GiB RAM, Node 24.17
- Storage: local disk, SQLite via libsql file client, WAL + busy_timeout=5000
- Fixture: 25 sites, 5000 alerts, 10000 decisions, 2000 notification events

## Measured results (BENCH_SCALE=1)

| benchmark                 |         n |    ms |     ops/s | note                                              |
| ------------------------- | --------: | ----: | --------: | ------------------------------------------------- |
| alert.insert (batch 100)  |      5000 |  ~455 | ~11,000/s | WAL, 100-row transactions                         |
| alertSite.insert          |      5000 |  ~350 | ~14,000/s | attribution rows alongside alerts                 |
| alerts.list (filter+page) | 200 reads |   ~75 |  ~2,600/s | `WHERE scenario… AND started_at>…` + LIMIT/OFFSET |
| alerts.byScenario         |        50 |   ~45 |  ~1,100/s | GROUP BY scenario over 24h                        |
| activity.rollup           |        50 |   ~85 |    ~600/s | hourly bucket scan over 7d                        |
| site.attribution join     |        50 |  ~155 |    ~320/s | alert_site ⋈ site grouped                         |
| decision.insert           |     10000 |  ~700 | ~14,500/s | WAL, 200-row transactions                         |
| edge.candidateSelect      |        50 | ~4100 |     ~12/s | full projection scan, 10k rows → ~82ms each       |
| edge.diff (memory)        |        10 |   ~45 |    ~220/s | 10k decisions × 10k list items, set diff          |
| notification.upsert       |      2000 | ~3200 |    ~630/s | insert-or-bump, one statement per event           |
| outbox.dueSelect          |        50 |   ~20 |  ~2,800/s | the dispatcher's due-row JOIN over 2000 rows      |
| retention.alertDelete     |         1 |   ~13 |         — | 2500 aged rows deleted                            |
| GET /healthz              |       300 | ~1150 |    ~260/s | warm, sequential, local                           |
| GET /login (render)       |       100 |  ~830 |    ~120/s | real Svelte render path, sequential               |

## Interpretation and limits

- **Alert ingest** is bounded by transaction round-trips, not SQLite: ~11k
  rows/s in 100-row batches. The real sync path adds LAPI fetch + JSON parse
  on top — those dominate before the DB becomes the limit.
- **`edge.candidateSelect` (~82ms at 10k decisions)** is the one slow shape:
  it returns every live local decision each reconcile. A composite index
  `decision(expired, origin)` ships in migration 0011 — the bench fixture has
  ~100% matching rows so it measures materialization, not planning; on real
  mixed data the index engages. At 15-minute reconcile cadence the scan is
  comfortably cheap up to ~50k decisions; beyond that consider a cursor.
- **notification.upsert ~630/s** reflects the per-event read-then-write
  recordEvent pattern; bursty alert storms are already deduped upstream by
  `event_key` so this is not the hot path.
- **HTTP numbers** are sequential single-connection on loopback — they show
  route cost (~3–8ms warm), not concurrency headroom. The dashboard is a
  single-process SQLite app; it does not need multi-replica benchmarking.
- **db size** for the full fixture: ~3 MiB. Retention keeps this bounded; the
  default TTLs are the sizing knob, not query speed.

## Not measured (be honest about these)

- Concurrent multi-user HTTP load (single-admin tool; nothing to measure).
- Real-network LAPI latency — mock fixtures only.
- 100k+ row tables — extrapolate linearly at your own risk; re-run with
  `BENCH_SCALE=10` before claiming it.
