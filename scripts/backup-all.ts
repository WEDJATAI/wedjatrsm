/**
 * R11 backup tooling: DB snapshot + full code bundle.
 *
 *   bun run db:backup   → timestamped SQLite copy into backups/
 *   bun run backup:all  → DB snapshot + git bundle (code + history)
 *
 * The git bundle is a single-file, self-contained repository clone stored
 * OUTSIDE .git — restore with `git clone backups/<file>.bundle restored`.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DB = join(ROOT, 'db', 'custom.db')
const BACKUPS = join(ROOT, 'backups')

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function backupDb(): string | null {
  mkdirSync(BACKUPS, { recursive: true })
  if (!existsSync(DB)) {
    console.error('db:backup — db/custom.db not found.')
    return null
  }
  const target = join(BACKUPS, `custom-manual-${stamp()}.db`)
  copyFileSync(DB, target)
  console.log(`db:backup → ${target}`)
  return target
}

function backupBundle(): string | null {
  mkdirSync(BACKUPS, { recursive: true })
  if (!existsSync(join(ROOT, '.git'))) {
    console.error('backup:all — no git repository, skipping bundle.')
    return null
  }
  const target = join(BACKUPS, `repo-snapshot-${stamp()}.bundle`)
  execFileSync('git', ['bundle', 'create', target, '--all'], { cwd: ROOT, stdio: 'inherit' })
  console.log(`backup:all → ${target}`)
  return target
}

const mode = process.argv[2] ?? 'db'
if (mode === 'db') {
  process.exit(backupDb() ? 0 : 1)
} else if (mode === 'all') {
  const db = backupDb()
  const bundle = backupBundle()
  process.exit(db && bundle ? 0 : 1)
} else {
  console.error('Usage: bun scripts/backup-all.ts [db|all]')
  process.exit(1)
}
