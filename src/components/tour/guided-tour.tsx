'use client'

import { useCallback, useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Compass, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { isTourDone, markTourDone, subscribeTourControl } from './tour-bus'
import type { SessionUser } from '@/lib/types'

const STEPS = [1, 2, 3, 4, 5, 6, 7, 8] as const
const FIRST_RUN_DELAY_MS = 1200

/**
 * R13 P1 — guided first-run tour. Shows once per user (localStorage flag),
 * replayable from the navbar help button via the tour event bus. Content is
 * a compact card overlay (z-[90], below sonner toasts but above the app):
 * the goal is orientation, not a context-sensitive spotlight — keeping it
 * simple keeps it honest for shared terminals where the waiter just needs
 * the 60-second version.
 */
export default function GuidedTour({ user }: { user: SessionUser }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [step, setStep] = useState<number | null>(null)

  // First run: open shortly after the shell mounts (lets the splash and
  // the first view settle; a tour popping during load feels broken).
  useEffect(() => {
    if (isTourDone(user.id)) return
    const timer = setTimeout(() => setStep(1), FIRST_RUN_DELAY_MS)
    return () => clearTimeout(timer)
  }, [user.id])

  // Replay requests from the navbar help button (also re-arms on login as
  // a fresh session for a user who skipped earlier — explicit replay wins).
  useEffect(
    () =>
      subscribeTourControl(() => {
        setStep(1)
      }),
    [],
  )

  const close = useCallback(
    (finished: boolean) => {
      setStep(null)
      markTourDone(user.id)
      void queryClient.invalidateQueries() // future-proof; cheap no-op today
      if (finished && typeof window !== 'undefined') {
        // focus the main landmark so keyboard users land somewhere sane
        document.getElementById('rms-main')?.focus({ preventScroll: true })
      }
    },
    [queryClient, user.id],
  )

  // Escape closes the tour (keyboard a11y).
  useEffect(() => {
    if (step == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (step < STEPS.length) setStep(step + 1)
        else close(true)
      }
      if (e.key === 'ArrowLeft' && step > 1) setStep(step - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, close])

  if (step == null) return null
  const stepIndex = Math.min(Math.max(step, 1), STEPS.length)

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('tour.title')}
      onClick={(e) => {
        if (e.target === e.currentTarget) close(false)
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-white shadow">
            <Compass className="size-6" aria-hidden />
          </div>
          <button
            type="button"
            onClick={() => close(false)}
            aria-label={t('tour.skip')}
            className="grid size-9 place-items-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <h2 className="mt-4 text-lg font-bold text-stone-900">{t('tour.title')}</h2>
        <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
          {t('tour.stepOf', { n: stepIndex, m: STEPS.length })} · {t('tour.subtitle')}
        </p>

        <div className="mt-4 min-h-[120px] rounded-xl bg-stone-50 p-4">
          <p className="text-sm font-semibold text-primary">{t(`tour.s${stepIndex}.title`)}</p>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
            {t(`tour.s${stepIndex}.body`)}
          </p>
        </div>

        {/* progress dots */}
        <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
          {STEPS.map((s) => (
            <span
              key={s}
              className={cn(
                'h-1.5 rounded-full transition-all',
                s === stepIndex ? 'w-5 bg-primary' : s < stepIndex ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-stone-200',
              )}
            />
          ))}
        </div>

        <div className="mt-5 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => close(false)}
            className="h-11 flex-1 text-stone-500 hover:text-stone-700"
          >
            {t('tour.skip')}
          </Button>
          {stepIndex > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(stepIndex - 1)}
              className="h-11 border-border px-5"
            >
              {t('tour.back')}
            </Button>
          )}
          <Button
            type="button"
            onClick={() => (stepIndex < STEPS.length ? setStep(stepIndex + 1) : close(true))}
            className="h-11 flex-1 bg-primary px-5 font-semibold text-white hover:bg-primary/90"
          >
            {stepIndex < STEPS.length ? t('tour.next') : t('tour.done')}
          </Button>
        </div>
      </div>
    </div>
  )
}
