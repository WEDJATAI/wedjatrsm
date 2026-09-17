# Task 17-a — Purchasing module (Suppliers + Purchase Orders + receiving → stock)

## Status: COMPLETE (API + UI + full lifecycle proven + browser-verified)

## Files owned (all created/replaced)
- `src/app/api/suppliers/route.ts` — GET list (with purchaseCount/totalPurchased aggregates), POST create
- `src/app/api/suppliers/[id]/route.ts` — PUT update, DELETE (409 while POs exist)
- `src/app/api/purchase-orders/route.ts` — GET list (?status= filter), POST create (PO-#### numbering, $transaction)
- `src/app/api/purchase-orders/[id]/route.ts` — GET single, PATCH confirm/cancel/receive (stock + last-purchase-price revaluation in $transaction)
- `src/components/admin/purchases-view.tsx` — two-tab UI (Suppliers | Purchase Orders), 1,531 lines

## Important context for other agents
- **A previous incarnation of task 17-a had already written these 5 files** (timestamps 11:54–12:01) but died before
  testing/worklogging. I reviewed every file against the contract line-by-line (all compliant), then ran the full
  lifecycle test + browser verification it never did. Do NOT rewrite these files.
- DB demo state left intentionally (my tables only): supplier "Nile Foods Supplies" (id 1, phone +20 100 555 1234)
  with 6 POs — PO-0001 received, PO-0002 cancelled (partial receipt 3/5 Cheese), PO-0003 cancelled, PO-0004 received
  (full lifecycle test), PO-0005 cancelled (invalid-case test), PO-0006 ordered with partial receipt (Milk 12/24,
  Tomatoes 10/10) to showcase the Receive button. All product stock/cost changes are consistent receipts
  (reason 'purchase' InventoryTransactions exist for every delta).
- Products whose stock/cost were changed by purchase receipts: Beef Fillet +10@275, Chicken Breast +6@88,
  Cheese +3@190 (previous run); Rice +20@30.50, Potatoes +15@13.75, Milk +12@26, Tomatoes +10@14.5 (my tests).
  If 17-b (stock counts) snapshots system quantities, these are the current true values.
- Receive API semantics: `receivedQty` = NEW CUMULATIVE total per line, clamped to [0, quantity]; reductions below
  the already-received level are rejected 400 (ledger protection); delta-0 resends are no-ops.
- Supplier delete is blocked (409) while any PO references the supplier — history is immutable (Odoo behavior).
- `bun run lint` currently shows 3 errors in `stockcounts-view.tsx` (17-b's in-progress file) — NOT from my files;
  my 5 files have 0 lint findings and 0 tsc errors.
