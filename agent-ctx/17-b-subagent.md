# Task 17-b — Stock Counts (Foodics Stock Count) + Waste (Foodics Waste)

## Status: COMPLETE (re-verified end-to-end by second incarnation after contract-alignment fixes)

## Files owned & delivered
| File | State |
|---|---|
| src/app/api/stock-counts/route.ts | Reviewed from previous incarnation — compliant, unchanged |
| src/app/api/stock-counts/[id]/route.ts | Reviewed — compliant, unchanged |
| src/app/api/stock-counts/[id]/counts/route.ts | Reviewed — compliant, unchanged |
| src/app/api/stock-counts/[id]/post/route.ts | FIXED: response field `adjustmentsPosted` → `postedAdjustments` (contract letter) |
| src/app/api/waste/route.ts | FIXED: list wrapper `{entries}` → `{wasteLogs}` (contract letter) |
| src/app/api/reports/waste/route.ts | Reviewed — compliant, unchanged |
| src/components/admin/stockcounts-view.tsx | Previous incarnation's version (3 lint errors already fixed via reset-on-close `close()` wrappers + `key={sheet.id}` remount); this run updated the two renamed response fields |

## The 2 contract-alignment fixes (2026-09-17 re-verification)
- Contract says "match that convention for **{stockCounts}/{wasteLogs}**" → waste GET now returns `{wasteLogs: [...]}` (was `{entries}`); view reads `.wasteLogs`.
- Contract says "Return updated DTO + **postedAdjustments** count" → post route + view now use `postedAdjustments` (was `adjustmentsPosted`).

## The lint fix pattern (for future agents hitting `react-hooks/set-state-in-effect`)
- `useEffect(() => { if (open) setX('') }, [open])` → `close()` wrapper resetting state, wired into Dialog `onOpenChange(false)`, Cancel button, and mutation onSuccess. Initial mount state is already clean, so reset-on-close is equivalent. VERIFIED LIVE: reopening Log Waste dialog showed a clean form after a filled+cancelled session.
- Draft state keyed by changing prop id → remove the effect, add `key={id}` on the conditionally-mounted component.

## Verified numbers (2026-09-17 re-verification, admin Amina Hassan)
- SC-0004 lifecycle: P37 25→23 (−2, −12.00 @6), P36 19→20 (+1, +9.00 @9), P30 uncounted → postedAdjustments=2, stock changed by EXACT variances, ledger tx #176/#177 reason 'adjustment', second post 409, cancel-on-posted 409
- SC-0005 cancel-path throwaway: created → cancelled, stock unchanged across cancel
- UI save on SC-0002 (real browser input): P37 count 24 → live variance −1/−EGP6.00, "unsaved counts" hint, Post disabled, Save → toast "Counts saved", 3/22 counted, impact EGP59.60
- Waste #4: P36 qty 1 expired → costValue 9.00, stock 20→19; report 2026-09-17: totalValue 125, entries 4, all 6 byReason rows (3 zeroed), topItems Cheese 95 > Soft Drink 18 > Water 12
- Auth: no token 401 ×8, waiter 403 ×8 (all method+route combos)
- Error paths: countedQty<0 400, product-not-on-sheet 400, missing sheet 404, reason 'theft' 400, qty 0 400, below-zero 400, missing product 400, bad from/to dates 400, action 'reopen' 400, counts-on-cancelled 409
- Audit rows #725–#730 (create/saveCounts/post/waste.log/create/cancel)
- Gates: lint 0 findings TOTAL, tsc 0 src errors, dev.log 0 × 5xx on my routes, UI verified EN desktop + 390px mobile (no overflow) + Arabic RTL (dir=rtl, جرد المخزون/الهدر, no overflow), zero console/page errors

## Final demo dataset (intentional)
- SC-0001 posted (impact 21.00) · SC-0002 open 3/22 counted (impact 59.60 — inputs + pending variances) · SC-0003 cancelled · SC-0004 posted (re-verification lifecycle, impact 21.00) · SC-0005 cancelled (cancel-path throwaway)
- 4 waste entries totalling EGP125.00 (breakage 12 / spoilage 95 / expired 9+9)

## Conventions kept (mirror these)
- List endpoints wrap arrays ({stockCounts}/{wasteLogs}); single objects {stockCount}/{wasteLog}; report {report}; 201 on create
- Local-time date parsing: DATE_RE + `new Date(y, mo-1, d)` + round-trip validation, `end = to + 24h` (exclusive) — same as zreport
- Stock math mirrors /api/inventory/adjust: refuse below zero with 400 (no clamp), stock stored unrounded
- Query keys: ['stock-counts'], ['waste', from, to], ['waste-report', from, to]; after post/waste invalidate ['products']/['inventory']/['inventory-value']/['inventory-transactions'] via useInvalidateStock()
