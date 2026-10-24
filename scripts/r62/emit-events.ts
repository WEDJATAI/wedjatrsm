// r62 — FAST event emission for the v11 menu reimport.
//
// The r62 surgery committed on BOTH planes (211 products / 20 categories /
// 200 active, audit row on Neon), but the original emission loop (one
// maxRev query + one INSERT per event = 820 sequential round-trips to
// us-east-1) was killed by the 180s command timeout before its single
// transaction committed — a clean rollback, zero events out.
//
// This emitter does the SAME job in ~20 round-trips:
//   · 3 bulk max-revision queries (Product ids · Category ids · sanity)
//   · multi-row INSERTs, 50 events per statement, in the exact stream
//     order the applier needs:
//       audit create → keeper updates → product deletes →
//       category deletes → category creates → product creates
//   · one transaction — all 410 events land atomically
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { readFileSync, readdirSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const menu = JSON.parse(readFileSync('scripts/r62/menu-v11.json', 'utf8')) as {
  cats: Array<{ id: number; name: string; nameAr: string; station: string; displayOrder: number }>
  items: Array<{ id: number; nameEn: string; nameAr: string; price: number; descEn: string | null; cat: string }>
}
const BK = readdirSync('backups').filter((d) => d.startsWith('r62-menu')).sort().pop()!
const backup = JSON.parse(readFileSync(`backups/${BK}/removed-local.json`, 'utf8')) as {
  products: Array<{ id: number }>
  categories: Array<{ id: number }>
  keepersBefore: Array<{ id: number; name: string; name_ar: string | null; price: number; sku: string | null; description: string | null; created_at: string }>
}
const HISTORY_KEEPER_IDS = [1001, 1002, 1003, 1007, 1068, 1070, 1071, 1073, 1076, 1084, 1168]
const NOW_ISO = new Date().toISOString()

const log = (m: string) => console.log(`[r62-emit] ${m}`)
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const canon = (v: any): any => {
  if (v instanceof Date) return v.toISOString()
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o }
  return v
}
const cj = (v: any) => JSON.stringify(canon(v))
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

type Ev = { entity: string; entityId: number; operation: string; payload: any }
const events: Ev[] = []

const prodCatIds = new Map(menu.items.map((i) => [i.id, menu.cats.find((c) => c.name === i.cat)!.id]))

const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

// ── 1. the audit row as committed by the surgery (source of truth) ──
const audit = (await pool.query(`SELECT id, details, created_at FROM audit_logs WHERE action='menu.reimport' ORDER BY id DESC LIMIT 1`)).rows[0]
ok(!!audit, `audit row found on Neon (id ${audit?.id})`)
events.push({
  entity: 'AuditLog', entityId: Number(audit.id), operation: 'create',
  payload: { id: Number(audit.id), action: 'menu.reimport', entity: 'product', entityId: null, details: audit.details, userId: null, userName: 'system', personId: null, personName: null, createdAt: audit.created_at.toISOString ? audit.created_at.toISOString() : String(audit.created_at) },
})

// ── 2. keeper updates (category nulled BEFORE the category rows die) ──
for (const kid of HISTORY_KEEPER_IDS) {
  const row = backup.keepersBefore.find((k) => Number(k.id) === kid)!
  events.push({
    entity: 'Product', entityId: kid, operation: 'update',
    payload: { id: kid, name: row.name, nameAr: row.name_ar ?? null, categoryId: null, price: Number(row.price), cost: 0, isStockable: false, isSellable: true, sku: row.sku ?? null, imageUrl: null, active: false, lowStockThreshold: 0, stock: 0, soldOut: false, allergens: null, dietary: null, description: row.description ?? null, createdAt: row.created_at ?? NOW_ISO },
  })
}

// ── 3. product deletes (before their categories) ────────────────────
for (const row of backup.products) events.push({ entity: 'Product', entityId: Number(row.id), operation: 'delete', payload: { id: Number(row.id) } })

// ── 4. category deletes ─────────────────────────────────────────────
for (const row of backup.categories) events.push({ entity: 'Category', entityId: Number(row.id), operation: 'delete', payload: { id: Number(row.id) } })

// ── 5. category creates ─────────────────────────────────────────────
for (const cat of menu.cats) events.push({ entity: 'Category', entityId: cat.id, operation: 'create', payload: { id: cat.id, name: cat.name, nameAr: cat.nameAr, displayOrder: cat.displayOrder, prepDestination: cat.station, active: true } })

// ── 6. product creates ──────────────────────────────────────────────
for (const p of menu.items) events.push({ entity: 'Product', entityId: p.id, operation: 'create', payload: { id: p.id, name: p.nameEn, nameAr: p.nameAr, categoryId: prodCatIds.get(p.id)!, price: p.price, cost: 0, isStockable: false, isSellable: true, sku: null, imageUrl: null, active: true, lowStockThreshold: 0, stock: 0, soldOut: false, allergens: null, dietary: null, description: p.descEn, createdAt: NOW_ISO } })

ok(events.length === 410, `event list built: ${events.length} (1 audit + 11 keepers + 165 prod del + 27 cat del + 19 cat new + 187 prod new)`)

// ── 7. bulk revision floors ─────────────────────────────────────────
log('bulk revision lookup…')
const productIds = [...new Set(events.filter((e) => e.entity === 'Product').map((e) => e.entityId))]
const categoryIds = [...new Set(events.filter((e) => e.entity === 'Category').map((e) => e.entityId))]
const auditIds = events.filter((e) => e.entity === 'AuditLog').map((e) => e.entityId)
const revFloor = new Map<string, number>()
for (const [entity, ids] of [['Product', productIds], ['Category', categoryIds], ['AuditLog', auditIds]] as const) {
  const r = await pool.query(
    `SELECT "entityId", COALESCE(MAX(revision),0) rev FROM hybrid_events WHERE entity=$1 AND "entityId" = ANY($2::int[]) GROUP BY "entityId"`,
    [entity, ids],
  )
  for (const row of r.rows) revFloor.set(`${entity}:${row.entityId}`, Number(row.rev))
}
log(`revision floors loaded (${revFloor.size} entities have prior events)`)

// ── 8. batched insert (one transaction) ─────────────────────────────
log('inserting events…')
const c = await pool.connect()
await c.query('BEGIN')
try {
  const CHUNK = 50
  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK)
    const values: unknown[] = []
    const tuples = chunk.map((e, j) => {
      const body = cj(e.payload)
      const rev = (revFloor.get(`${e.entity}:${e.entityId}`) ?? 0) + 1
      const base = j * 7
      values.push(randomUUID(), e.entity, e.entityId, e.operation, rev, sha(body), body)
      return `($${base + 1},'unbound',$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},'out','pending',0,now(),now())`
    })
    await c.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt") VALUES ${tuples.join(',')}`,
      values,
    )
  }
  await c.query('COMMIT')
} catch (e) {
  await c.query('ROLLBACK')
  c.release()
  throw e
}
c.release()

// ── 9. verify ───────────────────────────────────────────────────────
const cnt = (await pool.query(`SELECT COUNT(*) c FROM hybrid_events WHERE id > 15821 AND direction='out' AND "deviceId"='unbound'`)).rows[0].c
ok(Number(cnt) === 410, `Neon carries the 410 r62 events (${cnt})`)
const order = (await pool.query(`SELECT entity, operation, COUNT(*) n FROM hybrid_events WHERE id > 15821 AND direction='out' AND "deviceId"='unbound' GROUP BY entity, operation ORDER BY MIN(id)`)).rows
for (const r of order) console.log(`  · stream order: ${r.entity} ${r.operation} × ${r.n}`)

await pool.end()
console.log(failed === 0 ? `\n[r62-emit] STREAM READY — devices will pull the v11 cutover on their next cycle` : `\n[r62-emit] ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
