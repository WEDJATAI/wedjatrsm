// r47: zero-residue cleanup of the live E2E test (mazaj order CQ2ZKA → RSM check 2190)
// per the r46 discipline: stream cleanup BEFORE delete-event emission; hard deletes;
// supersede events at revisions ABOVE watermarks; audit row removed both sides.
import { Client } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { createClient as createLibsql } from '@libsql/client'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const MAZAJ_ORDER_ID = 'cmuy2jjwg0000ld06f8cq2zka'
const RSM_ORDER_ID = 2190
const RSM_ITEM_ID = 2516
const TABLE_ID = 37

async function main() {
  // ══════════ RSM NEON SIDE ══════════
  const neon = new Client({ connectionString: env.NEON_DATABASE_URL })
  await neon.connect()

  // 1. stream cleanup FIRST (delete the E2E create/update events — r46 lesson #2)
  const del = await neon.query(
    `DELETE FROM hybrid_events WHERE entity IN ('Order','OrderItem') AND "entityId" IN ($1,$2)
      AND direction='out' RETURNING id`,
    [String(RSM_ORDER_ID), String(RSM_ITEM_ID)],
  )
  console.log(`stream cleanup: ${del.rowCount} order/item events removed`)
  const tblEv = await neon.query(
    `DELETE FROM hybrid_events WHERE entity='RestaurantTable' AND "entityId"=$1 AND revision=8 AND direction='out' RETURNING id`,
    [String(TABLE_ID)],
  )
  console.log(`stream cleanup: ${tblEv.rowCount} table-37 rev-8 event removed`)
  const auditEv = await neon.query(
    `DELETE FROM hybrid_events WHERE entity='AuditLog' AND "entityId"='4803' AND direction='out' RETURNING id`,
  )
  console.log(`stream cleanup: ${auditEv.rowCount} audit-4803 event removed`)

  // 2. hard deletes + table free (direct Neon writes)
  await neon.query('DELETE FROM order_items WHERE id = $1', [RSM_ITEM_ID])
  await neon.query('DELETE FROM orders WHERE id = $1', [RSM_ORDER_ID])
  await neon.query("UPDATE tables SET status='free' WHERE id = $1", [TABLE_ID])
  await neon.query('DELETE FROM audit_logs WHERE id = 4803')
  console.log('Neon: order 2190 + item 2516 deleted, table 37 free, audit 4803 removed')

  // 3. supersede events (revisions ABOVE watermarks: item rev2, order rev3, table rev9)
  const emit = async (entity: string, entityId: string, operation: string, revision: number, payload: object) => {
    const body = JSON.stringify(payload)
    await neon.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, createHash('sha256').update(body).digest('hex'), body],
    )
    console.log(`  emitted ${entity}/${entityId} ${operation} rev${revision}`)
  }
  await emit('OrderItem', String(RSM_ITEM_ID), 'delete', 2, { id: RSM_ITEM_ID })
  await emit('Order', String(RSM_ORDER_ID), 'delete', 3, { id: RSM_ORDER_ID })
  const t = (await neon.query('SELECT * FROM tables WHERE id = $1', [TABLE_ID])).rows[0] as any
  const tPayload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(t)) tPayload[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v instanceof Date ? v.toISOString() : v
  tPayload.revision = 9
  await emit('RestaurantTable', String(TABLE_ID), 'update', 9, tPayload)
  await neon.end()

  // ══════════ RSM LOCAL SIDE (audit row direct delete; engine pulls the rest) ══════════
  const ldb = createLibsql({ url: 'file:db/custom.db' })
  await ldb.execute('DELETE FROM audit_logs WHERE id = 4803')
  console.log('local: audit 4803 removed (rows converge via engine pull)')

  // ══════════ MAZAJ NEON SIDE ══════════
  const mazaj = new Client({ connectionString: 'postgresql://neondb_owner:npg_uQWg6ci3RxCS@ep-silent-violet-b8c9ljz8-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require' })
  await mazaj.connect()
  // reverse the exact stock deductions of 1× Mazaya Blueberry fruits hookah
  await mazaj.query(`UPDATE "InventoryItem" SET "stockGrams" = "stockGrams" + 20 WHERE "brandId" = 'mazaya'`)
  await mazaj.query(`UPDATE "FlavorStock" SET "stockGrams" = "stockGrams" + 20 WHERE "brandIdRaw" = 'mazaya' AND "flavorName" = 'Blueberry'`)
  await mazaj.query(`UPDATE "SupplyItem" SET "stock" = "stock" + 1 WHERE "key" = 'regular_coal'`)
  await mazaj.query(`UPDATE "SupplyItem" SET "stock" = "stock" + 1 WHERE "key" = 'foil'`)
  const gone = await mazaj.query('DELETE FROM "Order" WHERE id = $1 RETURNING id', [MAZAJ_ORDER_ID])
  console.log(`mazaj: order deleted (${gone.rowCount}), stock reversed (+20g Mazaya/Blueberry, +1 coal, +1 foil)`)
  const check = (await mazaj.query('SELECT "stockGrams" FROM "InventoryItem" WHERE "brandId"=\'mazaya\'')).rows ?? []
  await mazaj.end()
  console.log('mazaj Mazaya stock now:', JSON.stringify(check))
  ldb.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
