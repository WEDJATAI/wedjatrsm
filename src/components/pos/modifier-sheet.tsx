'use client'

// ─── R8: item options sheet (POS) ───────────────────────────────────
// Opened when a waiter taps a product that HAS modifier groups: one
// section per group (radio behavior when maxSelect === 1, capped picks
// otherwise, minimums gate the Add button), a quantity stepper and a
// live line-total preview. Products without groups add instantly instead.

import { useMemo, useState } from 'react'
import { Check, Minus, Plus, SlidersHorizontal } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrency, formatQty } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { ModifierGroupDTO, Product, SelectedModifier } from '@/lib/types'
import { modifierDeltaLabel, round2 } from './pos-utils'

const MIN_QTY = 1
const MAX_QTY = 30
const MAX_COMMENT = 140

export type ModifierSheetSelection = {
  product: Product
  quantity: number
  modifiers: SelectedModifier[]
  /** R11: special-request comment ("extra sugar"…) — trimmed; goes into the
   *  draft line's notes so the kitchen + check see it like any note. */
  notes: string
}

type ModifierSheetProps = {
  open: boolean
  product: Product | null
  onOpenChange: (open: boolean) => void
  onConfirm: (selection: ModifierSheetSelection) => void
}

export default function ModifierSheet({
  open,
  product,
  onOpenChange,
  onConfirm,
}: ModifierSheetProps) {
  const { t, lang } = useI18n()
  // Fresh internal state per open: the parent keys this component by the
  // product id (remount = clean reset), so no reset effect is needed here.
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [quantity, setQuantity] = useState(1)
  // R11: free-text special request for this line (max 140 chars).
  const [comment, setComment] = useState('')

  const groups = useMemo<ModifierGroupDTO[]>(
    () =>
      (product?.modifierGroups ?? [])
        .filter((g) => g.active)
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [product],
  )
  const allOptions = useMemo(
    () => groups.flatMap((g) => g.modifiers.filter((m) => m.active)),
    [groups],
  )
  const selectedById = useMemo(() => {
    const map = new Map<number, SelectedModifier>()
    for (const opt of allOptions) {
      if (selectedIds.includes(opt.id)) {
        map.set(opt.id, {
          id: opt.id,
          name: opt.name,
          nameAr: opt.nameAr ?? null,
          priceDelta: round2(opt.priceDelta),
        })
      }
    }
    return map
  }, [allOptions, selectedIds])

  // ── Selection rules (enforced live) ───────────────────────────────
  const toggleOption = (group: ModifierGroupDTO, optionId: number) => {
    setSelectedIds((prev) => {
      if (prev.includes(optionId)) {
        return prev.filter((id) => id !== optionId)
      }
      const inGroup = group.modifiers.filter((m) => m.active).map((m) => m.id)
      const selectedInGroup = prev.filter((id) => inGroup.includes(id))
      if (group.maxSelect === 1) {
        // radio behavior — the previous pick of this group is replaced
        return [...prev.filter((id) => !inGroup.includes(id)), optionId]
      }
      if (selectedInGroup.length >= group.maxSelect) {
        return prev // cap reached — extra taps are ignored silently
      }
      return [...prev, optionId]
    })
  }

  // Minimums: total missing picks across required groups (Add disabled until 0).
  const missingMinimum = useMemo(() => {
    let missing = 0
    for (const g of groups) {
      const inGroup = g.modifiers.filter((m) => m.active).map((m) => m.id)
      const count = selectedIds.filter((id) => inGroup.includes(id)).length
      missing += Math.max(0, g.minSelect - count)
    }
    return missing
  }, [groups, selectedIds])

  const unitPrice = useMemo(() => {
    const delta = selectedIds.reduce((sum, id) => sum + (selectedById.get(id)?.priceDelta ?? 0), 0)
    return round2((product?.price ?? 0) + delta)
  }, [product, selectedIds, selectedById])
  const lineTotal = round2(unitPrice * quantity)

  const confirm = () => {
    if (!product || missingMinimum > 0) return
    // snapshot in group/option order (stable regardless of tap order)
    const ordered: SelectedModifier[] = []
    for (const g of groups) {
      for (const opt of g.modifiers) {
        if (!opt.active) continue
        const snap = selectedById.get(opt.id)
        if (snap) ordered.push(snap)
      }
    }
    onConfirm({ product, quantity: round2(quantity), modifiers: ordered, notes: comment.trim() })
  }

  const label = product ? localizedName(product.name, product.nameAr, lang) : ''
  const showEnglishHint = lang === 'ar' && product && label !== product.name
  const allergens = product?.allergens ?? []
  const dietary = product?.dietary ?? []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-5 text-primary" />
            <span className="truncate">{label}</span>
          </DialogTitle>
          <DialogDescription>
            <span className="font-semibold tabular-nums text-primary">
              {formatCurrency(product?.price ?? 0)}
            </span>
            {showEnglishHint && product && (
              <span className="ms-2 text-stone-400">{product.name}</span>
            )}
            {(allergens.length > 0 || dietary.length > 0) && (
              <span className="mt-2 flex flex-wrap gap-1">
                {allergens.map((a) => (
                  <Badge
                    key={`al-${a}`}
                    variant="outline"
                    className="border-rose-300 bg-rose-50 px-1.5 py-0 text-[10px] text-rose-700"
                  >
                    {t(`allergen.${a}`)}
                  </Badge>
                ))}
                {dietary.map((d) => (
                  <Badge
                    key={`dt-${d}`}
                    variant="outline"
                    className="border-emerald-300 bg-emerald-50 px-1.5 py-0 text-[10px] text-emerald-700"
                  >
                    {t(`dietary.${d}`)}
                  </Badge>
                ))}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {groups.length === 0 ? (
            <p className="py-2 text-center text-sm text-muted-foreground">
              {t('pos.noModsProduct')}
            </p>
          ) : (
            groups.map((group) => {
              const inGroup = group.modifiers.filter((m) => m.active)
              const meta =
                group.maxSelect === 1
                  ? t('pos.modPickOne')
                  : t('pos.modChooseUpTo', { n: group.maxSelect })
              const selectedInGroup = inGroup.filter((m) => selectedIds.includes(m.id)).length
              return (
                <section key={group.id} className="space-y-1.5">
                  <header className="flex flex-wrap items-center gap-1.5">
                    <h3 className="text-sm font-semibold">
                      {localizedName(group.name, group.nameAr, lang)}
                    </h3>
                    <Badge
                      variant="outline"
                      className={cn(
                        'px-1.5 py-0 text-[10px]',
                        group.minSelect > 0
                          ? 'border-rose-300 bg-rose-50 text-rose-700'
                          : 'text-muted-foreground',
                      )}
                    >
                      {group.minSelect > 0 ? t('pos.modRequired') : t('pos.modOptional')}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">{meta}</span>
                    {group.minSelect > 1 && selectedInGroup < group.minSelect && (
                      <span className="text-[11px] font-medium text-rose-600">
                        {t('pos.modChooseMin', { n: group.minSelect })}
                      </span>
                    )}
                  </header>
                  <div className="space-y-1.5">
                    {inGroup.map((opt) => {
                      const active = selectedIds.includes(opt.id)
                      const deltaLabel = modifierDeltaLabel(opt.priceDelta)
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggleOption(group, opt.id)}
                          className={cn(
                            'flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-start text-sm shadow-sm transition active:scale-[0.98]',
                            active
                              ? 'border-primary bg-primary/10 font-semibold text-primary'
                              : 'border-border bg-white text-stone-700 hover:border-primary/50 hover:bg-primary/[0.04]',
                          )}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className={cn(
                                'flex size-5 shrink-0 items-center justify-center rounded-full border',
                                active
                                  ? 'border-primary bg-primary text-white'
                                  : 'border-border bg-white',
                              )}
                              aria-hidden
                            >
                              {active && <Check className="size-3.5" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate">
                                {localizedName(opt.name, opt.nameAr, lang)}
                              </span>
                              {lang === 'ar' && opt.nameAr && opt.name !== opt.nameAr && (
                                <span className="block truncate text-[11px] text-stone-400">
                                  {opt.name}
                                </span>
                              )}
                            </span>
                          </span>
                          {deltaLabel && (
                            <span
                              className={cn(
                                'shrink-0 text-xs font-semibold tabular-nums',
                                opt.priceDelta > 0 ? 'text-emerald-700' : 'text-rose-600',
                              )}
                            >
                              {deltaLabel}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })
          )}

          {/* ── R11: special-request comment — one per line, so a commented
              item never merges into a plain one (notes break the merge rule) ── */}
          <div className="grid gap-1.5">
            <label htmlFor="modifier-comment" className="text-sm font-semibold">
              {t('pos.modCommentLabel')}
            </label>
            <Textarea
              id="modifier-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t('pos.modCommentPh')}
              maxLength={MAX_COMMENT}
              rows={2}
              className="min-h-11 resize-none rounded-xl border-border bg-white text-base"
            />
          </div>

          {/* ── Quantity + live line total ── */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-3">
            <span className="text-sm font-medium">{t('pos.modQty')}</span>
            <div className="flex items-center gap-2" role="group" aria-label={t('pos.modQty')}>
              <Button
                variant="outline"
                size="icon"
                className="size-11"
                disabled={quantity <= MIN_QTY}
                onClick={() => setQuantity((q) => Math.max(MIN_QTY, q - 1))}
              >
                <Minus />
                <span className="sr-only">−</span>
              </Button>
              <span className="w-10 text-center text-lg font-bold tabular-nums">
                {formatQty(quantity)}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-11"
                disabled={quantity >= MAX_QTY}
                onClick={() => setQuantity((q) => Math.min(MAX_QTY, q + 1))}
              >
                <Plus />
                <span className="sr-only">+</span>
              </Button>
            </div>
            <span className="text-end">
              <span className="block text-[11px] text-muted-foreground">{t('pos.modItemTotal')}</span>
              <span className="text-base font-bold tabular-nums text-primary">
                {formatCurrency(lineTotal)}
              </span>
            </span>
          </div>

          {missingMinimum > 0 && (
            <p className="text-xs font-medium text-rose-600" role="alert">
              {t('pos.modChooseMin', { n: missingMinimum })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" className="h-11 rounded-xl" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            className="h-11 rounded-xl bg-primary text-base font-semibold text-white hover:bg-primary/90"
            disabled={missingMinimum > 0}
            onClick={confirm}
          >
            <Plus className="size-4" />
            {t('pos.modAddFor', { price: formatCurrency(lineTotal) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
