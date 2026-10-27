# Work Record — Task r38-6b

- **Task ID**: r38-6b
- **Agent**: full-stack-developer (emit-wiring completion)
- **Mission**: Wire remaining follow-up outbox emitters (sub-routes + nested writes) for the hybrid two-way sync, following r38-6a's canonical pattern.

## What was done

All 8 listed files existed and were wired (business write + `emitOutboxEvent` in the SAME `db.$transaction`; `row` = plain Prisma row snapshot; deletes read the doomed row first inside the tx and emit the pre-delete snapshot):

| File | Handler | Entities emitted |
|---|---|---|
| `src/app/api/suppliers/[id]/route.ts` | PUT | Supplier `update` |
| `src/app/api/suppliers/[id]/route.ts` | DELETE | Supplier `delete` (pre-delete snapshot) |
| `src/app/api/stock-counts/[id]/route.ts` | PATCH (cancel) | StockCount `update` |
| `src/app/api/stock-counts/[id]/counts/route.ts` | PUT | StockCountLine `update` per line written |
| `src/app/api/stock-counts/[id]/post/route.ts` | POST | InventoryTransaction `create` per adjustment + Product `update` per stock move + StockCount `update` (status flip) |
| `src/app/api/purchase-orders/[id]/route.ts` | PATCH (confirm/cancel/receive) | PurchaseOrder `update` + (receive) InventoryTransaction `create` per delta, Product `update` per stock/cost revaluation, PurchaseOrderItem `update` per line |
| `src/app/api/products/[id]/sold-out/route.ts` | PATCH | Product `update` |
| `src/app/api/recipes/[id]/route.ts` | DELETE | RecipeComponent `delete` (pre-delete snapshot) |
| `src/app/api/products/route.ts` | POST | Product `create` (already wired) + InventoryTransaction `create` for the nested initial-stock ledger row (re-read via `tx.inventoryTransaction.findMany` inside the same tx) |

## Key decisions / notes for later agents

1. **Product `update` emissions in stock-count post + PO receive are deliberate and required**: `apply-remote-event.ts` applies an event as a whole-row upsert — an `InventoryTransaction` create event only inserts the ledger row and never moves product stock. Without the Product event (which carries the post-write stock snapshot) the other terminals' stock levels diverge. No double-application risk: the Product event overwrites the row (it does not increment).
2. Response rows that need relations (supplier PO aggregates, StockCount sheet, PO detail) are written PLAIN inside the tx (so the event payload carries raw columns only) and re-read WITH the include after the tx — response shapes byte-identical. This is r38-6a's established pattern.
3. `stock-counts/[id]/counts` PUT does NOT emit a StockCount event — the parent sheet row is not modified by that handler.
4. Zero-delta receive lines still emit PurchaseOrderItem `update` because the row update write genuinely runs for every step.
5. Nothing emitted for `User` or `ProductModifierGroup` anywhere. Modifier-group link writes in products POST remain excluded (composite PK, outside the registry).
6. Remaining unwired registry-entity write paths in the whole app: `categories/reorder` + `products/reorder` PUTs only (dead endpoints per r37 audit, no UI callers — out of scope, untouched).

## Verification

- `bun scripts/r38/verify-emit-wiring-2.ts` → **9/9 handler checks ALL OK** (incl. forbidden-entity check for User/ProductModifierGroup).
- `bun scripts/r38/verify-emit-wiring.ts` (r38-6a first wave) re-run → still **19/19 OK** (products POST enrichment is additive, no regression).
- `bun run lint` → exit 0, zero errors.
- `bunx tsc --noEmit` → 45 errors, ALL pre-existing baseline (agent-desktop/main.ts, old scripts, out-of-scope products/reorder); zero in the 8 wired files or the new script.
- Compile smoke: unauthenticated hits to all 8 routes → all 401 (routes compile + auth guard), zero 500s; dev.log clean.

Full narrative work log: `/home/z/my-project/worklog.md` (entry `Task ID: r38-6b`).
