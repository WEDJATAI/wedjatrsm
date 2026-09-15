'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Armchair,
  BadgeCheck,
  Brush,
  Clock,
  DoorOpen,
  Hourglass,
  Loader2,
  Map,
  MapPin,
  Plus,
  Trash2,
  Users,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { apiFetch, fetcher } from '@/lib/api'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { TABLE_SHAPES } from '@/lib/constants'
import type { FloorPlan, RestaurantTable } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

type DragState = {
  table: RestaurantTable
  pointerId: number
  startX: number
  startY: number
  /** Offset (in canvas %) between the grab point and the table center. */
  offX: number
  offY: number
  x: number
  y: number
  movedPx: number
}

/** Odoo 17-style tile silhouettes (BINDING — mirrors the POS floor screen). */
const SHAPE_TILE_CLASSES: Record<string, string> = {
  square: 'aspect-square rounded-2xl',
  round: 'aspect-square rounded-full',
  rectangle: 'h-24 rounded-2xl',
  oval: 'h-24 rounded-full',
}

function shapeTileClasses(shape: string): string {
  return SHAPE_TILE_CLASSES[shape] ?? SHAPE_TILE_CLASSES.square
}

/** Occupied-tile duration heat: <15m emerald · 15–44 amber · 45–89 orange · ≥90 rose. */
function occupiedHeatClasses(mins: number): { surface: string; amount: string } {
  if (mins < 15)
    return { surface: 'bg-emerald-50 border-emerald-200 text-emerald-900', amount: 'text-emerald-700' }
  if (mins < 45)
    return { surface: 'bg-amber-50 border-amber-200 text-amber-900', amount: 'text-amber-700' }
  if (mins < 90)
    return { surface: 'bg-orange-100 border-orange-300 text-orange-900', amount: 'text-orange-700' }
  return { surface: 'bg-rose-100 border-rose-300 text-rose-900', amount: 'text-rose-700' }
}

/** Tile surface per live status: free = white, reserved = amber ring, occupied = duration heat,
 *  paid = settled (emerald), deferred = client left with an open check (violet),
 *  dirty = bussed, awaiting the cleaning click (strong amber). */
function tableSurfaceClasses(
  table: RestaurantTable,
  mins: number,
): { surface: string; amount: string | null } {
  if (table.status === 'occupied') {
    const heat = occupiedHeatClasses(mins)
    return { surface: heat.surface, amount: heat.amount }
  }
  if (table.status === 'reserved')
    return { surface: 'bg-amber-50/70 border-amber-300 ring-1 ring-amber-400', amount: null }
  if (table.status === 'free') return { surface: 'bg-white border-border shadow-sm', amount: null }
  if (table.status === 'paid')
    return { surface: 'bg-emerald-600 border-emerald-600 text-white shadow-sm', amount: null }
  if (table.status === 'deferred')
    return {
      surface: 'bg-violet-100 border-violet-400 ring-1 ring-violet-400 text-violet-900',
      amount: null,
    }
  if (table.status === 'dirty')
    return {
      surface: 'bg-amber-200 border-amber-500 ring-2 ring-amber-400 text-amber-900',
      amount: null,
    }
  // unknown status — neutral stone fallback (keeps tiles readable)
  return { surface: 'border-stone-300 bg-stone-50 text-stone-700', amount: null }
}

/** Tiny shape glyph used next to each Select option. */
function ShapeGlyph({ shape, className }: { shape: string; className?: string }) {
  const cls =
    shape === 'round'
      ? 'size-3.5 rounded-full'
      : shape === 'oval'
        ? 'h-3 w-5 rounded-full'
        : shape === 'rectangle'
          ? 'h-3 w-5 rounded-[3px]'
          : 'size-3.5 rounded-[3px]'
  return <span className={cn('inline-block shrink-0 border-2 border-current', cls, className)} aria-hidden />
}

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))
const round1 = (value: number) => Math.round(value * 10) / 10
const toNumber = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Floor plan manager — list of plans + drag-to-arrange table canvas. */
export default function FloorPlansView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null)

  const [newPlanOpen, setNewPlanOpen] = useState(false)
  const [newPlanName, setNewPlanName] = useState('')

  const [addTableOpen, setAddTableOpen] = useState(false)
  const [addTableName, setAddTableName] = useState('')
  const [addTableCapacity, setAddTableCapacity] = useState('2')
  const [addTableShape, setAddTableShape] = useState('square')

  const [editOpen, setEditOpen] = useState(false)
  const [editingTable, setEditingTable] = useState<RestaurantTable | null>(null)
  const [editName, setEditName] = useState('')
  const [editCapacity, setEditCapacity] = useState('2')
  const [editShape, setEditShape] = useState('square')
  const [editX, setEditX] = useState('50')
  const [editY, setEditY] = useState('50')
  const [editStatus, setEditStatus] = useState('free')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['floorplans'],
    queryFn: () => fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans'),
    refetchInterval: 10000,
  })

  const floorPlans = data?.floorPlans ?? []
  const selectedPlan = floorPlans.find((plan) => plan.id === selectedPlanId) ?? floorPlans[0] ?? null
  const activeTables = selectedPlan
    ? selectedPlan.tables.filter((table) => table.active)
    : []
  // Hall stats for the canvas header strip: free = status 'free' exactly
  // (paid/deferred tables are NOT free — they await cleanup).
  const hallStats = {
    free: activeTables.filter((table) => table.status === 'free').length,
    occupied: activeTables.filter((table) => table.status === 'occupied').length,
  }

  // ── Mutations ────────────────────────────────────────────────────────

  const createPlanMutation = useMutation({
    mutationFn: (name: string) =>
      apiFetch<{ floorPlan: FloorPlan }>('/api/floorplans', { method: 'POST', body: { name } }),
    onSuccess: ({ floorPlan }) => {
      toast.success(t('admin.floorPlanCreated', { name: floorPlan.name }))
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      setSelectedPlanId(floorPlan.id)
      setNewPlanOpen(false)
      setNewPlanName('')
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  const togglePlanMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch(`/api/floorplans/${id}`, { method: 'PUT', body: { active } }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['floorplans'] })
      const previous = queryClient.getQueryData<{ floorPlans: FloorPlan[] }>(['floorplans'])
      if (previous) {
        queryClient.setQueryData(['floorplans'], {
          floorPlans: previous.floorPlans.map((plan) =>
            plan.id === id ? { ...plan, active } : plan,
          ),
        })
      }
      return { previous }
    },
    onError: (mutationError, _variables, context) => {
      toast.error(mutationError.message || t('error.generic'))
      if (context?.previous) {
        queryClient.setQueryData(['floorplans'], context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
    },
  })

  const addTableMutation = useMutation({
    mutationFn: (input: {
      floorPlanId: number
      name: string
      capacity: number
      shape: string
      positionX: number
      positionY: number
    }) => apiFetch<{ table: RestaurantTable }>('/api/tables', { method: 'POST', body: input }),
    onSuccess: ({ table }) => {
      toast.success(t('admin.tableAdded', { name: table.name }))
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      setAddTableOpen(false)
      setAddTableName('')
      setAddTableCapacity('2')
      setAddTableShape('square')
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  const updateTableMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number
      body: Record<string, unknown>
      successMessage?: string
      closeDialog?: boolean
    }) => apiFetch<{ table: RestaurantTable }>(`/api/tables/${id}`, { method: 'PUT', body }),
    onSuccess: (_result, variables) => {
      toast.success(variables.successMessage ?? t('admin.tableUpdated'))
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      if (variables.closeDialog) {
        setEditOpen(false)
        setEditingTable(null)
      }
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  // ── Table edit dialog ────────────────────────────────────────────────

  function openTableDialog(table: RestaurantTable) {
    setEditName(table.name)
    setEditCapacity(String(table.capacity))
    setEditShape(table.shape ?? 'square')
    setEditX(String(round1(table.positionX)))
    setEditY(String(round1(table.positionY)))
    setEditStatus(table.status)
    setEditingTable(table)
    setEditOpen(true)
  }

  // ── Pointer-based dragging (mouse + touch) ───────────────────────────

  function beginDrag(event: React.PointerEvent<HTMLDivElement>, table: RestaurantTable) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Pointer already released — ignore.
    }
    const pointerX = ((event.clientX - rect.left) / rect.width) * 100
    const pointerY = ((event.clientY - rect.top) / rect.height) * 100
    const state: DragState = {
      table,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offX: pointerX - table.positionX,
      offY: pointerY - table.positionY,
      x: table.positionX,
      y: table.positionY,
      movedPx: 0,
    }
    dragRef.current = state
    setDrag(state)
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pointerX = ((event.clientX - rect.left) / rect.width) * 100
    const pointerY = ((event.clientY - rect.top) / rect.height) * 100
    const next: DragState = {
      ...current,
      x: clampPercent(pointerX - current.offX, 2, 98),
      y: clampPercent(pointerY - current.offY, 2, 98),
      movedPx: Math.max(
        current.movedPx,
        Math.hypot(event.clientX - current.startX, event.clientY - current.startY),
      ),
    }
    dragRef.current = next
    setDrag(next)
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>, commit: boolean) {
    const current = dragRef.current
    if (!current || current.pointerId !== event.pointerId) return
    dragRef.current = null
    setDrag(null)
    if (!commit) return
    if (current.movedPx < 6) {
      // Treated as a click → open the table editor.
      openTableDialog(current.table)
      return
    }
    updateTableMutation.mutate({
      id: current.table.id,
      body: { positionX: round1(current.x), positionY: round1(current.y) },
      successMessage: t('admin.positionSaved'),
    })
  }

  // ── Form submit handlers ─────────────────────────────────────────────

  function handleCreatePlan() {
    const name = newPlanName.trim()
    if (!name) {
      toast.error(t('admin.floorPlanNameRequired'))
      return
    }
    createPlanMutation.mutate(name)
  }

  function handleAddTable() {
    if (!selectedPlan) return
    const name = addTableName.trim()
    if (!name) {
      toast.error(t('admin.tableNameRequired'))
      return
    }
    const parsedCapacity = Number(addTableCapacity)
    const capacity = Math.max(
      1,
      Math.round(Number.isFinite(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : 2),
    )
    // Spawn at a center-ish random spot (30-70%).
    const positionX = round1(30 + Math.random() * 40)
    const positionY = round1(30 + Math.random() * 40)
    addTableMutation.mutate({
      floorPlanId: selectedPlan.id,
      name,
      capacity,
      shape: addTableShape,
      positionX,
      positionY,
    })
  }

  function handleSaveTable() {
    if (!editingTable) return
    const name = editName.trim()
    if (!name) {
      toast.error(t('admin.tableNameRequired'))
      return
    }
    const parsedCapacity = Number(editCapacity)
    const capacity = Math.max(
      1,
      Math.round(
        Number.isFinite(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : editingTable.capacity,
      ),
    )
    const body: Record<string, unknown> = {
      name,
      capacity,
      shape: editShape,
      positionX: clampPercent(round1(toNumber(editX, editingTable.positionX)), 0, 100),
      positionY: clampPercent(round1(toNumber(editY, editingTable.positionY)), 0, 100),
    }
    // 'occupied' is managed automatically by open orders — never send it.
    if (editStatus === 'free' || editStatus === 'reserved') {
      body.status = editStatus
    }
    updateTableMutation.mutate({
      id: editingTable.id,
      body,
      successMessage: t('admin.tableUpdated'),
      closeDialog: true,
    })
  }

  function handleRemoveTable() {
    if (!editingTable) return
    updateTableMutation.mutate({
      id: editingTable.id,
      body: { active: false },
      successMessage: t('admin.tableRemoved'),
      closeDialog: true,
    })
  }

  const creatingPlan = createPlanMutation.isPending
  const addingTable = addTableMutation.isPending
  const savingTable = updateTableMutation.isPending

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('nav.floorplans')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.floorplansSubtitle')}</p>
        </div>
        <Dialog open={newPlanOpen} onOpenChange={setNewPlanOpen}>
          <DialogTrigger asChild>
            <Button size="lg">
              <Plus className="size-4" />
              {t('admin.newFloorPlan')}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('admin.newFloorPlanTitle')}</DialogTitle>
              <DialogDescription>{t('admin.newFloorPlanDesc')}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-name">{t('common.name')}</Label>
              <Input
                id="plan-name"
                value={newPlanName}
                placeholder={t('admin.planNamePlaceholder')}
                onChange={(event) => setNewPlanName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') handleCreatePlan()
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setNewPlanOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleCreatePlan} disabled={creatingPlan || !newPlanName.trim()}>
                {creatingPlan ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('admin.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : t('admin.loadFloorplansFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
          <div className="space-y-3">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-[460px] w-full rounded-xl" />
          </div>
        </div>
      ) : floorPlans.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 border-dashed p-12 py-20 text-center">
          <Map className="size-14 text-muted-foreground/40" />
          <div className="space-y-1">
            <p className="font-semibold">{t('admin.noFloorPlans')}</p>
            <p className="text-sm text-muted-foreground">{t('admin.createFirstPlan')}</p>
          </div>
          <Button onClick={() => setNewPlanOpen(true)}>
            <Plus className="size-4" />
            {t('admin.newFloorPlan')}
          </Button>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          {/* Floor plan list */}
          <div className="space-y-2 self-start">
            <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('admin.diningAreas')}
            </p>
            {floorPlans.map((plan) => {
              const activeTableCount = plan.tables.filter((table) => table.active).length
              const isSelected = selectedPlan !== null && plan.id === selectedPlan.id
              return (
                <Card
                  key={plan.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedPlanId(plan.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelectedPlanId(plan.id)
                    }
                  }}
                  className={cn(
                    'cursor-pointer p-3 transition-colors hover:bg-accent/40',
                    isSelected && 'border-primary bg-primary/5',
                    !plan.active && 'opacity-60',
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold leading-tight">{plan.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('admin.tableCount', { count: activeTableCount })}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={plan.active}
                        onCheckedChange={(checked) =>
                          togglePlanMutation.mutate({ id: plan.id, active: checked })
                        }
                        aria-label={`${t('common.active')}: ${plan.name}`}
                      />
                    </div>
                  </div>
                </Card>
              )
            })}
          </div>

          {/* Canvas editor */}
          {selectedPlan && (
            <Card className="gap-4 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-bold leading-tight">{selectedPlan.name}</h2>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <MapPin className="size-3.5 shrink-0" />
                    {t('admin.dragHint')}
                  </p>
                </div>
                <Dialog open={addTableOpen} onOpenChange={setAddTableOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Plus className="size-4" />
                      {t('admin.addTable')}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-sm">
                    <DialogHeader>
                      <DialogTitle>{t('admin.addTableTitle')}</DialogTitle>
                      <DialogDescription>{t('admin.addTableDesc')}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="table-name">{t('common.name')}</Label>
                        <Input
                          id="table-name"
                          value={addTableName}
                          placeholder={t('admin.tableNamePlaceholder')}
                          onChange={(event) => setAddTableName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddTable()
                          }}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                          <Label htmlFor="table-capacity">{t('admin.capacitySeats')}</Label>
                          <Input
                            id="table-capacity"
                            type="number"
                            min={1}
                            value={addTableCapacity}
                            onChange={(event) => setAddTableCapacity(event.target.value)}
                          />
                        </div>
                        <div className="grid gap-1.5">
                          <Label htmlFor="table-shape">{t('admin.shapeLabel')}</Label>
                          <Select value={addTableShape} onValueChange={setAddTableShape}>
                            <SelectTrigger id="table-shape" className="w-full">
                              <SelectValue placeholder={t('admin.shapeLabel')} />
                            </SelectTrigger>
                            <SelectContent>
                              {TABLE_SHAPES.map((shape) => (
                                <SelectItem key={shape} value={shape}>
                                  <span className="flex items-center gap-2">
                                    <ShapeGlyph shape={shape} />
                                    {t(`shape.${shape}`)}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setAddTableOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button onClick={handleAddTable} disabled={addingTable || !addTableName.trim()}>
                        {addingTable ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Plus className="size-4" />
                        )}
                        {t('common.add')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>

              <div className="relative">
                <div
                  ref={canvasRef}
                  className="relative h-[460px] w-full touch-none overflow-hidden rounded-2xl border-2 border-[#D6D0C4] bg-[radial-gradient(circle,#ece7dc_1px,transparent_1px)] [background-size:22px_22px] shadow-inner"
                >
                  {activeTables.length === 0 ? (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                      <Armchair className="size-12 text-muted-foreground/40" />
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('admin.addTablesEmpty')}
                      </p>
                    </div>
                  ) : (
                    activeTables.map((table) => {
                      const isDragging = drag !== null && drag.table.id === table.id
                      const x = isDragging ? drag.x : table.positionX
                      const y = isDragging ? drag.y : table.positionY
                      // Minutes since the open order started (duration heat driver).
                      const mins = table.openOrderSince
                        ? Math.max(0, (Date.now() - new Date(table.openOrderSince).getTime()) / 60000)
                        : 0
                      const { surface, amount: amountClass } = tableSurfaceClasses(table, mins)
                      const isOccupied = table.status === 'occupied'
                      const isPaid = table.status === 'paid'
                      const isDeferred = table.status === 'deferred'
                      const isDirty = table.status === 'dirty'
                      const shape = table.shape ?? 'square'
                      const statusLabel = t(`status.table.${table.status}`)
                      return (
                        <div
                          key={table.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`${table.name}, ${statusLabel}`}
                          style={{ left: `${x}%`, top: `${y}%` }}
                          onPointerDown={(event) => beginDrag(event, table)}
                          onPointerMove={moveDrag}
                          onPointerUp={(event) => endDrag(event, true)}
                          onPointerCancel={(event) => endDrag(event, false)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openTableDialog(table)
                            }
                          }}
                          className={cn(
                            'absolute w-28 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none',
                            isDragging && 'z-30 cursor-grabbing',
                          )}
                        >
                          <div
                            className={cn(
                              'flex w-full flex-col items-center justify-center gap-1 border-2 p-3 text-center shadow-sm transition hover:shadow-md',
                              shapeTileClasses(shape),
                              (shape === 'round' || shape === 'oval') && 'px-4',
                              surface,
                              isDragging && 'scale-105 shadow-lg ring-2 ring-ring/60',
                            )}
                          >
                            <span
                              className={cn(
                                'max-w-full truncate px-1 leading-tight',
                                isOccupied || isPaid || isDeferred
                                  ? 'text-base font-bold'
                                  : 'text-sm font-bold text-stone-500',
                              )}
                            >
                              {table.name}
                            </span>
                            {isOccupied ? (
                              <>
                                <span
                                  className={cn(
                                    'text-lg font-extrabold tabular-nums',
                                    amountClass,
                                  )}
                                >
                                  {formatCurrency(table.openOrderTotal ?? 0)}
                                </span>
                                <span className="flex items-center gap-1 text-[11px] font-medium">
                                  <Users className="size-3 shrink-0" aria-hidden />
                                  {table.openOrderGuests ?? table.capacity}
                                  <span aria-hidden>·</span>
                                  <Clock className="size-3 shrink-0" aria-hidden />
                                  {elapsedSince(table.openOrderSince ?? new Date())}
                                </span>
                              </>
                            ) : isPaid ? (
                              <span className="flex items-center gap-1 px-1 text-[11px] font-medium leading-tight">
                                <BadgeCheck className="size-4 shrink-0" aria-hidden />
                                {t('status.table.paid')}
                              </span>
                            ) : isDeferred ? (
                              <>
                                <span className="flex items-center gap-1 px-1 text-[11px] font-medium leading-tight">
                                  <Hourglass className="size-4 shrink-0" aria-hidden />
                                  {t('status.table.deferred')}
                                </span>
                                {table.deferredClientName ? (
                                  <span
                                    dir="auto"
                                    className="max-w-full truncate px-1 text-sm font-semibold leading-tight"
                                  >
                                    {table.deferredClientName}
                                  </span>
                                ) : null}
                              </>
                            ) : isDirty ? (
                              <span className="flex items-center gap-1 px-1 text-[11px] font-medium leading-tight">
                                <Brush className="size-4 shrink-0" aria-hidden />
                                {t('status.table.dirty')}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-xs text-stone-400">
                                <Users className="size-3 shrink-0" aria-hidden />
                                {table.capacity} {t('common.seats')}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}

                  {/* Hall stats — pinned inside the top of the canvas (never blocks dragging) */}
                  <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 bg-white/70 px-3 py-1.5 text-[11px] font-medium text-stone-500 backdrop-blur-sm">
                    <span>{t('admin.hallStatsTables', { n: activeTables.length })}</span>
                    <span className="text-emerald-700">
                      {t('admin.hallStatsFree', { n: hallStats.free })}
                    </span>
                    <span className="text-amber-700">
                      {t('admin.hallStatsOccupied', { n: hallStats.occupied })}
                    </span>
                  </div>
                </div>

                {/* Entrance marker — sits on the bottom border, mostly outside the canvas */}
                <div className="pointer-events-none absolute -bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-white px-3 py-1 text-[11px] font-medium text-stone-500 shadow-sm">
                  <DoorOpen className="size-3.5 shrink-0" aria-hidden />
                  {t('admin.hallEntrance')}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Table edit dialog */}
      <Dialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open)
          if (!open) setEditingTable(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('admin.editTable')}</DialogTitle>
            <DialogDescription>{t('admin.editTableDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">{t('common.name')}</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(event) => setEditName(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-capacity">{t('admin.capacitySeats')}</Label>
                <Input
                  id="edit-capacity"
                  type="number"
                  min={1}
                  value={editCapacity}
                  onChange={(event) => setEditCapacity(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-shape">{t('admin.shapeLabel')}</Label>
                <Select value={editShape} onValueChange={setEditShape}>
                  <SelectTrigger id="edit-shape" className="w-full">
                    <SelectValue placeholder={t('admin.shapeLabel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {TABLE_SHAPES.map((shape) => (
                      <SelectItem key={shape} value={shape}>
                        <span className="flex items-center gap-2">
                          <ShapeGlyph shape={shape} />
                          {t(`shape.${shape}`)}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-status">{t('common.status')}</Label>
              <Select value={editStatus} onValueChange={setEditStatus}>
                <SelectTrigger id="edit-status" className="w-full">
                  <SelectValue placeholder={t('admin.statusPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="free">{t('status.table.free')}</SelectItem>
                  <SelectItem value="reserved">{t('status.table.reserved')}</SelectItem>
                  <SelectItem value="occupied" disabled>
                    {t('admin.occupiedAuto')}
                  </SelectItem>
                  {/* paid / deferred / dirty are system-managed (set from the POS
                      floor turnover flow) — visible but not settable */}
                  <SelectItem value="paid" disabled>
                    {t('status.table.paid')}
                  </SelectItem>
                  <SelectItem value="deferred" disabled>
                    {t('status.table.deferred')}
                  </SelectItem>
                  <SelectItem value="dirty" disabled>
                    {t('status.table.dirty')}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('admin.occupiedNote')}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="edit-x">{t('admin.positionX')}</Label>
                <Input
                  id="edit-x"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={editX}
                  onChange={(event) => setEditX(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="edit-y">{t('admin.positionY')}</Label>
                <Input
                  id="edit-y"
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={editY}
                  onChange={(event) => setEditY(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={savingTable}>
                  <Trash2 className="size-4" />
                  {t('admin.removeTable')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('admin.removeTableQ')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('admin.removeTableDesc')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleRemoveTable}
                    className="bg-destructive text-white hover:bg-destructive/90"
                  >
                    {t('admin.removeTable')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setEditOpen(false)
                  setEditingTable(null)
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSaveTable} disabled={savingTable || !editName.trim()}>
                {savingTable && <Loader2 className="size-4 animate-spin" />}
                {t('admin.saveChanges')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
