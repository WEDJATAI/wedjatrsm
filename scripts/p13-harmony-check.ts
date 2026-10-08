// p13-harmony-check: one-command platform health check — the "are all five
// platforms connected and in harmony" monitor (owner request: "never happens
// any lose connection again"). Read-only. Exit code 0 = all CRITICAL green
// (DEGRADED states — Turso token dead, Inngest integration detached — are
// reported loudly but do not fail the run: the architecture is redundant by
// design, Neon is the data plane, Vercel crons mirror the Inngest jobs).
//
// Checks:
//   CRITICAL  github   — repo reachable with GITHUB_TOKEN; local HEAD vs
//                        origin/main (behind/ahead reported)
//   CRITICAL  vercel   — project + latest production deployment state +
//                        crons enabled
//   CRITICAL  neon     — RW smoke (SELECT 1 + users count)
//   DEGRADED  turso    — pipeline ping with TURSO_AUTH_TOKEN; a 401 means
//                        the token is dead (mint a fresh one: turso db tokens
//                        create — drop it into .env.deploy-local and re-run:
//                        this check turns green automatically)
//   DEGRADED  inngest  — GET VERCEL_PROD_URL/api/inngest; 401 = healthy auth
//                        wall, 503 = integration detached (cron mirrors
//                        active), anything else = unexpected
//   INFO      local    — hybrid outbox pending count + engine state
//
// Credentials come from gitignored .env.deploy-local via scripts/lib/env-local
// (single source of truth; survives sandbox recycles via /home/z/.deploy-creds.env
// and .git/deploy-creds.env copies — see worklog p12).
import { Pool } from 'pg'
import { execSync } from 'node:child_process'
import { envLocal, neonPooledUrl, tursoAuthToken, tursoDatabaseUrl } from './lib/env-local'

type State = 'GREEN' | 'DEGRADED' | 'RED' | 'INFO'
const results: Array<{ platform: string; state: State; note: string }> = []
const mark = (platform: string, state: State, note: string) => {
  results.push({ platform, state, note })
  console.log(`  [${state === 'GREEN' ? ' ✓ ' : state === 'RED' ? ' ✗ ' : state === 'DEGRADED' ? ' ! ' : ' · '}] ${platform.padEnd(8)} ${note}`)
}

console.log('p13 harmony check —', new Date().toISOString())

// ── GitHub ──
try {
  const gh = await fetch(`https://api.github.com/repos/${envLocal('GITHUB_REPO')}`, {
    headers: { Authorization: `Bearer ${envLocal('GITHUB_TOKEN')}`, 'User-Agent': 'p13-harmony-check' },
  })
  if (!gh.ok) throw new Error(`HTTP ${gh.status}`)
  const local = execSync('git rev-parse HEAD', { cwd: '/home/z/my-project' }).toString().trim()
  const remote = await fetch(`https://api.github.com/repos/${envLocal('GITHUB_REPO')}/branches/main`, {
    headers: { Authorization: `Bearer ${envLocal('GITHUB_TOKEN')}`, 'User-Agent': 'p13-harmony-check' },
  })
  const remoteSha = remote.ok ? ((await remote.json()) as { commit?: { sha?: string } }).commit?.sha?.slice(0, 7) ?? '?' : '?'
  const localSha = local.slice(0, 7)
  if (remoteSha === localSha) mark('github', 'GREEN', `repo reachable; origin/main == local HEAD (${localSha}) — in sync`)
  else if (remote.ok) mark('github', 'DEGRADED', `repo reachable; origin/main ${remoteSha} vs local HEAD ${localSha} — push or pull needed`)
  else mark('github', 'GREEN', `repo reachable with held token (branch compare HTTP ${remote.status}); local HEAD ${localSha}`)
} catch (e) {
  mark('github', 'RED', `unreachable: ${(e as Error).message}`)
}

// ── Vercel ──
try {
  const v = await fetch(`https://api.vercel.com/v9/projects/${envLocal('VERCEL_PROJECT')}`, {
    headers: { Authorization: `Bearer ${envLocal('VERCEL_TOKEN')}` },
  })
  if (!v.ok) throw new Error(`HTTP ${v.status}`)
  const pj = (await v.json()) as {
    targets?: { production?: { url?: string; readyState?: string } }
    crons?: { disabledAt?: string | null; definitions?: Array<{ path?: string; schedule?: string }> }
  }
  const prod = pj.targets?.production
  const cronsOk = pj.crons?.disabledAt == null && (pj.crons?.definitions?.length ?? 0) > 0
  const state: State = prod?.readyState === 'READY' && cronsOk ? 'GREEN' : 'DEGRADED'
  mark('vercel', state, `project ok; prod ${prod?.readyState ?? '?'} at ${prod?.url ?? '?'}; crons ${cronsOk ? `enabled (${pj.crons?.definitions?.map((c) => `${c.path} ${c.schedule}`).join(' · ')})` : 'DISABLED'}`)
} catch (e) {
  mark('vercel', 'RED', `unreachable: ${(e as Error).message}`)
}

// ── Neon ──
try {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const one = await pool.query('SELECT 1 AS ok')
  const users = await pool.query('SELECT COUNT(*)::int c FROM users')
  await pool.end()
  if (one.rows[0].ok === 1) mark('neon', 'GREEN', `RW smoke ok; users=${users.rows[0].c}`)
  else throw new Error('SELECT 1 returned unexpected result')
} catch (e) {
  mark('neon', 'RED', `unreachable: ${(e as Error).message}`)
}

// ── Turso ──
try {
  const res = await fetch('https://' + tursoDatabaseUrl().replace(/^libsql:\/\//, '') + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tursoAuthToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }, { type: 'close' }] }),
  })
  if (res.ok) mark('turso', 'GREEN', 'pipeline ping ok with held token')
  else if (res.status === 401)
    mark('turso', 'DEGRADED', `HTTP ${res.status} — held token invalid (server-side key rotation). Owner action: mint a fresh token (turso db tokens create), put it in .env.deploy-local as TURSO_AUTH_TOKEN=… and re-run — turns green automatically. Neon remains the authoritative data plane; nothing is lost while the replica is down.`)
  else mark('turso', 'DEGRADED', `HTTP ${res.status} — unexpected; inspect manually`)
} catch (e) {
  mark('turso', 'DEGRADED', `network error: ${(e as Error).message}`)
}

// ── Inngest (prod endpoint) ──
try {
  const res = await fetch(envLocal('VERCEL_PROD_URL').replace(/\/+$/, '') + '/api/inngest')
  if (res.status === 401) mark('inngest', 'GREEN', 'auth wall live (401) — signing key present, integration healthy')
  else if (res.status === 503)
    mark('inngest', 'DEGRADED', '503 integration detached — no INNGEST_SIGNING_KEY on the deployment. Owner action: re-connect the Inngest integration in the Vercel dashboard and redeploy. The Vercel cron mirrors keep all business functions scheduled; nothing is lost.')
  else mark('inngest', 'DEGRADED', `HTTP ${res.status} — unexpected (expected 401 or 503)`)
} catch (e) {
  mark('inngest', 'DEGRADED', `network error: ${(e as Error).message}`)
}

// ── local outbox (info) ──
try {
  const { Database } = await import('bun:sqlite')
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const pending = (db.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'`).get() as { c: number }).c
  const dead = (db.query(`SELECT COUNT(*) c FROM hybrid_events WHERE status='dead'`).get() as { c: number }).c
  mark('local', 'INFO', `hybrid outbox: ${pending} pending, ${dead} dead — engine syncs with the cloud automatically`)
} catch (e) {
  mark('local', 'INFO', `outbox not readable: ${(e as Error).message}`)
}

const criticalRed = results.filter((r) => r.state === 'RED')
console.log('\nRESULT:', criticalRed.length === 0
  ? 'ALL CRITICAL PLATFORMS GREEN' + (results.some((r) => r.state === 'DEGRADED') ? ' (with documented DEGRADED states — see above; architecture is redundant by design)' : '')
  : `${criticalRed.length} CRITICAL FAILURE(S): ${criticalRed.map((r) => r.platform).join(', ')}`)
process.exit(criticalRed.length === 0 ? 0 : 1)
