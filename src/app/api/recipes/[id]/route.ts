import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req, ['admin'])

    const { id } = await ctx.params // Next.js 16: dynamic route params are a Promise
    const componentId = Number(id)
    if (!Number.isInteger(componentId) || componentId < 1) {
      throw new ApiError('Invalid recipe component id', 400)
    }

    const existing = await db.recipeComponent.findUnique({ where: { id: componentId } })
    if (!existing) {
      throw new ApiError('Recipe component not found', 404)
    }

    await db.recipeComponent.delete({ where: { id: componentId } })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
