// r57 — RESUME: batched cloud-origin event emission + engine resume.
// (The surgery on both planes already committed; the original script died
// in the emission loop — 801 sequential round-trips — so this one batches
// 50 rows per statement and reads the removal sets from the backup dump.)
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { Database } from 'bun:sqlite'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const menu = JSON.parse(readFileSync('scripts/r57/menu-final.json', 'utf8')) as {
  cats: Array<{ id: number; name: string; nameAr: string; station: string; displayOrder: number }>
  items: Array<{ id: number; nameEn: string; nameAr: string | null; price: number; descEn: string | null; cat: string }>
}
const BK = 'backups/r57-menu-2026-10-17T18-06-34'
const dump = JSON.parse(readFileSync(`${BK}/removed-local.json`, 'utf8')) as {
  products: Array<{ id: number }>
  categories: Array<{ id: number }>
  inventory_transactions: Array<{ id: number }>
}
const AUDIT_ID = 6473
const WIPE_MARKER = 'rsm-owner-wipe-v1'
const NOW_ISO = new Date().toISOString()

const canon = (v: any): any => {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o }
  return v
}
const cj = (v: any) => JSON.stringify(canon(v))
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1, connectionTimeoutMillis: 20000 })
const local = new Database('/home/z/my-project/db/custom.db')

// guard: never double-emit
const already = Number((await pool.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND "deviceId"='unbound' AND entity IN ('Product','Category') AND "updatedAt" > now() - interval '1 hour'`)).rows[0].c)
if (already > 0) {
  console.log(`ABORT: ${already} Product/Category unbound events already emitted in the last hour — refusing to double-emit`)
  process.exit(1)
}

// revision watermarks in ONE query
const revRows = (await pool.query(`SELECT entity, "entityId", MAX(revision) rev FROM hybrid_events WHERE entity IN ('Product','Category','InventoryTransaction','AuditLog') GROUP BY entity, "entityId"`)).rows
const revMap = new Map<string, number>()
for (const r of revRows) revMap.set(`${r.entity}:${r.entityId}`, Number(r.rev))
const revOf = (entity: string, id: number) => (revMap.get(`${entity}:${id}`) ?? 0) + 1

// build the event list in stream-apply order
const prodCatIds = new Map(menu.items.map((i) => [i.id, menu.cats.find((c) => c.name === i.cat)!.id]))
const auditRow = (await pool.query('SELECT id, action, entity, details, user_name, created_at FROM audit_logs WHERE id=$1', [AUDIT_ID])).rows[0]
type Ev = { eventId: string; entity: string; entityId: number; operation: string; revision: number; payloadHash: string; payload: string }
const events: Ev[] = []
const push = (entity: string, entityId: number, operation: string, payload: any) => {
  const body = cj(payload)
  events.push({ eventId: randomUUID(), entity, entityId, operation, revision: revOf(entity, entityId), payloadHash: sha(body), payload: body })
}
push('AuditLog', AUDIT_ID, 'create', { id: auditRow.id, action: auditRow.action, entity: auditRow.entity, entityId: null, details: auditRow.details, userId: null, userName: auditRow.user_name, personId: null, personName: null, createdAt: new Date(auditRow.created_at).toISOString() })
for (const row of dump.inventory_transactions) push('InventoryTransaction', Number(row.id), 'delete', { id: Number(row.id), __wipe: WIPE_MARKER })
for (const row of dump.products) push('Product', Number(row.id), 'delete', { id: Number(row.id) })
for (const row of dump.categories) push('Category', Number(row.id), 'delete', { id: Number(row.id) })
push('Category', 5, 'update', { id: 5, name: 'Shisha', nameAr: 'شيشة', displayOrder: 999, prepDestination: 'shisha', active: true })
for (const c of menu.cats) push('Category', c.id, 'create', { id: c.id, name: c.name, nameAr: c.nameAr, displayOrder: c.displayOrder, prepDestination: c.station, active: true })
for (const p of menu.items) {
  push('Product', p.id, 'create', { id: p.id, name: p.nameEn, nameAr: p.nameAr, categoryId: prodCatIds.get(p.id)!, price: p.price, cost: 0, isStockable: false, isSellable: true, sku: null, imageUrl: null, active: true, lowStockThreshold: 0, stock: 0, soldOut: false, allergens: null, dietary: null, description: p.descEn, createdAt: NOW_ISO })
}
console.log(`events to emit: ${events.length} (expected 1+${dump.inventory_transactions.length}+${dump.products.length}+${dump.categories.length}+1+${menu.cats.length}+${menu.items.length})`)

// batched insert — 50 rows per statement
const client = await pool.connect()
await client.query('BEGIN')
try {
  const CHUNK = 50
  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK)
    const values: string[] = []
    const params: unknown[] = []
    chunk.forEach((ev, j) => {
      const b = j * 7
      values.push(`($${b + 1}::uuid,'unbound',$${b + 2}::text,$${b + 3}::int,$${b + 4}::text,$${b + 5}::int,$${b + 6}::text,$${b + 7}::text,'out','pending',0,now(),now())`)
      params.push(ev.eventId, ev.entity, ev.entityId, ev.operation, ev.revision, ev.payloadHash, ev.payload)
    })
    await client.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt") VALUES ${values.join(',')}`,
      params,
    )
  }
  await client.query('COMMIT')
} catch (e) {
  await client.query('ROLLBACK')
  client.release()
  throw e
}
client.release()
const emitted = Number((await pool.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND "deviceId"='unbound' AND entity IN ('Product','Category','InventoryTransaction') AND "updatedAt" > now() - interval '5 minutes'`)).rows[0].c)
ok(emitted === events.length - 1, `cloud-origin events emitted: ${emitted}/${events.length - 1} (+1 audit)`)

// resume engine
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()
console.log('[r57] engine resumed')

local.close()
await pool.end()
console.log(failed === 0 ? `\n[r57] EMISSION COMPLETE — stream armed, engine resumed (pull convergence next)` : `\n[r57] ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
