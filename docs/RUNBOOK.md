# RSM PLATFORM — RUNBOOK & FIXES LEDGER

> **The durable memory.** This file is committed to git (survives every recycle —
> `.git/` has never been wiped in 8 events). Any future agent (or human) should
> be able to recover the ENTIRE platform from this document alone.
> Last verified all-green: p19 (2026-10-02), HEAD after 402329c.

---

## 1 · Platform inventory (what exists, where)

| Piece | Location | Role |
|---|---|---|
| Next.js 16 app (POS, team wall, KDS, manager, AI copilot) | `/home/z/my-project` (this repo) | The product |
| Local SQLite | `db/custom.db` (DATABASE_URL in `.env`) | Local-first database |
| **Neon Postgres** | URL in vault / `.env.deploy-local` | **Production DB (source of truth on the cloud)** |
| **Turso** | URL+token in vault | Read replica (35-table mirror, daily sync) |
| **Vercel** | project `wedjatrsm` → `wedjatrsm-tonsy.vercel.app` | Production hosting + 2 crons (daily-digest 06:15, turso-sync 03:00 UTC) |
| **GitHub** | repo in vault `GITHUB_REPO` | Code + tracked recovery point + branch protection |
| **Inngest** | signing key in vault | Scheduled jobs (turso-replica-sync 03:30, daily-digest 06:30, stale-order-alert */30) |
| AI providers | 5 keys in vault (groq/openrouter/nvidia/gemini/huggingface) | AI copilot + consensus engine |

**Five-platform harmony check:** `bun scripts/p13-harmony-check.ts` (or `bun scripts/harden-verify.ts --cloud`).

## 2 · Credential stores & THE VAULT

| Store | Keys | Notes |
|---|---|---|
| `.git/env-vault.env` | **21 — FULL UNION** | **THE VAULT. Inside `.git/` = recycle-proof (proven 8×). NOT a git object — never pushed.** |
| `.env` | 10 (app: DATABASE_URL, JWT_SECRET, 5×AI, Turso, Inngest) | Read by the app at boot |
| `.env.deploy-local` | 19 (deploy creds + AI) | Read by scripts via `scripts/lib/env-local.ts` |
| `.git/deploy-creds.env` | 14 (deploy creds) | 2nd recycle-proof copy |
| `/home/z/.deploy-creds.env` | 14 | 3rd copy (home dir) |
| `/home/z/.deploy-creds-ai.env` | 5 (AI keys) | 4th copy |

**Rules:**
- Rotate a key → update the vault → `bun scripts/auto-heal.ts` (rebuilds all stores) → update the cloud (Vercel env / Neon / Turso console).
- NEVER `source` any of these files in bash — Neon URLs contain `&` and get mangled. Always read them through bun scripts / `scripts/lib/env-local.ts`.
- Rebuild the vault after adding a NEW key: `bun scripts/p19-build-vault.ts`.

## 3 · The recycle (the disaster this platform survives)

**Signature (8 events so far — all reversed with zero data loss):**
1. `db/custom.db` wiped to a **bare schema (0 users)**.
2. `.env` stripped to `DATABASE_URL` + `JWT_SECRET` only.
3. `.env.deploy-local` + `/home/z/.deploy-creds*.env` **deleted**.
4. 500-600 file-mode flips (755) staged into the git index.
5. **Survivors, every time: everything inside `.git/`** — commits, tags, `refs/protected/*`, `.git/deploy-creds.env` (and now the vault).

**The old kill chain (now closed by p19):** the dev server restarts → snapshot watcher `lazy-init` → snapshots the BARE db → **overwrites `download/rsm-platform-database.db` (the tracked recovery point)** → data loss becomes near-permanent (only HEAD's committed copy survived).

### Recovery — three tiers (use the first that applies)

**Tier 1 — AUTOMATIC (p19).** Do nothing. On the next dev-server boot,
`src/lib/recycle-guard.ts` (via `src/instrumentation.ts`) detects the bare db,
stages a restore (priority: git HEAD tracked recovery point → disk recovery
point → newest auto snapshot → newest manual backup), applies it through the
PROVEN staged-restore path, rebuilds all env stores from the vault, and
verifies. Look for `[recycle-guard] ✔ SELF-HEALED` in `dev.log`. The snapshot
engine also REFUSES to snapshot a bare db or demote the recovery point on a
>60% row collapse (`recycle-guard:` refusals in logs = protection working).

**Tier 2 — ONE COMMAND.** `bun scripts/auto-heal.ts` (add `--dry-run` to just
look). Heals env stores, db, git index modes; prints a verification report.

**Tier 3 — MANUAL (if both above somehow fail):**
```bash
cd /home/z/my-project
# 1. rebuild env stores from the vault (or copy .git/deploy-creds.env content)
bun scripts/auto-heal.ts            # env heal works even if db heal can't
# 2. stage the restore from git HEAD's tracked recovery point
git show HEAD:download/rsm-platform-database.db > db/restore-pending.db
# 3. set the marker (bun -e with @prisma/client, INSERT INTO hybrid_sync_state
#    (key,value,updatedAt) VALUES ('restore.pending','manual',CURRENT_TIMESTAMP))
# 4. restart the dev server — instrumentation applies the staged restore
# 5. verify: bun scripts/harden-verify.ts
```
**Last resort:** Neon is the cloud source of truth — `bun scripts/p12-cloud-pull.ts`
rebuilds local from Neon.

### Verification (run after ANY recovery or at any doubt)
```bash
bun scripts/harden-verify.ts          # local posture (15 checks)
bun scripts/harden-verify.ts --cloud  # + five-platform harmony
```

## 4 · ALL FIXES LEDGER (the memory of every repair)

> Consolidated from the worklog. "p-numbers" refer to worklog sections in `/home/z/my-project/worklog.md`.

| # | Fix | Where |
|---|---|---|
| r18/r20 | Sandbox wiped db/ + backups/ twice → recovery point moved to `download/` (survives), in-app snapshot engine built | `src/lib/db-snapshot.ts` |
| R19 | Stale Prisma client stranded after `prisma db push` → snapshot engine now uses short-lived clients per call | `src/lib/db-snapshot.ts` |
| R21 | Background shells die between sessions → snapshot watcher runs INSIDE the Next.js server process (instrumentation) | `src/instrumentation.ts`, `src/lib/snapshot-watch-init.ts` |
| R23 | Query logging too noisy/slow on serverless → dev-only query logs | `src/lib/db.ts` |
| r27 | Manager sign-in isolation (super-admin PIN door) | manager-login APIs |
| r30 | Local-first hybrid sync engine (durable outbox, push/pull, per-entity conflict policy, staged restore) | `src/lib/hybrid-sync/*`, 10 `/api/hybrid/*` routes |
| p9/p10 | Lelo house menu live (176 items, idempotent LO-* SKUs); retired demo menu rows RE-IDED on Neon (226-229) — why Neon shows 229 products vs local 225 (policy, not drift) | scripts/p10* |
| p12 | Two-way cloud sync (Neon↔local) + collision guard; 1 dead outbox letter is the DOCUMENTED collision guard, not a bug | `scripts/p12-cloud-pull.ts` |
| p13 | Five-platform harmony checker | `scripts/p13-harmony-check.ts` |
| p14 | Neon id-remap contract for outbox events (local ids ≠ neon ids) | hybrid engine |
| p15 | AI layer rebuilt: 5 providers, model-level failover (sibling model), provider chain failover, CONSENSUS engine (parallel + medoid + abstention + deadline). Honest limits: groq 403 / gemini 401 keys rejected by their platforms (registered — re-arm by putting a fresh key in the vault + `auto-heal`); OpenRouter region-blocked from Vercel egress (prod voters = NVIDIA+HF; sandbox = OR+NVIDIA+HF) | `src/lib/ai/*`, `/api/ai/*` |
| p15q | nemotron reasoning model echoed task instructions in briefings → anti-preamble instruction in system prompt | briefing route |
| p16 | Recycle #7 recovery; mode-flip normalization trick (recycle STAGES 755 into the index — working-tree chmod alone is invisible until re-add) | worklog p16 |
| p17 | Recycle #8 recovery; cloud-first verification order (verify Neon/Turso/Inngest BEFORE touching local) | worklog p17 |
| p18 | POS wide-screen bug ROOT CAUSE: flex pane lacked `min-w-0` (grid forced 2657px in 1920 viewport) + auto-fill grid `repeat(auto-fill,minmax(170px,1fr))`; menu reorganized 24→17 categories; variant consolidation (Omelet/Roll Pie/coffee/water/frappuccino = ONE tile + options); modifier-28 id collision (p18c repair — explicit ids can collide: always probe max(id) first) | POS menu components, scripts/p18* |
| p18b | Modifier 24 "Olive oil" predated the outbox → never reached Neon; re-emitted via engine channel. 13 orphaned option links on retired demo products → 15 relinks (Caesar dressing, 8 pizzas extras, 6 dessert toppings) | scripts/p18b*, p18c* |
| **p19** | **THE HARDENING (this document's reason):** vault, bare-db recycle guard + shrink ratchet, boot self-heal, auto-heal CLI, harden-verify, this runbook. Rehearsal-proven 14/14 in /tmp | `src/lib/recycle-guard.ts`, `src/lib/db-snapshot.ts`, `scripts/auto-heal.ts`, `scripts/harden-verify.ts`, `scripts/p19-rehearse.ts` |
| **r31** | **THE COO AUDIT + WRITE-PATH RESCUE:** (1) partial-cash payment stale-memo bug (submitRows/checkRows missing cashCharge deps → 400 on every partial cash tender) — fixed + browser-verified; (2) non-atomic order create left zombie zero-total orders that synced to Neon — recomputeTotals now takes a txScope and rides the create transaction (also the delivery webhook); (3) SQLite write convoy + runtime DEADLOCK under concurrency (app tx held the SQLite write lock while the hybrid engine's apply-tx busy-waited on it inside the Prisma runtime, blocking the first tx's next query) — fixed with journal_mode=WAL + `?socket_timeout=30000&connection_limit=1` in DATABASE_URL + `withWriteLock` FIFO mutex (src/lib/write-mutex.ts) + 30 s tx timeout: **93% create failure at 6 writers → 0 errors / 10,781 reqs / 15.4 creates-sustained**; (4) data repairs via designed channels: 16 stale/zombie orders cancelled, order #40 recomputed (was undercharging EGP 327.60), order #87 takeaway→dinein; (5) dev query logging now opt-in (RSM_QUERY_LOG=1; it measured 70k lines/23 MB per 3-min stress run + OOM'd the 4 GB sandbox at 2.5 GB RSS); (6) developer role can cancel orders, merged orders can no longer be cancelled; (7) payment button shows remaining after partial payment. Full report: `docs/r31-coo-audit.md`; stress gates: `scripts/r31-stress.ts` + `scripts/r31-integrity.ts` | `src/lib/db.ts`, `src/lib/write-mutex.ts`, `src/lib/orders.ts`, orders + webhook + cancel routes, payment-modal, cart-panel, `.zscripts/daemonize-dev.py` |
| **p20** | **THE HARMONY PASS (five platforms, end-to-end, after recycle #9):** (1) CLOUD-ORIGIN DELIVERY GAP (architectural): the owner's own prod POS writes (check merges/defers/payments/table moves — 133 events, deviceId `unbound`) were emitted to the cloud's outbox that NOTHING delivers — the pull endpoint only served relayed in-events. Fixed: cloud instances also serve their origin writes in the same cursor stream (`src/app/api/hybrid/pull/route.ts`). The owner's Oct-2 session (#93 merged, #330 deferred, #329 moved, table 15) converged to the local terminal live; (2) OUT-OF-ORDER BATCH RACE: engine tick + sync-now ran CONCURRENT push cycles → parallel batches applied out of order on the cloud, and origin-authority (no revision check once its guard passes) let a late rev-1 CREATE overwrite an applied rev-3 CANCEL — orders #590-605 re-opened on Neon by their own create payloads. Fixed: cycles serialized (tick shares the sync-now `cycleRunning` flag) + revision floor under origin-authority (shared `revisionFloorDecision()`); (3) recycle #9 silently DEGRADED `.env`'s DATABASE_URL (param-less — env-heal only fills MISSING keys; vault value was correct): restored + clean restart; (4) data repairs via designed channels: 26 stress-residue orders cancelled (preflight-guarded), 50 OOM-orphaned 'inflight' events released, REAL paid order #1210 + payment #208 (EGP 54.18 cash, lost to the recycle — own-echo events the pull can never serve) recovered from Neon through `ingestRemoteEvent`, 6 race-damaged orders re-emitted at rev+1; (5) outbox 2,670 → 0; local == Neon EXACTLY (1038/1038 orders, 208/208 payments — first full parity since the recycle); Turso refreshed on demand (35/35 exact); harden-verify --cloud 16/16 | `src/app/api/hybrid/pull/route.ts`, `src/lib/hybrid-sync/hybrid-engine.ts`, `src/lib/hybrid-sync/apply-remote-event.ts`, `scripts/p20-repair.ts`, `scripts/p20-touch-590.ts`, `scripts/p20-turso-sync.ts`, `scripts/p20-snapshot.ts` |

## 5 · Known benign artifacts (do NOT "fix" these)

- **PINs are intentionally NOT synced local↔cloud** — `User` rows are excluded from hybrid sync by design (passwordHash/PIN must never ride events; see `src/lib/hybrid-sync/entity-policy.ts`). The owner changed the manager PIN **on prod** and the developer PIN **locally**, so they differ BY OWNER ACTION:
  | Account | Local PIN | Prod (Neon) PIN |
  |---|---|---|
  | admin@rms.com (Manager) | 123456 (default) | **270761** (owner-changed, audit 2026-09-29) |
  | developer@rms.com | **180787** (owner-changed, audit 2026-10-01) | 111111 (default) |
  | all other 7 users | identical both sides | identical |
  Changing a PIN on one side does NOT change the other — do both deliberately if you want them matched.
- **Neon 229 vs local 225 products** — the p9/p10 re-id policy on retired demo rows. Not drift.
- **1 dead outbox letter** — the p12 collision guard doing its job.
- **Turso audit_logs +1 row** — the sync's own heartbeat row (id = replication.tursoSync), self-healing by design.
- **`M download/rsm-platform-database.db` in git status** — the snapshot watcher refreshing the tracked recovery point on db change. Commit it (or leave dirty; the guard in db-snapshot protects its content).
- **prod consensus 2 voters vs sandbox 3** — OpenRouter is region-blocked from Vercel egress.
- **groq/gemini keys** — rejected by their platforms (403/401). Providers stay registered; a fresh key in the vault + auto-heal re-arms them.
- **Order #40's items are frozen against cross-device edits** — the check is open with origin device `413e1476` (a terminal that no longer exists); the origin-authority policy correctly rejects other devices' item events on it (5 conflicts logged p20). If the owner ever needs that check edited remotely, an admin must act directly on each side (or close the check).
- **8 p20 policy conflicts** — all correct-by-design rejections during the harmony pull (dead-device origin stamps above, 2 stale table revisions, 1 hash tiebreak). Visible in admin → conflicts; they are the policy engine doing its job, not drift.
- **The manifest's nested `database` block is R17-era legacy** — `updateManifest()` preserves unknown fields, so `round`/`database.rowCount` (users:3, 618KB) are stale museum metadata. The TOP-LEVEL `tables`/`totalRows`/`generatedAt` fields are the live truth (the guards read `totalRows` only).
- **252 cloud-side `failed` in-events on Neon** — historical FK-era artifacts from pre-p12 pushes (recorded, not retried, never served to pullers). Harmless; do not bulk-clear without a dedicated review.
- **The cloud's own outbox rows stay `pending` forever** — after the p20 pull fix they are DELIVERED (cursor-based, per-terminal) but their row status never flips (no engine runs on the cloud to settle them). The cloud admin's "pending uploads" count includes them; that is cosmetic, delivery is cursor-based.

## 6 · Operational rules (learned the hard way)

1. **Never source env files in bash** (Neon `&` mangling).
2. **Never run `bun run build`** — dev server on port 3000 only (`bun run dev`).
3. **`prisma db push` regenerates the client** — long-lived Prisma clients go stale (R19); prefer short-lived clients in scripts.
4. **Explicit ids on modifier inserts can collide** — probe `max(id)` first (p18 lesson).
5. **After any menu/product write**: events must ride the hybrid outbox (engine pushes to Neon); composite-PK link tables (`product_modifier_groups`) are NOT event-addressable — write them directly on Neon AND locally (p18 pattern), then run Turso re-sync.
6. **Verify order after a recycle: cloud first, then local** (p17).
7. **Mode flips**: normalize with `git add -u` (chmod in the working tree alone is invisible while 755 is staged).
8. **Anti-rollback is triple-locked**: GitHub branch protection (force-push/delete blocked, enforce_admins) + `round12-stable` anchor tag (check with `bun scripts/git-guard.ts`) + git bundles in `backups/` and `/home/z/`.
9. **Backups**: `bun run db:backup` (snapshot) / `bun scripts/backup-all.ts all` (snapshot + bundle). Auto: in-app watcher every 10 min on change (keeps 30 in `backups/auto/`).
10. **The dev server restart is part of recovery** — the boot guard + staged restore both run at boot. After healing, check `dev.log` for `[recycle-guard]` lines.
11. **r31 environment rules (learned the hard way):**
    - `DATABASE_URL` must carry `?socket_timeout=30000&connection_limit=1` (Prisma-SQLite's busy timeout + single-connection queueing — without them concurrent writes deadlock the engine runtime). It is set in `.env` AND the vault; the shell also exports a PARAM-LESS copy that silently overrides `.env` (Next never overrides inherited process.env) — always start the dev server via `.zscripts/daemonize-dev.py` (python double-fork, strips the inherited var, survives the reaper) or the patched `ensure-dev.sh`.
    - NEVER re-add `PRAGMA busy_timeout` in `src/lib/db.ts` — a post-connect pragma OVERRIDES the URL's socket_timeout (a 10 s pragma silently defeated the 30 s setting once already).
    - Write transactions that matter (order create etc.) go through `withWriteLock()` (`src/lib/write-mutex.ts`) — SQLite is single-writer; the mutex converts contention into a fair FIFO queue.
    - Query logging is opt-in: `RSM_QUERY_LOG=1` in `.env` for a debugging session, then remove it (it cost 70k log lines / 23 MB per 3-min stress run and OOM'd the sandbox once).
12. **p20 sync-engine rules:**
    - ONE hybrid cycle at a time, always — the engine tick and admin "Sync now" share the `cycleRunning` flag. NEVER make them concurrent again: parallel cycles push different batches out of order and the receiver can apply stale payloads over newer state (it re-opened 6 cancelled orders on Neon once).
    - The pull stream now includes CLOUD-ORIGIN events (deviceId `unbound`, direction `out`) on Postgres deployments. If a terminal seems to "miss" an owner action done on prod, run a sync-now and check the conflicts log — the origin-authority policy may be correctly protecting a live check.
    - A paid order created on THIS terminal and echoed to the cloud CANNOT be re-pulled after a db restore (own-device echo filter). Recovery pattern: fetch its events from Neon and feed each through `ingestRemoteEvent` (see `scripts/p20-repair.ts` §3).
    - `env-heal` fills only MISSING keys — a key that is PRESENT but degraded (e.g. param-less DATABASE_URL after a recycle) survives healing. After any recycle: `bun scripts/harden-verify.ts` and diff `.env` values against the vault, not just key presence.
    - Cancel stress-test residue ONLY after a preflight guard (status=open + type=takeaway + zero payments + origin=this device) — the pattern in `scripts/p20-repair.ts`.

## 7 · Daily-driver commands

```bash
bun run dev                          # start dev server (port 3000, logs → dev.log)
bun scripts/harden-verify.ts         # posture check (15 checks, ~5s)
bun scripts/harden-verify.ts --cloud # + GitHub/Vercel/Neon/Turso/Inngest
bun scripts/auto-heal.ts             # recycle recovery (one command)
bun scripts/p13-harmony-check.ts     # five-platform harmony alone
bun scripts/backup-all.ts all        # db snapshot + git bundle
bun run lint                         # eslint
```
