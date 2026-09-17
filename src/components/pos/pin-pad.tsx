'use client'

// R10: Premium 6-digit PIN entry — the shared security gate for sensitive
// POS actions (item deletion, item moves between checks, manager discounts).
//
// Two exports:
//  · `PinPadGrid`  — the embedded keypad + digit display (composable; usable
//                    inside another dialog, e.g. the discount approval card).
//  · `PinDialog`   — a ready-made Dialog wrapper (icon + title + description
//                    + keypad + Cancel/Confirm) used by the cart panel for
//                    delete + move gates.
//
// Design language: Odoo plum accents on white, large ≥44px touch targets,
// tabular-nums, subtle press feedback (active:scale-95), wrong-PIN shake
// (.pin-shake keyframes in globals.css). The 6th digit auto-fires onFull
// (edge-triggered from the append handler — no effects, no double-fires).

import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Delete, Loader2, ShieldAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DELETE_PIN_LENGTH } from '@/lib/constants'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

// ── Keypad ──────────────────────────────────────────────────────────
// 1-9, backspace, 0, clear — the classic POS numeric layout.

const KEYS: Array<{ kind: 'digit'; d: string } | { kind: 'back' } | { kind: 'clear' }> = [
  { kind: 'digit', d: '1' },
  { kind: 'digit', d: '2' },
  { kind: 'digit', d: '3' },
  { kind: 'digit', d: '4' },
  { kind: 'digit', d: '5' },
  { kind: 'digit', d: '6' },
  { kind: 'digit', d: '7' },
  { kind: 'digit', d: '8' },
  { kind: 'digit', d: '9' },
  { kind: 'back' },
  { kind: 'digit', d: '0' },
  { kind: 'clear' },
]

type PinPadGridProps = {
  /** Current PIN digits (parent-owned state — the grid is controlled). */
  value: string
  onChange: (next: string) => void
  /** Fires once when the PIN reaches full length (edge-triggered). */
  onFull?: (pin: string) => void
  /** Wrong-PIN feedback: shakes the digit row + marks it rose. */
  error?: boolean
  /** Disables the keys (e.g. while the gated mutation is pending). */
  disabled?: boolean
  /** Hide the on-screen keypad (digit boxes only — e.g. inline compact use). */
  hideKeypad?: boolean
}

export function PinPadGrid({
  value,
  onChange,
  onFull,
  error = false,
  disabled = false,
  hideKeypad = false,
}: PinPadGridProps) {
  const { t } = useI18n()
  const length = DELETE_PIN_LENGTH

  const append = (d: string) => {
    if (disabled) return
    const next = (value + d).replace(/\D/g, '').slice(0, length)
    onChange(next)
    if (next.length === length) onFull?.(next)
  }

  const backspace = () => {
    if (disabled) return
    onChange(value.slice(0, -1))
  }

  const clear = () => {
    if (disabled) return
    onChange('')
  }

  return (
    <div className="space-y-4">
      {/* Digit display — filled slots show a dot (privacy), the row shakes
          and turns rose while `error` is set; key changes re-run the shake
          so consecutive wrong attempts re-animate. */}
      <div
        key={`${error}-${value.length}`}
        className={cn(
          'flex items-center justify-center gap-2',
          error && 'pin-shake',
        )}
        role="group"
        aria-label={t('pos.pinDisplayAria', { n: value.length })}
      >
        {Array.from({ length }, (_, i) => {
          const filled = i < value.length
          return (
            <span
              key={i}
              aria-hidden
              className={cn(
                'flex h-12 w-10 items-center justify-center rounded-lg border-2 transition-all duration-150',
                filled
                  ? error
                    ? 'border-destructive bg-destructive/10'
                    : 'border-[#714B67] bg-[#714B67]/10'
                  : 'border-[#E2E2E0] bg-white',
                i === value.length && !disabled && !error && 'border-[#714B67]/40',
              )}
            >
              {filled && (
                <span
                  className={cn(
                    'size-3 rounded-full',
                    error ? 'bg-destructive' : 'bg-[#714B67]',
                  )}
                />
              )}
            </span>
          )
        })}
      </div>
      {error && (
        <p
          className="text-center text-sm font-medium text-destructive"
          role="alert"
        >
          {t('pos.pinWrong')}
        </p>
      )}

      {!hideKeypad && (
        /* On-screen keypad — 3×4 grid, big touch targets, press feedback. */
        <div className="mx-auto grid max-w-[16rem] grid-cols-3 gap-2">
          {KEYS.map((key, i) => {
            if (key.kind === 'digit') {
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={() => append(key.d)}
                  className={cn(
                    'h-14 rounded-xl border-2 border-[#E2E2E0] bg-white text-xl font-semibold tabular-nums text-stone-700 transition active:scale-95',
                    'hover:border-[#714B67]/50 hover:bg-[#714B67]/[0.04]',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  {key.d}
                </button>
              )
            }
            if (key.kind === 'back') {
              return (
                <button
                  key={i}
                  type="button"
                  disabled={disabled}
                  onClick={backspace}
                  aria-label={t('pos.pinBackAria')}
                  title={t('pos.pinBackAria')}
                  className={cn(
                    'flex h-14 items-center justify-center rounded-xl border-2 border-[#E2E2E0] bg-white text-stone-500 transition active:scale-95',
                    'hover:border-[#714B67]/50 hover:bg-[#714B67]/[0.04]',
                    'disabled:cursor-not-allowed disabled:opacity-40',
                  )}
                >
                  <Delete className="size-5" aria-hidden />
                </button>
              )
            }
            return (
              <button
                key={i}
                type="button"
                disabled={disabled}
                onClick={clear}
                className={cn(
                  'h-14 rounded-xl border-2 border-[#E2E2E0] bg-white text-xs font-semibold uppercase tracking-wide text-stone-500 transition active:scale-95',
                  'hover:border-[#714B67]/50 hover:bg-[#714B67]/[0.04]',
                  'disabled:cursor-not-allowed disabled:opacity-40',
                )}
              >
                {t('common.clear')}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Dialog wrapper ──────────────────────────────────────────────────

type PinDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Dialog heading (already translated). */
  title: string
  /** Supporting line, e.g. "Enter the 6-digit PIN to remove Koshari…". */
  description?: string
  /** Hero icon — defaults to ShieldAlert. */
  icon?: LucideIcon
  /** Confirm-button label (already translated). */
  confirmLabel: string
  /** Destructive styling for the confirm button (item deletion). */
  destructive?: boolean
  /** Fired with the 6-digit PIN on Confirm OR when the 6th digit lands. */
  onConfirm: (pin: string) => void
  /** While true: keypad + buttons disable, confirm shows a spinner. */
  pending?: boolean
  /** Wrong-PIN feedback — dialog stays open, digits shake. */
  error?: boolean
}

export function PinDialog({
  open,
  onOpenChange,
  title,
  description,
  icon: Icon = ShieldAlert,
  confirmLabel,
  destructive = false,
  onConfirm,
  pending = false,
  error = false,
}: PinDialogProps) {
  const { t } = useI18n()
  const [pin, setPin] = useState('')

  // Fresh digits whenever the dialog re-opens (render-time adjustment —
  // no effect needed). A wrong attempt (error true) also wipes the digits
  // so each retry starts clean — the dialog stays open, the row shakes.
  const [wasOpen, setWasOpen] = useState(false)
  const [wasError, setWasError] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    setPin('')
  }
  if (error !== wasError) {
    setWasError(error)
    if (error) {
      setPin('')
    }
  }

  // The error visuals only show while the digits are empty (i.e. right
  // after a wrong attempt) — typing a fresh PIN returns to normal styling
  // even if the parent has not cleared `error` yet.
  const showError = error && pin.length === 0

  const submit = (value: string) => {
    if (value.length < DELETE_PIN_LENGTH || pending) return
    onConfirm(value)
  }

  // The 6th keystroke fires onFull from the append handler; keys disable
  // while `pending`, so no double submission can occur.
  const handleFull = (value: string) => submit(value)

  const handleConfirm = () => submit(pin)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={cn('size-5', destructive ? 'text-destructive' : 'text-[#714B67]')} />
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <PinPadGrid
          value={pin}
          onChange={(next) => {
            setPin(next)
          }}
          onFull={handleFull}
          error={showError}
          disabled={pending}
        />

        <DialogFooter>
          <Button
            variant="outline"
            className="h-11 rounded-xl"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            className={cn(
              'h-11 rounded-xl font-semibold',
              !destructive && 'bg-[#714B67] text-white hover:bg-[#714B67]/90',
            )}
            onClick={handleConfirm}
            disabled={pending || pin.length < DELETE_PIN_LENGTH}
          >
            {pending ? <Loader2 className="animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
