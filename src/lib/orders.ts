// ─── Shared business logic for orders, payments & tables ────────────
// Used by the /api/orders, /api/order-items, /api/tables and
// /api/floorplans route handlers. Keep this module reusable: all
// money math, stock validation and close/cancel side effects live here.

import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, type SessionPayload } from '@/lib/auth'
import { COURSES, MONEY_EPSILON, SERVICE_TAX_RATE, TAX_RATE } from '@/lib/constants'
import type {
  FloorPlan,
  Order,
  OrderItem,
  Payment,
  RestaurantTable,
  SelectedModifier,
} from '@/lib/types'

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
  // R8-b documented exception (approved in the task brief): `allergens` is
  // added to the product sub-select so KDS/cart allergen badges can read it
  // via a local cast — the ONLY change to this constant.
  // R11: `category.prepDestination` added so KDS station routing can read it
  // (second documented exception, same pattern).
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          nameAr: true,
          allergens: true,
          category: { select: { prepDestination: true } },
        },
      },
    },
  },
  payments: true,
  table: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>

/** A plain `payment` row (no relations) as loaded from Prisma. */
export type PaymentRow = {
  id: number
  orderId: number
  method: string
  amount: number
  tip?: number | null
  reference: string | null
  createdAt: Date
}

export function serializePayment(payment: PaymentRow): Payment {
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    amount: round2(payment.amount),
    tip: round2(payment.tip ?? 0),
    reference: payment.reference,
    createdAt: payment.createdAt.toISOString(),
  }
}

export type OrderItemRow = Prisma.OrderItemGetPayload<{
  include: { product: { select: { id: true; name: true; nameAr: true } } }
}>

/** Parse the selected_modifiers JSON column into a clean list (R8). */
export function parseSelectedModifiers(raw: string | null | undefined): SelectedModifier[] | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const list: SelectedModifier[] = []
    for (const entry of parsed) {
      const m = entry as { id?: unknown; name?: unknown; nameAr?: unknown; priceDelta?: unknown }
      const id = Number(m.id)
      const priceDelta = Number(m.priceDelta)
      if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(priceDelta)) continue
      list.push({
        id,
        name: String(m.name ?? ''),
        nameAr: m.nameAr == null ? null : String(m.nameAr),
        priceDelta: round2(priceDelta),
      })
    }
    return list.length > 0 ? list : null
  } catch {
    return null
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
    selectedModifiers: parseSelectedModifiers(item.selectedModifiers),
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
    // R11: order type + delivery contact
    orderType: order.orderType,
    deliveryPhone: order.deliveryPhone,
    deliveryAddress: order.deliveryAddress,
    subtotalAmount: round2(order.subtotalAmount),
    totalAmount: total,
    discountAmount: round2(order.discountAmount),
    taxAmount: round2(order.taxAmount),
    serviceTaxAmount: round2(order.serviceTaxAmount),
    discountReason: order.discountReason,
    clientName: order.clientName,
    extraTableIds: parseExtraTableIds(order.extraTableIds),
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

// ─── Merged seating (multi-table orders) ───────────────────────────

/** Parse the JSON extraTableIds column into a clean id list. */
export function parseExtraTableIds(raw: string | null | undefined): number[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(Number)
      .filter((id) => Number.isInteger(id) && id > 0)
  } catch {
    return []
  }
}

/** All table ids bound to an order: primary tableId + extraTableIds. */
export function orderTableIds(order: { tableId: number | null; extraTableIds: string | null }): number[] {
  const ids: number[] = []
  if (order.tableId != null) ids.push(order.tableId)
  for (const id of parseExtraTableIds(order.extraTableIds)) {
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Find an OPEN order that references the table — either as its primary
 * table OR as one of its merged-seating extra tables. Used to guard
 * transfer/destination tables and table release logic.
 */
export async function findOpenOrderOnTable(
  tableId: number,
  excludeOrderId?: number,
): Promise<{ id: number } | null> {
  const candidates = await db.order.findMany({
    where: {
      status: 'open',
      OR: [{ tableId }, { extraTableIds: { not: null } }],
    },
    select: { id: true, tableId: true, extraTableIds: true },
  })
  for (const order of candidates) {
    if (excludeOrderId != null && order.id === excludeOrderId) continue
    if (orderTableIds(order).includes(tableId)) return { id: order.id }
  }
  return null
}

/**
 * Set every table of an order to a target status — each table only when
 * no OTHER open order still references it (as primary or extra table).
 * Tables that are already 'free' (cleaned) or 'dirty' (amber, bussed and
 * awaiting the cleaning click) are never re-marked by a later settlement —
 * the manual cleaning flow always moves forward.
 */
export async function setTablesStatusForOrder(
  order: { id: number; tableId: number | null; extraTableIds: string | null },
  target: 'free' | 'paid' | 'deferred' | 'occupied',
): Promise<void> {
  const tableIds = orderTableIds(order)
  for (const tableId of tableIds) {
    const otherOpen = await findOpenOrderOnTable(tableId, order.id)
    if (otherOpen) continue
    const table = await db.restaurantTable.findUnique({
      where: { id: tableId },
      select: { status: true },
    })
    if (!table) continue
    // never re-dirty a table that has already been bussed ('dirty') or
    // cleaned ('free') — later settlements keep the manual cleaning state
    if (
      (target === 'paid' || target === 'deferred') &&
      (table.status === 'free' || table.status === 'dirty')
    ) {
      continue
    }
    if (table.status === target) continue
    await db.restaurantTable.update({ where: { id: tableId }, data: { status: target } })
  }
}

/**
 * Recompute an order's money fields from its current items:
 * subtotal = Σ qty × unitPrice, discount clamped to [0, subtotal],
 * VAT = (subtotal − discount) × TAX_RATE (14%),
 * service tax = (subtotal − discount) × SERVICE_TAX_RATE (12%),
 * total = subtotal − discount + VAT + service tax.
 * Persists the result and returns the serialized order.
 */
export async function recomputeTotals(orderId: number): Promise<Order> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { items: true } })
  if (!order) throw new ApiError('Order not found', 404)
  const subtotal = round2(
    order.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  )
  const discount = Math.min(Math.max(order.discountAmount, 0), subtotal)
  const base = round2(subtotal - discount)
  const tax = round2(base * TAX_RATE)
  const serviceTax = round2(base * SERVICE_TAX_RATE)
  const total = round2(base + tax + serviceTax)
  const updated = await db.order.update({
    where: { id: orderId },
    data: {
      subtotalAmount: subtotal,
      discountAmount: round2(discount),
      taxAmount: tax,
      serviceTaxAmount: serviceTax,
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
  /** R8: option snapshots rebuilt from the DB (never trusting client data);
   *  null when the item carries no options (today's behavior). */
  selectedModifiers: SelectedModifier[] | null
  /** R8: Σ snapshot priceDelta (0 when none) — unitPrice already includes it */
  modifiersPriceDelta: number
}

/**
 * Validate an `items` array from a request body: non-empty, each product
 * must exist / be active / be sellable, quantity > 0 and course ∈ COURSES
 * (default 'main'). unitPrice = product.price.
 *
 * R8: each item may carry `selectedModifiers` [{ id }] — every id must be an
 * ACTIVE Modifier of an ACTIVE group ATTACHED to the item's product; group
 * minSelect/maxSelect are enforced per item; duplicates are rejected. The
 * snapshot (name/nameAr/priceDelta) is always rebuilt from DB rows, and
 * unitPrice = round2(product.price + Σ deltas).
 */
export async function validateOrderItems(items: unknown): Promise<ValidatedOrderItem[]> {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError('Order must contain at least one item', 400)
  }
  const raw = items as {
    productId?: unknown
    quantity?: unknown
    notes?: unknown
    course?: unknown
    selectedModifiers?: unknown
  }[]

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
    if (item?.selectedModifiers != null && !Array.isArray(item.selectedModifiers)) {
      throw new ApiError('selectedModifiers must be an array', 400)
    }
    productIds.add(productId)
  }

  const products = await db.product.findMany({
    where: { id: { in: Array.from(productIds) } },
    select: { id: true, name: true, price: true, active: true, isSellable: true },
  })
  const productById = new Map(products.map((p) => [p.id, p]))

  // ── R8 phase A: parse the requested option ids per item ────────────
  // (integer ids > 0, no duplicates within one item — snapshots come later)
  const requestedIdsPerItem: (number[] | null)[] = raw.map((item) => {
    const list = item?.selectedModifiers
    if (!Array.isArray(list) || list.length === 0) return null
    const productId = Number(item.productId)
    const productLabel = productById.get(productId)?.name ?? String(productId)
    const ids: number[] = []
    const seen = new Set<number>()
    for (const entry of list) {
      const id = Number((entry as { id?: unknown })?.id)
      if (!Number.isInteger(id) || id <= 0) {
        throw new ApiError(`Invalid option for product "${productLabel}"`, 400)
      }
      if (seen.has(id)) {
        throw new ApiError(
          `Duplicate option id ${id} for product "${productLabel}"`,
          400,
        )
      }
      seen.add(id)
      ids.push(id)
    }
    return ids
  })

  // ── R8 phase B: load every referenced modifier (with its group) and the
  // group attachments of every product — two queries for the whole payload.
  const allModifierIds = new Set<number>()
  for (const ids of requestedIdsPerItem) {
    if (ids) for (const id of ids) allModifierIds.add(id)
  }
  type ModifierRow = {
    id: number
    name: string
    nameAr: string | null
    priceDelta: number
    active: boolean
    groupId: number
    group: { id: number; name: string; active: boolean }
  }
  const [modifierRows, linkRows] = await Promise.all([
    allModifierIds.size === 0
      ? Promise.resolve<ModifierRow[]>([])
      : db.modifier.findMany({
          where: { id: { in: Array.from(allModifierIds) } },
          select: {
            id: true,
            name: true,
            nameAr: true,
            priceDelta: true,
            active: true,
            groupId: true,
            group: { select: { id: true, name: true, active: true } },
          },
        }),
    db.productModifierGroup.findMany({
      where: { productId: { in: Array.from(productIds) } },
      include: { modifierGroup: true },
    }),
  ])
  const modifierById = new Map(modifierRows.map((m) => [m.id, m]))
  // ACTIVE groups attached per product (constraints apply to these only)
  const attachedGroupsByProduct = new Map<number, typeof linkRows[number]['modifierGroup'][]>()
  for (const link of linkRows) {
    if (!link.modifierGroup.active) continue
    const list = attachedGroupsByProduct.get(link.productId) ?? []
    list.push(link.modifierGroup)
    attachedGroupsByProduct.set(link.productId, list)
  }

  return raw.map((item, index) => {
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

    // ── R8 phase C: snapshot from DB rows + group constraint checks ──
    const requestedIds = requestedIdsPerItem[index]
    const attached = attachedGroupsByProduct.get(productId) ?? []
    const attachedGroupIds = new Set(attached.map((g) => g.id))
    const selected: SelectedModifier[] = []
    const countByGroup = new Map<number, number>()
    if (requestedIds) {
      for (const id of requestedIds) {
        const mod = modifierById.get(id)
        if (
          !mod ||
          !mod.active ||
          !mod.group.active ||
          !attachedGroupIds.has(mod.groupId)
        ) {
          throw new ApiError(`Invalid option for product "${product.name}"`, 400)
        }
        countByGroup.set(mod.groupId, (countByGroup.get(mod.groupId) ?? 0) + 1)
        selected.push({
          id: mod.id,
          name: mod.name,
          nameAr: mod.nameAr,
          priceDelta: round2(mod.priceDelta),
        })
      }
    }
    for (const group of attached) {
      const count = countByGroup.get(group.id) ?? 0
      if (count < group.minSelect) {
        throw new ApiError(
          `Option group "${group.name}" for product "${product.name}" requires at least ${group.minSelect} option(s)`,
          400,
        )
      }
      if (count > group.maxSelect) {
        throw new ApiError(
          `Option group "${group.name}" for product "${product.name}" allows at most ${group.maxSelect} option(s)`,
          400,
        )
      }
    }

    const modifiersPriceDelta = round2(
      selected.reduce((sum, m) => sum + m.priceDelta, 0),
    )
    return {
      productId,
      quantity: Number(item.quantity),
      unitPrice: round2(product.price + modifiersPriceDelta),
      notes: item.notes == null ? null : String(item.notes),
      course,
      selectedModifiers: selected.length > 0 ? selected : null,
      modifiersPriceDelta,
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
 * inventory (idempotent). Works for OPEN and DEFERRED orders — a deferred
 * check is settled by recording the remaining payments. After closing,
 * the order's tables become 'paid' (bill settled, awaiting the bussing
 * click) unless they were already bussed to 'dirty' or cleaned to 'free'.
 * Returns whether this call closed the order.
 */
export async function closeOrderIfFullyPaid(orderId: number): Promise<{ closed: boolean }> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  })
  if (!order) throw new ApiError('Order not found', 404)
  if (order.status !== 'open' && order.status !== 'deferred') return { closed: false }

  const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
  if (paidAmount < order.totalAmount - MONEY_EPSILON) return { closed: false }

  await db.order.update({
    where: { id: orderId },
    data: { status: 'paid', closedAt: new Date() },
  })
  await deductInventoryForOrder(orderId)

  await setTablesStatusForOrder(order, 'paid')
  return { closed: true }
}

/**
 * Defer a check: order → status 'deferred' with the client's name. The
 * client leaves; the order's tables switch to 'deferred' (tap to bus →
 * amber 'dirty' → tap to clean → free) so the check stays outstanding
 * but the seating is vacated.
 */
export async function deferOrder(
  orderId: number,
  clientName: string,
): Promise<OrderWithRelations> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: { select: { id: true } } },
  })
  if (!order) throw new ApiError('Order not found', 404)
  if (order.status !== 'open') {
    throw new ApiError('Only open orders can be deferred', 400)
  }
  if (order.items.length === 0) {
    throw new ApiError('Cannot defer an empty order', 400)
  }
  const updated = await db.order.update({
    where: { id: orderId },
    data: { status: 'deferred', clientName },
  })
  await setTablesStatusForOrder(updated, 'deferred')
  return db.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE })
}

/** Free a table if no other open order references it (primary or extra). */
export async function freeTableIfUnused(tableId: number, excludeOrderId?: number): Promise<void> {
  const otherOpenOrder = await findOpenOrderOnTable(tableId, excludeOrderId)
  if (!otherOpenOrder) {
    await db.restaurantTable.update({ where: { id: tableId }, data: { status: 'free' } })
  }
}

/**
 * R9 vision: re-house an open order (primary + merged extras) at a single
 * destination table — the exact semantics of POST /api/orders/[id]/transfer,
 * extracted so the human-confirmed AI movement flow reuses them.
 *
 * Runs inside the caller's transaction: primary table moves, extras are
 * released, previous tables are freed when no OTHER open order still
 * references them, and the destination table is marked occupied.
 */
export async function rehouseOpenOrder(
  tx: Prisma.TransactionClient,
  order: { id: number; tableId: number | null; extraTableIds: string | null },
  targetTableId: number,
): Promise<void> {
  const previousTableIds = orderTableIds(order)
  await tx.order.update({
    where: { id: order.id },
    data: { tableId: targetTableId, extraTableIds: null },
  })
  for (const previousTableId of previousTableIds) {
    if (previousTableId === targetTableId) continue
    const stillOpen = await findOpenOrderOnTable(previousTableId, order.id)
    if (!stillOpen) {
      await tx.restaurantTable.update({
        where: { id: previousTableId },
        data: { status: 'free' },
      })
    }
  }
  await tx.restaurantTable.update({
    where: { id: targetTableId },
    data: { status: 'occupied' },
  })
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
 * Serialize tables with POS polling extras. For every table bound to an
 * OPEN order (primary OR merged-seating extra table) attach openOrderId,
 * openOrderTotal, openOrderItemCount, openOrderSince, openOrderGuests and
 * openOrderMerged, and force live status 'occupied'. Tables holding a
 * DEFERRED check (status 'deferred') additionally get deferredClientName
 * + deferredOrderId so the floor can show who owes the deferred bill.
 * Open + deferred orders are fetched in TWO queries (tables referenced
 * directly or via extraTableIds, parsed in memory).
 */
export async function serializeTablesWithOpenOrders(tables: TableRow[]): Promise<RestaurantTable[]> {
  if (tables.length === 0) return []
  const tableIds = tables.map((t) => t.id)
  const [openOrders, deferredOrders] = await Promise.all([
    db.order.findMany({
      where: {
        status: 'open',
        OR: [{ tableId: { in: tableIds } }, { extraTableIds: { not: null } }],
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        tableId: true,
        totalAmount: true,
        guests: true,
        createdAt: true,
        extraTableIds: true,
        items: { select: { id: true, quantity: true, unitPrice: true } },
      },
    }),
    db.order.findMany({
      where: {
        status: 'deferred',
        OR: [{ tableId: { in: tableIds } }, { extraTableIds: { not: null } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        tableId: true,
        clientName: true,
        extraTableIds: true,
        totalAmount: true,
        payments: { select: { amount: true } },
      },
    }),
  ])

  // table id → first open order bound to it (primary or extra table)
  const openOrderByTable = new Map<
    number,
    (typeof openOrders)[number] & { merged: boolean }
  >()
  for (const order of openOrders) {
    const ids = orderTableIds(order)
    const merged = ids.length > 1
    for (const id of ids) {
      if (!openOrderByTable.has(id)) openOrderByTable.set(id, { ...order, merged })
    }
  }

  // table id → newest deferred order bound to it (for 'deferred' tables)
  const deferredOrderByTable = new Map<
    number,
    { id: number; clientName: string | null; remaining: number }
  >()
  for (const order of deferredOrders) {
    const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
    const info = {
      id: order.id,
      clientName: order.clientName,
      remaining: round2(order.totalAmount - paidAmount),
    }
    for (const id of orderTableIds(order)) {
      if (!deferredOrderByTable.has(id)) deferredOrderByTable.set(id, info)
    }
  }

  return tables.map((table) => {
    const base = serializeTable(table)
    if (base.status === 'deferred') {
      const deferred = deferredOrderByTable.get(table.id)
      if (deferred) {
        return {
          ...base,
          deferredClientName: deferred.clientName,
          deferredOrderId: deferred.id,
        }
      }
      return base
    }
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
      openOrderMerged: open.merged,
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
