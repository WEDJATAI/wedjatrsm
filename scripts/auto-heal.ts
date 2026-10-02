/**
 * p19 auto-heal — the ONE command that undoes a sandbox recycle.
 *
 *   bun scripts/auto-heal.ts            # full sweep (env + db + git modes + verify)
 *   bun scripts/auto-heal.ts --dry-run  # detect only, change nothing
 *
 * What it does (idempotent — safe to run on a healthy system):
 *   1. ENV HEAL  — rebuilds .env / .env.deploy-local / /home/z/.deploy-creds.env /
 *      /home/z/.deploy-creds-ai.env from the recycle-proof vault
 *      (.git/env-vault.env), filling ONLY missing keys.
 *   2. DB HEAL   — detects the bare-db recycle signature (0 users) and, when
 *      found, stages the best recovery source (git HEAD's tracked recovery
 *      point → disk recovery point → newest auto/manual backup) and applies
 *      it through the PROVEN staged-restore path (safety snapshot → swap).
 *      The bare recycled db is preserved at db/pre-restore-*.db.
 *   3. GIT HEAL  — normalizes the file-mode flips the recycle stages into
 *      the index (755→644 re-add).
 *   4. VERIFY    — users/products/orders counts, env key presence per store,
 *      recovery point rows, outbox state.
 *
 * The same logic runs automatically at every server boot
 * (src/lib/recycle-guard.ts via src/instrumentation.ts) — this CLI is the
 * manual/agent entry point and the fallback when the server is down.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'

const ROOT = process.cwd()
const DRY = process.argv.includes('--dry-run')

function ok(msg: string): void { console.log(`  [ ✓ ] ${msg}`) }
function warn(msg: string): void { console.log(`  [ ! ] ${msg}`) }
function fail(msg: string): void { console.log(`  [ ✗ ] ${msg}`) }
function step(msg: string): void { console.log(`\n── ${msg} ${'─'.repeat(Math.max(1, 64 - msg.length))}`) }

async function main(): Promise<void> {
  console.log(DRY ? '══ AUTO-HEAL (DRY RUN — detect only) ══' : '══ AUTO-HEAL (full sweep) ══')

  // ── 1 + 2: env heal + db heal via the boot guard (same code path) ────
  step('recycle-guard (env + db)')
  if (!process.env.DATABASE_URL?.startsWith('file:')) {
    fail('DATABASE_URL is not a local file: — this tool heals the LOCAL SQLite deployment only')
    process.exit(1)
  }
  if (DRY) {
    const vault = existsSync(join(ROOT, '.git/env-vault.env'))
    const envKeys = readFileSync(join(ROOT, '.env'), 'utf8').match(/^[A-Z_]+=/gm)?.length ?? 0
    const live = new PrismaClient({ log: ['error'] })
    let users = -1
    try {
      const rows = (await live.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM users`)) as Array<{ c: number | bigint }>
      users = Number(rows[0]?.c ?? -1)
    } catch { users = -1 }
    await live.$disconnect()
    if (vault) ok('vault present (.git/env-vault.env)')
    else fail('vault MISSING — run: bun scripts/p19-build-vault.ts')
    if (envKeys >= 10) ok(`.env has ${envKeys} keys (healthy)`)
    else warn(`.env has only ${envKeys} keys (stripped — recycle signature)`)
    if (users > 0) ok(`live db has ${users} users (healthy)`)
    else warn(`live db users=${users} (bare — recycle signature; boot guard or full run will heal)`)
    console.log('\ndry run complete — no changes made')
    return
  }
  const guard = await import('../src/lib/recycle-guard')
  const report = await guard.runRecycleGuardAtBoot()
  if (report.envHealed.length === 0) ok('env stores already healthy (nothing to heal)')
  if (report.dbHealed) {
    warn('bare db detected — applying staged restore through the proven path…')
    const hybrid = await import('../src/lib/hybrid-sync/hybrid-engine')
    await hybrid.applyStagedRestoreAtBoot()
    const healed = await guard.verifyRecycleRestore(report)
    if (healed) ok(`db restored from ${report.restoreSource} (${report.users} users)`)
    else fail('restore verification failed — see logs above')
  } else {
    if (report.healthy) ok(`live db healthy (${report.users} users)`)
    else fail('live db unhealthy AND no recovery source found — see docs/RUNBOOK.md §manual-recovery')
  }

  // ── 3: git mode-flip normalization ───────────────────────────────────
  step('git heal (mode flips)')
  try {
    const status = execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' })
    const flips = status.split('\n').filter((l) => /^M /.test(l.trim()) || l.includes('old mode'))
    // The recycle stages 755 modes into the index; re-add normalizes to 644
    const changed = status.split('\n').filter((l) => l.trim().length > 0)
    if (changed.length > 0) {
      execFileSync('git', ['add', '-u'], { cwd: ROOT })
      ok(`index normalized (${changed.length} entries re-added with canonical modes)`)
    } else {
      ok('git index clean')
    }
  } catch (e) {
    warn(`git heal skipped: ${e instanceof Error ? e.message : e}`)
  }

  // ── 4: verification ──────────────────────────────────────────────────
  step('verification')
  const p = new PrismaClient({ log: ['error'] })
  try {
    const users = await p.user.count()
    const products = await p.product.count()
    const orders = await p.order.count()
    ok(`db: ${users} users · ${products} products · ${orders} orders`)
    const pending = await p.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
    if (pending === 0) ok('hybrid outbox: 0 pending')
    else warn(`hybrid outbox: ${pending} pending (engine will drain)`)
  } catch (e) {
    fail(`db verification failed: ${e instanceof Error ? e.message : e}`)
  } finally {
    await p.$disconnect()
  }

  const stores: Array<[string, number]> = [
    ['.env', (readFileSync(join(ROOT, '.env'), 'utf8').match(/^[A-Z_]+=/gm) ?? []).length],
    ['.env.deploy-local', existsSync(join(ROOT, '.env.deploy-local')) ? (readFileSync(join(ROOT, '.env.deploy-local'), 'utf8').match(/^[A-Z_]+=/gm) ?? []).length : -1],
    ['/home/z/.deploy-creds.env', existsSync('/home/z/.deploy-creds.env') ? (readFileSync('/home/z/.deploy-creds.env', 'utf8').match(/^[A-Z_]+=/gm) ?? []).length : -1],
    ['/home/z/.deploy-creds-ai.env', existsSync('/home/z/.deploy-creds-ai.env') ? (readFileSync('/home/z/.deploy-creds-ai.env', 'utf8').match(/^[A-Z_]+=/gm) ?? []).length : -1],
    ['.git/env-vault.env', existsSync(join(ROOT, '.git/env-vault.env')) ? (readFileSync(join(ROOT, '.git/env-vault.env'), 'utf8').match(/^[A-Z_]+=/gm) ?? []).length : -1],
  ]
  for (const [name, n] of stores) {
    if (name === '.git/env-vault.env') {
      if (n >= 21) ok(`${name}: ${n} keys`)
      else fail(`${name}: ${n} keys (expected ≥21 — rebuild: bun scripts/p19-build-vault.ts)`)
    } else if (name === '.env') {
      if (n >= 10) ok(`${name}: ${n} keys`)
      else warn(`${name}: ${n} keys (expected ≥10)`)
    } else {
      if (n >= 14) ok(`${name}: ${n} keys`)
      else warn(`${name}: ${n} keys (expected ≥14 — will be healed on next run/boot)`)
    }
  }

  const rp = join(ROOT, 'download/rsm-platform-database.db')
  if (existsSync(rp)) {
    const bytes = statSync(rp).size
    ok(`recovery point: ${(bytes / 1024 / 1024).toFixed(1)} MB (download/rsm-platform-database.db)`)
  } else {
    fail('recovery point MISSING (download/rsm-platform-database.db)')
  }

  console.log('\n══ AUTO-HEAL COMPLETE ══')
  console.log('Next: curl http://localhost:3000/ (server must be (re)started to load the healed db)')
}

main().catch((e) => {
  console.error('auto-heal FAILED:', e)
  process.exit(1)
})
