import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth, type SessionPayload } from '@/lib/auth'
import { MAX_OPTIONS_PER_GROUP } from '@/lib/constants'

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — invalid/empty JSON is treated as an empty body
  }
  return {}
}

/** Optional Arabic name field → trimmed string | null (empty/null clears) | undefined (absent). */
function parseNameAr(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError('Arabic name must be a string', 400)
  const s = value.trim()
  return s === '' ? null : s
}

/** Required name field (trimmed, 1..60 chars). */
function parseName(value: unknown, label: string): string {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s || s.length > 60) {
    throw new ApiError(`${label} is required (1-60 characters)`, 400)
  }
  return s
}

/** Selection count (min 0..10 / max 1..10) with a default when absent. */
function parseSelectCount(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(`${label} must be an integer ${min}-${max}`, 400)
  }
  return n
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

type ParsedModifier = {
  id?: number
  name: string
  nameAr: string | null
  priceDelta: number
  sortOrder: number
}

/**
 * Full option list for a group payload.
 * - `undefined` → field absent (POST: no options; PUT: keep existing options)
 * - `[]` → explicit empty (PUT: delete every option)
 */
function parseModifierList(value: unknown): ParsedModifier[] | undefined {
  if (value === undefined) return undefined
  if (value === null) return []
  if (!Array.isArray(value)) throw new ApiError('Options must be an array', 400)
  if (value.length > MAX_OPTIONS_PER_GROUP) {
    throw new ApiError(`A group can have at most ${MAX_OPTIONS_PER_GROUP} options`, 400)
  }
  const seenIds = new Set<number>()
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ApiError('Each option must be an object', 400)
    }
    const rec = entry as Record<string, unknown>
    const name = parseName(rec.name, 'Option name')
    let priceDelta = 0
    if (rec.priceDelta !== undefined && rec.priceDelta !== null) {
      const n = Number(rec.priceDelta)
      if (!Number.isFinite(n)) {
        throw new ApiError('Option price must be a number', 400)
      }
      priceDelta = round2(n)
    }
    let sortOrder = index + 1
    if (rec.sortOrder !== undefined && rec.sortOrder !== null) {
      const n = Number(rec.sortOrder)
      if (!Number.isInteger(n) || n < 0 || n > 999) {
        throw new ApiError('Option order must be an integer 0-999', 400)
      }
      sortOrder = n
    }
    const parsed: ParsedModifier = {
      name,
      nameAr: parseNameAr(rec.nameAr) ?? null,
      priceDelta,
      sortOrder,
    }
    if (rec.id !== undefined && rec.id !== null) {
      const id = Number(rec.id)
      if (!Number.isInteger(id) || id < 1) throw new ApiError('Invalid option id', 400)
      if (seenIds.has(id)) throw new ApiError('Duplicate option id', 400)
      seenIds.add(id)
      parsed.id = id
    }
    return parsed
  })
}

// ─── Serialization (ModifierGroupDTO) ───────────────────────────────

const GROUP_INCLUDE = {
  modifiers: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
  _count: { select: { products: true } },
} satisfies Prisma.ModifierGroupInclude

type ModifierRow = {
  id: number
  name: string
  nameAr: string | null
  priceDelta: number
  active: boolean
  sortOrder: number
}

type GroupRow = {
  id: number
  name: string
  nameAr: string | null
  minSelect: number
  maxSelect: number
  active: boolean
  sortOrder: number
  modifiers: ModifierRow[]
  _count: { products: number }
}

function serializeGroup(g: GroupRow) {
  return {
    id: g.id,
    name: g.name,
    nameAr: g.nameAr,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    active: g.active,
    sortOrder: g.sortOrder,
    modifiers: g.modifiers.map((m) => ({
      id: m.id,
      name: m.name,
      nameAr: m.nameAr,
      priceDelta: round2(m.priceDelta),
      active: m.active,
      sortOrder: m.sortOrder,
    })),
    productCount: g._count.products,
  }
}

// ─── Audit ──────────────────────────────────────────────────────────
// 'modifierGroup.*' actions are not part of lib/audit's AUDIT_ACTIONS
// union (that file is owned by other agents in R8), so the rows are
// written directly — fire-and-forget, never failing the business op.

async function auditModifierGroup(
  user: SessionPayload,
  action: 'modifierGroup.create' | 'modifierGroup.update' | 'modifierGroup.delete',
  entityId: number,
  details: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: user.userId,
        userName: user.name,
        action,
        entity: 'settings',
        entityId,
        details,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record', action, err)
  }
}

// ─── Handlers ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const groups = await db.modifierGroup.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: GROUP_INCLUDE,
    })
    return NextResponse.json({ groups: groups.map((g) => serializeGroup(g)) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['admin'])
    const body = await readBody(req)

    const name = parseName(body.name, 'Name')
    const nameAr = parseNameAr(body.nameAr)
    const minSelect = parseSelectCount(body.minSelect, 'Min selections', 0, 10, 0)
    const maxSelect = parseSelectCount(body.maxSelect, 'Max selections', 1, 10, 1)
    if (minSelect > maxSelect) {
      throw new ApiError('Max selections must be ≥ min selections', 400)
    }

    // sortOrder: clamp 0..999; default = current max + 10
    let sortOrder: number
    if (body.sortOrder !== undefined && body.sortOrder !== null) {
      const n = Number(body.sortOrder)
      if (!Number.isInteger(n)) throw new ApiError('Order must be an integer', 400)
      sortOrder = clamp(n, 0, 999)
    } else {
      const agg = await db.modifierGroup.aggregate({ _max: { sortOrder: true } })
      sortOrder = clamp((agg._max.sortOrder ?? 0) + 10, 0, 999)
    }

    const modifiers = parseModifierList(body.modifiers) ?? []

    const createData: Prisma.ModifierGroupCreateInput = {
      name,
      nameAr: nameAr ?? null,
      minSelect,
      maxSelect,
      sortOrder,
    }
    if (modifiers.length > 0) {
      createData.modifiers = {
        create: modifiers.map((m) => ({
          name: m.name,
          nameAr: m.nameAr,
          priceDelta: m.priceDelta,
          sortOrder: m.sortOrder,
        })),
      }
    }

    const group = await db.modifierGroup.create({
      data: createData,
      include: GROUP_INCLUDE,
    })

    await auditModifierGroup(
      session,
      'modifierGroup.create',
      group.id,
      `Modifier group "${group.name}" created (${group.modifiers.length} option${group.modifiers.length === 1 ? '' : 's'})`,
    )

    return NextResponse.json({ group: serializeGroup(group) })
  } catch (err) {
    return errorResponse(err)
  }
}
