/**
 * R30 hybrid sync — the canonical entity registry + per-entity conflict policy.
 *
 * Entity names ALIGN with the legacy rsm-sync/1 18-table registry in
 * src/lib/sync.ts (Prisma model names: Customer, Order, OrderItem, Payment,
 * Attendance, CashDrawerEntry, InventoryTransaction, Reservation, AuditLog,
 * Supplier, PurchaseOrder, PurchaseOrderItem, StockCount, StockCountLine,
 * WasteLog, Promotion, Person, CustomRole), extended with the reference/config
 * entities the hybrid engine CAN carry (Product, Category, modifiers, recipes,
 * tables, floors, drawer sessions) so a new device can be provisioned via
 * /api/hybrid/bootstrap.
 *
 * User is deliberately EXCLUDED — the legacy sync excludes it too (catalog/
 * reference data ships with the Windows package), and it is the most sensitive
 * row in the database (passwordHash + PIN must never ride a hybrid event).
 *
 * Policies (what happens when a remote event arrives for a local row):
 *  - append-only        financial/audit rows: inserts only. A remote
 *                       update/delete is NEVER applied — it is recorded as a
 *                       HybridConflict (resolution 'rejected') and acked, so
 *                       financial/audit history can never be silently
 *                       rewritten from another device.
 *  - origin-authority   Order + OrderItem: while the parent order is
 *                       open/deferred, the device that CREATED it
 *                       (Order.originDeviceId) keeps edit authority; other
 *                       devices' events are recorded as conflicts and skipped.
 *                       After close (or when no origin is stamped), falls
 *                       through to revision-aware.
 *  - cloud-authoritative reference/config: the cloud (master menu) wins; a
 *                       local un-acked outbound edit with a different payload
 *                       hash is additionally recorded as a conflict
 *                       ('remote-wins') so the divergence is visible.
 *  - revision-aware     everything operational: highest revision wins; equal
 *                       revisions tiebreak deterministically on the larger
 *                       payload hash (hex compare), with the loser recorded.
 */

export type HybridEntityPolicy =
  | 'append-only'
  | 'origin-authority'
  | 'cloud-authoritative'
  | 'revision-aware'

export const HYBRID_ENTITIES: Record<string, { policy: HybridEntityPolicy }> = {
  // ── append-only: financial / audit trail ─────────────────────────────
  Payment: { policy: 'append-only' },
  CashDrawerEntry: { policy: 'append-only' },
  InventoryTransaction: { policy: 'append-only' },
  WasteLog: { policy: 'append-only' },
  AuditLog: { policy: 'append-only' },
  Attendance: { policy: 'append-only' },

  // ── origin-authority: live check state ───────────────────────────────
  Order: { policy: 'origin-authority' },
  OrderItem: { policy: 'origin-authority' },

  // ── cloud-authoritative: reference / config ──────────────────────────
  Product: { policy: 'cloud-authoritative' },
  Category: { policy: 'cloud-authoritative' },
  ModifierGroup: { policy: 'cloud-authoritative' },
  Modifier: { policy: 'cloud-authoritative' },
  // NOTE: ProductModifierGroup (the product↔group link table) is deliberately
  // NOT in this registry — it has a COMPOSITE primary key (productId +
  // modifierGroupId), which the single-int entityId contract of rsm-hybrid/1
  // cannot address. Its links re-derive from Product / ModifierGroup events
  // (the modifier APIs recreate rows on both sides); a future format revision
  // may add composite addressing.
  RecipeComponent: { policy: 'cloud-authoritative' },
  CustomRole: { policy: 'cloud-authoritative' },

  // ── revision-aware: operational data ─────────────────────────────────
  Customer: { policy: 'revision-aware' },
  Reservation: { policy: 'revision-aware' },
  Supplier: { policy: 'revision-aware' },
  PurchaseOrder: { policy: 'revision-aware' },
  PurchaseOrderItem: { policy: 'revision-aware' },
  StockCount: { policy: 'revision-aware' },
  StockCountLine: { policy: 'revision-aware' },
  Promotion: { policy: 'revision-aware' },
  Person: { policy: 'revision-aware' },
  RestaurantTable: { policy: 'revision-aware' },
  CashDrawerSession: { policy: 'revision-aware' },
  FloorPlan: { policy: 'revision-aware' },
}

/** Policy for a wire entity name (null when the entity is not registered). */
export function resolvePolicy(entity: string): HybridEntityPolicy | null {
  return HYBRID_ENTITIES[entity]?.policy ?? null
}
