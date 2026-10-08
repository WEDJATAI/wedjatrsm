'use client'

// ─── Idle session timeout watcher ────────────────────────────────────
// Shared POS/KDS terminals must not stay signed in unattended: after
// IDLE_WARN_AFTER_MS (15 min) without input a warning dialog appears with
// a IDLE_LOGOUT_SECONDS countdown (60s); "Stay signed in" resets the timer,
// otherwise the session is ended through the app's logout handler.
// Debug/E2E: appending ?idleTest=1 to the URL shortens both to 10s.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Hourglass } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  IDLE_LOGOUT_SECONDS,
  IDLE_TEST_LOGOUT_SECONDS,
  IDLE_TEST_WARN_MS,
  IDLE_WARN_AFTER_MS,
} from '@/lib/constants'
import { useI18n } from '@/lib/i18n'

const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
]

export function IdleLogoutWatcher({ onLogout }: { onLogout: () => void }) {
  const { t } = useI18n()
  const [warnOpen, setWarnOpen] = useState(false)
  const [countdown, setCountdown] = useState(IDLE_LOGOUT_SECONDS)

  const lastActivityRef = useRef<number>(Date.now())
  const warnOpenRef = useRef(false)
  const logoutHandledRef = useRef(false)

  // Debug override (?idleTest=1) is read once at mount.
  const warnMsRef = useRef(IDLE_WARN_AFTER_MS)
  const countdownSecRef = useRef(IDLE_LOGOUT_SECONDS)
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).has('idleTest')) {
        warnMsRef.current = IDLE_TEST_WARN_MS
        countdownSecRef.current = IDLE_TEST_LOGOUT_SECONDS
      }
    } catch {
      // no window/query — defaults stay
    }
  }, [])

  const resetActivity = useCallback(() => {
    lastActivityRef.current = Date.now()
  }, [])

  const staySignedIn = useCallback(() => {
    resetActivity()
    warnOpenRef.current = false
    setWarnOpen(false)
  }, [resetActivity])

  // Track user activity (passive listeners; no re-render on events).
  useEffect(() => {
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetActivity, { passive: true })
    }
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetActivity)
      }
    }
  }, [resetActivity])

  // Ticker: opens the warning after the idle threshold, then counts down
  // to an automatic logout. Any activity while the dialog is open only
  // refreshes the timestamp — the user must confirm "Stay signed in".
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (logoutHandledRef.current) return
      const idleFor = Date.now() - lastActivityRef.current
      if (!warnOpenRef.current) {
        if (idleFor >= warnMsRef.current) {
          warnOpenRef.current = true
          setCountdown(countdownSecRef.current)
          setWarnOpen(true)
        }
        return
      }
      setCountdown((left) => {
        if (left <= 1) {
          logoutHandledRef.current = true
          toast.info(t('idle.signedOutToast'))
          onLogout()
          return 0
        }
        return left - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [onLogout, t])

  // Reset the one-shot guard when re-mounted after a logout/login cycle.
  useEffect(() => {
    logoutHandledRef.current = false
  }, [])

  return (
    <Dialog open={warnOpen} onOpenChange={(open) => !open && staySignedIn()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hourglass className="size-5 text-amber-600" aria-hidden />
            {t('idle.warningTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('idle.warningDesc', { seconds: countdown })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onLogout}>
            {t('idle.logoutNow')}
          </Button>
          <Button
            className="bg-amber-600 text-white hover:bg-amber-700"
            onClick={staySignedIn}
          >
            {t('idle.stay')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
