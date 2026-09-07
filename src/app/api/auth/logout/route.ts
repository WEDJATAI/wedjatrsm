import { NextResponse } from 'next/server'
import { clearSessionCookie, errorResponse } from '@/lib/auth'

export async function POST() {
  try {
    const res = NextResponse.json({ ok: true })
    clearSessionCookie(res)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
