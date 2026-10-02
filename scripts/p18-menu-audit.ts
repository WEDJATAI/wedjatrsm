/** p18 menu audit — categories, products, variants analysis. Read-only. */
import { Database } from 'bun:sqlite'

const db = new Database('db/custom.db', { readonly: true })

const cats = db.query('select id, name, name_ar as nameAr, display_order as sortOrder, active from categories order by display_order').all() as any[]
console.log('=== CATEGORIES (' + cats.length + ') ===')
for (const c of cats) {
  const n = (db.query('select count(*) c from products where category_id = ? and active = 1').get(c.id) as any).c
  console.log(
    String(c.id).padStart(3), '|',
    String(c.sortOrder).padStart(3), '|',
    c.active ? 'ACT ' : 'ina ', '|',
    String(c.name).padEnd(26), '|',
    String(c.nameAr ?? '').padEnd(18), '|',
    'items:', n,
  )
}

console.log('\n=== ACTIVE PRODUCTS BY CATEGORY ===')
const prods = db.query('select p.id, p.name, p.name_ar as nameAr, p.price, p.category_id as categoryId, c.name catName from products p left join categories c on c.id = p.category_id where p.active = 1 order by p.category_id, p.name').all() as any[]
let last = ''
for (const p of prods) {
  if (p.catName !== last) { console.log('\n--- ' + p.catName + ' ---'); last = p.catName }
  console.log(String(p.id).padStart(4), '|', String(p.name).padEnd(42), '|', String(p.nameAr ?? '').padEnd(30), '|', p.price)
}

console.log('\n=== MODIFIER GROUPS ===')
const mgs = db.query('select id, name, name_ar as nameAr, min_select as minSelect, max_select as maxSelect from modifier_groups').all() as any[]
for (const m of mgs) {
  const mods = db.query('select name, price_delta as priceDelta from modifiers where group_id = ?').all(m.id) as any[]
  const linked = db.query('select p.name from product_modifier_groups pmg join products p on p.id = pmg.product_id where pmg.modifier_group_id = ?').all(m.id) as any[]
  console.log('#' + m.id, m.name, '(ar:', m.nameAr + ')', 'min/max:', m.minSelect + '/' + m.maxSelect)
  console.log('   options:', mods.map(x => x.name + (x.priceDelta ? ' +' + x.priceDelta : '')).join(' · '))
  console.log('   linked to:', linked.map(x => x.name).join(' · ') || '(none)')
}

console.log('\n=== VARIANT SUSPECTS (same first word, likely type-variants) ===')
const byFirst: Record<string, string[]> = {}
for (const p of prods) {
  const first = p.name.split(' ')[0].toLowerCase()
  ;(byFirst[first] = byFirst[first] ?? []).push(p.name + ' [' + p.catName + ']')
}
for (const [k, v] of Object.entries(byFirst)) {
  if (v.length >= 3) console.log(k.toUpperCase() + ':', v.length, '→', v.slice(0, 8).join(' | '))
}

db.close()
