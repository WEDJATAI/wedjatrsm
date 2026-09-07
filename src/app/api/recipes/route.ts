import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import type { Product, RecipeComponent } from '@/lib/types'

type DbProduct = {
  id: number
  name: string
  categoryId: number | null
  category?: { id: number; name: string } | null
  price: number
  cost: number
  isStockable: boolean
  isSellable: boolean
  sku: string | null
  imageUrl: string | null
  active: boolean
  lowStockThreshold: number
  stock: number
  createdAt: Date
}

/** Serialize a product row (with optional category) for the API. */
function serializeProduct(p: DbProduct): Product & { createdAt: string } {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    price: p.price,
    cost: p.cost,
    isStockable: p.isStockable,
    isSellable: p.isSellable,
    sku: p.sku,
    imageUrl: p.imageUrl,
    active: p.active,
    lowStockThreshold: p.lowStockThreshold,
    stock: p.stock,
    createdAt: p.createdAt.toISOString(),
  }
}

function serializeComponent(c: {
  id: number
  productId: number
  ingredientId: number
  quantity: number
  ingredient: DbProduct
}): RecipeComponent & { ingredient: Product & { createdAt: string } } {
  return {
    id: c.id,
    productId: c.productId,
    ingredientId: c.ingredientId,
    quantity: c.quantity,
    ingredient: serializeProduct(c.ingredient),
  }
}

const ingredientInclude = {
  ingredient: { include: { category: { select: { id: true, name: true } } } },
} as const

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'recipes'])

    const raw = new URL(req.url).searchParams.get('productId')
    if (!raw) {
      throw new ApiError('productId query parameter is required', 400)
    }
    const productId = Number(raw)
    if (!Number.isInteger(productId)) {
      throw new ApiError('productId must be an integer', 400)
    }

    const components = await db.recipeComponent.findMany({
      where: { productId },
      include: ingredientInclude,
      orderBy: { ingredient: { name: 'asc' } },
    })

    return NextResponse.json({ components: components.map(serializeComponent) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'recipes'])

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>

    const productId = Number(data.productId)
    const ingredientId = Number(data.ingredientId)
    if (!Number.isInteger(productId)) {
      throw new ApiError('productId must be an integer', 400)
    }
    if (!Number.isInteger(ingredientId)) {
      throw new ApiError('ingredientId must be an integer', 400)
    }

    const quantity = Number(data.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ApiError('quantity must be a number greater than zero', 400)
    }

    if (productId === ingredientId) {
      throw new ApiError('A dish cannot use itself as an ingredient', 400)
    }

    const dish = await db.product.findFirst({ where: { id: productId, isSellable: true } })
    if (!dish) {
      throw new ApiError('Selected dish is not a sellable product', 400)
    }

    const ingredient = await db.product.findFirst({ where: { id: ingredientId, isStockable: true } })
    if (!ingredient) {
      throw new ApiError('Selected ingredient is not stockable', 400)
    }

    const component = await db.recipeComponent.upsert({
      where: { productId_ingredientId: { productId, ingredientId } },
      update: { quantity },
      create: { productId, ingredientId, quantity },
      include: ingredientInclude,
    })

    return NextResponse.json({ component: serializeComponent(component) })
  } catch (err) {
    return errorResponse(err)
  }
}
