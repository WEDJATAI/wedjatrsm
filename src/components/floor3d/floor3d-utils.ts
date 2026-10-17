/**
 * r56: 3D floor plan — pure geometry/palette helpers (no React, no three).
 *
 * World mapping: the floor box (widthUnits × heightUnits, % of a 100×100
 * reference) maps to world units /10 — a full 100×100 floor is 10×10 units.
 * X → right, Z → toward the viewer (floor "depth" = the 2D canvas height
 * axis), Y → up. Tables/chairs use realistic-but-compact proportions with
 * deliberately SMALL chairs (owner directive): a chair seat is 0.30 wide
 * against a 1.55-square table top — furniture that reads at a glance
 * without crowding the layout.
 */

import type { FloorPlan, FloorSpace, RestaurantTable } from '@/lib/types'
import { clampPointToFloor } from '@/lib/floor-geometry'

// ── world mapping ─────────────────────────────────────────────────────

export type FloorWorld = { w: number; d: number }

export function floorWorld(plan: FloorPlan): FloorWorld {
  return { w: (plan.widthUnits ?? 100) / 10, d: (plan.heightUnits ?? 100) / 10 }
}

/** Floor-relative % (0–100, y down) → world (x, z). */
export function percentToWorld(
  px: number,
  py: number,
  floor: FloorWorld,
): { x: number; z: number } {
  return { x: (px / 100 - 0.5) * floor.w, z: (py / 100 - 0.5) * floor.d }
}

/** World (x, z) → floor-relative % (0–100, y down). */
export function worldToPercent(
  x: number,
  z: number,
  floor: FloorWorld,
): { x: number; y: number } {
  return { x: (x / floor.w + 0.5) * 100, y: (z / floor.d + 0.5) * 100 }
}

/** Clamp a floor-relative % point into the walkable silhouette (1-decimal). */
export function clampPercentToShape(
  shape: string,
  x: number,
  y: number,
): { x: number; y: number } {
  const clamped = clampPointToFloor(shape, x, y)
  return { x: Math.round(clamped.x * 10) / 10, y: Math.round(clamped.y * 10) / 10 }
}

// ── table furniture proportions (world units) ─────────────────────────

export type TableDims = { w: number; d: number; round: boolean }

export const TABLE_TOP_H = 0.74
export const TABLE_TOP_T = 0.07

/** Table-top footprint per tile shape (world units). */
export function tableDims(shape: string): TableDims {
  switch (shape) {
    case 'round':
      return { w: 1.55, d: 1.55, round: true }
    case 'rectangle':
      return { w: 2.35, d: 1.15, round: false }
    case 'oval':
      return { w: 2.35, d: 1.15, round: true }
    case 'square':
    default:
      return { w: 1.55, d: 1.55, round: false }
  }
}

// ── chairs — deliberately SMALL (owner directive r56) ─────────────────

export const CHAIR_SEAT_W = 0.3
export const CHAIR_SEAT_D = 0.3
export const CHAIR_SEAT_H = 0.42
export const CHAIR_BACK_H = 0.24

export type ChairSlot = { x: number; z: number; rotY: number }

/**
 * Seat slots around a table for its capacity. Round/oval tops get a radial
 * ring; rectilinear tops distribute round-robin over the four edges. Every
 * chair faces the table center.
 */
export function chairLayout(table: RestaurantTable, dims: TableDims): ChairSlot[] {
  const n = Math.max(0, Math.min(14, Math.floor(table.capacity ?? 2)))
  if (n === 0) return []
  if (dims.round) {
    const rX = dims.w / 2 + 0.3
    const rZ = dims.d / 2 + 0.3
    const slots: ChairSlot[] = []
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2 - Math.PI / 2
      slots.push({
        x: Math.cos(theta) * rX,
        z: Math.sin(theta) * rZ,
        rotY: Math.PI / 2 - theta,
      })
    }
    return slots
  }
  // rectilinear: round-robin over edges [top, right, bottom, left]
  const perEdge: number[][] = [[], [], [], []]
  for (let i = 0; i < n; i++) perEdge[i % 4].push(i)
  const slots: ChairSlot[] = new Array(n)
  const marginX = dims.w / 2 + 0.28
  const marginZ = dims.d / 2 + 0.28
  perEdge.forEach((members, edge) => {
    members.forEach((slotIndex, j) => {
      const t = members.length === 1 ? 0 : (j / (members.length - 1)) * 2 - 1 // -1..1
      if (edge === 0) slots[slotIndex] = { x: t * (dims.w / 2 - 0.15), z: -marginZ, rotY: Math.PI }
      else if (edge === 2) slots[slotIndex] = { x: t * (dims.w / 2 - 0.15), z: marginZ, rotY: 0 }
      else if (edge === 1) slots[slotIndex] = { x: marginX, z: t * (dims.d / 2 - 0.1), rotY: Math.PI / 2 }
      else slots[slotIndex] = { x: -marginX, z: t * (dims.d / 2 - 0.1), rotY: -Math.PI / 2 }
    })
  })
  return slots
}

// ── status palette (3D hex — mirrors the 2D Tailwind heat classes) ────

export type TableStatusVisual = {
  halo: string | null
  label: string
  amount: string | null
}

export function occupiedHeatColor(mins: number): string {
  if (mins < 15) return '#34d399' // emerald-400
  if (mins < 45) return '#fbbf24' // amber-400
  if (mins < 90) return '#fb923c' // orange-400
  return '#fb7185' // rose-400
}

export function minutesSince(iso: string | null | undefined): number {
  if (!iso) return 0
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000)
}

export function tableStatusVisual(table: RestaurantTable): TableStatusVisual {
  const occupied = table.status === 'occupied' || table.openOrderId != null
  if (occupied) {
    const color = occupiedHeatColor(minutesSince(table.openOrderSince))
    return { halo: color, label: 'occupied', amount: color }
  }
  switch (table.status) {
    case 'reserved':
      return { halo: '#f59e0b', label: 'reserved', amount: '#b45309' }
    case 'paid':
      return { halo: '#059669', label: 'paid', amount: '#059669' }
    case 'deferred':
      return { halo: '#8b5cf6', label: 'deferred', amount: '#7c3aed' }
    case 'dirty':
      return { halo: '#d97706', label: 'dirty', amount: '#b45309' }
    default:
      return { halo: null, label: 'free', amount: '#78716c' }
  }
}

// ── custom spaces (r56) ───────────────────────────────────────────────

export type SpaceKindMeta = {
  /** platform tint (muted, warm — blends with the stone/amber theme) */
  color: string
  /** small accent props rendered on the platform */
  accent: 'sofas' | 'counter' | 'riser' | 'rope' | 'balls' | 'plants' | 'none'
  /** lucide icon name hint for the label chip */
  icon: 'sofa' | 'martini' | 'music' | 'crown' | 'baby' | 'sprout' | 'footprints' | 'utensils' | 'shapes'
}

export const SPACE_KIND_META: Record<string, SpaceKindMeta> = {
  lounge: { color: '#d8c8ae', accent: 'sofas', icon: 'sofa' },
  bar: { color: '#c8a687', accent: 'counter', icon: 'martini' },
  stage: { color: '#b58a5f', accent: 'riser', icon: 'music' },
  vip: { color: '#cdb45a', accent: 'rope', icon: 'crown' },
  kids: { color: '#f0b28c', accent: 'balls', icon: 'baby' },
  greenery: { color: '#a7bfa0', accent: 'plants', icon: 'sprout' },
  walkway: { color: '#e9e3d6', accent: 'none', icon: 'footprints' },
  counter: { color: '#c2a58c', accent: 'counter', icon: 'utensils' },
  custom: { color: '#c5bcae', accent: 'none', icon: 'shapes' },
}

export function spaceKindMeta(kind: string): SpaceKindMeta {
  return SPACE_KIND_META[kind] ?? SPACE_KIND_META.custom
}

/** Space platform world box (center + size + rotation radians). */
export function spaceWorldBox(
  space: FloorSpace,
  floor: FloorWorld,
): { x: number; z: number; w: number; d: number; rot: number } {
  const center = percentToWorld(space.positionX, space.positionY, floor)
  return {
    x: center.x,
    z: center.z,
    w: Math.max(0.4, (space.widthUnits / 100) * floor.w),
    d: Math.max(0.4, (space.depthUnits / 100) * floor.d),
    rot: (space.rotation * Math.PI) / 180,
  }
}
