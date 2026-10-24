/**
 * p21 repair: re-emit the CURRENT truth for every cloud-authoritative row
 * (products, categories, modifiers, modifier groups) so the cloud converges
 * after the historical failed-event healing stomped September-era payloads
 * over today's state. Fresh revisions pass the new revision floor.
 */
import { db } from '../src/lib/db'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'

async function main() {
  let count = 0
  const products = await db.product.findMany()
  for (const p of products) {
    await db.$transaction(async (tx) => {
      await emitOutboxEvent(tx, { entity: 'Product', entityId: p.id, operation: 'update', row: p })
    })
    count++
  }
  console.log(`products re-emitted: ${count}`)
  let ccount = 0
  const cats = await db.category.findMany()
  for (const c of cats) {
    await db.$transaction(async (tx) => {
      await emitOutboxEvent(tx, { entity: 'Category', entityId: c.id, operation: 'update', row: c })
    })
    ccount++
  }
  console.log(`categories re-emitted: ${ccount}`)
  let mcount = 0
  const mods = await db.modifier.findMany()
  for (const m of mods) {
    await db.$transaction(async (tx) => {
      await emitOutboxEvent(tx, { entity: 'Modifier', entityId: m.id, operation: 'update', row: m })
    })
    mcount++
  }
  console.log(`modifiers re-emitted: ${mcount}`)
  let gcount = 0
  const groups = await db.modifierGroup.findMany()
  for (const g of groups) {
    await db.$transaction(async (tx) => {
      await emitOutboxEvent(tx, { entity: 'ModifierGroup', entityId: g.id, operation: 'update', row: g })
    })
    gcount++
  }
  console.log(`modifier groups re-emitted: ${gcount}`)
  const pending = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  console.log(`outbox pending: ${pending} — drain with sync-now cycles`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
