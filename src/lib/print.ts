'use client'

// ─── Shared print-window infrastructure (R11) ─────────────────────────
// Extracted from the check-modal's popup print pattern so kitchen prep
// tickets, guest checks and receipts can share one implementation.
// The lib stays i18n-free: every human label is passed in RESOLVED by the
// caller (components own the useI18n → labels mapping, see
// kitchen-order-card.tsx `kitchenTicketLabels`).
//
// R12: station routing — `printKitchenTicketsByStation` groups the order's
// items by product station and renders ONE print document with MULTIPLE
// 80mm ticket sections (one per station, page-break separated) so kitchens
// without a screen get per-station prep tickets. Items without a station
// (or an unknown one) land in the 'MAIN KITCHEN' section.

import { STATIONS, STATION_LABELS } from '@/lib/constants'

/** Escape a string for safe inclusion in generated print-window HTML
 *  (user names, notes, table names…). Mirrors pos-utils.ts escapeHtml. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type PrintWindowOptions = {
  /** document/tab title (browser tab + print header) */
  title?: string
  /** popup size in px (default 380×640 — 80mm-style paper) */
  width?: number
  height?: number
}

/**
 * Print an HTML fragment in a popup window — the classic receipt pattern:
 * open a named window, write a full document, then trigger print().
 *
 * The window is NAMED 'rms-print' so consecutive prints reuse the SAME tab
 * (the KDS "print all new" button fires one ticket per order without
 * spawning a window per order). The caller's html may start with its own
 * `<style>` block for paper-specific styling.
 *
 * Throws `Error('popup blocked')` when the browser refuses the popup.
 */
export function printHtml(html: string, opts: PrintWindowOptions = {}): void {
  const width = opts.width ?? 380
  const height = opts.height ?? 640
  const w = window.open('', 'rms-print', `width=${width},height=${height}`)
  if (!w) throw new Error('popup blocked')
  w.document.open()
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
      opts.title ?? 'Print',
    )}</title></head><body>${html}</body></html>`,
  )
  w.document.close()
  w.focus()
  w.print()
}

// ─── Kitchen prep tickets (80mm, big fonts for line cooks) ───────────

/** One line on a kitchen ticket. `modifiers` arrive pre-localized. */
export type KitchenTicketItem = {
  name: string
  /** appended in parens after the name when present: `2× Falafel (فلافل)` */
  nameAr?: string | null
  quantity: number
  /** emphasized in CAPS with a ⚠ prefix when present */
  notes?: string | null
  course?: string | null
  /** 'new' | 'preparing' | 'ready' | 'served' — non-new items get a suffix */
  status?: string | null
  /** pre-localized option sub-lines, e.g. ['Extra Tahini', 'No ice'] */
  modifiers?: string[]
  /** R12: station routing key from the product ('hot'|'cold'|'bar'|'dessert');
   *  null/unknown → the MAIN KITCHEN section. Callers without station data
   *  simply omit it (everything prints as one main-kitchen ticket). */
  station?: string | null
}

export type KitchenTicketOrder = {
  id: number
  /** null + takeaway=true → the ticket shows the takeaway label */
  tableName: string | null
  takeaway: boolean
  guests: number
  waiter: string
  /** when the items were fired at the kitchen (order # or send time) */
  sentAt: string | Date
  items: KitchenTicketItem[]
}

/** Fully-resolved ticket labels — the caller maps useI18n t() into these. */
export type KitchenTicketLabels = {
  /** paper title, e.g. 'KITCHEN TICKET' */
  title: string
  /** rotated stamp for fresh tickets, e.g. 'NEW' */
  newStamp: string
  order: string
  table: string
  waiter: string
  guests: string
  takeaway: string
  printedAt: string
  /** course display names keyed by course id (starter/main/dessert/drink) */
  courses: Record<string, string>
  /** item-status suffixes keyed by status id (new/preparing/ready/served) */
  statuses?: Record<string, string>
  /** R12: station display names keyed by station id (hot/cold/bar/dessert);
   *  falls back to STATION_LABELS when omitted. */
  stations?: Record<string, string>
  /** R12: section header for items without a station (default 'MAIN KITCHEN') */
  mainStation?: string
}

/** Course grouping order on the ticket; unknown/empty courses land in main. */
const TICKET_COURSE_ORDER: readonly string[] = ['starter', 'main', 'dessert', 'drink']

/** Qty without trailing zeros (2 → '2', 1.5 → '1.5'). */
function ticketQty(q: number): string {
  if (!Number.isFinite(q)) return '0'
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, '')
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** HH:MM (24h) — the kitchen fire time. */
function hhmm(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Full local timestamp for the printed-at footer. */
function ticketStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm(d)}`
}

const TICKET_CSS = `<style>
body{font-family:'Courier New',monospace;font-size:17px;font-weight:bold;color:#000;background:#fff;margin:0;padding:20px 14px;width:320px;box-sizing:border-box}
h3,p{margin:3px 0}
.rest{text-align:center;font-size:19px;margin:0 0 2px}
.title{text-align:center;font-size:22px;letter-spacing:2px;margin:6px 0 2px}
.stampline{text-align:center;margin:10px 0}
.stampd{display:inline-block;border:3px solid #000;padding:2px 14px;transform:rotate(-6deg);letter-spacing:4px}
.hr{margin:10px 0;white-space:nowrap;overflow:hidden}
.r{display:flex;justify-content:space-between;margin:3px 0}
.course{text-align:center;margin:10px 0 3px;letter-spacing:1px}
.item{margin:4px 0;font-size:18px}
.mod{margin:1px 0 1px 16px;font-weight:normal;font-size:15px}
.warn{margin:2px 0 2px 8px;font-size:16px;text-decoration:underline}
.foot{text-align:center;font-size:12px;font-weight:normal;margin-top:10px}
.stationline{text-align:center;margin:6px 0 2px}
.station{display:inline-block;border:3px solid #000;padding:3px 12px;letter-spacing:3px;font-size:20px}
.tix{padding:20px 14px;box-sizing:border-box;page-break-after:always;break-after:page}
.tix:last-child{page-break-after:auto;break-after:auto}
</style>`

/**
 * Ticket BODY lines (no CSS) for a subset of the order's items — shared by
 * the single-ticket builder below and the R12 station-routed builder.
 * 80mm-style prep ticket body (monospace, bold, high-contrast, ~320px wide,
 * big fonts so the line reads it at a glance). Items are grouped by course
 * (starter → main → dessert → drink; unknown → main), modifiers get
 * indented sub-lines, notes shout in caps with ⚠, and non-new items carry
 * a status suffix like (READY). The NEW stamp is shown only when at least
 * one item in THIS section is still fresh (status 'new' or unset) — a
 * reprint of an in-progress order stays unstamped.
 */
function ticketSectionLines(params: {
  restaurantName: string
  order: KitchenTicketOrder
  labels: KitchenTicketLabels
  items: KitchenTicketItem[]
  /** R12: station header printed under the title (station-routed tickets). */
  stationName?: string
  now: Date
}): string[] {
  const { restaurantName, order, labels, items } = params
  const now = params.now
  const divider = '<p class="hr">────────────────────────────────</p>'
  const row = (l: string, r: string) =>
    `<p class="r"><span>${escapeHtml(l)}</span><span>${escapeHtml(r)}</span></p>`

  // Group items by course (unknown/empty course → main).
  const byCourse = new Map<string, KitchenTicketItem[]>()
  for (const item of items) {
    let course = (item.course ?? '').trim().toLowerCase()
    if (!TICKET_COURSE_ORDER.includes(course)) course = 'main'
    const bucket = byCourse.get(course)
    if (bucket) bucket.push(item)
    else byCourse.set(course, [item])
  }

  const lines: string[] = []
  lines.push(`<h3 class="rest">${escapeHtml(restaurantName)}</h3>`)
  lines.push(`<p class="title">${escapeHtml(labels.title.toUpperCase())}</p>`)
  if (params.stationName) {
    lines.push(
      `<p class="stationline"><span class="station">${escapeHtml(
        params.stationName.toUpperCase(),
      )}</span></p>`,
    )
  }

  // NEW stamp only while something on the ticket is still fresh.
  const hasFresh = items.some((it) => !it.status || it.status === 'new')
  if (hasFresh) {
    lines.push(`<p class="stampline"><span class="stampd">${escapeHtml(labels.newStamp)}</span></p>`)
  }

  lines.push(divider)
  const tableLabel = order.takeaway || !order.tableName
    ? labels.takeaway
    : `${labels.table} ${order.tableName}`
  const sentAt = order.sentAt instanceof Date ? order.sentAt : new Date(order.sentAt)
  const sentTime = Number.isNaN(sentAt.getTime()) ? hhmm(now) : hhmm(sentAt)
  lines.push(row(`${labels.order} #${order.id} · ${tableLabel}`, sentTime))
  lines.push(row(labels.guests, String(order.guests)))
  lines.push(row(labels.waiter, order.waiter))
  lines.push(divider)

  for (const course of TICKET_COURSE_ORDER) {
    const courseItems = byCourse.get(course)
    if (!courseItems || courseItems.length === 0) continue
    lines.push(
      `<p class="course">── ${escapeHtml((labels.courses[course] ?? course).toUpperCase())} ──</p>`,
    )
    for (const item of courseItems) {
      const nameAr = (item.nameAr ?? '').trim()
      const arSuffix =
        nameAr && nameAr !== item.name ? ` (${escapeHtml(nameAr)})` : ''
      const statusSuffix =
        item.status && item.status !== 'new'
          ? ` (${escapeHtml(labels.statuses?.[item.status] ?? item.status.toUpperCase())})`
          : ''
      lines.push(
        `<p class="item">${ticketQty(item.quantity)}× ${escapeHtml(item.name)}${arSuffix}${statusSuffix}</p>`,
      )
      for (const mod of item.modifiers ?? []) {
        if (!mod.trim()) continue
        lines.push(`<p class="mod">+ ${escapeHtml(mod)}</p>`)
      }
      if (item.notes && item.notes.trim()) {
        lines.push(`<p class="warn">⚠ ${escapeHtml(item.notes.trim().toUpperCase())}</p>`)
      }
    }
  }

  lines.push(divider)
  lines.push(
    `<p class="foot">${escapeHtml(labels.printedAt)} ${ticketStamp(now)} · ${escapeHtml(
      restaurantName,
    )}</p>`,
  )
  return lines
}

/**
 * PURE builder for an 80mm-style kitchen prep ticket (monospace, bold,
 * high-contrast, ~320px wide, big fonts so the line reads it at a glance).
 * Items are grouped by course (starter → main → dessert → drink; unknown →
 * main), modifiers get indented sub-lines, notes shout in caps with ⚠, and
 * non-new items carry a status suffix like (READY). The NEW stamp is shown
 * only when at least one item on the ticket is still fresh (status 'new' or
 * unset) — a reprint of an in-progress order stays unstamped.
 */
export function buildKitchenTicketHtml(params: {
  restaurantName: string
  order: KitchenTicketOrder
  labels: KitchenTicketLabels
  now?: Date
}): string {
  const lines = ticketSectionLines({
    restaurantName: params.restaurantName,
    order: params.order,
    labels: params.labels,
    items: params.order.items,
    now: params.now ?? new Date(),
  })
  return `${TICKET_CSS}${lines.join('\n')}`
}

// ─── R12: station-routed kitchen tickets ─────────────────────────────

/** Section key for items without (or with an unknown) station. */
const MAIN_STATION = 'main'

/** Extra CSS for the multi-section document: the body keeps width/font, the
 *  page padding moves to each `.tix` section, and every section but the last
 *  ends with an explicit page break (one physical 80mm ticket per station). */
const STATION_DOC_CSS = `<style>body{padding:0}</style>`

/**
 * PURE builder for the station-routed prep-ticket document: ONE HTML page
 * holding MULTIPLE 80mm ticket sections — the order's items grouped by
 * product station (course grouping preserved WITHIN each section), sections
 * separated by CSS page breaks so each station gets its own physical ticket.
 * Station order: main kitchen first, then the canonical STATIONS sequence.
 * Station names resolve from labels.stations (i18n) → STATION_LABELS → id.
 */
export function buildKitchenTicketsByStationHtml(params: {
  restaurantName: string
  order: KitchenTicketOrder
  labels: KitchenTicketLabels
  now?: Date
}): string {
  const { order, labels } = params
  const now = params.now ?? new Date()

  // Group items by station (null/empty/unknown → main kitchen).
  const groups = new Map<string, KitchenTicketItem[]>()
  for (const item of order.items) {
    let station = (item.station ?? '').trim().toLowerCase()
    if (!(STATIONS as readonly string[]).includes(station)) station = MAIN_STATION
    const bucket = groups.get(station)
    if (bucket) bucket.push(item)
    else groups.set(station, [item])
  }

  // No items at all (or nothing station-routable): plain empty ticket.
  if (groups.size === 0) {
    const lines = ticketSectionLines({
      restaurantName: params.restaurantName,
      order,
      labels,
      items: [],
      now,
    })
    return `${TICKET_CSS}${lines.join('\n')}`
  }

  const stationName = (station: string): string => {
    if (station === MAIN_STATION) {
      return labels.mainStation ?? 'MAIN KITCHEN'
    }
    return labels.stations?.[station] ?? STATION_LABELS[station] ?? station
  }

  const sections: string[] = []
  for (const station of [MAIN_STATION, ...STATIONS]) {
    const items = groups.get(station)
    if (!items || items.length === 0) continue
    const lines = ticketSectionLines({
      restaurantName: params.restaurantName,
      order,
      labels,
      items,
      stationName: stationName(station),
      now,
    })
    sections.push(`<div class="tix">${lines.join('\n')}</div>`)
  }
  return `${TICKET_CSS}${STATION_DOC_CSS}${sections.join('\n')}`
}

/**
 * Convenience: build + print the station-routed kitchen tickets in one call
 * (ONE window/document, one section per station — page-break separated).
 * Returns true on success, false when the popup was blocked (never throws —
 * a failed print must not break the POS send flow).
 */
export function printKitchenTicketsByStation(
  order: KitchenTicketOrder,
  labels: KitchenTicketLabels,
  restaurantName: string,
): boolean {
  try {
    const html = buildKitchenTicketsByStationHtml({ restaurantName, order, labels })
    printHtml(html, { title: labels.title, width: 380, height: 640 })
    return true
  } catch {
    return false
  }
}

/**
 * Convenience: build + print a kitchen ticket in one call.
 * Returns true on success, false when the popup was blocked (never throws —
 * a failed print must not break the POS send flow).
 */
export function printKitchenTicket(
  order: KitchenTicketOrder,
  labels: KitchenTicketLabels,
  restaurantName: string,
): boolean {
  try {
    const html = buildKitchenTicketHtml({ restaurantName, order, labels })
    printHtml(html, { title: labels.title, width: 380, height: 640 })
    return true
  } catch {
    return false
  }
}
