# Task r30-10 — Hybrid Sync Center UI (Prompt 4)

Agent: full-stack-developer · Date: R30 · Status: COMPLETE (all gates green)

## What this agent did
Built the admin + POS surfaces for the rsm-hybrid/1 engine: the Hybrid Sync Center card in Settings (sibling AFTER the legacy bundle SyncCard — that card is untouched), a calm status pill in the POS order header, and the r30 i18n dictionary (EN + Egyptian Arabic).

## Files (6)
- `src/components/admin/hybrid-sync-card.tsx` (NEW, ~1,180 lines) — status tiles, calm-mode banner, controls, errors/reconcile/restore dialogs, device management with show-once keys
- `src/lib/i18n/dict/r30.ts` (NEW) — ~95 keys × EN/AR, prefix `hybrid.`, registered in `src/lib/i18n/index.tsx` DICT_PAIRS
- `src/lib/types.ts` — +HybridStatusDTO / HybridSyncNowResult / HybridErrorEvent / HybridDeviceDTO / HybridReconcileReport
- `src/components/admin/settings-view.tsx` — `<HybridSyncCard />` right after `<SyncCard />`
- `src/components/pos/pos-view.tsx` — `HybridSyncPill` at the end of the order-mode header controls

## Contracts the next agent must preserve
1. **Query keys**: the card and the POS pill SHARE `['hybrid','status']` (card: 30s interval / pill: 60s, both staleTime 20s, retry:false). Backups use the EXISTING `['backups']` key (shared with the settings BackupCard — one fetch, both cards). Errors: `['hybrid','errors']` (enabled only while the dialog is open). Devices: `['hybrid','devices']` (enabled only while the collapsible is open). If you add hybrid UI, reuse these keys — do not create parallel caches.
2. **Sync-now 409**: the route answers `{error:'sync already running'}` with 409; the card detects it by message content ("already running") since `apiFetch` throws a plain `ApiRequestError`. If you change the route's 409 wording, update the card's check.
3. **Calm-mode semantics (product rule)**: LOCAL MODE is NEVER red. Priority: pendingUploads>0 → amber waiting; cloud reachable+online+0 pending → emerald connected; everything else → emerald LOCAL MODE — OPERATING NORMALLY. The POS pill must never toast/modal/click — waiters cannot open Settings.
4. **Device keys are shown EXACTLY once** (register + rotate). The reveal dialog copies to clipboard only; there is no "show again" — by design (the server stores sha256 only).
5. **Restore is staged-only**: the dialog's confirm text promises a safety snapshot + restart; the actual swap happens at next boot via `applyStagedRestoreAtBoot` (r30-6/7/8a). Never call restore outside the AlertDialog flow.
6. **Types live in types.ts** — the health snapshot shape is mirrored there; if `buildHealthSnapshot()` changes, update `HybridStatusDTO` in lockstep.

## Gate evidence
- `bun run lint` → 0 findings · `bunx tsc --noEmit` → 12 errors, ALL the documented pre-existing legacy baseline (inngest/print/round12-migrate/migrate-neon/products-reorder); ZERO new.
- E2E (agent-browser, manager door → Dr Ihab → 123456): 11 screenshots r30-01..10 + r30-09b — all tiles render honestly (CLOUD "Not configured" — no cloud target in this sandbox), Sync Now → "0 pushed · 0 acked · 0 applied", Pause→Paused→resumed, errors dialog empty-clean, device registered with one-time key + Copy, restore dialog listed the real backup and was CANCELLED (nothing staged), POS pill "LOCAL MODE — OPERATING NORMALLY" emerald, Arabic RTL fully translated. Browser console 0 errors/warnings; dev.log every hybrid/backup call 200, zero api-errors this session.

## Honest caveats for the next agent
1. **CLOUD "Not configured"** is the correct sandbox state — the connected/waiting banner variants + reconcile drift badges + 409-busy toast are implemented per route contracts but NOT live-exercised (no cloud peer exists here). First live exercise happens when a real targetUrl is set.
2. **390px**: the app renders the pre-existing R15 mobile waiter portal (not the desktop POS tree) below 768px — so the pill's compact <sm variant (dot + count) is unreachable in practice; verified instead at 768px (pill renders, POS header no overflow). The 768px document horizontal overflow that exists is PRE-EXISTING (app navbar `HEADER.sticky.top-0` right controls), not from the pill.
3. The E2E-registered device **"Front Desk Tablet"** stays in the registry (inert; key shown once in-session only) — revoke it via the card's dropdown if you want a pristine list.
4. The legacy SyncCard (bundle sync) and the new Hybrid card intentionally COEXIST: bundle = whole-table one-way export/import; hybrid = event-based device-to-cloud. Do not merge or remove either.
5. Language was restored to EN and sync was resumed after E2E — app state is clean (no restore staged, verify `restorePending` null via /api/hybrid/status if in doubt).
