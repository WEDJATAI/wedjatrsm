# R30 — Forensic Audit + Hardening Checkpoint (Prompt 1)

**Date:** R30 · **Method:** Two parallel read-only forensic audits (infrastructure/data layer + application surface/write paths) over the entire repository, plus direct inspection of git/CI/provider state. No business functionality was modified.

---

## CHECKPOINT RECORD (created before any hybrid work)

| Item | Value |
|---|---|
| Validated production Git SHA (local) | `7f55cba` — r29 Customers CRM Pro, E2E-verified (lint 0, 12 screenshots) |
| Backup branch | `backup/pre-hybrid-r30` @ `7f55cba` (pushed attempt: no sandbox credentials) |
| Immutable recovery tag | `r29-validated-checkpoint` (annotated) @ `7f55cba` |
| GitHub `origin/main` at audit time | `e7bf6ab` (r26b) — **local is 4 commits AHEAD** (r27/r28/r29 unpushed) |
| Rollback policy | Never reset/revert past `r29-validated-checkpoint`. All future work builds on `7f55cba`+. If any tool attempts to deploy an older commit, STOP and restore newest validated state. |
| Push status | **FAILED from sandbox** — `https://github.com/WEDJATAI/wedjatrsm.git` is readable (public) but no write credentials exist here (no credential helper, no GH/GITHUB token env vars, no SSH keys). Push must be performed from an environment with credentials. Local checkpoint objects protect the state meanwhile. |

## DATABASE / SCHEMA / VERSION STATE

- **Local desktop runtime:** SQLite in WAL mode (`db/custom.db` + `-shm`/`-wal`), 35 models, 0 enums, all PKs `Int autoincrement` except `VisionTableState` (natural key). **No `prisma/migrations/`** — lifecycle is `db:push` + idempotent seed (`prisma/seed.ts` + `customer-fixtures.ts` + `menu-enrichment.ts`).
- **Neon (cloud system of record):** `prisma/schema.postgres.prisma` mirror (35 models + r26b payments columns, ALTER-verified 1,635 rows migrated). Zero runtime driver deps — accessed via `DATABASE_URL` only; Vercel buildCommand regenerates the client from this file. Config lives in Vercel dashboard (not repo).
- **Turso (replica/recovery):** `@libsql/client`, `src/lib/turso.ts` + `turso-sync.ts` (topological DELETE+INSERT full refresh + count verification) + embedded DDL `turso-schema.ts`. **Auth token rotated → cron sync currently fails 401** (dead credential; replica data is stale).
- **Inngest:** app id `wedjatrsm`, serve route `/api/inngest`, 3 registered functions: `rsm-turso-replica-sync` (daily 03:30 UTC), `rsm-daily-digest` (06:30), `rsm-stale-order-alert` (*/30). Signing keys live in Vercel env.
- **Vercel:** `vercel.json` (region `iad1`, crons: turso-sync 03:00, daily-digest 06:15). No `.vercel/` in repo. Last known deployment per worklog: **r26b production rollout**. Cannot query deployment state from sandbox (no token) — unverified.
- **⚠️ Schema must be mirrored in 4 places** for any model change: `schema.prisma`, `schema.postgres.prisma`, `schema.pgtmp.prisma`, `src/lib/turso-schema.ts` (+ Neon DDL migration script). Missing one = drift (this exact failure happened in R27 with `is_super_admin`).

## WHAT EXISTS — Implementation Map

**Platform:** Next.js 16 App Router (single `/` route, hash-based view switching), React, TypeScript, Prisma, Tailwind + shadcn/ui, TanStack Query, full EN/AR i18n (Egyptian Arabic). 116 API route files across 34 domains.

**Desktop:** Mature Electron shell — `desktop/main.js` (500 lines): per-installation data dir, first-run seed from `resources/seed.db`, per-install JWT secret, free-port scan 4312–4321, spawns bundled Next standalone server; `preload.js` context-isolation (renderer gets marker object only, no IPC/Node); `electron-updater` via GitHub Releases (check on launch + 30 min, install on quit); NSIS + portable x64; CI `.github/workflows/desktop-release.yml` (tag `desktop-v*` → windows-latest → publish).

**Sync (one-way, R15):** `src/lib/sync.ts` (953 lines) — `rsm-sync/1` bundle, 18 operational tables, watermark delta (`sync.lastExportAt`), upsert-by-id last-writer-wins, never deletes; routes `/api/sync/{status,settings,export,push,import}` (import = dual auth session-or-key, `x-rsm-sync-key` timingSafeEqual); UI `sync-card.tsx` (702-line Sync Center in Settings) + global `sync-watcher.tsx` (60s poll, auto-push delta when online). **No pull path — cloud→local download does not exist.**

**Offline:** `src/lib/offline-queue.ts` (localStorage, order-creations only, FIFO replay, no server-side idempotency key) + `offline-banner.tsx` + PWA `sw.js` (shell cache only; API network-only).

**Backups:** `src/lib/backup.ts` (`VACUUM INTO` → `backups/`, auto after login, keep 14, strict filename allow-list) + `src/lib/db-snapshot.ts` (auto snapshots keep 30 + atomic refresh of `download/rsm-platform-database.db` + manifest, 10-min watcher via `src/instrumentation.ts`) + `windows-package.ts` (self-contained Windows ZIP).

**Auth:** custom JWT (jose HS256, httpOnly cookie + Bearer fallback), roles `admin|waiter|kitchen` + custom roles with permission keys, exactly one super admin (Dr Ihab, PIN door), 4 machine-auth precedents (sync key / vision ingest key / delivery webhook key / CRON_SECRET — all constant-time compare).

**Audit:** `AuditLog` model (append-only, person attribution) + `logAudit()` fire-and-forget helper, ~60 action codes; no middleware — coverage depends on each route calling it.

**AI:** `src/lib/ai/providers.ts` — chat chain Groq(llama-3.3-70b) → Gemini 2.5-flash → z-ai-web-dev-sdk with timeouts; embeddings chain 3× HuggingFace endpoints → deterministic local fallback (never fails). Used by copilot, briefing (15-min cache), menu-search. Vision/CCTV is rule-based edge processing (no server-side frame inference).

**Domains:** orders (11 routes), tables, KDS via order-items, inventory, purchasing (suppliers/POs), stock counts, waste, cash drawer, reservations, attendance (public check-in wall), customers CRM (R29), products/categories/modifiers/recipes, promotions, reports (9), vision (14), AI (3), auth (8), users/roles, sync (5), settings, audit, integrations (delivery webhook), invoices, admin/backup, cron (2), desktop packaging, Inngest serve.

## WHAT IS GOOD

1. Already **offline-first single-site**: Electron + bundled Next + local SQLite — POS runs with zero internet by design.
2. Mature, shipping desktop pipeline (auto-update, CI packaging, per-install secrets, context isolation).
3. 4 working constant-time machine-auth precedents to copy for device auth.
4. Backup/snapshot engine is real and tested (`VACUUM INTO`, retention, manifest).
5. AI fallback chains already exist per capability (not one global fallback).
6. Audit log with person attribution rides sync bundles.
7. Additive round discipline (28 rounds, nothing deleted; `git-guard.ts` protects ancestry).
8. Full EN/AR i18n and a single launcher/navbar registry making UI additions cheap.

## WHAT IS WEAK (ranked for the hybrid goal)

1. **Integer autoincrement PKs + upsert-by-id merge → guaranteed id collisions in multi-site sync.**
2. **Sync is strictly one-way** (local→cloud). No pull/bootstrap channel.
3. **No conflict-detection data model**: `updatedAt` on only 12/35 models (Customer, OrderItem, Payment, Attendance, CashDrawerEntry, InventoryTransaction, WasteLog, AuditLog lack it); no revision/rowhash/soft-delete/origin-device anywhere.
4. **Watermark diff, no outbox/oplog** — mutations on non-`updatedAt` tables are invisible between exports; no delete propagation.
5. **Offline queue is client-side localStorage, order-creates only, no idempotency key** — replay can duplicate orders.
6. **No device identity or per-device auth** — one shared sync key in AppSetting.
7. **Payment/close path is multi-commit** (payment.createMany → order.update → inventory tx → tables → loyalty tx) — no single transaction to hang an outbox on; same for several POS paths (KDS single-write by design).
8. **4 hand-maintained schema artifacts** + no migration runner for existing desktop installs (updater swaps code, not schema).
9. **Turso replica: full-refresh copy with a dead credential** — unusable as hybrid backbone in current form; also must EXCLUDE queue tables.
10. **Dual pending-change models will fight** (row-scan pending counts vs outbox counts → auto-push loop confusion).

## WHAT MUST CHANGE (additively)

- Add durable event outbox + device identity + pull channel + per-entity conflict policy + hybrid sync state (this round's implementation — see `src/lib/hybrid-sync/`).
- New `rsm-hybrid/1` event format alongside legacy `rsm-sync/1` (legacy untouched).
- Neon DDL migration script for new tables (idempotent `CREATE TABLE IF NOT EXISTS`).
- Turso replica must exclude outbox/queue tables.
- Remove 2 dead R12-era files (below) — they reference schema fields that never existed (`loyaltyPoints`, `LoyaltyTransaction`) and fail `tsc` since before R29; runtime would 500 if ever called. Real loyalty flows live in `src/lib/loyalty.ts` + `/api/customers` PUT.
  - `src/app/api/customers/[id]/loyalty-adjust/route.ts`
  - `src/app/api/customers/customer-helpers.ts`

## WHAT WILL BE PRESERVED (not modified in function)

All POS, kitchen, inventory, purchasing, accounting, reservation, attendance, reporting, Vision, AI, authentication, audit, and administrative functionality; the legacy `/api/sync/*` surface and `rsm-sync/1` format; `sync-card.tsx` Sync Center; offline order queue; backup + snapshot engines; Electron shell + auto-update + packaging CI; seed fixtures.

## WHAT WILL BE ADDED (roadmap R30+)

1. `src/lib/hybrid-sync/` — device identity, outbox, cloud client, push/pull managers, retries (backoff+jitter), reconciliation, per-entity conflict policy, health, sync state, canonical serialization.
2. Prisma models (all 3 schemas + Turso DDL): `HybridDevice`, `HybridEvent` (durable event identity: eventId/deviceId/entity/entityId/operation/revision/payloadHash/payload/status/attempts/lastError/ackedAt), `HybridConflict`, `HybridSyncState`.
3. `/api/hybrid/{push,pull,bootstrap,status,reconcile}` + device registration endpoints with dedicated device-key auth (separate from session auth; provider credentials NEVER in desktop).
4. Hybrid Sync Center UI (admin settings) + POS status pill (`LOCAL MODE — OPERATING NORMALLY` / `CLOUD SYNC — CONNECTED` / `X CHANGES WAITING TO SYNC`).
5. AI capability failover formalization + circuit breaker + safe (secret-free) failure logging.
6. Neon migration script + Turso exclusion + deployment runbook.

## CURRENT RISKS

- **Remote GitHub is 3 rounds behind local** and cannot be pushed from this sandbox (no credentials). Until pushed, the newest validated state exists only locally + in this sandbox backup branch/tag. A `git push origin main --tags` from a credentialed environment is REQUIRED (fast-forward `e7bf6ab` → `7f55cba`, no force).
- Turso credential dead (401) — replica stale until token rotated.
- Vercel deployment state unverifiable from sandbox (no token).
- `next.config.ts` has `typescript.ignoreBuildErrors: true` — type drift risk (pre-existing).
- Windows package ships full source copy (pre-existing design, unchanged).

## AUDIT TRAIL

- Audited by: 2 parallel read-only agents (infra + surface) + direct git/env verification.
- Env var names inventoried (never values): `DATABASE_URL`, `RMS_SQLITE_URL`, `RMS_SNAPSHOT_WATCHER`, `TAX_RATE`, `SERVICE_TAX_RATE`, `JWT_SECRET`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET`, `INNGEST_SIGNING_KEY`, `INNGEST_EVENT_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `HF_API_KEY`, `NODE_ENV`, `PORT`, `HOSTNAME`.
- Secrets in repo: none found in tracked source (`.env` untracked, secret values never printed in this audit).
