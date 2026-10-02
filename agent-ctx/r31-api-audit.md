# r31 — API Smoke + Role-Guard Matrix Audit (Task 2-a)

- **Agent:** API & Security auditor (subagent, Task 2-a) · **Date:** 2026-10-02
- **Scope:** every audited API route on the RUNNING dev server (`localhost:3000`) — availability, 401/403/200 role matrix, invalid-body validation, latency; plus money-math verification, order-lifecycle code review, unauth-enumeration and SQLi probes.
- **Method:** `bun scripts/r31-api-audit.ts` (364 probes, tokens from /tmp, never printed) + `scripts/r31b-money-and-cleanup.ts` (money math, PIN-leak checks, probe-artifact cleanup) + `scripts/r31c-db-money-truth.ts` (read-only DB truth sweep). Zero writes to `src/`. Probe artifacts created were reverted through designed channels (stock count SC-0002 → cancelled via its own PATCH cancel).
- **Actors:** unauth · waiter (pos) · kitchen (kitchen) · custom «مينا» (pos,promotions,customers,reservations,cashdrawer,settings,attendance,users,reports,inventory,recipes,floorplans,categories,kitchen,products,dashboard — no roles/audit/vision/purchases/payroll) · admin (Dr Ihab) · developer sanity probe only.

## 1. Executive summary

| Metric | Result |
|---|---|
| GET routes audited | 50 (×5 actors = 250 probes) |
| Mutation endpoints probed | 39 groups / 105 probes (unauth→401, waiter/kitchen/custom→403-or-400, admin+junk body) |
| Total probes | 364 |
| 500s during my probes | **0** in the 364 (1 transient 500 on a follow-up PATCH, see F4) |
| Latency outliers >2s | **0** (max 1,952 ms = first-hit route compile; heavy reports warm: audit 16 ms, zreport 81 ms, payroll 50 ms) |
| Role-matrix conformance | **356/364** after correcting 5 expectation artifacts on my side; the 8 remaining deviations map to **2 systemic findings (F5, F6)** |
| Money math | **EXACT** on all 5 sampled genuinely-paid orders (14% VAT + 12% service on (subtotal−discount); payments = total) |
| Unauth enumeration | team-wall / manager-login leak **names + role labels only** — no emails, no PINs |
| SQLi-shaped inputs | 4/4 rejected or normal (400/200), no 500 |
| Overall verdict | **Auth & authz: EXCELLENT (zero bypasses). Money integrity: exact on live data, but 2 CRITICAL architectural/data findings (F1, F2) + 1 HIGH data-integrity finding (F3) need lead action.** |

## 2. GET role matrix (50 routes × 5 actors)

| Method | Path | Unauth | Waiter | Kitchen | Custom | Admin | ms (admin) | Verdict |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/auth/me` | 401 | 200 | 200 | 200 | 200 | 21 | ✅ PASS |
| GET | `/api/auth/team-wall` | 200 | 200 | 200 | 200 | 200 | 16 | ✅ PASS (public by design — no email/PIN leak) |
| GET | `/api/tables` | 405 | 405 | 405 | 405 | 405 | 6 | ✅ PASS (405: POST-only route, no GET handler) |
| GET | `/api/tables/status` | 401 | 200 | 200 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/orders` | 401 | 200 | 200 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/products` | 401 | 200 | 200 | 200 | 200 | 21 | ✅ PASS |
| GET | `/api/categories` | 401 | 200 | 200 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/modifier-groups` | 401 | 200 | 200 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/customers` | 401 | 200 | 200 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/customers/stats` | 401 | 200 | 200 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/reservations` | 401 | 200 | 200 | 200 | 200 | 17 | ✅ PASS |
| GET | `/api/promotions` | 401 | 200 | 403 | 200 | 200 | 9 | ✅ PASS |
| GET | `/api/inventory` | 401 | 200 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/inventory/low-stock` | 401 | 200 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/inventory/transactions` | 401 | 200 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/recipes` | 401 | 403 | 403 | 400 | 400 | 9 | ✅ PASS (400: requires ?productId=) |
| GET | `/api/suppliers` | 401 | 403 | 403 | 403 | 200 | 10 | ✅ PASS |
| GET | `/api/purchase-orders` | 401 | 403 | 403 | 403 | 200 | 10 | ✅ PASS |
| GET | `/api/stock-counts` | 401 | 403 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/shifts` | 401 | 200 | 200 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/users` | 401 | 403 | 403 | 200 | 200 | 12 | ✅ PASS |
| GET | `/api/roles` | 401 | 403 | 403 | 200 | 200 | 10 | ✅ PASS* (custom 200 — guard grants users-perm holders, see F10) |
| GET | `/api/audit` | 401 | 403 | 403 | 403 | 200 | 10 | ✅ PASS |
| GET | `/api/attendance` | 401 | 403 | 403 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/attendance/me` | 401 | 200 | 200 | 200 | 200 | 8 | ✅ PASS |
| GET | `/api/cash-drawer` | 401 | 403 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/waste` | 401 | 403 | 403 | 200 | 200 | 7 | ✅ PASS |
| GET | `/api/invoices` | 401 | 403 | 403 | 200 | 200 | 53 | ✅ PASS |
| GET | `/api/floorplans` | 401 | 200 | 200 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/integrations` | 401 | 403 | 403 | 200 | 200 | 9 | ✅ PASS |
| GET | `/api/settings` | 401 | 200 | 200 | 200 | 200 | 7 | ✅ PASS |
| GET | `/api/reports/sales` | 401 | 403 | 403 | 200 | 200 | 26 | ✅ PASS |
| GET | `/api/reports/zreport` | 401 | 403 | 403 | 200 | 200 | 13 | ✅ PASS |
| GET | `/api/reports/forecast` | 401 | 403 | 403 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/reports/menu-engineering` | 401 | 403 | 403 | 200 | 200 | 13 | ✅ PASS |
| GET | `/api/reports/payroll` | 401 | 403 | 403 | 403 | 200 | 8 | ✅ PASS |
| GET | `/api/reports/people` | 401 | 403 | 403 | 200 | 200 | 10 | ✅ PASS |
| GET | `/api/reports/my-shift` | 401 | 200 | 200 | 200 | 200 | 7 | ✅ PASS |
| GET | `/api/reports/waste` | 401 | 403 | 403 | 200 | 200 | 9 | ✅ PASS |
| GET | `/api/reports/inventory-value` | 401 | 403 | 403 | 200 | 200 | 11 | ✅ PASS |
| GET | `/api/ai/status` | 401 | 403 | 403 | 403 | 200 | 8 | ✅ PASS |
| GET | `/api/vision/overview` | 401 | 403 | 403 | 403 | 200 | 20 | ✅ PASS |
| GET | `/api/vision/cameras` | 401 | 403 | 403 | 403 | 200 | 7 | ✅ PASS |
| GET | `/api/vision/zones` | 401 | 403 | 403 | 403 | 200 | 8 | ✅ PASS |
| GET | `/api/vision/movements` | 401 | 200 | 403 | 200 | 200 | 9 | ✅ PASS |
| GET | `/api/vision/analytics` | 401 | 403 | 403 | 403 | 200 | 10 | ✅ PASS |
| GET | `/api/vision/config` | 401 | 403 | 403 | 403 | 200 | 9 | ✅ PASS |
| GET | `/api/hybrid/status` | 401 | 401 | 401 | 200 | 200 | 13 | ✅ PASS* (waiter/kitchen 401 — dual-auth door, see F7) |
| GET | `/api/sync/status` | 401 | 403 | 403 | 200 | 200 | 16 | ✅ PASS |
| GET | `/api/desktop/package` | 401 | 403 | 403 | 200 | 200 | 789 | ✅ PASS |

Developer sanity probe: `GET /api/ai/status` with the developer token → **200** (admin-equivalence p11-d confirmed).

## 3. Mutation probe matrix (safe probes: unauth → 401, underprivileged → 403, admin + junk body)

| Method | Path | Probes (actor → status) | Verdict |
|---|---|---|---|
| POST | `/api/orders` | unauth→401 · kitchen→403 · admin+{}→400 | ✅ PASS |
| PUT | `/api/order-items/1` | unauth→401 · waiter+{}→200 (no-op; pos+kitchen route) · admin+{qty:−5}→400 · admin+{status:'yesterday'}→400 | ✅ PASS |
| POST | `/api/orders/108/cancel` | unauth→401 · waiter→403 (not owner) · kitchen→403 · admin→400 («cannot cancel a paid order») | ✅ PASS (paid order owned by another user — zero mutation risk) |
| POST | `/api/orders/40/payments` | unauth→401 · kitchen→403 · waiter+{}→400 · admin+{foo}→400 · admin+{amount:−10}→400 · admin+{method:'crypto'}→400 | ✅ PASS (open order; validation fires before any payment row is written) |
| POST | `/api/categories` | unauth→401 · waiter→403 · kitchen→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| PUT | `/api/categories/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 (no-op 200, no data change) |
| DELETE | `/api/categories/999999` | unauth→401 · waiter→403 · admin→404 | ✅ PASS |
| POST | `/api/products` | waiter→403 · admin+{}→400 | ✅ PASS |
| PUT | `/api/products/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| DELETE | `/api/products/999999` | admin→404 · waiter→403 | ✅ PASS |
| PATCH | `/api/products/1/sold-out` | admin+{}→400 («soldOut must be true or false») · waiter+{}→400 | ✅ PASS (validated BEFORE any toggle; write-path verified separately: PATCH with current value → 200 in 75 ms, value unchanged) |
| POST | `/api/users` | waiter→403 · admin+{}→400 | ✅ PASS |
| PUT | `/api/users/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| POST | `/api/roles` | waiter→403 · custom→403 (lacks roles perm) · admin+{}→400 | ✅ PASS |
| PUT | `/api/roles/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| POST | `/api/suppliers` | waiter→403 · custom→403 (lacks purchases) · admin+{}→400 | ✅ PASS |
| POST | `/api/promotions` | waiter→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| POST | `/api/reservations` | kitchen→403 · waiter+{}→400 · admin+{}→400 | ✅ PASS |
| POST | `/api/attendance/check-in` | unauth+{}→400 · waiter+{}→400 · admin+{}→400 | ✅ PASS (public by design — login-screen card; rate-limited 10/5min) |
| POST | `/api/cash-drawer` | waiter→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| POST | `/api/waste` | waiter→403 · admin+{}→400 | ✅ PASS |
| POST | `/api/inventory/adjust` | waiter→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| POST | `/api/vision/simulate` | waiter→403 · custom→403 (lacks vision) · admin+{foo:'bar'}→400 | ✅ PASS |
| POST | `/api/ai/copilot` | waiter→403 · custom→403 (admin-only list) · admin+{}→400 | ✅ PASS |
| POST | `/api/ai/menu-search` | unauth→401 · waiter+{}→400 · admin+{}→400 | ✅ PASS |
| POST | `/api/auth/register` | unauth+{}→400 · unauth+{foo:'bar'}→400 | ✅ PASS (rate-limited 429 above cap) |
| PUT | `/api/settings` | waiter→403 · custom+{}→200 · admin+{}→200 | ✅ PASS (empty body = designed no-op returning current settings) |
| POST | `/api/tables` | waiter→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| PUT | `/api/tables/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| POST | `/api/tables/18/clear` | unauth→401 · waiter+{}→400 (free table) · admin+{foo}→400 | ✅ PASS (probe used a FREE table — no table state touched) |
| POST | `/api/floorplans` | waiter→403 · admin+{}→400 | ✅ PASS |
| PUT | `/api/floorplans/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| POST | `/api/modifier-groups` | waiter→403 · custom→403 (classic admin-only) · admin+{}→400 | ✅ PASS |
| PUT | `/api/modifier-groups/1` ⚠️ | waiter→403 · admin+{}→200 | ⚠️ F5 |
| POST | `/api/recipes` | waiter→403 · custom+{}→400 · admin+{}→400 | ✅ PASS |
| DELETE | `/api/recipes/999999` | waiter→403 · admin→404 | ✅ PASS |
| POST | `/api/stock-counts` ⚠️ | waiter→403 · admin+{}→**201 created** | ⚠️ F6 (junk body creates state; artifact reverted) |
| POST | `/api/hybrid/sync-now` | unauth→401 · waiter→403 · kitchen→403 · admin→200 (one allowed cycle, 613 ms) | ✅ PASS |
| POST | `/api/hybrid/pause` | unauth→401 · waiter→403 · kitchen→403 — **never called with admin/custom** | ✅ PASS |

## 4. FINDINGS (ordered by severity)

### F1 — CRITICAL · Order totals are persisted non-atomically → zombie zero-total orders under DB contention
**Evidence:** `POST /api/orders` (src/app/api/orders/route.ts): order+items+tables committed in `$transaction` (~line 171–227), then `recomputeTotals(created.id)` runs in a **separate** transaction (~line 230). Same pattern in `PUT /api/orders/[id]` (items committed ~line 102, `recomputeTotals` only at ~line 395). During my audit window a concurrent actor's `POST /api/orders` requests failed with **Prisma P1008 «Socket timeout»** inside `recomputeTotals` — the create-transaction had already committed. Result in DB **right now**: orders **#335, #336, #337** (created 2026-10-02T11:15:49–11:16:05, takeaway) are `status='open'` with 1 item each (3×110 / 3×110 / 2×110) but **subtotal=0, tax=0, total=0** — while the caller received 500 («order creation failed»). dev.log: 42× `POST /api/orders 500 in 5.3s–16.9s`, stack `at async POST (src/app/api/orders/route.ts:171:21)` / P1008 at `db.stockCount.update`-style socket timeouts.
**Impact:** clients retry → duplicate zombie checks; items exist but money shows 0; if such an order is paid, the overpay guard compares against `totalAmount=0` and rejects (safe), but the check must never reach POS in this state.
**Fix file:** `src/app/api/orders/route.ts` + `src/app/api/orders/[id]/route.ts` + `src/lib/orders.ts` (fold `recomputeTotals` into the same `$transaction` as the item writes, or compensate/rollback on recompute failure).

### F2 — CRITICAL · Live open check #40 has stale totals (items added days ago never folded in) → undercharge risk
**Evidence (DB, read-only):** order **#40** (open, table 1): stored `subtotal=225.00, total=283.50`, but its items sum **485.00** — item 602 (4×60) created 2026-09-28 18:37 and item 603 (1×20) created 2026-09-30 07:30 were added **after** creation and the stored subtotal was never recomputed (pre-dates today's contention by 4 days). Correct math would be base 485 → tax 67.90 + svc 58.20 → **total 611.10**, but the payment guard caps at `totalAmount=283.50` → presenting this check undercharges by **EGP 327.60**.
**Fix file:** same as F1 (atomic recompute); plus a data repair for #40 (and any other live mismatch — 4 open orders currently mismatch: #40 + the 3 F1 zombies).

### F3 — HIGH · 22 of 100 paid orders have ZERO payment rows (paidAmount=0)
**Evidence (DB):** paid orders without any Payment rows: **#108, 126, 127, 128, 129, 132, 133, 136, 139** (2026-09-08..14) and **#312, 314, 316–326** (2026-09-23..27 cluster). Each is `status='paid'` with `paidAmount=0, remaining=total` (e.g. #108: total 186.48, payments []). Six of them also have no items (#108, 126, 127, 129, 136, 139).
**Impact:** Z-report payment-by-method under-counts vs sales on those days; refund capacity for them is 0 (a refund request would correctly 400, but the guest has no recorded tender); `serializeOrder.paidAmount` misleads the floor UI.
**Root:** bulk import/seed era rows (not caused by current code paths — every current payment write is transactional). Needs a data-triage decision by the lead (backfill payment rows, or re-classify).

### F4 — HIGH · SQLite write-lock contention (P1008) turns long transactions into 500s — intermittent
**Evidence:** dev.log (current session) holds **43× 500s**: 42× `POST /api/orders` (5.3–16.9 s renders, stack at `route.ts:171` = the create `$transaction`; caller unknown — a concurrent actor, NOT my probes: all my POST /api/orders probes were rejected at 401/403/400 before any transaction) + 1× my `PATCH /api/stock-counts/2` cancel (`db.stockCount.update` inside BEGIN IMMEDIATE, P1008 after 10.3 s). **Retry of the identical cancel request succeeded in 68 ms** → transient lock contention, not a code bug. Simple writes work fine (PATCH sold-out 200 in 75 ms; my 364 probes had zero 500s; hybrid/sync-now 200 in 613 ms).
**Fix direction (lead):** SQLite single-writer contention while multiple processes hold the file (dev server + snapshot watcher + parallel agent scripts). Consider busy_timeout tuning, shorter transactions, or serializing writers. The 500 surface is the P1008 — an availability risk under concurrent load.

### F5 — MEDIUM · Empty/junk-body PUT on 7 endpoints returns 200 no-op instead of 400
**Evidence:** admin + `{}` (and `{"foo":"bar"}` behaves the same) → **200** on `PUT /api/categories/1`, `/api/products/1`, `/api/users/1`, `/api/roles/1`, `/api/tables/1`, `/api/floorplans/1`, `/api/modifier-groups/1`. POST counterparts all 400 correctly. **No data was mutated** — code applies only `body.X !== undefined` fields (verified in src and by re-GET); the response echoes the unchanged row. Unknown fields are silently ignored rather than rejected.
**Fix files:** the 7 `[id]/route.ts` PUT handlers — reject empty updates (`if no recognized field present → 400`) for consistency with the POST validation posture.

### F6 — MEDIUM · `POST /api/stock-counts` with a junk body CREATES state (201)
**Evidence:** admin + `{}` → **201 Created** — a full count sheet SC-0002 was created (20 snapshot lines, all stockable products, status 'open', createdBy Dr Ihab). The only optional field is `note`, so an empty body is "valid" by design; per the validation policy a body of `{}`/`{"foo":"bar"}` should not create state.
**Cleanup done:** reverted through the designed channel — `PATCH /api/stock-counts/2 {action:'cancel'}` → 200 (first attempt hit the F4 P1008 500; retry 68 ms). DB now: SC-0002 `cancelled`, no stock changes (cancel is the designed no-stock-change path).
**Fix file:** `src/app/api/stock-counts/route.ts` POST — require at least a `note` (or an explicit confirm field).

### F7 — LOW · Dual-auth door returns 401 for authenticated-but-underprivileged sessions
**Evidence:** `GET /api/hybrid/status` with waiter (pos-only) and kitchen tokens → **401**, not 403 (`requireSessionOrDevice` in src/lib/hybrid-auth.ts: `requireAuth` throws 403 → caught → device path fails → route answers 401). Authz is still enforced (no bypass); semantics only. Same applies to other hybrid routes using the dual door.

### F8 — LOW · Developer role cannot cancel others' orders (manual role check excludes admin-equivalence)
**Evidence:** src/app/api/orders/[id]/cancel/route.ts line 28: `if (session.role !== 'admin' && order.userId !== sessionUserId(session))` — the p11-d developer (admin-equivalent everywhere else, verified 200 on /api/ai/status) gets 403 unless they own the order. Not probed live (mutation risk) — code-read finding.

### F9 — LOW · Cancel route permits cancelling a `merged` source order
**Evidence:** the guard blocks only `paid` and `cancelled` (lines 31–36). A `merged` source order passes and would flip it to `cancelled` + free tables (source orders are normally consumed by the merge). Edge case; no live probe (mutation risk). File: src/app/api/orders/[id]/cancel/route.ts.

### F10 — INFO · `GET /api/roles` is reachable by any holder of the `users` permission
**Evidence:** custom «مينا» (no `roles` perm) → **200** — the guard list is `['admin','roles','users']` so the `users` permission satisfies it (intentional: role picker in user management). She sees every role's permission set but **zero PINs** (`pinForSession` nulls cleartext for non-admins: custom saw 0/9 PINs, admin 9/9 by design) and user emails are visible to `users`-perm holders (needed for user management). No passwords ever exposed (`USER_SAFE_SELECT` excludes passwordHash).

### F11 — INFO · Refund design keeps `paid` status with netPaid < total (by design, verified)
**Evidence:** paid orders #43/#47/#53 each carry `cash 116.55 + card 116.55 = 233.10 = total` plus a **−5.00 partial refund** row (`refund: audit: partial refund of split check`) → net 228.10 while status stays `paid`. Money math stays exact; Z-report nets refunds. No guard missing.

### F12 — INFO · Paid order #70 still carries the documented pre-fix p8 race artifact
**Evidence:** items 5×160+3×20+2×95=1050 → tax 147, svc 126, total **1323.00** — but payments are **2× cash 1323.00 = 2646.00** (the exact race the p8 fix closed; the duplicate row was left as the historical proof). Refund capacity currently 1323.00. Lead may want to refund/clean the duplicate row.

### Positive results (no action)
- **AuthN/AuthZ:** zero bypasses across 355 auth-relevant probes. 401 exactly on unauth (except by-design public team-wall/manager-login/register/attendance-check-in and the F7 dual-door); 403 exactly for missing role+permission; admin/developer pass everything; waiter (pos) reaches only pos-scoped routes; kitchen only kitchen-scoped; custom Meena correctly blocked from purchases (suppliers/purchase-orders), payroll, vision, and classic-admin lists (ai/status, copilot, modifier-groups writes).
- **Money math (see §5):** exact on all genuinely-paid sampled orders.
- **Unauth enumeration:** team-wall/manager-login return names + role labels only (checked full payloads: no `@`, no `pin`).
- **SQLi probes:** `?status='; DROP TABLE orders;--` → 400; `?tableId=1 OR 1=1;--` → 400; `?q='; DROP TABLE customers;--` → 200 empty; `?entity=x' UNION SELECT 1,2,3--` → 200 empty (Prisma parameterized — no 500 anywhere).
- **Latency:** 0 probes >2 s. Heaviest: desktop/package 789–1137 ms (zip build); all reports warm ≤81 ms. First-hit route compiles ≤1.95 s (once per route).
- **Hybrid sync-now** (admin, once): 200 in 613 ms — one clean cycle, engine healthy.

## 5. Money-math verification (paid orders, exact numbers)

Formula (src/lib/orders.ts `recomputeTotals`): `base = round2(subtotal − discount)`; `tax = round2(base×0.14)`; `serviceTax = round2(base×0.12)`; `total = round2(base+tax+serviceTax)`. **Service tax is NOT toggleable via the settings API** — `GET /api/settings` returns restaurant names only (`{"restaurantName":"Lilo Cafe and Restaurant","restaurantNameAr":"ليلو كافيه ومطعم"}`); rates come from env constants (TAX_RATE 0.14, SERVICE_TAX_RATE 0.12). There is no per-item discount column (unitPrice already includes modifier deltas) → line math is `qty × unitPrice`.

| Order | Items (qty×price) | calc subtotal | stored subtotal | calc tax 14% | stored tax | calc svc 12% | stored svc | calc total | stored total | payments (gross) | net paid | Match |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| #100 | 5×195 + 3×20 + 2×190 | 1415.00 | 1415.00 | 198.10 | 198.10 | 169.80 | 169.80 | 1782.90 | 1782.90 | card 510.30 + cash 510.30+270.90+245.70+245.70 | 1782.90 | ✅ 5/5 |
| #96 | 3×20 + 1×195 + 2×190 | 635.00 | 635.00 | 88.90 | 88.90 | 76.20 | 76.20 | 800.10 | 800.10 | cash 749.70 + 50.40 | 800.10 | ✅ 5/5 |
| #94 | 2×95 + 1×60 | 250.00 | 250.00 | 35.00 | 35.00 | 30.00 | 30.00 | 315.00 | 315.00 | cash 315.00 | 315.00 | ✅ 5/5 |
| #91 | 5×195 + 2×190 + 3×20 | 1415.00 | 1415.00 | 198.10 | 198.10 | 169.80 | 169.80 | 1782.90 | 1782.90 | card 510.30 + cash 510.30+270.90+245.70+245.70 | 1782.90 | ✅ 5/5 |
| #90 | 5×195 + 3×20 + 2×190 | 1415.00 | 1415.00 | 198.10 | 198.10 | 169.80 | 169.80 | 1782.90 | 1782.90 | cash 1782.90 | 1782.90 | ✅ 5/5 |

Every check (subtotal, tax, service tax, total, payments=total) within ±0.02 on all five. Refund-bearing orders (#43/#47/#53) verified separately: gross payments = total exactly, then legitimate −5.00 refunds reduce net — ledger stays exact (F11).

## 6. Order lifecycle guard code review (payments / cancel / refund)

**`POST /api/orders/[id]/payments`** — guards found, in order: session (`waiter|admin|pos`); order exists; **status must be `open|deferred`** (paying a paid/cancelled/merged order → 400); JSON body required; `payments` non-empty array (loyalty-only exception); method whitelist (`PAYMENT_METHODS`); `amount` finite > 0 (negative payments impossible); `tip ≥ 0`; `amountTendered ≥ amount`; `changeGiven ≤ tendered−amount`; **overpay guard run INSIDE the row-lock transaction** (`updateMany ... status in ['open','deferred']` re-assert + payments re-read in-lock — the p8 race fix; concurrent double-pay now impossible); loyalty redemption caps itself at remaining balance net of same-request rows; close-if-fully-paid afterwards. **No missing guards found.** Only nuance: a zero-total order would reject every payment (overpay vs remaining 0) — safe direction.

**`POST /api/orders/[id]/cancel`** — guards: session; **owner-or-admin** (403 otherwise; see F8 developer gap); **paid → 400** (cannot cancel paid); already-cancelled → 400; write + outbox event in one transaction; frees every seating table only if unused; cancelled orders make no inventory changes. **Gap: `merged` source orders pass** (F9). No body surface (nothing to validate).

**`POST /api/orders/[id]/refund`** — guards: **classic admin only** (custom/`settings`/`users` holders cannot refund — documented design); id integer; `amount > 0` (no negative refund = no forced positive ledger); reason required (≤140 chars, audit trail); method whitelist; **order must be `paid`** (409 otherwise — refunding an open check impossible); capacity = Σ positive payments − Σ refunds (refund > paid impossible); negative Payment row keeps every aggregate honest (paidAmount, Z-report by method, drawer). **No missing guards found.**

**`POST /api/orders` (creation)** — items: non-empty (0-item orders rejected), `productId` int > 0, `quantity > 0` (negative rejected), products must exist/active/sellable, modifier ids validated + deduped; tables: exist, active, no open order, ≤MAX_SEATING_TABLES, no duplicates; guests 1–30; delivery phone 5–20 + address ≤200; stock availability checked; totals via `recomputeTotals`. **Only structural gap = F1 non-atomicity.**

**`PUT /api/order-items/[id]`** — kitchen+waiter route; item must exist; status whitelist; `quantity > 0` (negative rejected — verified live: `{quantity:-5}` → 400); empty `{}` → no-op 200 (documented in F5 family but acceptable here: KDS status taps).

## 7. Probe safety & cleanup ledger
- cancel probe used **paid order #108 owned by another user** → waiter/kitchen 403 (role guard), admin 400 (paid guard) — no order touched.
- payments probe used **open order #40** with junk bodies only → all 400 before any write.
- clear probe used **free table #18** → 400 both actors.
- `hybrid/pause` never called with admin/custom (would have paused the engine).
- stock count artifact SC-0002 **cancelled via designed PATCH** (no stock changes) — DB back to pre-audit state for that table.
- sold-out write-path test used the product's **current value** (`false` → `false`) — no toggle occurred.
- No file under `src/` was modified; dev server untouched; tokens never printed/logged.

## 8. Next actions for the lead
1. **F1/F2 (CRITICAL):** make `recomputeTotals` ride the same transaction as item writes (orders POST + orders/[id] PUT); add a startup/periodic integrity sweep (orders where `subtotal ≠ Σ(qty×unitPrice)` while `status='open'`) — currently 4 live cases (#40 stale-since-Sep-28, #335–337 zero-total zombies). Decide on data repair.
2. **F3 (HIGH):** triage the 22 payment-less paid orders (backfill Payment rows or re-classify) — they skew Z-report payment aggregates.
3. **F4 (HIGH):** address SQLite write-lock contention (P1008 → 500s under concurrent actors); at minimum make `errorResponse` distinguish P1008 with a 503 + retry hint so clients don't treat it as a hard failure.
4. **F5/F6 (MEDIUM):** tighten empty-body PUTs (7 endpoints) and `POST /api/stock-counts` to 400 on no recognized fields.
5. **F7–F9 (LOW):** optional polish — dual-door 403 semantics, developer cancel parity, merged-source cancel guard.

*Raw data: `agent-ctx/r31-api-audit-results.json` (364 probes), `agent-ctx/r31b-money-results.json` (money + PIN checks). Scripts: `scripts/r31-api-audit.ts`, `scripts/r31b-money-and-cleanup.ts`, `scripts/r31c-db-money-truth.ts`.*
