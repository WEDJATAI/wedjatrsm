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
