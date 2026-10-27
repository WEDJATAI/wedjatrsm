# Task r30-6/7/8a — Local-First Hybrid Sync Engine (Prompts 2+3)

Agent: full-stack-developer · Date: R30 · Status: COMPLETE (all gates green)

## What this agent did
Implemented the full rsm-hybrid/1 local-first hybrid sync engine for the restaurant platform, additively, alongside the preserved legacy rsm-sync/1 one-way engine.

## Key files (see worklog.md "Task ID: r30-6/7/8a" for the full log)
- `src/lib/hybrid-sync/` — 15 engine modules (constants, serialization, sync-state, device-identity, entity-policy, outbox, cloud-client, retry, dmmf, push, apply-remote-event, pull, reconcile, health, hybrid-engine)
- `src/lib/hybrid-auth.ts` — device auth (timingSafeEqual sha256 key compare) + session-or-device dual auth
- `src/app/api/hybrid/*` — 10 routes (push, pull, bootstrap, status, reconcile, device, sync-now, pause, retry-failed, errors)
- `src/app/api/admin/backup/restore/` — staged restore (validated allow-list + integrity probe; applied at next boot by hybrid-engine)
- `scripts/hybrid-neon-migrate.ts` — idempotent Neon DDL (NOT executed — deploy-time deliverable)
- `scripts/hybrid-demo.ts` — protocol verification (9/9 PASS)
- Schema ×3 mirrors: +HybridDevice/HybridEvent/HybridConflict/HybridSyncState + Order.originDeviceId
- Turso: HYBRID_QUEUE_TABLES exclusion in turso-sync.ts + turso-schema.ts + turso-schema-gen.ts (queues never replicate)

## Design decisions later agents must know
1. **Entity registry**: `src/lib/hybrid-sync/entity-policy.ts` — entity names are Prisma model names aligned with the legacy sync 18-table registry. `User` excluded (legacy + sensitivity). `ProductModifierGroup` excluded: composite PK (productId+modifierGroupId) cannot be addressed by the single-int `entityId` wire contract — do NOT add it back without a format revision.
2. **Outbox contract**: `emitOutboxEvent(tx, {...})` MUST be called inside the SAME Prisma transaction as the business write (errors roll back the business write by design). Wiring it into business routes (orders/payments/customers) is the NEXT round's work — the engine is built but no business route emits outbox events yet.
3. **Ingest path**: both `/api/hybrid/push` and the local pull cycle use ONE function `ingestRemoteEvent` (dedupe by eventId → per-entity policy → atomic apply). Never duplicate this logic.
4. **Conflict semantics**: conflicts are acked-as-processed (sender stops retrying; divergence recorded in HybridConflict for human review). 'failed' (e.g. FK parent missing) events are NOT acked — the sender retries with backoff; the receiver retries its own failed in-events in the pull cycle (budget 10).
5. **Staged restore**: `POST /api/admin/backup/restore` only stages (db/restore-pending.db + HybridSyncState 'restore.pending'); `applyStagedRestoreAtBoot()` performs VACUUM INTO safety snapshot → inode-preserving rename dance → file swap at NEXT boot. Never call it at runtime.
6. **Kill-switches**: `RMS_HYBRID_WATCHER=0` disables the engine boot (instrumentation.ts); `RMS_SNAPSHOT_WATCHER=0` still controls only the snapshot watcher. Engine is SQLite-only by design (the cloud deployment is the sync TARGET, not an initiator).
7. **Turso regen**: `bun scripts/turso-schema-gen.ts` now emits the FULL file (HYBRID_QUEUE_TABLES + TURSO_DDL_MIGRATIONS preserved). When adding columns to EXISTING models, add a tolerant ALTER to the migrations list in the generator's template (fresh DBs get them via CREATE TABLE, live replicas via ALTER). The R30 regen incidentally healed R27's users.is_super_admin replica drift.
8. **Neon deploy prerequisite**: run `DATABASE_URL=<neon> bun scripts/hybrid-neon-migrate.ts` BEFORE pushing r30 code to Vercel (hybrid tables + orders.origin_device_id must exist server-side first).

## Gate evidence
- `bun run lint` → 0 findings
- `bunx tsc --noEmit` → 12 errors, all pre-existing legacy (inngest/print/round12-migrate/migrate-neon/products-reorder); ZERO new from this task's 37 touched files
- `bun scripts/hybrid-demo.ts` → "HYBRID PROTOCOL: ALL PASS" (9/9 steps)
- dev.log clean during demo; engine boots ([hybrid-engine] started (interval 30s))
- `bun run db:push` additive, verified twice, data intact
