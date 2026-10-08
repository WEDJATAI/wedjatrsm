/**
 * r38-6b verification — source-level coverage check for the follow-up
 * outbox wiring (sub-routes + nested writes).
 *
 * Same style as r38-6a's verify-emit-wiring.ts:
 *   1. split each route file into exported handler blocks (GET/POST/PUT/
 *      PATCH/DELETE);
 *   2. every WRITE handler (POST/PUT/PATCH/DELETE) must contain at least one
 *      `emitOutboxEvent(` call;
 *   3. collect the emitted entity names per handler and compare them with the
 *      EXPECTED coverage map below;
 *   4. flag any handler that performs a Prisma write (tx.<model>.create/
 *      update/upsert/delete/deleteMany) without emitting for it.
 *
 * Run: bun scripts/r38/verify-emit-wiring-2.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// run from the repo root (bun scripts/r38/verify-emit-wiring-2.ts)
const ROOT = process.cwd()

type HandlerSpec = {
  /** exported verb */
  method: string
  /** entity names (order-insensitive) the handler is expected to emit */
  entities: string[]
}

const EXPECTED: Record<string, HandlerSpec[]> = {
  'src/app/api/suppliers/[id]/route.ts': [
    { method: 'PUT', entities: ['Supplier'] },
    { method: 'DELETE', entities: ['Supplier'] },
  ],
  'src/app/api/stock-counts/[id]/route.ts': [{ method: 'PATCH', entities: ['StockCount'] }],
  'src/app/api/stock-counts/[id]/counts/route.ts': [
    { method: 'PUT', entities: ['StockCountLine'] },
  ],
  'src/app/api/stock-counts/[id]/post/route.ts': [
    { method: 'POST', entities: ['StockCount', 'InventoryTransaction', 'Product'] },
  ],
  'src/app/api/purchase-orders/[id]/route.ts': [
    {
      method: 'PATCH',
      entities: ['PurchaseOrder', 'PurchaseOrderItem', 'InventoryTransaction', 'Product'],
    },
  ],
  'src/app/api/products/[id]/sold-out/route.ts': [{ method: 'PATCH', entities: ['Product'] }],
  'src/app/api/recipes/[id]/route.ts': [{ method: 'DELETE', entities: ['RecipeComponent'] }],
  // first-wave file, revisited: the nested initial-stock ledger row now also
  // rides the outbox in addition to the already-wired Product 'create'
  'src/app/api/products/route.ts': [
    { method: 'POST', entities: ['Product', 'InventoryTransaction'] },
  ],
}

type Block = { method: string; source: string }

/** Split a route file into exported handler blocks. */
function handlerBlocks(src: string): Block[] {
  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/g
  const marks: { method: string; start: number }[] = []
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    marks.push({ method: m[1], start: m.index })
  }
  return marks.map((mark, i) => ({
    method: mark.method,
    source: src.slice(
      mark.start,
      i + 1 < marks.length ? marks[i + 1].start : undefined,
    ),
  }))
}

/** Entities emitted inside a handler block (deduped, source order). */
function emittedEntities(block: string): string[] {
  const found: string[] = []
  const re = /emitOutboxEvent\(/g
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    const window = block.slice(m.index, m.index + 200)
    const ent = /entity:\s*'([A-Za-z]+)'/.exec(window)?.[1]
    if (ent && !found.includes(ent)) found.push(ent)
  }
  return found
}

/** Prisma write models referenced in a block (e.g. tx.category.update). */
function writtenModels(block: string): string[] {
  const found: string[] = []
  const re = /\b(?:db|tx)\.([a-zA-Z]+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g
  for (let m = re.exec(block); m !== null; m = re.exec(block)) {
    if (!found.includes(m[1])) found.push(m[1])
  }
  return found
}

const WRITE_VERBS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let failures = 0
const rows: string[][] = []

for (const [file, specs] of Object.entries(EXPECTED)) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  const blocks = handlerBlocks(src)

  for (const spec of specs) {
    const block = blocks.find((b) => b.method === spec.method)
    if (!block) {
      failures++
      rows.push([file, spec.method, 'MISSING HANDLER', '—'])
      continue
    }
    const actual = emittedEntities(block.source)
    const missing = spec.entities.filter((e) => !actual.includes(e))
    // any emitted entity must be a registry name (defensive — catches typos)
    const registryNames = new Set([
      'Product', 'Category', 'ModifierGroup', 'Modifier', 'RecipeComponent',
      'Promotion', 'Supplier', 'PurchaseOrder', 'PurchaseOrderItem',
      'StockCount', 'StockCountLine', 'CustomRole', 'Order', 'OrderItem',
      'Payment', 'Customer', 'Reservation', 'RestaurantTable', 'FloorPlan',
      'Shift', 'Attendance', 'CashDrawerEntry', 'CashDrawerSession',
      'InventoryTransaction', 'WasteLog', 'AuditLog', 'Person',
    ])
    const nonRegistry = actual.filter((e) => !registryNames.has(e))
    // forbidden entities must never be emitted (task rule)
    const forbidden = actual.filter((e) => e === 'User' || e === 'ProductModifierGroup')

    const ok = missing.length === 0 && nonRegistry.length === 0 && forbidden.length === 0
    if (!ok) failures++
    rows.push([
      file,
      spec.method,
      actual.length > 0 ? actual.join(', ') : '(none)',
      ok
        ? 'OK'
        : `FAIL missing=[${missing.join(',')}] nonRegistry=[${nonRegistry.join(',')}] forbidden=[${forbidden.join(',')}]`,
    ])
  }

  // any OTHER write handler present must also emit (catch-all)
  for (const block of blocks) {
    if (!WRITE_VERBS.has(block.method)) continue
    if (specs.some((s) => s.method === block.method)) continue
    const actual = emittedEntities(block.source)
    const writes = writtenModels(block.source)
    if (writes.length > 0 && actual.length === 0) {
      failures++
      rows.push([file, block.method, '(none)', `FAIL writes=[${writes.join(',')}] without emit`])
    }
  }
}

// ── report ────────────────────────────────────────────────────────────
const fileW = Math.max(...rows.map((r) => r[0].length)) + 1
const methodW = 7
const covW = Math.max(...rows.map((r) => r[2].length), 10) + 1
console.log(
  `${'file'.padEnd(fileW)}${'handler'.padEnd(methodW + 1)}${'entities emitted'.padEnd(covW)}status`,
)
console.log('-'.repeat(fileW + methodW + covW + 8))
for (const [file, method, cov, status] of rows) {
  console.log(
    `${file.padEnd(fileW)}${method.padEnd(methodW + 1)}${cov.padEnd(covW)}${status}`,
  )
}
console.log('-'.repeat(fileW + methodW + covW + 8))
console.log(
  `${rows.length} handler checks · ${failures === 0 ? 'ALL OK' : `${failures} FAILURE(S)`}`,
)
process.exit(failures === 0 ? 0 : 1)
