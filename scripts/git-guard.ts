/**
 * R11/R12 git hardening: repo integrity guard.
 *
 * Verifies the current HEAD is a DESCENDANT of the protected round12-stable
 * tag — i.e. nobody rolled the repository back to an older state. Run it
 * any time you suspect tampering:  `bun run git:guard`
 *
 * Exit codes: 0 = healthy · 1 = rollback detected / missing anchors.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const PROTECTED_TAG = 'round12-stable'

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

  // The protected anchor tag must exist.
  let anchor: string
  try {
    anchor = git(['rev-parse', `refs/tags/${PROTECTED_TAG}^{commit}`])
  } catch {
    console.error(`git:guard — protected tag '${PROTECTED_TAG}' is MISSING. Restore it from backups/repo-*.bundle before doing anything else.`)
    return 1
  }

  // A protected ref copy must exist too (refs/protected/* is frozen by hooks).
  let protectedRef: string | null = null
  try {
    protectedRef = git(['rev-parse', `refs/protected/${PROTECTED_TAG}`])
  } catch {
    protectedRef = null
  }

  // All stable round tags must exist (history anchors round2 → round12).
  let stableTags: string[] = []
  try {
    stableTags = git(['tag', '--list', 'round*-stable']).split('\n').filter(Boolean)
  } catch {
    stableTags = []
  }
  const expectedTags = 11 // round2…round12
  if (stableTags.length < expectedTags) {
    console.error(`git:guard — stable round tags missing (found ${stableTags.length}, expected ${expectedTags}): ${stableTags.join(', ') || 'NONE'}. Restore from backups/repo-round12-stable.bundle (git fetch <bundle> 'refs/tags/*:refs/tags/*').`)
  }

  // HEAD must contain the anchor (HEAD is at or after round11).
  let isDescendant = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', anchor, head], { stdio: 'ignore' })
    isDescendant = true
  } catch {
    isDescendant = false
  }

  const ok = isDescendant && protectedRef === anchor && stableTags.length >= expectedTags
  if (ok) {
    console.log(`git:guard OK — HEAD ${head.slice(0, 10)} is at/after ${PROTECTED_TAG} (${anchor.slice(0, 10)}); protected ref intact; ${stableTags.length} stable round tags present.`)
    return 0
  }

  console.error(`git:guard FAILED — repository appears ROLLED BACK.`)
  console.error(`  HEAD:            ${head.slice(0, 10)}`)
  console.error(`  ${PROTECTED_TAG}: ${anchor.slice(0, 10)}`)
  console.error(`  protected ref:   ${protectedRef ?? '(missing)'}`)
  if (!isDescendant) console.error('  HEAD is BEFORE the protected anchor — restore with: git reset --hard round12-stable')
  if (protectedRef !== anchor) console.error('  Protected ref drifted — restore with: git update-ref refs/protected/round12-stable ' + anchor)
  return 1
}

process.exit(main())
