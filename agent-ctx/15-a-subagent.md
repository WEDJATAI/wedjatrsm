# Task 15-a — subagent record (backend sync + Windows package)

Round 15, agent 15-a. Counterpart: 15-b (frontend Sync Center / download UI, working in parallel).

## What I built (file ownership respected — created only these)

- `src/lib/sync.ts` — sync engine: AppSetting-backed settings (`sync.targetUrl|autoExport|lastExportAt|lastPushAt|key`), lazy 48-hex key, masked exposure, pending counts (created_at > lastExportAt for the 9 synced tables), bundle builder (delta = watermark rows + ALL open orders incl. items+payments; full = everything; Prisma client field names, dates→ISO), defensive normalizers + FK-ordered per-row upsert importer (skip-on-failure, never delete, sender wins).
- `src/lib/windows-package.ts` — temp-dir package builder: copy tree w/ excludes, patch package.json (Windows-safe dev/start), fresh `.env` (`file:../db/custom.db`), live=VACUUM INTO snapshot | demo=db push+seed via env override + throwaway-PrismaClient verification, CRLF bats (install/start/stop), bilingual README-WINDOWS.md, info-zip, size check, cleanup on all paths.
- Routes: `api/sync/status` (GET), `api/sync/settings` (PUT, zod), `api/sync/export` (POST), `api/sync/push` (POST → remote `/api/sync/import`, 502 on failure, watermark only on success), `api/sync/import` (dual auth: session OR `x-rsm-sync-key` timingSafeEqual; format gate), `api/desktop/package` (GET ?data=live|demo, streams zip, always cleans temp).

## Key facts for other agents

- Import body must be the **SyncBundle itself** (top-level `format: 'rsm-sync/1'`), NOT the export response wrapper `{ bundle, exportedAt }` — unwrap before importing a saved export file.
- The full sync key is never exposed via API (status returns `syncKeyMasked` = `031c…9179` style). It lives in AppSetting `sync.key`; rotate via PUT settings `{ rotateKey: true }` (old key dies immediately — verified 401).
- Push semantics: builds same bundle as export; `lastExportAt` advances only for **delta** pushes **after** a 2xx from the remote; `lastPushAt` on success. Full mode never marks (snapshot semantics, same as export).
- Demo package generation runs `bun x prisma db push --skip-generate` + `bun run prisma/seed.ts` from the PROJECT cwd with `DATABASE_URL` env override → temp file. Verified the live db is untouched (env var beats .env in both bun and prisma CLI).
- Audit actions used: `sync.export|sync.import|sync.push|sync.settings|desktop.package`, entity `system`. Key-auth imports audit as user `system (sync)` (userId 0 — audit_logs.user_id has NO FK, checked with PRAGMA foreign_key_list).
- End state I left: targetUrl='', autoExport=false, key present, watermarks honest (lastPushAt 01:08:40Z from the verified self-push loop). No test residue.

## Verification evidence (summarized)

- lint 0; tsc 0 in my files (1 pre-existing error in waiter-portal.tsx = 15-b's file, mid-edit).
- Self-import idempotency: delta 0/17/0, full(1,294 rows) 0/1294/0 inserted/updated/skipped.
- Push loop to self: 200, remote merged 0 inserted/1299 updated. Bad target → 502. No target → 400.
- Auth matrix: anon 401, waiter 403, wrong key 401, rotated-old key 401, new key 200.
- Zips: live 896,934 B, demo 830,887 B; contents verified (all must-haves, 0 forbidden entries, CRLF bats, relative .env, demo db seeded+integrity ok, live snapshot integrity ok, temp cleanup proven).
- dev.log 500s: two windows, both caused by 15-b's transient waiter-portal.tsx parse error (all routes 500'd together, recovered on their fix). 0 attributable to my code.
- Dev server died once before my tests (known sandbox pattern) — restarted once, daemonized; single healthy instance on :3000 since.
