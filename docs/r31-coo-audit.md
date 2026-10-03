# R31 — COO / Project-Manager / Restaurant-Operations Audit Report

**Platform:** Lilo Cafe and Restaurant — RMS (Restaurant Management System)
**Audit date:** 02 Oct 2026 · **Auditor:** COO / PM / Restaurant-management lead
**Method:** role-by-role end-to-end workflow walkthroughs (browser), full API surface × role matrix (364 probes), five-phase load/stress simulation (3 runs: baseline → mid-fix → final gate), data-integrity forensics, money-math verification, code review of the order lifecycle.
**Verdict headline:** *The platform was functionally excellent and secure, but the order-write path could not survive a real Friday rush (93% create failures at 6 concurrent waiters) and left corrupt zero-total orders that synced to the cloud. Both are now fixed and stress-proven: 10,781 requests, 0 errors, 15.4 creates/sec sustained, zero data loss.*

---

## 1 · Executive summary

| Area | Grade before | Grade after this audit | Why |
|---|---|---|---|
| Feature completeness (22 modules) | A | A | Foodics/Odoo-class scope: POS, KDS, floor plans, reservations, inventory, recipes, stock counts, suppliers/POs, promotions, payroll, attendance, cash drawer, customers/loyalty, vision, hybrid sync, AI copilot, reports (8 kinds), audit log, roles, users, settings, integrations |
| Security (authn/authz) | A | A | 364 probes: **zero bypasses**; PINs masked, no data leaks, SQLi clean, per-role module gating exact |
| Money math | A | A | 14% VAT + 12% service verified exact on every sampled order, receipt, and Z-report; split-tender, tips, refunds, change all correct |
| **Write-path resilience** | **F** | **A** | 6 concurrent waiters → 93% create failures, zombie orders synced to Neon; **now 0 errors at 15.4 creates/s** |
| **Data hygiene** | **D** | **A** | 16 stale/zombie open orders polluting POS floor & KDS; a live table-1 check undercharging EGP 327.60; all repaired via designed channels |
| UX / organization | B+ | B+ | Excellent flows; issues found: payment-button showing full bill after partial payment (fixed), account-level check-issuer chip confusion (documented), stale-order clutter (fixed by data repair; guard recommended) |
| Ops/read path | A | A | 95–113 rps sustained, p95 ≤ 232 ms on the terminal fleet; burst 24-concurrent stable |

**What was fixed this round (all stress-verified, zero data loss):**
1. Partial cash payments were **impossible** (stale-memo bug sent full-bill amount with partial tender → 400). FIXED + browser-verified.
2. Order creation was **non-atomic** (totals written in a 2nd transaction) → zombie open orders with total = EGP 0 that **synced to Neon**. FIXED (single transaction) — 831 stress creates later: zero zombies.
3. SQLite ran in default `journal_mode=delete` with a 5 s engine timeout → write convoy, read starvation, raw 500s. FIXED (WAL + tuned timeouts + app-level write lock + single-connection queueing).
4. 16 stale/zombie orders + one stale live check repaired; order #87 type normalized; POS floor and KDS now clean.
5. Payment button now shows the remaining balance after a partial payment.
6. Developer role can now cancel orders (admin-equivalence); merged orders can no longer be cancelled (merge-trail protection).
7. Dev-mode Prisma query logging (70k lines / 23 MB per 3-min run, measurable latency + memory cost) is now opt-in (`RSM_QUERY_LOG=1`).

---

## 2 · Scope & method

**Roles exercised end-to-end (browser, real clicks):**
- **Waiter (Omar, PIN door + person picker)** — floor → guests → menu (17 categories) → modifier sheet (live price math) → kitchen comment → send → bilingual guest check → split tender → bilingual receipt → table bussing lifecycle.
- **Kitchen (Chef Layla)** — KDS course/station filters, ticket flow New → Preparing → Ready → Served.
- **Manager (Dr Ihab, private PIN door)** — dashboard KPIs, AI briefing entry, all 22 admin modules opened and rendered, Users table (PIN masking, self-protection), Reports date ranges & aggregates.
- **Custom role (مينا — hall manager, 16 permissions)** — launcher restricted exactly to her grants (Vision/Roles/Payroll/Activity/Purchases correctly hidden; Stock Counts/Modifier Groups/Integrations ride parent grants by design).
- **Unauthenticated** — team wall only; no data leakage (names only, no emails/PINs).

**API matrix (364 probes):** every GET route × 5 actors; every mutation route × (no-auth / under-privileged / admin+invalid-body); SQLi-shaped inputs; money-math on sampled paid orders; lifecycle guard code review. Full matrix: `agent-ctx/r31-api-audit.md`.

**Stress simulation (3 runs, live dev server):** read-heavy (8×60 s), write-path (6×45 s), burst (24×10 s), reports-under-load (4×15 s), KDS+POS mixed (10×30 s) + full data-integrity verification after each run. Harness: `scripts/r31-stress.ts` + `scripts/r31-integrity.ts` (reusable regression gates).

---

## 3 · Findings register (severity → disposition)

### CRITICAL — fixed this round

| # | Finding | Evidence | Fix |
|---|---|---|---|
| C1 | **Partial cash payment impossible.** `submitRows`/`checkRows` memos in `payment-modal.tsx` omitted `cashCharge`/`singleCash` deps — the UI *said* "Charging EGP 300.00" while *submitting* amount 558.18 with amountTendered 300 → API 400 (cash-short guard). Full payments worked by coincidence, hiding the bug. | Browser capture: `{"payments":[{"method":"cash","amount":558.18,"tip":0,"amountTendered":300}]}` → 400; UI text "Charging EGP 300.00" simultaneously | Deps added to both memos; verified live: partial cash 300 → "Payment recorded — remaining EGP 258.18" |
| C2 | **Non-atomic order create → zombie orders synced to cloud.** `POST /api/orders` committed order+items in tx#1, then `recomputeTotals` in tx#2; under contention tx#2 timed out after tx#1 committed → open order, items present, **totalAmount = 0** — and the outbox event had already synced it to Neon. | Stress run 1: orders #335–337 exactly this shape (kept as evidence, now cancelled); stress log: 42× 500 on POST /api/orders | `recomputeTotals(orderId, txScope?)` — create route + delivery webhook now fold the money write into the create transaction. 831 later creates: **zero zombies** |
| C3 | **Write-path collapse under realistic rush.** 6 concurrent writers → 25/26 creates failed (500), p50 10.9 s; reads degraded to p95 5.2 s while writes were in flight. Root causes (layered): SQLite `journal_mode=delete`; Prisma 5 s interactive-tx + 5 s socket timeout; busy-handler backoff storms; and a **true deadlock**: an app transaction holding the SQLite write lock while the hybrid engine's apply-transaction busy-waited on it *inside the Prisma runtime*, blocking the very runtime the first transaction needed for its next query. | Stress runs 1–3 + lock-holder experiments + step-by-step transaction trace (`BEGIN IMMEDIATE` acquired, next query never scheduled) | Four-layer fix (see §4): WAL + `socket_timeout=30000` + `connection_limit=1` + process-wide `withWriteLock` FIFO mutex + 30 s tx timeout. **Final gate: 0 errors / 10,781 reqs; creates p50 222 ms, p99 905 ms at 15.4/s sustained** |
| C4 | **Live check #40 (table 1) stale by EGP 327.60.** Stored subtotal 225 / total 283.50 while its 4 items sum 485 (items added Sept-28/30 never folded in). A guest paying the displayed check would have been undercharged 327.60. | DB forensics: items Σ 485 vs stored 225 | Recomputed through `recomputeTotals` (outbox-synced): now 485 / 611.10 |
| C5 | **16 stale/zombie open orders polluting the POS floor and KDS.** 13 never-completed load-test takeaways from Sept-28 (88 h old, 4 with EGP 500 partial cash payments) + 3 zero-total zombies — all rendered to waiters as actionable tickets. | POS floor view + KDS tickets listing them | All 16 cancelled via the designed API channel (audit-logged, outbox-synced). Floor & KDS now clean; guard recommendation R2 |

### HIGH — dispositioned

| # | Finding | Evidence | Disposition |
|---|---|---|---|
| H1 | **22 paid orders with zero payment rows** (#108, #126–139, #312–326) — Z-report tender aggregates under-count for those periods. | DB forensics; ids listed in `agent-ctx` | **Documented, not fabricated.** Creating synthetic payment rows would falsify financial records. Recommended: investigate the Payment-entity sync policy on the historical Neon pulls (these look like cloud-pulled orders whose Payment rows never rode events) — see roadmap R4 |
| H2 | **next-server memory pressure.** Dev-mode query logging + stress residue ballooned RSS to 2.5 GB → **OOM-kill** mid-audit on the 4 GB sandbox. | dmesg `oom-kill … next-server anon-rss: 2,544,852 kB` | Query logging now opt-in (`RSM_QUERY_LOG=1`); daemonizer restarts are cheap. Prod (Vercel) already ran error-only logging — unaffected |

### MEDIUM — fixed or dispositioned

| # | Finding | Disposition |
|---|---|---|
| M1 | Payment button showed the full bill (EGP 558.18) after a partial payment instead of the remaining balance | **Fixed** — shows `remainingAmount` once payments exist (verified live) |
| M2 | Developer role locked out of order cancellation (manual `role !== 'admin'` check vs p11-d admin-equivalence) | **Fixed** — admin/developer/super-admin all privileged |
| M3 | Merged orders passed the cancel guard (cancelling would orphan the merge trail) | **Fixed** — 400 "lives on in the merged target" |
| M4 | Empty/junk-body `PUT /api/{categories,products,users,roles,tables,floorplans,modifier-groups}/[id]` → 200 no-op (POSTs validate properly; PUTs inconsistent). No data changed (verified) | **Recommended** R3 — shared body-validation helper across the 7 PUT routes (safe, additive) |
| M5 | `POST /api/stock-counts {}` → 201 (creates a snapshot count sheet) | **By design** — the endpoint is a "start a stock count" action with no required fields; audit finding withdrawn after code review |
| M6 | Dual-auth doors return 401 (not 403) to authenticated-but-underprivileged sessions (e.g. waiter on `/api/hybrid/status`) | **Documented** — semantic choice; harmless to clients; noted for a future consistency pass |

### LOW / INFO — noted

- Account-level sessions never stamp `checkIssuedAt` (by design — the first stamp is reserved for person-level attribution), so the header chip can read "Check not issued yet" after an account-level print. **Recommend** showing a distinct "printed (account level)" chip state (roadmap R5).
- The `558.1799926757812` values seen during testing were an **agent-browser accessibility-tree serialization artifact** (float32 boundary in the tooling) — the real DOM input shows `558.18`. No app bug.
- Custom roles inherit sub-modules from parents (inventory → stock counts, products → modifier groups, settings → integrations) — intentional; **documented here** so it is never misread as a permission bug.
- Known benign artifacts unchanged (RUNBOOK §5): Neon 229 vs local 225 products (re-id policy), 1 dead outbox letter (collision guard), PIN divergence local↔prod (owner actions), Turso heartbeat row.

---

## 4 · The write-path fix, explained (what was actually wrong)

1. **WAL journal mode** (`journal_mode=WAL`, persistent in the db header, applied at every client boot): readers stop blocking writers and vice-versa. The backup engine already used WAL-safe `VACUUM INTO`, so no backup-path changes were needed.
2. **`socket_timeout=30000`** in the DATABASE_URL (this is Prisma-SQLite's busy timeout, in ms): competing writers wait politely instead of failing at the old 5 s default. Applied to `.env` **and the recycle-proof vault** so every future heal preserves it.
3. **`connection_limit=1`** — the decisive change. With one connection, every query (from the API, the hybrid engine, the snapshot watcher) queues *asynchronously* in Prisma's pool; SQLite-level busy-waits — and the runtime deadlock they caused — become structurally impossible.
4. **`withWriteLock`** (`src/lib/write-mutex.ts`) — a FIFO promise-chain mutex around the two order-create transactions: fairness and bounded latency on top of the single connection.
5. **Atomic create + 30 s transaction timeout** (see C2) — money totals commit with the order or not at all.

**Environment subtleties discovered and fixed along the way (documented for every future agent):**
- The platform shell exports a **param-less `DATABASE_URL`**, and Next.js never overrides an inherited `process.env` value with `.env` — so URL params in `.env` were silently ignored by any server started from a shell. `.zscripts/daemonize-dev.py` (new, the worklog-standard python double-fork daemonizer) and `.zscripts/ensure-dev.sh` now strip the inherited var so `.env` wins.
- A `PRAGMA busy_timeout` after connect **overrides** the URL param — the initial 10 s pragma silently defeated the 30 s URL setting. The pragma was removed; the comment in `src/lib/db.ts` explains why it must never return.

---

## 5 · Stress-test results (before → after)

| Phase | Before (audit run) | Final gate (after fixes) |
|---|---|---|
| 1 Read-heavy (8 × 60 s) | 5,343 reqs · 88.9 rps · 0 err · worst p99 583 ms | 5,711 reqs · **95.1 rps** · 0 err · worst p99 538 ms |
| 2 Write path (6 × 45 s) | 27 reqs · **25 create failures (93%)** · p50 10.9 s · p99 17.1 s | **1,390 reqs · 30.8 rps · 0 err** · create p50 **222 ms** · p99 **905 ms** |
| 3 Burst (24 × 10 s) | 1,242 reqs · 122.7 rps · 0 err | 905 reqs · 89.4 rps · 0 err · p99 1.2 s |
| 4 Reports (4 × 15 s) | 1,414 reqs · 0 err · p99 316 ms | 1,194 reqs · 0 err · p99 449 ms |
| 5 KDS+POS mixed (10 × 30 s) | reads collapsed p95 5.2–5.7 s · 17 errors | 1,549 reqs · 0 err · reads p95 **242 ms** · creates p95 1.2 s |
| **Total** | 8,190 reqs · 42 errors (0.51%) | **10,781 reqs · 0 errors** |

**Friday-rush verdict (40-table restaurant ≈ 15–25 terminals):** the read fleet always had headroom; the write path now sustains **15 order-creates + 15 cancels per second** with sub-second p99 — an order of magnitude beyond any real rush. Data integrity after the final run: **7/7 checks pass** (all 831 created orders cancelled with exact money math, zero orphan items, zero payments on test rows, pre-existing 206 orders intact, no new dead outbox letters, server healthy).

---

## 6 · Security posture (unchanged strength, re-proven)

- **Authentication:** JWT (jose) in httpOnly cookie + Bearer fallback; rate-limited login doors; manager/developer private PIN doors isolated (R27) — re-verified from all five roles.
- **Authorization:** every route's role gate matches its permission model — **0 bypasses in 364 probes**. Custom-role users see exactly their module set. PINs never leave admin-only surfaces.
- **Input validation:** POSTs validated end-to-end (invalid bodies → 400, never 500). The PUT no-op inconsistency (M4) is the one gap — no data impact, fix recommended.
- **Injection:** SQLi-shaped probes 4/4 clean (Prisma parameterization).
- **Money integrity:** server-authoritative recompute choke point on every mutation path; overpay/tender/capacity guards verified in code review; refunds capacity-bound (paid − refunded).

---

## 7 · Restaurant-operations assessment (the COO lens)

**What this platform already does at professional grade:** bilingual EN/AR everything (checks, receipts, UI, RTL); person-level attribution (who took the order, who issued the check, who operated the drawer); deferred checks with settle-flow; split bills (equal / by-items / custom); tips with presets and give-back screens; 86/sold-out with per-category station routing (kitchen/bar/shisha); table lifecycle with cleaning states; loyalty with redemption-as-tender; promotions with time windows incl. past-midnight; delivery-aggregator webhook with menu matching and price-diff flags; ETA e-invoicing fields; cash-drawer sessions with paid-in/out and Z-report reconciliation; offline-first hybrid sync with five-platform harmony; AI briefing/copilot with multi-provider failover.

**Organizational recommendations (prioritized):**

- **R1 — Stale-order guard (recommended, high value).** The Sept-28 incident happened because nothing flags open orders that are hours old. Add a "stale" badge + auto-suggest cancel after a configurable threshold (e.g. 12 h takeaway / same-day-closing dine-in) on the POS floor and a stale-tickets filter on KDS. *(Data repair fixed this instance; the guard prevents recurrence.)*
- **R2 — Put-validation helper (M4).** One shared validator across the 7 `[id]` PUT routes; 400 on empty/junk bodies, consistent with POSTs.
- **R3 — Payment-tender history for cloud-pulled orders (H1).** Investigate why 22 historically cloud-pulled paid orders lack Payment rows; consider a one-time reconciliation import from Neon source-of-truth (NOT synthetic rows — real rows from the cloud DB).
- **R4 — Check-issuer chip for account-level prints (LOW).** Distinct "printed (account level)" state so the chip never contradicts the paper.
- **R5 — Data-doctor admin tool (high value, low risk).** A read-only diagnostics screen: zombie-order scan (open + total 0), stale-order scan, paid-without-payments scan, items-vs-subtotal mismatch scan — the exact four forensics this audit ran manually, productized for the owner.
- **R6 — Load-test as a release gate.** `scripts/r31-stress.ts` + `scripts/r31-integrity.ts` are reusable; run phase 2 (write path) before any future deploy that touches order/payment paths. The r31 baseline numbers are in this report.

---

## 8 · Residual risks (honest)

1. **Single-connection serialization** is the right architecture for SQLite but means *every* DB operation queues behind long transactions. The 30 s tx timeout bounds worst-case waits; the stress data shows sub-second p99 in practice. If the restaurant ever exceeds ~30 rps of mixed traffic, the next step is the documented Turso/Neon path, not more SQLite tuning.
2. **Dev-mode memory** on the 4 GB sandbox remains the tightest resource (compile + 22 modules); the daemonizer restart is the pressure valve. Production (Vercel/serverless) is unaffected.
3. **The 22 payment-less paid orders** remain in the data (documented ids) until R3 runs — Z-report tender breakdowns for those historical days under-count; order-level revenue is correct.
4. **Order #70** carries the documented p8 double-payment artifact (RUNBOOK §5) — untouched by policy.

---

## 9 · Artifacts produced this round

- **Fixes (code):** `src/components/pos/payment-modal.tsx` (C1), `src/components/pos/cart-panel.tsx` (M1), `src/lib/orders.ts` + `src/app/api/orders/route.ts` + `src/app/api/integrations/delivery/webhook/route.ts` (C2, C3), `src/lib/db.ts` (WAL + logging policy), `src/lib/write-mutex.ts` (new, C3), `src/app/api/orders/[id]/cancel/route.ts` (M2, M3), `.zscripts/daemonize-dev.py` (new) + `.zscripts/ensure-dev.sh` (env strip), `.env` + `.git/env-vault.env` (DATABASE_URL params, durable).
- **Data repairs (designed channels, all audit-logged + outbox-synced):** 16 stale/zombie orders cancelled; order #40 totals recomputed (485 / 611.10); order #87 normalized takeaway→dinein.
- **Audit tooling (reusable):** `scripts/r31-stress.ts`, `scripts/r31-integrity.ts`, `scripts/r31-data-repair.ts`, `scripts/audit-baseline.ts`, `scripts/r31-lock-experiment.ts`, `scripts/r31-probe-lock.ts` (forensics), plus the subagents' `scripts/r31-api-audit.ts`.
- **Reports:** this document, `agent-ctx/r31-api-audit.md` (full 364-probe matrix), `agent-ctx/r31-stress-audit.md` (baseline stress report).
- **Screenshots:** 44 browser-verifications (`screenshots/r31-01…44-*.png`) covering every role, flow, module sweep, Arabic RTL, mobile 390 px, and the fixed payment paths.
