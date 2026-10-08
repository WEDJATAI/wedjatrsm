# R31 Stress Audit — Friday-Rush Load Simulation (Task ID: 2-b)

- **Date:** 2026-10-02, 11:13–11:16 UTC (suite) + post-test verification
- **Target:** LIVE dev server `http://localhost:3000` (Next.js 16 dev, `next dev -p 3000`, PID 1100, untouched/not restarted)
- **DB:** local SQLite `db/custom.db` via Prisma (the same live instance the dev server serves)
- **Auth:** Bearer admin token from `/tmp/rsm-tok-manager-login.txt` (never printed)
- **Harness:** `scripts/r31-stress.ts` (NEW, this task) — `NODE_ENV=production bun scripts/r31-stress.ts`
- **Integrity:** `scripts/r31-integrity.ts` (NEW, this task) — read-only
- **Load exclusions honored:** zero traffic sent to `/api/hybrid/push`, `/api/sync/*`, `/api/admin/backup`, `/api/cron/*`, `/api/inngest`
- **Write-path product:** briefed **productId 20 was NOT in the active catalog** (`GET /api/products` returns 184 active products; id 20 is a retired demo row, absent from the payload). Substituted **productId 101 "Arabita"** (Pasta, EGP 110, active, sellable, non-stockable, no recipe → zero stock side effects). Recorded in both scripts.

---

## 1. Executive summary

| Metric | Value |
|---|---|
| Total requests (incl. 32 warmup) | **8,190** (8,158 headline) |
| Overall error rate | **42 / 8,190 = 0.51%** — **all 42 on `POST /api/orders`** |
| Write-path (`order_create`) failure rate | **42 / 45 attempts = 93.3%** (3 succeeded) |
| Worst p99 (any endpoint) | **17,082 ms** (`order_create`, phase 2) |
| Worst read p99 under pure reads | 585 ms (`hybrid/status`, phase 1) / 585 ms (`tables/status`, phase 3 burst) |
| Read-path error rate | **0 / 8,116 = 0.00%** |
| Post-test data integrity | **6 / 7 checks PASS; check 1 FAIL — 3 orphan orders** |
| Dev server survival | Survived; healthy after test (`GET /` 39 ms, `/api/products` 20 ms) |

### Verdict vs realistic Friday rush (40-table restaurant ≈ 15–25 terminals)

- **READ fleet (POS catalog, floor status, KDS order polls, categories, hybrid status): PASS.** 8 concurrent terminals for 60 s → 88.9 rps, p50 58–109 ms, p95 ≤ 232 ms, **zero errors**. Even a 24-terminal burst (122.7 rps) produced **zero errors** with p99 ≤ 585 ms. A 15–25-terminal restaurant's polling load is comfortably inside the green zone.
- **WRITE PATH (order rush): CRITICAL FAILURE.** With only **6 concurrent waiters** sending takeaway orders, **42 of 45 creates failed with HTTP 500** and successful creates took p50 ≈ **11 s**. A Friday-rush order rush (multiple waiters firing orders within the same seconds) would be rejected outright on this stack.
- **Reads collapse when writes are in flight:** in the mixed phase, `GET /api/orders` degraded from p50 65 ms / p95 143 ms (pure reads) to p50 230 ms / p95 5.2 s — a waiter's KDS/POS screen would visibly stall during an order rush.
- **DATA INTEGRITY VIOLATED under load:** 3 creates answered **500 AFTER the transaction had already committed** → orphan orders **#335, #336, #337** stuck `status='open'`, totals 0.00 (with committed items), which have already synced to Neon via the outbox (out/acked 1626 → 1645). They appear as phantom open takeaway checks.

---

## 2. Per-phase results

### Phase 0 — Warmup (excluded from headline)

10 sequential GETs each of products / tables/status / orders + **1 create+cancel cycle** (added to warm the write-path compile so first-hit compilation would not pollute phase 2; the created order #333 is recorded as a test order).

| Endpoint | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| GET /api/products | 10 | 45.9 | 91.4 | 91.4 | 91.4 ms |
| GET /api/tables/status | 10 | 16.0 | 39.8 | 39.8 | 39.8 ms |
| GET /api/orders | 10 | 13.4 | 21.1 | 21.1 | 21.1 ms |
| POST /api/orders (single-user write) | 1 | 75.8 | — | — | 75.8 ms |
| POST /api/orders/333/cancel | 1 | 157.3 | — | — | 157.3 ms |

Single-user write path is healthy (~76 ms create / ~157 ms cancel). The collapse below is purely a concurrency effect.

### Phase 1 — Read-heavy, waiter terminal fleet (60 s, 8 workers round-robin)

**5,343 reqs, 88.9 rps, 0 errors.**

| Endpoint | n | p50 | p95 | p99 | max | avg | rps |
|---|---|---|---|---|---|---|---|
| GET /api/products | 1,067 | 72.8 | 143.7 | 353.2 | 818.8 | 85.2 | 17.8 |
| GET /api/tables/status | 1,069 | 69.4 | 162.8 | **565.1** | 850.0 | 84.4 | 17.8 |
| GET /api/orders | 1,069 | 65.3 | 142.9 | 275.8 | 854.8 | 77.8 | 17.8 |
| GET /api/categories | 1,069 | 57.7 | 146.8 | 327.2 | 744.5 | 70.9 | 17.8 |
| GET /api/hybrid/status | 1,069 | 109.4 | 231.6 | **583.1** | 865.1 | 129.4 | 17.8 |

All 2xx/200. `hybrid/status` is the slowest read (p50 109 ms — it aggregates outbox/sync state).

### Phase 2 — Write-path, order rush (45 s deadline, 6 workers; wall 54.6 s for in-flight requests)

**27 reqs recorded, 0.5 rps, 25 errors (all HTTP 500 on create).** Only 1 of 26 creates succeeded.

| Endpoint | n | ok | p50 | p95 | p99 | max | statuses |
|---|---|---|---|---|---|---|---|
| POST /api/orders | 26 | 1 | **10,912** | 16,929 | **17,082** | 17,082 ms | 200×1, **500×25** |
| POST /api/orders/{id}/cancel | 1 | 1 | 140.6 | 140.6 | 140.6 | 140.6 ms | 200×1 |

### Phase 3 — Burst, Friday 8pm spike (10 s, 24 workers alternating)

**1,242 reqs, 122.7 rps, 0 errors.** No socket errors, no 500s, no SQLITE_BUSY surfaced to clients.

| Endpoint | n | p50 | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|
| GET /api/products | 621 | 168.2 | 283.9 | 537.5 | 609.9 | 61.4 |
| GET /api/tables/status | 621 | 193.5 | 322.9 | 584.8 | 596.7 | 61.4 |

Tripling concurrency (8→24) roughly doubled p50 (69→168 ms) and pushed p99 to ~0.6 s — degraded but stable and error-free.

### Phase 4 — Reports under load (15 s, 4 workers round-robin)

**1,414 reqs, 94.2 rps, 0 errors.** The aggregate report queries held up well under continuous concurrent load.

| Endpoint | n | p50 | p95 | p99 | max | rps |
|---|---|---|---|---|---|---|
| GET /api/reports/zreport | 471 | 39.2 | 77.0 | 315.5 | 524.6 | 31.4 |
| GET /api/reports/sales | 471 | 47.9 | 81.9 | 120.8 | 557.9 | 31.4 |
| GET /api/reports/forecast | 472 | 21.1 | 55.1 | 74.3 | 236.4 | 31.4 |

### Phase 5 — KDS+POS mixed, realistic shift (30 s deadline, 10 workers; wall 39.1 s)

**132 reqs, 3.4 rps, 17 errors (again all on create).** 70% orders / 20% products / 10% write cycle.

| Endpoint | n | ok | p50 | p95 | p99 | max | statuses |
|---|---|---|---|---|---|---|---|
| GET /api/orders | 93 | 93 | 230.5 | **5,210.4** | 5,730.2 | 5,730.2 ms | 200 |
| GET /api/products | 20 | 20 | 251.2 | 5,736.9 | 5,736.9 | 5,736.9 ms | 200 |
| POST /api/orders | 18 | 1 | 10,697 | 16,717 | 16,717 | 16,717 ms | 200×1, **500×17** |
| POST /api/orders/{id}/cancel | 1 | 1 | 267.0 | 267.0 | 267.0 | 267.0 ms | 200 |

Key signal: with writes merely *attempted* in the mix, read p95 jumped from ~143 ms (phase 1) to **5.2–5.7 s** — read/write lock contention on the single SQLite file.

---

## 3. Server error log excerpts (dev.log windows per phase)

dev.log: 3,291 lines at suite start → 73,672 at suite end (**+70,381 lines / ~23 MB in 3m08s** — Prisma `log: ['query']` in dev mode; see findings). Phase windows derived from per-phase `wc -l` snapshots recorded by the harness.

- **Phase 0, 1, 3, 4 windows: ZERO matching error lines** (no `error|Error|ECONNRESET|SQLITE_BUSY| 500 ` outside query-log SQL text).
- **Phase 2 window (lines 50,000–50,984) — deduped:**

```
16× [api-error] Error [PrismaClientKnownRequestError]: Socket timeout (the database
    failed to respond to a query within the configured timeout).
10× [api-error] Error [PrismaClientKnownRequestError]:
    Invalid `tx.hybridSyncState.findUnique()` invocation …
    Invalid `tx.hybridEvent.aggregate()` invocation …
    Invalid `tx.hybridEvent.create()` invocation …
10× Transaction API error: Transaction already closed: A query cannot be executed
    on an expired transaction. The timeout for this transaction was 5000 ms,
    however 5,009–10,317 ms passed since the start of the transaction. Consider
    increasing the interactive transaction timeout or doing less work in the transaction.
15× POST /api/orders 500 in 5.3s–16.9s (compile: 4–19ms, render: 5.3–16.9s)
```

- **Phase 5 window (lines 71,807–73,672) — same signature, deduped:**

```
10× [api-error] PrismaClientKnownRequestError: Socket timeout (… configured timeout)
 7× [api-error] Invalid `tx.*` invocation (hybridSyncState / hybridEvent)
 7×  Transaction API error: Transaction already closed … timeout was 5000 ms …
    5,009–5,728 ms passed
 3×  POST /api/orders 500 in 6.0s / 9.6s / 16.0s
```

- **No `ECONNRESET`, no literal `SQLITE_BUSY` string** (Prisma surfaces SQLite lock waits as the socket-timeout error above), **no socket-level errors, no restarts** — the server never died.
- DB pragmas (read-only, post-test): `journal_mode = delete` (NOT WAL), `busy_timeout = 5000` ms.

---

## 4. Post-test data integrity verification (7 checks)

Run ~3 min after the suite by `scripts/r31-integrity.ts` (read-only). Baseline: 160 orders (max id 332), 34 cancelled, 204 payments, outbox `in/applied 1186 · out/acked 1626 · out/dead 1 · out/pending 1`.

| # | Check | Result | Detail |
|---|---|---|---|
| 1 | Order count after == baseline + created (166 == 160+3) | **FAIL** | 166 ≠ 163 → **3 unrecorded orders #335, #336, #337: `status='open'`, totals 0.00/0.00** (creates that answered 500 *after* the transaction committed). Not deleted — kept as evidence per report-only mandate. |
| 2 | Created test orders all `cancelled`; zero payments on them | **PASS** (with orphan note) | Recorded #333/#334/#338 all `cancelled`, 0 payments. Orphans #335–337 also have 0 payments but are stuck `open` with zero totals — impossible live-check state (items committed, totals never computed). |
| 3 | orderItems of created orders exist, quantity > 0 | **PASS** | 3 item rows across the 3 recorded orders, all quantity > 0 (1×/2×/2× Arabita @ 110). Orphan items also present (3×110, 3×110, 2×110). |
| 4 | No pre-existing order lost | **PASS** | Orders with id ≤ 332: 160 of 160 — nothing lost. |
| 5 | Hybrid outbox: no NEW dead events | **PASS** | After: `in/applied 1186 · out/acked 1645 · out/dead 1` — dead-out still exactly the 1 documented p12 collision-guard event; pending 1 → 0 (drained). +19 acked = the test orders' outbox events, **including the 3 orphans, which have now synced to Neon as real `open` orders**. |
| 6 | Money math on created-then-cancelled orders (#333, #334, #338) | **PASS** | All exact: items Σ = subtotal (110 / 220 / 220); VAT 14% (15.4 / 30.8 / 30.8); service 12% (13.2 / 26.4 / 26.4); total = 138.60 / 277.20 / 277.20. (Orphan math is definitionally broken: items exist but subtotal/total = 0.) |
| 7 | Dev server still answers 200 on GET / | **PASS** | HTTP 200 (39 ms; `/api/products` 20 ms, `/api/orders` 14 ms, `/api/hybrid/status` 19 ms post-test). |

**Bottom line: no pre-existing data was lost and no money math is wrong, but the write path violates atomicity under load — failed creates leave phantom `open` orders that propagate to Neon.**

## 5. Created test order ids

Recorded by the harness (also in `/tmp/r31-stress-order-ids.json`):

```
[333, 334, 338]   // 333 = warmup, 334 = phase 2, 338 = phase 5 — all cancelled, kept in DB by design (sync to Neon like the 34 pre-existing cancelled ones)
```

Unrecorded server-side orphans from failed creates (NOT touched — evidence for the lead agent): **#335, #336, #337** (`open`, zero totals, items committed, synced to Neon).

## 6. Memory (leak indicator)

`ps -o rss,vsz,cmd -p $(pgrep -f 'next dev|next-server|bun.*dev' | head -3)` before/after + the `next-server` child specifically:

| When | next-server (PID 1100) RSS | Note |
|---|---|---|
| ~40 min before suite | 1,808,896 KB (1.81 GB) | includes earlier agents' E2E work |
| Suite start | 2,293,816 KB (2.29 GB) | |
| Suite end (peak) | 3,146,440 KB (3.15 GB) | **+853 MB during 3m08s of load** |
| ~10 min after suite | 2,374,704 KB (2.37 GB) | ~770 MB reclaimed by GC; **net +81 MB retained** |

Large transient allocation under load, mostly reclaimed once idle. Not a classic monotonic leak from one run, but RSS never returns to the pre-suite floor and the absolute level (2.4 GB) is heavy — worth a multi-run soak test. Dev-mode Prisma query logging (`log: ['query']` in `src/lib/db.ts`, dev-only) is a major contributor: dev.log absorbed ~23 MB / 70k lines during the suite, and every query log line is synchronous formatting work inside the request path.

---

## 7. Performance findings & bottleneck hypotheses

1. **SQLite is in `journal_mode=delete` (rollback journal), NOT WAL.** In this mode readers block the writer and the writer blocks all readers. Confirmed pragma read: `journal_mode=delete`, `busy_timeout=5000`. This single setting explains both the write convoy and the read collapse to 5.2–5.7 s p95 during mixed load. **Highest-leverage fix candidate.**
2. **Write lock convoy + 5 s Prisma interactive-transaction timeout.** `POST /api/orders` wraps order + items + outbox events in `db.$transaction`; with 6 concurrent writers each transaction serializes on the single SQLite write lock; once total wait exceeds 5,000 ms Prisma kills the transaction → `Transaction already closed` → HTTP 500. Worse, queued writers stack behind a transaction that is already doomed.
3. **Outbox emission lengthens the write critical section.** The failing statements inside the create transaction are `tx.hybridSyncState.findUnique()`, `tx.hybridEvent.aggregate()`, `tx.hybridEvent.create()` (hybrid-sync bookkeeping) — the R30 "outbox rides the same transaction" design is correctness-friendly but multiplies statements inside the exclusive lock window, amplifying contention.
4. **`Socket timeout` = lock waits exceeding the engine's configured timeout** (aligns with `busy_timeout=5000`). No literal SQLITE_BUSY surfaced, but this is the same phenomenon reported by the Prisma SQLite driver.
5. **Create is not atomic end-to-end (the integrity bug).** The order transaction commits, then `recomputeTotals()` + `logAudit()` run *outside* it. Under contention those post-commit steps timed out → client got 500 → but the committed order remained: `status='open'`, `subtotal/total = 0.00`, items present, outbox event emitted (→ synced to Neon). Three such phantoms: #335–337. A retrying POS client would double-send; a non-retrying one leaves a ghost check on the floor.
6. **Read paths scale acceptably for the terminal fleet size** — 8 terminals ≈ 89 rps with sub-250 ms p95; 24-terminal burst ≈ 123 rps, p99 ≤ 585 ms, zero errors; reports (zreport/sales/forecast) stay ≤ 82 ms p95 even hammered at 31 rps each. The platform's Friday-rush risk is concentrated 100% in the write path.
7. **Dev-mode amplifiers (honesty note):** this is `next dev`, not a production build — per-request compile checks, Prisma `log: ['query']` (23 MB of log during the run), and Turbopack memory. Production (`bun run build` + NODE_ENV=production, query logging off) will be faster across the board; the SQLite journal-mode/lock issues, however, are configuration-level and will persist in any packaged desktop deployment using this db file.
8. **Hybrid engine stayed healthy throughout:** outbox drained (pending 1 → 0), no new dead letters (still exactly the 1 documented p12 event), no ECONNRESET against Neon.

## 8. Recommended next actions (for the lead agent — this task is report-only)

1. `PRAGMA journal_mode=WAL` on the local SQLite (+ consider higher `busy_timeout`) — likely converts the write convoy into single-digit-ms contention; must be validated against the hybrid engine + snapshot watcher.
2. Move `recomputeTotals` (and ideally `logAudit`) inside the create transaction, or add a compensating rollback when post-commit steps fail — closes the phantom-order integrity hole.
3. Re-tune the interactive transaction timeout (5 s default) and/or slim the outbox emission path inside hot write transactions.
4. Add an automated "impossible state" monitor (open orders with zero totals) — this test proved it can happen under load.
5. Re-run `scripts/r31-stress.ts` after each fix — the harness + `scripts/r31-integrity.ts` are reusable regression gates (artifacts in `/tmp/r31-*`).

## 9. Artifacts

- `scripts/r31-stress.ts` — stress harness (phases 0–5, per-endpoint percentiles, created-id capture, abort-on-dead-server)
- `scripts/r31-integrity.ts` — 7-check post-test verification (read-only)
- `/tmp/r31-stress-results.json` — full metrics; `/tmp/r31-stress-order-ids.json` — created ids; `/tmp/r31-stress-baseline.json` — pre-test DB baseline; `/tmp/r31-integrity-result.json` — verification output; `/tmp/r31-stress-run.log` — harness stdout
- dev.log windows: phase1 3668–50000, phase2 50000–50984, phase3 50984–60932, phase4 60932–71807, phase5 71807–73672
