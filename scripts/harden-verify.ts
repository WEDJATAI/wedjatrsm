/**
 * p19 harden-verify — ONE command that proves the whole hardening posture.
 *
 *   bun scripts/harden-verify.ts            # local integrity (fast, ~5s)
 *   bun scripts/harden-verify.ts --cloud    # + five-platform harmony (network)
 *
 * Checks (exit 0 = all green, 1 = something needs attention):
 *   1. recycle signature  — live db users, .env key count
 *   2. credential stores  — every vault key present AND value-identical in
 *                           .env / .env.deploy-local / /home/z copies
 *                           (values never printed, only match/no-match)
 *   3. git anti-rollback  — scripts/git-guard.ts (HEAD ≥ round12-stable)
 *   4. db vs manifest     — users/products/orders vs download manifest
 *   5. hybrid outbox      — pending/dead event counts
 *   6. backups            — recovery point rows, newest auto snapshot,
 *                           newest git bundle
 *   7. --cloud            — scripts/p13-harmony-check.ts (GitHub/Vercel/
 *                           Neon/Turso/Inngest)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const ROOT = process.cwd()
const CLOUD = process.argv.includes('--cloud')

let pass = 0
let failCount = 0
function check(label: string, cond: boolean, extra = ''): void {
  console.log(`  [ ${cond ? '✓' : '✗'} ] ${label}${extra ? ` — ${extra}` : ''}`)
  if (cond) pass++
  else failCount++
}
function section(msg: string): void { console.log(`\n── ${msg} ${'─'.repeat(Math.max(1, 66 - msg.length))}`) }

function parseEnv(file: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim())
  }
  return out
}

async function main(): Promise<void> {
  console.log('══ HARDEN-VERIFY ══')

  // ── 1. recycle signature ─────────────────────────────────────────────
  section('1 · recycle signature')
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }), log: ['error'] }) // r49: Prisma 7 adapter
  let users = -1
  let products = -1
  let orders = -1
  try {
    users = await db.user.count()
    products = await db.product.count()
    orders = await db.order.count()
  } catch { /* counted below as failure */ }
  check('live db populated (no bare-db recycle signature)', users > 0, `users=${users}`)

  const envKeys = parseEnv(join(ROOT, '.env'))
  check('.env healthy (≥10 keys — not stripped)', envKeys.size >= 10, `${envKeys.size} keys`)

  // ── 2. credential stores vs vault ────────────────────────────────────
  section('2 · credential stores vs vault (.git/env-vault.env)')
  const vault = parseEnv(join(ROOT, '.git/env-vault.env'))
  check('vault present', vault.size >= 21, `${vault.size} keys`)
  const { APP_KEYS, DEPLOY_KEYS, HOME_KEYS, HOME_AI_KEYS } = await import('../src/lib/recycle-guard')
  const stores: Array<[string, readonly string[]]> = [
    ['.env', APP_KEYS],
    ['.env.deploy-local', DEPLOY_KEYS],
    ['/home/z/.deploy-creds.env', HOME_KEYS],
    ['/home/z/.deploy-creds-ai.env', HOME_AI_KEYS],
  ]
  for (const [name, keys] of stores) {
    const store = parseEnv(name.startsWith('/') ? name : join(ROOT, name))
    const missing: string[] = []
    const mismatched: string[] = []
    for (const k of keys) {
      if (!store.has(k)) missing.push(k)
      else if (vault.has(k) && store.get(k) !== vault.get(k)) mismatched.push(k)
    }
    check(
      `${name} complete & identical to vault`,
      missing.length === 0 && mismatched.length === 0,
      missing.length ? `MISSING: ${missing.join(',')}` : mismatched.length ? `DIFFERS: ${mismatched.join(',')}` : `${store.size} keys`,
    )
  }

  // ── 3. git anti-rollback ─────────────────────────────────────────────
  section('3 · git anti-rollback guard')
  try {
    const out = execFileSync('bun', ['scripts/git-guard.ts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    check('git-guard: HEAD ≥ round12-stable anchor', /OK|healthy|descendant/i.test(out), out.trim().split('\n').pop() ?? '')
  } catch (e) {
    const err = e instanceof Error ? (e as { stdout?: string; message: string }) : { message: String(e) }
    check('git-guard: HEAD ≥ round12-stable anchor', false, err.stdout?.trim().split('\n').pop() ?? err.message)
  }

  // ── 4. db vs manifest ────────────────────────────────────────────────
  section('4 · live db vs recovery manifest')
  const manifestPath = join(ROOT, 'download/rsm-database-manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as { totalRows?: number; tables?: Record<string, number>; generatedAt?: string }
      const mUsers = m.tables?.users ?? -1
      const mOrders = m.tables?.orders ?? -1
      check('users consistent with manifest', mUsers === users, `db=${users} manifest=${mUsers}`)
      check('orders consistent with manifest', mOrders === orders, `db=${orders} manifest=${mOrders}`)
      check('manifest fresh (<24h)', m.generatedAt ? Date.now() - Date.parse(m.generatedAt) < 24 * 3600 * 1000 : false, m.generatedAt ?? 'n/a')
    } catch (e) {
      check('manifest readable', false, e instanceof Error ? e.message : 'parse error')
    }
  } else {
    check('manifest present', false, 'download/rsm-database-manifest.json missing')
  }

  // ── 5. hybrid outbox ─────────────────────────────────────────────────
  section('5 · hybrid sync outbox')
  try {
    const pending = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
    const dead = await db.hybridEvent.count({ where: { direction: 'out', status: 'dead' } })
    check('outbox drained (0 pending)', pending === 0, `pending=${pending} dead=${dead} (1 dead = documented p12 collision guard)`)
  } catch (e) {
    check('outbox readable', false, e instanceof Error ? e.message : 'error')
  }
  await db.$disconnect()

  // ── 6. backups ───────────────────────────────────────────────────────
  section('6 · backup freshness')
  const rp = join(ROOT, 'download/rsm-platform-database.db')
  check('recovery point present', existsSync(rp), existsSync(rp) ? `${(statSync(rp).size / 1024 / 1024).toFixed(1)} MB` : 'missing')
  const autoDir = join(ROOT, 'backups/auto')
  const autos = existsSync(autoDir) ? readdirSync(autoDir).filter((f) => /^custom-\d{8}-\d{6}\.db$/.test(f)).sort().reverse() : []
  check('auto snapshots exist', autos.length > 0, autos[0] ? `newest: ${autos[0]} (${autos.length} kept)` : 'none')
  const bundles = existsSync(join(ROOT, 'backups')) ? readdirSync(join(ROOT, 'backups')).filter((f) => f.endsWith('.bundle')).sort().reverse() : []
  check('git bundles exist', bundles.length > 0, bundles[0] ?? 'none')

  // ── 7. cloud harmony (optional) ──────────────────────────────────────
  if (CLOUD) {
    section('7 · five-platform harmony (network)')
    try {
      const out = execFileSync('bun', ['scripts/p13-harmony-check.ts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 })
      const green = (out.match(/\[ ✓ \]/g) ?? []).length
      const red = (out.match(/\[ ✗ \]/g) ?? []).length
      check('p13 harmony check', red === 0 && green >= 5, `${green} green / ${red} red`)
    } catch (e) {
      const err = e as { stdout?: string; message: string }
      check('p13 harmony check', false, (err.stdout?.trim().split('\n').pop() ?? err.message).slice(0, 120))
    }
  }

  console.log(`\n══ HARDEN-VERIFY RESULT: ${pass} passed · ${failCount} failed ${failCount === 0 ? '— ALL GREEN' : '— ACTION NEEDED (docs/RUNBOOK.md)'} ══`)
  process.exit(failCount === 0 ? 0 : 1)
}

main().catch((e) => { console.error('harden-verify crashed:', e); process.exit(1) })
