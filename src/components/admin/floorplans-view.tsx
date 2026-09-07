'use client'

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Armchair, Loader2, Map, MapPin, Plus, Trash2, Users } from 'lucide-react'
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

const TABLE_STYLES: Record<string, { surface: string; dot: string }> = {
  free: { surface: 'border-emerald-400 bg-emerald-50 text-emerald-900', dot: 'bg-emerald-500' },
  occupied: { surface: 'border-amber-400 bg-amber-100 text-amber-950', dot: 'bg-amber-500' },
  reserved: { surface: 'border-rose-400 bg-rose-50 text-rose-900', dot: 'bg-rose-500' },
}

/** Canvas tile sizing per table shape (6-c spec): round → circle, etc. */
const SHAPE_TILE_CLASSES: Record<string, string> = {
  square: 'h-20 w-24 rounded-xl',
  round: 'h-24 w-24 rounded-full',
  rectangle: 'h-24 w-32 rounded-xl',
  oval: 'h-24 w-32 rounded-full',
}

function shapeTileClasses(shape: string): string {
  return SHAPE_TILE_CLASSES[shape] ?? SHAPE_TILE_CLASSES.square
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

              <div
                ref={canvasRef}
                className="relative h-[460px] w-full touch-none overflow-hidden rounded-xl border-2 border-dashed border-border bg-[radial-gradient(circle,#e7e2d8_1px,transparent_1px)] [background-size:22px_22px]"
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
                    const styles =
                      TABLE_STYLES[table.status] ?? {
                        surface: 'border-stone-300 bg-stone-50 text-stone-700',
                        dot: 'bg-stone-400',
                      }
                    const statusLabel = t(`status.table.${table.status}`)
                    const showGuests =
                      table.status === 'occupied' && table.openOrderGuests != null
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
                          'absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none select-none flex-col items-center justify-center gap-0.5 border-2 p-1 font-semibold shadow-sm transition-shadow active:cursor-grabbing',
                          shapeTileClasses(table.shape ?? 'square'),
                          styles.surface,
                          isDragging && 'z-30 cursor-grabbing scale-105 shadow-lg ring-2 ring-ring/60',
                        )}
                      >
                        <span className="max-w-full truncate px-1 text-sm font-bold leading-tight">
                          {table.name}
                        </span>
                        {showGuests ? (
                          <span className="flex items-center gap-1 text-[11px] font-medium opacity-80">
                            <Users className="size-3 shrink-0" aria-hidden />
                            {table.openOrderGuests} {t('common.people')}
                          </span>
                        ) : (
                          <span className="text-[11px] font-medium opacity-75">
                            {table.capacity} {t('common.seats')}
                          </span>
                        )}
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider opacity-80">
                          <span className={cn('size-2 rounded-full', styles.dot)} />
                          {statusLabel}
                        </span>
                      </div>
                    )
                  })
                )}
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
