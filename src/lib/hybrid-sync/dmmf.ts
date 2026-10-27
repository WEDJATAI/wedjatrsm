/**
 * R30 hybrid sync — Prisma DMMF utilities.
 *
 * The engine addresses business tables DYNAMICALLY (a wire event carries the
 * entity name), so model shape + delegate accessors are resolved through the
 * Prisma DMMF exactly like the Turso replicator does (src/lib/turso-sync.ts).
 * Field-type coercion turns a wire payload (JSON, ISO date strings) back into
 * Prisma-ready data — unknown keys are ignored, so a peer running a newer
 * schema never breaks an older one.
 */
import { Prisma } from '@prisma/client'

type DmmfField = {
  name: string
  kind: string
  type: string
  isId?: boolean // r49: absent from Prisma 7's reconstructed DMMF — kept optional for v6 compat
  dbName: string | null
}

export type HybridModelInfo = {
  /** Prisma model name — the canonical hybrid entity name */
  name: string
  /** physical table name (@map) */
  table: string
  /** db client accessor (lowercase-first model name) */
  accessor: string
  fields: DmmfField[]
  hasUpdatedAt: boolean
}

function buildModelMap(): Map<string, HybridModelInfo> {
  const map = new Map<string, HybridModelInfo>()
  const models = Prisma.dmmf.datamodel.models as unknown as Array<{
    name: string
    dbName: string | null
    fields: DmmfField[]
  }>
  for (const model of models) {
    map.set(model.name, {
      name: model.name,
      table: model.dbName ?? model.name,
      accessor: model.name.charAt(0).toLowerCase() + model.name.slice(1),
      fields: model.fields,
      hasUpdatedAt: model.fields.some((f) => f.name === 'updatedAt' && f.kind === 'scalar'),
    })
  }
  return map
}

let cachedModels: Map<string, HybridModelInfo> | null = null

/** Model info by Prisma model name (the hybrid entity name). */
export function hybridModelFor(entity: string): HybridModelInfo | null {
  if (!cachedModels) cachedModels = buildModelMap()
  return cachedModels.get(entity) ?? null
}

/**
 * Coerce a wire payload into Prisma-ready data for the model:
 *  - DateTime fields ← ISO strings (invalid dates throw — bad data fails the
 *    event instead of silently corrupting a row)
 *  - Int/Float/Boolean fields ← strict numeric/boolean coercion
 *  - Json fields ← passthrough; String fields ← String(value)
 *  - keys that are not scalar fields of the model are IGNORED
 */
export function coercePayload(
  model: HybridModelInfo,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const field of model.fields) {
    if (field.kind !== 'scalar') continue
    if (!(field.name in payload)) continue
    const raw = payload[field.name]
    if (raw === undefined) continue
    data[field.name] = coerceValue(field.name, field.type, raw)
  }
  return data
}

function coerceValue(fieldName: string, type: string, raw: unknown): unknown {
  if (raw === null) return null
  switch (type) {
    case 'DateTime': {
      const d = new Date(String(raw))
      if (Number.isNaN(d.getTime())) throw new Error(`invalid date for ${fieldName}`)
      return d
    }
    case 'Int': {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`invalid int for ${fieldName}`)
      return Math.trunc(n)
    }
    case 'Float': {
      const n = Number(raw)
      if (!Number.isFinite(n)) throw new Error(`invalid float for ${fieldName}`)
      return n
    }
    case 'Boolean': {
      if (typeof raw === 'boolean') return raw
      if (raw === 'true' || raw === 1) return true
      if (raw === 'false' || raw === 0) return false
      throw new Error(`invalid boolean for ${fieldName}`)
    }
    case 'Json':
      return raw
    default:
      return String(raw)
  }
}
