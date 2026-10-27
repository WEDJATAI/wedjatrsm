'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Armchair,
  BadgeCheck,
  Box,
  Frame,
  LayoutGrid,
  Loader2,
  Map,
  MapPin,
  Plus,
  Shapes,
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
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { apiFetch, fetcher } from '@/lib/api'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { FLOOR_SPACE_KINDS, TABLE_SHAPES } from '@/lib/constants'
import {
  FLOOR_SHAPES,
  FLOOR_SIZE_MAX,
  FLOOR_SIZE_MIN,
  clampPointToFloor,
  floorContainsPoint,
  floorShapeClip,
} from '@/lib/floor-geometry'
import type { FloorPlan, FloorSpace, RestaurantTable } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

// r56: the 3D floor plan engine — WebGL, client-only (no SSR).
const Floor3dScene = dynamic(() => import('@/components/floor3d/floor3d-scene'), {
  ssr: false,
  loading: () => (
    <div className='flex h-full w-full items-center justify-center rounded-2xl bg-[#f6f2ea]' role='status' aria-label='3D'>
      <Box className='size-10 animate-pulse text-stone-400' aria-hidden />
    </div>
  ),
})

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

/** Floor shape preset tile — a mini silhouette sharing the real clip-path. */
function FloorShapeTile({ shape, className }: { shape: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-8 w-12 border-2 border-current bg-current/10', className)}
      style={{ clipPath: floorShapeClip(shape) }}
    />
  )
}

const clampPercent = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))
const round1 = (value: number) => Math.round(value * 10) / 10
const toNumber = (value: string, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Floor plan manager — plan list + the r56 3D drag-to-arrange canvas. */
export default function FloorPlansView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [selectedPlanId, setSelectedPlanId] = useState<number | null>(null)

  // r56: 3D camera preset — perspective maquette or top-down blueprint
  const [view3d, setView3d] = useState<'perspective' | 'top'>('perspective')

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

  // p21: floor size & shape editor state
  const [floorEditOpen, setFloorEditOpen] = useState(false)
  const [floorShape, setFloorShape] = useState('rectangle')
  const [floorWidth, setFloorWidth] = useState(100)
  const [floorHeight, setFloorHeight] = useState(100)

  // r56: custom space dialogs
  const [addSpaceOpen, setAddSpaceOpen] = useState(false)
  const [addSpaceName, setAddSpaceName] = useState('')
  const [addSpaceKind, setAddSpaceKind] = useState('lounge')
  const [addSpaceWidth, setAddSpaceWidth] = useState(18)
  const [addSpaceDepth, setAddSpaceDepth] = useState(18)
  const [addSpaceRotation, setAddSpaceRotation] = useState(0)

  const [editSpaceOpen, setEditSpaceOpen] = useState(false)
  const [editingSpace, setEditingSpace] = useState<FloorSpace | null>(null)
  const [editSpaceName, setEditSpaceName] = useState('')
  const [editSpaceKind, setEditSpaceKind] = useState('lounge')
  const [editSpaceWidth, setEditSpaceWidth] = useState(18)
  const [editSpaceDepth, setEditSpaceDepth] = useState(18)
  const [editSpaceRotation, setEditSpaceRotation] = useState(0)
  const [editSpaceX, setEditSpaceX] = useState('50')
  const [editSpaceY, setEditSpaceY] = useState('50')

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
  const activeSpaces = selectedPlan ? selectedPlan.spaces ?? [] : []
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

  // p21: save the floor's size & shape, then nudge any table that falls in a
  // cut-away region back inside the walkable area (positions are preserved
  // whenever they still fit — only genuinely stranded tables move).
  const saveFloorGeometryMutation = useMutation({
    mutationFn: async ({ plan, tables }: { plan: FloorPlan; tables: RestaurantTable[] }) => {
      await apiFetch(`/api/floorplans/${plan.id}`, {
        method: 'PUT',
        body: { floorShape, widthUnits: floorWidth, heightUnits: floorHeight },
      })
      const stranded = tables
        .map((table) => {
          const target = clampPointToFloor(floorShape, table.positionX, table.positionY)
          return { table, target, moved: target.x !== table.positionX || target.y !== table.positionY }
        })
        .filter((entry) => entry.moved)
      // Spread clamped tables so they never stack on one point: each nudged
      // table gets a ring offset around its clamp target, then re-clamped
      // into the walkable area (the offset can't push it back into a notch).
      stranded.forEach((entry, i) => {
        const ring = Math.floor(i / 8)
        const angle = (i % 8) * (Math.PI / 4)
        const spread = 7 + ring * 7
        entry.target = clampPointToFloor(
          floorShape,
          clampPercent(entry.target.x + Math.cos(angle) * spread, 4, 96),
          clampPercent(entry.target.y + Math.sin(angle) * spread, 4, 96),
        )
      })
      for (const entry of stranded) {
        await apiFetch(`/api/tables/${entry.table.id}`, {
          method: 'PUT',
          body: { positionX: entry.target.x, positionY: entry.target.y },
        })
      }
      return { moved: stranded.length }
    },
    onSuccess: ({ moved }) => {
      toast.success(
        moved > 0
          ? t('admin.floorGeometrySavedMoved', { n: moved })
          : t('admin.floorGeometrySaved'),
      )
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      setFloorEditOpen(false)
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  /** Open the size & shape editor seeded from the selected plan. */
  function openFloorDialog(plan: FloorPlan) {
    setFloorShape(plan.floorShape ?? 'rectangle')
    setFloorWidth(plan.widthUnits ?? 100)
    setFloorHeight(plan.heightUnits ?? 100)
    setFloorEditOpen(true)
  }

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

  // ── r56: custom space mutations + edit dialog ────────────────────────

  const createSpaceMutation = useMutation({
    mutationFn: (input: {
      floorPlanId: number
      name: string
      kind: string
      widthUnits: number
      depthUnits: number
      rotation: number
    }) => apiFetch<{ space: FloorSpace }>('/api/floorspaces', { method: 'POST', body: input }),
    onSuccess: ({ space }) => {
      toast.success(t('admin.spaceAdded', { name: space.name }))
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      setAddSpaceOpen(false)
      setAddSpaceName('')
      setAddSpaceKind('lounge')
      setAddSpaceWidth(18)
      setAddSpaceDepth(18)
      setAddSpaceRotation(0)
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  const updateSpaceMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: number
      body: Record<string, unknown>
      successMessage?: string
      closeDialog?: boolean
    }) => apiFetch<{ space: FloorSpace }>(`/api/floorspaces/${id}`, { method: 'PUT', body }),
    onSuccess: (_result, variables) => {
      toast.success(variables.successMessage ?? t('admin.spaceUpdated'))
      void queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      if (variables.closeDialog) {
        setEditSpaceOpen(false)
        setEditingSpace(null)
      }
    },
    onError: (mutationError) =>
      toast.error(mutationError.message || t('error.generic')),
  })

  function openSpaceDialog(space: FloorSpace) {
    setEditSpaceName(space.name)
    setEditSpaceKind(space.kind)
    setEditSpaceWidth(Math.round(space.widthUnits))
    setEditSpaceDepth(Math.round(space.depthUnits))
    setEditSpaceRotation(Math.round(space.rotation))
    setEditSpaceX(String(round1(space.positionX)))
    setEditSpaceY(String(round1(space.positionY)))
    setEditingSpace(space)
    setEditSpaceOpen(true)
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
    // Spawn at a center-ish random spot (30-70%), always inside the shape.
    const shape = selectedPlan.floorShape ?? 'rectangle'
    const spawn = clampPointToFloor(
      shape,
      round1(30 + Math.random() * 40),
      round1(30 + Math.random() * 40),
    )
    const positionX = spawn.x
    const positionY = spawn.y
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

  // r56: custom space submit handlers
  function handleAddSpace() {
    if (!selectedPlan) return
    const name = addSpaceName.trim()
    if (!name) {
      toast.error(t('admin.spaceNameRequired'))
      return
    }
    createSpaceMutation.mutate({
      floorPlanId: selectedPlan.id,
      name,
      kind: addSpaceKind,
      widthUnits: addSpaceWidth,
      depthUnits: addSpaceDepth,
      rotation: addSpaceRotation,
    })
  }

  function handleSaveSpace() {
    if (!editingSpace) return
    const name = editSpaceName.trim()
    if (!name) {
      toast.error(t('admin.spaceNameRequired'))
      return
    }
    updateSpaceMutation.mutate({
      id: editingSpace.id,
      body: {
        name,
        kind: editSpaceKind,
        widthUnits: editSpaceWidth,
        depthUnits: editSpaceDepth,
        rotation: editSpaceRotation,
        positionX: clampPercent(round1(toNumber(editSpaceX, editingSpace.positionX)), 0, 100),
        positionY: clampPercent(round1(toNumber(editSpaceY, editingSpace.positionY)), 0, 100),
      },
      successMessage: t('admin.spaceUpdated'),
      closeDialog: true,
    })
  }

  function handleRemoveSpace() {
    if (!editingSpace) return
    updateSpaceMutation.mutate({
      id: editingSpace.id,
      body: { active: false },
      successMessage: t('admin.spaceRemoved'),
      closeDialog: true,
    })
  }

  const creatingPlan = createPlanMutation.isPending
  const addingTable = addTableMutation.isPending
  const addingSpace = createSpaceMutation.isPending
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
                    {t('admin.dragHint3d')}
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-2'>
                  {/* r56: camera presets — perspective maquette / top blueprint */}
                  <div
                    role='group'
                    aria-label={t('admin.view3dLabel')}
                    className='flex items-center rounded-xl border border-border bg-muted/40 p-0.5'
                  >
                    <Button
                      size='sm'
                      variant={view3d === 'perspective' ? 'default' : 'ghost'}
                      className='h-8 rounded-lg px-3'
                      onClick={() => setView3d('perspective')}
                      aria-pressed={view3d === 'perspective'}
                    >
                      <Box className='size-4' />
                      <span className='hidden sm:inline'>{t('admin.view3dPerspective')}</span>
                    </Button>
                    <Button
                      size='sm'
                      variant={view3d === 'top' ? 'default' : 'ghost'}
                      className='h-8 rounded-lg px-3'
                      onClick={() => setView3d('top')}
                      aria-pressed={view3d === 'top'}
                    >
                      <LayoutGrid className='size-4' />
                      <span className='hidden sm:inline'>{t('admin.view3dTop')}</span>
                    </Button>
                  </div>
                  {/* p21: floor size & shape editor */}
                  <Button variant='outline' onClick={() => openFloorDialog(selectedPlan)}>
                    <Frame className='size-4' />
                    {t('admin.floorSizeShape')}
                  </Button>
                  <Dialog open={floorEditOpen} onOpenChange={setFloorEditOpen}>
                    <DialogContent className='sm:max-w-md'>
                      <DialogHeader>
                        <DialogTitle>{t('admin.floorSizeShapeTitle', { name: selectedPlan.name })}</DialogTitle>
                        <DialogDescription>{t('admin.floorSizeShapeDesc')}</DialogDescription>
                      </DialogHeader>
                      <div className='grid gap-4'>
                        {/* Shape presets */}
                        <div className='grid grid-cols-3 gap-2'>
                          {FLOOR_SHAPES.map((shape) => (
                            <button
                              key={shape}
                              type='button'
                              onClick={() => setFloorShape(shape)}
                              aria-pressed={floorShape === shape}
                              className={cn(
                                'flex flex-col items-center gap-1.5 rounded-xl border-2 p-2.5 text-xs font-semibold transition active:scale-95',
                                floorShape === shape
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border bg-white text-stone-600 hover:border-primary/40',
                              )}
                            >
                              <FloorShapeTile
                                shape={shape}
                                className={floorShape === shape ? 'text-primary' : 'text-stone-400'}
                              />
                              {t(`floorShape.${shape}`)}
                            </button>
                          ))}
                        </div>
                        {/* Size controls */}
                        <div className='grid gap-4 rounded-xl border border-border bg-muted/30 p-3'>
                          <div className='grid gap-2'>
                            <div className='flex items-center justify-between text-sm font-medium'>
                              <Label htmlFor='floor-width'>{t('admin.floorWidth')}</Label>
                              <span className='tabular-nums text-muted-foreground'>{floorWidth}%</span>
                            </div>
                            <Slider
                              id='floor-width'
                              min={FLOOR_SIZE_MIN}
                              max={FLOOR_SIZE_MAX}
                              step={5}
                              value={[floorWidth]}
                              onValueChange={([w]) => setFloorWidth(w)}
                            />
                          </div>
                          <div className='grid gap-2'>
                            <div className='flex items-center justify-between text-sm font-medium'>
                              <Label htmlFor='floor-height'>{t('admin.floorHeight')}</Label>
                              <span className='tabular-nums text-muted-foreground'>{floorHeight}%</span>
                            </div>
                            <Slider
                              id='floor-height'
                              min={FLOOR_SIZE_MIN}
                              max={FLOOR_SIZE_MAX}
                              step={5}
                              value={[floorHeight]}
                              onValueChange={([h]) => setFloorHeight(h)}
                            />
                          </div>
                          {/* Live preview */}
                          <div className='flex h-24 items-center justify-center rounded-lg border border-dashed border-border bg-white p-2'>
                            <div
                              className='h-full border-2 border-[#D6D0C4] bg-[radial-gradient(circle,#ece7dc_1px,transparent_1px)] [background-size:14px_14px]'
                              style={{
                                width: `${Math.round(floorWidth * 0.9)}%`,
                                height: `${Math.round(floorHeight * 0.9)}%`,
                                clipPath: floorShapeClip(floorShape),
                              }}
                            />
                          </div>
                          <p className='text-[11px] leading-relaxed text-muted-foreground'>
                            {t('admin.floorShapeClampHint')}
                          </p>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant='outline' onClick={() => setFloorEditOpen(false)}>
                          {t('common.cancel')}
                        </Button>
                        <Button
                          onClick={() =>
                            saveFloorGeometryMutation.mutate({
                              plan: selectedPlan,
                              tables: activeTables,
                            })
                          }
                          disabled={saveFloorGeometryMutation.isPending}
                        >
                          {saveFloorGeometryMutation.isPending ? (
                            <Loader2 className='size-4 animate-spin' />
                          ) : (
                            <BadgeCheck className='size-4' />
                          )}
                          {t('admin.saveChanges')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
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

                {/* r56: custom space creation — the owner lays out lounges,
                    bars, stages, VIP corners… as 3D zones on the floor */}
                <Dialog open={addSpaceOpen} onOpenChange={setAddSpaceOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline">
                      <Shapes className="size-4" />
                      {t('admin.addSpace')}
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>{t('admin.addSpaceTitle')}</DialogTitle>
                      <DialogDescription>{t('admin.addSpaceDesc')}</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                      <div className="grid gap-1.5">
                        <Label htmlFor="space-name">{t('common.name')}</Label>
                        <Input
                          id="space-name"
                          value={addSpaceName}
                          placeholder={t('admin.spaceNamePlaceholder')}
                          onChange={(event) => setAddSpaceName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') handleAddSpace()
                          }}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor="space-kind">{t('admin.spaceKind')}</Label>
                        <Select value={addSpaceKind} onValueChange={setAddSpaceKind}>
                          <SelectTrigger id="space-kind" className="w-full">
                            <SelectValue placeholder={t('admin.spaceKind')} />
                          </SelectTrigger>
                          <SelectContent>
                            {FLOOR_SPACE_KINDS.map((kind) => (
                              <SelectItem key={kind} value={kind}>
                                {t(`spaceKind.${kind}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-4 rounded-xl border border-border bg-muted/30 p-3">
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between text-sm font-medium">
                            <Label htmlFor="space-width">{t('admin.spaceWidth')}</Label>
                            <span className="tabular-nums text-muted-foreground">{addSpaceWidth}%</span>
                          </div>
                          <Slider
                            id="space-width"
                            min={4}
                            max={60}
                            step={1}
                            value={[addSpaceWidth]}
                            onValueChange={([w]) => setAddSpaceWidth(w)}
                          />
                        </div>
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between text-sm font-medium">
                            <Label htmlFor="space-depth">{t('admin.spaceDepth')}</Label>
                            <span className="tabular-nums text-muted-foreground">{addSpaceDepth}%</span>
                          </div>
                          <Slider
                            id="space-depth"
                            min={4}
                            max={60}
                            step={1}
                            value={[addSpaceDepth]}
                            onValueChange={([d]) => setAddSpaceDepth(d)}
                          />
                        </div>
                        <div className="grid gap-2">
                          <div className="flex items-center justify-between text-sm font-medium">
                            <Label htmlFor="space-rotation">{t('admin.spaceRotation')}</Label>
                            <span className="tabular-nums text-muted-foreground">{addSpaceRotation}°</span>
                          </div>
                          <Slider
                            id="space-rotation"
                            min={-180}
                            max={180}
                            step={5}
                            value={[addSpaceRotation]}
                            onValueChange={([r]) => setAddSpaceRotation(r)}
                          />
                        </div>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setAddSpaceOpen(false)}>
                        {t('common.cancel')}
                      </Button>
                      <Button onClick={handleAddSpace} disabled={addingSpace || !addSpaceName.trim()}>
                        {addingSpace ? (
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
              </div>

              {/* r56: the floor itself — a 3D architectural maquette.
                  Size & silhouette stay p21-owned (widthUnits/heightUnits/
                  floorShape); tables + custom spaces render as 3D furniture
                  (SMALL chairs, per the owner directive). Drag furniture on
                  the floor to arrange; tap it to edit. Orbit with an empty
                  drag; the toolbar switches perspective/top presets. */}
              <div className='relative pb-4'>
                {/* Hall stats — floating over the scene (never clipped) */}
                <div className='pointer-events-none absolute -top-2 left-0 z-10 flex flex-wrap items-center gap-3 rounded-full border border-border bg-white px-3 py-1 text-[11px] font-medium text-stone-500 shadow-sm'>
                  <span>{t('admin.hallStatsTables', { n: activeTables.length })}</span>
                  <span className='text-emerald-700'>
                    {t('admin.hallStatsFree', { n: hallStats.free })}
                  </span>
                  <span className='text-amber-700'>
                    {t('admin.hallStatsOccupied', { n: hallStats.occupied })}
                  </span>
                  {activeSpaces.length > 0 && (
                    <span className='text-stone-400'>
                      · {t('admin.hallStatsSpaces', { n: activeSpaces.length })}
                    </span>
                  )}
                </div>

                <div className='h-[480px] overflow-hidden rounded-2xl border border-[#D6D0C4] shadow-inner sm:h-[560px]'>
                  <Floor3dScene
                    plan={selectedPlan}
                    mode='edit'
                    view={view3d}
                    onTableClick={openTableDialog}
                    onTableMove={(table, x, y) =>
                      updateTableMutation.mutate({
                        id: table.id,
                        body: { positionX: x, positionY: y },
                        successMessage: t('admin.positionSaved'),
                      })
                    }
                    onSpaceClick={openSpaceDialog}
                    onSpaceMove={(space, x, y) =>
                      updateSpaceMutation.mutate({
                        id: space.id,
                        body: { positionX: x, positionY: y },
                        successMessage: t('admin.positionSaved'),
                      })
                    }
                  />
                </div>

                {/* Empty-hall coaching — floats over the 3D scene when a plan
                    has no tables yet */}
                {activeTables.length === 0 && (
                  <div className='pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 text-center'>
                    <Armchair className='size-12 text-stone-400/70' />
                    <p className='rounded-full bg-white/90 px-3 py-1 text-sm font-medium text-stone-500 shadow-sm'>
                      {t('admin.addTablesEmpty')}
                    </p>
                  </div>
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
