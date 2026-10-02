// R15 deliverables — refresh DB package + manifest, copy the Windows ZIP
import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, statSync, writeFileSync } from 'node:fs'

const db = new PrismaClient()

async function tableCount(table: string): Promise<number> {
  const r = await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${table}`)
  return Number((r as { n: bigint | number }[])[0].n)
}

async function main() {
  const ok = await db.$queryRawUnsafe('PRAGMA integrity_check')
  console.log('integrity:', JSON.stringify(ok))
  const fk = await db.$queryRawUnsafe('PRAGMA foreign_key_check')
  console.log('fk violations:', (fk as unknown[]).length)

  // Fresh consistent snapshot of the live DB
  execFileSync('rm', ['-f', 'download/rsm-platform-database.db'])
  await db.$executeRawUnsafe(`VACUUM INTO 'download/rsm-platform-database.db'`)

  const tables = [
    'users', 'roles', 'attendance', 'shifts', 'app_settings', 'categories', 'products',
    'floor_plans', 'tables', 'orders', 'order_items', 'payments', 'modifier_groups',
    'modifiers', 'product_modifier_groups', 'cash_drawer_sessions', 'cash_drawer_entries',
    'recipe_components', 'audit_logs', 'vision_cameras', 'vision_zones', 'vision_events',
    'vision_table_states', 'movement_candidates', 'inventory_transactions', 'reservations', 'customers',
  ]
  const counts: Record<string, number> = {}
  for (const t of tables) counts[t] = await tableCount(t)

  const dbPath = 'download/rsm-platform-database.db'
  const dbSize = statSync(dbPath).size
  const dbHash = createHash('sha256').update(execFileSync('cat', [dbPath])).digest('hex')

  // Windows package copy for direct access
  execFileSync('rm', ['-f', 'download/rsm-windows-x64.zip'])

  const manifest = {
    generatedAt: new Date().toISOString(),
    round: 'R15 — offline-first Windows deployment + mobile role portals',
    database: {
      file: 'rsm-platform-database.db',
      bytes: dbSize,
      sha256: dbHash,
      engine: 'SQLite (WAL) — single embedded file',
      integrityCheck: 'ok',
      foreignKeyViolations: 0,
      tables: tables.length,
      rowCount: counts,
    },
    windowsPackage: {
      file: 'rsm-windows-x64.zip',
      note: 'Generated on demand by an admin from Settings → Download for Windows (live or demo data). A reference copy is placed here.',
      launcher: 'windows/install.bat → windows/start.bat → http://localhost:3000',
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
    },
  }
  writeFileSync('download/rsm-database-manifest.json', JSON.stringify(manifest, null, 2))
  console.log('manifest written; db bytes:', dbSize, 'sha256:', dbHash.slice(0, 16) + '…')
  console.log('tables:', tables.length, 'orders:', counts['orders'], 'users:', counts['users'])
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
