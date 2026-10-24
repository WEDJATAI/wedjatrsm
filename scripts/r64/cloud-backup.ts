/**
 * R64 cloud backup pipeline — one command captures EVERY plane's data into a
 * single encrypted, round-trip-verified bundle, then publishes it to the
 * GitHub release channel (tag r64-backup, never "latest").
 *
 *   bun scripts/r64/cloud-backup.ts make
 *     → backups/r64/r64-cloud-backup-<ts>.tar.gz.enc (+ .sha256 + staging/)
 *
 *   bun scripts/r64/cloud-backup.ts upload <file.enc>
 *     → creates/patches the r64-backup GitHub release + uploads the asset
 *
 * Bundle contents (staged under backups/r64/staging-<ts>/):
 *   local-db/custom-<ts>.db          VACUUM INTO snapshot of live db/custom.db
 *   local-db/rsm-platform-database.db the shipped desktop payload snapshot
 *   neon/neon-data-dump.sql          full row dump of the Neon system of record
 *   turso/turso-data-dump.sql        full row dump of the Turso replica
 *   env/…                            credential files — SECRETS, encrypted-only
 *   code/repo-head.tar.gz            git archive of the pushed root commit
 *   manifest.json                    sha256 + sizes + per-table row counts
 *   RESTORE.md                       plaintext restore runbook (no secrets)
 *
 * Encryption: openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt.
 * Passphrase: RSM_BACKUP_PASSPHRASE in .env.deploy-local (generated on first
 * run, reused afterwards) — also mirrored to backups/r64-backup.passphrase
 * (mode 0600, gitignored). NEVER print it, never commit it.
 *
 * Round-trip proof: every `make` decrypts its own output back to a temp file
 * and re-hashes every artifact against manifest.json before reporting OK.
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { envLocal, neonPooledUrl, tursoAuthToken, tursoDatabaseUrl } from '../lib/env-local'

const ROOT = process.cwd()
const BK = join(ROOT, 'backups', 'r64')
const ENV_FILE = join(ROOT, '.env.deploy-local')
const GITHUB_API = 'https://api.github.com'
const GITHUB_UPLOADS = 'https://uploads.github.com'
const RELEASE_TAG = 'r64-backup'

const sha256 = (f: string): string => createHash('sha256').update(readFileSync(f)).digest('hex')

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

// ── passphrase management ─────────────────────────────────────────────────
function readEnvRaw(): string {
  return readFileSync(ENV_FILE, 'utf8')
}

function getOrCreatePassphrase(): string {
  const raw = readEnvRaw()
  const m = raw.match(/^RSM_BACKUP_PASSPHRASE=(.+)$/m)
  if (m && m[1].trim()) return m[1].trim()
  const pass = randomBytes(24).toString('base64')
  // append to .env.deploy-local (gitignored credential store)
  const withLine = raw.endsWith('\n') ? raw + `RSM_BACKUP_PASSPHRASE=${pass}\n` : raw + `\nRSM_BACKUP_PASSPHRASE=${pass}\n`
  writeFileSync(ENV_FILE, withLine, { mode: 0o600 })
  const passFile = join(ROOT, 'backups', 'r64-backup.passphrase')
  writeFileSync(passFile, `RSM_BACKUP_PASSPHRASE=${pass}\n`, { mode: 0o600 })
  chmodSync(passFile, 0o600)
  console.log('  · generated new RSM_BACKUP_PASSPHRASE (stored in .env.deploy-local + backups/r64-backup.passphrase)')
  return pass
}

// ── SQL value escapers ────────────────────────────────────────────────────
function pgValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `'\\x${Buffer.from(v as Uint8Array).toString('hex')}'`
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

function liteValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString('hex')}'`
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  return `'${String(v).replace(/'/g, "''")}'`
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// ── Neon dump ─────────────────────────────────────────────────────────────
async function dumpNeon(dir: string): Promise<Record<string, number>> {
  console.log('  · Neon: connecting (pooled)…')
  const pool = new Pool({ connectionString: neonPooledUrl(), max: 1, ssl: { rejectUnauthorized: false } })
  try {
    const tables = (await pool.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
    )).rows.map((r: any) => r.relname as string)

    const counts: Record<string, number> = {}
    const parts: string[] = [
      `-- RSM Platform — Neon data dump ${new Date().toISOString()}`,
      `-- system of record (production, Vercel plane) — schema: prisma/schema.postgres.prisma`,
      `-- restore: fresh Neon DB → prisma db push --schema prisma/schema.postgres.prisma → import this file`,
      `BEGIN;`,
      `SET session_replication_role = replica; -- FK-safe: restore rows in any order`,
      ``,
    ]
    for (const t of tables) {
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
        [t],
      )).rows.map((r: any) => r.column_name as string)
      const res = await pool.query(`SELECT * FROM "${t}"`)
      counts[t] = res.rowCount ?? 0
      parts.push(`-- table: ${t} (${counts[t]} rows)`)
      if (!cols.length) continue
      const colList = cols.map((c) => `"${c}"`).join(',')
      for (const batch of chunk(res.rows as any[], 200)) {
        const values = batch.map((row) => `(${cols.map((c) => pgValue(row[c])).join(',')})`).join(',\n')
        parts.push(`INSERT INTO "${t}"(${colList}) VALUES\n${values};`)
      }
      parts.push(``)
    }
    parts.push(`COMMIT;`, ``)
    writeFileSync(join(dir, 'neon-data-dump.sql'), parts.join('\n'))
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    console.log(`  · Neon: ${tables.length} tables, ${total} rows dumped`)
    await pool.end()
    return counts
  } catch (e) {
    try { await pool.end() } catch { /* noop */ }
    throw e
  }
}

// ── Turso dump ────────────────────────────────────────────────────────────
async function dumpTurso(dir: string): Promise<Record<string, number>> {
  console.log('  · Turso: connecting (libsql http)…')
  const client = createClient({ url: tursoDatabaseUrl(), authToken: tursoAuthToken() })
  try {
    const tables = (
      await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    ).rows.map((r) => String(r.name))

    const counts: Record<string, number> = {}
    const parts: string[] = [
      `-- RSM Platform — Turso replica dump ${new Date().toISOString()}`,
      `-- analytics/backup replica — canonical resync: bun scripts/sync-turso.ts`,
      ``,
    ]
    for (const t of tables) {
      const res = await client.execute(`SELECT * FROM "${t}"`)
      counts[t] = res.rows.length
      parts.push(`-- table: ${t} (${counts[t]} rows)`)
      if (!res.rows.length) continue
      const cols = Object.keys(res.rows[0] as Record<string, unknown>)
      const colList = cols.map((c) => `"${c}"`).join(',')
      for (const batch of chunk(res.rows as Record<string, unknown>[], 200)) {
        const values = batch.map((row) => `(${cols.map((c) => liteValue(row[c])).join(',')})`).join(',\n')
        parts.push(`INSERT INTO "${t}"(${colList}) VALUES\n${values};`)
      }
      parts.push(``)
    }
    writeFileSync(join(dir, 'turso-data-dump.sql'), parts.join('\n'))
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    console.log(`  · Turso: ${tables.length} tables, ${total} rows dumped`)
    client.close()
    return counts
  } catch (e) {
    try { client.close() } catch { /* noop */ }
    throw e
  }
}

// ── local SQLite snapshot ─────────────────────────────────────────────────
function snapshotSqlite(dir: string, ts: string): void {
  console.log('  · SQLite: VACUUM INTO live db/custom.db…')
  const live = join(ROOT, 'db', 'custom.db')
  const target = join(dir, `custom-${ts}.db`)
  const ldb = new Database(live, { readonly: true })
  try {
    ldb.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`)
  } finally {
    ldb.close()
  }
  const payload = join(ROOT, 'download', 'rsm-platform-database.db')
  if (existsSync(payload)) copyFileSync(payload, join(dir, 'rsm-platform-database.db'))
  console.log(`  · SQLite: snapshot ${statSync(target).size.toLocaleString()} bytes + payload copy`)
}

// ── make ──────────────────────────────────────────────────────────────────
async function make(): Promise<void> {
  const ts = stamp()
  const staging = join(BK, `staging-${ts}`)
  mkdirSync(join(staging, 'local-db'), { recursive: true })
  mkdirSync(join(staging, 'neon'), { recursive: true })
  mkdirSync(join(staging, 'turso'), { recursive: true })
  mkdirSync(join(staging, 'env'), { recursive: true })
  mkdirSync(join(staging, 'code'), { recursive: true })

  console.log(`r64 cloud backup — make ${ts}`)
  snapshotSqlite(join(staging, 'local-db'), ts)
  const neonCounts = await dumpNeon(join(staging, 'neon'))
  const tursoCounts = await dumpTurso(join(staging, 'turso'))

  // env + credential copies (SECRETS — only ever live inside the encrypted tar)
  for (const src of [
    join(ROOT, '.env.deploy-local'),
    join(ROOT, '.env'),
    join('/home/z/.deploy-creds.env'),
    join(ROOT, '.git', 'deploy-creds.env'),
  ]) {
    if (existsSync(src)) copyFileSync(src, join(staging, 'env', src.split('/').slice(-2).join('_')))
  }

  // code archive of the pushed root commit
  console.log('  · code: git archive HEAD…')
  const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  execFileSync('git', ['archive', '--format=tar.gz', '-o', join(staging, 'code', 'repo-head.tar.gz'), 'HEAD'], {
    cwd: ROOT,
    stdio: 'inherit',
  })

  // manifest + RESTORE.md
  const artifacts: Array<{ file: string; bytes: number; sha256: string }> = []
  const walk = (d: string, base = '') => {
    for (const f of readdirSync(d)) {
      const full = join(d, f)
      if (statSync(full).isDirectory()) { walk(full, `${base}${f}/`); continue }
      if (f === 'manifest.json' || f === 'RESTORE.md') continue
      artifacts.push({ file: `${base}${f}`, bytes: statSync(full).size, sha256: sha256(full) })
    }
  }
  walk(staging)
  const manifest = {
    generatedAt: new Date().toISOString(),
    round: 'R64 — harden structure + full cloud backup + single-commit git collapse',
    headCommit: headSha,
    artifacts,
    counts: { neon: neonCounts, turso: tursoCounts },
  }
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(staging, 'RESTORE.md'),
    `# RSM Platform — cloud backup bundle ${ts}

Decrypt (passphrase: .env.deploy-local → RSM_BACKUP_PASSPHRASE on the admin machine,
mirrored at backups/r64-backup.passphrase):

    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \\
      -in r64-cloud-backup-${ts}.tar.gz.enc -out bundle.tar.gz \\
      -pass env:RSM_BACKUP_PASSPHRASE
    tar -xzf bundle.tar.gz
    # verify every sha256 against manifest.json before restoring anything

## Restore paths
1. **Local / desktop plane (SQLite)** — stop the app, then:
   cp local-db/custom-${ts}.db db/custom.db
2. **Neon (system of record)** — fresh Neon database, then:
   DATABASE_URL=<url> bunx prisma db push --schema prisma/schema.postgres.prisma
   psql <url> -f neon/neon-data-dump.sql      (dump sets session_replication_role=replica)
3. **Turso replica** — no dump import needed, resync from the system of record:
   TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… bun scripts/sync-turso.ts
4. **Code** — the single-commit repository is on GitHub (WEDJATAI/wedjatrsm);
   code/repo-head.tar.gz is the identical tree of commit ${headSha.slice(0, 12)}.

## Notes
- env/ holds credential files — treat the decrypted bundle as a secret.
- The desktop payload snapshot (local-db/rsm-platform-database.db) is the DB
  future fresh installs bootstrap from (mirrors the GitHub release payload).
`,
  )

  // tar + encrypt + round-trip verify
  const tarPath = join(BK, `r64-cloud-backup-${ts}.tar.gz`)
  const encPath = `${tarPath}.enc`
  console.log('  · tar + encrypt (aes-256-cbc · pbkdf2 · 200000 iters)…')
  execFileSync('tar', ['-czf', tarPath, '-C', staging, '.'])
  const pass = getOrCreatePassphrase()
  execFileSync('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt', '-in', tarPath, '-out', encPath, '-pass', 'env:RSM_BK_PASS'], {
    env: { ...process.env, RSM_BK_PASS: pass },
  })
  rmSync(tarPath)

  // round-trip proof
  console.log('  · verifying round-trip decrypt…')
  const verifyTar = join(BK, `.verify-${ts}.tar.gz`)
  execFileSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-in', encPath, '-out', verifyTar, '-pass', 'env:RSM_BK_PASS'], {
    env: { ...process.env, RSM_BK_PASS: pass },
  })
  const verifyDir = join(BK, `.verify-${ts}`)
  mkdirSync(verifyDir, { recursive: true })
  execFileSync('tar', ['-xzf', verifyTar, '-C', verifyDir])
  const m = JSON.parse(readFileSync(join(verifyDir, 'manifest.json'), 'utf8'))
  let ok = 0
  for (const a of m.artifacts as Array<{ file: string; sha256: string }>) {
    const h = sha256(join(verifyDir, a.file))
    if (h !== a.sha256) throw new Error(`round-trip mismatch: ${a.file}`)
    ok++
  }
  rmSync(verifyTar)
  rmSync(verifyDir, { recursive: true, force: true })
  writeFileSync(`${encPath}.sha256`, `${sha256(encPath)}  r64-cloud-backup-${ts}.tar.gz.enc\n`)

  console.log(`\nr64 cloud backup OK → ${encPath}`)
  console.log(`  · ${statSync(encPath).size.toLocaleString()} bytes · ${artifacts.length + 2} files · round-trip verified ${ok}/${(m.artifacts as unknown[]).length} artifacts`)
  console.log(`  · passphrase: .env.deploy-local → RSM_BACKUP_PASSPHRASE (never printed, never committed)`)
  console.log(`  · next: bun scripts/r64/cloud-backup.ts upload ${encPath}`)
}

// ── upload ────────────────────────────────────────────────────────────────
async function upload(file: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`file not found: ${file}`)
  const token = envLocal('GITHUB_TOKEN')
  const repo = envLocal('GITHUB_REPO')
  const name = file.split('/').pop() as string
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rsm-r64-backup' }

  // find or create the r64-backup release
  let releaseId: number | null = null
  const byTag = await fetch(`${GITHUB_API}/repos/${repo}/releases/tags/${RELEASE_TAG}`, { headers })
  if (byTag.ok) {
    const rel = (await byTag.json()) as any
    releaseId = rel.id
    // replace any same-named asset
    for (const asset of rel.assets ?? []) {
      if (asset.name === name) {
        await fetch(`${GITHUB_API}/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE', headers })
        console.log(`  · replaced old asset ${name}`)
      }
    }
    console.log(`  · using existing release ${RELEASE_TAG} (#${releaseId})`)
  } else {
    const created = await fetch(`${GITHUB_API}/repos/${repo}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: RELEASE_TAG,
        target_commitish: 'main',
        name: 'RSM Platform — cloud backup (encrypted, AES-256)',
        body: [
          'Encrypted full-system backup bundle produced by `scripts/r64/cloud-backup.ts`.',
          '',
          '**Contents (inside the encrypted tar.gz):** live SQLite snapshot · Neon data dump · Turso replica dump · credential files · code archive of the single root commit · sha256 manifest · RESTORE runbook.',
          '',
          '**Decrypt:** `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in <file>.enc -out bundle.tar.gz -pass env:RSM_BACKUP_PASSPHRASE` — the passphrase lives only in the gitignored `.env.deploy-local` on the admin machine.',
          '',
          'This release is a backup channel: it is never marked "latest" and is not part of the app download flow.',
        ].join('\n'),
        make_latest: 'false',
      }),
    })
    if (!created.ok) throw new Error(`release create failed: ${created.status} ${await created.text()}`)
    const rel = (await created.json()) as any
    releaseId = rel.id
    console.log(`  · created release ${RELEASE_TAG} (#${releaseId})`)
  }

  // upload the asset
  const body = readFileSync(file)
  const up = await fetch(`${GITHUB_UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
    body,
  })
  if (!up.ok) throw new Error(`asset upload failed: ${up.status} ${await up.text()}`)
  const asset = (await up.json()) as any
  console.log(`  · uploaded ${name} (${body.length.toLocaleString()} bytes)`)

  // anonymous availability proof (public repo)
  const anon = await fetch(asset.browser_download_url, { method: 'HEAD' })
  console.log(`  · anonymous availability: ${anon.status} ${anon.status === 200 ? '✓' : '✗'} → ${asset.browser_download_url}`)
  if (anon.status !== 200) throw new Error('asset not anonymously reachable')
  console.log(`\nupload OK → https://github.com/${repo}/releases/tag/${RELEASE_TAG}`)
}

const mode = process.argv[2] ?? 'make'
if (mode === 'make') {
  make().catch((e) => { console.error('[r64-backup] FAILED:', e); process.exit(1) })
} else if (mode === 'upload') {
  const file = process.argv[3]
  if (!file) { console.error('Usage: bun scripts/r64/cloud-backup.ts upload <file.enc>'); process.exit(1) }
  upload(file).catch((e) => { console.error('[r64-backup] FAILED:', e); process.exit(1) })
} else {
  console.error('Usage: bun scripts/r64/cloud-backup.ts [make | upload <file.enc>]')
  process.exit(1)
}
