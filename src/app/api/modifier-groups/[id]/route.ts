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

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n)) throw new ApiError('Invalid modifier group id', 400)
  return n
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
 * - `undefined` → field absent (keep existing options untouched)
 * - `[]` → explicit empty (delete every option)
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

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth(req, ['admin'])
    const { id } = await params
    const groupId = parseIdParam(id)

    const existing = await db.modifierGroup.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, minSelect: true, maxSelect: true },
    })
    if (!existing) throw new ApiError('Modifier group not found', 404)

    const body = await readBody(req)
    const data: Prisma.ModifierGroupUpdateInput = {}

    if (body.name !== undefined) {
      data.name = parseName(body.name, 'Name')
    }
    const nameAr = parseNameAr(body.nameAr)
    if (nameAr !== undefined) data.nameAr = nameAr

    const minSelect = body.minSelect === undefined ? undefined : parseSelectCount(body.minSelect, 'Min selections', 0, 10, 0)
    const maxSelect = body.maxSelect === undefined ? undefined : parseSelectCount(body.maxSelect, 'Max selections', 1, 10, 1)
    if (minSelect !== undefined) data.minSelect = minSelect
    if (maxSelect !== undefined) data.maxSelect = maxSelect

    // cross-field validation against the FINAL values (existing ∪ updates)
    const finalMin = minSelect ?? existing.minSelect
    const finalMax = maxSelect ?? existing.maxSelect
    if (finalMin > finalMax) {
      throw new ApiError('Max selections must be ≥ min selections', 400)
    }

    if (body.sortOrder !== undefined && body.sortOrder !== null) {
      const n = Number(body.sortOrder)
      if (!Number.isInteger(n)) throw new ApiError('Order must be an integer', 400)
      data.sortOrder = clamp(n, 0, 999)
    }

    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('Active must be true or false', 400)
      }
      data.active = body.active
    }

    // optional `modifiers` array = FULL REPLACE of the group's options
    const modifiers = parseModifierList(body.modifiers)
    if (modifiers) {
      // ids must reference options of THIS group (hard-delete is safe:
      // order items store a JSON snapshot, not FKs)
      const existingIds = new Set(
        (await db.modifier.findMany({ where: { groupId }, select: { id: true } })).map((m) => m.id),
      )
      for (const m of modifiers) {
        if (m.id !== undefined && !existingIds.has(m.id)) {
          throw new ApiError(`Option #${m.id} does not belong to this group`, 400)
        }
      }
    }

    await db.$transaction(async (tx) => {
      await tx.modifierGroup.update({ where: { id: groupId }, data })
      if (modifiers) {
        const keepIds = modifiers.flatMap((m) => (m.id !== undefined ? [m.id] : []))
        await tx.modifier.deleteMany({
          where: { groupId, ...(keepIds.length > 0 ? { id: { notIn: keepIds } } : {}) },
        })
        for (const m of modifiers) {
          if (m.id !== undefined) {
            await tx.modifier.update({
              where: { id: m.id },
              data: {
                name: m.name,
                nameAr: m.nameAr,
                priceDelta: m.priceDelta,
                sortOrder: m.sortOrder,
              },
            })
          } else {
            await tx.modifier.create({
              data: {
                groupId,
                name: m.name,
                nameAr: m.nameAr,
                priceDelta: m.priceDelta,
                sortOrder: m.sortOrder,
              },
            })
          }
        }
      }
    })

    const updated = await db.modifierGroup.findUniqueOrThrow({
      where: { id: groupId },
      include: GROUP_INCLUDE,
    })

    await auditModifierGroup(
      session,
      'modifierGroup.update',
      updated.id,
      `Modifier group "${updated.name}" updated (${updated.modifiers.length} option${updated.modifiers.length === 1 ? '' : 's'})`,
    )

    return NextResponse.json({ group: serializeGroup(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth(req, ['admin'])
    const { id } = await params
    const groupId = parseIdParam(id)

    const existing = await db.modifierGroup.findUnique({
      where: { id: groupId },
      include: GROUP_INCLUDE,
    })
    if (!existing) throw new ApiError('Modifier group not found', 404)

    const soft = new URL(req.url).searchParams.get('soft') === '1'

    if (soft) {
      // soft delete — hide the group but keep options/links intact
      await db.modifierGroup.update({
        where: { id: groupId },
        data: { active: false },
      })
      await auditModifierGroup(
        session,
        'modifierGroup.update',
        existing.id,
        `Modifier group "${existing.name}" deactivated`,
      )
      return NextResponse.json({ ok: true, soft: true })
    }

    // hard delete — cascades to options + product links (order items keep
    // their JSON snapshot, so history is never affected)
    await db.modifierGroup.delete({ where: { id: groupId } })
    await auditModifierGroup(
      session,
      'modifierGroup.delete',
      existing.id,
      `Modifier group "${existing.name}" deleted (${existing.modifiers.length} option${existing.modifiers.length === 1 ? '' : 's'}, ${existing._count.products} product link${existing._count.products === 1 ? '' : 's'})`,
    )
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
