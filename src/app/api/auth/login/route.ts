import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  createSessionToken,
  errorResponse,
  setSessionCookie,
  verifyPassword,
} from '@/lib/auth'

type LoginUser = {
  id: number
  email: string
  name: string
  role: string
  passwordHash: string
  active: boolean
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // missing/invalid JSON body → handled by the 400 below
    }

    const rawPin: unknown = body.pin
    const pin =
      rawPin === null || rawPin === undefined ? '' : String(rawPin).trim()
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!pin && (!email || !password)) {
      return NextResponse.json(
        { error: 'Email and password or PIN required' },
        { status: 400 },
      )
    }

    let user: LoginUser | null = null

    if (pin) {
      // PIN quick-login: exact match on an active user
      user = await db.user.findFirst({ where: { pin, active: true } })
    } else {
      const found = await db.user.findFirst({ where: { email } })
      if (
        found &&
        found.active &&
        (await verifyPassword(password, found.passwordHash))
      ) {
        user = found
      }
    }

    if (!user) {
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    })
    const res = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    })
    setSessionCookie(res, token)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
