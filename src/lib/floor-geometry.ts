/**
 * p21: floor geometry — the owner controls each dining area's SIZE & SHAPE.
 *
 * A floor is a rectangle of widthUnits × heightUnits (percent of the canvas
 * box, 30–100) masked by a `floorShape` silhouette. Tables live at
 * floor-relative percentage coordinates; this module is the single source of
 * truth for the silhouettes so the admin editor (drag/drop + clamping), the
 * API validation and any future renderer never disagree.
 *
 * Shapes (x → right, y → down, all values floor-relative 0–100):
 *   rectangle  full box
 *   l_left     L with the notch cut from the TOP-RIGHT (tall left wing)
 *   l_right    L with the notch cut from the TOP-LEFT (tall right wing)
 *   t_top      T with the bar on top, stem down the middle
 *   u_up       U opening up (notch cut from the top-middle)
 *   u_down     U opening down (notch cut from the bottom-middle)
 */

export const FLOOR_SHAPES = [
  'rectangle',
  'l_left',
  'l_right',
  't_top',
  'u_up',
  'u_down',
] as const

export type FloorShape = (typeof FLOOR_SHAPES)[number]

/** Minimum/maximum floor size, in % of the canvas box. */
export const FLOOR_SIZE_MIN = 30
export const FLOOR_SIZE_MAX = 100

/** CSS clip-path polygon per shape (percentages of the floor rectangle). */
export const FLOOR_SHAPE_CLIP: Record<string, string> = {
  rectangle: 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
  l_left: 'polygon(0% 0%, 50% 0%, 50% 50%, 100% 50%, 100% 100%, 0% 100%)',
  l_right: 'polygon(50% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 50%, 50% 50%)',
  t_top: 'polygon(0% 0%, 100% 0%, 100% 50%, 65% 50%, 65% 100%, 35% 100%, 35% 50%, 0% 50%)',
  u_up: 'polygon(0% 0%, 30% 0%, 30% 50%, 70% 50%, 70% 0%, 100% 0%, 100% 100%, 0% 100%)',
  u_down: 'polygon(0% 0%, 100% 0%, 100% 100%, 70% 100%, 70% 50%, 30% 50%, 30% 100%, 0% 100%)',
}

export function floorShapeClip(shape: string | null | undefined): string {
  return FLOOR_SHAPE_CLIP[shape ?? 'rectangle'] ?? FLOOR_SHAPE_CLIP.rectangle
}

export function isFloorShape(value: unknown): value is FloorShape {
  return typeof value === 'string' && (FLOOR_SHAPES as readonly string[]).includes(value)
}

/**
 * Is a floor-relative point inside the walkable area of the shape?
 * Points exactly on an edge count as inside (drag clamping lands there).
 */
export function floorContainsPoint(shape: string | null | undefined, x: number, y: number): boolean {
  const s = shape ?? 'rectangle'
  switch (s) {
    case 'l_left':
      // notch = top-right quadrant
      return !(x > 50 && y < 50)
    case 'l_right':
      // notch = top-left quadrant
      return !(x < 50 && y < 50)
    case 't_top':
      // below the midline only the middle stem (35–65) is walkable
      return !(y > 50 && (x < 35 || x > 65))
    case 'u_up':
      // notch = top-middle (30–70, upper half)
      return !(y < 50 && x > 30 && x < 70)
    case 'u_down':
      // notch = bottom-middle (30–70, lower half)
      return !(y > 50 && x > 30 && x < 70)
    case 'rectangle':
    default:
      return true
  }
}

/**
 * Clamp a floor-relative point into the walkable area: when the point sits in
 * a cut-away region it slides toward the floor center until it is inside
 * (1%-steps; the shapes are rectilinear so this converges quickly). Falls
 * back to the center when given something pathological.
 */
export function clampPointToFloor(
  shape: string | null | undefined,
  x: number,
  y: number,
): { x: number; y: number } {
  const cx = Math.min(100, Math.max(0, x))
  const cy = Math.min(100, Math.max(0, y))
  if (floorContainsPoint(shape, cx, cy)) return { x: cx, y: cy }
  // slide toward center in 1% steps until inside (≤100 iterations)
  let px = cx
  let py = cy
  for (let i = 0; i < 100; i++) {
    px += (50 - px) * 0.12
    py += (50 - py) * 0.12
    if (floorContainsPoint(shape, px, py)) {
      return { x: Math.round(px * 10) / 10, y: Math.round(py * 10) / 10 }
    }
  }
  return { x: 50, y: 50 }
}
