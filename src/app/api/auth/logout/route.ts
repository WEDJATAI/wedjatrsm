import { NextRequest, NextResponse } from 'next/server'
import { clearSessionCookie, errorResponse } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const res = NextResponse.json({ ok: true })
    clearSessionCookie(res, req)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
