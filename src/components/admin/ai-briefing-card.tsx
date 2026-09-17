'use client'

// 9-b: AI manager briefing hero card for the admin dashboard (admin only —
// the parent mounts it after checking the session role; the API 403s
// otherwise). Self-contained: GET /api/ai/briefing (15-min server cache)
// with a 5-min client staleTime. The refresh button bumps the query key so
// the request carries ?refresh=1 and the server recomputes.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, RotateCw, Sparkles, WifiOff } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { fetcher } from '@/lib/api'
import { formatCurrency, formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export type AiBriefingResponse = {
  briefing: {
    text: string
    provider: string
    generatedAt: string
    snapshot: {
      revenueToday: number
      ordersToday: number
      avgCheck: number
      tipsToday: number
      occupiedNow: number
    }
  }
  cached: boolean
}

/** Provider pill label — 'zai' is the platform model, labeled "Saffron AI". */
export function aiProviderLabel(provider: string, zaiLabel: string): string {
  if (provider === 'groq') return 'Groq'
  if (provider === 'gemini') return 'Gemini'
  if (provider === 'zai') return zaiLabel
  return 'AI'
}

export default function AiBriefingCard() {
  const { t } = useI18n()
  // Refresh bumps the query key; tick > 0 asks the server to bypass its cache.
  const [refreshTick, setRefreshTick] = useState(0)

  const { data, isPending, isError, isFetching } = useQuery({
    queryKey: ['ai-briefing', refreshTick],
    queryFn: () =>
      fetcher<AiBriefingResponse>(`/api/ai/briefing${refreshTick > 0 ? '?refresh=1' : ''}`),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const handleRefresh = () => setRefreshTick((tick) => tick + 1)

  if (isPending) {
    return (
      <Card className="gap-0 overflow-hidden p-0" aria-busy="true">
        <div className="bg-gradient-to-r from-amber-100 via-orange-50 to-rose-100 p-4 sm:p-6">
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-xl" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-3.5 w-72 max-w-full" />
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
        </div>
        <div className="space-y-4 p-4 sm:p-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
          <div className="space-y-2.5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        </div>
      </Card>
    )
  }

  if (isError) {
    return (
      <Card className="border-dashed p-4 sm:p-6">
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-muted">
            <WifiOff className="size-6 text-stone-400" aria-hidden />
          </div>
          <p className="max-w-md text-sm text-muted-foreground">{t('ai.briefingOffline')}</p>
          <Button variant="outline" className="h-11 gap-2 rounded-xl" onClick={handleRefresh}>
            <RotateCw className="size-4" aria-hidden />
            {t('ai.briefingRetry')}
          </Button>
        </div>
      </Card>
    )
  }

  const briefing = data.briefing
  const lines = briefing.text.split('\n').filter((line) => line.trim().length > 0)

  return (
    <Card className="gap-0 overflow-hidden p-0">
      {/* Gradient hero header */}
      <div className="bg-gradient-to-r from-amber-100 via-orange-50 to-rose-100 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/80 shadow-sm">
              <Sparkles className="size-5 text-amber-600" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-bold tracking-tight">{t('ai.briefingTitle')}</h2>
              <p className="mt-0.5 text-xs text-stone-600">{t('ai.briefingSubtitle')}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {data.cached && (
              <Badge
                variant="outline"
                className="border-stone-300 bg-white/70 text-[10px] font-medium text-stone-500"
              >
                {t('ai.briefingCached')}
              </Badge>
            )}
            <Badge variant="secondary" className="bg-white/80 font-medium text-stone-700 shadow-sm">
              {aiProviderLabel(briefing.provider, t('ai.providerZai'))}
            </Badge>
            <Button
              variant="outline"
              className="h-11 w-11 rounded-xl bg-white/80 px-0 hover:bg-white"
              onClick={handleRefresh}
              disabled={isFetching}
              aria-label={t('ai.briefingRefresh')}
              title={t('ai.briefingRefresh')}
            >
              <RotateCw className={cn('size-4', isFetching && 'animate-spin')} aria-hidden />
            </Button>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-stone-500">
          <Clock className="size-3" aria-hidden />
          <span className="tabular-nums">{formatTime(briefing.generatedAt)}</span>
        </p>
      </div>

      {/* Body */}
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MiniStat label={t('ai.statRevenue')} value={formatCurrency(briefing.snapshot.revenueToday)} />
          <MiniStat label={t('ai.statOrders')} value={String(briefing.snapshot.ordersToday)} />
          <MiniStat label={t('ai.statAvgCheck')} value={formatCurrency(briefing.snapshot.avgCheck)} />
          <MiniStat label={t('ai.statTips')} value={formatCurrency(briefing.snapshot.tipsToday)} />
        </div>

        <div
          className="rms-scroll max-h-48 overflow-y-auto rounded-xl border border-[#E2E2E0] bg-stone-50/60 p-4"
          aria-label={t('ai.briefingTitle')}
        >
          {lines.map((line, i) => {
            const bullet = line.trimStart().startsWith('- ')
            const text = bullet ? line.trimStart().slice(2) : line
            const isRecommendation = /^recommendation\b/i.test(text.trim())
            if (bullet) {
              return (
                <p key={i} className="flex gap-2.5 py-0.5 text-sm leading-relaxed text-stone-700">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
                  <span>{text}</span>
                </p>
              )
            }
            return (
              <p
                key={i}
                className={cn(
                  'py-0.5 text-sm leading-relaxed',
                  isRecommendation ? 'pt-2 font-semibold text-primary' : 'text-stone-700',
                )}
              >
                {text}
              </p>
            )
          })}
        </div>
      </div>
    </Card>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#E2E2E0] bg-white p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 text-lg font-bold leading-none tabular-nums">{value}</p>
    </div>
  )
}
