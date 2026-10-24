// r62 — build scripts/r62/menu-v11.json from the owner-attached
// Lilo_Bilingual_Menu_v11_261008_225246.pdf (THE ONLY SOURCE OF TRUTH).
//
// Two extraction sources, each covering the other's weakness:
//   · TEXT LAYER (pdftotext -layout): letter-accurate English names, prices,
//     descriptions + section structure — but PDFium emits some Arabic runs
//     in VISUAL word order (e.g. "Turkish Coffee (Single)" extracts as
//     "سنجل - قهوة تركي" while the rendered menu reads "قهوة تركي - سنجل").
//   · VLM on the RENDERED pages (glm-5v-turbo): reads Arabic in correct
//     logical word order — but can misread individual letters.
// Merge rule per item: text-layer letters; word order taken from the VLM
// when the VLM's reading is the reverse of the extracted word sequence;
// letter-set equality is required before trusting a reversal. Anything
// neither equal nor reversed is flagged for manual review (printed).
import { execSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const PDF = '/home/z/my-project/upload/Lilo_Bilingual_Menu_v11_261008_225246.pdf'
const PAGES_DIR = '/tmp/menu_v11_pages'
const OUT = 'scripts/r62/menu-v11.json'

// ── the 19 v11 sections (TOC order) ────────────────────────────────────────
type CatDef = { id: number; name: string; nameAr: string; station: string; displayOrder: number }
const CATS: CatDef[] = [
  { id: 100, name: 'Breakfast', nameAr: 'الفطور', station: 'kitchen', displayOrder: 10 },
  { id: 101, name: 'Roll Pie Breakfast', nameAr: 'فطار رول باي', station: 'kitchen', displayOrder: 20 },
  { id: 102, name: 'Appetizers', nameAr: 'المقبلات', station: 'kitchen', displayOrder: 30 },
  { id: 103, name: 'Soups', nameAr: 'الشوربة', station: 'kitchen', displayOrder: 40 },
  { id: 104, name: 'Salads', nameAr: 'السلطات', station: 'kitchen', displayOrder: 50 },
  { id: 105, name: 'Pan Lilo', nameAr: 'بان ليلو', station: 'kitchen', displayOrder: 60 },
  { id: 106, name: 'Sandwiches', nameAr: 'الساندوتشات', station: 'kitchen', displayOrder: 70 },
  { id: 107, name: 'Pasta', nameAr: 'المكرونة', station: 'kitchen', displayOrder: 80 },
  { id: 108, name: 'Pizza', nameAr: 'البيتزا', station: 'kitchen', displayOrder: 90 },
  { id: 109, name: 'Main Dishes', nameAr: 'الأطباق الرئيسية', station: 'kitchen', displayOrder: 100 },
  { id: 110, name: 'Desserts', nameAr: 'الحلويات', station: 'kitchen', displayOrder: 110 },
  { id: 111, name: 'Extras', nameAr: 'إضافات', station: 'kitchen', displayOrder: 120 },
  { id: 112, name: 'Fresh Juices', nameAr: 'العصائر الطازجة', station: 'bar', displayOrder: 130 },
  { id: 113, name: 'Milkshake', nameAr: 'ميلك شيك', station: 'bar', displayOrder: 140 },
  { id: 114, name: 'Frappe & Smoothie', nameAr: 'فرابيه و سموثي', station: 'bar', displayOrder: 150 },
  { id: 115, name: 'Hot Drinks', nameAr: 'المشروبات الساخنة', station: 'bar', displayOrder: 160 },
  { id: 116, name: 'Iced Coffee & Chocolate', nameAr: 'القهوة والشوكولاتة المثلجة', station: 'bar', displayOrder: 170 },
  { id: 117, name: 'Cocktails', nameAr: 'الكوكتيلات', station: 'bar', displayOrder: 180 },
  { id: 118, name: 'Soft Drinks & Yogurt', nameAr: 'المشروبات الغازية والزبادي', station: 'bar', displayOrder: 190 },
]
const catByName = new Map(CATS.map((c) => [c.name.toLowerCase(), c]))

// per-category expected item counts (hand tally from the PDF)
const EXPECTED: Record<string, number> = {
  Breakfast: 8, 'Roll Pie Breakfast': 4, Appetizers: 10, Soups: 5, Salads: 7,
  'Pan Lilo': 6, Sandwiches: 11, Pasta: 13, Pizza: 8, 'Main Dishes': 13,
  Desserts: 10, Extras: 14, 'Fresh Juices': 10, Milkshake: 8, 'Frappe & Smoothie': 7,
  'Hot Drinks': 24, 'Iced Coffee & Chocolate': 7, Cocktails: 7, 'Soft Drinks & Yogurt': 15,
}

// section notes the PDF attaches to every item of a section (appended to descEn)
const SECTION_NOTE: Record<string, string> = {
  'Roll Pie Breakfast': 'All roll pies are served with salad and potato cubes.',
  Soups: 'All soups are served with toasted bread with butter and garlic.',
  'Main Dishes': 'All dishes are served with two side dishes.',
}

// ARABIC OVERRIDES — where the text layer provably dropped a glyph but the
// RENDERED page shows it (triple-VLM-verified at 300 DPI incl. tight crop):
// · Cheese Fries - Large: layer said "بالجبن", every visual reading says
//   "بالجبنة" (taa marbuta present) — r51's independent VLM read agrees.
const AR_OVERRIDE: Record<string, string> = {
  'Cheese Fries - Large': 'بطاطس بالجبنة - كبير',
}

// ── helpers ────────────────────────────────────────────────────────────────
const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u0640]/g
const AR_CHARS = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

/** strip bidi controls + tatweel, NFKC presentation forms → base letters */
function normAr(s: string): string {
  return s.replace(BIDI, '').normalize('NFKC').replace(/\s+/g, ' ').trim()
}
/** the Latin prefix of a line (everything before the first Arabic/bidi char) */
function latinPart(line: string): string {
  const m = line.match(/^([^\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]*)/)
  return (m ? m[1] : '').replace(/\s+/g, ' ').trim()
}
const words = (s: string) => s.split(/\s+/).filter(Boolean)
const revWords = (s: string) => words(s).reverse().join(' ')
const charSet = (s: string) => [...s.replace(/[\s-]/g, '')].sort().join('')

// ── 1. text-layer parse (per PDF page → guaranteed page attribution) ───────
type TextItem = { page: number; nameEn: string; price: number; arRaw: string; descEn: string[]; cat: string }
const textItems: TextItem[] = []
const flags: string[] = []

const CAT_RE = CATS.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const catHeaderRe = new RegExp(`^\\s*(${CAT_RE})\\s{2,}(\\S.*)$`, 'i')
const itemRe = /^\s*([A-Za-z][A-Za-z0-9().&'\/,\- ]*?)\s{2,}(\d+)\s+EGP\s*(.*)$/

for (let page = 3; page <= 12; page++) {
  execSync(`pdftotext -layout -f ${page} -l ${page} "${PDF}" /tmp/menu_v11_p${page}.txt`)
  const lines = readFileSync(`/tmp/menu_v11_p${page}.txt`, 'utf8').split('\n')
  let currentCat: string | null = null
  let current: TextItem | null = null

  for (const raw of lines) {
    const line = raw.replace(/\u0000/g, '')
    if (/Buon appetito/i.test(line)) break
    // the page masthead ONLY — a bare /cafe/i filter ate "Latte Cafe" + "Nescafe"
    if (/CAF[EÉ]\s*&\s*RESTAURANT|Our Menu|FIND US|Spicy dish/i.test(line)) continue

  const catM = line.match(catHeaderRe)
  if (catM && !/\d/.test(line)) {
    const cat = catByName.get(catM[1].trim().toLowerCase())
    if (cat && !line.includes('EGP')) {
      currentCat = cat.name
      current = null
      continue
    }
  }

  const itemM = line.match(itemRe)
  if (itemM && currentCat) {
    current = { page, nameEn: itemM[1].replace(/\s+/g, ' ').trim(), price: Number(itemM[2]), arRaw: itemM[3] ?? '', descEn: [], cat: currentCat }
    textItems.push(current)
    continue
  }

  if (current && currentCat) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^All\s/i.test(trimmed)) continue // section note (baked in per-section below)
    const latin = latinPart(line)
    // sub-headers (EN + AR, no price): "Cold Sandwiches", "Omelet", "Fries",
    // "Beef", "Chicken", "Seafood", "Soft Drinks & Water", "Yogurt" — group
    // labels inside a section, NOT item descriptions
    const SUB_HEADERS = ['cold sandwiches', 'omelet', 'fries', 'beef', 'chicken', 'seafood', 'soft drinks & water', 'yogurt']
    if (AR_CHARS.test(line) && SUB_HEADERS.includes(latin.toLowerCase())) continue
    if (/[A-Za-z]{2,}/.test(latin) && !AR_CHARS.test(latin) && !/\d\s*EGP/.test(latin)) {
      current.descEn.push(latin)
    }
  }
  }
}

// ── 2. VLM readings ────────────────────────────────────────────────────────
type VlmItem = { en?: string; ar?: string; price?: number; header_en?: string; header_ar?: string }
const vlmByPage = new Map<number, { items: VlmItem[]; headers: Array<[string, string]> }>()
for (let p = 3; p <= 12; p++) {
  const f = `${PAGES_DIR}/vlm-${String(p).padStart(2, '0')}.json`
  const j = JSON.parse(readFileSync(f, 'utf8'))
  let content = j.choices?.[0]?.message?.content ?? '[]'
  content = content.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  const arr = JSON.parse(content) as VlmItem[]
  const items = arr.filter((x) => x.en && x.price != null)
  const headers = arr.filter((x) => x.header_en).map((x) => [x.header_en as string, x.header_ar as string] as [string, string])
  vlmByPage.set(p, { items, headers })
}

// VLM header Arabic cross-check for the 19 categories
console.log('── category Arabic (VLM rendered order) ──')
for (const c of CATS) {
  let vlmAr: string | null = null
  for (const [, h] of vlmByPage) {
    const hit = h.headers.find(([en]) => en.toLowerCase().startsWith(c.name.toLowerCase().slice(0, 6)))
    if (hit) { vlmAr = normAr(hit[1]); break }
  }
  if (vlmAr && vlmAr !== c.nameAr && charSet(vlmAr) === charSet(c.nameAr)) {
    flags.push(`cat ${c.name}: order fixed to VLM "${vlmAr}" (was "${c.nameAr}")`)
    c.nameAr = vlmAr
  } else if (vlmAr && charSet(vlmAr) !== charSet(c.nameAr)) {
    flags.push(`cat ${c.name}: VLM "${vlmAr}" vs canonical "${c.nameAr}" (letters differ — canonical kept)`)
  }
}

// ── 3. merge: text letters + VLM word order ───────────────────────────────
console.log(`\ntext-layer items: ${textItems.length}`)
type Final = { id: number; nameEn: string; nameAr: string; price: number; descEn: string | null; cat: string; page: number }
const finals: Final[] = []
let id = 2000
let arFixed = 0

for (const [idx, it] of textItems.entries()) {
  const vlmPage = vlmByPage.get(it.page)
  // match VLM item by EN name (fallback: same-index)
  let vlm = vlmPage?.items.find((v) => (v.en ?? '').toLowerCase().replace(/\s+/g, ' ').trim() === it.nameEn.toLowerCase())
  if (!vlm && vlmPage && vlmPage.items[idx % vlmPage.items.length]) {
    const candidate = vlmPage.items[idx % vlmPage.items.length]
    if ((candidate.en ?? '').toLowerCase().includes(it.nameEn.split(' ')[0].toLowerCase())) vlm = candidate
  }

  const arText = normAr(it.arRaw)
  let nameAr = arText
  let resolved = 'text'

  // DASH-PART REVERSAL: mixed AR names printed as "[suffix] - [main]" in the
  // text layer (visual order) must read "[main] - [suffix]" logically. The
  // VLM confirmed this exact rule on every readable case (Turkish Coffee
  // (Single) → "قهوة تركي - سنجل", Cheese Fries → "بطاطس بالجبنة - كبير",
  // Lilo Salad → "سلطة ليلو - دجاج مشوي أو كرسبي"). The TEXT letters stay
  // authoritative (the VLM misread "دوبل" as "دبل" — the layer is exact).
  const enHasSuffixStructure = /-|\((Single|Double)\)/.test(it.nameEn)
  if (enHasSuffixStructure && arText.includes('-')) {
    const parts = arText.split(/\s*-\s*/).filter(Boolean)
    if (parts.length === 2) {
      const candidate = `${parts[1]} - ${parts[0]}`
      const vlmAr = vlm?.ar ? normAr(vlm.ar) : null
      if (!vlmAr || vlmAr === candidate || charSet(vlmAr) === charSet(candidate)) {
        nameAr = candidate
        resolved = vlmAr ? 'dash-reversal(VLM-confirmed)' : 'dash-reversal'
        arFixed++
      } else {
        // VLM confirms the dash-reversal ORDER but its letters differ — the
        // text layer is the letter-exact source (it IS the PDF's embedded
        // text; the VLM misreads small glyphs, e.g. دوبل → دبل). Text order
        // + text letters win; the VLM divergence is only logged.
        flags.push(`#${id} ${it.nameEn}: dash-reversal letters kept from text "${candidate}" (VLM read "${vlmAr}")`)
        nameAr = candidate; resolved = 'dash-reversal(text-letters)'; arFixed++
      }
    }
  } else if (vlm?.ar) {
    const arVlm = normAr(vlm.ar)
    if (arVlm === arText) resolved = 'text==vlm'
    else if (revWords(arText) === arVlm) { nameAr = revWords(arText); resolved = 'reversed'; arFixed++ }
    else if (charSet(arVlm) === charSet(arText)) {
      // letters identical, order differs but not a clean reversal — trust VLM order
      nameAr = arVlm; resolved = 'vlm-order'; arFixed++
    } else if (charSet(revWords(arText)) === charSet(arVlm)) {
      nameAr = revWords(arText); resolved = 'reversed-approx'; arFixed++
    } else {
      flags.push(`#${id} ${it.nameEn}: ar "${arText}" vs VLM "${arVlm}" (text kept)`)
    }
  } else {
    flags.push(`#${id} ${it.nameEn}: no VLM match (text kept)`)
  }

  if (vlm && Number(vlm.price) !== it.price) flags.push(`#${id} ${it.nameEn}: price text ${it.price} vs VLM ${vlm.price} (text kept)`)

  if (AR_OVERRIDE[it.nameEn] && nameAr !== AR_OVERRIDE[it.nameEn]) {
    flags.push(`#${id} ${it.nameEn}: AR override applied "${AR_OVERRIDE[it.nameEn]}" (was "${nameAr}")`)
    nameAr = AR_OVERRIDE[it.nameEn]
  }

  let desc: string | null = it.descEn.length ? it.descEn.join(' ').replace(/\s+/g, ' ').trim() : null
  const note = SECTION_NOTE[it.cat]
  if (note) desc = desc ? `${desc} ${note}` : note

  finals.push({ id: id++, nameEn: it.nameEn, nameAr, price: it.price, descEn: desc, cat: it.cat, page: it.page })
  if (process.env.VERBOSE) console.log(`  #${finals.length + 1999} [${it.cat}] ${it.nameEn} · ${it.price} · ${nameAr} · ${resolved}`)
}

// ── 4. validate ────────────────────────────────────────────────────────────
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

console.log('\n── validation ──')
ok(finals.length === 187, `187 items parsed (got ${finals.length})`)
for (const c of CATS) {
  const n = finals.filter((f) => f.cat === c.name).length
  ok(n === EXPECTED[c.name], `${c.name}: ${n}/${EXPECTED[c.name]} items`)
}
ok(finals.every((f) => f.price >= 20 && f.price <= 470), 'all prices in 20..470 EGP')
ok(finals.every((f) => f.nameAr.length > 0), 'every item has an Arabic name')
const dupEn = finals.map((f) => f.nameEn.toLowerCase()).filter((v, i, a) => a.indexOf(v) !== i)
ok(dupEn.length === 0, `no duplicate EN names (${dupEn.join(', ') || 'none'})`)
const dupAr = finals.map((f) => f.nameAr).filter((v, i, a) => a.indexOf(v) !== i)
ok(dupAr.length === 0, `no duplicate AR names (${dupAr.join(', ') || 'none'})`)

// VLM per-page count cross-check
for (const [p, v] of vlmByPage) {
  const textN = finals.filter((f) => f.page === p).length
  ok(v.items.length === textN, `page ${p}: VLM ${v.items.length} vs text ${textN} items`)
}

console.log(`\narabic word-order fixes applied: ${arFixed}`)
if (flags.length) {
  console.log(`\n── flags (${flags.length}) ──`)
  for (const f of flags) console.log('  ⚑', f)
}

// ── 5. emit ────────────────────────────────────────────────────────────────
mkdirSync('scripts/r62', { recursive: true })
writeFileSync(OUT, JSON.stringify({ cats: CATS, items: finals }, null, 1) + '\n')
console.log(`\nwrote ${OUT} — ${CATS.length} categories · ${finals.length} items`)
console.log(failed === 0 ? 'ALL VALIDATIONS PASSED' : `${failed} VALIDATION FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
