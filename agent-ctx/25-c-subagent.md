# Task 25-c — subagent (full-stack): POS tile visual upgrade (R25)

Task: Upgrade the POS product tiles (src/components/pos/product-grid.tsx) to a
visual-first, zero-reading design matching the R24 Team Wall design language
(recognition by IMAGE, COLOR and SIZE — not by reading).

## Context read first
- worklog.md global conventions + Task ID 24 (Team Wall).
- src/components/pos/product-grid.tsx (old ProductTile), src/components/pos/pos-utils.ts
  (guessCourse/CourseKey), src/lib/types.ts (Product.imageUrl), src/lib/feedback.ts
  (sndTap/haptic — pre-built, R25), src/components/auth/team-wall.tsx (card patterns),
  src/components/pos/pos-view.tsx (['pos-products'] query → /api/products?sellable=1),
  src/app/api/products/route.ts (serializeProduct), eslint.config.mjs (no-img-element OFF).

## API / DB findings
- GET /api/products ALREADY returns `imageUrl`: the route uses `include` (all scalars)
  and serializeProduct spreads `...p`. POS consumes the same endpoint. → NO API change.
- DB (db/custom.db, via bun:sqlite — sqlite3 CLI missing; column is `image_url`):
  0 products have an imageUrl → per instructions did NOT seed; the medallion
  fallback is the live design. (Orphan public/dishes/*.png exist but unreferenced.)

## What changed (src/components/pos/product-grid.tsx ONLY)
- Added `import { haptic, sndTap } from '@/lib/feedback'`.
- Added `COURSE_MEDALLIONS: Record<CourseKey, string>` — literal per-course tint
  classes (starter=emerald-100/emerald-700, main=amber, dessert=fuchsia, drink=teal).
- ProductTile rewritten:
  1. PHOTO TILES (imageUrl set, not failed): full-width 4:3 header band
     (`aspect-[4/3] w-full rounded-t-xl object-cover`, plain <img>, alt = localized
     name, lazy+async); compact body: name (text-base font-semibold) + price
     (text-lg font-bold tabular-nums text-primary) on one row, chips, right-aligned
     badges; button goes p-0 gap-0 so the band is flush with the tile border.
  2. onError fallback: per-tile useState flag flips the tile to the medallion layout.
  3. NO-PHOTO TILES: BIG size-12 rounded-xl colored medallion (course icon size-6),
     centered header like the R24 team-wall faces (keeps the icon clear of both 44px
     corner toggles at every grid width and frees the full tile width for the name);
     name text-sm→text-base font-semibold, price → text-lg font-bold.
  4. All existing behavior kept: favorites star (top-end), 86 toggle (top-start),
     allergen/dietary chips, options badge, stock badges, sold-out
     disabling+pointer-events-none, active:scale-95, Arabic secondary line,
     bilingual search/category/favorites pills, grid unchanged (2/3/4 cols).
  5. Tile onClick now calls sndTap() + haptic(8) before onAdd(product).
  6. Additive polish: h-full (tiles equalize per grid row — photo tiles run taller),
     whitespace-normal (Button base ships nowrap; text-base names need to wrap),
     white/85 backdrop-blur pill on the corner toggles when a photo is showing.

## Verification
- `bun run lint` → 0 findings (exit 0).
- `bunx tsc --noEmit` → no errors in product-grid.tsx (remaining repo errors are
  pre-existing, other agents' files).
- dev.log: clean hot recompile after edits, no errors.
- No changes to page.tsx, prisma schema, API routes; no packages; no tests; no git.

## Report for the main agent
- Files changed: src/components/pos/product-grid.tsx (only).
- imageUrl in API: YES, already present (no additive change needed).
- Seeded images: NONE (0 rows) — medallion layout carries the design.
- Lint: 0 findings.
