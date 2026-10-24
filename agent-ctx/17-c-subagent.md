# Task 17-c — Promotions engine + POS integration (subagent 17-c)

## What this agent did
Round 17 promotions (Foodics happy-hour style automatic discounts) with live POS integration. Full details in `/home/z/my-project/worklog.md` → section `Task ID: 17-c`.

## Files owned/created (do not duplicate work)
- `src/lib/promotions.ts` — NEW pure evaluation library (client+server safe, no db imports): `isPromotionLive`, `evaluatePromotion`, `bestPromotion`, `toPromotionDTO`, `promoReason`/`isPromoReason` (`PROMO #<id> — <name>` marker convention), `CartLine` type.
- `src/app/api/promotions/route.ts` — GET (list ?activeOnly=1; perms admin/promotions/**pos** — POS cart preview needs waiter access) + POST create (full validation) + audit `promotion.create`.
- `src/app/api/promotions/[id]/route.ts` — PUT (merged-row validation, safe scope-target switching) + DELETE + audits.
- `src/components/admin/promotions-view.tsx` — full admin UI (was a placeholder): list w/ chips + schedule + inline active toggle, create/edit dialog (all fields incl. weekday pills, time/date pickers), delete confirm.
- **Surgical money-path integration** (shared, careful):
  - `src/lib/orders.ts` `recomputeTotals` (~lines 304-368) — THE single server-authoritative choke point: no manager discount + open order → evaluate best live promo at server time, set `discountAmount`/`discountReason='PROMO #<id> — <name>'`; manager discount wins, never stacked; no match → discount resets to 0. Runs at order create + PUT /api/orders/[id] + transfer-items + merge + delivery webhook.
  - `src/components/pos/cart-panel.tsx` — display-only promo preview line (PROMO badge + name + −amount), promo-aware Payment button amount; `src/components/pos/pos-view.tsx` passes `products` prop (1 line) for category matching.

## Key conventions for later agents
- Discount-source rule: manager reason (non-empty, NOT starting with `PROMO`, amount>0) blocks promos; reasons starting with `PROMO` are reserved engine markers.
- Promotion list endpoints wrap as `{promotions}` (17-a/17-b list-wrapper convention).
- `toPromotionDTO` dates are LOCAL `YYYY-MM-DD` keys (not full ISO) — date-input + timezone-proof.
- Only OPEN orders re-evaluate promos; paid/cancelled/deferred keep settled totals.

## Verification evidence (see worklog for full numbers)
- 50/50 pure-library unit checks; full CRUD + 14 validation 400s + auth matrix via curl.
- Order math verified: 10% order-scope (215→21.50), manager-wins (25 kept, no stack, promo returns after removal), out-of-window → 0 + stale promo clears, category fixed 15 (in/out of category), product scope w/ modifier deltas (97→48.50), fixed 500 clamps to subtotal (total 0.00, never negative).
- UI (agent-browser): create/edit/delete/toggle through real dialogs; POS cart client preview matched server to the penny (19.50/221.13); manager-discount order shows no promo badge; Arabic RTL + 390px clean.
- All 16 test orders cancelled via the cancel API (no row deletions). Demo state: 3 promos (Happy Hour active 10%, Late Night Happy Hour 22:00–02:00 active, Drinks Deal fixed EGP 15 Beverages inactive).

## Incident note
Platform dev server died externally at 13:46 (no error logged, nothing respawned). Restarted via python double-fork daemon (R13 pattern), stable since. If port 3000 is dead for you: same recovery applies.

## Quality gates at handoff
`bun run lint` 0 findings · `bunx tsc --noEmit` 0 src errors · dev.log zero 5xx on promotions routes · GET / 200.
