# RSM Platform — Backup & Restore Runbook (r64)

> **Scope:** what is backed up, where every copy lives, how to restore each
> plane, and how often to run it. This file is tracked in the repo and contains
> **no secrets** — all credentials live in the gitignored `.env.deploy-local`
> on the admin machine.

## The five clouds and what each holds

| Plane | Role | Backup mechanism |
|---|---|---|
| **GitHub** `WEDJATAI/wedjatrsm` | code (single-commit history by design) + release artifacts | the repo itself + the encrypted `r64-backup` release bundle |
| **Vercel** `wedjatrsm` / `wedjatrsm-tonsy` | production deployment | auto-redeploys from GitHub `main`; the repo is the source |
| **Neon** PostgreSQL | system of record (cloud data plane) | encrypted dump in the bundle + Neon storage-level durability |
| **Turso** libsql | analytics/backup replica | encrypted dump in the bundle + `scripts/sync-turso.ts` full refresh |
| **Inngest** | scheduled jobs | functions are defined in `src/inngest/functions.ts` (in the repo) and registered through the Vercel integration |

## One-command full backup (r64 pipeline)

```bash
bun scripts/r64/cloud-backup.ts make          # build + encrypt + round-trip verify
bun scripts/r64/cloud-backup.ts upload <file.enc>   # publish to the r64-backup release
```

**What lands inside `backups/r64/r64-cloud-backup-<ts>.tar.gz.enc`:**

| Path | Contents |
|---|---|
| `local-db/custom-<ts>.db` | `VACUUM INTO` snapshot of the live SQLite plane (consistency-guaranteed) |
| `local-db/rsm-platform-database.db` | the desktop install payload snapshot (what fresh installs bootstrap from) |
| `neon/neon-data-dump.sql` | full row dump of the Neon system of record, FK-safe (`session_replication_role=replica`) |
| `turso/turso-data-dump.sql` | full row dump of the Turso replica |
| `env/` | `.env.deploy-local`, `.env`, deploy-creds copies — **secrets, encrypted-only** |
| `code/repo-head.tar.gz` | `git archive` of the pushed root commit |
| `manifest.json` | sha256 + size of every artifact + per-table row counts |
| `RESTORE.md` | the short restore instructions (duplicated below) |

**Encryption:** `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`.
**Passphrase:** `RSM_BACKUP_PASSPHRASE` in `.env.deploy-local` (generated on
first run, then reused so every bundle shares one restore key; mirrored at
`backups/r64-backup.passphrase`, mode 0600). It is never printed by the script,
never committed, and never stored in plaintext on any cloud.

Every `make` **round-trip-verifies itself**: the script decrypts its own
output and re-hashes every artifact against `manifest.json` before reporting
OK. A bundle that cannot prove itself is not a backup.

## Restore procedures

### 0. Decrypt a bundle

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in r64-cloud-backup-<ts>.tar.gz.enc -out bundle.tar.gz \
  -pass env:RSM_BACKUP_PASSPHRASE
tar -xzf bundle.tar.gz
# then verify EVERY sha256 against manifest.json before touching anything
```

### 1. Local / desktop plane (SQLite)

```bash
# stop the app first, then:
cp local-db/custom-<ts>.db db/custom.db
```

The desktop payload (`local-db/rsm-platform-database.db`) restores the same
way into a fresh install's payload slot.

### 2. Neon (system of record)

```bash
# fresh Neon database, then push the schema and import the rows:
DATABASE_URL='<new-neon-url>' bunx prisma db push --schema prisma/schema.postgres.prisma
psql '<new-neon-url>' -f neon/neon-data-dump.sql
```

The dump opens with `BEGIN; SET session_replication_role = replica;` so rows
restore in any order without FK violations, and commits at the end.

### 3. Turso replica

No dump import is needed — the replica is fully derived:

```bash
TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/sync-turso.ts
```

### 4. Code

The repository on GitHub **is** the backup (single-commit root by design —
see `download/RECOVERY-GIT.md`). `code/repo-head.tar.gz` in the bundle is the
byte-identical tree of the exact commit the bundle was taken from.

## Cadence

- **After every significant round** (menu changes, order-history repairs,
  structure work): run `make` + `upload` — it is one command and proves
  itself.
- The Vercel cron `/api/cron/turso-sync` and Inngest `rsm-turso-replica-sync`
  keep the Turso replica warm daily regardless.
- `download/rsm-platform-database.db` is refreshed automatically by the
snapshot watcher (`src/lib/db-snapshot.ts`) on live data changes — the
in-app Settings → Backup flow serves the same snapshots.

## Where the backups physically live

1. **GitHub release `r64-backup`** — the encrypted bundle (public URL, useless
   without the passphrase).
2. **Local `backups/r64/`** — the staging tree + encrypted bundle + passphrase
   mirror (gitignored, never leaves the machine in plaintext).
3. **`.env.deploy-local` / `/home/z/.deploy-creds.env` / `.git/deploy-creds.env`**
   — the credential originals (all gitignored).
