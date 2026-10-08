/**
 * R23: Full-replication engine — system of record → Turso replica.
 *
 * Strategy: idempotent FULL refresh (this dataset is a few thousand rows —
 * a complete copy takes ~1–2 s over the libsql HTTP protocol and is always
 * self-consistent, unlike incremental sync which needs watermarks and
 * conflict handling):
 *   1. ensure the replica schema exists (idempotent DDL — src/lib/turso-schema.ts)
 *   2. one transactional batch per table: DELETE then INSERTs, parents first
 *      (topological order from the Prisma DMMF — identical model shapes on
 *      both the SQLite and PostgreSQL clients)
 *   3. verify per-table row counts against the source
 *
 * Runs on a schedule (Vercel cron /api/cron/turso-sync + Inngest
 * rsm-turso-replica-sync) and on demand. Safe to re-run at any time.
 */
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { getTursoClient, isTursoConfigured } from '@/lib/turso'
import { TURSO_DDL, TURSO_DDL_MIGRATIONS, HYBRID_QUEUE_TABLES } from '@/lib/turso-schema'

export type TursoSyncTableReport = {
  table: string
  sourceRows: number
  replicaRows: number
  ok: boolean
}

export type TursoSyncReport = {
  ok: boolean
  configured: boolean
  tables: TursoSyncTableReport[]
  totalRows: number
  durationMs: number
  error?: string
  syncedAt: string
}

type DmmfField = {
  name: string
  kind: string
  type: string
  isId?: boolean // r49: absent from Prisma 7's reconstructed DMMF — kept optional for v6 compat
  dbName: string | null
  relationFromFields?: string[]
}
type DmmfModel = {
  name: string
  dbName: string | null
  fields: DmmfField[]
}

type ModelInfo = {
  model: DmmfModel
  table: string
  accessor: string
  /** physical column names for every scalar field, in DMMF order */
  columns: string[]
}

function accessorFor(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1)
}

/** Models topologically sorted by FK dependencies (parents first).
 * R30: hybrid-sync queue tables (HYBRID_QUEUE_TABLES) are EXCLUDED — they are
 * per-installation operational state (outbox/in-record/device registry), not
 * business data; a full-refresh copy of a queue is meaningless and harmful.
 *
 * r51 FIX (Prisma 7 regression): Prisma 7's reconstructed DMMF dropped
 * `relationFromFields` from object fields, so the old dependency detection
 * silently found ZERO edges and degenerated to schema-file order — inserting
 * `users` (child) before `roles` (parent) and failing the replica's
 * users_role_id_fkey on EVERY full refresh (the daily cron had been failing
 * since the r49 Prisma 7 upgrade). The FK graph is now derived from
 * TURSO_DDL itself — the exact constraint set the replica enforces — which
 * is version-independent ground truth. DMMF edges are kept as a secondary
 * source for v6 compatibility. */
function orderedModels(): ModelInfo[] {
  const models = (Prisma.dmmf.datamodel.models as unknown as DmmfModel[]).filter(
    (m) => !HYBRID_QUEUE_TABLES.has(m.dbName ?? m.name),
  )
  const tableToModel = new Map(models.map((m) => [m.dbName ?? m.name, m]))
  const syncedTables = new Set(tableToModel.keys())

  // FK edges straight from the replica DDL: FOREIGN KEY ("col") REFERENCES "table" ("col")
  const ddlDeps = new Map<string, Set<string>>()
  const fkPattern = /FOREIGN KEY\s*\([^)]*\)\s*REFERENCES\s*"([^"]+)"/gi
  for (const ddl of TURSO_DDL) {
    const tableMatch = /CREATE TABLE IF NOT EXISTS\s+"([^"]+)"/i.exec(ddl)
    if (!tableMatch) continue
    const table = tableMatch[1]
    if (!syncedTables.has(table)) continue
    const d = ddlDeps.get(table) ?? new Set<string>()
    for (const m of ddl.matchAll(fkPattern)) {
      const parent = m[1]
      // self-references (Product→Product recipe links) and FKs pointing at
      // non-synced tables (hybrid queues) can never resolve in this walk
      if (parent !== table && syncedTables.has(parent)) d.add(parent)
    }
    ddlDeps.set(table, d)
  }

  const deps = new Map<string, Set<string>>()
  for (const m of models) {
    const table = m.dbName ?? m.name
    const d = new Set<string>(ddlDeps.get(table) ?? [])
    // v6-compat secondary source: DMMF relation edges (empty under Prisma 7)
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0 && f.type !== m.name) {
        const parentModel = models.find((x) => x.name === f.type)
        const parentTable = parentModel?.dbName ?? parentModel?.name
        if (parentTable && syncedTables.has(parentTable)) d.add(parentTable)
      }
    }
    // store keyed by table name, translated back to model names below
    deps.set(table, d)
  }
  const orderedTables: string[] = []
  const remaining = new Set(syncedTables)
  for (let progress = true; remaining.size > 0 && progress; ) {
    progress = false
    for (const name of [...remaining]) {
      const d = deps.get(name) ?? new Set<string>()
      if ([...d].every((x) => !remaining.has(x))) {
        orderedTables.push(name)
        remaining.delete(name)
        progress = true
      }
    }
  }
  if (remaining.size > 0) {
    throw new Error(`FK cycle between tables: ${[...remaining].join(', ')}`)
  }
  return orderedTables.map((table) => {
    const model = tableToModel.get(table)!
    return {
      model,
      table,
      accessor: accessorFor(model.name),
      columns: model.fields
        .filter((f) => f.kind === 'scalar')
        .map((f) => f.dbName ?? f.name),
    }
  })
}

/** libsql value conversion — Dates become ISO strings (sortable, unambiguous). */
function toSqlValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}

/**
 * r38: retry wrapper for EVERY replica operation. Turso's Hrana endpoint
 * intermittently answers 502 in BURSTS lasting a few seconds (found live:
 * identical DDL lists passed and failed minutes apart; a 1.5s retry window
 * was too short — one burst outlasted it). The sync is a full refresh, so
 * re-sending a failed statement is always safe. 4 attempts, 1s × attempt
 * backoff (~6s total window) rides out every burst observed.
 */
async function withTursoRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * attempt))
    }
  }
  throw new Error(`turso op failed after 4 attempts (${label}): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

/**
 * Run one full replication pass. NEVER throws for configuration/token
 * problems — those come back as { ok: false, error } so scheduled callers
 * can log them without crashing.
 */
export async function syncAllToTurso(): Promise<TursoSyncReport> {
  const started = Date.now()
  const report: TursoSyncReport = {
    ok: false,
    configured: isTursoConfigured(),
    tables: [],
    totalRows: 0,
    durationMs: 0,
    syncedAt: new Date().toISOString(),
  }
  if (!report.configured) {
    report.error = 'Turso replica is not configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing)'
    report.durationMs = Date.now() - started
    return report
  }

  try {
    const client = getTursoClient()

    // 1) ensure schema (idempotent)
    for (const ddl of TURSO_DDL) {
      await withTursoRetry(() => client.execute(ddl), 'ddl')
    }
    // 1b) column evolution on existing tables (R26) — duplicate-column
    //     errors mean the column is already there, which is success.
    for (const ddl of TURSO_DDL_MIGRATIONS) {
      try {
        await withTursoRetry(() => client.execute(ddl), 'ddl-migration')
      } catch {
        // ALTER TABLE ADD COLUMN re-run → column exists → fine
      }
    }

    // 2) full refresh, FK-safe on RE-runs:
    //    a) read all source rows first (a read error aborts before any mutation)
    //    b) DELETE children-first (REVERSE topo order) — the schema has 10
    //       ON DELETE RESTRICT FKs, so deleting a parent while children still
    //       reference it would fail (this bit the very first implementation:
    //       run #1 succeeded only because every table was still empty)
    //    c) INSERT parents-first (forward topo order), one batch per table
    const infos = orderedModels()
    const rowsByTable = new Map<string, Array<Record<string, unknown>>>()
    // R26: via `unknown` — the delegate cast is intentional (dynamic model walk)
    const delegates = db as unknown as Record<
      string,
      { findMany: () => Promise<Array<Record<string, unknown>>>; count: () => Promise<number> }
    >
    for (const info of infos) {
      const delegate = delegates[info.accessor]
      if (!delegate) throw new Error(`missing prisma delegate ${info.accessor}`)
      rowsByTable.set(info.table, await delegate.findMany())
    }

    for (const info of [...infos].reverse()) {
      await withTursoRetry(() => client.execute(`DELETE FROM "${info.table}"`), `delete ${info.table}`)
    }

    for (const info of infos) {
      const rows = rowsByTable.get(info.table) ?? []
      if (rows.length === 0) continue
      const colList = info.columns.map((c) => `"${c}"`).join(', ')
      const placeholders = `(${info.columns.map(() => '?').join(', ')})`
      const statements = rows.map((row) => ({
        sql: `INSERT INTO "${info.table}" (${colList}) VALUES ${placeholders}`,
        args: info.columns.map((col) => {
          const prismaField = info.model.fields.find((f) => (f.dbName ?? f.name) === col)
          return toSqlValue(prismaField ? row[prismaField.name] : row[col])
        }),
      }))
      // r38: send INSERTs in CHUNKED batches (the whole-table single batch —
      // up to 4,660 statements for audit_logs — exceeded the Hrana pipeline
      // limit and died with HTTP 502; the daily Vercel cron would hit the
      // same wall once tables grew past the limit). 200 statements/batch
      // stays well under it; withTursoRetry absorbs transient 5xx.
      const CHUNK = 200
      for (let i = 0; i < statements.length; i += CHUNK) {
        const chunk = statements.slice(i, i + CHUNK)
        await withTursoRetry(() => client.batch(chunk, 'write'), `insert ${info.table}#${i / CHUNK}`)
      }
      report.totalRows += rows.length
    }

    // 3) verify counts
    let mismatches = 0
    for (const info of infos) {
      const delegate = delegates[info.accessor]
      const sourceRows = await delegate.count()
      const res = await withTursoRetry(() => client.execute(`SELECT COUNT(*) AS c FROM "${info.table}"`), `count ${info.table}`)
      const replicaRows = Number(res.rows[0]?.c ?? 0)
      const ok = sourceRows === replicaRows
      if (!ok) mismatches++
      report.tables.push({ table: info.table, sourceRows, replicaRows, ok })
    }
    if (mismatches > 0) throw new Error(`${mismatches} table count mismatches after sync`)

    report.ok = true
    // success audit row (visible in the admin Activity log; failures stay
    // in the scheduler logs to avoid daily noise while a token is broken)
    await logAudit({
      user: null,
      action: 'replication.tursoSync',
      entity: 'system',
      details: `Turso replica refreshed: ${report.tables.length} tables, ${report.totalRows} rows in ${report.durationMs}ms`,
    })
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e)
  }
  report.durationMs = Date.now() - started
  return report
}
