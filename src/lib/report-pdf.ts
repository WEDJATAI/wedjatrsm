'use client'

// ─── r60: Sales-report PDF export + print ──────────────────────────
// Owner request: "in the reports show paid in cash and paid by card and
// paid by others, and be able to export the report in pdf and save it or
// print it."
//
// Three layers:
//  1. Data helpers (dependency-free, shared by the view + Z-report):
//     filledPaymentMethods() — cash/card/other ALWAYS listed (zero-filled
//     when no activity) so the breakdown never silently disappears;
//     paidInMethodLabel() — "Paid in cash / Paid by card / Paid by other".
//  2. exportSalesReportPdf() — a real A4 PDF file (jsPDF + autoTable).
//     Arabic UI mode embeds Amiri and renders through a presentation-forms
//     bidi shuffler (arabic-persian-reshaper) because jsPDF has no bidi
//     engine; digits get isolated LTR runs so amounts/dates never mirror.
//  3. buildSalesReportPrintDocument() — an A4 print window (browser
//     engines shape Arabic natively, so the print path uses the plain
//     locale formatters and lets the UA do RTL).
//
// Heavy imports (jspdf) are dynamic — the reports view only pays for
// them at click time.

import type { SalesReport } from '@/lib/types'
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format'

export type Translate = (key: string, vars?: Record<string, string | number>) => string
export type ReportLang = 'en' | 'ar'

export type MethodRow = { method: string; amount: number; count: number }

// ── 1. Data helpers ────────────────────────────────────────────────

/** The three tender types the owner asked to always see, in order. */
const BASE_METHODS = ['cash', 'card', 'other'] as const

/**
 * Zero-filled payment-method rows: cash / card / other are ALWAYS present
 * (E£0.00 · 0 payments when idle) so "paid in cash / by card / by other"
 * is always on the report. Extra methods (loyalty…) appear only when they
 * actually had activity in the period.
 */
export function filledPaymentMethods(rows: MethodRow[]): MethodRow[] {
  const by = new Map<string, MethodRow>()
  for (const r of rows) by.set(r.method, r)
  const out: MethodRow[] = []
  for (const m of BASE_METHODS) {
    const r = by.get(m)
    out.push(r ?? { method: m, amount: 0, count: 0 })
    by.delete(m)
  }
  const extras = [...by.values()]
    .filter((r) => r.count > 0 || r.amount !== 0)
    .sort((a, b) => b.amount - a.amount)
  return [...out, ...extras]
}

/** "Paid in cash" / "Paid by card" / "Paid by other methods" (i18n). */
export function paidInMethodLabel(method: string, t: Translate): string {
  switch (method) {
    case 'cash':
      return t('reports.paidIn.cash')
    case 'card':
      return t('reports.paidIn.card')
    case 'other':
      return t('reports.paidIn.other')
    case 'loyalty':
      return t('reports.paidIn.loyalty')
    default:
      return method.charAt(0).toUpperCase() + method.slice(1)
  }
}

/** Locale-safe money for the PDF canvas: Latin digits + E£ (bidi-safe). */
const PDF_CURRENCY = new Intl.NumberFormat('en-EG', {
  style: 'currency',
  currency: 'EGP',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
export function pdfCurrency(n: number): string {
  return PDF_CURRENCY.format(Number.isFinite(n) ? n : 0)
}

/** 'YYYY-MM-DD' → local midnight (same semantics as the view's parseDay). */
function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

// ── 2. Arabic visual-order engine (jsPDF has no bidi) ──────────────

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F]/

/** Convert to Arabic presentation forms in logical order (joining). */
import { ArabicShaper } from 'arabic-persian-reshaper'

type Run = { ar: boolean; chars: string[] }

function classify(ch: string): 'ar' | 'digit' | 'neutral' {
  if (/\d/.test(ch) || /[\u0660-\u0669]/.test(ch)) return 'digit'
  if (/\p{Script=Arabic}/u.test(ch)) return 'ar'
  return 'neutral'
}

/**
 * Simplified bidi for display on a LTR canvas (jsPDF draws glyphs in
 * string order): split into Arabic / Latin runs (digits are always LTR
 * runs), reverse the RUN order, reshape + char-reverse the Arabic runs.
 * Pure-Latin strings pass through untouched. Good enough for report
 * labels, names and dates; amounts never enter here in mixed form.
 */
export function arabicVisual(text: string): string {
  if (!ARABIC_RE.test(text)) return text
  const runs: Run[] = []
  for (const ch of text) {
    const c = classify(ch)
    let last = runs[runs.length - 1]
    if (c === 'ar') {
      if (!last || !last.ar) {
        last = { ar: true, chars: [] }
        runs.push(last)
      }
    } else if (c === 'digit') {
      if (!last || last.ar) {
        last = { ar: false, chars: [] }
        runs.push(last)
      }
    } else if (!last) {
      last = { ar: false, chars: [] }
      runs.push(last)
    }
    last.chars.push(ch)
  }
  if (!runs.some((r) => r.ar)) return text
  const pieces: string[] = []
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]
    if (r.ar) {
      const reshaped = ArabicShaper.convertArabic(r.chars.join(''))
      pieces.push(reshaped.split('').reverse().join(''))
    } else {
      pieces.push(r.chars.join(''))
    }
  }
  return pieces.join('')
}

// ── 3. Shared option types ─────────────────────────────────────────

export type ReportExportOptions = {
  report: SalesReport
  t: Translate
  lang: ReportLang
  isRTL: boolean
  restaurantName: string
  restaurantNameAr: string
  /** 'YYYY-MM-DD' range already applied to the report */
  from: string
  to: string
}

// ── 4. Amiri font loader (cached; only fetched in Arabic mode) ─────

let amiriPromise: Promise<{ regular: string; bold: string }> | null = null

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function loadAmiri(): Promise<{ regular: string; bold: string }> {
  amiriPromise ??= (async () => {
    const [regular, bold] = await Promise.all([
      fetch('/fonts/Amiri-Regular.ttf').then((r) => {
        if (!r.ok) throw new Error(`Amiri-Regular.ttf ${r.status}`)
        return r.arrayBuffer()
      }),
      fetch('/fonts/Amiri-Bold.ttf').then((r) => {
        if (!r.ok) throw new Error(`Amiri-Bold.ttf ${r.status}`)
        return r.arrayBuffer()
      }),
    ])
    return { regular: bufToB64(regular), bold: bufToB64(bold) }
  })()
  return amiriPromise
}

// ── 5. PDF export (jsPDF + autoTable, all imports lazy) ────────────

// jsPDF/autoTable color tuples (mutable [r, g, b] — the libs' Color type).
const INK: [number, number, number] = [28, 25, 23] // stone-900
const RULE: [number, number, number] = [214, 211, 209] // stone-300
const HEAD_FILL: [number, number, number] = [245, 244, 243] // stone-100
const TOTAL_FILL: [number, number, number] = [231, 229, 228] // stone-200
const MUTED: [number, number, number] = [120, 113, 108] // stone-500
const BAR_TRACK: [number, number, number] = [231, 229, 228]
const BAR_FILLS: [number, number, number][] = [
  [28, 25, 23],
  [87, 83, 78],
  [168, 162, 158],
  [214, 211, 209],
]

export async function exportSalesReportPdf(opts: ReportExportOptions): Promise<void> {
  const { report, t, lang, restaurantName, restaurantNameAr, from, to } = opts
  const rtl = lang === 'ar'
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const autoTable = autoTableMod.default
  const cell = (s: string): string => (rtl ? arabicVisual(s) : s)

  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  // Amiri is embedded whenever the Arabic masthead is needed — even in EN UI
  // mode (helvetica has no Arabic glyphs); in AR mode the whole document
  // renders through it.
  const needsAmiri = rtl || restaurantNameAr.trim().length > 0
  if (needsAmiri) {
    const fonts = await loadAmiri()
    doc.addFileToVFS('Amiri-Regular.ttf', fonts.regular)
    doc.addFileToVFS('Amiri-Bold.ttf', fonts.bold)
    doc.addFont('Amiri-Regular.ttf', 'amiri', 'normal')
    doc.addFont('Amiri-Bold.ttf', 'amiri', 'bold')
  }
  const base = rtl ? 'amiri' : 'helvetica'

  const PAGE_W = 210
  const M = 14
  const INNER = PAGE_W - M * 2
  const generated = formatDateTime(new Date())
  // '→' (U+2192) is not WinAnsi — swap for an en dash on the PDF canvas.
  const rangeLine = `${t('admin.showingRange', {
    from: formatDate(parseDay(from)),
    to: formatDate(parseDay(to)),
  })} · ${t('admin.paidOrders', { count: report.totalOrders })}`.replace(/→/g, '–')

  doc.setProperties({
    title: `Sales Report ${from} → ${to}`,
    subject: rangeLine,
    creator: restaurantName,
  })

  // ── Header (page 1) ──
  let y = 20
  doc.setFont(base, 'bold')
  doc.setFontSize(17)
  doc.setTextColor(...INK)
  doc.text(cell(restaurantName), PAGE_W / 2, y, { align: 'center' })
  y += 6.5
  if (restaurantNameAr.trim()) {
    // Always through Amiri (shaped + visual order), even in EN mode.
    doc.setFont('amiri', 'bold')
    doc.setFontSize(12.5)
    doc.text(arabicVisual(restaurantNameAr), PAGE_W / 2, y, { align: 'center' })
    doc.setFont(base, 'bold')
    y += 6.5
  }
  doc.setFontSize(13)
  doc.text(cell(t('admin.reportTitlePdf')), PAGE_W / 2, y, { align: 'center' })
  y += 5.5
  doc.setFont(base, 'normal')
  doc.setFontSize(9.5)
  doc.text(cell(rangeLine), PAGE_W / 2, y, { align: 'center' })
  y += 4.5
  doc.setFontSize(8)
  doc.setTextColor(...MUTED)
  doc.text(
    cell(`${t('admin.pdfGeneratedAt')}: ${generated}`),
    rtl ? M : PAGE_W - M,
    y,
    { align: rtl ? 'left' : 'right' },
  )
  y += 3
  doc.setDrawColor(...RULE)
  doc.setLineWidth(0.5)
  doc.line(M, y, PAGE_W - M, y)
  y += 9

  /** Section heading: bold title + light underline; returns next y. */
  function heading(text: string, yy: number): number {
    doc.setFont(base, 'bold')
    doc.setFontSize(11.5)
    doc.setTextColor(...INK)
    doc.text(cell(text), rtl ? PAGE_W - M : M, yy, { align: rtl ? 'right' : 'left' })
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.25)
    doc.line(M, yy + 2, PAGE_W - M, yy + 2)
    doc.setFont(base, 'normal')
    return yy + 7.5
  }

  const tableTheme = {
    styles: {
      font: base,
      fontStyle: 'normal' as const,
      fontSize: 9.5,
      cellPadding: { top: 2.2, bottom: 2.2, left: 3, right: 3 },
      lineColor: RULE,
      lineWidth: 0.15,
      textColor: INK,
    },
    headStyles: {
      fillColor: HEAD_FILL,
      textColor: INK,
      fontStyle: 'bold' as const,
      halign: 'right' as const,
    },
  }

  /** Column styles: label column aligned to the reading start, numbers right. */
  function colStyles(n: number): Record<number, { halign: 'left' | 'right' }> {
    const out: Record<number, { halign: 'left' | 'right' }> = {}
    for (let i = 0; i < n; i++) {
      const labelIdx = rtl ? n - 1 : 0
      out[i] = { halign: i === labelIdx ? (rtl ? 'right' : 'left') : 'right' }
    }
    return out
  }

  /** Mirror a row for RTL (visual column order) and bidi-shape every cell. */
  type RowCells = { content: string; styles: { fontStyle?: 'bold'; fillColor?: [number, number, number] } }[]
  function row(cells: string[], total = false): RowCells {
    const shaped = cells.map(cell)
    const ordered = rtl ? [...shaped].reverse() : shaped
    return ordered.map((content) => ({
      content,
      styles: total ? { fontStyle: 'bold', fillColor: TOTAL_FILL } : {},
    }))
  }

  function afterTable(): number {
    const last = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
    return last.finalY + 10
  }

  // ── Summary ──
  y = heading(t('admin.pdfSummary'), y)
  const summaryRows: [string, string][] = [
    [t('admin.totalRevenue'), pdfCurrency(report.totalRevenue)],
    [t('admin.pdfPaidOrders'), String(report.totalOrders)],
    [t('money.avgOrderValue'), pdfCurrency(report.avgOrderValue)],
    [
      `${t('money.avgCheckPerPerson')} (${t('admin.guestsSub', { count: report.totalGuests })})`,
      pdfCurrency(report.avgCheckPerPerson),
    ],
    [
      `${t('reports.deferredOutstanding')} (${t('reports.deferredCount', { n: report.deferredCount })})`,
      pdfCurrency(report.deferredOutstanding),
    ],
  ]
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    showHead: false,
    columnStyles: colStyles(2),
    body: summaryRows.map(([l, v]) => row([l, v])),
  })
  y = afterTable()

  // ── Payments by method (always cash / card / other) ──
  y = heading(t('admin.paymentMethods'), y)
  const methods = filledPaymentMethods(report.byMethod)
  const methodTotal = methods.reduce((s, m) => s + m.amount, 0)
  // Simple proportional bars — direction-neutral, print-friendly.
  const LABEL_ZONE = 64
  const BAR_X = M + LABEL_ZONE + 2
  const BAR_W = INNER - LABEL_ZONE - 2
  let by = y + 1
  methods.forEach((m, idx) => {
    const share = methodTotal > 0 ? Math.max(0, m.amount) / methodTotal : 0
    const label = cell(paidInMethodLabel(m.method, t))
    doc.setFont(base, 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...INK)
    doc.text(label, rtl ? M + LABEL_ZONE : M, by + 3, { align: rtl ? 'right' : 'left' })
    doc.setFillColor(...BAR_TRACK)
    doc.roundedRect(BAR_X, by, BAR_W, 3.6, 1.8, 1.8, 'F')
    if (share > 0) {
      doc.setFillColor(...BAR_FILLS[idx % BAR_FILLS.length])
      doc.roundedRect(BAR_X, by, Math.max(3, BAR_W * share), 3.6, 1.8, 1.8, 'F')
    }
    by += 6.4
  })
  y = by + 2.5
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    columnStyles: colStyles(4),
    head: [[
      ...row([
        t('admin.zreportMethod'),
        t('admin.zreportCount'),
        t('money.total'),
        t('admin.pdfShare'),
      ]),
    ]],
    body: methods.map((m) =>
      row([
        paidInMethodLabel(m.method, t),
        String(m.count),
        pdfCurrency(m.amount),
        `${methodTotal > 0 ? Math.round((Math.max(0, m.amount) / methodTotal) * 100) : 0}%`,
      ]),
    ),
    foot: [[...row([t('money.total'), String(methods.reduce((s, m) => s + m.count, 0)), pdfCurrency(methodTotal), '100%'], true)]],
    footStyles: {
      fillColor: TOTAL_FILL,
      textColor: INK,
      fontStyle: 'bold' as const,
      halign: 'right' as const,
    },
  })
  y = afterTable()
  doc.setFont(base, 'normal')
  doc.setFontSize(7.8)
  doc.setTextColor(...MUTED)
  doc.text(cell(t('admin.pdfPaymentsNote')), PAGE_W / 2, y - 7, { align: 'center', maxWidth: INNER })
  y += 2

  // ── Revenue by day ──
  y = heading(t('admin.revenueByDay'), y)
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    columnStyles: colStyles(3),
    head: [[...row([t('admin.pdfDay'), t('money.orders'), t('money.revenue')])]],
    body: report.byDay.map((d) =>
      row([formatDate(parseDay(d.date)), String(d.orders), pdfCurrency(d.revenue)]),
    ),
    foot: [[...row([t('money.total'), String(report.totalOrders), pdfCurrency(report.totalRevenue)], true)]],
    footStyles: {
      fillColor: TOTAL_FILL,
      textColor: INK,
      fontStyle: 'bold' as const,
      halign: 'right' as const,
    },
  })
  y = afterTable()

  // ── Top products ──
  y = heading(t('admin.topProductsPeriod'), y)
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    columnStyles: colStyles(3),
    head: [[...row([t('common.name'), t('admin.soldQty'), t('money.revenue')])]],
    body: report.topProducts.map((p) => row([p.name, String(p.quantity), pdfCurrency(p.revenue)])),
  })
  y = afterTable()

  // ── By category ──
  y = heading(t('admin.revenueByCategory'), y)
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    columnStyles: colStyles(3),
    head: [[...row([t('common.name'), t('admin.soldQty'), t('money.revenue')])]],
    body: report.byCategory.map((c) =>
      row([c.name, String(c.quantity), pdfCurrency(c.revenue)]),
    ),
    foot: [[...row([t('money.total'), '', pdfCurrency(report.totalRevenue)], true)]],
    footStyles: {
      fillColor: TOTAL_FILL,
      textColor: INK,
      fontStyle: 'bold' as const,
      halign: 'right' as const,
    },
  })

  // ── Footers on every page ──
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.25)
    doc.line(M, 283, PAGE_W - M, 283)
    doc.setFont(base, 'normal')
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(cell(restaurantName), M, 287)
    doc.text(
      cell(t('admin.pdfPage', { n: p, total: pages })),
      PAGE_W / 2,
      287,
      { align: 'center' },
    )
    doc.text(cell(generated), PAGE_W - M, 287, { align: 'right' })
  }

  doc.save(`Sales-Report_${from}_${to}.pdf`)
}

// ── 6. Print window (browser handles RTL/shaping natively) ─────────

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

/** Full standalone A4 print document for the sales report. */
export function buildSalesReportPrintDocument(opts: ReportExportOptions): string {
  const { report, t, lang, isRTL, restaurantName, restaurantNameAr, from, to } = opts
  const methods = filledPaymentMethods(report.byMethod)
  const methodTotal = methods.reduce((s, m) => s + m.amount, 0)
  const generated = formatDateTime(new Date())
  const rangeLine = `${t('admin.showingRange', {
    from: formatDate(parseDay(from)),
    to: formatDate(parseDay(to)),
  })} · ${t('admin.paidOrders', { count: report.totalOrders })}`

  const th = (...cols: string[]) =>
    `<tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>`
  const tr = (cols: string[], cls = '') =>
    `<tr class="${cls}">${cols.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`
  const section = (title: string, bodyHtml: string) =>
    `<section><h2>${esc(title)}</h2>${bodyHtml}</section>`

  const parts: string[] = []

  // Summary
  parts.push(
    section(
      t('admin.pdfSummary'),
      `<table class="kv"><tbody>${[
        tr([t('admin.totalRevenue'), formatCurrency(report.totalRevenue)]),
        tr([t('admin.pdfPaidOrders'), String(report.totalOrders)]),
        tr([t('money.avgOrderValue'), formatCurrency(report.avgOrderValue)]),
        tr([
          `${t('money.avgCheckPerPerson')} — ${t('admin.guestsSub', { count: report.totalGuests })}`,
          formatCurrency(report.avgCheckPerPerson),
        ]),
        tr([
          `${t('reports.deferredOutstanding')} — ${t('reports.deferredCount', { n: report.deferredCount })}`,
          formatCurrency(report.deferredOutstanding),
        ]),
      ].join('')}</tbody></table>`,
    ),
  )

  // Payments by method — always cash / card / other
  parts.push(
    section(
      t('admin.paymentMethods'),
      `<table><thead>${th(
        t('admin.zreportMethod'),
        t('admin.zreportCount'),
        t('money.total'),
        t('admin.pdfShare'),
      )}</thead><tbody>${methods
        .map((m) =>
          tr([
            paidInMethodLabel(m.method, t),
            String(m.count),
            formatCurrency(m.amount),
            `${methodTotal > 0 ? Math.round((Math.max(0, m.amount) / methodTotal) * 100) : 0}%`,
          ]),
        )
        .join('')}</tbody><tfoot>${tr(
        [
          t('money.total'),
          String(methods.reduce((s, m) => s + m.count, 0)),
          formatCurrency(methodTotal),
          '100%',
        ],
        'total',
      )}</tfoot></table><p class="note">${esc(t('admin.pdfPaymentsNote'))}</p>`,
    ),
  )

  // Revenue by day
  parts.push(
    section(
      t('admin.revenueByDay'),
      `<table><thead>${th(t('admin.pdfDay'), t('money.orders'), t('money.revenue'))}</thead><tbody>${report.byDay
        .map((d) => tr([formatDate(parseDay(d.date)), String(d.orders), formatCurrency(d.revenue)]))
        .join('')}</tbody><tfoot>${tr(
        [t('money.total'), String(report.totalOrders), formatCurrency(report.totalRevenue)],
        'total',
      )}</tfoot></table>`,
    ),
  )

  // Top products
  parts.push(
    section(
      t('admin.topProductsPeriod'),
      `<table><thead>${th(t('common.name'), t('admin.soldQty'), t('money.revenue'))}</thead><tbody>${report.topProducts
        .map((p) => tr([p.name, String(p.quantity), formatCurrency(p.revenue)]))
        .join('')}</tbody></table>`,
    ),
  )

  // By category
  parts.push(
    section(
      t('admin.revenueByCategory'),
      `<table><thead>${th(t('common.name'), t('admin.soldQty'), t('money.revenue'))}</thead><tbody>${report.byCategory
        .map((c) => tr([c.name, String(c.quantity), formatCurrency(c.revenue)]))
        .join('')}</tbody><tfoot>${tr(
        [t('money.total'), '—', formatCurrency(report.totalRevenue)],
        'total',
      )}</tfoot></table>`,
    ),
  )

  return `<!DOCTYPE html>
<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${lang}">
<head>
<meta charset="utf-8">
<title>${esc(t('admin.reportTitlePdf'))} — ${esc(from)} → ${esc(to)}</title>
<style>
  @page { size: A4; margin: 13mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Amiri, serif; font-size: 12px; line-height: 1.55; color: #1c1917; margin: 0; }
  header { text-align: center; margin-bottom: 10px; }
  header h1 { font-size: 21px; margin: 0; }
  header .ar { font-size: 15px; font-weight: 700; margin: 2px 0; }
  header .title { font-size: 15px; font-weight: 700; margin: 6px 0 2px; }
  header .range { font-size: 11px; color: #57534e; }
  header .gen { font-size: 10px; color: #78716c; margin-top: 2px; }
  header .rule { display: block; border-top: 1px solid #d6d3d1; margin: 8px 0 14px; }
  section { margin-bottom: 14px; }
  section h2 { font-size: 13.5px; margin: 0 0 6px; padding-bottom: 3px; border-bottom: 1px solid #e7e5e4; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #d6d3d1; padding: 4px 8px; text-align: start; }
  th { background: #f5f5f4; font-weight: 700; }
  td:nth-child(n+2), th:nth-child(n+2) { text-align: end; }
  table.kv td { border: none; padding: 3px 8px 3px 0; }
  table.kv td:nth-child(2) { font-weight: 600; text-align: end; white-space: nowrap; }
  tfoot td, tr.total td { background: #e7e5e4; font-weight: 700; }
  p.note { font-size: 10px; color: #78716c; margin: 6px 0 0; }
  @media print { body { font-size: 11.5px; } section { break-inside: avoid; } }
</style>
</head>
<body>
<header>
  <h1>${esc(restaurantName)}</h1>
  ${restaurantNameAr.trim() ? `<p class="ar" dir="rtl">${esc(restaurantNameAr)}</p>` : ''}
  <p class="title">${esc(t('admin.reportTitlePdf'))}</p>
  <p class="range">${esc(rangeLine)}</p>
  <p class="gen">${esc(t('admin.pdfGeneratedAt'))}: ${esc(generated)}</p>
  <span class="rule"></span>
</header>
${parts.join('\n')}
</body>
</html>`
}
