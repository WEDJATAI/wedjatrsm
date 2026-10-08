// p12-cloud-pull: one-shot out-of-band convergence pull — Neon (production) → local SQLite.
//
// WHY THIS EXISTS (worklog p12): the owner asked "pull all data — be sure we
// lost nothing, especially added employees". The cloud-era rows (5 employees,
// prod orders/items/drawer/audit history) were created BEFORE the hybrid
// outbox existed, so the HTTP pull protocol can never deliver them (it only
// serves events). This script converges the local instance to the cloud's
// current state, honoring the registry policies:
//
//  POLICY (per src/lib/hybrid-sync/entity-policy.ts):
//   - append-only (Payment, CashDrawerEntry, InventoryTransaction, WasteLog,
//     AuditLog, Attendance): cloud-only rows INSERTED; divergent same-id rows
//     NEVER overwritten — recorded in hybrid_conflicts (resolution 'rejected');
//     each side keeps its own financial/audit history.
//   - origin-authority (Order, OrderItem): same handling for a direct pull —
//     inserts only, divergent → conflict row, local retained.
//   - cloud-authoritative (Product, Category, ModifierGroup, Modifier,
//     RecipeComponent, CustomRole): cloud is the master — divergent rows are
//     OVERWRITTEN locally (local id kept for FK safety) + conflict row
//     ('remote-wins') for visibility.
//   - revision-aware (everything else): newer updated_at wins; equal/older
//     cloud → keep local + conflict row ('rejected').
//   - User: EXCLUDED from the hybrid registry BY DESIGN (passwordHash + PIN
//     must never ride a hybrid event). This pull adds the 5 cloud-era
//     employees + developer by email only: missing-by-email users INSERTED
//     (their cloud ids), divergent users KEPT LOCAL (no event, no conflict
//     row — stdout report only). User rows never enter hybrid_events.
//
//  CROSS-INSTANCE ID COLLISIONS (re-id pass): when the same numeric id means
//  DIFFERENT logical rows on the two sides (local Category 5 = "Shisha" vs
//  cloud Category 5 = "Ingredients (internal)"), a by-id match with a
//  DIFFERENT natural key is spurious: the cloud row is INSERTED under a
//  fresh local id (never reusing a live local id), the local row stays
//  untouched, and the map entry (cloudId → newLocalId) redirects children.
//  Mirrors the p9/p10 re-iding precedent (226-229, Omelet 9→29).
//
//  NATURAL KEYS: users → email, products → sku, categories → name,
//  custom_roles → name. Prevents duplicate rows when the same logical row
//  lives under different ids on the two sides (the re-ided products 226-229;
//  the developer account local id 4 vs cloud id 14).
//  FK REMAPS on insert/update: user_id/_user_id/created_by_id/created_by →
//  USERMAP; product_id/ingredient_id/_product_id → PRODUCTMAP;
//  category_id → CATMAP; role_id → ROLEMAP.
//
//  SAFETY: pre-write VACUUM INTO backup; ONE bun:sqlite transaction for ALL
//  writes (rows + events + conflicts — all or nothing); deterministic
//  eventIds (p12pull:…) against the eventId UNIQUE index; conflicts deduped
//  by (entity, entityId, hashes, resolution); post-verify re-derives the
//  comparison and must show ZERO cloud-only rows; unique invariants (email,
//  sku) asserted not duplicated. Read-only towards Neon.
//  RUN ORDER GUARD: the local outbox must be fully drained (push to the
//  cloud complete) BEFORE this pull — otherwise cloud-authoritative product
//  overwrites could resurrect the locally-retired old demo menu.
//  tsc: carries the same documented bun:sqlite TS2307 class as p10-backups.
import { Pool } from 'pg'
import Database from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { neonPooledUrl } from './lib/env-local'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const sortedStringify = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + sortedStringify(o[k])).join(',') + '}'
}

type Policy = 'append-only' | 'origin-authority' | 'cloud-authoritative' | 'revision-aware' | 'user-out-of-band'
const PLAN: Array<{ model: string; table: string; policy: Policy; natKey?: string }> = [
  { model: 'CustomRole', table: 'roles', policy: 'cloud-authoritative', natKey: 'name' },
  { model: 'User', table: 'users', policy: 'user-out-of-band', natKey: 'email' },
  { model: 'Person', table: 'persons', policy: 'revision-aware' },
  { model: 'Customer', table: 'customers', policy: 'revision-aware' },
  { model: 'Category', table: 'categories', policy: 'cloud-authoritative', natKey: 'name' },
  { model: 'Product', table: 'products', policy: 'cloud-authoritative', natKey: 'sku' },
  { model: 'FloorPlan', table: 'floor_plans', policy: 'revision-aware' },
  { model: 'RestaurantTable', table: 'tables', policy: 'revision-aware' },
  { model: 'ModifierGroup', table: 'modifier_groups', policy: 'cloud-authoritative' },
  { model: 'Modifier', table: 'modifiers', policy: 'cloud-authoritative' },
  { model: 'RecipeComponent', table: 'recipe_components', policy: 'cloud-authoritative' },
  { model: 'Promotion', table: 'promotions', policy: 'revision-aware' },
  { model: 'Reservation', table: 'reservations', policy: 'revision-aware' },
  { model: 'Supplier', table: 'suppliers', policy: 'revision-aware' },
  { model: 'PurchaseOrder', table: 'purchase_orders', policy: 'revision-aware' },
  { model: 'PurchaseOrderItem', table: 'purchase_order_items', policy: 'revision-aware' },
  { model: 'StockCount', table: 'stock_counts', policy: 'revision-aware' },
  { model: 'StockCountLine', table: 'stock_count_lines', policy: 'revision-aware' },
  { model: 'Order', table: 'orders', policy: 'origin-authority' },
  { model: 'OrderItem', table: 'order_items', policy: 'origin-authority' },
  { model: 'Payment', table: 'payments', policy: 'append-only' },
  { model: 'InventoryTransaction', table: 'inventory_transactions', policy: 'append-only' },
  { model: 'CashDrawerSession', table: 'cash_drawer_sessions', policy: 'revision-aware' },
  { model: 'CashDrawerEntry', table: 'cash_drawer_entries', policy: 'append-only' },
  { model: 'Attendance', table: 'attendance', policy: 'append-only' },
  { model: 'WasteLog', table: 'waste_logs', policy: 'append-only' },
  { model: 'AuditLog', table: 'audit_logs', policy: 'append-only' },
]

// comparison normalizer — aggressive, applied IDENTICALLY to both sides
function norm(v: unknown): number | string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) return Date.parse(v.replace(' ', 'T') + 'Z')
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v)
    if (v.startsWith('{') || v.startsWith('[')) { try { return sortedStringify(JSON.parse(v)) } catch { /* fallthrough */ } }
    const n = Number(v)
    return Number.isFinite(n) && v.trim() !== '' ? n : v
  }
  if (typeof v === 'object') return sortedStringify(v) // pg jsonb
  return null
}

const isUserFk = (c: string) => c === 'user_id' || c.endsWith('_user_id') || c === 'created_by_id' || c === 'created_by'
const isProductFk = (c: string) => c === 'product_id' || c === 'ingredient_id' || c.endsWith('_product_id')

const neon = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 5 })
const local = new Database('/home/z/my-project/db/custom.db')
const localCols = (t: string): string[] =>
  (local.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((r) => r.name)

const existedConflicts = new Set(
  (local.query('SELECT entity, entityId, localHash, remoteHash, resolution FROM hybrid_conflicts').all() as any[])
    .map((r) => `${r.entity}|${r.entityId}|${r.localHash}|${r.remoteHash}|${r.resolution}`),
)

// ── run-order guard: the outbox must be drained before we pull ──
const pendingOut = (local.query(`SELECT COUNT(*) FROM hybrid_events WHERE direction='out' AND status='pending'`).get() as any).c
if (pendingOut > 0) {
  console.log(`RUN-ORDER GUARD FAILED: ${pendingOut} out-events still pending — the push must complete first ` +
    `(otherwise cloud-authoritative overwrites could resurrect the locally-retired old menu). Re-run later.`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const backupPath = `/home/z/my-project/backups/pre-p12-pull-${stamp}.db`
local.exec(`VACUUM INTO '${backupPath}'`)
console.log('BACKUP:', backupPath, 'quick_check:', (local.query(`PRAGMA quick_check`).get() as any)?.quick_check ?? 'ok')

const USERMAP = new Map<number, number>()
const PRODUCTMAP = new Map<number, number>()
const CATMAP = new Map<number, number>()
const ROLEMAP = new Map<number, number>()
const nextId = new Map<string, number>()
const freshId = (table: string): number => {
  if (!nextId.has(table)) {
    const max = (local.query(`SELECT COALESCE(MAX(id),0) m FROM ${table}`).get() as any).m
    nextId.set(table, Number(max) + 1)
  }
  const v = nextId.get(table)!
  nextId.set(table, v + 1)
  return v
}

const stats: Array<Record<string, string | number>> = []
const stmts: Array<{ sql: string; params: unknown[] }> = []
const events: Array<{ eventId: string; entity: string; entityId: number; payload: string; payloadHash: string }> = []
const conflicts: Array<{ entity: string; eventId: string; entityId: number; localHash: string; remoteHash: string; policy: string; resolution: string; details: string }> = []

for (const spec of PLAN) {
  const lcols = localCols(spec.table)
  if (!lcols.length) { console.log(`${spec.model}: local table missing — SKIPPED`); continue }
  const nq = await neon.query(`SELECT * FROM ${spec.table}`)
  const pgCols = nq.fields.map((f) => ({ name: f.name, oid: f.dataTypeID }))
  const shared = pgCols.map((c) => c.name).filter((c) => lcols.includes(c))
  if (!shared.includes('id')) { console.log(`${spec.model}: no shared id — SKIPPED`); continue }

  const store = (col: string, v: unknown): unknown => {
    const oid = pgCols.find((c) => c.name === col)?.oid ?? 0
    if (v === null || v === undefined) return null
    if (oid === 16) return v ? 1 : 0
    if (oid === 1184 || oid === 1114) return v instanceof Date ? v.getTime() : Date.parse(String(v))
    if (oid === 1082) return Date.parse(String(v) + 'T00:00:00Z')
    if (oid === 1700 || oid === 700 || oid === 701 || oid === 20 || oid === 21 || oid === 23) return Number(v)
    if (oid === 114 || oid === 3802) return typeof v === 'object' ? sortedStringify(v) : String(v)
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  }
  const remap = (c: string, v: unknown): unknown => {
    if (typeof v !== 'number') return v
    if (isUserFk(c)) return USERMAP.get(v) ?? v
    if (isProductFk(c)) return PRODUCTMAP.get(v) ?? v
    if (c === 'category_id') return CATMAP.get(v) ?? v
    if (c === 'role_id') return ROLEMAP.get(v) ?? v
    return v
  }

  const localRows = local.query(`SELECT * FROM ${spec.table}`).all() as Array<Record<string, unknown>>
  const lNorm = localRows.map((r) => { const o: Record<string, number | string | null> = {}; for (const c of lcols) o[c] = norm(r[c]); return o })
  const byId = new Map(lNorm.map((r) => [Number(r.id), r]))
  const byNat = spec.natKey && shared.includes(spec.natKey)
    ? new Map(lNorm.filter((r) => r[spec.natKey!] !== null && r[spec.natKey!] !== undefined).map((r) => [String(r[spec.natKey!]), r]))
    : null

  const s: Record<string, string | number> = { model: spec.model, identical: 0, inserted: 0, reIded: 0, divergentKept: 0, divergentApplied: 0, localOnly: 0 }
  const matched = new Set<number>()
  let printedDivergence = false

  for (const cr of nq.rows as Array<Record<string, unknown>>) {
    const cn: Record<string, number | string | null> = {}
    for (const c of shared) cn[c] = norm(cr[c])
    const id = Number(cn.id)
    const natVal = spec.natKey ? (cn[spec.natKey!] ?? null) : null
    const byIdRow = byId.get(id) ?? null
    const byNatRow = byNat && natVal !== null ? byNat.get(String(natVal)) ?? null : null

    // spurious by-id match: same id, DIFFERENT natural key. First consult
    // byNat — if the cloud row's identity already lives locally under another
    // id, MERGE onto that row (the duplicate-family case: Neon carries the old
    // shisha family twice — ids 44-48 under cat 5 AND 50-53 under cat 9; and
    // the p9-remapped rows came back through the pull loopback). Only when
    // the identity is genuinely unknown locally does the cloud row get a
    // fresh local id (re-id, p9/p10 precedent).
    const idSpurious = !!(byIdRow && spec.natKey && byIdRow[spec.natKey!] !== null && natVal !== null &&
        String(byIdRow[spec.natKey!]) !== String(natVal))
    const target = idSpurious ? (byNatRow ?? null) : (byIdRow ?? byNatRow)

    if (idSpurious && !target) {
      const newId = freshId(spec.table)
      const cols = shared.filter((c) => c !== 'id')
      const vals = cols.map((c) => remap(c, store(c, cr[c])))
      stmts.push({ sql: `INSERT INTO ${spec.table} (id, ${cols.join(',')}) VALUES (${['id', ...cols].map(() => '?').join(',')})`, params: [newId, ...vals] })
      s.reIded = Number(s.reIded) + 1
      console.log(`RE-ID ${spec.model}: cloud id ${id} ("${String(natVal)}") collides with local id ${id} ("${String(byIdRow![spec.natKey!])}") — identity unknown locally → inserted as fresh local id ${newId}`)
      const collisionHash = sha('collision')
      conflicts.push({ entity: spec.model, eventId: `p12cf:${spec.model}:${id}:collisn:${collisionHash.slice(0, 8)}`, entityId: Number(byIdRow!.id), localHash: collisionHash, remoteHash: collisionHash, policy: spec.policy, resolution: 're-ided', details: `cross-instance id collision: cloud ${spec.model} ${id} ("${String(natVal)}") inserted under fresh local id ${newId}; local ${spec.model} ${id} ("${String(byIdRow![spec.natKey!])}") untouched` })
      if (spec.model === 'User') USERMAP.set(id, newId)
      if (spec.model === 'Product') PRODUCTMAP.set(id, newId)
      if (spec.model === 'Category') CATMAP.set(id, newId)
      if (spec.model === 'CustomRole') ROLEMAP.set(id, newId)
      continue
    }
    if (idSpurious && target) {
      s.identical = Number(s.identical) + 0
      console.log(`MERGE ${spec.model}: cloud id ${id} ("${String(natVal)}") by-id-collides with local id ${id} ("${String(byIdRow![spec.natKey!])}") but the identity exists locally as id ${Number(target.id)} → merging there (no duplicate row)`)
    }
    if (!target) {
      const cols = shared.filter((c) => c !== 'id')
      const vals = cols.map((c) => remap(c, store(c, cr[c])))
      stmts.push({ sql: `INSERT INTO ${spec.table} (id, ${cols.join(',')}) VALUES (${['id', ...cols].map(() => '?').join(',')})`, params: [id, ...vals] })
      s.inserted = Number(s.inserted) + 1
      if (spec.policy !== 'user-out-of-band') {
        const po: Record<string, unknown> = {}
        for (const c of shared) {
          const camel = c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())
          const oid = pgCols.find((x) => x.name === c)?.oid ?? 0
          const stored = c === 'id' ? id : store(c, cr[c])
          po[camel] = oid === 16 ? Boolean(stored)
            : (oid === 1184 || oid === 1114) ? new Date(Number(stored)).toISOString()
            : (oid === 114 || oid === 3802) ? JSON.parse(String(stored))
            : stored
        }
        const payload = sortedStringify(po)
        const payloadHash = sha(payload)
        events.push({ eventId: `p12pull:${spec.model}:${id}:${payloadHash.slice(0, 12)}`, entity: spec.model, entityId: id, payload, payloadHash })
      }
      if (spec.model === 'User') USERMAP.set(id, id)
      if (spec.model === 'Product') PRODUCTMAP.set(id, id)
      if (spec.model === 'Category') CATMAP.set(id, id)
      if (spec.model === 'CustomRole') ROLEMAP.set(id, id)
    } else {
      matched.add(Number(target.id))
      const contentCols = shared.filter((c) => c !== 'id') // id is the KEY, not content — merged rows (byNat target, different ids) would otherwise always compare divergent
      // map-aware comparison: FK columns on the cloud side are compared through
      // the id maps (cloud cat 9 vs local cat 5 is CONVERGENT, not divergent)
      const cnComp: Record<string, number | string | null> = {}
      for (const c of contentCols) {
        let v = cn[c]
        if (typeof v === 'number') {
          if (isUserFk(c)) { const m = USERMAP.get(v); if (m !== undefined) v = m }
          else if (isProductFk(c)) { const m = PRODUCTMAP.get(v); if (m !== undefined) v = m }
          else if (c === 'category_id') { const m = CATMAP.get(v); if (m !== undefined) v = m }
          else if (c === 'role_id') { const m = ROLEMAP.get(v); if (m !== undefined) v = m }
        }
        cnComp[c] = v
      }
      const localCanon = sortedStringify(contentCols.slice().sort().map((c) => [c, target[c]]))
      const cloudCanon = sortedStringify(contentCols.slice().sort().map((c) => [c, cnComp[c]]))
      if (localCanon === cloudCanon) {
        s.identical = Number(s.identical) + 1
      } else {
        if (!printedDivergence) {
          printedDivergence = true
          const diffs = contentCols.filter((c) => JSON.stringify(target[c]) !== JSON.stringify(cn[c])).slice(0, 3)
          console.log(`  first ${spec.model} divergence (id ${id}):`, diffs.map((c) => `${c}: local=${JSON.stringify(target[c])} cloud=${JSON.stringify(cn[c])}`).join(' | '))
        }
        const localHash = sha(localCanon), remoteHash = sha(cloudCanon)
        if (spec.policy === 'user-out-of-band') {
          s.divergentKept = Number(s.divergentKept) + 1 // keep local; report only
        } else if (spec.policy === 'cloud-authoritative') {
          const cols = shared.filter((c) => c !== 'id')
          const vals = cols.map((c) => remap(c, store(c, cr[c])))
          stmts.push({ sql: `UPDATE ${spec.table} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, params: [...vals, Number(target.id)] })
          s.divergentApplied = Number(s.divergentApplied) + 1
          conflicts.push({ entity: spec.model, eventId: `p12cf:${spec.model}:${Number(target.id)}:${localHash.slice(0, 8)}:${remoteHash.slice(0, 8)}`, entityId: Number(target.id), localHash, remoteHash, policy: spec.policy, resolution: 'remote-wins', details: 'p12 out-of-band pull: cloud-authoritative — cloud content applied over local (local id kept)' })
        } else if (spec.policy === 'revision-aware' && shared.includes('updated_at')) {
          if (Number(cn.updated_at ?? 0) > Number(target.updated_at ?? 0)) {
            const cols = shared.filter((c) => c !== 'id')
            const vals = cols.map((c) => remap(c, store(c, cr[c])))
            stmts.push({ sql: `UPDATE ${spec.table} SET ${cols.map((c) => c + '=?').join(',')} WHERE id=?`, params: [...vals, Number(target.id)] })
            s.divergentApplied = Number(s.divergentApplied) + 1
            conflicts.push({ entity: spec.model, eventId: `p12cf:${spec.model}:${Number(target.id)}:${localHash.slice(0, 8)}:${remoteHash.slice(0, 8)}`, entityId: Number(target.id), localHash, remoteHash, policy: spec.policy, resolution: 'remote-wins', details: 'p12 out-of-band pull: revision-aware — newer cloud updated_at applied' })
          } else {
            s.divergentKept = Number(s.divergentKept) + 1
            conflicts.push({ entity: spec.model, eventId: `p12cf:${spec.model}:${Number(target.id)}:${localHash.slice(0, 8)}:${remoteHash.slice(0, 8)}`, entityId: Number(target.id), localHash, remoteHash, policy: spec.policy, resolution: 'rejected', details: 'p12 out-of-band pull: revision-aware — local not older; local retained' })
          }
        } else {
          s.divergentKept = Number(s.divergentKept) + 1
          conflicts.push({ entity: spec.model, eventId: `p12cf:${spec.model}:${Number(target.id)}:${localHash.slice(0, 8)}:${remoteHash.slice(0, 8)}`, entityId: Number(target.id), localHash, remoteHash, policy: spec.policy, resolution: 'rejected', details: 'p12 out-of-band pull: divergent same-id row — both sides retain their own history' })
        }
      }
      if (spec.model === 'User') USERMAP.set(id, Number(target.id))
      if (spec.model === 'Product') PRODUCTMAP.set(id, Number(target.id))
      if (spec.model === 'Category') CATMAP.set(id, Number(target.id))
      if (spec.model === 'CustomRole') ROLEMAP.set(id, Number(target.id))
    }
  }
  s.localOnly = lNorm.length - matched.size
  stats.push(s)
}

console.table(stats)
console.log('user divergences kept local (out-of-band, stdout-only):', stats.find((x) => x.model === 'User')?.divergentKept ?? 0)

// ── ONE transaction: rows + events + conflicts (all or nothing) ──
const runAll = local.transaction(() => {
  // r49: bun-types' run() rest-param inference rejects array spreads — call
  // through a widened signature (runtime API is identical).
  const localRun = local.run.bind(local) as unknown as (sql: string, ...params: unknown[]) => unknown
  for (const st of stmts) localRun(st.sql, ...st.params)
  const now = Math.floor(Date.now() / 1000)
  for (const ev of events) {
    localRun(
      `INSERT OR IGNORE INTO hybrid_events (eventId, deviceId, batchId, entity, entityId, operation, revision, payloadHash, payload, direction, status, attempts, lastError, nextAttemptAt, createdAt, updatedAt, ackedAt)
       VALUES (?, 'unbound', NULL, ?, ?, 'insert', 1, ?, ?, 'in', 'applied', 0, NULL, NULL, ?, ?, ?)`,
      ev.eventId, ev.entity, ev.entityId, ev.payloadHash, ev.payload, now, now, now,
    ) // r49: typed arrays above satisfy SQLQueryBindings
  }
  let deduped = 0
  const resolvedAt = Date.now() // epoch ms — the convention of the pre-existing rows
  for (const cf of conflicts) {
    const key = `${cf.entity}|${cf.entityId}|${cf.localHash}|${cf.remoteHash}|${cf.resolution}`
    if (existedConflicts.has(key)) { deduped++; continue }
    localRun(
      `INSERT INTO hybrid_conflicts (eventId, entity, entityId, localHash, remoteHash, policy, resolution, details, resolvedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cf.eventId, cf.entity, cf.entityId, cf.localHash, cf.remoteHash, cf.policy, cf.resolution, cf.details, resolvedAt,
    ) // r49
  }
  return deduped
})
const dedupedCount = runAll() as number
console.log('WROTE:', stmts.length, 'row statements |', events.length, 'events |', conflicts.length, 'conflicts (', dedupedCount, 'deduped as pre-existing )')

// ── post-verify: re-derive; cloud-only must be ZERO; invariants hold ──
let failures = 0
for (const spec of PLAN) {
  const lcols = localCols(spec.table)
  if (!lcols.length) continue
  const nq = await neon.query(`SELECT * FROM ${spec.table}`)
  const shared = nq.fields.map((f) => f.name).filter((c) => lcols.includes(c))
  const localRowsNow = local.query(`SELECT * FROM ${spec.table}`).all() as Array<Record<string, unknown>>
  const ids = new Set(localRowsNow.map((r) => Number(r.id)))
  const nats = spec.natKey && shared.includes(spec.natKey)
    ? new Set(localRowsNow.map((r) => String(r[spec.natKey!] ?? '')).filter((x) => x && x !== 'null'))
    : null
  let cloudOnly = 0
  for (const cr of nq.rows as Array<Record<string, unknown>>) {
    if (!ids.has(Number(cr.id)) && !(nats && nats.has(String(cr[spec.natKey!] ?? '')))) cloudOnly++
  }
  if (cloudOnly > 0) { failures++; console.log(`POST-VERIFY FAIL: ${spec.model} — ${cloudOnly} cloud-only rows remain`) }
}
const dupeEmails = (local.query(`SELECT email FROM users GROUP BY email HAVING COUNT(*)>1`).all() as any[]).length
const dupeSkus = (local.query(`SELECT sku FROM products WHERE sku IS NOT NULL GROUP BY sku HAVING COUNT(*)>1`).all() as any[]).length
const dupeCatNames = (local.query(`SELECT name FROM categories GROUP BY name HAVING COUNT(*)>1`).all() as any[]).length
if (dupeEmails) { failures++; console.log('POST-VERIFY FAIL: duplicate user emails:', dupeEmails) }
if (dupeSkus) { failures++; console.log('POST-VERIFY FAIL: duplicate product skus:', dupeSkus) }
if (dupeCatNames) { failures++; console.log('POST-VERIFY FAIL: duplicate category names:', dupeCatNames) }
const present = (local.query(`SELECT name FROM users`).all() as any[]).map((r) => r.name) as string[]
for (const w of ['Demo User', 'Cloud Demo', 'Sara Cloud', 'مينا', 'Amira']) if (!present.includes(w)) { failures++; console.log('POST-VERIFY FAIL: employee missing:', w) }
const devCount = (local.query(`SELECT COUNT(*) c FROM users WHERE role='developer'`).get() as any).c
if (devCount !== 1) { failures++; console.log('POST-VERIFY FAIL: developer rows =', devCount, '(must be exactly 1)') }
// old menu must still be retired locally after the pull
const oldActive = (local.query(`SELECT COUNT(*) c FROM products WHERE id BETWEEN 20 AND 49 AND active=1`).get() as any).c
if (oldActive > 0) { failures++; console.log('POST-VERIFY FAIL: old demo products active again:', oldActive) }
const oldCatsActive = (local.query(`SELECT COUNT(*) c FROM categories WHERE id IN (1,2,4) AND active=1`).get() as any).c
if (oldCatsActive > 0) { failures++; console.log('POST-VERIFY FAIL: old-only categories active again:', oldCatsActive) }

console.log('users local:', (local.query(`SELECT COUNT(*) c FROM users`).get() as any).c,
  '| neon:', (await neon.query(`SELECT COUNT(*)::int c FROM users`)).rows[0].c)
console.log('orders local:', (local.query(`SELECT COUNT(*) c FROM orders`).get() as any).c,
  '| neon:', (await neon.query(`SELECT COUNT(*)::int c FROM orders`)).rows[0].c)
console.log('old demo products active (must be 0):', oldActive, '| old cats 1,2,4 active (must be 0):', oldCatsActive)
console.log(failures === 0 ? 'POST-VERIFY: ALL PASS — converged, no duplicates, old menu still retired' : `POST-VERIFY: ${failures} FAILURES`)
await neon.end()
if (failures > 0) process.exit(1)
