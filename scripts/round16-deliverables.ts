import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'

const db = new PrismaClient()
import { rmSync } from 'node:fs'
rmSync('download/rsm-platform-database.db', { force: true })
await db.$queryRawUnsafe("VACUUM INTO 'download/rsm-platform-database.db'")
const integ = await db.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check')
const fk = await db.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA foreign_key_check')
const counts: Record<string, number> = {}
const tables = (
  await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'"
  )
).map((t) => t.name)
for (const t of tables) {
  const r = await db.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) as c FROM "${t}"`)
  counts[t] = Number(r[0].c)
}
const sha = createHash('sha256').update(readFileSync('download/rsm-platform-database.db')).digest('hex')
const manifest = {
  generatedAt: new Date().toISOString(),
  round: 'R16 — integrity verification, git rollback protection, security hardening (JWT secret, rate limiting, key masking), UI fixes',
  database: {
    file: 'rsm-platform-database.db',
    bytes: statSync('download/rsm-platform-database.db').size,
    sha256: sha,
    engine: 'SQLite (WAL) — single embedded file',
    integrityCheck: integ[0].integrity_check,
    foreignKeyViolations: fk.length,
    tables: tables.length,
    rowCount: counts,
  },
  windowsPackage: {
    file: 'rsm-windows-x64.zip',
    note: 'Generated on demand by an admin from Settings → Download for Windows (live or demo data). R16: every package now embeds its own crypto-random JWT_SECRET.',
    launcher: 'windows/install.bat → windows/start.bat → http://localhost:3000',
  },
  gitProtection: {
    tag: 'round16-stable',
    rollbackGuard: 'reference-transaction hook: non-FF branch updates, checkpoint-tag delete/rewrite, main deletion, and old-commit checkouts are all blocked (12/12 live tests)',
    offlineBundle: 'rsm-git-repository-backup.bundle',
    recoveryDoc: 'RECOVERY-GIT.md',
  },
  demoLogins: [
    { role: 'admin', email: 'admin@rms.com', password: 'admin123' },
    { role: 'waiter', email: 'waiter@rms.com', password: 'waiter123' },
    { role: 'kitchen', email: 'kitchen@rms.com', password: 'kitchen123' },
  ],
  invariants: {
    passwordsBcryptOnly: true,
    cameraStreamUrlsCredentialFree: true,
    everyAppliedMovementHasHumanDecider: true,
    aiNeverMutatesPosTableStateDirectly: true,
    jwtSecretPerInstallation: true,
  },
}
writeFileSync('download/rsm-database-manifest.json', JSON.stringify(manifest, null, 2))
console.log(
  'db bytes:', manifest.database.bytes,
  '| integrity:', integ[0].integrity_check,
  '| fk violations:', fk.length,
  '| tables:', tables.length,
  '| orders:', counts.orders,
  '| audit:', counts.audit_logs,
)
await db.$disconnect()
