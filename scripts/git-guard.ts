/**
 * R42 git hardening — single-commit anti-rollback guard.
 *
 * The old strategy (R11/R12) protected history with ancestor checks against
 * round*-stable tags: "HEAD must be a descendant of round12-stable". The r42
 * strategy is stronger and simpler: THE OLD HISTORY NO LONGER EXISTS. The
 * repository contains exactly ONE commit — the latest verified state. There
 * is nothing older to roll back to, by construction.
 *
 * This guard verifies that invariant end-to-end:
 *
 *   1. main's history contains exactly ONE commit (the root == HEAD)
 *   2. HEAD is on branch main (not detached, not a rescue branch)
 *   3. origin/main == local HEAD (the deployed history is the same single
 *      commit — no stale remote copy to pull an older state from)
 *   4. no other local branches (backup branches are deleted by design)
 *   5. no tags (old round*-stable anchors are deleted by design)
 *
 * Run any time you suspect tampering:  `bun run git:guard`
 * Exit codes: 0 = invariant holds · 1 = violation found.
 *
 * If a violation is ever found, the response is FORWARD-ONLY: re-push the
 * latest verified single commit (backups/r42/repo-full-history-pre-collapse.bundle
 * holds the full pre-collapse history offline for forensic use — it is not
 * a rollback source for the system).
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).trim()
}

function main(): number {
  if (!existsSync('.git')) {
    console.error('git:guard — not a git repository (run from the project root).')
    return 1
  }

  let head: string
  try {
    head = git(['rev-parse', 'HEAD'])
  } catch {
    console.error('git:guard — HEAD is unborn (empty repository?).')
    return 1
  }

  let failures = 0
  const fail = (msg: string) => {
    console.error(`git:guard ✗ ${msg}`)
    failures++
  }

  // 1) exactly ONE commit in main's history (root == HEAD).
  const root = git(['rev-list', '--max-parents=0', 'main'])
  const count = git(['rev-list', '--count', 'main'])
  if (count !== '1' || root !== head) {
    fail(`main must contain exactly ONE commit (found ${count}, root ${root.slice(0, 10)} vs HEAD ${head.slice(0, 10)}). Old history present — collapse it (worklog r42) before any deploy.`)
  }

  // 2) HEAD is on main (not detached / not an old rescue branch).
  const symbolic = git(['symbolic-ref', '--quiet', 'HEAD'])
  if (symbolic !== 'refs/heads/main') {
    fail(`HEAD is not on main (currently ${symbolic || 'detached'}). Run: git checkout main`)
  }

  // 3) origin/main == local HEAD (no stale remote history to pull from).
  let remoteSha: string | null = null
  try {
    remoteSha = git(['rev-parse', 'origin/main'])
  } catch {
    remoteSha = null
  }
  if (remoteSha !== head) {
    fail(`origin/main (${remoteSha?.slice(0, 10) ?? 'missing'}) != local HEAD (${head.slice(0, 10)}). Push the latest state: git push origin main`)
  }

  // 4) no other local branches.
  const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(Boolean)
  const extra = branches.filter((b) => b !== 'main')
  if (extra.length > 0) {
    fail(`extra local branches present: ${extra.join(', ')} (old-state branches are deleted by design — collapse them).`)
  }

  // 5) tags — r43 refinement: a tag that points AT the single commit (HEAD)
  //    is a harmless label (it anchors the GitHub Release that carries the
  //    desktop installer); a tag pointing at ANY other commit is an anchor
  //    into a state that should no longer exist.
  const tags = git(['tag', '--list']).split('\n').filter(Boolean)
  const staleTags = tags.filter((tag) => {
    const target = git(['rev-parse', `${tag}^{commit}`]).trim()
    return target !== head.trim()
  })
  if (staleTags.length > 0) {
    fail(`tags anchored OUTSIDE the single commit: ${staleTags.join(', ')} (old history anchors are deleted by design — remove or re-point them).`)
  }

  if (failures === 0) {
    console.log(
      `git:guard OK — single-commit invariant holds. HEAD ${head.slice(0, 10)} == root == origin/main; ` +
        `no other branches; every tag anchored at HEAD (${tags.length} tag${tags.length === 1 ? '' : 's'}). ` +
        `There is no older git state to roll back to.`,
    )
    return 0
  }

  console.error('git:guard FAILED — the single-commit anti-rollback invariant is violated.')
  console.error('  Response is FORWARD-ONLY: restore the latest verified state, never an older one.')
  return 1
}

process.exit(main())
