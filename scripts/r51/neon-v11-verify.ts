import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
async function main() {
  const q = async (sql: string) => (await pool.query(sql)).rows
  const checks: Array<[string, string, boolean]> = []

  const extrasCat = await q(`SELECT id, name, name_ar, display_order, active FROM categories WHERE name='Extras'`)
  checks.push(['Extras category on Neon', JSON.stringify(extrasCat[0] ?? 'MISSING'), extrasCat.length === 1 && extrasCat[0].active === true])
  const extrasId = extrasCat[0]?.id

  const extras = await q(`SELECT COUNT(*)::int c FROM products WHERE sku LIKE 'LO-EX-%' AND active=true`)
  checks.push(['14 Extras products active', `${extras[0].c}/14`, extras[0].c === 14])

  const dedup = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (226,227,228,229) AND active=false`)
  checks.push(['4 duplicates deactivated', `${dedup[0].c}/4`, dedup[0].c === 4])

  const reactivated = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (55,56,57,58,59,60,139,142,170,179,181,194,219) AND active=true`)
  checks.push(['13 reactivations', `${reactivated[0].c}/13`, reactivated[0].c === 13])

  const coldSand = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (51,52,53) AND category_id=7`)
  checks.push(['cold sandwiches → Breakfast', `${coldSand[0].c}/3`, coldSand[0].c === 3])

  const rollPies = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (58,59,60,61) AND category_id=10`)
  checks.push(['roll pies → section', `${rollPies[0].c}/4`, rollPies[0].c === 4])

  const yogurt = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (220,221,222,223,224,225) AND category_id=27`)
  checks.push(['yogurt → Soft Drinks & Yogurt', `${yogurt[0].c}/6`, yogurt[0].c === 6])

  const vermicelli = await q(`SELECT COUNT(*)::int c FROM products WHERE id IN (114,115,116) AND active=false`)
  checks.push(['vermicelli retired', `${vermicelli[0].c}/3`, vermicelli[0].c === 3])

  const mazaj = await q(`SELECT COUNT(*)::int c FROM products WHERE sku LIKE 'MAZAJ-%' AND active=true`)
  checks.push(['MAZAJ shisha intact', `${mazaj[0].c}/13`, mazaj[0].c === 13])

  const mixCheese = await q(`SELECT name, price, category_id FROM products WHERE id=61`)
  checks.push(['Mix Cheese Roll Pie 230', JSON.stringify(mixCheese[0]), mixCheese[0]?.name === 'Mix Cheese Roll Pie' && Number(mixCheese[0].price) === 230 && Number(mixCheese[0].category_id) === 10])

  const renames = await q(`SELECT id, name FROM products WHERE id IN (54,65,71,77,92,98,108,169,178,180,193,207,210,218) ORDER BY id`)
  const expected: Record<number, string> = { 54: 'Cheesy Omelet', 65: 'Combo Lilo', 71: 'Cheese Fries - Large', 77: 'Lilo Salad', 92: 'Lilo Beef Sandwich', 98: 'Chicken Lilo', 108: 'Lilo Beef', 169: 'Turkish Coffee (Single)', 178: 'Espresso (Single)', 180: 'Mikato (Single)', 193: 'Light Frappuccino', 207: 'Lilo Cocktail', 210: 'Blue Lilo', 218: 'Small Water' }
  const renameOk = renames.every((r) => expected[r.id] === r.name)
  checks.push(['14 renames landed', renames.map((r) => `${r.id}:${r.name}`).join(' | '), renameOk])

  const catRenames = await q(`SELECT id, name, name_ar FROM categories WHERE id IN (8,9,11,12,25,27) ORDER BY id`)
  checks.push(['category states', catRenames.map((c) => `${c.id}:${c.name}`).join(' | '), true])

  const activeSellable = await q(`SELECT COUNT(*)::int c FROM products WHERE active=true AND is_sellable=true`)
  checks.push(['Neon active sellable', `${activeSellable[0].c} (expect 200)`, activeSellable[0].c === 200])

  const total = await q(`SELECT COUNT(*)::int c FROM products`)
  checks.push(['Neon total products', `${total[0].c} (expect 331)`, total[0].c === 331])

  let pass = 0
  for (const [name, detail, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ': ' + detail : ''}`)
    if (ok) pass++
  }
  console.log(`\n${pass}/${checks.length} NEON CHECKS PASSED`)
  await pool.end()
  process.exit(pass === checks.length ? 0 : 1)
}
main().catch(e => { console.error(e); process.exit(1) })
