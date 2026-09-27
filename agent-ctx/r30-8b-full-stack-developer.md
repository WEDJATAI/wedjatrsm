# Task r30-8b — Hybrid Outbox Wiring into Business Write Paths

Agent: full-stack-developer · Date: R30 · Status: COMPLETE (all gates green)

## What this agent did
Wired the rsm-hybrid/1 durable outbox (built by r30-6/7/8a) into the platform's business write paths. Every listed write now appends its outbox event(s) in the SAME Prisma transaction — strictly additive: no response shapes, status codes, permission checks, audit calls, or business logic changed anywhere.

## Files modified (22)
- `src/app/api/orders/route.ts` — POST: originDeviceId stamp (getLocalDevice, read-only, null-safe) + Order create + OrderItem creates (read-back) + RestaurantTable updates, all in the existing creation tx
- `src/app/api/orders/[id]/route.ts` — PUT: all 5 branches (addItems / removeItemIds / updateItems / discountAmount / guests / customerId) each wrapped in a tx + OrderItem create/delete/update + Order update events
- `src/app/api/orders/[id]/payments/route.ts` — createMany tx + Payment creates (id>max read-back, window computed BEFORE createMany) + Order update
- `src/app/api/orders/[id]/refund/route.ts` — batch-array tx → interactive tx + Payment create (negative row) + Order update
- `src/app/api/orders/[id]/cancel/route.ts` — order.update tx + Order update
- `src/app/api/orders/[id]/check-issue/route.ts` — updateMany tx + re-read + Order update (only when count===1)
- `src/app/api/orders/[id]/merge/route.ts` — Order update × 2 (target + source) inside the existing interactive tx
- `src/app/api/orders/[id]/transfer/route.ts` — Order update inside the existing rehouse tx
- `src/app/api/orders/[id]/transfer-items/route.ts` — Order update × 2 (source + target) inside the existing CAS tx
- `src/app/api/order-items/[id]/route.ts` — KDS hot path: one tx, update + OrderItem update event using the update result
- `src/lib/orders.ts` — recomputeTotals (see deviations), closeOrderIfFullyPaid, deductInventoryForOrder (Product updates + InventoryTransaction creates inside its tx), setTablesStatusForOrder, deferOrder
- `src/lib/loyalty.ts` — awardLoyaltyOnClose (batch → interactive tx + Customer/Order updates), redeemLoyaltyPoints (batch → interactive tx + Customer/Order updates + Payment create)
- `src/app/api/inventory/adjust/route.ts` — existing tx + Product update (plain re-read) + InventoryTransaction create
- `src/app/api/customers/route.ts` + `[id]/route.ts` — Customer create / update (covers pointsAdjust)
- `src/app/api/reservations/route.ts` + `[id]/route.ts` + `[id]/seat/route.ts` — Reservation create/update; seat wraps BOTH writes in one tx + Reservation + RestaurantTable updates
- `src/app/api/attendance/check-in/route.ts` + `check-out/route.ts` — Attendance create/update (PUBLIC routes — events emit with local device identity)
- `src/app/api/cash-drawer/route.ts` — open → CashDrawerSession create; paid_in/paid_out → CashDrawerEntry create
- `src/app/api/cash-drawer/[id]/route.ts` — close → CashDrawerSession update

## Decisions + deviations later agents must know (full detail in worklog.md "Task ID: r30-8b")
1. **recomputeTotals IS wired** (map only named the other orders.ts functions): it is the single money choke point; without it Order 'create' events carry totals 0 forever on remote devices until close.
2. **redeemLoyaltyPoints IS wired** beyond the map — it creates a Payment (loyalty tender) inside the payments flow.
3. **merge/transfer-items emit Order updates ONLY** (exact map scope): re-parented OrderItem rows and Payment rows carry no events this phase (Payment is append-only → updates rejected by design; item re-parenting = phase-2 candidate).
4. **freeTableIfUnused + rehouseOpenOrder table writes NOT wired** (not in the map) — cancel/transfer table releases ride no events this phase.
5. **logAudit stays fire-and-forget OUTSIDE the txs** (by design; avoids SQLite write-lock contention and preserves audit semantics). Audit-log entity is out of scope.
6. **Event rows are PLAIN Prisma rows** (no relation includes) everywhere EXCEPT the KDS route (map explicitly said "the update result", which includes product) — keeps payload hashes comparable.
7. **Loopback semantics (verified live)**: pushing to self acks everything — same-revision same-content = no-op, append-only duplicates + stale revisions = acked-as-processed conflicts. Zero failed/dead.

## Phase-2 wiring list (out of scope this round)
products/categories/modifiers/reorder · purchasing/suppliers/POs · stock-counts · waste · users/roles/shifts · vision (incl. rehouseOpenOrder table writes via vision) · settings · audit-log events · merge/transfer-items item re-parenting · freeTableIfUnused releases · orders-POST reservation auto-link.

## Gate evidence
- `bun run lint` → 0 findings
- `bunx tsc --noEmit` → 12 errors, ALL pre-existing legacy baseline (migrate-neon / round12-migrate / products-reorder / inngest / print); ZERO new from the 22 touched files
- Throwaway `scripts/hybrid-wiring-check.ts` (deleted): **27/27 PASS — "WIRING: ALL PASS"** — order #42 full lifecycle, 34/34 out events acked via loopback (pushed=34 acked=34 failed=0), idempotent second sync-now, no duplicate rows, order converged (paid, 667.80, 66.78 pts); DB fully restored (stocks, table, targetUrl='', unpaused, zero test events/conflicts)
- Throwaway `scripts/hybrid-wiring-smoke.ts` (deleted): **30/30 PASS — "SMOKE: ALL PASS"** — defer/refund/cancel/transfer/transfer-items/merge/reservations/attendance/cash-drawer all verified live; DB fully restored
- dev.log clean during both runs (the only api-error in the log is the historical reconcile 500 from a previous session, already fixed by r30-6/7/8a)
