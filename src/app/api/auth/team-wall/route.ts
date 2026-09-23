import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse } from '@/lib/auth'
import { resolveRoleLabel } from '@/lib/attendance'

// ─── R24 Team Wall — public roster for the photo-wall sign-in ────────
// GET /api/auth/team-wall
// Lists ACTIVE users that have a PIN (they can self-serve on the wall).
// Exposes only what a staff board by the door would show: name, role,
// and live on-shift status. NEVER emails, password hashes or PINs.
// Public by design: the wall is a kiosk screen; PIN verification (and its
// rate limiting) happens on POST /api/attendance/wall.

export type WallUser = {
  id: number
  name: string
  role: string
  roleLabel: string
  roleName: string | null
  /** true when the role has screens in the app (POS/KDS/admin) → “MY SCREEN” */
  canUseApp: boolean
  /** live: an open attendance record exists right now */
  onShift: boolean
  /** when the current shift started (ISO) — powers the ticking timer */
  checkedInAt: string | null
}

// Wall order: floor staff first, managers last (waiter → kitchen → custom → admin).
const ROLE_ORDER: Record<string, number> = { waiter: 0, kitchen: 1, custom: 2, admin: 3 }

export async function GET() {
  try {
    const [users, openRecords] = await Promise.all([
      db.user.findMany({
        where: { active: true, pin: { not: null } },
        select: {
          id: true,
          name: true,
          role: true,
          roleId: true,
          roleRecord: { select: { name: true, permissions: true, active: true } },
        },
        orderBy: { name: 'asc' },
      }),
      db.attendance.findMany({
        where: { checkOutAt: null },
        select: { userId: true, checkInAt: true },
        orderBy: { checkInAt: 'desc' },
      }),
    ])

    // latest open record per user (a user should never have two, but be safe)
    const openByUser = new Map<number, Date>()
    for (const rec of openRecords) {
      if (!openByUser.has(rec.userId)) openByUser.set(rec.userId, rec.checkInAt)
    }

    const team: WallUser[] = users.map((u) => {
      const { roleName, roleLabel } = resolveRoleLabel(u)
      const checkedInAt = openByUser.get(u.id) ?? null
      const canUseApp =
        u.role === 'admin' ||
        u.role === 'waiter' ||
        u.role === 'kitchen' ||
        (u.role === 'custom' &&
          (u.roleRecord?.permissions ?? '')
            .split(',')
            .map((p) => p.trim())
            .some((p) => p.length > 0))
      return {
        id: u.id,
        name: u.name,
        role: u.role,
        roleLabel,
        roleName,
        canUseApp,
        onShift: checkedInAt !== null,
        checkedInAt: checkedInAt ? checkedInAt.toISOString() : null,
      }
    })

    team.sort((a, b) => {
      const ra = ROLE_ORDER[a.role] ?? 9
      const rb = ROLE_ORDER[b.role] ?? 9
      if (ra !== rb) return ra - rb
      return a.name.localeCompare(b.name)
    })

    return NextResponse.json({ team, onShiftCount: team.filter((t) => t.onShift).length })
  } catch (err) {
    return errorResponse(err)
  }
}
