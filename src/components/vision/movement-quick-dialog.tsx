'use client'

// ─── MovementQuickDialog — compact AI-suggestion review ──────────────
// Shared by the vision Overview floor tiles AND the POS table-select
// floor chips. Renders the suggestion summary + evidence, the mandatory
// "AI suggestion — human confirmation required" banner, and (when an
// order is attached) the apply-mode select. Decisions go through the
// shared useMovementDecisions hook so invalidations match the Movements
// tab exactly. Never styles the AI inference as verified fact.

import { useState } from 'react'
import { ArrowRight, Loader2, Sparkles, TriangleAlert, Users } from 'lucide-react'

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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency, formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { MovementCandidateDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

import { useMovementDecisions, type MovementMode } from './movement-actions'
import { confidenceClass, formatConfidence, movementStatusClass } from './vision-utils'

export type MovementQuickDialogProps = {
  movement: MovementCandidateDTO | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** called after a decision was applied (or the dialog should close) */
  onDone: () => void
}

export default function MovementQuickDialog({
  movement,
  open,
  onOpenChange,
  onDone,
}: MovementQuickDialogProps) {
  const { t } = useI18n()
  const { confirmMutation, rejectMutation } = useMovementDecisions()
  const [mode, setMode] = useState<MovementMode>('table_and_order')
  const [lastId, setLastId] = useState<number | null>(movement?.id ?? null)

  // Reset the apply-mode whenever a different suggestion is opened (the
  // "adjust state during render" pattern — no setState-in-effect).
  if (movement && movement.id !== lastId) {
    setLastId(movement.id)
    setMode('table_and_order')
  }

  if (!movement) return null

  const pending = movement.status === 'pending'
  const busy = confirmMutation.isPending || rejectMutation.isPending
  const hasOrder = movement.orderId != null
  // Live-state guard: the order must still sit on the source table for a
  // "move table + order" to make sense — surface the mismatch loudly.
  const orderNotOnFrom = hasOrder && movement.currentState.orderTableId != null && movement.currentState.orderTableId !== movement.fromTableId

  const decide = async (action: 'confirm' | 'reject') => {
    if (!movement) return
    try {
      if (action === 'confirm') {
        await confirmMutation.mutateAsync({
          id: movement.id,
          mode: hasOrder ? mode : 'table_only',
        })
      } else {
        await rejectMutation.mutateAsync({ id: movement.id })
      }
      onDone()
    } catch {
      // errors already toasted inside the mutation; keep the dialog open
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex flex-wrap items-center gap-2">
            {t('vision.movements.reviewTitle')}
            <Badge variant="outline" className={movementStatusClass(movement.status)}>
              {t(`vision.movements.status.${movement.status}`)}
            </Badge>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 pt-1">
              {/* Route */}
              <p className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">
                <span className="tabular-nums">{movement.fromTableName}</span>
                <ArrowRight className="size-4 shrink-0 rtl:rotate-180" aria-hidden />
                <span className="tabular-nums">{movement.toTableName}</span>
                <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
                  <Users className="size-3.5" aria-hidden />
                  {t('vision.movements.guests', { n: movement.peopleCount })}
                </span>
              </p>

              {/* Mandatory AI banner — never present inference as fact */}
              <p
                role="note"
                className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800"
              >
                <Sparkles className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t('vision.movements.aiBanner')}
              </p>

              {/* Facts grid */}
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <p>
                  <span className="font-medium text-foreground">{t('vision.movements.detected')}: </span>
                  <span className="tabular-nums">
                    {formatTime(movement.detectedAt)} · {t('vision.movements.confidence')}{' '}
                    <span className={cn('rounded border px-1 py-0.5', confidenceClass(movement.confidence))}>
                      {formatConfidence(movement.confidence)}
                    </span>
                  </span>
                </p>
                <p>
                  <span className="font-medium text-foreground">{t('vision.movements.order')}: </span>
                  {hasOrder ? (
                    <span className="tabular-nums">
                      #{movement.orderId}
                      {movement.orderTotal != null ? ` · ${formatCurrency(movement.orderTotal)}` : ''}
                    </span>
                  ) : (
                    t('vision.movements.noOrder')
                  )}
                </p>
                {movement.evidence && (
                  <p className="col-span-2">
                    <span className="font-medium text-foreground">{t('vision.movements.evidence')}: </span>
                    {t('vision.movements.evidenceDetail', {
                      camera: movement.evidence.cameraCode ?? '—',
                      n: movement.evidence.eventIds.length,
                    })}
                  </p>
                )}
              </div>

              {orderNotOnFrom && (
                <p
                  className="flex items-center gap-2 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"
                  role="alert"
                >
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                  {t('vision.movements.orderNotOnFrom')}
                </p>
              )}

              {/* Apply mode (order attached) */}
              {pending && hasOrder && (
                <div className="space-y-1.5">
                  <Label htmlFor={`ai-move-mode-${movement.id}`} className="text-xs">
                    {t('vision.movements.mode')}
                  </Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as MovementMode)}>
                    <SelectTrigger
                      id={`ai-move-mode-${movement.id}`}
                      className="h-11 w-full"
                      disabled={busy}
                    >
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
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {pending ? (
            <>
              <AlertDialogCancel
                disabled={busy}
                className="border-rose-300 text-rose-700 hover:bg-rose-50 hover:text-rose-700"
                onClick={(e) => {
                  e.preventDefault()
                  void decide('reject')
                }}
              >
                {rejectMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {t('vision.movements.reject')}
              </AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={(e) => {
                  e.preventDefault()
                  void decide('confirm')
                }}
              >
                {confirmMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {t('vision.movements.confirm')}
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogCancel>{t('common.close')}</AlertDialogCancel>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
