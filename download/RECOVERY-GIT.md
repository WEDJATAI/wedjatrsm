# RSM Platform — Git Protection & Recovery Guide (Round 16)

This repository is protected against **rolling back to an older git state**.
Nothing can rewind the code history, and the live database can never be
overwritten by a git operation.

## What is protected (and how)

| Threat | Protection |
|---|---|
| `git reset --hard <old>` | ❌ blocked by rollback guard hook (refused before the tree is touched) |
| `git branch -f main <old>` / `git push --force` | ❌ blocked (non-fast-forward refused; `receive.denyNonFastForwards` + `receive.denyDeletes`) |
| `git update-ref <ref> <old-sha>` (with or without old value) | ❌ blocked (guard resolves the real on-disk ref value itself) |
| `git tag -d round*-stable` / `git tag -f` | ❌ blocked (checkpoint tags `*-stable`, `v*`, `rsm*` are immutable) |
| `git checkout <old-commit>` / `<old-tag>` | ❌ blocked (HEAD never moves to an ancestor of main) |
| `git checkout <old> -- db/custom.db` | ✅ impossible — the live DB and `backups/` are **untracked**; git cannot touch them |
| Branch `main` deletion | ❌ blocked |

Normal work is never affected: fast-forward commits and merges, creating
new tags/branches, and git's own housekeeping (`pack-refs`, `gc`) all work.

## If you genuinely need an old state

NEVER rewind a ref. Reference it with a NEW tag or branch instead:

```bash
git tag rescue-20260915 <old-sha>          # permanent marker
git switch -c rescue-20260915 <old-sha>    # inspect old code safely
```

## Known residuals (honest)

1. **A *blocked* `git checkout <old>` may still update the working tree
   before aborting** (git packs the tree before moving HEAD). The refs stay
   correct — repair with:
   ```bash
   git checkout main
   git checkout main -- .
   ```
   The live database is untouched either way (untracked).
2. `git checkout <old> -- <path>` (path checkout) bypasses ref hooks.
   Code is recoverable from git; the DB/backups are untracked and safe.
3. The guard hooks live in `.git/hooks/` and do not travel with clones.
   The portable protection is the tag set + the offline bundle.

## Recovery sources (multiple, independent)

| Source | Location | Contains |
|---|---|---|
| Checkpoint tag | `round16-stable` (+ round2–5) | full code history markers |
| Offline git bundle | `backups/rsm-git-round16.bundle` and `download/rsm-git-repository-backup.bundle` | ALL refs + complete history |
| DB snapshots | `backups/custom-*.db` (VACUUM INTO, 24h-auto + manual + per-round) | point-in-time database |
| In-app backups | Settings → Backup (download any snapshot) | same, from the UI |
| Windows package | Settings → Download for Windows | full app + embedded DB |

### Restoring the repository from the bundle

```bash
git clone backups/rsm-git-round16.bundle rsm-restored
cd rsm-restored && git checkout main
```

### Restoring the database from a snapshot

```bash
cp backups/custom-round16-start-*.db db/custom.db   # app stopped
# (see download/README.md for the full WAL-aware procedure)
```

## Round-16 verification evidence

- `scripts/round16-verify.ts` — 77/77 checks: nothing deleted vs the R15
  manifest (all tables ≥ manifest counts, live checks #126–#133 intact,
  shisha/kitchen/bar routing intact, safety invariants hold).
- Guard self-test: 8/8 manual transaction tests, 12/12 live tests
  (commit-allowed, rewind-blocked, tag-ops-blocked, pack-refs-works,
  packed-tag-delete-blocked, checkout-blocked).
- Incident drill (real): a test checkout of an old branch during hardening
  overwrote working files — the DB was restored byte-identical from git
  history, verified 77/77, and the recovery procedure above was proven live.
