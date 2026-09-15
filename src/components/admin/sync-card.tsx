'use client'

// ─── R15: Sync Center card (Settings) ───────────────────────────────
// Offline-first story: data lives locally; this card keeps it in step
// with a hosted/cloud RMS copy — status, cloud target, auto-export,
// key rotation, and export / push / import bundle actions. All strings
// via t() (r15-sync dict); RTL-safe (logical spacing, dir="ltr" on URLs).

import { useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CloudUpload,
  FileJson,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  TriangleAlert,
  Wifi,
  WifiOff,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import type { SyncBundle, SyncImportSummary, SyncSettingsDTO } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Tables reported in the pending breakdown, in display order. */
const PENDING_TABLES = [
  'orders',
  'orderItems',
  'payments',
  'customers',
  'attendance',
  'cashEntries',
  'inventoryTransactions',
  'reservations',
  'auditLogs',
] as const

/** Sum the values of a per-table count record ({"orders": 3, …} → n). */
function sumCounts(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0)
}

/** Local timestamp for bundle file names: rsm-sync-YYYYMMDD-HHmm.json */
function bundleFileStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** Hand a blob to the browser as a file save (same pattern as backups). */
function saveBlobFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/** navigator.onLine as a React store (online/offline event subscription). */
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

export function SyncCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // ── live status (poll + refetch on window focus) ──
  const statusQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => fetcher<{ sync: SyncSettingsDTO }>('/api/sync/status'),
    refetchInterval: 60_000,
    retry: false,
  })
  const sync = statusQuery.data?.sync ?? null

  const refreshStatus = () => void queryClient.invalidateQueries({ queryKey: ['sync-status'] })

  // ── connectivity (navigator.onLine as an external store) ──
  const online = useSyncExternalStore(subscribeOnline, getOnlineSnapshot, getOnlineServerSnapshot)

  // ── auto-export switch ──
  const autoMutation = useMutation({
    mutationFn: (autoExport: boolean) =>
      apiFetch<{ sync: SyncSettingsDTO }>('/api/sync/settings', {
        method: 'PUT',
        body: { autoExport },
      }),
    onSuccess: (_data, autoExport) => {
      toast.success(autoExport ? t('sync.autoOn') : t('sync.autoOff'))
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── key rotation ──
  const rotateMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ sync: SyncSettingsDTO }>('/api/sync/settings', {
        method: 'PUT',
        body: { rotateKey: true },
      }),
    onSuccess: () => {
      toast.success(t('sync.keyRegenerated'))
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── export bundle (delta) → JSON file download ──
  const exportMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ bundle: SyncBundle; exportedAt: string }>('/api/sync/export', {
        body: { mode: 'delta' },
      }),
    onSuccess: (data) => {
      const file = `rsm-sync-${bundleFileStamp()}.json`
      const blob = new Blob([JSON.stringify(data.bundle, null, 2)], {
        type: 'application/json',
      })
      saveBlobFile(blob, file)
      toast.success(t('sync.exportDone', { n: sumCounts(data.bundle.counts), file }))
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── push to cloud (disabled without a target) ──
  const pushMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: true; target: string; summary: SyncImportSummary }>('/api/sync/push', {
        body: { mode: 'delta' },
      }),
    onSuccess: (data) => {
      toast.success(
        t('sync.pushDone', {
          inserted: sumCounts(data.summary.inserted),
          updated: sumCounts(data.summary.updated),
        }),
      )
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── import bundle (file pick → confirm → merge) ──
  const [pendingImport, setPendingImport] = useState<{ name: string; bundle: SyncBundle } | null>(
    null,
  )
  const importMutation = useMutation({
    mutationFn: (bundle: SyncBundle) =>
      apiFetch<{ summary: SyncImportSummary }>('/api/sync/import', { body: bundle }),
    onSuccess: (data) => {
      toast.success(
        t('sync.importDone', {
          inserted: sumCounts(data.summary.inserted),
          updated: sumCounts(data.summary.updated),
          skipped: sumCounts(data.summary.skipped),
        }),
      )
      setPendingImport(null)
      refreshStatus()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const fileInputRef = useRef<HTMLInputElement>(null)

  const onImportFile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as SyncBundle
      if (!parsed || parsed.format !== 'rsm-sync/1' || typeof parsed.data !== 'object') {
        toast.error(t('sync.importInvalid'))
        return
      }
      setPendingImport({ name: file.name, bundle: parsed })
    } catch {
      toast.error(t('sync.importInvalid'))
    }
  }

  // ── pending breakdown dialog ──
  const [breakdownOpen, setBreakdownOpen] = useState(false)

  const hasTarget = !!sync?.targetUrl
  const pending = sync?.pending
  const pendingTotal = pending?.total ?? 0

  return (
    <Card id="sync-center-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="size-5 text-primary" aria-hidden />
          {t('sync.title')}
        </CardTitle>
        <CardDescription>{t('sync.subtitle')}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {/* ── status ── */}
        {statusQuery.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : statusQuery.isError || !sync ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4 shrink-0" aria-hidden />
              {statusQuery.error?.message ?? t('sync.status')}
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
            {/* status grid — stacks on phones */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">{t('sync.lastExport')}</p>
                <p className="mt-1 text-sm font-medium">
                  {sync.lastExportAt ? formatDateTime(sync.lastExportAt) : t('sync.never')}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">{t('sync.lastPush')}</p>
                <p className="mt-1 text-sm font-medium">
                  {sync.lastPushAt ? formatDateTime(sync.lastPushAt) : t('sync.never')}
                </p>
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">{t('sync.pending')}</p>
                {pendingTotal > 0 ? (
                  <button
                    type="button"
                    onClick={() => setBreakdownOpen(true)}
                    className="mt-1 inline-flex items-center gap-1.5 rounded-full text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    aria-label={`${t('sync.pendingCount', { n: pendingTotal })} — ${t('sync.details')}`}
                  >
                    <Badge className="bg-amber-600 text-white hover:bg-amber-600">
                      {pendingTotal}
                    </Badge>
                    {t('sync.pendingCount', { n: pendingTotal })}
                  </button>
                ) : (
                  <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
                    {t('sync.inSync')}
                  </p>
                )}
              </div>
              <div className="rounded-lg border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">{t('sync.connectivity')}</p>
                <p
                  className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium"
                  role="status"
                >
                  <span
                    className={`size-2.5 shrink-0 rounded-full ${online ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}
                    aria-hidden
                  />
                  {online ? (
                    <>
                      <Wifi className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                      {t('sync.online')}
                    </>
                  ) : (
                    <>
                      <WifiOff className="size-4 text-muted-foreground" aria-hidden />
                      {t('sync.offline')}
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* ── cloud target (keyed field — remounts with fresh data) ── */}
            <TargetField key={sync.targetUrl} initialTarget={sync.targetUrl} onSaved={refreshStatus} />

            {/* ── auto-export ── */}
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="min-w-0">
                <Label htmlFor="sync-auto" className="text-sm font-medium">
                  {t('sync.autoLabel')}
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">{t('sync.autoHelper')}</p>
              </div>
              <Switch
                id="sync-auto"
                checked={sync.autoExport}
                disabled={autoMutation.isPending}
                onCheckedChange={(checked) => autoMutation.mutate(checked)}
                className="mt-1 data-[state=checked]:bg-emerald-600"
              />
            </div>

            {/* ── sync key (masked) ── */}
            <div className="grid gap-2">
              <Label htmlFor="sync-key">{t('sync.keyLabel')}</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="sync-key"
                  readOnly
                  value={sync.syncKeyMasked}
                  dir="ltr"
                  className="h-11 font-mono text-xs"
                />
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="h-11 shrink-0"
                      disabled={rotateMutation.isPending}
                    >
                      {rotateMutation.isPending ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <KeyRound className="size-4" />
                      )}
                      {rotateMutation.isPending
                        ? t('sync.keyRegenerating')
                        : t('sync.keyRegenerate')}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('sync.keyConfirmTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t('sync.keyConfirmBody')}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="h-11">{t('common.cancel')}</AlertDialogCancel>
                      <AlertDialogAction
                        className="h-11"
                        onClick={() => rotateMutation.mutate()}
                      >
                        {t('sync.keyConfirmAction')}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
              <p className="text-xs text-muted-foreground">{t('sync.keyHelper')}</p>
            </div>

            <Separator />

            {/* ── actions ── */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="h-11"
                disabled={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
              >
                {exportMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FileJson className="size-4" />
                )}
                {exportMutation.isPending ? t('sync.exporting') : t('sync.export')}
              </Button>

              {hasTarget ? (
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={pushMutation.isPending}
                  onClick={() => pushMutation.mutate()}
                >
                  {pushMutation.isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <CloudUpload className="size-4" />
                  )}
                  {pushMutation.isPending ? t('sync.pushing') : t('sync.push')}
                </Button>
              ) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* span keeps the disabled button hoverable for the tooltip */}
                    <span className="inline-flex" tabIndex={0}>
                      <Button variant="outline" className="h-11" disabled aria-disabled>
                        <CloudUpload className="size-4" />
                        {t('sync.push')}
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{t('sync.pushNeedsTarget')}</TooltipContent>
                </Tooltip>
              )}

              <Button
                variant="outline"
                className="h-11"
                disabled={importMutation.isPending}
                onClick={() => fileInputRef.current?.click()}
              >
                {importMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArrowUpFromLine className="size-4" />
                )}
                {importMutation.isPending ? t('sync.importing') : t('sync.import')}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-hidden
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  e.target.value = '' // allow re-picking the same file
                  if (file) void onImportFile(file)
                }}
              />
            </div>
          </>
        )}

        {/* ── pending breakdown dialog (per-table counts) ── */}
        <Dialog open={breakdownOpen} onOpenChange={setBreakdownOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('sync.pendingBreakdown')}</DialogTitle>
              <DialogDescription>{t('sync.pending')}</DialogDescription>
            </DialogHeader>
            {pending && pendingTotal > 0 ? (
              <ul className="max-h-96 overflow-y-auto rms-scroll grid gap-1.5 p-1 text-sm">
                {PENDING_TABLES.map((table) => (
                  <li
                    key={table}
                    className="flex items-center justify-between gap-4 rounded-md border px-3 py-2"
                  >
                    <span className="min-w-0 truncate">{t(`sync.table.${table}`)}</span>
                    <Badge variant="secondary" className="tabular-nums shrink-0">
                      {pending[table]}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-1 text-sm text-muted-foreground">{t('sync.pendingEmpty')}</p>
            )}
          </DialogContent>
        </Dialog>

        {/* ── import confirm dialog (merge semantics) ── */}
        <AlertDialog
          open={pendingImport !== null}
          onOpenChange={(open) => {
            if (!open && !importMutation.isPending) setPendingImport(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('sync.importConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('sync.importConfirmBody')}
              </AlertDialogDescription>
              {pendingImport ? (
                <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground" dir="auto">
                  {t('sync.importConfirmFile', {
                    name: pendingImport.name,
                    date: formatDateTime(pendingImport.bundle.generatedAt),
                    n: sumCounts(pendingImport.bundle.counts),
                  })}
                </p>
              ) : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11" disabled={importMutation.isPending}>
                {t('common.cancel')}
              </AlertDialogCancel>
              <AlertDialogAction
                className="h-11"
                disabled={importMutation.isPending}
                onClick={(e) => {
                  e.preventDefault() // keep the dialog open until the mutation settles
                  if (pendingImport) importMutation.mutate(pendingImport.bundle)
                }}
              >
                {importMutation.isPending ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ArrowDownToLine className="size-4" />
                )}
                {importMutation.isPending ? t('sync.importing') : t('sync.importConfirmAction')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  )
}

// ─── Cloud target field (keyed by the saved value → remounts with fresh
// data after loads/saves, so no state-seeding effects are needed) ─────

function TargetField({
  initialTarget,
  onSaved,
}: {
  initialTarget: string
  onSaved: () => void
}) {
  const { t } = useI18n()
  const [targetUrl, setTargetUrl] = useState(initialTarget)

  const saveMutation = useMutation({
    mutationFn: (url: string) =>
      apiFetch<{ sync: SyncSettingsDTO }>('/api/sync/settings', {
        method: 'PUT',
        body: { targetUrl: url.trim() },
      }),
    onSuccess: () => {
      toast.success(t('sync.targetSaved'))
      onSaved()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const dirty = targetUrl.trim() !== initialTarget.trim()

  return (
    <div className="grid gap-2">
      <Label htmlFor="sync-target-url">{t('sync.targetLabel')}</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="sync-target-url"
          value={targetUrl}
          onChange={(e) => setTargetUrl(e.target.value)}
          className="h-11"
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={t('sync.targetPh')}
        />
        <Button
          className="h-11 shrink-0"
          disabled={saveMutation.isPending || !dirty}
          onClick={() => saveMutation.mutate(targetUrl)}
        >
          {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Save className="size-4" />}
          {t('sync.targetSave')}
        </Button>
      </div>
      {!initialTarget ? (
        <p className="text-xs text-muted-foreground">{t('sync.targetUnset')}</p>
      ) : null}
    </div>
  )
}
