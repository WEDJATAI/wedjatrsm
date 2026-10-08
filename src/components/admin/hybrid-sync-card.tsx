'use client'

// ─── R30: Hybrid Sync Center card (Settings) ────────────────────────
// The EVENT-BASED device-to-cloud layer (rsm-hybrid/1) — a sibling of
// the legacy bundle SyncCard above it, NOT a replacement: that card
// moves whole-table bundles one way; this card mirrors every business
// write through a durable outbox to registered devices + the cloud.
// Offline-first posture: LOCAL MODE is always presented CALMLY — the
// restaurant keeps operating; queues drain when a link returns.
// All strings via t() (r30 dict); RTL-safe (logical spacing, dir="ltr"
// on ids/keys/filenames).

import { useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  UseMutationResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArchiveRestore,
  Check,
  ChevronDown,
  CloudCheck,
  CloudCog,
  CloudOff,
  CloudUpload,
  Copy,
  DatabaseBackup,
  KeyRound,
  Laptop,
  Loader2,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scale,
  TriangleAlert,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type {
  BackupInfo,
  HybridDeviceDTO,
  HybridErrorEvent,
  HybridReconcileReport,
  HybridStatusDTO,
  HybridSyncNowResult,
} from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// ── navigator.onLine as a React store (online/offline events) ───────

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine
}

function getOnlineServerSnapshot(): boolean {
  return true
}

// ── small presentational pieces ─────────────────────────────────────

type DotTone = 'emerald' | 'amber' | 'rose' | 'slate'

const DOT_TONES: Record<DotTone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  slate: 'bg-muted-foreground/50',
}

/** Colored state dot (decorative — the adjacent text carries the state). */
function StateDot({ tone }: { tone: DotTone }) {
  return <span className={cn('size-2 shrink-0 rounded-full', DOT_TONES[tone])} aria-hidden />
}

/** One status tile: muted label + value row (dot + text / count). */
function StatusTile({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-lg border bg-muted/30 p-3', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 min-h-6 text-sm font-medium">{children}</div>
    </div>
  )
}

/** Value row: dot + state/count text. */
function TileValue({
  tone,
  children,
  title,
}: {
  tone: DotTone
  children: ReactNode
  title?: string
}) {
  return (
    <p className="flex items-center gap-1.5" title={title}>
      <StateDot tone={tone} />
      <span className="min-w-0 truncate">{children}</span>
    </p>
  )
}

/** Mask a full deviceId to its first 8 chars + ellipsis (list endpoint
 *  returns the whole id; the status snapshot arrives pre-masked). */
function maskDeviceId(deviceId: string): string {
  return `${deviceId.slice(0, 8)}…`
}

/** Mutation result types shared with the device-management section. */
type DeviceActionMutation = UseMutationResult<
  { device: HybridDeviceDTO },
  Error,
  { deviceId: string; action: string; name?: string }
>
type RotateKeyMutation = UseMutationResult<
  { device: HybridDeviceDTO; deviceKey: string },
  Error,
  string
>

// ─── Card ───────────────────────────────────────────────────────────

export function HybridSyncCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // ── live status (poll + refetch on window focus; POS pill shares key) ──
  const statusQuery = useQuery({
    queryKey: ['hybrid', 'status'],
    queryFn: () => fetcher<HybridStatusDTO>('/api/hybrid/status'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 20_000,
    retry: false,
  })
  const status = statusQuery.data ?? null

  const refreshStatus = () =>
    void queryClient.invalidateQueries({ queryKey: ['hybrid', 'status'] })

  // ── connectivity (navigator.onLine as an external store) ──
  const online = useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineServerSnapshot)

  // ── backups (shares the ['backups'] cache with the backups card above) ──
  const backupsQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => fetcher<{ backups: BackupInfo[] }>('/api/admin/backup'),
    staleTime: 30_000,
    retry: false,
  })
  const latestBackup = backupsQuery.data?.backups[0] ?? null

  // ── dialog state ──
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [includeDead, setIncludeDead] = useState(false)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)
  const [devicesOpen, setDevicesOpen] = useState(false)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [revealedKey, setRevealedKey] = useState<{ deviceId: string; deviceKey: string } | null>(
    null,
  )

  // ── Sync now (one push + one pull cycle; 409 → calm info toast) ──
  const syncNowMutation = useMutation({
    mutationFn: () => apiFetch<HybridSyncNowResult>('/api/hybrid/sync-now'),
    onSuccess: (data) => {
      toast.success(
        t('hybrid.syncDone', {
          pushed: data.push.pushed,
          acked: data.push.acked,
          applied: data.pull.applied,
        }),
      )
      refreshStatus()
      // r37: a pull cycle APPLIES remote writes locally — refresh all cached
      // data so admin views never act on stale rows after a manual sync.
      void queryClient.invalidateQueries()
    },
    onError: (err: Error) => {
      if (err.message.toLowerCase().includes('already running')) {
        toast.info(t('hybrid.syncBusy'))
      } else {
        toast.error(err.message)
      }
    },
  })

  // ── pause / resume the background engine ──
  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) =>
      apiFetch<{ paused: boolean }>('/api/hybrid/pause', { body: { paused } }),
    onSuccess: (data) => {
      toast.success(data.paused ? t('hybrid.pausedToast') : t('hybrid.resumedToast'))
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── retry failed (optionally dead-lettered) outbox events ──
  const retryMutation = useMutation({
    mutationFn: (withDead: boolean) =>
      apiFetch<{ reset: number }>('/api/hybrid/retry-failed', {
        body: { includeDead: withDead },
      }),
    onSuccess: (data) => {
      toast.success(t('hybrid.retried', { n: data.reset }))
      refreshStatus()
      void queryClient.invalidateQueries({ queryKey: ['hybrid', 'errors'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── reconciliation (drift report → toast + detail dialog) ──
  const [reconcileReport, setReconcileReport] = useState<HybridReconcileReport | null>(null)
  const reconcileMutation = useMutation({
    mutationFn: () => apiFetch<HybridReconcileReport>('/api/hybrid/reconcile', { body: {} }),
    onSuccess: (report) => {
      const drifted = report.entities.filter((e) => (e.drift ?? 0) !== 0).length
      toast.success(t('hybrid.reconcileDone', { n: drifted }))
      setReconcileReport(report)
      refreshStatus()
      // r37: reconciliation repairs drifted rows — refresh all cached data so
      // admin views never act on stale rows after a repair.
      void queryClient.invalidateQueries()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── create a manual backup snapshot ──
  const backupMutation = useMutation({
    mutationFn: () => apiFetch<{ backup: BackupInfo }>('/api/admin/backup', { body: {} }),
    onSuccess: (data) => {
      toast.success(t('admin.backupDone', { name: data.backup.name }))
      void queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── staged restore (applied at next boot — see confirm dialog) ──
  const restoreMutation = useMutation({
    mutationFn: (filename: string) =>
      apiFetch<{ staged: boolean }>('/api/admin/backup/restore', { body: { filename } }),
    onSuccess: () => {
      toast.success(t('hybrid.restoreStaged'))
      setPendingRestore(null)
      setRestoreOpen(false)
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── register a new device (key shown EXACTLY once) ──
  const registerMutation = useMutation({
    mutationFn: (vars: { name: string; platform: string }) =>
      apiFetch<{ deviceId: string; deviceKey: string }>('/api/hybrid/device', { body: vars }),
    onSuccess: (data) => {
      toast.success(t('hybrid.deviceRegistered'))
      setRegisterOpen(false)
      setRevealedKey({ deviceId: data.deviceId, deviceKey: data.deviceKey })
      void queryClient.invalidateQueries({ queryKey: ['hybrid', 'devices'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── per-device actions (pause/resume/rename/revoke) ──
  const deviceActionMutation = useMutation({
    mutationFn: (vars: { deviceId: string; action: string; name?: string }) =>
      apiFetch<{ device: HybridDeviceDTO }>('/api/hybrid/device', {
        method: 'PATCH',
        body: vars,
      }),
    onSuccess: () => {
      toast.success(t('hybrid.deviceDone'))
      void queryClient.invalidateQueries({ queryKey: ['hybrid', 'devices'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── rotate a device key (new key shown EXACTLY once) ──
  const rotateMutation = useMutation({
    mutationFn: (deviceId: string) =>
      apiFetch<{ device: HybridDeviceDTO; deviceKey: string }>('/api/hybrid/device', {
        method: 'PATCH',
        body: { deviceId, action: 'rotate' },
      }),
    onSuccess: (data) => {
      toast.success(t('hybrid.keyRotated'))
      setRevealedKey({ deviceId: data.device.deviceId, deviceKey: data.deviceKey })
      void queryClient.invalidateQueries({ queryKey: ['hybrid', 'devices'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── derived tile states (merged client + server, honest) ──
  const counts = status?.counts
  const failedTotal =
    counts ? counts.failedOut + counts.deadOut + counts.failedIn : 0
  const hasQueuedEvents =
    !!counts &&
    (counts.pendingUploads + counts.failedOut + counts.deadOut + counts.failedIn + counts.pendingDownloads) > 0
  // internet: show the WORSE of client navigator.onLine and the server verdict
  const internetOk = online && status?.internet !== 'offline'

  return (
    <Card id="hybrid-sync-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CloudCog className="size-5 text-primary" aria-hidden />
          {t('hybrid.title')}
        </CardTitle>
        <CardDescription>{t('hybrid.subtitle')}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {statusQuery.isLoading ? (
          <>
            {/* calm banner + tiles skeletons */}
            <Skeleton className="h-10 w-full" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          </>
        ) : statusQuery.isError || !status ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {statusQuery.error?.message ?? t('error.generic')}
            </p>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void statusQuery.refetch()}
            >
              <RefreshCw className="size-4" aria-hidden />
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <>
            {/* ── calm mode banner (LOCAL MODE is never alarming) ── */}
            {(() => {
              const cloudConnected =
                online && !!status.targetUrl && status.cloud.reachable === 'yes'
              const pending = status.counts.pendingUploads
              if (pending > 0) {
                return (
                  <p
                    role="status"
                    className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300"
                  >
                    <CloudUpload className="size-4 shrink-0" aria-hidden />
                    {t('hybrid.mode.waiting', { n: pending })}
                  </p>
                )
              }
              if (cloudConnected) {
                return (
                  <p
                    role="status"
                    className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                  >
                    <CloudCheck className="size-4 shrink-0" aria-hidden />
                    {t('hybrid.mode.cloud')}
                  </p>
                )
              }
              return (
                <p
                  role="status"
                  className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
                >
                  <CloudOff className="size-4 shrink-0" aria-hidden />
                  {t('hybrid.mode.local')}
                </p>
              )
            })()}

            {/* staged-restore notice (next boot applies it) */}
            {status.restorePending ? (
              <p className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                <ArchiveRestore className="size-4 shrink-0" aria-hidden />
                {t('hybrid.restoreStaged')}
              </p>
            ) : null}

            {/* ── status tiles — 2 cols mobile, 4 desktop ── */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {/* LOCAL SYSTEM */}
              <StatusTile label={t('hybrid.localSystem')}>
                {!status.local.dbOk ? (
                  <TileValue tone="rose">{t('hybrid.error')}</TileValue>
                ) : status.engine === 'running' ? (
                  <TileValue tone="emerald">{t('hybrid.healthy')}</TileValue>
                ) : hasQueuedEvents ? (
                  <TileValue tone="amber">{t('hybrid.warning')}</TileValue>
                ) : (
                  <TileValue tone="slate">{t('hybrid.stopped')}</TileValue>
                )}
              </StatusTile>

              {/* LOCAL DATABASE */}
              <StatusTile label={t('hybrid.localDatabase')}>
                <TileValue
                  tone={status.local.dbOk ? 'emerald' : 'rose'}
                >
                  {status.local.dbOk ? t('hybrid.healthy') : t('hybrid.error')}
                </TileValue>
              </StatusTile>

              {/* INTERNET — client + server merged, worse wins */}
              <StatusTile label={t('hybrid.internet')}>
                <TileValue
                  tone={internetOk ? 'emerald' : 'slate'}
                  title={t('hybrid.internet')}
                >
                  {internetOk ? t('hybrid.connected') : t('hybrid.offline')}
                </TileValue>
              </StatusTile>

              {/* CLOUD */}
              <StatusTile label={t('hybrid.cloud')}>
                {status.cloud.reachable === 'yes' && status.targetUrl ? (
                  <TileValue tone="emerald" title={status.targetUrl}>
                    {t('hybrid.connected')}
                  </TileValue>
                ) : !status.targetUrl ? (
                  <TileValue tone="slate">{t('hybrid.notConfigured')}</TileValue>
                ) : (
                  <TileValue tone="amber">
                    {t('hybrid.unavailable')}
                  </TileValue>
                )}
                {status.cloud.authFailed ? (
                  <p className="mt-1 text-[11px] leading-tight text-amber-700 dark:text-amber-400">
                    {t('hybrid.authFailedHint')}
                  </p>
                ) : null}
              </StatusTile>

              {/* LAST PUSH */}
              <StatusTile label={t('hybrid.lastPush')}>
                <RelTimeValue iso={status.lastPushAt} neverLabel={t('hybrid.never')} />
              </StatusTile>

              {/* LAST PULL */}
              <StatusTile label={t('hybrid.lastPull')}>
                <RelTimeValue iso={status.lastPullAt} neverLabel={t('hybrid.never')} />
              </StatusTile>

              {/* LAST RECONCILIATION */}
              <StatusTile label={t('hybrid.lastReconcile')}>
                <RelTimeValue iso={status.lastReconcileAt} neverLabel={t('hybrid.never')} />
              </StatusTile>

              {/* PENDING UPLOADS */}
              <StatusTile label={t('hybrid.pendingUploads')}>
                <TileValue tone={status.counts.pendingUploads > 0 ? 'amber' : 'emerald'}>
                  <span className="tabular-nums">{status.counts.pendingUploads}</span>
                </TileValue>
              </StatusTile>

              {/* PENDING DOWNLOADS */}
              <StatusTile label={t('hybrid.pendingDownloads')}>
                <TileValue tone={status.counts.pendingDownloads > 0 ? 'amber' : 'emerald'}>
                  <span className="tabular-nums">{status.counts.pendingDownloads}</span>
                </TileValue>
              </StatusTile>

              {/* FAILED EVENTS — click opens the errors dialog */}
              <StatusTile label={t('hybrid.failedEvents')}>
                {failedTotal > 0 ? (
                  <button
                    type="button"
                    onClick={() => setErrorsOpen(true)}
                    className="-ms-1 inline-flex items-center gap-1.5 rounded-full px-1 text-rose-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:text-rose-400"
                    aria-label={`${t('hybrid.failedEvents')}: ${failedTotal} — ${t('hybrid.viewErrors')}`}
                  >
                    <StateDot tone="rose" />
                    <span className="tabular-nums">{failedTotal}</span>
                  </button>
                ) : (
                  <TileValue tone="emerald">
                    <span className="tabular-nums">0</span>
                  </TileValue>
                )}
              </StatusTile>

              {/* DEVICE — masked id + name */}
              <StatusTile label={t('hybrid.device')}>
                {status.device ? (
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs" dir="ltr" title={status.device.name}>
                      {status.device.deviceId}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {status.device.name}
                    </p>
                  </div>
                ) : (
                  <TileValue tone="slate">—</TileValue>
                )}
              </StatusTile>

              {/* SYNC — enabled / paused */}
              <StatusTile label={t('hybrid.sync')}>
                <Badge
                  className={
                    status.paused
                      ? 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100'
                      : 'border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100'
                  }
                >
                  {status.paused ? t('hybrid.paused') : t('hybrid.enabled')}
                </Badge>
              </StatusTile>

              {/* BACKUP — last successful local snapshot */}
              <StatusTile label={t('hybrid.backup')}>
                {backupsQuery.isLoading ? (
                  <Skeleton className="h-4 w-16" />
                ) : latestBackup ? (
                  <p className="truncate" title={formatDateTime(latestBackup.createdAt)}>
                    <RelTimeValue iso={latestBackup.createdAt} neverLabel={t('hybrid.never')} />
                  </p>
                ) : (
                  <TileValue tone="slate">{t('hybrid.never')}</TileValue>
                )}
              </StatusTile>
            </div>

            {/* cloud target hint — honest, actionable, never scary */}
            {!status.targetUrl ? (
              <p className="text-xs text-muted-foreground">{t('hybrid.noTargetHint')}</p>
            ) : null}

            <Separator />

            {/* ── admin controls ── */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={syncNowMutation.isPending}
                onClick={() => syncNowMutation.mutate()}
              >
                {syncNowMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                {syncNowMutation.isPending ? t('hybrid.syncing') : t('hybrid.syncNow')}
              </Button>

              <Button
                variant="outline"
                className="h-11"
                disabled={pauseMutation.isPending}
                onClick={() => pauseMutation.mutate(!status.paused)}
              >
                {pauseMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : status.paused ? (
                  <Play className="size-4" />
                ) : (
                  <Pause className="size-4" />
                )}
                {status.paused ? t('hybrid.resumeSync') : t('hybrid.pauseSync')}
              </Button>

              {failedTotal > 0 ? (
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={retryMutation.isPending}
                  onClick={() => retryMutation.mutate(false)}
                >
                  {retryMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <RotateCcw className="size-4" />
                  )}
                  {t('hybrid.retryFailed')}
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* span keeps the disabled button hoverable for the tooltip */}
                    <span className="inline-flex" tabIndex={0}>
                      <Button variant="outline" className="h-11" disabled aria-disabled>
                        <RotateCcw className="size-4" />
                        {t('hybrid.retryFailed')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('hybrid.retryNone')}</TooltipContent>
                </Tooltip>
              )}

              <Button
                variant="outline"
                className="h-11"
                onClick={() => setErrorsOpen(true)}
              >
                <TriangleAlert className="size-4" />
                {t('hybrid.viewErrors')}
              </Button>

              <Button
                variant="outline"
                className="h-11"
                disabled={reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate()}
              >
                {reconcileMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Scale className="size-4" />
                )}
                {t('hybrid.runReconciliation')}
              </Button>

              <Button
                variant="outline"
                className="h-11"
                disabled={backupMutation.isPending}
                onClick={() => backupMutation.mutate()}
              >
                {backupMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <DatabaseBackup className="size-4" />
                )}
                {backupMutation.isPending
                  ? t('admin.backupBackingUp')
                  : t('hybrid.createBackup')}
              </Button>

              <Button
                variant="outline"
                className="h-11"
                onClick={() => setRestoreOpen(true)}
              >
                <ArchiveRestore className="size-4" />
                {t('hybrid.restoreBackup')}
              </Button>
            </div>

            <Separator />

            {/* ── device management (collapsible) ── */}
            <DeviceManagementSection
              open={devicesOpen}
              onOpenChange={setDevicesOpen}
              onRegister={() => setRegisterOpen(true)}
              deviceActionMutation={deviceActionMutation}
              rotateMutation={rotateMutation}
            />
          </>
        )}

        {/* ── sync errors dialog ── */}
        <Dialog open={errorsOpen} onOpenChange={setErrorsOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('hybrid.errorsTitle')}</DialogTitle>
              <DialogDescription>{t('hybrid.subtitle')}</DialogDescription>
            </DialogHeader>
            <ErrorsList open={errorsOpen} />
            <DialogFooter className="gap-2 sm:gap-0">
              <label className="flex min-h-11 flex-1 items-center gap-2 text-sm">
                <Checkbox
                  checked={includeDead}
                  onCheckedChange={(checked) => setIncludeDead(checked === true)}
                  aria-label={t('hybrid.includeDead')}
                />
                {t('hybrid.includeDead')}
              </label>
              <Button
                className="h-11 shrink-0"
                disabled={retryMutation.isPending || failedTotal === 0}
                onClick={() => retryMutation.mutate(includeDead)}
              >
                {retryMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCcw className="size-4" />
                )}
                {t('hybrid.retryFailed')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── reconciliation report dialog ── */}
        <Dialog
          open={reconcileReport !== null}
          onOpenChange={(open) => {
            if (!open) setReconcileReport(null)
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('hybrid.driftTitle')}</DialogTitle>
              <DialogDescription>
                {reconcileReport
                  ? reconcileReport.cloudReachable
                    ? t('hybrid.driftConflicts', { n: reconcileReport.conflictsTotal })
                    : t('hybrid.cloudUnreachable')
                  : ''}
              </DialogDescription>
            </DialogHeader>
            {reconcileReport ? (
              <div className="max-h-96 overflow-y-auto rms-scroll rounded-md border">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>{t('hybrid.entity')}</TableHead>
                      <TableHead className="text-end">{t('hybrid.driftLocal')}</TableHead>
                      <TableHead className="text-end">{t('hybrid.driftCloud')}</TableHead>
                      <TableHead className="text-end">{t('hybrid.drift')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reconcileReport.entities.map((row) => (
                      <TableRow key={row.entity}>
                        <TableCell className="font-medium">{row.entity}</TableCell>
                        <TableCell className="text-end tabular-nums">{row.localCount}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.cloudCount ?? '—'}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">
                          {row.drift === null ? (
                            '—'
                          ) : row.drift === 0 ? (
                            0
                          ) : (
                            <Badge
                              className={
                                row.drift < 0
                                  ? 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100'
                                  : 'border-rose-300 bg-rose-100 text-rose-800 hover:bg-rose-100'
                              }
                            >
                              {row.drift > 0 ? `+${row.drift}` : row.drift}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        {/* ── restore backup dialog (list + staged-restore confirm) ── */}
        <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('hybrid.restoreBackup')}</DialogTitle>
              <DialogDescription>{t('admin.backupSubtitle')}</DialogDescription>
            </DialogHeader>
            {backupsQuery.isLoading ? (
              <div className="grid gap-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : backupsQuery.isError ? (
              <p className="text-sm text-destructive">
                {backupsQuery.error?.message ?? t('common.error')}
              </p>
            ) : (backupsQuery.data?.backups.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">{t('admin.backupEmpty')}</p>
            ) : (
              <ul className="max-h-96 overflow-y-auto rms-scroll grid gap-1.5 p-1 text-sm">
                {backupsQuery.data?.backups.map((backup) => (
                  <li
                    key={backup.name}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs" dir="ltr" title={backup.name}>
                        {backup.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(backup.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="h-11 shrink-0"
                      onClick={() => setPendingRestore(backup.name)}
                    >
                      <ArchiveRestore className="size-4" />
                      {t('hybrid.restoreAction')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </DialogContent>
        </Dialog>

        {/* staged-restore confirm (nested AlertDialog) */}
        <AlertDialog
          open={pendingRestore !== null}
          onOpenChange={(open) => {
            if (!open && !restoreMutation.isPending) setPendingRestore(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('hybrid.confirmRestoreTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('hybrid.confirmRestoreBody')}
              </AlertDialogDescription>
              {pendingRestore ? (
                <p
                  className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground"
                  dir="ltr"
                >
                  {pendingRestore}
                </p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11" disabled={restoreMutation.isPending}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                className="h-11"
                disabled={restoreMutation.isPending}
                onClick={(e) => {
                  e.preventDefault() // keep the dialog open until the mutation settles
                  if (pendingRestore) restoreMutation.mutate(pendingRestore)
                }}
              >
                {restoreMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArchiveRestore className="size-4" />
                )}
                {t('hybrid.restoreAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* ── register device dialog ── */}
        <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('hybrid.registerDevice')}</DialogTitle>
              <DialogDescription>{t('hybrid.deviceSectionSub')}</DialogDescription>
            </DialogHeader>
            <RegisterDeviceForm
              pending={registerMutation.isPending}
              onSubmit={(name, platform) => registerMutation.mutate({ name, platform })}
            />
          </DialogContent>
        </Dialog>

        {/* ── device key reveal (shown EXACTLY once) ── */}
        <Dialog
          open={revealedKey !== null}
          onOpenChange={(open) => {
            if (!open) setRevealedKey(null)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <KeyRound className="size-5 text-amber-600" aria-hidden />
                {t('hybrid.deviceKeyLabel')}
              </DialogTitle>
              <DialogDescription>{t('hybrid.showOnce')}</DialogDescription>
            </DialogHeader>
            {revealedKey ? <DeviceKeyReveal {...revealedKey} /> : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}

/** Failed/dead event list (fetched only while the errors dialog is open). */
function ErrorsList({ open }: { open: boolean }) {
  const { t } = useI18n()
  const errorsQuery = useQuery({
    queryKey: ['hybrid', 'errors'],
    queryFn: () => fetcher<{ events: HybridErrorEvent[] }>('/api/hybrid/errors'),
    enabled: open,
    retry: false,
  })

  if (errorsQuery.isLoading) {
    return (
      <div className="grid gap-2 p-1">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    )
  }
  if (errorsQuery.isError) {
    return (
      <p className="p-1 text-sm text-destructive">
        {errorsQuery.error?.message ?? t('common.error')}
      </p>
    )
  }
  const events = errorsQuery.data?.events ?? []
  if (events.length === 0) {
    return <p className="p-1 text-sm text-muted-foreground">{t('hybrid.errorsEmpty')}</p>
  }
  return (
    <ul className="max-h-96 overflow-y-auto rms-scroll grid gap-1.5 p-1 text-sm">
      {events.map((event) => (
        <li key={event.eventId} className="rounded-md border px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">
              {event.entity} <span className="text-muted-foreground">#{event.entityId}</span>
            </span>
            <Badge variant="secondary" className="text-xs">
              {event.operation}
            </Badge>
            <Badge variant="outline" className="text-xs font-normal">
              {event.direction === 'out'
                ? t('hybrid.directionOut')
                : t('hybrid.directionIn')}
            </Badge>
            <Badge
              className={
                event.status === 'dead'
                  ? 'border-rose-300 bg-rose-100 text-rose-800 hover:bg-rose-100'
                  : 'border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100'
              }
            >
              {event.status === 'dead' ? t('hybrid.statusDead') : t('hybrid.statusFailed')}
            </Badge>
            <span className="ms-auto text-xs tabular-nums text-muted-foreground">
              {t('hybrid.attempts')}: {event.attempts}
            </span>
          </div>
          {event.lastError ? (
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={event.lastError}
              dir="ltr"
            >
              {event.lastError}
            </p>
          ) : null}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            <RelTime iso={event.updatedAt} />
          </p>
        </li>
      ))}
    </ul>
  )
}

// ─── Relative-time helpers ──────────────────────────────────────────

/** "3m ago" / "2h ago" style stamp via the r30 dict (Latin digits). */
function RelTime({ iso }: { iso: string }) {
  const { t } = useI18n()
  return <>{relTimeString(iso, t)}</>
}

function relTimeString(
  iso: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('hybrid.justNow')
  if (min < 60) return t('hybrid.nMinAgo', { n: min })
  const hours = Math.floor(min / 60)
  if (hours < 24) return t('hybrid.nHourAgo', { n: hours })
  return t('hybrid.nDayAgo', { n: Math.floor(hours / 24) })
}

/** Tile value: relative stamp with the absolute time on hover. */
function RelTimeValue({ iso, neverLabel }: { iso: string | null; neverLabel: string }) {
  const { t } = useI18n()
  if (!iso) return <span className="text-muted-foreground">{neverLabel}</span>
  return (
    <span title={formatDateTime(iso)}>{relTimeString(iso, t)}</span>
  )
}

// ─── Device management section (collapsible) ────────────────────────

function DeviceManagementSection({
  open,
  onOpenChange,
  onRegister,
  deviceActionMutation,
  rotateMutation,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onRegister: () => void
  deviceActionMutation: DeviceActionMutation
  rotateMutation: RotateKeyMutation
}) {
  const { t } = useI18n()
  const [renameTarget, setRenameTarget] = useState<HybridDeviceDTO | null>(null)
  const [rotateTarget, setRotateTarget] = useState<HybridDeviceDTO | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<HybridDeviceDTO | null>(null)

  const devicesQuery = useQuery({
    queryKey: ['hybrid', 'devices'],
    queryFn: () => fetcher<{ devices: HybridDeviceDTO[] }>('/api/hybrid/device'),
    enabled: open,
    retry: false,
  })
  const devices = devicesQuery.data?.devices ?? []

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="h-11 justify-start gap-2 px-2">
            <Laptop className="size-4" aria-hidden />
            <span className="font-medium">{t('hybrid.deviceSection')}</span>
            <ChevronDown
              className="size-4 transition-transform data-[state=open]:rotate-180"
              aria-hidden
            />
          </Button>
        </CollapsibleTrigger>
        <Button variant="outline" className="h-11" onClick={onRegister}>
          <Plus className="size-4" />
          {t('hybrid.registerDevice')}
        </Button>
      </div>
      <p className="mt-1 ps-2 text-xs text-muted-foreground">{t('hybrid.deviceSectionSub')}</p>

      <CollapsibleContent className="mt-3 grid gap-2">
        {devicesQuery.isLoading ? (
          Array.from({ length: 2 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : devicesQuery.isError ? (
          <p className="text-sm text-destructive">
            {devicesQuery.error?.message ?? t('common.error')}
          </p>
        ) : devices.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            {t('hybrid.noDevices')}
          </p>
        ) : (
          devices.map((device) => (
            <div
              key={device.deviceId}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2"
            >
              <Laptop className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{device.name}</p>
                  <Badge variant="outline" className="text-xs font-normal">
                    {device.platform === 'linux'
                      ? t('hybrid.platform.linux')
                      : t('hybrid.platform.windows')}
                  </Badge>
                  <DeviceStatusBadge status={device.status} />
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr">
                  {maskDeviceId(device.deviceId)} · {t('hybrid.lastSeen')}:{' '}
                  {device.lastSeenAt ? (
                    <RelTime iso={device.lastSeenAt} />
                  ) : (
                    t('hybrid.never')
                  )}
                </p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-11 w-11 p-0"
                    aria-label={`${t('hybrid.actions.rename')} / ${device.name}`}
                  >
                    <MoreVertical className="size-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setRenameTarget(device)}>
                    <Pencil className="size-4" aria-hidden />
                    {t('hybrid.actions.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setRotateTarget(device)}>
                    <KeyRound className="size-4" aria-hidden />
                    {t('hybrid.actions.rotate')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {device.status === 'active' ? (
                    <DropdownMenuItem
                      onClick={() =>
                        deviceActionMutation.mutate({
                          deviceId: device.deviceId,
                          action: 'pause',
                        })
                      }
                    >
                      <Pause className="size-4" aria-hidden />
                      {t('hybrid.actions.pause')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      onClick={() =>
                        deviceActionMutation.mutate({
                          deviceId: device.deviceId,
                          action: 'resume',
                        })
                      }
                    >
                      <Play className="size-4" aria-hidden />
                      {t('hybrid.actions.resume')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setRevokeTarget(device)}
                  >
                    <TriangleAlert className="size-4" aria-hidden />
                    {t('hybrid.actions.revoke')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </CollapsibleContent>

      {/* rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('hybrid.renameTitle')}</DialogTitle>
          </DialogHeader>
          {renameTarget ? (
            <RenameDeviceForm
              initialName={renameTarget.name}
              pending={deviceActionMutation.isPending}
              onSubmit={(name) => {
                deviceActionMutation.mutate(
                  { deviceId: renameTarget.deviceId, action: 'rename', name },
                  { onSuccess: () => setRenameTarget(null) },
                )
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* rotate-key confirm */}
      <AlertDialog
        open={rotateTarget !== null}
        onOpenChange={(o) => {
          if (!o && !rotateMutation.isPending) setRotateTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('hybrid.rotateConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('hybrid.rotateConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={rotateMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11"
              disabled={rotateMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (!rotateTarget) return
                rotateMutation.mutate(rotateTarget.deviceId, {
                  onSuccess: () => setRotateTarget(null),
                })
              }}
            >
              {rotateMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <KeyRound className="size-4" />
              )}
              {t('hybrid.actions.rotate')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* revoke confirm (destructive) */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o && !deviceActionMutation.isPending) setRevokeTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('hybrid.revokeConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('hybrid.revokeConfirmBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={deviceActionMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-destructive text-white hover:bg-destructive/90"
              disabled={deviceActionMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (!revokeTarget) return
                deviceActionMutation.mutate(
                  { deviceId: revokeTarget.deviceId, action: 'revoke' },
                  { onSuccess: () => setRevokeTarget(null) },
                )
              }}
            >
              {deviceActionMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <TriangleAlert className="size-4" />
              )}
              {t('hybrid.actions.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  )
}

/** Registry status → colored badge. */
function DeviceStatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  if (status === 'active') {
    return (
      <Badge className="border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
        {t('hybrid.enabled')}
      </Badge>
    )
  }
  if (status === 'paused') {
    return (
      <Badge className="border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
        {t('hybrid.paused')}
      </Badge>
    )
  }
  return (
    <Badge className="border-rose-300 bg-rose-100 text-rose-800 hover:bg-rose-100">
      {t('hybrid.actions.revoke')}
    </Badge>
  )
}

// ─── Forms ──────────────────────────────────────────────────────────

/** Register-device form: name + platform select (windows/linux). */
function RegisterDeviceForm({
  pending,
  onSubmit,
}: {
  pending: boolean
  onSubmit: (name: string, platform: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [platform, setPlatform] = useState('windows')

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="hybrid-device-name">{t('hybrid.deviceName')}</Label>
        <Input
          id="hybrid-device-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('hybrid.deviceName')}
          className="h-11"
          maxLength={80}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="hybrid-device-platform">{t('hybrid.devicePlatform')}</Label>
        <Select value={platform} onValueChange={setPlatform}>
          <SelectTrigger id="hybrid-device-platform" className="h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="windows">{t('hybrid.platform.windows')}</SelectItem>
            <SelectItem value="linux">{t('hybrid.platform.linux')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DialogFooter>
        <Button
          className="h-11"
          disabled={pending || name.trim().length === 0}
          onClick={() => onSubmit(name.trim(), platform)}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Plus className="size-4" />}
          {t('hybrid.registerDevice')}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** Rename form (pre-filled with the current name). */
function RenameDeviceForm({
  initialName,
  pending,
  onSubmit,
}: {
  initialName: string
  pending: boolean
  onSubmit: (name: string) => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState(initialName)

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="hybrid-rename-name">{t('hybrid.deviceName')}</Label>
        <Input
          id="hybrid-rename-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-11"
          maxLength={80}
          autoComplete="off"
        />
      </div>
      <DialogFooter>
        <Button
          className="h-11"
          disabled={pending || name.trim().length === 0 || name.trim() === initialName}
          onClick={() => onSubmit(name.trim())}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Check className="size-4" />}
          {t('common.save')}
        </Button>
      </DialogFooter>
    </div>
  )
}

/** The one-time device key: selectable code block + copy + warning. */
function DeviceKeyReveal({ deviceId, deviceKey }: { deviceId: string; deviceKey: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copyKey = async () => {
    try {
      await navigator.clipboard.writeText(deviceKey)
      setCopied(true)
      toast.success(t('hybrid.copied'))
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('common.error'))
    }
  }

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">{t('hybrid.deviceIdLabel')}</Label>
        <p className="select-all break-all rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs" dir="ltr">
          {deviceId}
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">{t('hybrid.deviceKeyLabel')}</Label>
        <p
          className="select-all break-all rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-xs"
          dir="ltr"
        >
          {deviceKey}
        </p>
      </div>
      <Button variant="outline" className="h-11" onClick={() => void copyKey()}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? t('hybrid.copied') : t('hybrid.copy')}
      </Button>
      <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
        {t('hybrid.keyWarning')}
      </p>
    </div>
  )
}
