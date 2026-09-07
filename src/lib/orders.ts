// ─── Shared business logic for orders, payments & tables ────────────
// Used by the /api/orders, /api/order-items, /api/tables and
// /api/floorplans route handlers. Keep this module reusable: all
// money math, stock validation and close/cancel side effects live here.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, type SessionPayload } from '@/lib/auth'
import { COURSES, MONEY_EPSILON, TAX_RATE } from '@/lib/constants'
import type { FloorPlan, Order, OrderItem, Payment, RestaurantTable } from '@/lib/types'

/** Round a number to 2 decimal places (money persistence boundary). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Parse a numeric route param, throwing a 400 ApiError when invalid. */
export function parseId(value: string, label = 'id'): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(`Invalid ${label}`, 400)
  }
  return id
}

/**
 * Resolve the numeric user id from a session payload. NOTE: auth.getSessionUser
 * currently returns the DB user row ({ id, ... }) while the declared
 * SessionPayload shape uses `userId` — support both spellings so orders are
 * always attributed to the logged-in user.
 */
export function sessionUserId(session: SessionPayload): number {
  const alt = session as unknown as { userId?: number; id?: number }
  const id = alt.userId ?? alt.id
  if (id == null || !Number.isFinite(id)) {
    throw new ApiError('Unauthorized', 401)
  }
  return id
}

// ─── Orders ─────────────────────────────────────────────────────────

export const ORDER_INCLUDE = {
  items: { include: { product: { select: { id: true, name: true, nameAr: true } } } },
  payments: true,
  table: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>

export type OrderItemRow = Prisma.OrderItemGetPayload<{
  include: { product: { select: { id: true; name: true; nameAr: true } } }
}>

/** A plain `payment` row (no relations) as loaded from Prisma. */
export type PaymentRow = {
  id: number
  orderId: number
  method: string
  amount: number
  reference: string | null
  createdAt: Date
}

export function serializePayment(payment: PaymentRow): Payment {
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    amount: round2(payment.amount),
    reference: payment.reference,
    createdAt: payment.createdAt.toISOString(),
  }
}

export function serializeOrderItem(item: OrderItemRow): OrderItem {
  return {
    id: item.id,
    orderId: item.orderId,
    productId: item.productId,
    product: item.product,
    quantity: item.quantity,
    unitPrice: round2(item.unitPrice),
    notes: item.notes,
    course: item.course,
    status: item.status,
    createdAt: item.createdAt.toISOString(),
  }
}

/** Map a loaded order (with ORDER_INCLUDE relations) to the API `Order` payload. */
export function serializeOrder(order: OrderWithRelations): Order {
  const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
  const total = round2(order.totalAmount)
  return {
    id: order.id,
    tableId: order.tableId,
    table: order.table,
    userId: order.userId,
    user: order.user,
    status: order.status,
    subtotalAmount: round2(order.subtotalAmount),
    totalAmount: total,
    discountAmount: round2(order.discountAmount),
    taxAmount: round2(order.taxAmount),
    paidAmount: round2(paidAmount),
    remainingAmount: round2(total - paidAmount),
    guests: order.guests,
    createdAt: order.createdAt.toISOString(),
    closedAt: order.closedAt ? order.closedAt.toISOString() : null,
    items: order.items.map(serializeOrderItem),
    payments: order.payments.map(serializePayment),
  }
}

/** Load an order with all relations or throw 404. */
export async function getOrderOr404(orderId: number): Promise<OrderWithRelations> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
  if (!order) throw new ApiError('Order not found', 404)
  return order
}

/**
 * Recompute an order's money fields from its current items:
 * subtotal = Σ qty × unitPrice, discount clamped to [0, subtotal],
 * tax = (subtotal − discount) × TAX_RATE, total = subtotal − discount + tax.
 * Persists the result and returns the serialized order.
 */
export async function recomputeTotals(orderId: number): Promise<Order> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { items: true } })
  if (!order) throw new ApiError('Order not found', 404)
  const subtotal = round2(
    order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  )
  const discount = Math.min(Math.max(order.discountAmount, 0), subtotal)
  const tax = round2((subtotal - discount) * TAX_RATE)
  const total = round2(subtotal - discount + tax)
  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      subtotalAmount: subtotal,
      discountAmount: round2(discount),
      taxAmount: tax,
      totalAmount: total,
    },
    include: ORDER_INCLUDE,
  })
  return serializeOrder(updated)
}

// ─── Item payload validation (POST /api/orders + PUT addItems) ──────

export type ValidatedOrderItem = {
  productId: number
  quantity: number
  unitPrice: number
  notes: string | null
  course: string
}

/**
 * Validate an `items` array from a request body: non-empty, each product
 * must exist / be active / be sellable, quantity > 0 and course ∈ COURSES
 * (default 'main'). Returns normalized rows with unitPrice = product.price.
 */
export async function validateOrderItems(items: unknown): Promise<ValidatedOrderItem[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('Order must contain at least one item', 400)
  }
  const raw = items as { productId?: unknown; quantity?: unknown; notes?: unknown; course?: unknown }[]

  const productIds = new Set<number>()
  for (const item of raw) {
    const productId = Number(item?.productId)
    const quantity = Number(item?.quantity)
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new ApiError('Invalid productId in order items', 400)
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ApiError(`Invalid quantity for product ${productId}`, 400)
    }
    productIds.add(productId)
  }

  const products = await db.product.findMany({
    where: { id: { in: Array.from(productIds) } },
    select: { id: true, name: true, price: true, active: true, isSellable: true },
  })
  const productById = new Map(products.map((p) => [p.id, p]))

  return raw.map((item) => {
    const productId = Number(item.productId)
    const product = productById.get(productId)
    if (!product) throw new ApiError(`Product ${productId} not found`, 400)
    if (!product.active || !product.isSellable) {
      throw new ApiError(`Product "${product.name}" is not available`, 400)
    }
    const course = item.course == null ? 'main' : String(item.course)
    if (!(COURSES as readonly string[]).includes(course)) {
      throw new ApiError(`Invalid course "${course}"`, 400)
    }
    return {
      productId,
      quantity: Number(item.quantity),
      unitPrice: product.price,
      notes: item.notes == null ? null : String(item.notes),
      course,
    }
  })
}

// ─── Stock availability ─────────────────────────────────────────────

/**
 * Verify that adding `newItems` to an order keeps enough stock.
 * Quantities of the SAME products already on the existing open order are
 * subtracted (they were validated when added and are deducted only once).
 * Checks both direct stockable product stock and, via the recipe (BOM),
 * each ingredient's aggregated requirement.
 */
export async function checkStockAvailability(
  newItems: { productId: number; quantity: number }[],
  existingOrderId?: number,
): Promise<void> {
  // Net additional quantity per product
  const needs = new Map<number, number>()
  for (const item of newItems) {
    const quantity = Number(item.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    needs.set(item.productId, (needs.get(item.productId) ?? 0) + quantity)
  }
  if (needs.size === 0) return

  if (existingOrderId != null) {
    const existing = await db.orderItem.findMany({
      where: { orderId: existingOrderId, productId: { in: Array.from(needs.keys()) } },
      select: { productId: true, quantity: true },
    })
    for (const row of existing) {
      if (row.productId == null) continue
      needs.set(row.productId, (needs.get(row.productId) ?? 0) - row.quantity)
    }
  }

  const requiredProductIds = Array.from(needs.entries())
    .filter(([, need]) => need > 0)
    .map(([id]) => id)
  if (requiredProductIds.length === 0) return

  const products = await db.product.findMany({
    where: { id: { in: requiredProductIds } },
    include: { recipeFor: { include: { ingredient: true } } },
  })

  // Aggregated ingredient requirements across all dishes
  const ingredientNeeds = new Map<number, { name: string; stock: number; need: number }>()

  for (const product of products) {
    const need = needs.get(product.id) ?? 0
    if (product.isStockable) {
      if (product.stock + MONEY_EPSILON < need) {
        throw new ApiError(
          `Insufficient stock for "${product.name}" (available ${round2(product.stock)}, needed ${round2(need)})`,
          400,
        )
      }
    }
    for (const component of product.recipeFor) {
      const ingredientNeed = component.quantity * need
      const previous = ingredientNeeds.get(component.ingredientId)
      ingredientNeeds.set(component.ingredientId, {
        name: component.ingredient.name,
        stock: component.ingredient.stock,
        need: (previous?.need ?? 0) + ingredientNeed,
      })
    }
  }

  for (const info of ingredientNeeds.values()) {
    if (info.stock + MONEY_EPSILON < info.need) {
      throw new ApiError(
        `Insufficient stock for "${info.name}" (available ${round2(info.stock)}, needed ${round2(info.need)})`,
        400,
      )
    }
  }
}

// ─── Inventory deduction on close ───────────────────────────────────

/**
 * Deduct inventory for a paid order — IDEMPOTENT: skipped when any
 * InventoryTransaction with reason 'sale' already exists for the order.
 * Deducts stockable product stock directly and each recipe ingredient
 * (component.quantity × item.quantity), writing 'sale' transactions.
 */
export async function deductInventoryForOrder(orderId: number): Promise<void> {
  const existing = await db.inventoryTransaction.findFirst({
    where: { orderId, reason: 'sale' },
    select: { id: true },
  })
  if (existing) return

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: {
        include: { product: { include: { recipeFor: { include: { ingredient: true } } } } },
      },
    },
  })
  if (!order) return

  await db.$transaction(async (tx) => {
    for (const item of order.items) {
      const product = item.product
      if (!product) continue

      if (product.isStockable) {
        await tx.product.update({
          where: { id: product.id },
          data: { stock: { decrement: item.quantity } },
        })
        await tx.inventoryTransaction.create({
          data: {
            productId: product.id,
            quantityChange: -item.quantity,
            reason: 'sale',
            orderId,
          },
        })
      }

      for (const component of product.recipeFor) {
        const quantity = component.quantity * item.quantity
        if (quantity === 0) continue
        await tx.product.update({
          where: { id: component.ingredientId },
          data: { stock: { decrement: quantity } },
        })
        await tx.inventoryTransaction.create({
          data: {
            productId: component.ingredientId,
            quantityChange: -quantity,
            reason: 'sale',
            orderId,
          },
        })
      }
    }
  })
}

// ─── Close / table release ──────────────────────────────────────────

/**
 * Auto-close an order when fully paid: status 'paid' + closedAt, deduct
 * inventory (idempotent) and free its table when no other open order
 * references it. Returns whether this call closed the order.
 */
export async function closeOrderIfFullyPaid(orderId: number): Promise<{ closed: boolean }> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  })
  if (!order) throw new ApiError('Order not found', 404)
  if (order.status !== 'open') return { closed: false }

  const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
  if (paidAmount < order.totalAmount - MONEY_EPSILON) return { closed: false }

  await db.order.update({
    where: { id: orderId },
    data: { status: 'paid', closedAt: new Date() },
  })
  await deductInventoryForOrder(orderId)

  if (order.tableId != null) {
    const otherOpenOrder = await db.order.findFirst({
      where: { tableId: order.tableId, status: 'open', id: { not: orderId } },
      select: { id: true },
    })
    if (!otherOpenOrder) {
      await db.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'free' },
      })
    }
  }
  return { closed: true }
}

/** Free a table if no other open order references it (used on cancel). */
export async function freeTableIfUnused(tableId: number, excludeOrderId?: number): Promise<void> {
  const otherOpenOrder = await db.order.findFirst({
    where: { tableId, status: 'open', id: { not: excludeOrderId ?? -1 } },
    select: { id: true },
  })
  if (!otherOpenOrder) {
    await db.restaurantTable.update({ where: { id: tableId }, data: { status: 'free' } })
  }
}

// ─── Tables & floor plans (polling extras) ──────────────────────────

export type TableRow = {
  id: number
  floorPlanId: number | null
  name: string
  capacity: number
  shape: string
  positionX: number
  positionY: number
  status: string
  active: boolean
}

export function serializeTable(table: TableRow): RestaurantTable {
  return {
    id: table.id,
    floorPlanId: table.floorPlanId,
    name: table.name,
    capacity: table.capacity,
    shape: table.shape,
    positionX: table.positionX,
    positionY: table.positionY,
    status: table.status,
    active: table.active,
  }
}

/**
 * Serialize tables with POS polling extras: for each table with an open
 * order attach openOrderId, openOrderTotal, openOrderItemCount and
 * openOrderSince, and force live status 'occupied'. Only ONE query for
 * all open orders is issued.
 */
export async function serializeTablesWithOpenOrders(tables: TableRow[]): Promise<RestaurantTable[]> {
  if (tables.length === 0) return []
  const openOrders = await db.order.findMany({
    where: { status: 'open', tableId: { in: tables.map((t) => t.id) } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      tableId: true,
      totalAmount: true,
      guests: true,
      createdAt: true,
      items: { select: { id: true, quantity: true, unitPrice: true } },
    },
  })

  const openOrderByTable = new Map<number, (typeof openOrders)[number]>()
  for (const order of openOrders) {
    if (order.tableId == null) continue
    if (!openOrderByTable.has(order.tableId)) openOrderByTable.set(order.tableId, order)
  }

  return tables.map((table) => {
    const base = serializeTable(table)
    const open = openOrderByTable.get(table.id)
    if (!open) return base
    const itemCount = open.items.reduce((sum, item) => sum + item.quantity, 0)
    return {
      ...base,
      status: 'occupied',
      openOrderId: open.id,
      openOrderTotal: round2(open.totalAmount),
      openOrderItemCount: round2(itemCount),
      openOrderSince: open.createdAt.toISOString(),
      openOrderGuests: open.guests,
    }
  })
}

export type FloorPlanRow = Prisma.FloorPlanGetPayload<{ include: { tables: true } }>

/**
 * Serialize floor plans (with already-filtered table rows) attaching the
 * same open-order polling extras as /api/tables/status.
 */
export async function serializeFloorPlans(plans: FloorPlanRow[]): Promise<FloorPlan[]> {
  if (plans.length === 0) return []
  const tablesWithExtras = await serializeTablesWithOpenOrders(plans.flatMap((p) => p.tables))
  const extrasById = new Map(tablesWithExtras.map((t) => [t.id, t]))
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    backgroundImage: plan.backgroundImage,
    active: plan.active,
    tables: plan.tables
      .map((table) => extrasById.get(table.id))
      .filter((table): table is RestaurantTable => table != null),
  }))
}
