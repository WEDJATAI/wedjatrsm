'use client'

import { useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import type { InventoryItem, Product } from '@/lib/types'
import { INVENTORY_REASON_LABELS } from '@/lib/constants'
import { formatQty } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/** What the InventoryView wants to adjust (a preset > 0 means "Restock" flow). */
export type InventoryAdjustTarget = {
  item: InventoryItem
  /** Positive prefill for the quantity field (also pre-selects the 'purchase' reason). */
  preset?: number
}

const ADJUST_REASONS = ['purchase', 'adjustment', 'waste'] as const
type AdjustReason = (typeof ADJUST_REASONS)[number]

const QUICK_CHANGES = [1, 5, 10, -1, -5]

export function InventoryAdjustDialog({
  target,
  onClose,
}: {
  target: InventoryAdjustTarget | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={target != null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-bold">
            {target?.item.name ?? 'Adjust stock'}
          </DialogTitle>
          <DialogDescription>
            Current stock:{' '}
            <span className="font-mono font-medium text-foreground">
              {target ? formatQty(target.item.stock) : '—'}
            </span>
            {target
              ? ` · threshold ${formatQty(target.item.lowStockThreshold)}`
              : null}
          </DialogDescription>
        </DialogHeader>

        {/* Keyed by product (and preset) so the form state resets on each open */}
        {target ? (
          <AdjustForm
            key={`${target.item.productId}-${target.preset ?? 0}`}
            target={target}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function AdjustForm({
  target,
  onClose,
}: {
  target: InventoryAdjustTarget
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const preset = target.preset ?? 0
  const [quantityChange, setQuantityChange] = useState(preset > 0 ? String(preset) : '0')
  const [reason, setReason] = useState<AdjustReason>(preset > 0 ? 'purchase' : 'adjustment')
  const [note, setNote] = useState('')

  const adjustMutation = useMutation({
    mutationFn: (vars: {
      productId: number
      quantityChange: number
      reason: AdjustReason
      note?: string
    }) =>
      apiFetch<{ product: Product }>('/api/inventory/adjust', {
        method: 'POST',
        body: vars,
      }),
    onSuccess: (data) => {
      toast.success(
        `${data.product.name} adjusted — stock is now ${formatQty(data.product.stock)}`,
      )
      void queryClient.invalidateQueries({ queryKey: ['inventory'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-value'] })
      void queryClient.invalidateQueries({ queryKey: ['inventory-transactions'] })
      onClose()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function applyQuick(delta: number) {
    const current = Number(quantityChange)
    const next = (Number.isFinite(current) ? current : 0) + delta
    setQuantityChange(String(next))
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const qty = Number(quantityChange)
    if (!Number.isFinite(qty) || qty === 0) {
      toast.error('Enter a non-zero quantity change')
      return
    }
    adjustMutation.mutate({
      productId: target.item.productId,
      quantityChange: qty,
      reason,
      note: note.trim() || undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="adjust-quantity">Quantity change</Label>
        <div className="flex flex-wrap gap-1.5">
          {QUICK_CHANGES.map((delta) => (
            <Button
              key={delta}
              type="button"
              variant="outline"
              size="sm"
              onClick={() => applyQuick(delta)}
            >
              {delta > 0 ? `+${delta}` : delta}
            </Button>
          ))}
        </div>
        <Input
          id="adjust-quantity"
          type="number"
          step="any"
          inputMode="decimal"
          value={quantityChange}
          onChange={(e) => setQuantityChange(e.target.value)}
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          positive = add stock · negative = remove
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="adjust-reason">Reason</Label>
        <Select value={reason} onValueChange={(v) => setReason(v as AdjustReason)}>
          <SelectTrigger id="adjust-reason" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ADJUST_REASONS.map((r) => (
              <SelectItem key={r} value={r}>
                {INVENTORY_REASON_LABELS[r] ?? r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="adjust-note">Note (optional)</Label>
        <Input
          id="adjust-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. supplier invoice #"
        />
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={adjustMutation.isPending}>
          {adjustMutation.isPending ? 'Saving…' : 'Save adjustment'}
        </Button>
      </div>
    </form>
  )
}
