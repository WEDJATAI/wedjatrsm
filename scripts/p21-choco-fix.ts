import { db } from '../src/lib/db'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'
async function main() {
  // Phase 1 set Chocolate stock 21.95 → 15 (down) without an inventory
  // transaction — book the missing 'adjustment' row for a clean ledger.
  const choco = await db.product.findFirst({ where: { name: 'Chocolate (kg)' }, select: { id: true, stock: true } })
  if (!choco) throw new Error('chocolate not found')
  const existing = await db.inventoryTransaction.findFirst({ where: { productId: choco.id, quantityChange: -6.95, reason: 'adjustment' } })
  if (existing) { console.log('adjustment already booked'); return }
  await db.$transaction(async (tx) => {
    const row = await tx.inventoryTransaction.create({ data: { productId: choco.id, quantityChange: -6.95, reason: 'adjustment' } })
    await emitOutboxEvent(tx, { entity: 'InventoryTransaction', entityId: row.id, operation: 'create', row })
  })
  console.log('booked -6.95 adjustment for Chocolate (kg) id', choco.id)
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
