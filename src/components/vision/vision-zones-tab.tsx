'use client'

// ─── Vision Zones tab — polygon zone editor over the floor schematic ─
// Draw normalized (0..1) polygons over the camera's floor-plan schematic
// (honest label: schematic calibration frame — the real edge processor
// streams the actual camera frame). Existing zones are clickable for
// editing with optimistic-version concurrency (409 on mismatch), zones
// can fire a test detection through the simulator API.

import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Crosshair,
  Eraser,
  Loader2,
  MousePointerClick,
  Play,
  SquareDashed,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { FloorPlan, RestaurantTable, VisionCameraDTO, VisionZoneDTO, VisionZonePoint } from '@/lib/types'
import { cn } from '@/lib/utils'

import { VisionErrorCard } from './vision-shared'
import { VISION_ZONE_KINDS } from '@/lib/constants'

const MAX_ZONE_POINTS = 24
const MIN_ZONE_POINTS = 3

type Props = {
  cameras: VisionCameraDTO[]
  zones: VisionZoneDTO[]
  isLoading: boolean
  isError: boolean
  refetch: () => void
  floorPlans: FloorPlan[]
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** POS-status → schematic table dot colors (warm palette). */
function tableDotClasses(status: string): string {
  switch (status) {
    case 'occupied':
      return 'border-amber-400 bg-amber-100 text-amber-800'
    case 'paid':
      return 'border-emerald-500 bg-emerald-100 text-emerald-800'
    case 'deferred':
      return 'border-violet-400 bg-violet-100 text-violet-800'
    case 'dirty':
      return 'border-amber-600 bg-amber-200 text-amber-900'
    case 'reserved':
      return 'border-amber-300 bg-amber-50 text-amber-700'
    default:
      return 'border-stone-300 bg-white text-stone-600'
  }
}

export default function VisionZonesTab({
  cameras,
  zones,
  isLoading,
  isError,
  refetch,
  floorPlans,
}: Props) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const svgRef = useRef<SVGSVGElement | null>(null)

  const [cameraId, setCameraId] = useState<number | null>(null)
  const camera = cameras.find((c) => c.id === cameraId) ?? cameras[0] ?? null
  const floorPlan = floorPlans.find((fp) => fp.id === camera?.floorPlanId) ?? null
  const cameraZones = camera ? zones.filter((z) => z.cameraId === camera.id) : []

  // drawing state
  const [drawing, setDrawing] = useState(false)
  const [points, setPoints] = useState<VisionZonePoint[]>([])
  const [draftPolygon, setDraftPolygon] = useState<VisionZonePoint[] | null>(null)

  // zone form state (editing an existing zone OR composing a new one)
  const [editingZone, setEditingZone] = useState<VisionZoneDTO | null>(null)
  const [zoneName, setZoneName] = useState('')
  const [zoneKind, setZoneKind] = useState<string>('table')
  const [zoneTableId, setZoneTableId] = useState<string>('none')
  const [zoneSeats, setZoneSeats] = useState('')
  const [zoneActive, setZoneActive] = useState(true)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const invalidateZones = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['vision-zones'] }),
      queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
    ])
  }

  const createZoneMutation = useMutation({
    mutationFn: (body: {
      cameraId: number
      name: string
      kind: string
      tableId?: number
      polygon: VisionZonePoint[]
      seats?: number
      active: boolean
    }) => apiFetch<{ zone: VisionZoneDTO }>('/api/vision/zones', { body }),
    onSuccess: async () => {
      toast.success(t('vision.zones.created'))
      resetZoneForm()
      await invalidateZones()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updateZoneMutation = useMutation({
    mutationFn: (vars: { id: number; version: number; body: Record<string, unknown> }) =>
      apiFetch<{ zone: VisionZoneDTO }>(`/api/vision/zones/${vars.id}`, {
        method: 'PUT',
        body: { ...vars.body, version: vars.version },
      }),
    onSuccess: async () => {
      toast.success(t('vision.zones.updated'))
      if (editingZone) resetZoneForm()
      await invalidateZones()
    },
    onError: async (err: Error) => {
      toast.error(`${err.message} — ${t('vision.zones.conflict')}`)
      await invalidateZones()
    },
  })

  const deleteZoneMutation = useMutation({
    mutationFn: (id: number) => apiFetch<{ ok: boolean }>(`/api/vision/zones/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success(t('vision.zones.deleted'))
      setDeleteOpen(false)
      resetZoneForm()
      await invalidateZones()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const testDetectionMutation = useMutation({
    mutationFn: (tableId: number) =>
      apiFetch<{ results: { event_id: string; outcome: string; detail: string | null }[] }>(
        '/api/vision/simulate',
        { body: { scenario: 'seat', tableId, people: 1 } },
      ),
    onSuccess: async (data) => {
      const first = data.results[0]
      if (first) toast.info(t(`vision.outcome.${first.outcome}`))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-movements'] }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const resetZoneForm = () => {
    setEditingZone(null)
    setDraftPolygon(null)
    setZoneName('')
    setZoneKind('table')
    setZoneTableId('none')
    setZoneSeats('')
    setZoneActive(true)
  }

  const startDrawing = () => {
    resetZoneForm()
    setDrawing(true)
    setPoints([])
  }

  const cancelDrawing = () => {
    setDrawing(false)
    setPoints([])
  }

  const addPoint = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drawing) return
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    if (points.length >= MAX_ZONE_POINTS) {
      toast.info(t('vision.zones.maxPoints'))
      return
    }
    const x = clamp01((e.clientX - rect.left) / rect.width)
    const y = clamp01((e.clientY - rect.top) / rect.height)
    setPoints((prev) => [...prev, { x, y }])
  }

  const commitPolygon = () => {
    if (points.length < MIN_ZONE_POINTS) return
    setDraftPolygon(points)
    setDrawing(false)
    setPoints([])
  }

  const selectZone = (zone: VisionZoneDTO) => {
    setEditingZone(zone)
    setDraftPolygon(null)
    setDrawing(false)
    setPoints([])
    setZoneName(zone.name)
    setZoneKind(String(zone.kind))
    setZoneTableId(zone.tableId != null ? String(zone.tableId) : 'none')
    setZoneSeats(zone.seats != null ? String(zone.seats) : '')
    setZoneActive(zone.active)
  }

  const prefillFromTable = (table: RestaurantTable) => {
    if (drawing) return
    setZoneTableId(String(table.id))
    if (!editingZone) setZoneName(`Z-${table.name}`)
  }

  const tables = floorPlan?.tables.filter((tb) => tb.active) ?? []
  const formTableId = zoneTableId === 'none' ? null : Number(zoneTableId)
  const polygon = editingZone ? editingZone.polygon : draftPolygon
  const canSave =
    zoneName.trim() !== '' &&
    polygon != null &&
    polygon.length >= MIN_ZONE_POINTS &&
    camera != null

  const submitZone = () => {
    if (!camera) return
    if (zoneName.trim() === '') {
      toast.error(t('vision.zones.nameRequired'))
      return
    }
    if (polygon == null || polygon.length < MIN_ZONE_POINTS) {
      toast.error(t('vision.zones.polygonRequired'))
      return
    }
    const seats = zoneSeats.trim() === '' ? undefined : Math.max(0, Math.floor(Number(zoneSeats)))
    if (editingZone) {
      // Edit mode must send an explicit null to UNLINK the table (undefined
      // would be dropped from the JSON body and keep the old mapping).
      updateZoneMutation.mutate({
        id: editingZone.id,
        version: editingZone.version,
        body: {
          name: zoneName.trim(),
          kind: zoneKind,
          tableId: formTableId,
          polygon,
          seats,
          active: zoneActive,
        },
      })
    } else {
      createZoneMutation.mutate({
        cameraId: camera.id,
        name: zoneName.trim(),
        kind: zoneKind,
        tableId: formTableId ?? undefined,
        polygon,
        seats,
        active: zoneActive,
      })
    }
  }

  const runTest = () => {
    if (formTableId == null) {
      toast.error(t('vision.zones.needTable'))
      return
    }
    testDetectionMutation.mutate(formTableId)
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-64" />
        <Skeleton className="aspect-[4/3] w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    )
  }
  if (isError) {
    return <VisionErrorCard onRetry={refetch} />
  }

  if (cameras.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
          <SquareDashed className="size-8 text-muted-foreground/40" aria-hidden />
          <p className="font-medium">{t('vision.cameras.empty')}</p>
          <p className="text-sm text-muted-foreground">{t('vision.cameras.emptyHint')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{t('vision.zones.subtitle')}</p>
          <div className="flex items-center gap-2">
            <Label htmlFor="zone-camera" className="text-xs">
              {t('vision.zones.camera')}
            </Label>
            <Select
              value={String(camera?.id ?? '')}
              onValueChange={(v) => {
                setCameraId(Number(v))
                resetZoneForm()
                cancelDrawing()
              }}
            >
              <SelectTrigger id="zone-camera" className="h-11 w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {cameras.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    <span className="font-mono text-xs uppercase">{c.code}</span> · {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {drawing ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-amber-700 tabular-nums">
              {t('vision.zones.points', { n: points.length })} —{' '}
              {points.length < MIN_ZONE_POINTS ? t('vision.zones.needMin') : ''}
            </span>
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              disabled={points.length === 0}
              onClick={() => setPoints((prev) => prev.slice(0, -1))}
            >
              <Eraser className="size-4" aria-hidden />
              {t('vision.zones.undoPoint')}
            </Button>
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              onClick={cancelDrawing}
            >
              {t('vision.zones.cancelDraw')}
            </Button>
            <Button
              className="h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={points.length < MIN_ZONE_POINTS}
              title={t('vision.zones.closeSaveHint')}
              onClick={commitPolygon}
            >
              {t('vision.zones.closeSave')}
            </Button>
          </div>
        ) : (
          <Button variant="outline" className="h-11 gap-1.5" onClick={startDrawing}>
            <Crosshair className="size-4" aria-hidden />
            {t('vision.zones.draw')}
          </Button>
        )}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-3">
        {/* ── schematic canvas ── */}
        <Card className="xl:col-span-2">
          <CardContent className="space-y-2 p-4">
            {floorPlan == null ? (
              <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-300 bg-stone-50 text-center">
                <SquareDashed className="size-8 text-muted-foreground/40" aria-hidden />
                <p className="max-w-sm px-4 text-sm text-muted-foreground">
                  {t('vision.zones.noFloor')}
                </p>
              </div>
            ) : (
              <>
                <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl border-2 border-stone-300 bg-[radial-gradient(circle,#ece7dc_1px,transparent_1px)] [background-size:22px_22px]">
                  {floorPlan.backgroundImage && (
                    <img
                      src={floorPlan.backgroundImage}
                      alt={floorPlan.name}
                      className="absolute inset-0 h-full w-full object-contain opacity-60"
                    />
                  )}

                  {/* zones overlay (SVG 0..100 normalized, stretched) */}
                  <svg
                    ref={svgRef}
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className={cn('absolute inset-0 h-full w-full', drawing && 'cursor-crosshair')}
                    onClick={addPoint}
                    aria-label={t('vision.zones.subtitle')}
                  >
                    {cameraZones.map((zone) => {
                      const selected = editingZone?.id === zone.id
                      const pts = zone.polygon.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')
                      return (
                        <polygon
                          key={zone.id}
                          points={pts}
                          fill={selected ? 'rgba(5,150,105,0.20)' : 'rgba(180,83,9,0.18)'}
                          stroke={selected ? '#059669' : '#d97706'}
                          strokeWidth={selected ? 2 : 0.6}
                          className={cn(!drawing && 'cursor-pointer')}
                          style={{ pointerEvents: drawing ? 'none' : 'auto' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (!drawing) selectZone(zone)
                          }}
                        >
                          <title>{zone.name}</title>
                        </polygon>
                      )
                    })}

                    {/* committed draft / editing outline (emerald highlight) */}
                    {polygon && polygon.length >= MIN_ZONE_POINTS && (
                      <polygon
                        points={polygon.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                        fill="rgba(5,150,105,0.10)"
                        stroke="#059669"
                        strokeWidth={0.8}
                        strokeDasharray="1.5,1"
                        style={{ pointerEvents: 'none' }}
                      />
                    )}

                    {/* in-progress drawing */}
                    {drawing && points.length > 0 && (
                      <>
                        {points.length >= MIN_ZONE_POINTS && (
                          <polygon
                            points={points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                            fill="rgba(180,83,9,0.10)"
                            stroke="#d97706"
                            strokeWidth={0.5}
                            strokeDasharray="1,1"
                            style={{ pointerEvents: 'none' }}
                          />
                        )}
                        <polyline
                          points={points.map((p) => `${p.x * 100},${p.y * 100}`).join(' ')}
                          fill="none"
                          stroke="#b45309"
                          strokeWidth={0.5}
                          style={{ pointerEvents: 'none' }}
                        />
                        {points.map((p, i) => (
                          <g key={i} style={{ pointerEvents: 'none' }}>
                            <circle cx={p.x * 100} cy={p.y * 100} r={0.9} fill="#b45309" />
                            <circle
                              cx={p.x * 100}
                              cy={p.y * 100}
                              r={2.2}
                              fill="none"
                              stroke="#b45309"
                              strokeWidth={0.35}
                            />
                          </g>
                        ))}
                      </>
                    )}
                  </svg>

                  {/* schematic table dots (click → prefill the form) */}
                  {tables.map((tb) => (
                    <button
                      key={tb.id}
                      type="button"
                      disabled={drawing}
                      title={tb.name}
                      aria-label={`${tb.name} — ${t(`status.table.${tb.status}`)}`}
                      style={{ left: `${tb.positionX}%`, top: `${tb.positionY}%` }}
                      onClick={() => prefillFromTable(tb)}
                      className={cn(
                        'absolute z-10 -translate-x-1/2 -translate-y-1/2 rounded-lg border px-1.5 py-0.5 text-[10px] font-bold shadow-sm transition',
                        tableDotClasses(tb.status),
                        formTableId === tb.id && 'ring-2 ring-emerald-500',
                        drawing ? 'pointer-events-none opacity-70' : 'hover:shadow-md',
                      )}
                    >
                      {tb.name}
                    </button>
                  ))}
                </div>
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                  <MousePointerClick className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {t('vision.zones.clickTableHint')} · {t('vision.zones.clickZoneHint')}
                </p>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t('vision.zones.calibrationHint')}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* ── zone form ── */}
        <Card>
          <CardHeader className="space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <SquareDashed className="size-4" aria-hidden />
              {editingZone
                ? t('vision.zones.editing', { name: editingZone.name })
                : t('vision.zones.newZone')}
            </CardTitle>
            <CardDescription className="text-[11px]">
              {polygon != null && polygon.length >= MIN_ZONE_POINTS
                ? t('vision.zones.points', { n: polygon.length })
                : t('vision.zones.polygonRequired')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="zone-name">{t('vision.zones.zoneName')}</Label>
              <Input
                id="zone-name"
                className="h-11"
                placeholder="Z-T1"
                value={zoneName}
                onChange={(e) => setZoneName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="zone-kind">{t('vision.zones.zoneKind')}</Label>
              <Select value={zoneKind} onValueChange={setZoneKind}>
                <SelectTrigger id="zone-kind" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISION_ZONE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`vision.zones.kind.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="zone-table">{t('vision.zones.linkedTable')}</Label>
              <Select value={zoneTableId} onValueChange={setZoneTableId}>
                <SelectTrigger id="zone-table" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('vision.zones.tableNone')}</SelectItem>
                  {tables.map((tb) => (
                    <SelectItem key={tb.id} value={String(tb.id)}>
                      {tb.name}
                    </SelectItem>
                  ))}
                  {editingZone?.tableId != null &&
                    !tables.some((tb) => tb.id === editingZone.tableId) && (
                      <SelectItem value={String(editingZone.tableId)}>
                        {editingZone.tableName ?? `#${editingZone.tableId}`}
                      </SelectItem>
                    )}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-snug text-muted-foreground">
                {t('vision.zones.tableHint')}
              </p>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="zone-seats">{t('common.seats')}</Label>
                <Input
                  id="zone-seats"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={30}
                  className="h-11"
                  value={zoneSeats}
                  onChange={(e) => setZoneSeats(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2 pb-3">
                <Switch
                  id="zone-active"
                  checked={zoneActive}
                  onCheckedChange={setZoneActive}
                  aria-label={t('common.active')}
                />
                <Label htmlFor="zone-active" className="text-xs">
                  {t('common.active')}
                </Label>
              </div>
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <Button
                className="h-11 w-full gap-1.5"
                disabled={!canSave || createZoneMutation.isPending || updateZoneMutation.isPending}
                onClick={submitZone}
              >
                {(createZoneMutation.isPending || updateZoneMutation.isPending) && (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                )}
                {editingZone ? t('vision.zones.save') : t('vision.zones.create')}
              </Button>
              <Button
                variant="outline"
                className="h-11 w-full gap-1.5"
                disabled={formTableId == null || testDetectionMutation.isPending}
                title={t('vision.zones.testHint')}
                onClick={runTest}
              >
                {testDetectionMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-4" aria-hidden />
                )}
                {t('vision.zones.test')}
              </Button>
              {editingZone && (
                <Button
                  variant="outline"
                  className="h-11 w-full gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                  disabled={deleteZoneMutation.isPending}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t('common.delete')}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── zones list for this camera ── */}
      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="text-base">{t('vision.zones.listTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {cameraZones.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-200 bg-stone-50 p-4 text-sm text-muted-foreground">
              {t('vision.zones.none')}
            </p>
          ) : (
            <ul className="rms-scroll max-h-72 divide-y divide-stone-100 overflow-y-auto pr-1">
              {cameraZones.map((zone) => (
                <li key={zone.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                  <button
                    type="button"
                    className="font-medium underline-offset-2 hover:underline"
                    onClick={() => selectZone(zone)}
                  >
                    {zone.name}
                  </button>
                  <Badge
                    variant="outline"
                    className={cn(
                      zone.tableId != null
                        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                        : 'border-stone-300 bg-stone-100 text-stone-500',
                    )}
                  >
                    {zone.tableName ?? t('vision.zones.tableNone')}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {t(`vision.zones.kind.${zone.kind}`)}
                  </Badge>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {t('vision.zones.points', { n: zone.polygon.length })} ·{' '}
                    {t('vision.zones.version', { n: zone.version })}
                  </span>
                  <span className="ms-auto flex items-center gap-2">
                    <Switch
                      checked={zone.active}
                      aria-label={`${t('common.active')} — ${zone.name}`}
                      onCheckedChange={(checked) =>
                        updateZoneMutation.mutate({
                          id: zone.id,
                          version: zone.version,
                          body: { active: checked },
                        })
                      }
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── delete zone confirm ── */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(o) => {
          if (!o && !deleteZoneMutation.isPending) setDeleteOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('vision.zones.deleteTitle', { name: editingZone?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('vision.zones.deleteDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteZoneMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              disabled={deleteZoneMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (editingZone) deleteZoneMutation.mutate(editingZone.id)
              }}
            >
              {deleteZoneMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
