import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, getSessionUser } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req)
    if (!user) throw new ApiError('Unauthorized', 401)
    return NextResponse.json({
      user: { id: user.userId, email: user.email, name: user.name, role: user.role },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
