'use client'

// ─── R27: Change the manager's PIN (the super admin's own number) ────
// One dialog, two moments:
//   · FIRST TIME — he just signed in with the starting PIN 123456 and
//     the app asks him to make it his own (skippable, but the banner
//     stays on his launcher until he does);
//   · ANY TIME — the "Change my PIN" button on his launcher hero.
// Server-side: only the super admin may call POST /api/auth/manager-pin
// and he must prove the current PIN first.

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

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
import { apiFetch } from '@/lib/api'
import { sndSuccess, haptic } from '@/lib/feedback'
import { useI18n } from '@/lib/i18n'

const PIN_RE = /^\d{6}$/

export function ManagerPinDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [currentPin, setCurrentPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // fresh slate every time the door opens
  useEffect(() => {
    if (open) {
      setCurrentPin('')
      setNewPin('')
      setConfirmPin('')
      setError(null)
      setLoading(false)
    }
  }, [open])

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (loading) return
    // client-side validation mirrors the server exactly
    if (!PIN_RE.test(currentPin)) {
      setError(t('manager.currentPinInvalid'))
      return
    }
    if (!PIN_RE.test(newPin)) {
      setError(t('auth.registerPinInvalid'))
      return
    }
    if (newPin !== confirmPin) {
      setError(t('auth.registerPinMismatch'))
      return
    }
    if (newPin === currentPin) {
      setError(t('manager.sameAsOld'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      await apiFetch('/api/auth/manager-pin', {
        body: { currentPin, newPin, confirmPin },
      })
      sndSuccess()
      haptic(18)
      toast.success(t('manager.pinChanged'))
      // refresh the manager status (kills the default-PIN banner)
      await queryClient.invalidateQueries({ queryKey: ['manager-status'] })
      onOpenChange(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('error.generic')
      setError(message)
      toast.error(message)
      setCurrentPin('')
    } finally {
      setLoading(false)
    }
  }

  const pinField = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    autoFocus?: boolean,
  ) => (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        dir="ltr"
        placeholder="••••••"
        className="h-12 text-center font-mono text-lg tracking-[0.35em]"
        maxLength={6}
        value={value}
        autoFocus={autoFocus}
        disabled={loading}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          onChange(e.target.value.replace(/\D/g, '').slice(0, 6))
          if (error) setError(null)
        }}
      />
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="grid size-9 place-items-center rounded-lg bg-amber-100 text-amber-700">
              <KeyRound className="size-4.5" aria-hidden />
            </span>
            {t('manager.changePinTitle')}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <ShieldCheck className="size-3.5 shrink-0 text-amber-600" aria-hidden />
            {t('manager.changePinSub')}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={submit} noValidate>
          {pinField('mgr-cur-pin', t('manager.currentPin'), currentPin, setCurrentPin, true)}
          <div className="grid grid-cols-2 gap-3">
            {pinField('mgr-new-pin', t('manager.newPin'), newPin, setNewPin)}
            {pinField('mgr-confirm-pin', t('auth.registerPinConfirm'), confirmPin, setConfirmPin)}
          </div>

          {error && (
            <div
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {t('manager.later')}
            </Button>
            <Button
              type="submit"
              className="h-11 bg-amber-600 text-white hover:bg-amber-700"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t('manager.savingPin')}
                </>
              ) : (
                <>
                  <ShieldCheck className="size-4" aria-hidden />
                  {t('manager.savePin')}
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
