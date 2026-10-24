'use client'

// ─── Vision Movements tab — the human review center ──────────────────
// Every AI-detected guest move is a SUGGESTION: the amber AI banner is
// rendered on every pending card, decisions are explicit (mode select
// when an order is attached, confirm dialog describes the operational
// change), 409 state-changes flip cards to conflict, and confirmed
// table+order moves can be undone.

import { useState } from 'react'
import { ArrowRight, ChevronDown, Loader2, Sparkles, TriangleAlert, Undo2, Users } from 'lucide-react'

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
import { Card, CardContent } from '@/components/ui/card'
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
import { elapsedSince, formatCurrency, formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { MovementCandidateDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

import { useMovementDecisions, type MovementMode } from './movement-actions'
import { VisionErrorCard } from './vision-shared'
import type { MovementFilter } from './vision-view'
import { confidenceClass, formatConfidence, movementStatusClass } from './vision-utils'

const FILTERS: MovementFilter[] = ['pending', 'confirmed', 'rejected', 'conflict', 'all']

type Props = {
  movements: MovementCandidateDTO[]
  isLoading: boolean
  isError: boolean
  refetch: () => void
  status: MovementFilter
  onStatusChange: (status: MovementFilter) => void
  pendingCount: number
}

export default function VisionMovementsTab({
  movements,
  isLoading,
  isError,
  refetch,
  status,
  onStatusChange,
  pendingCount,
}: Props) {
  const { t } = useI18n()

  const statusLabel = (f: MovementFilter): string =>
    f === 'all' ? t('vision.movements.filter.all') : t(`vision.movements.status.${f}`)

  if (isLoading) {
    return (
      <section className="space-y-4" aria-busy="true">
        <div className="flex gap-2">
          {FILTERS.map((f) => (
            <Skeleton key={f} className="h-11 w-28 rounded-full" />
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-2xl" />
          ))}
        </div>
      </section>
    )
  }
  if (isError) {
    return <VisionErrorCard onRetry={refetch} />
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('vision.movements.subtitle')}</p>

      {/* ── status filter chips ── */}
      <div className="rms-scroll flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t('vision.tabs.movements')}>
        {FILTERS.map((f) => {
          const active = status === f
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onStatusChange(f)}
              className={cn(
                'h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition',
                active
                  ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                  : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50',
              )}
            >
              {statusLabel(f)}
              {f === 'pending' && pendingCount > 0 && (
                <span className="ms-1 rounded-full bg-amber-100 px-1.5 text-[11px] font-bold text-amber-800 tabular-nums">
                  {pendingCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* ── cards ── */}
      {movements.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <Users className="size-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {t('vision.movements.empty', { status: statusLabel(status) })}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="rms-scroll max-h-[32rem] space-y-3 overflow-y-auto pr-1">
          {movements.map((movement) => (
            <MovementCard key={movement.id} movement={movement} />
          ))}
        </div>
      )}
    </section>
  )
}

// ─── One suggestion card ─────────────────────────────────────────────

function MovementCard({ movement }: { movement: MovementCandidateDTO }) {
  const { t } = useI18n()
  const { confirmMutation, rejectMutation, undoMutation } = useMovementDecisions()

  const [mode, setMode] = useState<MovementMode>('table_and_order')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [undoOpen, setUndoOpen] = useState(false)

  const pending = movement.status === 'pending'
  const hasOrder = movement.orderId != null
  const busy =
    confirmMutation.isPending || rejectMutation.isPending || undoMutation.isPending
  // Live-state guard: the proposal may be stale — the order must still be
  // on the source table for a "move table + order" to make sense.
  const orderNotOnFrom =
    hasOrder &&
    movement.currentState.orderTableId != null &&
    movement.currentState.orderTableId !== movement.fromTableId
  const canUndo =
    movement.status === 'confirmed' && movement.appliedAt != null && movement.orderId != null

  const orderPart = hasOrder
    ? t('vision.movements.confirmOrderPart', {
        id: movement.orderId ?? 0,
        total: formatCurrency(movement.orderTotal ?? 0),
      })
    : ''

  const submitConfirm = async () => {
    try {
      await confirmMutation.mutateAsync({
        id: movement.id,
        mode: hasOrder ? mode : 'table_only',
        reason: reason.trim() === '' ? undefined : reason.trim(),
      })
      setConfirmOpen(false)
    } catch {
      // toasted inside the mutation (409 flips the card to conflict)
    }
  }

  const submitReject = async () => {
    try {
      await rejectMutation.mutateAsync({
        id: movement.id,
        reason: reason.trim() === '' ? undefined : reason.trim(),
      })
      setRejectOpen(false)
    } catch {
      // toasted inside the mutation
    }
  }

  const submitUndo = async () => {
    try {
      await undoMutation.mutateAsync({ id: movement.id })
      setUndoOpen(false)
    } catch {
      // toasted inside the mutation
    }
  }

  return (
    <Card className={cn('gap-0', pending ? 'border-amber-200' : 'border-stone-200')}>
      <CardContent className="space-y-3 p-4">
        {/* header */}
        <div className="flex flex-wrap items-center gap-2">
          <p className="flex items-center gap-2 text-base font-bold">
            <span className="tabular-nums">{movement.fromTableName}</span>
            <ArrowRight className="size-4 text-muted-foreground rtl:rotate-180" aria-hidden />
            <span className="tabular-nums">{movement.toTableName}</span>
          </p>
          <Badge variant="outline" className={cn(movementStatusClass(movement.status), 'gap-1.5')}>
            {pending && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-amber-500" />
              </span>
            )}
            {t(`vision.movements.status.${movement.status}`)}
          </Badge>
          <Badge variant="outline" className={confidenceClass(movement.confidence)}>
            {t('vision.movements.confidence')} {formatConfidence(movement.confidence)}
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <Users className="size-3" aria-hidden />
            {t('vision.movements.guests', { n: movement.peopleCount })}
          </Badge>
        </div>

        {/* AI banner — mandatory on pending suggestions */}
        {pending && (
          <p
            role="note"
            className="flex items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"
          >
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            {t('vision.movements.aiBanner')}
          </p>
        )}

        {/* detail grid */}
        <div className="grid gap-x-4 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
          <p>
            <span className="font-medium text-foreground">{t('vision.movements.detected')}: </span>
            <span className="tabular-nums">
              {formatTime(movement.detectedAt)} ({elapsedSince(movement.detectedAt)})
            </span>
          </p>
          <p>
            <span className="font-medium text-foreground">{t('vision.movements.order')}: </span>
            {hasOrder ? (
              <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 tabular-nums">
                #{movement.orderId} · {formatCurrency(movement.orderTotal ?? 0)}
              </Badge>
            ) : (
              t('vision.movements.noOrder')
            )}
          </p>
          {movement.evidence && (
            <p className="sm:col-span-2">
              <span className="font-medium text-foreground">{t('vision.movements.evidence')}: </span>
              {t('vision.movements.evidenceDetail', {
                camera: movement.evidence.cameraCode ?? '—',
                n: movement.evidence.eventIds.length,
              })}
            </p>
          )}
          {/* live state badges */}
          <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
            <span className="font-medium text-foreground">{t('vision.movements.liveState')}:</span>
            <Badge variant="secondary" className="text-[10px]">
              {t('vision.movements.from')}: {t(`status.table.${movement.currentState.fromTableStatus}`)}
            </Badge>
            <Badge variant="secondary" className="text-[10px]">
              {t('vision.movements.to')}: {t(`status.table.${movement.currentState.toTableStatus}`)}
            </Badge>
            {movement.currentState.orderStatus != null && (
              <Badge
                variant="secondary"
                className={cn(
                  'text-[10px]',
                  orderNotOnFrom && 'border-rose-300 bg-rose-50 text-rose-700',
                )}
              >
                {t('vision.movements.orderStatus', {
                  status: t(`status.order.${movement.currentState.orderStatus}`),
                })}
              </Badge>
            )}
          </div>
          {orderNotOnFrom && (
            <p
              className="flex items-center gap-1.5 rounded-md border border-rose-300 bg-rose-50 px-2 py-1.5 font-semibold text-rose-700 sm:col-span-2"
              role="alert"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              {t('vision.movements.orderNotOnFrom')}
            </p>
          )}
        </div>

        {/* decision trail */}
        {movement.decidedByName && (
          <p className="space-y-0.5 text-[11px] leading-snug text-muted-foreground">
            {movement.decidedAt && (
              <span className="me-1 tabular-nums">
                {t('vision.movements.decidedAt', { time: formatTime(movement.decidedAt) })}
              </span>
            )}
            <span>{t('vision.movements.decidedBy', { name: movement.decidedByName })}</span>
            {movement.decisionReason && (
              <span className="block">
                {t('vision.movements.reasonLabel', { reason: movement.decisionReason })}
              </span>
            )}
            {movement.appliedAt && (
              <span className="block tabular-nums">
                {t('vision.movements.appliedAt', { time: formatTime(movement.appliedAt) })}
              </span>
            )}
          </p>
        )}

        {/* actions (pending only) */}
        {pending && (
          <div className="space-y-3 border-t border-stone-100 pt-3">
            {hasOrder && (
              <div className="space-y-1.5">
                <Label htmlFor={`mode-${movement.id}`} className="text-xs">
                  {t('vision.movements.mode')}
                </Label>
                <Select value={mode} onValueChange={(v) => setMode(v as MovementMode)}>
                  <SelectTrigger id={`mode-${movement.id}`} className="h-11 w-full sm:w-72" disabled={busy}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="table_and_order">
                      {t('vision.movements.modeOrder')}
                    </SelectItem>
                    <SelectItem value="table_only">{t('vision.movements.modeTableOnly')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {t('vision.movements.modeHint')}
                </p>
              </div>
            )}

            {/* expandable rejection area */}
            {rejectOpen && (
              <div className="space-y-1.5 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
                <Label htmlFor={`reject-reason-${movement.id}`} className="text-xs">
                  {t('vision.movements.rejectReason')}
                </Label>
                <Input
                  id={`reject-reason-${movement.id}`}
                  className="h-11 bg-white"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    className="h-11"
                    disabled={busy}
                    onClick={() => setRejectOpen(false)}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-11 border-rose-300 text-rose-700 hover:bg-rose-100 hover:text-rose-700"
                    disabled={busy}
                    onClick={() => void submitReject()}
                  >
                    {rejectMutation.isPending && (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    )}
                    {t('vision.movements.rejectConfirm')}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {!rejectOpen && (
                <Button
                  variant="outline"
                  className="h-11 gap-1.5 border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                  disabled={busy}
                  onClick={() => setRejectOpen(true)}
                >
                  {t('vision.movements.reject')}
                  <ChevronDown className="size-4" aria-hidden />
                </Button>
              )}
              <Button
                className="h-11 gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
                disabled={busy}
                onClick={() => setConfirmOpen(true)}
              >
                {t('vision.movements.confirm')}
              </Button>
            </div>
          </div>
        )}

        {/* undo (confirmed + applied + order attached) */}
        {canUndo && (
          <div className="border-t border-stone-100 pt-3">
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              disabled={busy}
              onClick={() => setUndoOpen(true)}
            >
              <Undo2 className="size-4" aria-hidden />
              {t('vision.movements.undo')}
            </Button>
          </div>
        )}
      </CardContent>

      {/* ── confirm dialog ── */}
      <AlertDialog open={confirmOpen} onOpenChange={(o) => !busy && setConfirmOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vision.movements.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('vision.movements.confirmDesc', {
                people: movement.peopleCount,
                from: movement.fromTableName,
                to: movement.toTableName,
                order: orderPart,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void submitConfirm()
              }}
            >
              {confirmMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('vision.movements.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── undo dialog ── */}
      <AlertDialog open={undoOpen} onOpenChange={(o) => !busy && setUndoOpen(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('vision.movements.undoTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('vision.movements.undoDesc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault()
                void submitUndo()
              }}
            >
              {undoMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('vision.movements.undo')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
