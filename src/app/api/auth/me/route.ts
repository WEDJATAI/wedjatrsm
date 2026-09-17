import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, getSessionUser, loadSessionUser } from '@/lib/auth'

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
