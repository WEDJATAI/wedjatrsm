# RSM Platform — Database Package

Complete, verified database deliverable for **Lilo Cafe and Restaurant** (RSM —
Restaurant System Management, Next.js 16 + Prisma + SQLite). Refreshed through
Round 17 (Foodics/Odoo-level upgrade: purchasing, stock counts, waste
management, promotions engine with live POS auto-apply, payroll + forecast,
refunds restored, R9 AI copilot/briefing re-wired).

## Files

| File | Description |
| --- | --- |
| `rsm-platform-database.db` | The complete platform database (single embedded SQLite file — this is the ONLY database the platform needs; no external DB server is required). All schema modifications from every build round (R3 → R17) are applied. Snapshot taken with SQLite `VACUUM INTO` — consistent even while the live server serves traffic. |
| `rsm-windows-x64.zip` | Ready-to-run Windows package reference copy: the full platform + `windows\install.bat` + `start.bat` + bilingual README + portable `.env` (R16: with its own crypto-random `JWT_SECRET`) + a live-data `db\custom.db`. Generated fresh from Settings → *Download for Windows* (live or demo data). |
| `rsm-database-manifest.json` | Machine-readable audit manifest: SHA-256 checksum, integrity/foreign-key checks, row counts for all 34 tables, safety-invariant checks. |
| `rsm-git-repository-backup.bundle` | Offline git bundle: ALL branches, tags (incl. `round17-stable`) and complete history. Clone from it with `git clone rsm-git-repository-backup.bundle rsm-restored`. |
| `RECOVERY-GIT.md` | **NEW (R16)** — git protection map + recovery procedures (what is blocked, what is allowed, how to restore). |
| `r12-ux-audit-report.md` | Full UX audit scorecard (R11-R12), Foodics comparison, recommendations implementation record (R13), load-test & data-safety record (R14), Windows + mobile portals record (§8, R15). |

## Verification (all PASS — Round 17 refresh)

- `PRAGMA integrity_check` → **ok**
- `PRAGMA foreign_key_check` → **0 violations**
- Table inventory → **34/34** tables present (27 original + 7 new R17 tables) (matches `prisma/schema.prisma`)
- **Nothing-deleted audit (R17)**: `scripts/round17-verify.ts` — every
  pre-existing table at or above its pre-migration baseline (zero deletions;
  all growth accounted: +16 test orders cancelled, +1 test refund, +123 audit
  rows, +17 inventory transactions, +3 attendance sessions); live checks
  #126–#133 intact through the R17 work
- Safety invariants: AI never writes table state (0 auto-applied movements) ·
  bcrypt-only password hashes · no credentials embedded in camera URLs ·
  per-installation JWT secret (R16)
- Concurrency: 0 errors under load (see §7 of the audit report)

## Git rollback protection (R16)

The repository can no longer be rolled back to an older state — see
`RECOVERY-GIT.md` for the full map. In short: a `reference-transaction` guard
blocks `git reset --hard`, branch/tag rewrites, checkpoint-tag deletion and
checkouts of old commits (12/12 live tests + 8/8 manual transaction tests);
the live database and `backups/` are untracked so no git operation can ever
overwrite them; an offline bundle + the `round16-stable` tag provide recovery
even if the hooks are lost.

## What's inside

- **Operations**: 3 users (admin / waiter / kitchen), 2 active floor plans
  (Main Hall + Terrace), 16 tables, 49 products (6 categories incl. Shisha with
  10 flavors + station routing), 7 modifier groups, 129 orders, payments,
  inventory ledger, reservations, customers & loyalty, delivery webhook orders.
- **AI Vision / CCTV (R9)**: 2 online cameras (CAM-001 Main Hall, CAM-002
  Terrace), 6 polygon zones mapped to dining tables, processed edge events
  with filtering, movement candidates (all human-decided — **0 pending**),
  ingest key + tunable detection config.
- **R13-R14 additions**: customer profiles + loyalty settings, delivery
  webhook key, `lastAutoBackupAt` marker, `journal_mode=WAL` recommended on
  restore (see below).

## Restoring

```bash
cp rsm-platform-database.db /path/to/project/db/custom.db
# recommended after restore (persistent, one command):
sqlite3 /path/to/project/db/custom.db "PRAGMA journal_mode=WAL;"
```

The app reads the DB location from `DATABASE_URL` (`file:…/db/custom.db`).

**Fresh-install alternative:** `bun prisma/seed.ts` — seeds
users/menu/floors/orders + vision demo (cameras, zones, table states, ingest
key) + loyalty settings & demo customers, and enables WAL automatically.

## Backups (R14)

The platform now protects its own data — no cron or external tooling needed:

- **Automatic**: after the first successful login each day the server creates
  a consistent `VACUUM INTO` snapshot in `backups/` (keeps the 14 most recent
  automatic snapshots). Every action is audit-logged.
- **Manual**: Admin → Settings → *Data & backups* → **Backup now**.
- **Download**: every snapshot listed in Settings has a Download button
  (strict filename validation, admin-only, audit-logged).
- **Restore**: copy the downloaded file over `db/custom.db` (stop the server
  first), then re-enable WAL as shown above.

## Run on a Windows PC (R15 — offline-first)

1. Unzip `rsm-windows-x64.zip` (or generate a fresh one from the app:
   Settings → *Download for Windows*, with current data or demo data).
2. Double-click `windows\install.bat` (once — installs dependencies;
   needs [Bun](https://bun.com) or Node.js 20+).
3. Double-click `windows\start.bat` → open `http://localhost:3000`.
4. Everything now runs from the PC — data lives in `db\custom.db`, no
   internet required to operate.
5. **Sync when online**: on the PC instance open Settings → *Sync Center*,
   set the cloud target URL to your hosted RMS and enable *Push updates
   automatically* — pending updates (orders, payments, customers,
   attendance, cash, reservations) export whenever the PC is online.

## Demo logins

- `admin@rms.com` / `admin123` (PIN 1234) — full access incl. AI Vision
- `waiter@rms.com` / `waiter123` (PIN 1111)
- `kitchen@rms.com` / `kitchen123` (PIN 2222)

## Notes

- Open checks at packaging time are real session data and were intentionally
  preserved.
- Safety-critical rule enforced by the application: AI never writes POS table
  status directly — every table reassignment goes through human confirmation.
- Load-test evidence (2-core sandbox, dev mode): ~330-500 DB ops/s with 0
  errors at 4-16 concurrent workers; 62 HTTP req/s sustained with 0 errors at
  6 terminals. Production hardware + build will perform better.
