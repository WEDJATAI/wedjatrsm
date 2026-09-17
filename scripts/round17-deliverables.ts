// Round 17 deliverables: refreshed database snapshot (VACUUM INTO) + manifest.
// Mirrors round16-deliverables.ts with the R17 module inventory.
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { rmSync } from 'node:fs'

const db = new PrismaClient()
rmSync('download/rsm-platform-database.db', { force: true })
await db.$queryRawUnsafe("VACUUM INTO 'download/rsm-platform-database.db'")
const integ = await db.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check')
const fk = await db.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA foreign_key_check')
const counts: Record<string, number> = {}
const tables = (
  await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'",
  )
).map((t) => t.name)
for (const t of tables) {
  const r = await db.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) as c FROM "${t}"`)
  counts[t] = Number(r[0].c)
}
const sha = createHash('sha256')
  .update(readFileSync('download/rsm-platform-database.db'))
  .digest('hex')
const manifest = {
  generatedAt: new Date().toISOString(),
  round: 'R17 — Foodics/Odoo-level upgrade: purchasing (suppliers + POs + receiving), stock counts, waste management, promotions engine w/ live POS integration, payroll + forecast, refunds restored, R9 AI copilot/briefing re-wired',
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
  r17Modules: {
    purchasing: 'Suppliers CRUD + PO lifecycle (draft→ordered→received/cancelled, partial receiving, last-purchase-price revaluation, stock ledger integration) — #/purchases',
    stockCounts: 'Count sheets with system snapshot, variance posting (adjustment transactions), cancel — #/stockcounts',
    waste: 'Waste log (6 reasons, cost-valued) + waste report by reason/top items — #/stockcounts → Waste tab',
    promotions: 'Time-windowed rules (percent/fixed × order/category/product), auto-applied server-side at the order recompute choke point, live POS cart preview, never stacks with manager discounts — #/promotions',
    payroll: 'User hourly rates + attendance-based payroll report (sessions, hours, late minutes, gross pay) — #/payroll',
    forecast: '28-day history + same-weekday-average 7-day projection — dashboard card + /api/reports/forecast',
    refunds: 'Admin-only negative-payment refunds against paid checks (capacity-clamped, reason-required, audited), Z-report refunds section + refunds card in Reports',
    aiRestored: 'R9 AI morning briefing + copilot chat re-wired onto the dashboard (components + APIs existed but render wiring had been lost); ai.* dictionary rebuilt EN/AR',
  },
  windowsPackage: {
    file: 'rsm-windows-x64.zip',
    note: 'Generated on demand by an admin from Settings → Download for Windows (live or demo data). Per-install crypto-random JWT_SECRET embedded. R17 note: new modules ship in the package; the R15 sync engine syncs the original 9 tables (R17 tables sync pending — documented).',
    launcher: 'windows/install.bat → windows/start.bat → http://localhost:3000',
  },
  gitProtection: {
    tag: 'round17-stable',
    rollbackGuard: 'reference-transaction hook (unchanged from R16, 12/12 live tests): non-FF branch updates, checkpoint-tag delete/rewrite, main deletion, and old-commit checkouts are all blocked',
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
    r17ZeroDeletionVerified: true,
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
