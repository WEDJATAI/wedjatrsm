'use client'

/**
 * r56: the 3D floor plan engine — react-three-fiber v9 + drei v10 (three
 * 0.186), the current state-of-the-art React WebGL stack.
 *
 * Renders a floor plan as a premium architectural maquette:
 *  - the p21 shaped floor (rectangle/L/T/U) extruded with low walls (an
 *    entrance gap on the bottom edge) over a dotted-stone slab
 *  - tables as shape-accurate 3D tops (square/round/rectangle/oval) with
 *    pedestal bases and DELIBERATELY SMALL chairs (owner directive) placed
 *    by capacity, every chair facing its table
 *  - r56 custom spaces (lounge/bar/stage/VIP/kids/greenery/walkway/…)
 *    as tinted platforms with kind-specific accent props + bilingual labels
 *  - live POS status: duration-heat halos, occupied amounts, tool
 *    eligibility dimming, selection rings
 *  - two modes: 'edit' (admin — drag to arrange, tap to edit) and
 *    'select' (POS — tap a table to open it)
 *  - studio lighting without any network fetch: an Environment built from
 *    local Lightformers, directional soft shadows + contact shadows, ACES
 *    tone mapping. No HDR files, no font files, no CDN — sandbox-safe.
 *
 * i18n: `t` is resolved OUTSIDE the Canvas (context is guaranteed there)
 * and passed down as a prop — no context-bridging assumptions inside the
 * WebGL tree.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  RoundedBox,
  useCursor,
} from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import {
  Armchair,
  Baby,
  Crown,
  DoorOpen,
  Footprints,
  Martini,
  Music,
  Shapes as ShapesIcon,
  Sofa,
  Sprout,
  UtensilsCrossed,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { FloorPlan, FloorSpace, RestaurantTable } from '@/lib/types'
import { floorOutline } from '@/lib/floor-geometry'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  CHAIR_BACK_H,
  CHAIR_SEAT_D,
  CHAIR_SEAT_H,
  CHAIR_SEAT_W,
  TABLE_TOP_H,
  TABLE_TOP_T,
  chairLayout,
  clampPercentToShape,
  floorWorld,
  percentToWorld,
  spaceKindMeta,
  spaceWorldBox,
  tableDims,
  tableStatusVisual,
  worldToPercent,
  type FloorWorld,
} from './floor3d-utils'

// ── shared prop types ─────────────────────────────────────────────────

export type Floor3dInteraction = 'default' | 'eligible' | 'ineligible'
export type Floor3dView = 'perspective' | 'top'

type TFunc = (key: string, params?: Record<string, string | number>) => string

export type Floor3dSceneProps = {
  plan: FloorPlan
  mode: 'edit' | 'select'
  /** edit: tap (no drag) on a table → open its editor */
  onTableClick?: (table: RestaurantTable) => void
  /** edit: drag commit — floor-relative % (clamped + 1-decimal) */
  onTableMove?: (table: RestaurantTable, xPercent: number, yPercent: number) => void
  onSpaceClick?: (space: FloorSpace) => void
  onSpaceMove?: (space: FloorSpace, xPercent: number, yPercent: number) => void
  /** select (POS): tap a table */
  onTableSelect?: (table: RestaurantTable) => void
  /** POS tool dims (transfer/merge/seat) */
  tableInteraction?: (table: RestaurantTable) => Floor3dInteraction
  selectedTableIds?: number[]
  /** camera preset (admin toolbar) */
  view?: Floor3dView
  className?: string
}

type DragState = {
  kind: 'table' | 'space'
  id: number
  offset: { x: number; z: number }
  startCenter: { x: number; z: number }
  lastPercent: { x: number; y: number }
  moved: number
}

type DragPos = { kind: 'table' | 'space'; id: number; x: number; y: number }

// ── floating-label overlay (root-free drei-<Html> replacement) ────────
//
// drei's <Html> creates one ReactDOM root per label chip and unmounts it
// synchronously during the Canvas lifecycle — with React 19 this trips the
// "Attempted to synchronously unmount a root while React was already
// rendering" race detector on every mount (21 log entries on view entry).
// This replacement renders the chips in the page's own React tree (zero
// extra roots, zero portals) and a single projector inside the Canvas
// writes transforms directly to the DOM nodes every frame — same visuals
// (drei's exact distance-scaling math), zero lifecycle races.

type LabelEntry = {
  el: HTMLElement | null
  anchor: THREE.Object3D | null
  /** drei-equivalent distanceFactor (table 8 · space/entrance 9) */
  factor: number
}
type LabelRegistry = Map<string, LabelEntry>

/** Registers the chip's DOM node (overlay side) into the registry. */
function labelElRegistrar(registry: LabelRegistry, id: string, factor: number) {
  return (el: HTMLDivElement | null) => {
    const entry = registry.get(id) ?? { el: null, anchor: null, factor }
    entry.el = el
    registry.set(id, entry)
  }
}

/** Registers the 3D anchor object (scene-graph side) into the registry. */
function labelAnchorRegistrar(registry: LabelRegistry | null, id: string, factor: number) {
  return (obj: THREE.Object3D | null) => {
    if (!registry) return
    const entry = registry.get(id) ?? { el: null, anchor: null, factor }
    entry.anchor = obj
    if (obj) entry.factor = factor
    registry.set(id, entry)
  }
}

const PLANE_Y0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const DRAG_CLICK_EPSILON = 0.07 // world units — under this, a pointerdown+up is a tap

// ── floor slab + walls ────────────────────────────────────────────────

/** Dotted stone texture (procedural CanvasTexture — zero network). */
function useFloorTexture(): THREE.CanvasTexture {
  return useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.fillStyle = '#e9e2d3'
      ctx.fillRect(0, 0, 64, 64)
      ctx.fillStyle = '#d6ccb8'
      ctx.beginPath()
      ctx.arc(32, 32, 2.1, 0, Math.PI * 2)
      ctx.fill()
    }
    const tex = new THREE.CanvasTexture(canvas)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.colorSpace = THREE.SRGBColorSpace
    tex.repeat.set(1 / 0.55, 1 / 0.55) // one dot per 0.55 world units
    return tex
  }, [])
}

function FloorSlab({ plan, floor }: { plan: FloorPlan; floor: FloorWorld }) {
  const texture = useFloorTexture()
  const geometry = useMemo(() => {
    // outline % → shape space (x = worldX, y = -worldZ); ensure CCW winding
    let pts = floorOutline(plan.floorShape).map(
      ([px, py]) => new THREE.Vector2(((px / 100 - 0.5) * floor.w), -((py / 100 - 0.5) * floor.d)),
    )
    const area2 = pts.reduce(
      (sum, p, i) => sum + (p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y),
      0,
    )
    if (area2 < 0) pts = [...pts].reverse()
    const shape = new THREE.Shape(pts)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: false })
    geo.rotateX(-Math.PI / 2) // shape (x,y) → world (x, 0, -y); extrusion → up
    return geo
  }, [plan.floorShape, floor.w, floor.d])

  return (
    <mesh
      geometry={geometry}
      position={[0, -0.16, 0]}
      receiveShadow
    >
      <meshStandardMaterial map={texture} roughness={0.94} metalness={0} />
    </mesh>
  )
}

function Walls({ plan, floor }: { plan: FloorPlan; floor: FloorWorld }) {
  const WALL_H = 0.52
  const WALL_T = 0.14
  const segments = useMemo(() => {
    const outline = floorOutline(plan.floorShape)
    const toWorld = ([px, py]: [number, number]) => ({
      x: (px / 100 - 0.5) * floor.w,
      z: (py / 100 - 0.5) * floor.d,
    })
    const out: { x: number; z: number; len: number; rotY: number }[] = []
    for (let i = 0; i < outline.length; i++) {
      const p1 = toWorld(outline[i])
      const p2 = toWorld(outline[(i + 1) % outline.length])
      const dx = p2.x - p1.x
      const dz = p2.z - p1.z
      const len = Math.hypot(dx, dz)
      if (len < 0.05) continue
      const rotY = Math.atan2(-dz, dx)
      const mid = { x: (p1.x + p2.x) / 2, z: (p1.z + p2.z) / 2 }
      // entrance gap: bottom-boundary edges get a centered 14% opening
      const isBottom = outline[i][1] === 100 && outline[(i + 1) % outline.length][1] === 100
      if (isBottom) {
        for (const t of [-1, 1]) {
          // two half-segments: from each end toward a gap of ±7% of length
          const gap = len * 0.07
          const segLen = (len - gap * 2) / 2
          if (segLen < 0.1) continue
          const cx = mid.x + t * (gap / 2 + segLen / 2) * (dx / len)
          const cz = mid.z + t * (gap / 2 + segLen / 2) * (dz / len)
          out.push({ x: cx, z: cz, len: segLen + WALL_T, rotY })
        }
        continue
      }
      out.push({ x: mid.x, z: mid.z, len: len + WALL_T, rotY })
    }
    return out
  }, [plan.floorShape, floor.w, floor.d])

  return (
    <group>
      {segments.map((seg, i) => (
        <mesh
          key={i}
          position={[seg.x, WALL_H / 2 - 0.02, seg.z]}
          rotation={[0, seg.rotY, 0]}
          castShadow
          receiveShadow
        >
          <boxGeometry args={[seg.len, WALL_H, WALL_T]} />
          <meshStandardMaterial color="#f0e9db" roughness={0.88} />
        </mesh>
      ))}
    </group>
  )
}

function EntranceChip({ t }: { t: TFunc }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-stone-300 bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-stone-500 shadow-sm backdrop-blur">
      <DoorOpen className="size-3.5" aria-hidden />
      {t('admin.hallEntrance')}
    </div>
  )
}

function EntranceMat({
  floor,
  t,
  registry,
}: {
  floor: FloorWorld
  t: TFunc
  registry: LabelRegistry | null
}) {
  const anchorRef = labelAnchorRegistrar(registry, 'entrance', 9)
  return (
    <group position={[0, 0, floor.d / 2 + 0.34]}>
      <mesh position={[0, 0.015, 0]} receiveShadow>
        <boxGeometry args={[1.5, 0.03, 0.52]} />
        <meshStandardMaterial color="#cdbb97" roughness={0.9} />
      </mesh>
      <object3D ref={anchorRef} position={[0, 0.32, 0]} />
    </group>
  )
}

// ── chairs — SMALL on purpose ─────────────────────────────────────────

function Chair({ dimmed }: { dimmed: boolean }) {
  return (
    <group>
      {/* pedestal leg + base */}
      <mesh position={[0, (CHAIR_SEAT_H - 0.05) / 2, 0]} castShadow={false}>
        <cylinderGeometry args={[0.024, 0.03, CHAIR_SEAT_H - 0.05, 10]} />
        <meshStandardMaterial color="#57493c" roughness={0.55} metalness={0.25} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </mesh>
      <mesh position={[0, 0.015, 0]} castShadow={false}>
        <cylinderGeometry args={[0.11, 0.13, 0.03, 14]} />
        <meshStandardMaterial color="#57493c" roughness={0.55} metalness={0.25} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </mesh>
      {/* seat */}
      <RoundedBox
        args={[CHAIR_SEAT_W, 0.05, CHAIR_SEAT_D]}
        radius={0.02}
        smoothness={3}
        position={[0, CHAIR_SEAT_H, 0]}
        castShadow
      >
        <meshStandardMaterial color="#8a7668" roughness={0.7} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </RoundedBox>
      {/* backrest (behind the seat — the chair faces local -Z) */}
      <RoundedBox
        args={[CHAIR_SEAT_W, CHAIR_BACK_H, 0.045]}
        radius={0.018}
        smoothness={3}
        position={[0, CHAIR_SEAT_H + CHAIR_BACK_H / 2 + 0.02, CHAIR_SEAT_D / 2 + 0.005]}
        castShadow
      >
        <meshStandardMaterial color="#6d5f52" roughness={0.7} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </RoundedBox>
    </group>
  )
}

// ── table label chip (DOM — crisp text, i18n + RTL native) ────────────

function TableLabel({
  table,
  t,
  lang,
}: {
  table: RestaurantTable
  t: TFunc
  lang: 'en' | 'ar'
}) {
  const visual = tableStatusVisual(table)
  const occupied = table.status === 'occupied' || table.openOrderId != null
  return (
    <div
      dir="auto"
      className="flex min-w-[78px] max-w-[160px] flex-col items-center gap-0.5 rounded-xl border border-stone-200/90 bg-white/95 px-2.5 py-1.5 text-center shadow-md backdrop-blur"
    >
      <span className="text-[13px] font-extrabold leading-none text-stone-700">{table.name}</span>
      {occupied ? (
        <>
          <span
            className="text-[13px] font-extrabold tabular-nums leading-none"
            style={{ color: visual.amount ?? '#78716c' }}
          >
            {formatCurrency(table.openOrderTotal ?? 0, lang)}
          </span>
          <span className="flex items-center gap-1 text-[10px] font-semibold leading-none text-stone-500">
            <Armchair className="size-3" aria-hidden />
            {table.openOrderGuests ?? table.capacity}
            <span aria-hidden>·</span>
            <span className="tabular-nums">{elapsedSince(table.openOrderSince ?? new Date())}</span>
          </span>
        </>
      ) : (
        <span
          className="flex items-center gap-1 text-[10px] font-bold uppercase leading-none"
          style={{ color: visual.amount ?? '#78716c' }}
        >
          {table.capacity} {t('common.seats')} · {t(`status.table.${table.status}`)}
        </span>
      )}
    </div>
  )
}

// ── the 3D table ──────────────────────────────────────────────────────

type Table3dProps = {
  table: RestaurantTable
  floor: FloorWorld
  mode: 'edit' | 'select'
  t: TFunc
  lang: 'en' | 'ar'
  interaction: Floor3dInteraction
  selected: boolean
  dragging: boolean
  dragPercent: { x: number; y: number } | null
  registry: LabelRegistry | null
  onPointerDownEdit: (e: ThreeEvent<PointerEvent>, table: RestaurantTable) => void
  onSelect?: (table: RestaurantTable) => void
}

function Table3d({
  table,
  floor,
  mode,
  t,
  lang,
  interaction,
  selected,
  dragging,
  dragPercent,
  registry,
  onPointerDownEdit,
  onSelect,
}: Table3dProps) {
  const group = useRef<THREE.Group>(null)
  const [hovered, setHovered] = useState(false)
  useCursor(hovered && interaction !== 'ineligible')

  const dims = tableDims(table.shape)
  const visual = tableStatusVisual(table)
  const pos = dragPercent ?? { x: table.positionX, y: table.positionY }
  const center = percentToWorld(pos.x, pos.y, floor)
  const chairs = useMemo(() => chairLayout(table, dims), [table, dims])
  const dimmed = interaction === 'ineligible'
  const lift = hovered || selected || dragging

  // smooth hover/selection lift
  useFrame((_, dt) => {
    if (!group.current) return
    const target = lift ? 0.07 : 0
    group.current.position.y = THREE.MathUtils.damp(group.current.position.y, target, 10, dt)
    const targetScale = dragging ? 1.06 : 1
    const s = THREE.MathUtils.damp(group.current.scale.x, targetScale, 10, dt)
    group.current.scale.setScalar(s)
  })

  const haloRadius = Math.max(dims.w, dims.d) / 2 + 0.4
  const wood = '#a97c50'

  return (
    <group
      ref={group}
      position={[center.x, 0, center.z]}
      onPointerDown={mode === 'edit' ? (e) => onPointerDownEdit(e, table) : undefined}
      onClick={
        mode === 'select' && interaction !== 'ineligible' && onSelect
          ? (e) => {
              e.stopPropagation()
              onSelect(table)
            }
          : undefined
      }
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* status halo on the floor */}
      {visual.halo && (
        <>
          <mesh position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[haloRadius, 40]} />
            <meshBasicMaterial color={visual.halo} transparent opacity={dimmed ? 0.08 : 0.22} depthWrite={false} />
          </mesh>
          <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[haloRadius - 0.05, haloRadius, 48]} />
            <meshBasicMaterial color={visual.halo} transparent opacity={dimmed ? 0.15 : 0.55} depthWrite={false} />
          </mesh>
        </>
      )}

      {/* selection ring (POS tools) */}
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[haloRadius + 0.04, haloRadius + 0.12, 48]} />
          <meshBasicMaterial color="#7c3aed" transparent opacity={0.9} depthWrite={false} />
        </mesh>
      )}
      {interaction === 'eligible' && !selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[haloRadius + 0.04, haloRadius + 0.12, 48]} />
          <meshBasicMaterial color="#b45309" transparent opacity={0.7} depthWrite={false} />
        </mesh>
      )}

      {/* pedestal */}
      <mesh position={[0, (TABLE_TOP_H - TABLE_TOP_T / 2) / 2, 0]} castShadow>
        <cylinderGeometry args={[0.08, 0.12, TABLE_TOP_H - TABLE_TOP_T / 2, 16]} />
        <meshStandardMaterial color="#4e4238" roughness={0.45} metalness={0.35} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </mesh>
      <mesh position={[0, 0.02, 0]} castShadow>
        <cylinderGeometry args={[0.3, 0.34, 0.04, 20]} />
        <meshStandardMaterial color="#4e4238" roughness={0.45} metalness={0.35} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
      </mesh>

      {/* table top — shape accurate */}
      {dims.round ? (
        <mesh
          position={[0, TABLE_TOP_H, 0]}
          scale={table.shape === 'oval' ? [1, 1, dims.d / dims.w] : [1, 1, 1]}
          castShadow
        >
          <cylinderGeometry args={[dims.w / 2, dims.w / 2, TABLE_TOP_T, 44]} />
          <meshStandardMaterial color={wood} roughness={0.38} metalness={0.06} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
        </mesh>
      ) : (
        <RoundedBox
          args={[dims.w, TABLE_TOP_T, dims.d]}
          radius={0.035}
          smoothness={4}
          position={[0, TABLE_TOP_H, 0]}
          castShadow
        >
          <meshStandardMaterial color={wood} roughness={0.38} metalness={0.06} transparent={dimmed} opacity={dimmed ? 0.35 : 1} />
        </RoundedBox>
      )}

      {/* chairs — small, facing the table */}
      {chairs.map((slot, i) => (
        <group key={i} position={[slot.x, 0, slot.z]} rotation={[0, slot.rotY, 0]}>
          <Chair dimmed={dimmed} />
        </group>
      ))}

      {/* floating label anchor (chip renders in the page overlay) */}
      <object3D ref={labelAnchorRegistrar(registry, `table-${table.id}`, 8)} position={[0, TABLE_TOP_H + 0.5, 0]} />
    </group>
  )
}

// ── custom spaces (r56) ───────────────────────────────────────────────

const SPACE_ICONS: Record<string, LucideIcon> = {
  sofa: Sofa,
  martini: Martini,
  music: Music,
  crown: Crown,
  baby: Baby,
  sprout: Sprout,
  footprints: Footprints,
  utensils: UtensilsCrossed,
  shapes: ShapesIcon,
}

function SpaceAccents({ kind, w, d }: { kind: string; w: number; d: number }) {
  switch (kind) {
    case 'lounge':
      return (
        <group>
          <RoundedBox args={[Math.min(1.6, w * 0.4), 0.24, 0.44]} radius={0.06} smoothness={3} position={[-w * 0.18, 0.26, -d / 2 + 0.32]} castShadow>
            <meshStandardMaterial color="#9c8468" roughness={0.8} />
          </RoundedBox>
          <RoundedBox args={[Math.min(1.6, w * 0.4), 0.24, 0.44]} radius={0.06} smoothness={3} position={[w * 0.18, 0.26, -d / 2 + 0.32]} castShadow>
            <meshStandardMaterial color="#9c8468" roughness={0.8} />
          </RoundedBox>
          <mesh position={[0, 0.3, 0.1]} castShadow>
            <cylinderGeometry args={[0.26, 0.3, 0.32, 20]} />
            <meshStandardMaterial color="#7a5f43" roughness={0.5} />
          </mesh>
        </group>
      )
    case 'bar':
    case 'counter':
      return (
        <RoundedBox args={[Math.max(0.8, w * 0.78), 0.52, Math.max(0.3, d * 0.3)]} radius={0.03} smoothness={3} position={[0, 0.4, -d / 2 + Math.max(0.3, d * 0.3) / 2 + 0.12]} castShadow>
          <meshStandardMaterial color="#7a5a3c" roughness={0.45} />
        </RoundedBox>
      )
    case 'stage':
      return (
        <group>
          <RoundedBox args={[w * 0.92, 0.2, d * 0.92]} radius={0.03} smoothness={3} position={[0, 0.24, 0]} castShadow>
            <meshStandardMaterial color="#8a6a48" roughness={0.5} />
          </RoundedBox>
          <mesh position={[0, 0.36, 0]} castShadow>
            <cylinderGeometry args={[0.14, 0.16, 0.06, 16]} />
            <meshStandardMaterial color="#3f3630" roughness={0.3} metalness={0.5} />
          </mesh>
        </group>
      )
    case 'vip':
      return (
        <group>
          {[
            [-w / 2 + 0.14, -d / 2 + 0.14],
            [w / 2 - 0.14, -d / 2 + 0.14],
            [-w / 2 + 0.14, d / 2 - 0.14],
            [w / 2 - 0.14, d / 2 - 0.14],
          ].map(([x, z], i) => (
            <mesh key={i} position={[x, 0.35, z]} castShadow>
              <cylinderGeometry args={[0.035, 0.045, 0.44, 10]} />
              <meshStandardMaterial color="#b8963f" roughness={0.35} metalness={0.6} />
            </mesh>
          ))}
          <mesh position={[0, 0.42, d / 2 - 0.14]}>
            <boxGeometry args={[w - 0.28, 0.02, 0.02]} />
            <meshStandardMaterial color="#b8963f" roughness={0.35} metalness={0.6} />
          </mesh>
        </group>
      )
    case 'kids': {
      const balls: [number, number, string][] = [
        [-w * 0.22, 0.06, '#e8896a'],
        [0, -d * 0.08, '#7fb069'],
        [w * 0.2, 0.05, '#e0b95c'],
        [-w * 0.08, d * 0.18, '#8aa7c9'],
        [w * 0.26, d * 0.16, '#d98a9e'],
      ]
      return (
        <group>
          {balls.map(([x, z, color], i) => (
            <mesh key={i} position={[x, 0.21, z]} castShadow>
              <sphereGeometry args={[0.1, 18, 14]} />
              <meshStandardMaterial color={color} roughness={0.35} />
            </mesh>
          ))}
        </group>
      )
    }
    case 'greenery': {
      const plants: [number, number][] = [
        [-w * 0.28, -d * 0.2],
        [w * 0.26, -d * 0.24],
        [0, d * 0.22],
      ]
      return (
        <group>
          {plants.map(([x, z], i) => (
            <group key={i} position={[x, 0.14, z]}>
              <mesh position={[0, 0.09, 0]} castShadow>
                <cylinderGeometry args={[0.13, 0.1, 0.18, 14]} />
                <meshStandardMaterial color="#8d6e55" roughness={0.8} />
              </mesh>
              <mesh position={[0, 0.36, 0]} castShadow>
                <sphereGeometry args={[0.2, 16, 12]} />
                <meshStandardMaterial color="#6f8f66" roughness={0.9} />
              </mesh>
            </group>
          ))}
        </group>
      )
    }
    default:
      return null
  }
}

type Space3dProps = {
  space: FloorSpace
  floor: FloorWorld
  dragging: boolean
  dragPercent: { x: number; y: number } | null
  registry: LabelRegistry | null
  onPointerDownEdit: (e: ThreeEvent<PointerEvent>, space: FloorSpace) => void
}

/** Space label chip (DOM — rendered in the page overlay). */
function SpaceLabel({ space, t }: { space: FloorSpace; t: TFunc }) {
  const meta = spaceKindMeta(space.kind)
  const Icon = SPACE_ICONS[meta.icon] ?? ShapesIcon
  return (
    <div
      dir="auto"
      className="flex items-center gap-1.5 rounded-full border border-stone-200/90 bg-white/95 px-3 py-1 shadow-md backdrop-blur"
    >
      <Icon className="size-3.5 shrink-0" style={{ color: '#8a7355' }} aria-hidden />
      <span className="max-w-[130px] truncate text-xs font-bold text-stone-600">{space.name}</span>
      <span className="text-[9px] font-bold uppercase tracking-wide text-stone-400">
        {t(`spaceKind.${space.kind}`)}
      </span>
    </div>
  )
}

function Space3d({ space, floor, dragging, dragPercent, registry, onPointerDownEdit }: Space3dProps) {
  const [hovered, setHovered] = useState(false)
  useCursor(hovered)
  const meta = spaceKindMeta(space.kind)
  const box = spaceWorldBox({ ...space, positionX: dragPercent?.x ?? space.positionX, positionY: dragPercent?.y ?? space.positionY }, floor)

  return (
    <group
      position={[box.x, 0, box.z]}
      rotation={[0, box.rot, 0]}
      onPointerDown={(e) => onPointerDownEdit(e, space)}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHovered(true)
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* platform */}
      <RoundedBox
        args={[box.w, 0.14, box.d]}
        radius={0.05}
        smoothness={4}
        position={[0, 0.07, 0]}
        receiveShadow
        castShadow
      >
        <meshStandardMaterial
          color={hovered || dragging ? '#cbb593' : meta.color}
          roughness={0.86}
        />
      </RoundedBox>
      <SpaceAccents kind={space.kind} w={box.w} d={box.d} />
      {/* label anchor (chip renders in the page overlay) */}
      <object3D ref={labelAnchorRegistrar(registry, `space-${space.id}`, 9)} position={[0, 1.05, 0]} />
    </group>
  )
}

// ── label projector (inside the Canvas — syncs anchors → chip DOM) ───

/**
 * Every frame: project each registered 3D anchor to screen space and write
 * the transform directly onto its chip DOM node (no React state, no extra
 * roots). Scaling mirrors drei <Html>: 1 / (2·tan(vFOV/2)·distance) × factor.
 */
function OverlayProjector({
  registry,
  overlay,
}: {
  registry: LabelRegistry
  overlay: React.RefObject<HTMLDivElement | null>
}) {
  const camera = useThree((s) => s.camera)
  const world = useMemo(() => new THREE.Vector3(), [])
  const camPos = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const root = overlay.current
    if (!root || registry.size === 0) return
    const widthHalf = root.clientWidth / 2
    const heightHalf = root.clientHeight / 2
    camera.getWorldPosition(camPos)
    const persp = camera as THREE.PerspectiveCamera
    const vFOV = persp.isPerspectiveCamera ? (persp.fov * Math.PI) / 180 : 0
    for (const entry of registry.values()) {
      const el = entry.el
      if (!el || !entry.anchor) continue
      entry.anchor.getWorldPosition(world)
      const dist = world.distanceTo(camPos)
      world.project(camera)
      const behind = world.z > 1 || world.z < -1
      if (behind) {
        if (el.style.opacity !== '0') el.style.opacity = '0'
        continue
      }
      const x = world.x * widthHalf + widthHalf
      const y = -(world.y * heightHalf) + heightHalf
      const scale = vFOV
        ? THREE.MathUtils.clamp((1 / (2 * Math.tan(vFOV / 2) * dist)) * entry.factor, 0.4, 1.3)
        : 1
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`
      el.style.zIndex = String(Math.round(THREE.MathUtils.clamp((1 - world.z) * 15, 0, 30)))
      if (el.style.opacity !== '1') el.style.opacity = '1'
    }
  })
  return null
}

// ── camera rig (view presets with smooth transitions) ─────────────────

function CameraRig({ view, floor }: { view: Floor3dView; floor: FloorWorld }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const anim = useRef<{ from: THREE.Vector3; to: THREE.Vector3; t: number } | null>(null)

  const targetPos = useMemo(() => {
    const dist = Math.max(floor.w, floor.d) * 1.32
    return view === 'top'
      ? new THREE.Vector3(0.001, dist * 1.12, 0.001)
      : new THREE.Vector3(floor.w * 0.06, dist * 0.92, dist * 0.72)
  }, [view, floor.w, floor.d])

  useEffect(() => {
    anim.current = { from: camera.position.clone(), to: targetPos, t: 0 }
  }, [targetPos, camera])

  useFrame((_, dt) => {
    const a = anim.current
    if (!a) return
    a.t = Math.min(1, a.t + dt / 0.75)
    const e = 1 - Math.pow(1 - a.t, 3) // easeOutCubic
    camera.position.lerpVectors(a.from, a.to, e)
    if (a.t >= 1) anim.current = null
  })
  return null
}

// ── drag manager (edit mode) ──────────────────────────────────────────

function DragCapture({
  floor,
  shape,
  stateRef,
  setDragPos,
  onDragEnd,
  setOrbitEnabled,
}: {
  floor: FloorWorld
  shape: string
  stateRef: React.RefObject<DragState | null>
  setDragPos: (pos: DragPos | null) => void
  onDragEnd: (state: DragState) => void
  setOrbitEnabled: (enabled: boolean) => void
}) {
  const { gl, camera } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])

  useEffect(() => {
    const el = gl.domElement
    const toWorld = (e: PointerEvent): { x: number; z: number } | null => {
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hit = new THREE.Vector3()
      if (!raycaster.ray.intersectPlane(PLANE_Y0, hit)) return null
      return { x: hit.x, z: hit.z }
    }
    const onMove = (e: PointerEvent) => {
      const st = stateRef.current
      if (!st) return
      const p = toWorld(e)
      if (!p) return
      const cx = p.x - st.offset.x
      const cz = p.z - st.offset.z
      st.moved = Math.max(st.moved, Math.hypot(cx - st.startCenter.x, cz - st.startCenter.z))
      const pct = worldToPercent(cx, cz, floor)
      const clamped = clampPercentToShape(shape, clamp(pct.x, 2, 98), clamp(pct.y, 2, 98))
      st.lastPercent = clamped
      setDragPos({ kind: st.kind, id: st.id, x: clamped.x, y: clamped.y })
    }
    const onUp = () => {
      const st = stateRef.current
      if (!st) return
      stateRef.current = null
      setDragPos(null)
      setOrbitEnabled(true)
      onDragEnd(st)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    return () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
    }
  }, [gl, camera, raycaster, floor, shape, stateRef, setDragPos, onDragEnd, setOrbitEnabled])

  return null
}

// ── scene content (inside the Canvas) ─────────────────────────────────

type SceneContentProps = Floor3dSceneProps & {
  t: TFunc
  lang: 'en' | 'ar'
  registry: LabelRegistry
  overlayRef: React.RefObject<HTMLDivElement | null>
}

function SceneContent({
  plan,
  mode,
  t,
  lang,
  registry,
  overlayRef,
  onTableClick,
  onTableMove,
  onSpaceClick,
  onSpaceMove,
  onTableSelect,
  tableInteraction,
  selectedTableIds,
  view = 'perspective',
}: SceneContentProps) {
  const floor = useMemo(() => floorWorld(plan), [plan])
  const shape = plan.floorShape ?? 'rectangle'
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const dragStateRef = useRef<DragState | null>(null)
  const [dragPos, setDragPos] = useState<DragPos | null>(null)
  const [orbitEnabled, setOrbitEnabled] = useState(true)
  const spaces = plan.spaces ?? []
  const selectedIds = selectedTableIds ?? []

  const tables = useMemo(() => plan.tables.filter((tb) => tb.active), [plan.tables])

  const startDrag = (
    e: ThreeEvent<PointerEvent>,
    kind: 'table' | 'space',
    obj: RestaurantTable | FloorSpace,
  ) => {
    if (mode !== 'edit') return
    e.stopPropagation()
    const hit = new THREE.Vector3()
    if (!e.ray.intersectPlane(PLANE_Y0, hit)) return
    const current = percentToWorld(obj.positionX, obj.positionY, floor)
    dragStateRef.current = {
      kind,
      id: obj.id,
      offset: { x: hit.x - current.x, z: hit.z - current.z },
      startCenter: current,
      lastPercent: { x: obj.positionX, y: obj.positionY },
      moved: 0,
    }
    setOrbitEnabled(false)
  }

  const onDragEnd = (state: DragState) => {
    if (state.moved < DRAG_CLICK_EPSILON) {
      // a tap, not a drag → open the editor
      if (state.kind === 'table') {
        const table = tables.find((tb) => tb.id === state.id)
        if (table) onTableClick?.(table)
      } else {
        const space = spaces.find((sp) => sp.id === state.id)
        if (space) onSpaceClick?.(space)
      }
      return
    }
    if (state.kind === 'table') {
      const table = tables.find((tb) => tb.id === state.id)
      if (table) onTableMove?.(table, state.lastPercent.x, state.lastPercent.y)
    } else {
      const space = spaces.find((sp) => sp.id === state.id)
      if (space) onSpaceMove?.(space, state.lastPercent.x, state.lastPercent.y)
    }
  }

  const dist = Math.max(floor.w, floor.d) * 1.32

  return (
    <>
      <color attach="background" args={['#f6f2ea']} />
      <ambientLight intensity={0.55} color="#fff3e4" />
      <hemisphereLight intensity={0.45} color="#fff8ee" groundColor="#d8cdbd" />
      <directionalLight
        position={[dist * 0.55, dist * 0.95, dist * 0.4]}
        intensity={1.5}
        color="#fff1dd"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-9}
        shadow-camera-right={9}
        shadow-camera-top={9}
        shadow-camera-bottom={-9}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
        shadow-bias={-0.0004}
      />
      {/* procedural studio environment — local lightformers, zero fetches */}
      <Environment resolution={128} frames={1}>
        <Lightformer form="rect" intensity={2.1} position={[0, 6, 5]} scale={[10, 4, 1]} target={[0, 0, 0]} color="#fff4e2" />
        <Lightformer form="rect" intensity={1.05} position={[-6, 4, -4]} rotation-y={Math.PI / 3} scale={[8, 3, 1]} color="#ffe9d0" />
        <Lightformer form="rect" intensity={0.85} position={[6, 3.5, -3]} rotation-y={-Math.PI / 3} scale={[8, 3, 1]} color="#f3ece2" />
      </Environment>

      <CameraRig view={view} floor={floor} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enabled={orbitEnabled}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={4.5}
        maxDistance={dist * 2.4}
        minPolarAngle={0.08}
        maxPolarAngle={1.35}
        target={[0, 0, 0]}
      />

      <FloorSlab plan={plan} floor={floor} />
      <Walls plan={plan} floor={floor} />
      <EntranceMat floor={floor} t={t} registry={registry} />
      <OverlayProjector registry={registry} overlay={overlayRef} />

      {/* custom spaces first (platforms under furniture) */}
      {spaces.map((space) => (
        <Space3d
          key={`space-${space.id}`}
          space={space}
          floor={floor}
          dragging={dragPos?.kind === 'space' && dragPos.id === space.id}
          dragPercent={dragPos?.kind === 'space' && dragPos.id === space.id ? { x: dragPos.x, y: dragPos.y } : null}
          registry={registry}
          onPointerDownEdit={(e, sp) => startDrag(e, 'space', sp)}
        />
      ))}

      {tables.map((table) => (
        <Table3d
          key={`table-${table.id}`}
          table={table}
          floor={floor}
          mode={mode}
          t={t}
          lang={lang}
          interaction={tableInteraction ? tableInteraction(table) : 'default'}
          selected={selectedIds.includes(table.id)}
          dragging={dragPos?.kind === 'table' && dragPos.id === table.id}
          dragPercent={dragPos?.kind === 'table' && dragPos.id === table.id ? { x: dragPos.x, y: dragPos.y } : null}
          registry={registry}
          onPointerDownEdit={(e, tb) => startDrag(e, 'table', tb)}
          onSelect={onTableSelect}
        />
      ))}

      <ContactShadows
        position={[0, 0.008, 0]}
        opacity={0.34}
        scale={Math.max(floor.w, floor.d) * 1.5}
        blur={2.4}
        far={2.2}
        resolution={512}
        color="#6b5b47"
      />

      {mode === 'edit' && (
        <DragCapture
          floor={floor}
          shape={shape}
          stateRef={dragStateRef}
          setDragPos={setDragPos}
          onDragEnd={onDragEnd}
          setOrbitEnabled={setOrbitEnabled}
        />
      )}
    </>
  )
}

// ── the public component (outside the Canvas — context is safe here) ──

/**
 * The 3D floor plan. MUST be mounted through next/dynamic with ssr:false
 * (WebGL) — the admin floorplans view and the POS floor screen both wrap
 * it: `dynamic(() => import('@/components/floor3d/floor3d-scene'), { ssr: false })`.
 */
export default function Floor3dScene({ plan, className, ...rest }: Floor3dSceneProps) {
  // i18n is resolved in the DOM tree and threaded INTO the Canvas as props
  // (the provider has a built-in key fallback — a stray mount degrades
  // gracefully, never crashes the WebGL canvas).
  const { t, lang } = useI18n()
  const floor = useMemo(() => floorWorld(plan), [plan])
  const dist = Math.max(floor.w, floor.d) * 1.32

  // r56 label overlay: chips live in THIS React tree (no extra react-dom
  // roots — the drei <Html> race is impossible by construction). Anchors
  // inside the Canvas register into the same map; the projector writes
  // transforms straight to these nodes every frame.
  const registry = useMemo(() => new Map<string, LabelEntry>() as LabelRegistry, [])
  const overlayRef = useRef<HTMLDivElement>(null)
  const spaces = plan.spaces ?? []
  const tables = useMemo(() => plan.tables.filter((tb) => tb.active), [plan.tables])
  const chipBase = 'pointer-events-none absolute left-0 top-0 opacity-0 will-change-transform'

  return (
    <div className={cn('relative h-full w-full', className)}>
      {/* floating label chips (page tree — crisp text, i18n + RTL native) */}
      <div ref={overlayRef} className='pointer-events-none absolute inset-0 z-10 overflow-hidden' aria-hidden>
        <div className={chipBase} data-f3d-label='entrance' ref={labelElRegistrar(registry, 'entrance', 9)}>
          <EntranceChip t={t} />
        </div>
        {spaces.map((space) => (
          <div
            key={`space-${space.id}`}
            className={chipBase}
            data-f3d-label={`space-${space.id}`}
            ref={labelElRegistrar(registry, `space-${space.id}`, 9)}
          >
            <SpaceLabel space={space} t={t} />
          </div>
        ))}
        {tables.map((table) => (
          <div
            key={`table-${table.id}`}
            className={chipBase}
            data-f3d-label={`table-${table.id}`}
            ref={labelElRegistrar(registry, `table-${table.id}`, 8)}
          >
            <TableLabel table={table} t={t} lang={lang} />
          </div>
        ))}
      </div>
      <Canvas
        shadows="percentage"
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: 'high-performance' }}
        camera={{ fov: 40, near: 0.1, far: 120, position: [floor.w * 0.06, dist * 0.92, dist * 0.72] }}
      >
        <SceneContent plan={plan} t={t} lang={lang} registry={registry} overlayRef={overlayRef} {...rest} />
      </Canvas>
    </div>
  )
}
