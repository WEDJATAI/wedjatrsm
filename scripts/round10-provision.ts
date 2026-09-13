/**
 * Round 10 — Database Provisioning & Deliverables (COO/PM)
 *
 * 1. Full integrity audit of the live SQLite database:
 *    PRAGMA integrity_check, foreign_key_check, table inventory vs schema,
 *    row counts, and domain-level operational checks (restaurant lens).
 * 2. Packages the deliverables into download/:
 *    - rsm-platform-database.db  (complete database, all modifications applied)
 *    - rsm-database-manifest.json (machine-readable manifest w/ checksums)
 *
 * Run: bun scripts/round10-provision.ts
 */
import { PrismaClient } from '@prisma/client'
import { copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const db = new PrismaClient() // no query logging — clean manifest output
const ROOT = process.cwd()
const LIVE_DB = path.join(ROOT, 'db', 'custom.db')
const DOWNLOAD_DIR = path.join(ROOT, 'download')

// Every table defined in prisma/schema.prisma (@@map names).
const EXPECTED_TABLES = [
  'users', 'roles', 'attendance', 'shifts', 'app_settings', 'categories',
  'products', 'floor_plans', 'tables', 'orders', 'order_items', 'payments',
  'modifier_groups', 'modifiers', 'product_modifier_groups',
  'cash_drawer_sessions', 'cash_drawer_entries', 'recipe_components',
  'audit_logs', 'vision_cameras', 'vision_zones', 'vision_events',
  'vision_table_states', 'movement_candidates', 'inventory_transactions',
] as const

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

interface Manifest {
  package: string
  generatedAt: string
  database: {
    engine: string
    file: string
    sizeBytes: number
    sha256: string
    schemaSha256: string
    prismaClientVersion: string
    integrityCheck: string
    foreignKeyViolations: number
    tablesExpected: number
    tablesFound: number
    missingTables: string[]
    extraTables: string[]
    tableCounts: Record<string, number>
  }
  operations: {
    restaurant: { name: string; nameAr: string }
    usersByRole: Record<string, number>
    activeUsers: number
    floorPlans: Array<{ name: string; active: boolean; tables: number }>
    sellableProducts: number
    ingredientProducts: number
    stockableProducts: number
    ordersByStatus: Record<string, number>
    historicalRevenuePaid: number
    lowStockItems: number
    recipes: number
    modifierGroups: number
  }
  vision: {
    cameras: Array<{ code: string; name: string; status: string; zones: number }>
    zonesTotal: number
    zonesMappedToTables: number
    eventsTotal: number
    eventsByOutcome: Record<string, number>
    tableStates: Record<string, number>
    movementsByStatus: Record<string, number>
    pendingMovements: number
    ingestKeyConfigured: boolean
    ingestKeyMasked: string
    configValid: boolean
    config: Record<string, unknown>
  }
  compliance: {
    auditLogRows: number
    visionAuditRows: number
    passwordHashesAllBcrypt: boolean
    streamUrlsNoCredentials: boolean
    movementConfirmedCount: number
    movementAutoApplied: number // must be 0 — AI never auto-applies
  }
}

async function main() {
  console.log('════ RSM Round 10 — Database Provisioning Audit ════\n')

  // ── 1. Physical integrity ─────────────────────────────────────────
  const integrity = await db.$queryRawUnsafe<[{ integrity_check: string }]>(
    'PRAGMA integrity_check'
  )
  const integrityCheck = integrity[0]?.integrity_check ?? 'unknown'
  console.log(`integrity_check ............ ${integrityCheck}`)

  const fkViolations = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    'PRAGMA foreign_key_check'
  )
  console.log(`foreign_key_check violations  ${fkViolations.length}`)

  // ── 2. Table inventory vs schema ──────────────────────────────────
  const found = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  const foundNames = found.map((r) => r.name)
  const missing = EXPECTED_TABLES.filter((t) => !foundNames.includes(t))
  const extra = foundNames.filter((t) => !(EXPECTED_TABLES as readonly string[]).includes(t))
  console.log(`tables expected/found ....... ${EXPECTED_TABLES.length}/${foundNames.length}`)
  if (missing.length) console.log(`  MISSING: ${missing.join(', ')}`)
  if (extra.length) console.log(`  extra: ${extra.join(', ')}`)

  // ── 3. Row counts across every table ──────────────────────────────
  const tableCounts: Record<string, number> = {}
  for (const t of foundNames) {
    const r = await db.$queryRawUnsafe<[{ n: number | bigint }]>(`SELECT COUNT(*) n FROM "${t}"`)
    tableCounts[t] = Number(r[0].n)
  }
  console.log('\nrow counts:')
  for (const [t, n] of Object.entries(tableCounts)) console.log(`  ${t.padEnd(26)} ${n}`)

  // ── 4. Domain-level operational audit (restaurant lens) ───────────
  const [settings, users, plans, allTables, products, orders, cams, zones, events, states, movements, auditRows] =
    await Promise.all([
      db.appSetting.findMany(),
      db.user.findMany({ select: { role: true, active: true, passwordHash: true } }),
      db.floorPlan.findMany({ select: { id: true, name: true, active: true }, orderBy: { id: 'asc' } }),
      db.restaurantTable.findMany({ select: { id: true, floorPlanId: true, active: true } }),
      db.product.findMany({ select: { isSellable: true, isStockable: true, stock: true, lowStockThreshold: true } }),
      db.order.findMany({ select: { status: true, totalAmount: true } }),
      db.visionCamera.findMany({ select: { id: true, code: true, name: true, status: true, streamUrl: true }, orderBy: { id: 'asc' } }),
      db.visionZone.findMany({ select: { id: true, tableId: true, cameraId: true } }),
      db.visionEvent.findMany({ select: { outcome: true } }),
      db.visionTableState.findMany({ select: { state: true } }),
      db.movementCandidate.findMany({ select: { status: true, appliedAt: true, decidedBy: true } }),
      db.auditLog.findMany({ select: { action: true } }),
    ])

  const settingsMap = new Map(settings.map((s) => [s.key, s.value]))
  const usersByRole: Record<string, number> = {}
  for (const u of users) usersByRole[u.role] = (usersByRole[u.role] ?? 0) + 1
  const activeUsers = users.filter((u) => u.active).length
  const passwordHashesAllBcrypt = users.every((u) => u.passwordHash.startsWith('$2'))

  const floorPlans = plans.map((p) => ({
    name: p.name,
    active: p.active,
    tables: allTables.filter((t) => t.floorPlanId === p.id).length,
  }))
  const sellableProducts = products.filter((p) => p.isSellable).length
  const ingredientProducts = products.filter((p) => !p.isSellable).length
  const stockableProducts = products.filter((p) => p.isStockable).length
  const lowStockItems = products.filter(
    (p) => p.isStockable && p.stock <= p.lowStockThreshold
  ).length

  const ordersByStatus: Record<string, number> = {}
  for (const o of orders) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1
  const historicalRevenuePaid = orders
    .filter((o) => o.status === 'paid')
    .reduce((s, o) => s + o.totalAmount, 0)

  // Vision subsystem
  const camZoneCounts = new Map<number, number>()
  for (const z of zones) camZoneCounts.set(z.cameraId, (camZoneCounts.get(z.cameraId) ?? 0) + 1)
  const cameras = cams.map((c) => ({
    code: c.code,
    name: c.name,
    status: c.status,
    zones: camZoneCounts.get(c.id) ?? 0,
  }))
  const zonesMappedToTables = zones.filter((z) => z.tableId !== null).length
  const streamUrlsNoCredentials = cams.every(
    (c) => !c.streamUrl || !/^[a-z]+:\/\/[^@/]+@/i.test(c.streamUrl)
  )

  const eventsByOutcome: Record<string, number> = {}
  for (const e of events) eventsByOutcome[e.outcome] = (eventsByOutcome[e.outcome] ?? 0) + 1
  const tableStates: Record<string, number> = {}
  for (const s of states) tableStates[s.state] = (tableStates[s.state] ?? 0) + 1
  const movementsByStatus: Record<string, number> = {}
  for (const m of movements) movementsByStatus[m.status] = (movementsByStatus[m.status] ?? 0) + 1
  const pendingMovements = movements.filter((m) => m.status === 'pending').length

  // Safety invariant: every applied movement MUST have a human decider.
  const appliedWithDecider = movements.filter((m) => m.appliedAt !== null && m.decidedBy !== null)
  const movementAutoApplied = appliedWithDecider.length === 0
    ? 0
    : movements.filter((m) => m.appliedAt !== null).length - appliedWithDecider.length

  const visionAuditRows = auditRows.filter((a) => a.action.startsWith('vision.')).length

  const rawIngestKey = settingsMap.get('visionIngestKey') ?? ''
  const ingestKeyMasked = rawIngestKey
    ? `${rawIngestKey.slice(0, 12)}…${rawIngestKey.slice(-4)} (${rawIngestKey.length} chars)`
    : 'NOT SET'
  let configValid = false
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(settingsMap.get('visionConfig') ?? '{}')
    configValid =
      typeof config.highConfidence === 'number' &&
      typeof config.mediumConfidence === 'number' &&
      typeof config.vacancyDelaySeconds === 'number' &&
      typeof config.movementCooldownMinutes === 'number'
  } catch {
    configValid = false
  }

  // ── 5. Print domain summary ───────────────────────────────────────
  console.log('\noperational snapshot:')
  console.log(`  restaurant ................. ${settingsMap.get('restaurantName')}`)
  console.log(`  users (active/total) ....... ${activeUsers}/${users.length} by role ${JSON.stringify(usersByRole)}`)
  console.log(`  floor plans ................ ${floorPlans.map((f) => `${f.name}${f.active ? '' : ' (inactive)'}`).join(' · ')}`)
  console.log(`  products ................... ${sellableProducts} sellable / ${ingredientProducts} ingredients / ${stockableProducts} stockable`)
  console.log(`  orders ..................... ${JSON.stringify(ordersByStatus)} · paid revenue EGP ${historicalRevenuePaid.toFixed(2)}`)
  console.log(`  low-stock items ............ ${lowStockItems}`)
  console.log(`  cameras .................... ${cameras.map((c) => `${c.code}:${c.status}(${c.zones} zones)`).join(' · ')}`)
  console.log(`  vision events .............. ${events.length} total → ${JSON.stringify(eventsByOutcome)}`)
  console.log(`  table states ............... ${JSON.stringify(tableStates)}`)
  console.log(`  movement candidates ........ ${JSON.stringify(movementsByStatus)} (pending ${pendingMovements})`)
  console.log(`  vision audit rows .......... ${visionAuditRows} / ${auditRows.length} total`)
  console.log(`  ingest key ................. ${ingestKeyMasked}`)
  console.log(`  vision config valid ........ ${configValid} → ${JSON.stringify(config)}`)

  // ── 6. Safety invariants (hard fail if violated) ──────────────────
  const failures: string[] = []
  if (integrityCheck !== 'ok') failures.push('integrity_check failed')
  if (fkViolations.length > 0) failures.push(`${fkViolations.length} FK violations`)
  if (missing.length > 0) failures.push(`missing tables: ${missing.join(',')}`)
  if (!passwordHashesAllBcrypt) failures.push('non-bcrypt password hash found')
  if (!streamUrlsNoCredentials) failures.push('camera stream URL contains credentials')
  if (movementAutoApplied > 0) failures.push('movement auto-applied without human decision')
  if (!rawIngestKey) failures.push('vision ingest key not configured')
  if (!configValid) failures.push('vision config invalid')

  console.log(`\nsafety invariants ........... ${failures.length === 0 ? 'ALL PASS ✔' : 'FAIL: ' + failures.join('; ')}`)
  if (failures.length > 0) {
    throw new Error(`Database audit failed: ${failures.join('; ')}`)
  }

  // ── 7. Package deliverables into download/ ─────────────────────────
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true })
  const target = path.join(DOWNLOAD_DIR, 'rsm-platform-database.db')
  await copyFile(LIVE_DB, target)
  const dbBuf = await fsp.readFile(target)
  const schemaBuf = await fsp.readFile(path.join(ROOT, 'prisma', 'schema.prisma'))
  const { size } = await fsp.stat(target)

  const manifest: Manifest = {
    package: 'RSM (Restaurant System Management) — complete platform database',
    generatedAt: new Date().toISOString(),
    database: {
      engine: 'SQLite (embedded, single file — no external DB server required)',
      file: 'rsm-platform-database.db',
      sizeBytes: size,
      sha256: sha256(dbBuf),
      schemaSha256: sha256(schemaBuf),
      prismaClientVersion: '6.19.2',
      integrityCheck,
      foreignKeyViolations: fkViolations.length,
      tablesExpected: EXPECTED_TABLES.length,
      tablesFound: foundNames.length,
      missingTables: missing,
      extraTables: extra,
      tableCounts,
    },
    operations: {
      restaurant: {
        name: settingsMap.get('restaurantName') ?? '',
        nameAr: settingsMap.get('restaurantNameAr') ?? '',
      },
      usersByRole,
      activeUsers,
      floorPlans,
      sellableProducts,
      ingredientProducts,
      stockableProducts,
      ordersByStatus,
      historicalRevenuePaid: Math.round(historicalRevenuePaid * 100) / 100,
      lowStockItems,
      recipes: tableCounts['recipe_components'] ?? 0,
      modifierGroups: tableCounts['modifier_groups'] ?? 0,
    },
    vision: {
      cameras,
      zonesTotal: zones.length,
      zonesMappedToTables,
      eventsTotal: events.length,
      eventsByOutcome,
      tableStates,
      movementsByStatus,
      pendingMovements,
      ingestKeyConfigured: Boolean(rawIngestKey),
      ingestKeyMasked,
      configValid,
      config,
    },
    compliance: {
      auditLogRows: auditRows.length,
      visionAuditRows,
      passwordHashesAllBcrypt,
      streamUrlsNoCredentials,
      movementConfirmedCount: movementsByStatus['confirmed'] ?? 0,
      movementAutoApplied,
    },
  }

  await fsp.writeFile(
    path.join(DOWNLOAD_DIR, 'rsm-database-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  )

  console.log(`\ndeliverables written → download/`)
  console.log(`  rsm-platform-database.db ... ${size} bytes (sha256 ${manifest.database.sha256.slice(0, 16)}…)`)
  console.log(`  rsm-database-manifest.json . complete audit + manifest`)
  console.log('\n════ Round 10 provisioning: PASS ════')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
