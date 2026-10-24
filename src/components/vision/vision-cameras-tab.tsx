'use client'

// ─── Vision Cameras tab — camera CRUD + detection settings + edge ────
// Registering streams (rtsp/http) mapped to floor plans, live status
// per camera, admin-tunable detection thresholds/timings, and the edge
// ingest connection (endpoint + one-time-rotatable key).

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult } from '@tanstack/react-query'
import {
  Cctv,
  Copy,
  KeyRound,
  Loader2,
  MonitorPlay,
  Pencil,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { apiFetch } from '@/lib/api'
import { elapsedSince } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { FloorPlan, VisionCameraDTO, VisionConfigDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

import { VisionErrorCard, VisionSkeletonGrid } from './vision-shared'
import type { VisionIngestInfo } from './vision-view'
import { cameraStatusClass } from './vision-utils'

type SetupDemoMutation = UseMutationResult<
  { results: { event_id: string; outcome: string; detail: string | null }[] },
  Error,
  void
>

type Props = {
  cameras: VisionCameraDTO[]
  isLoading: boolean
  isError: boolean
  refetch: () => void
  config?: VisionConfigDTO
  ingest?: VisionIngestInfo
  configLoading: boolean
  configError: boolean
  configRefetch: () => void
  floorPlans: FloorPlan[]
  setupDemoMutation: SetupDemoMutation
}

const CONFIG_FIELDS = [
  { key: 'highConfidence', unit: '0–1' },
  { key: 'mediumConfidence', unit: '0–1' },
  { key: 'vacancyDelaySeconds', unit: 's' },
  { key: 'movementDedupeMinutes', unit: 'min' },
  { key: 'movementCooldownMinutes', unit: 'min' },
  { key: 'serviceDelayMinutes', unit: 'min' },
  { key: 'maxEventAgeSeconds', unit: 's' },
  { key: 'manualHoldMinutes', unit: 'min' },
] as const

type ConfigKey = (typeof CONFIG_FIELDS)[number]['key']
type ConfigForm = Record<ConfigKey, string>

export default function VisionCamerasTab({
  cameras,
  isLoading,
  isError,
  refetch,
  config,
  ingest,
  configLoading,
  configError,
  configRefetch,
  floorPlans,
  setupDemoMutation,
}: Props) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editingCamera, setEditingCamera] = useState<VisionCameraDTO | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<VisionCameraDTO | null>(null)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [revealedKey, setRevealedKey] = useState<string | null>(null)

  // camera form fields
  const [fCode, setFCode] = useState('')
  const [fName, setFName] = useState('')
  const [fUrl, setFUrl] = useState('')
  const [fFloor, setFFloor] = useState<string>('none')

  // detection-settings form (synced from the server config during render)
  const [configForm, setConfigForm] = useState<ConfigForm | null>(null)
  const [configSynced, setConfigSynced] = useState<string | null>(null)
  const configFingerprint = config ? JSON.stringify(config) : null
  if (config && configFingerprint !== configSynced) {
    setConfigSynced(configFingerprint)
    setConfigForm({
      highConfidence: String(config.highConfidence),
      mediumConfidence: String(config.mediumConfidence),
      vacancyDelaySeconds: String(config.vacancyDelaySeconds),
      movementDedupeMinutes: String(config.movementDedupeMinutes),
      movementCooldownMinutes: String(config.movementCooldownMinutes),
      serviceDelayMinutes: String(config.serviceDelayMinutes),
      maxEventAgeSeconds: String(config.maxEventAgeSeconds),
      manualHoldMinutes: String(config.manualHoldMinutes),
    })
  }

  const invalidateCameras = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['vision-cameras'] }),
      queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['vision-zones'] }),
    ])
  }

  const createCameraMutation = useMutation({
    mutationFn: (body: { code: string; name: string; streamUrl?: string; floorPlanId?: number }) =>
      apiFetch<{ camera: VisionCameraDTO }>('/api/vision/cameras', { body }),
    onSuccess: async () => {
      toast.success(t('vision.cameras.created'))
      setFormOpen(false)
      resetForm()
      await invalidateCameras()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const updateCameraMutation = useMutation({
    mutationFn: (vars: { id: number; body: Record<string, unknown> }) =>
      apiFetch<{ camera: VisionCameraDTO }>(`/api/vision/cameras/${vars.id}`, {
        method: 'PUT',
        body: vars.body,
      }),
    onSuccess: async () => {
      toast.success(t('vision.cameras.updated'))
      await invalidateCameras()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteCameraMutation = useMutation({
    mutationFn: (id: number) => apiFetch<{ ok: boolean }>(`/api/vision/cameras/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      toast.success(t('vision.cameras.deleted'))
      setDeleteTarget(null)
      await invalidateCameras()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const saveConfigMutation = useMutation({
    mutationFn: (body: Partial<VisionConfigDTO>) =>
      apiFetch<{ config: VisionConfigDTO }>('/api/vision/config', { method: 'PUT', body }),
    onSuccess: async () => {
      toast.success(t('vision.config.saved'))
      await queryClient.invalidateQueries({ queryKey: ['vision-config'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const rotateKeyMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ config: VisionConfigDTO; ingest: VisionIngestInfo }>('/api/vision/config', {
        method: 'PUT',
        body: { rotateIngestKey: true },
      }),
    onSuccess: (data) => {
      toast.success(t('vision.edge.rotated'))
      setRevealedKey(data.ingest.key)
      setRotateOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['vision-config'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const resetForm = () => {
    setFCode('')
    setFName('')
    setFUrl('')
    setFFloor('none')
    setEditingCamera(null)
  }

  const openAdd = () => {
    resetForm()
    setFormOpen(true)
  }

  const openEdit = (camera: VisionCameraDTO) => {
    setEditingCamera(camera)
    setFCode(camera.code)
    setFName(camera.name)
    setFUrl(camera.streamUrl ?? '')
    setFFloor(camera.floorPlanId != null ? String(camera.floorPlanId) : 'none')
    setFormOpen(true)
  }

  const submitCameraForm = () => {
    if (fCode.trim() === '' || fName.trim() === '') {
      toast.error(t('common.required'))
      return
    }
    const floorPlanId = fFloor === 'none' ? undefined : Number(fFloor)
    const streamUrl = fUrl.trim() === '' ? undefined : fUrl.trim()
    if (editingCamera) {
      // explicit nulls so a blank field actually CLEARS the link/URL
      // (undefined would be dropped from the JSON body = "unchanged").
      updateCameraMutation.mutate({
        id: editingCamera.id,
        body: {
          name: fName.trim(),
          streamUrl: streamUrl ?? null,
          floorPlanId: floorPlanId ?? null,
        },
      })
    } else {
      createCameraMutation.mutate({
        code: fCode.trim(),
        name: fName.trim(),
        streamUrl,
        floorPlanId,
      })
    }
  }

  const submitConfig = () => {
    if (!configForm) return
    const values: Partial<Record<ConfigKey, number>> = {}
    for (const field of CONFIG_FIELDS) {
      const raw = configForm[field.key].trim()
      const num = Number(raw)
      if (raw === '' || !Number.isFinite(num) || num < 0) {
        toast.error(t('vision.config.numberInvalid'))
        return
      }
      values[field.key] = num
    }
    if ((values.mediumConfidence as number) >= (values.highConfidence as number)) {
      toast.error(t('vision.config.invalid'))
      return
    }
    saveConfigMutation.mutate(values as Partial<VisionConfigDTO>)
  }

  const copyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key)
      toast.success(t('vision.edge.copied'))
    } catch {
      toast.error(t('error.generic'))
    }
  }

  if (isLoading) {
    return <VisionSkeletonGrid count={6} />
  }
  if (isError) {
    return <VisionErrorCard onRetry={refetch} />
  }

  return (
    <section className="space-y-4">
      {/* ── header row ── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('vision.cameras.subtitle')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" className="h-11 gap-1.5" disabled={setupDemoMutation.isPending} onClick={() => setupDemoMutation.mutate()}>
            {setupDemoMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Sparkles className="size-4" aria-hidden />
            )}
            {t('vision.setupDemo')}
          </Button>
          <Button className="h-11 gap-1.5" onClick={openAdd}>
            <Plus className="size-4" aria-hidden />
            {t('vision.cameras.add')}
          </Button>
        </div>
      </div>

      {/* ── camera cards ── */}
      {cameras.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <Cctv className="size-8 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">{t('vision.cameras.empty')}</p>
            <p className="max-w-md text-sm text-muted-foreground">{t('vision.cameras.emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cameras.map((camera) => (
            <Card key={camera.id} className="gap-3">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                        {camera.code}
                      </Badge>
                      <Badge variant="outline" className={cameraStatusClass(camera.status)}>
                        {t(`vision.cameras.status.${camera.status}`)}
                      </Badge>
                    </div>
                    <p className="truncate font-semibold">{camera.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {camera.floorPlanName ?? t('vision.cameras.floorPlanNone')} ·{' '}
                      {t('vision.cameras.zoneCount', { n: camera.zoneCount })}
                    </p>
                  </div>
                  <Switch
                    checked={camera.active}
                    aria-label={`${t('common.active')} — ${camera.name}`}
                    onCheckedChange={(checked) =>
                      updateCameraMutation.mutate({ id: camera.id, body: { active: checked } })
                    }
                  />
                </div>
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p>
                    <span className="font-medium">{t('vision.cameras.lastSeen')}: </span>
                    <span className="tabular-nums">
                      {camera.lastSeenAt ? elapsedSince(camera.lastSeenAt) : t('vision.cameras.never')}
                    </span>
                  </p>
                  {camera.lastError && (
                    <p className="truncate text-rose-600" title={camera.lastError}>
                      <span className="font-medium">{t('vision.cameras.lastError')}: </span>
                      {camera.lastError}
                    </p>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 gap-1.5"
                    onClick={() => openEdit(camera)}
                  >
                    <Pencil className="size-4" aria-hidden />
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                    onClick={() => setDeleteTarget(camera)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    {t('common.delete')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ── detection settings + edge connection ── */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SlidersHorizontal className="size-4" aria-hidden />
              {t('vision.config.title')}
            </CardTitle>
            <CardDescription>{t('vision.config.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {configLoading ? (
              <div className="space-y-3">
                {CONFIG_FIELDS.map((f) => (
                  <Skeleton key={f.key} className="h-11 w-full" />
                ))}
              </div>
            ) : configError || !config || !configForm ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <p className="text-sm text-muted-foreground">{t('vision.loadFailed')}</p>
                <Button variant="outline" size="sm" onClick={configRefetch}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {CONFIG_FIELDS.map((field) => (
                    <div key={field.key} className="space-y-1">
                      <Label htmlFor={`cfg-${field.key}`} className="text-xs">
                        {t(`vision.config.${field.key}`)}
                      </Label>
                      <Input
                        id={`cfg-${field.key}`}
                        type="number"
                        inputMode="decimal"
                        step="any"
                        min={0}
                        className="h-11"
                        value={configForm[field.key]}
                        onChange={(e) =>
                          setConfigForm((prev) =>
                            prev ? { ...prev, [field.key]: e.target.value } : prev,
                          )
                        }
                      />
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {t(`vision.config.${field.key}Hint`)}
                      </p>
                    </div>
                  ))}
                </div>
                <Button
                  className="h-11 w-full sm:w-auto sm:px-6"
                  disabled={saveConfigMutation.isPending}
                  onClick={submitConfig}
                >
                  {saveConfigMutation.isPending && (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  )}
                  {t('common.save')}
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Edge connection */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" aria-hidden />
              {t('vision.edge.title')}
            </CardTitle>
            <CardDescription>{t('vision.edge.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {configLoading ? (
              <Skeleton className="h-28 w-full" />
            ) : configError || !ingest ? (
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <p className="text-sm text-muted-foreground">{t('vision.loadFailed')}</p>
                <Button variant="outline" size="sm" onClick={configRefetch}>
                  {t('common.retry')}
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">{t('vision.edge.endpoint')}</span>
                    <code className="rounded border bg-stone-100 px-2 py-0.5 font-mono text-[11px]">
                      {ingest.endpoint}
                    </code>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-muted-foreground">{t('vision.edge.key')}</span>
                    <code className="max-w-[60%] truncate rounded border bg-stone-100 px-2 py-0.5 font-mono text-[11px]">
                      {ingest.key}
                    </code>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t('vision.edge.keyMasked')}</p>
                </div>

                <Button
                  variant="outline"
                  className="h-11 gap-1.5"
                  disabled={rotateKeyMutation.isPending}
                  onClick={() => setRotateOpen(true)}
                >
                  <RotateCcw className="size-4" aria-hidden />
                  {t('vision.edge.rotate')}
                </Button>

                {revealedKey && (
                  <div className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <code className="min-w-0 flex-1 break-all font-mono text-xs font-bold text-amber-900">
                        {revealedKey}
                      </code>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-11 shrink-0 gap-1.5"
                        onClick={() => void copyKey(revealedKey)}
                      >
                        <Copy className="size-4" aria-hidden />
                        {t('vision.edge.copyKey')}
                      </Button>
                    </div>
                    <p className="flex items-start gap-1.5 text-[11px] font-semibold text-amber-800">
                      <MonitorPlay className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {t('vision.edge.storeSafe')}
                    </p>
                  </div>
                )}
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t('vision.edge.authNote')}
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── add / edit camera dialog ── */}
      <Dialog open={formOpen} onOpenChange={(o) => { if (!o) { setFormOpen(false); resetForm() } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCamera ? t('vision.cameras.edit') : t('vision.cameras.add')}</DialogTitle>
            <DialogDescription>
              {editingCamera ? t('vision.cameras.editDesc') : t('vision.cameras.codeHint')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cam-code">{t('vision.cameras.code')}</Label>
              <Input
                id="cam-code"
                className="h-11 font-mono uppercase"
                placeholder={t('vision.cameras.codePlaceholder')}
                value={fCode}
                disabled={editingCamera != null}
                onChange={(e) => setFCode(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-name">{t('common.name')}</Label>
              <Input
                id="cam-name"
                className="h-11"
                value={fName}
                onChange={(e) => setFName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-url">{t('vision.cameras.streamUrl')}</Label>
              <Input
                id="cam-url"
                className="h-11"
                placeholder="rtsp://…"
                value={fUrl}
                onChange={(e) => setFUrl(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">{t('vision.cameras.streamUrlHint')}</p>
              <p className="text-[11px] font-medium text-amber-700">
                {t('vision.cameras.noCredentials')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cam-floor">{t('vision.cameras.floorPlan')}</Label>
              <Select value={fFloor} onValueChange={setFFloor}>
                <SelectTrigger id="cam-floor" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('vision.cameras.floorPlanNone')}</SelectItem>
                  {floorPlans.map((fp) => (
                    <SelectItem key={fp.id} value={String(fp.id)}>
                      {fp.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              disabled={createCameraMutation.isPending || updateCameraMutation.isPending}
              onClick={() => { setFormOpen(false); resetForm() }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={createCameraMutation.isPending || updateCameraMutation.isPending}
              onClick={submitCameraForm}
            >
              {(createCameraMutation.isPending || updateCameraMutation.isPending) && (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              )}
              {editingCamera ? t('common.update') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── delete confirm ── */}
      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(o) => { if (!o && !deleteCameraMutation.isPending) setDeleteTarget(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('vision.cameras.deleteTitle', { code: deleteTarget?.code ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-1">
                <p>{t('vision.cameras.deleteDesc')}</p>
                <p className="font-medium text-amber-700">{t('vision.cameras.deleteBlocked')}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteCameraMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className={cn('bg-rose-600 text-white hover:bg-rose-700')}
              disabled={deleteCameraMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget) deleteCameraMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteCameraMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── rotate key confirm ── */}
      <AlertDialog open={rotateOpen} onOpenChange={(o) => !rotateKeyMutation.isPending && setRotateOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vision.edge.rotateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('vision.edge.rotateDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotateKeyMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={rotateKeyMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                rotateKeyMutation.mutate()
              }}
            >
              {rotateKeyMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('vision.edge.rotate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
