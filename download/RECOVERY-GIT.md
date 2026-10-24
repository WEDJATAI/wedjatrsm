# RSM Platform — Git Protection & Recovery Guide (r64)

This repository is protected against **rolling back to an older git state**:
there **is no older git state**. The history is a single commit by design
(the r42/r55/r64 collapse protocol), so nothing can rewind, and the live
database can never be overwritten by a git operation.

## The r64 strategy (three layers)

| Layer | Mechanism |
|---|---|
| **1. Nothing to roll back to** | `main` = exactly ONE commit (the latest verified state). Enforced by `bun run git:guard` (single-commit invariant, `origin/main == HEAD`, no extra branches, every tag anchored at HEAD). |
| **2. Rewind-blocking hooks** | `.git/hooks/reference-transaction` + `post-checkout` refuse non-fast-forward updates, `main` deletion, checkpoint-tag rewrites, and checkouts of ancestors of `main`. `.git/hooks/pre-commit` is the r44 commit firewall (`RSM_ALLOW_COMMIT=1` for deliberate commits). |
| **3. Untouchable live data** | `db/*.db*` and `backups/` are gitignored — no git operation can ever clobber the live database. |

## Authorized history collapse (the periodic protocol)

Rounds accumulate work commits on top of the root; periodically the history is
collapsed back to a single commit so the "nothing to roll back to" invariant
holds again. This is the **only** operation allowed to touch the guard hooks,
and it is deliberately documented:

```bash
# 1. move the two rewind guards aside (pre-commit firewall stays)
mv .git/hooks/reference-transaction .git/hooks/reference-transaction.r64
mv .git/hooks/post-checkout .git/hooks/post-checkout.r64
# 2. safety bundle (offline, temporary — deleted after verification)
git bundle create backups/pre-collapse.bundle --all
# 3. stage everything and re-root
git add -A && git checkout --orphan r64-fresh
RSM_ALLOW_COMMIT=1 git commit -m "RSM Platform — <round>: …"
git branch -D main && git branch -m main
git tag -d <old-tags>                       # any tag not anchored at the new root
git reflog expire --expire=now --all && git gc --prune=now
# 4. re-anchor the live release tag at the new root, push, delete old releases
git push --force origin main
git push origin --delete refs/tags/platform-setup-v2   # then re-create at HEAD
# 5. REINSTALL the guards, then prove the invariant
mv .git/hooks/reference-transaction.r64 .git/hooks/reference-transaction
mv .git/hooks/post-checkout.r64 .git/hooks/post-checkout
bun run git:guard    # → OK
```

Old releases that carry source archives of pre-collapse commits are deleted in
the same operation (the live `platform-setup-v2` release is kept — its tag is
re-anchored at the new root, its installer assets stay byte-identical).

## If you genuinely need an old state

The honest answer after r64: **you cannot, from git** — that is the design.
Recovery is forward-only:

- **Data**: the encrypted `r64-backup` release bundle + `backups/` snapshots
  (see `docs/BACKUP-RESTORE.md`).
- **Code**: the single commit on GitHub is always the latest verified state.
- GitHub may serve unreachable pre-collapse objects by raw SHA for a GC
  window; no ref points at them, no release carries them, and they are not
  rollback paths for the system.

## Known residuals (honest)

1. The guard hooks live in `.git/hooks/` and do not travel with clones. The
   portable protections are the single-commit invariant (clone-visible),
   `bun run git:guard`, and the release/tag anchoring.
2. `git checkout <old> -- <path>` bypasses ref hooks — irrelevant while no
   old commits exist, and the DB is untracked either way.
3. The R16-era checkpoint tags (`round*-stable`) no longer exist; this guide
   supersedes the R16 procedure.

## Verification evidence

- `scripts/git-guard.ts` — single-commit anti-rollback invariant (run any
  time: `bun run git:guard`).
- `scripts/p13-harmony-check.ts` — GitHub/Vercel/Neon/Turso/Inngest harmony.
- `scripts/r64/cloud-backup.ts` — encrypted, round-trip-verified backups.
- `docs/BACKUP-RESTORE.md` — full backup/restore runbook.
