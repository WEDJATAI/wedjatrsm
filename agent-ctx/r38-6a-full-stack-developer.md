# r38-6a — full-stack-developer (emit-wiring) — work record

Task: Wire `emitOutboxEvent` into every write path of the 14 reference/config CRUD
route files so local menu/config edits flow to the cloud (hybrid sync outbox).

## What was done

1. **Read first**: worklog.md conventions, `src/lib/hybrid-sync/outbox.ts` (THE
   CONTRACT: emit with the SAME Prisma tx as the business write; `row` must be
   the raw Prisma row), `entity-policy.ts` registry, `apply-remote-event.ts`
   (delete ops ARE carried/applied — push.ts sends `operation` verbatim),
   `dmmf.ts` (non-scalar payload keys ignored on apply), the two canonical
   wired routes (`tables/[id]`, `customers`), then all 14 target files in full.

2. **Pattern applied everywhere** (matches the reservations/payments precedent):
   - business write + emit inside the SAME `db.$transaction` (writes that had
     no transaction got one);
   - the emitted `row` is always the PLAIN row (no include relations) so the
     payload carries raw columns only and hashes stay consistent across emit
     sites — where a route previously created/updated WITH an include for its
     response, the tx now writes plain + emits + the response row is re-read
     with the include afterwards (response shapes byte-identical);
   - deletes (hard and soft) read the doomed row(s) FIRST inside the tx, then
     delete, then emit the pre-delete snapshot;
   - upserts (recipes) read existence first to distinguish create vs update.

3. **Coverage (19 write handlers, all verified)**:

   | file | handler | entities emitted |
   |---|---|---|
   | products/route.ts | POST | Product |
   | products/[id]/route.ts | PUT / DELETE | Product |
   | categories/route.ts | POST | Category |
   | categories/[id]/route.ts | PUT / DELETE | Category |
   | modifier-groups/route.ts | POST | ModifierGroup, Modifier |
   | modifier-groups/[id]/route.ts | PUT / DELETE | ModifierGroup, Modifier |
   | recipes/route.ts | POST | RecipeComponent (create or update) |
   | promotions/route.ts | POST | Promotion |
   | promotions/[id]/route.ts | PUT / DELETE | Promotion |
   | stock-counts/route.ts | POST | StockCount, StockCountLine×N |
   | suppliers/route.ts | POST | Supplier |
   | purchase-orders/route.ts | POST | PurchaseOrder, PurchaseOrderItem×N |
   | roles/route.ts | POST | CustomRole |
   | roles/[id]/route.ts | PUT / DELETE | CustomRole |

   Never emitted: User, ProductModifierGroup (composite PK, outside registry).

4. **Verification**:
   - `scripts/r38/verify-emit-wiring.ts` — source-level check (handler-block
     split, per-handler entity coverage vs expected map, non-registry entity
     guard, catch-all for any other writing handler): **19/19 ALL OK**.
   - `bun run lint` → exit 0, zero errors. `bunx tsc --noEmit` → zero errors
     in the 14 files + the script (rest = pre-existing baseline).
   - LIVE end-to-end proof (engine live, cloud reachable): no-op PUTs on
     category 28 (displayOrder — the exact mission repro), product 3, modifier
     group 1 → outbox events #11738/#11739/#11740 (Category/Product/
     ModifierGroup `update`, clean raw-row payloads) went **pending → acked**
     via the engine's own push cycle within ~30s.

## Findings / notes for other agents

- **Out-of-scope registry write paths NOT wired** (outside the 14-file list,
  untouched per the rules — follow-up candidates):
  `suppliers/[id]` PUT+DELETE · `stock-counts/[id]` PATCH + `[id]/counts` PUT +
  `[id]/post` POST · `purchase-orders/[id]` PATCH · `products/[id]/sold-out`
  PATCH · `recipes/[id]` DELETE (the ONLY RecipeComponent delete path!) ·
  `categories/reorder` + `products/reorder` PUTs (dead endpoints, no UI callers).
- `products/route.ts` POST also creates a nested initial-stock
  InventoryTransaction ('purchase') that is NOT emitted (per the task's entity
  spec for that file) — flagged as a wiring decision for a follow-up.
- Fixed the stale comment in `roles/[id]/route.ts` claiming "rsm-hybrid/1
  carries no delete events" — push.ts sends operation verbatim and
  apply-remote-event.ts applies deletes; the comment contradicted the new
  emission.
- No validation / auth / serialization / response-shape changes anywhere; no
  files outside the 14 routes + the verify script were modified.
