// /api/audit — paginated audit-log listing (admin + 'audit' permission).
// Query params: page (≥1, default 1), pageSize (10–200, default 50),
// action (exact match), from / to (YYYY-MM-DD or ISO — 'from' filters from
// the start of the given day, 'to' through the end of it; invalid values
// are ignored), userId (exact). Ordered newest-first.

import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { errorResponse, requireAuth } from '@/lib/auth'
import type { AuditLogEntry, AuditLogPage } from '@/lib/types'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' → local start of day; ISO strings parse as-is; null on garbage. */
function parseFromBoundary(raw: string): Date | null {
  const trimmed = raw.trim()
  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, mo, d] = trimmed.split('-').map(Number)
    return new Date(y, mo - 1, d)
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** 'YYYY-MM-DD' → local end of day (inclusive); ISO strings as-is; null on garbage. */
function parseToBoundary(raw: string): Date | null {
  const trimmed = raw.trim()
  if (DATE_ONLY_RE.test(trimmed)) {
    const [y, mo, d] = trimmed.split('-').map(Number)
    return new Date(y, mo - 1, d, 23, 59, 59, 999)
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Positive integer query param with a fallback (invalid → fallback). */
function positiveInt(raw: string | null, fallback: number): number {
  const n = Math.floor(Number(raw))
  return raw != null && raw !== '' && Number.isFinite(n) && n >= fallback ? n : fallback
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['audit'])

    const sp = new URL(req.url).searchParams
    const page = positiveInt(sp.get('page'), 1)
    const rawPageSize = Math.floor(Number(sp.get('pageSize')))
    const pageSize =
      sp.get('pageSize') != null && Number.isFinite(rawPageSize) && rawPageSize > 0
        ? Math.min(200, Math.max(10, rawPageSize))
        : 50

    // ── Filters (invalid values are ignored, never 500s) ──────────────
    const where: Prisma.AuditLogWhereInput = {}

    const action = sp.get('action')
    if (action != null && action !== '') {
      where.action = action
    }

    const createdAt: Prisma.DateTimeFilter = {}
    const fromRaw = sp.get('from')
    if (fromRaw != null && fromRaw !== '') {
      const from = parseFromBoundary(fromRaw)
      if (from) createdAt.gte = from
    }
    const toRaw = sp.get('to')
    if (toRaw != null && toRaw !== '') {
      const to = parseToBoundary(toRaw)
      if (to) createdAt.lte = to
    }
    if (createdAt.gte != null || createdAt.lte != null) {
      where.createdAt = createdAt
    }

    const userIdRaw = sp.get('userId')
    if (userIdRaw != null && userIdRaw !== '') {
      const userId = Math.floor(Number(userIdRaw))
      if (Number.isFinite(userId) && userId > 0) {
        where.userId = userId
      }
    }

    const total = await db.auditLog.count({ where })
    const rows = await db.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    })

    const logs: AuditLogEntry[] = rows.map((row) => ({
      id: row.id,
      userId: row.userId ?? null,
      userName: row.userName,
      action: row.action,
      entity: row.entity,
      entityId: row.entityId ?? null,
      details: row.details ?? null,
      createdAt: row.createdAt.toISOString(),
    }))

    const payload: AuditLogPage = { logs, total, page, pageSize }
    return NextResponse.json(payload)
  } catch (err) {
    return errorResponse(err)
  }
}
