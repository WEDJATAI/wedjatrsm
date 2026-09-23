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
import { TURSO_DDL } from '@/lib/turso-schema'

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
  isId: boolean
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

/** Models topologically sorted by FK dependencies (parents first). */
function orderedModels(): ModelInfo[] {
  const models = Prisma.dmmf.datamodel.models as unknown as DmmfModel[]
  const deps = new Map<string, Set<string>>()
  for (const m of models) {
    const d = new Set<string>()
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0 && f.type !== m.name) {
        d.add(f.type)
      }
    }
    deps.set(m.name, d)
  }
  const ordered: DmmfModel[] = []
  const remaining = new Set(models.map((m) => m.name))
  for (let progress = true; remaining.size > 0 && progress; ) {
    progress = false
    for (const name of [...remaining]) {
      const d = deps.get(name) ?? new Set<string>()
      if ([...d].every((x) => !remaining.has(x))) {
        ordered.push(models.find((m) => m.name === name)!)
        remaining.delete(name)
        progress = true
      }
    }
  }
  if (remaining.size > 0) {
    throw new Error(`FK cycle between models: ${[...remaining].join(', ')}`)
  }
  return ordered.map((model) => ({
    model,
    table: model.dbName ?? model.name,
    accessor: accessorFor(model.name),
    columns: model.fields
      .filter((f) => f.kind === 'scalar')
      .map((f) => f.dbName ?? f.name),
  }))
}

/** libsql value conversion — Dates become ISO strings (sortable, unambiguous). */
function toSqlValue(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
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
      await client.execute(ddl)
    }

    // 2) per table: transactional DELETE + INSERT batch, parents first
    const infos = orderedModels()
    for (const info of infos) {
      const delegate = (db as Record<string, { findMany: () => Promise<Array<Record<string, unknown>>>; count: () => Promise<number> }>)[info.accessor]
      if (!delegate) throw new Error(`missing prisma delegate ${info.accessor}`)
      const rows = await delegate.findMany()

      const statements: Array<{ sql: string; args: Array<string | number | boolean | null> }> = [
        { sql: `DELETE FROM "${info.table}"`, args: [] },
      ]
      if (rows.length > 0) {
        const colList = info.columns.map((c) => `"${c}"`).join(', ')
        const placeholders = `(${info.columns.map(() => '?').join(', ')})`
        for (const row of rows) {
          const args = info.columns.map((col) => {
            const prismaField = info.model.fields.find((f) => (f.dbName ?? f.name) === col)
            return toSqlValue(prismaField ? row[prismaField.name] : row[col])
          })
          statements.push({ sql: `INSERT INTO "${info.table}" (${colList}) VALUES ${placeholders}`, args })
        }
      }
      await client.batch(statements, 'write')
      report.totalRows += rows.length
    }

    // 3) verify counts
    let mismatches = 0
    for (const info of infos) {
      const delegate = (db as Record<string, { findMany: () => Promise<Array<Record<string, unknown>>>; count: () => Promise<number> }>)[info.accessor]
      const sourceRows = await delegate.count()
      const res = await client.execute(`SELECT COUNT(*) AS c FROM "${info.table}"`)
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
