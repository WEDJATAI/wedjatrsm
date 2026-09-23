/**
 * R23: SQLite → Neon (PostgreSQL) data migration.
 *
 * One-time tool that copies every row from the local SQLite database
 * (db/custom.db — the sandbox / Windows-app system of record) into the
 * Neon PostgreSQL production database used by the Vercel deployment.
 *
 * Usage (from the project root):
 *   DATABASE_URL="postgresql://…@…neon.tech/neondb?sslmode=require" \
 *     bun scripts/migrate-neon.ts
 *
 * How it works:
 *   - the SQLite side uses a PrismaClient with an EXPLICIT file: datasource
 *     URL (independent of DATABASE_URL, which points at Neon for this run);
 *   - the Postgres side uses the pgtmp client generated from
 *     prisma/schema.pgtmp.prisma into ./pgtmp-client (the default
 *     @prisma/client stays SQLite-flavored — local dev is never disturbed);
 *   - models are topologically sorted by FK dependencies (parents first);
 *   - ids are preserved; sequences are reset with setval(MAX(id)+1) so the
 *     next autoincrement insert lands on the right value;
 *   - the target tables are TRUNCATEd first → the script is idempotent and
 *     can be re-run safely;
 *   - per-model row counts are verified at the end and a system.migrate
 *     audit row is appended to the TARGET database.
 */
import { join } from 'node:path'
import { PrismaClient as SqliteClient, Prisma as SqlitePrisma } from '@prisma/client'
import { PrismaClient as PgClient } from '../pgtmp-client'

const SQLITE_URL =
  process.env.RMS_SQLITE_URL ?? `file:${join(process.cwd(), 'db', 'custom.db')}`

const CHUNK = 200

type DmmfField = {
  name: string
  kind: string
  type: string
  isId: boolean
  relationFromFields?: string[]
}
type DmmfModel = {
  name: string
  dbName: string | null
  fields: DmmfField[]
}

function accessorFor(modelName: string): string {
  return modelName.charAt(0).toLowerCase() + modelName.slice(1)
}

/** Kahn topological sort by FK dependencies (referenced model first). */
function topoSort(models: DmmfModel[]): DmmfModel[] {
  const deps = new Map<string, Set<string>>()
  for (const m of models) {
    const d = new Set<string>()
    for (const f of m.fields) {
      if (f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0) {
        if (f.type !== m.name) d.add(f.type) // cross-model FK edge
      }
    }
    deps.set(m.name, d)
  }
  const order: DmmfModel[] = []
  const remaining = new Set(models.map((m) => m.name))
  for (let progress = true; remaining.size > 0 && progress; ) {
    progress = false
    for (const name of [...remaining]) {
      const d = deps.get(name) ?? new Set<string>()
      if ([...d].every((x) => !remaining.has(x))) {
        order.push(models.find((m) => m.name === name)!)
        remaining.delete(name)
        progress = true
      }
    }
  }
  if (remaining.size > 0) {
    throw new Error(`FK cycle detected between models: ${[...remaining].join(', ')}`)
  }
  return order
}

async function main(): Promise<void> {
  const pgUrl = process.env.DATABASE_URL ?? ''
  if (!pgUrl.startsWith('postgres')) {
    throw new Error('DATABASE_URL must be the Neon PostgreSQL URL for this script')
  }

  const sqlite = new SqliteClient({ datasources: { db: { url: SQLITE_URL } } })
  const pg = new PgClient()
  const started = Date.now()

  try {
    const models = SqlitePrisma.dmmf.datamodel.models as unknown as DmmfModel[]
    const ordered = topoSort(models)
    console.log(
      `[migrate-neon] ${models.length} models, topo order:\n  ${ordered
        .map((m) => m.name)
        .join(' → ')}`,
    )

    // 1) wipe target tables (reverse-independent — CASCADE handles the rest)
    const tables = models.map((m) => `"${m.dbName ?? m.name}"`).join(', ')
    await pg.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`)
    console.log('[migrate-neon] target tables truncated')

    // 2) copy rows model by model (parents first), preserving ids
    let total = 0
    for (const m of ordered) {
      const acc = accessorFor(m.name)
      const scalarFields = m.fields.filter((f) => f.kind === 'scalar').map((f) => f.name)
      const sqliteDelegate = (sqlite as unknown as Record<string, { findMany: () => Promise<Record<string, unknown>[]> }>)[acc]
      const pgDelegate = (pg as unknown as Record<string, { createMany: (args: { data: Record<string, unknown>[] }) => Promise<{ count: number }> }>)[acc]
      if (!sqliteDelegate || !pgDelegate) throw new Error(`missing delegate for model ${m.name}`)

      const rows = await sqliteDelegate.findMany()
      const data = rows.map((r) => {
        const o: Record<string, unknown> = {}
        for (const f of scalarFields) o[f] = r[f]
        return o
      })
      for (let i = 0; i < data.length; i += CHUNK) {
        await pgDelegate.createMany({ data: data.slice(i, i + CHUNK) })
      }
      total += data.length
      console.log(`[migrate-neon] ${m.name.padEnd(24)} ${String(data.length).padStart(5)} rows`)
    }

    // 3) reset autoincrement sequences to MAX(id)+1 (explicit-id inserts do
    //    not advance them; without this the next insert would collide).
    //    NOTE: physical column names — DMMF field.name is the camelCase Prisma
    //    name; the actual column is the @map value (field.dbName) when mapped.
    for (const m of ordered) {
      const idFields = m.fields.filter((f) => f.kind === 'scalar' && f.isId)
      if (idFields.length !== 1 || idFields[0].type !== 'Int') continue // composite/string keys have no sequence
      const table = m.dbName ?? m.name
      const col = idFields[0].dbName ?? idFields[0].name
      // Not every Int @id is autoincrement (e.g. VisionTableState uses a
      // manually-set id with NO sequence) — only reset real sequences.
      const seqRows = await pg.$queryRawUnsafe<Array<{ seq: string | null }>>(
        `SELECT pg_get_serial_sequence('"${table}"', '${col}') AS seq`,
      )
      const seq = seqRows[0]?.seq
      if (!seq) continue
      await pg.$executeRawUnsafe(
        `SELECT setval('${seq}', COALESCE((SELECT MAX("${col}") FROM "${table}"), 0) + 1, false)`,
      )
    }
    console.log('[migrate-neon] sequences reset')

    // 4) verify counts
    let mismatch = 0
    for (const m of ordered) {
      const acc = accessorFor(m.name)
      const s = (sqlite as unknown as Record<string, { count: () => Promise<number> }>)[acc]
      const p = (pg as unknown as Record<string, { count: () => Promise<number> }>)[acc]
      const [a, b] = [await s.count(), await p.count()]
      if (a !== b) {
        mismatch++
        console.error(`[migrate-neon] COUNT MISMATCH ${m.name}: sqlite=${a} pg=${b}`)
      }
    }
    if (mismatch > 0) throw new Error(`${mismatch} model count mismatches — see above`)

    // 5) audit row in the TARGET db (also proves sequences are healthy)
    await pg.auditLog.create({
      data: {
        userId: 1,
        userName: 'Amina Hassan',
        action: 'system.migrate',
        entity: 'system',
        entityId: 0,
        details: `SQLite → Neon migration complete: ${total} rows across ${models.length} models (source ${SQLITE_URL}) in ${Date.now() - started}ms`,
      },
    })

    console.log(
      `[migrate-neon] DONE — ${total} rows, ${models.length} models, counts verified, ${Date.now() - started}ms`,
    )
  } finally {
    await sqlite.$disconnect()
    await pg.$disconnect()
  }
}

main().catch((e) => {
  console.error('[migrate-neon] FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
