'use client'

// ─── r43: live two-way sync health pill (Launcher hero) ──────────────
//
// ONE component, BOTH versions of the platform:
//  · the CLOUD version (Vercel + Neon) renders hub mode — is the datastore
//    alive, how many devices are connected, when did they last sync;
//  · the DESKTOP version (full Windows install) renders terminal mode —
//    is my engine running, is the cloud reachable, last push/pull, queue.
//
// Polls /api/hybrid/live-health every 30 s (TanStack Query) — the same
// snapshot the desktop agent's dashboard shows, so the pill and the agent
// always agree. Visible to roles that can open Settings (admins/managers/
// developer); staff roles never see infrastructure state.
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  Cloud,
  Loader2,
  PauseCircle,
} from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type LiveHealth =
  | {
      mode: 'terminal'
      healthy: boolean
      engine: 'running' | 'stopped'
      paused: boolean
      cloudReachable: 'yes' | 'no' | 'unknown'
      cloudAuthFailed: boolean
      lastPushAt: string | null
      lastPullAt: string | null
      pendingUploads: number
      pendingDownloads: number
      failedOut: number
      deviceName: string | null
      targetUrl: string | null
      dbOk: boolean
      restorePending: string | null
      checkedAt: string
    }
  | {
      mode: 'hub'
      healthy: boolean
      dbOk: boolean
      activeDevices: number
      lastDeviceContactAt: string | null
      eventsLastHour: number
      lastEventAt: string | null
      checkedAt: string
    }

/** "3m ago" style relative time (compact, bilingual-safe digits). */
function agoLabel(iso: string | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!iso) return t('home.syncNever')
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return t('home.syncJustNow')
  const min = Math.floor(ms / 60_000)
  if (min < 1) return t('home.syncJustNow')
  if (min < 60) return t('home.syncAgo', { minutes: min })
  const h = Math.floor(min / 60)
  return t('home.syncAgoHours', { hours: h })
}

export function SyncHealthPill() {
  const { t } = useI18n()
  const query = useQuery({
    queryKey: ['hybrid', 'live-health'],
    queryFn: () => apiFetch<LiveHealth>('/api/hybrid/live-health', { method: 'GET' }),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  })

  const health = query.data

  // ── compact verdict ──
  let tone: 'ok' | 'warn' | 'bad' | 'unknown' = 'unknown'
  let label = t('home.syncChecking')
  if (health) {
    if (health.mode === 'hub') {
      tone = health.healthy ? 'ok' : 'bad'
      label = health.healthy ? t('home.syncHubLive') : t('home.syncHubDown')
    } else if (health.paused) {
      tone = 'warn'
      label = t('home.syncPaused')
    } else if (!health.healthy) {
      tone = 'bad'
      label = t('home.syncOffline')
    } else if (health.pendingUploads + health.pendingDownloads > 0 || health.cloudReachable !== 'yes') {
      tone = 'warn'
      label = t('home.syncPending')
    } else {
      tone = 'ok'
      label = t('home.syncLive')
    }
  }

  const dot = {
    ok: 'bg-success',
    warn: 'bg-warning',
    bad: 'bg-destructive',
    unknown: 'bg-muted-foreground/40',
  }[tone]

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('home.syncDetailTitle')}
          title={t('home.syncDetailTitle')}
          className={cn(
            'flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-sm font-semibold card-elevated backdrop-blur-sm transition active:scale-95',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tone === 'ok' && 'border-success/35 bg-success/10 text-success hover:bg-success/20',
            tone === 'warn' && 'border-warning/40 bg-warning/10 text-warning hover:bg-warning/20',
            tone === 'bad' && 'border-destructive/35 bg-destructive/10 text-destructive hover:bg-destructive/20',
            (tone === 'unknown' || !health) && 'border-border/70 bg-card/70 text-muted-foreground hover:bg-card',
          )}
        >
          {query.isFetching && !health ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <span className="relative flex size-2.5">
              {tone === 'ok' && (
                <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', dot)} />
              )}
              <span className={cn('relative inline-flex size-2.5 rounded-full', dot)} />
            </span>
          )}
          <span className="hidden sm:inline">{label}</span>
          {health?.mode === 'hub' ? <Cloud className="size-4" aria-hidden /> : <Activity className="size-4" aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 rounded-2xl p-4" dir="auto">
        <p className="flex items-center gap-2 text-sm font-semibold">
          {health?.healthy ? (
            <CheckCircle2 className="size-4 text-success" aria-hidden />
          ) : tone === 'bad' ? (
            <CloudOff className="size-4 text-destructive" aria-hidden />
          ) : (
            <AlertTriangle className="size-4 text-warning" aria-hidden />
          )}
          {t('home.syncDetailTitle')}
        </p>

        {!health ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('home.syncChecking')}</p>
        ) : health.mode === 'terminal' ? (
          <dl className="mt-3 grid gap-1.5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncEngine')}</dt>
              <dd className="font-medium">
                {health.paused ? (
                  <span className="inline-flex items-center gap-1.5">
                    <PauseCircle className="size-3.5 text-amber-600" aria-hidden /> {t('home.syncEnginePaused')}
                  </span>
                ) : health.engine === 'running' ? (
                  t('home.syncEngineRunning')
                ) : (
                  t('home.syncEngineStopped')
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncCloudReachable')}</dt>
              <dd className="font-medium">
                {health.cloudReachable === 'yes'
                  ? t('home.syncCloudYes')
                  : health.cloudReachable === 'no'
                    ? t('home.syncCloudNo')
                    : t('home.syncCloudUnknown')}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncLastPush')}</dt>
              <dd className="font-medium tabular-nums">{agoLabel(health.lastPushAt, t)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncLastPull')}</dt>
              <dd className="font-medium tabular-nums">{agoLabel(health.lastPullAt, t)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncQueue')}</dt>
              <dd className="font-medium tabular-nums">
                {t('home.syncQueueValue', {
                  up: health.pendingUploads,
                  down: health.pendingDownloads,
                })}
              </dd>
            </div>
            {health.deviceName && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{t('home.syncDevice')}</dt>
                <dd className="max-w-40 truncate font-medium" dir="ltr">
                  {health.deviceName}
                </dd>
              </div>
            )}
            {health.targetUrl && (
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{t('home.syncTarget')}</dt>
                <dd className="max-w-40 truncate font-mono text-xs" dir="ltr">
                  {health.targetUrl}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <dl className="mt-3 grid gap-1.5 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncHubDb')}</dt>
              <dd className="font-medium">{health.dbOk ? t('home.syncCloudYes') : t('home.syncCloudNo')}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncActiveDevices')}</dt>
              <dd className="font-medium tabular-nums">{health.activeDevices}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncLastContact')}</dt>
              <dd className="font-medium tabular-nums">{agoLabel(health.lastDeviceContactAt, t)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t('home.syncEventsHour')}</dt>
              <dd className="font-medium tabular-nums">{health.eventsLastHour}</dd>
            </div>
          </dl>
        )}
        <p className="mt-3 border-t border-border/60 pt-2.5 text-xs text-muted-foreground">{t('home.syncFooter')}</p>
      </PopoverContent>
    </Popover>
  )
}
