/**
 * p19 rehearsal — hermetic end-to-end test of the recycle self-heal.
 *
 * Simulates recycle #9 in /tmp/p19-rehearsal (the REAL live db is NEVER
 * touched): a bare live db + a populated recovery point + no .git. Then runs
 * the exact boot sequence (recycle-guard → staged restore → verify) and the
 * db-snapshot guards, and asserts every outcome.
 *
 *   bun scripts/p19-rehearse.ts
 */
import { copyFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const PROJECT = '/home/z/my-project'
const SANDBOX = '/tmp/p19-rehearsal'

// fixture: the REAL bare db captured from recycle #8 + the real recovery point
const BARE_FIXTURE = join(PROJECT, 'db/pre-restore-20261002-064706.db')
const RECOVERY = join(PROJECT, 'download/rsm-platform-database.db')

let pass = 0
let failCount = 0
function check(label: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? '  [ ✓ ]' : '  [ ✗ ]'} ${label}${extra ? ` (${extra})` : ''}`)
  if (cond) pass++
  else failCount++
}

async function countUsers(url: string): Promise<number> {
  const p = new PrismaClient({ adapter: new PrismaLibSql({ url: url.split('?')[0] }), log: ['error'] }) // r49: Prisma 7 adapter
  try {
    const r = (await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM users`)) as Array<{ c: number | bigint }>
    return Number(r[0]?.c ?? -1)
  } finally {
    await p.$disconnect()
  }
}

async function main(): Promise<void> {
  console.log('══ P19 REHEARSAL — simulated recycle #9 (hermetic, /tmp) ══\n')

  if (!existsSync(BARE_FIXTURE)) { console.error('bare fixture missing:', BARE_FIXTURE); process.exit(1) }

  // ── set up the sandbox: bare live db + good recovery point, no .git ──
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(join(SANDBOX, 'db'), { recursive: true })
  mkdirSync(join(SANDBOX, 'download'), { recursive: true })
  copyFileSync(BARE_FIXTURE, join(SANDBOX, 'db/live.db'))
  copyFileSync(RECOVERY, join(SANDBOX, 'download/rsm-platform-database.db'))
  // clear any STALE restore marker carried by the fixture (recycle #8's db
  // still has one) — the rehearsal must prove OUR marker-setting path works
  {
    const p = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${SANDBOX}/db/live.db` }), log: ['error'] }) // r49: Prisma 7 adapter
    await p.$executeRawUnsafe(`DELETE FROM hybrid_sync_state WHERE key = 'restore.pending'`)
    await p.$disconnect()
  }
  process.env.DATABASE_URL = `file:${SANDBOX}/db/live.db`
  process.chdir(SANDBOX) // recycle-guard + hybrid-engine resolve paths from cwd

  const usersBefore = await countUsers(`file:${SANDBOX}/db/live.db`)
  check('fixture: sandbox live db is BARE (0 users) — recycle signature', usersBefore === 0, `users=${usersBefore}`)

  // ── TEST 1: db-snapshot guard 1 refuses to snapshot the bare db ─────
  console.log('\n── test 1: snapshot guard refuses bare db ──')
  const snap = await import(join(PROJECT, 'src/lib/db-snapshot'))
  let refused = false
  try {
    await snap.takeSnapshot('rehearsal')
  } catch (e) {
    // r49: unknown-safe narrowing (catch vars are unknown under strict TS)
    const msg = e instanceof Error ? e.message : String(e)
    refused = msg.includes('recycle-guard')
    if (refused) console.log(`        → refused with: ${msg.split('—')[0].trim()}`)
  }
  check('guard 1: takeSnapshot THREW on bare db (recovery point protected)', refused)
  check('guard 1: recovery point NOT overwritten (still has users)', (await countUsers(`file:${SANDBOX}/download/rsm-platform-database.db`)) > 0)

  // ── TEST 2: boot sequence — guard detects + stages + proven swap ────
  console.log('\n── test 2: boot self-heal (recycle-guard → staged restore → verify) ──')
  const guard = await import(join(PROJECT, 'src/lib/recycle-guard'))
  const report = await guard.runRecycleGuardAtBoot()
  check('guard: RECYCLE SIGNATURE DETECTED', report.dbHealed, `source=${report.restoreSource}`)
  check('guard: staged restore file created', existsSync(join(SANDBOX, 'db/restore-pending.db')))

  const hybrid = await import(join(PROJECT, 'src/lib/hybrid-sync/hybrid-engine'))
  await hybrid.applyStagedRestoreAtBoot()
  const verified = await guard.verifyRecycleRestore(report)
  check('restore: applied through the PROVEN staged path', verified)
  const usersAfter = await countUsers(`file:${SANDBOX}/db/live.db`)
  check('restore: live db now has the full team back', usersAfter === 9, `users=${usersAfter}`)
  const preserved = readdirSync(join(SANDBOX, 'db')).filter((f) => /^pre-restore-\d{8}-\d{6}\.db$/.test(f))
  check('restore: bare original preserved (db/pre-restore-*.db)', preserved.length > 0, preserved.join(', '))
  check('restore: marker + staged file cleaned up', !existsSync(join(SANDBOX, 'db/restore-pending.db')))

  // ── TEST 3: snapshot now allowed again (restored db is healthy) ─────
  console.log('\n── test 3: snapshot guard passes on the healed db ──')
  let snapshotOk = false
  try {
    const r = await snap.takeSnapshot('rehearsal-after-heal')
    snapshotOk = r.ok && r.users !== undefined ? true : r.ok
  } catch (e) {
    console.log('        → unexpected:', e instanceof Error ? e.message : e)
  }
  check('guard 1: takeSnapshot SUCCEEDS on healed db', snapshotOk)
  check('guard 1: recovery point refreshed from healed db', (await countUsers(`file:${SANDBOX}/download/rsm-platform-database.db`)) === 9)

  // ── TEST 4: guard 2 (shrink ratchet) ─────────────────────────────────
  console.log('\n── test 4: shrink ratchet ──')
  let ratchetRefused = false
  try {
    snap.assertNoShrink(100) // manifest now says ~6273 rows; 100 is a 98% collapse
  } catch (e) {
    ratchetRefused = e instanceof Error && e.message.includes('recycle-guard')
  }
  check('guard 2: >60% row collapse refused (escape hatch: RSM_SNAPSHOT_ALLOW_SHRINK=1)', ratchetRefused)
  process.env.RSM_SNAPSHOT_ALLOW_SHRINK = '1'
  let ratchetOverride = true
  try {
    snap.assertNoShrink(100)
  } catch {
    ratchetOverride = false
  }
  check('guard 2: escape hatch honored', ratchetOverride)
  delete process.env.RSM_SNAPSHOT_ALLOW_SHRINK

  // ── TEST 5: healthy-db no-op (idempotence) ───────────────────────────
  console.log('\n── test 5: idempotence on a healthy system ──')
  const report2 = await guard.runRecycleGuardAtBoot()
  check('guard: healthy db → no staging, no false positive', !report2.dbHealed && report2.healthy, `users=${report2.users}`)

  console.log(`\n══ REHEARSAL RESULT: ${pass} passed · ${failCount} failed ══`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((e) => { console.error('rehearsal crashed:', e); process.exit(1) })
