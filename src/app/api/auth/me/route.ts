import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, getSessionUser, loadSessionUser } from '@/lib/auth'
// R21: in-app auto-snapshot watcher (side-effect import — do not remove).
// This route is hit on every app boot/page load, guaranteeing the watcher lives
// even in a server instance that started before instrumentation.ts existed.
import '@/lib/snapshot-watch-init'

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req)
    if (!user) throw new ApiError('Unauthorized', 401)
    // R19: active people under the account (for the navbar person switcher)
    const row = await loadSessionUser(user.userId)
    return NextResponse.json({
      user: {
        id: user.userId,
        email: user.email,
        name: user.name,
        role: user.role,
        permissions: user.permissions,
        roleName: user.roleName,
        personId: user.personId,
        personName: user.personName,
      },
      people: row?.people ?? [],
    })
  } catch (err) {
    return errorResponse(err)
  }
}
