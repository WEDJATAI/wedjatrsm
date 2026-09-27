# Task 25-d — subagent (full-stack) — KDS new-order sound + highlight

## Task
Make the Kitchen Display System speak the R24 Team Wall's sound language: kitchen staff who can't read fluently must HEAR and SEE when new work arrives.

## Files changed (ONLY these two)
- `src/components/kitchen/kitchen-view.tsx` — new-order detection + sound toggle
- `src/components/kitchen/kitchen-order-card.tsx` — optional `highlight` prop (amber ring)

## Implementation notes (for later agents)
- **Detection**: `seenOrderIdsRef` (Set<number> | null) primes on the FIRST data snapshot (no chime on KDS open). Every later snapshot diffs ids: unseen id ⇒ `sndAlert()` (only when `soundOn`) + `haptic([30,50,30])` (always — silent channel) + one `toast(t('kds.newOrderAlert'))` per batch + 12s in `highlightedIds` state.
- **No filter false positives**: detection reads the RAW query `data` (course/station filters are purely visual in the card); ids are only ever ADDED to the seen-set, so re-appearing ids never re-fire. Optimistic status mutations write unchanged ids ⇒ empty diff ⇒ no chime.
- **Timers**: one removal timer per highlighted id in `highlightTimersRef` Map; unmount effect clears all (no setState on dead component).
- **Sound toggle**: size-11 pill (Volume2/VolumeX, aria-pressed, title/aria-label = `kds.soundOn`/`kds.soundOff`), styles mirror course filter pills exactly (amber active / zinc-700 inactive). Persisted `localStorage['rms-kds-sound']` ('1' on default, '0' muted), SSR-safe lazy useState initializer (typeof window + try/catch). Re-enable plays `sndTap` for audible confirmation.
- **Card ring**: `highlight && 'relative z-10 animate-pulse border-amber-400 ring-4 ring-amber-400 shadow-[0_0_32px_rgba(251,191,36,0.35)]'` listed LAST in `cn()` so twMerge beats the urgency border; z-10 lifts glow above grid neighbours.
- i18n keys pre-existed in `src/lib/i18n/dict/r25.ts` (not touched).

## Verification
- `bun run lint` → 0 findings (exit 0).
- `bunx tsc --noEmit` → 0 errors in kitchen files (repo-wide pre-existing errors in unrelated files remain, untouched).
- dev.log clean (no compile errors).

Worklog record appended to `/home/z/my-project/worklog.md` under `Task ID: 25-d`.
