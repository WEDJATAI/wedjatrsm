import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req, ['admin', 'recipes'])

    const { id } = await ctx.params // Next.js 16: dynamic route params are a Promise
    const componentId = Number(id)
    if (!Number.isInteger(componentId) || componentId < 1) {
      throw new ApiError('Invalid recipe component id', 400)
    }

    const existing = await db.recipeComponent.findUnique({ where: { id: componentId } })
    if (!existing) {
      throw new ApiError('Recipe component not found', 404)
    }

    // R38 hybrid sync: the pre-delete snapshot rides the outbox atomically
    // with the delete (read first, then delete, then emit) — this is the
    // only RecipeComponent delete path, so remote devices learn the
    // component is gone instead of re-deriving it forever.
    await db.$transaction(async (tx) => {
      const row = await tx.recipeComponent.findUnique({ where: { id: componentId } })
      await tx.recipeComponent.delete({ where: { id: componentId } })
      if (row) {
        await emitOutboxEvent(tx, {
          entity: 'RecipeComponent',
          entityId: row.id,
          operation: 'delete',
          row,
        })
      }
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
