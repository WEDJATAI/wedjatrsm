'use client'

// ─── r32: Revoke payment dialog — cashier PIN + reason ───────────────
// Opened from the receipt modal right after a payment (and anywhere a paid
// order needs its payment voided). Authorization = the cashier's own 6-digit
// PIN (users.pin, same as check-in); the reason is mandatory and lands in
// the activity log. Server-side: /api/orders/[id]/revoke.

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Ban, Loader2 } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { formatCurrency } from '@/lib/format'
import { PinPadGrid } from '@/components/pos/pin-pad'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Order } from '@/lib/types'

const REASON_MAX = 140

type RevokeDialogProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  /** fired after a successful revoke (order is now status 'revoked') */
  onRevoked?: (order: Order) => void
}

export function RevokeDialog({ order, open, onOpenChange, onRevoked }: RevokeDialogProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [pinError, setPinError] = useState(false)

  // fresh state whenever the dialog re-opens (render-time, no effect)
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setReason('')
      setPin('')
      setPinError(false)
    }
  }

  const revokeMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ order: Order; revoke: { amount: number; method: string; reason: string; revokedBy: string } }>(
        `/api/orders/${order.id}/revoke`,
        { method: 'POST', body: { pin, reason: reason.trim() } },
      ),
    onSuccess: async (data) => {
      toast.success(
        t('pos.revokeDoneToast', {
          id: order.id,
          amount: formatCurrency(data.revoke.amount),
          by: data.revoke.revokedBy,
        }),
      )
      onOpenChange(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      ])
      onRevoked?.(data.order)
    },
    onError: (err: Error) => {
      if (/PIN/i.test(err.message)) {
        setPinError(true)
        setPin('')
      }
      toast.error(err.message)
    },
  })

  const canConfirm = reason.trim().length > 0 && pin.length >= 6 && !revokeMutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-10 place-items-center rounded-xl bg-destructive/10 text-destructive">
              <Ban className="size-5" aria-hidden />
            </span>
            {t('pos.revokeTitle')}
          </DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t('pos.revokeDescription', {
              order: order.id,
              table: order.table?.name ?? t('common.takeaway'),
              amount: formatCurrency(order.paidAmount),
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="revoke-reason">{t('pos.revokeReasonLabel')}</Label>
          <Textarea
            id="revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
            placeholder={t('pos.revokeReasonPlaceholder')}
            className="min-h-20 rounded-xl"
            dir="auto"
            maxLength={REASON_MAX}
            aria-required
          />
          <p
            className={cn(
              'text-end text-xs tabular-nums',
              reason.length >= REASON_MAX ? 'font-semibold text-destructive' : 'text-muted-foreground',
            )}
          >
            {reason.length}/{REASON_MAX}
          </p>
        </div>

        <div className="grid gap-2">
          <Label>{t('pos.revokePinLabel')}</Label>
          <PinPadGrid
            value={pin}
            onChange={(next) => {
              setPin(next)
              setPinError(false)
            }}
            error={pinError}
            disabled={revokeMutation.isPending}
          />
          <p className="text-center text-xs text-muted-foreground" dir="auto">
            {t('pos.revokeHint')}
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            className="h-11 rounded-xl"
            onClick={() => onOpenChange(false)}
            disabled={revokeMutation.isPending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            className="h-11 rounded-xl font-semibold"
            disabled={!canConfirm}
            onClick={() => revokeMutation.mutate()}
          >
            {revokeMutation.isPending ? <Loader2 className="animate-spin" /> : <Ban className="size-4" />}
            {t('pos.revokeConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
