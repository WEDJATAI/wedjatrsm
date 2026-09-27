'use client'

// ─── R27: Manager sign-in — the ONE super admin's private door ───────
// The Team Wall's "Manager sign-in" corner opens Dr Ihab's personal
// screen: a warm welcome by name, then ONLY his 6-digit PIN (first
// time: 123456 — he sets his own the moment he lands in the app).
// His PIN never works on the staff doors, and no staff PIN opens this.
//
// Design language: the Team Wall (big avatar, warm colors, bilingual,
// shake on wrong PIN) with the shared 6-digit keypad from LoginView.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  LogIn,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { fetcher, apiFetch, setSessionToken } from '@/lib/api'
import { sndDigit, sndError, sndSuccess, haptic } from '@/lib/feedback'
import { useI18n } from '@/lib/i18n'
import type { SessionUser } from '@/lib/types'
import { useAppSettings } from '@/lib/use-settings'
import LoginView, { PinKeypad, MANAGER_PIN_LENGTH } from './login-view'

type ManagerStatus = {
  /** the manager's display name (null when the account is disabled) */
  name: string | null
  /** still on the first-time PIN (123456) → show the welcome hint */
  usingDefaultPin: boolean
}

type ManagerLoginResponse = {
  user: SessionUser
  usingDefaultPin: boolean
  token?: string
}

export default function ManagerSignIn({
  onLogin,
  onBackToWall,
}: {
  onLogin: () => void
  onBackToWall: () => void
}) {
  const { t } = useI18n()
  const { restaurantName } = useAppSettings()

  // ── who is the manager? (greeting comes from the server) ─────────
  const statusQuery = useQuery({
    queryKey: ['manager-status'],
    queryFn: () => fetcher<ManagerStatus>('/api/auth/manager-login'),
    staleTime: 30_000,
  })
  const managerName = statusQuery.data?.name
  const usingDefaultPin = statusQuery.data?.usingDefaultPin ?? false

  // ── classic sign-in escape hatch (email / demo / registration) ────
  const [showClassic, setShowClassic] = useState(false)
  // ── PIN state ─────────────────────────────────────────────────────
  const [pin, setPin] = useState('')
  const [pinLoading, setPinLoading] = useState(false)
  const [pinError, setPinError] = useState(false)
  const [shake, setShake] = useState(false)
  const shakeTimer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    }
  }, [])

  const triggerShake = useCallback(() => {
    setShake(true)
    sndError()
    haptic([30, 60, 30])
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    shakeTimer.current = window.setTimeout(() => {
      setShake(false)
      shakeTimer.current = null
    }, 500)
  }, [])

  const submitPin = useCallback(
    async (value: string) => {
      setPinLoading(true)
      try {
        const res = await apiFetch<ManagerLoginResponse>('/api/auth/manager-login', {
          body: { pin: value },
        })
        if (res.token) setSessionToken(res.token)
        sndSuccess()
        haptic(18)
        toast.success(t('auth.welcomeBack', { name: res.user.name }))
        onLogin()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
        setPin('')
        setPinError(true)
        triggerShake()
      } finally {
        setPinLoading(false)
      }
    },
    [onLogin, t, triggerShake],
  )

  const pressDigit = useCallback(
    (digit: string) => {
      if (pinLoading) return
      const next = (pin + digit).slice(0, MANAGER_PIN_LENGTH)
      setPin(next)
      setPinError(false)
      sndDigit()
      haptic(6)
      if (next.length === MANAGER_PIN_LENGTH) void submitPin(next)
    },
    [pin, pinLoading, submitPin],
  )

  const backspacePin = useCallback(() => {
    setPin((p) => p.slice(0, -1))
  }, [])

  const clearPin = useCallback(() => {
    setPin('')
    setPinError(false)
  }, [])

  // ── physical keyboard (digits / backspace / escape) ───────────────
  const handlersRef = useRef({ press: pressDigit, back: backspacePin, clear: clearPin })
  useEffect(() => {
    handlersRef.current = { press: pressDigit, back: backspacePin, clear: clearPin }
  })
  useEffect(() => {
    if (showClassic) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.repeat) return
      if (/^[0-9]$/.test(e.key)) handlersRef.current.press(e.key)
      else if (e.key === 'Backspace') handlersRef.current.back()
      else if (e.key === 'Escape') handlersRef.current.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showClassic])

  // ── classic sign-in card (email / demo / self-registration) ──────
  if (showClassic) {
    return <LoginView onLogin={onLogin} onBackToWall={() => setShowClassic(false)} />
  }

  const initials = (managerName ?? '?')
    .trim()
    .split(/\s+/)
    .map((p) => p.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className="grid min-h-screen w-full place-items-center bg-background p-4 sm:p-6">
      {/* Shake animation (wrong PIN) */}
      <style>{`
        @keyframes rmsShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
        .rms-shake { animation: rmsShake 0.45s ease; }
        @keyframes rmsPop { 0% { transform: scale(0.6); opacity: 0; } 70% { transform: scale(1.08); } 100% { transform: scale(1); opacity: 1; } }
        .rms-pop { animation: rmsPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
      `}</style>

      <div className="flex w-full max-w-md flex-col">
        <div className="bg-card flex w-full flex-col gap-6 rounded-2xl border p-6 shadow-lg sm:p-8">
          {/* back to the wall */}
          <button
            type="button"
            onClick={onBackToWall}
            className="flex min-h-8 w-fit items-center gap-1.5 self-start rounded text-xs font-semibold text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
            {t('wall.backToWall')}
          </button>

          {statusQuery.isError ? (
            /* server unreachable — retry */
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <p className="text-sm font-semibold text-destructive">{t('auth.loginFailed')}</p>
              <button
                type="button"
                onClick={() => void statusQuery.refetch()}
                className="min-h-11 rounded-lg border px-4 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('wall.retry')}
              </button>
            </div>
          ) : (
            <>
              {/* ── Welcome header — the manager, by name ── */}
              <div className="flex flex-col items-center gap-3 text-center">
                <span
                  className="rms-pop grid size-20 place-items-center rounded-full bg-gradient-to-br from-amber-500 via-orange-500 to-rose-600 text-2xl font-black text-white shadow-lg sm:size-24 sm:text-3xl"
                  aria-hidden
                >
                  {statusQuery.isLoading ? (
                    <Loader2 className="size-8 animate-spin text-white/80" />
                  ) : (
                    initials
                  )}
                </span>
                <div className="space-y-1.5">
                  <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl">
                    {t('wall.welcomeManager', { name: managerName ?? t('wall.manager') })}
                  </h1>
                  <Badge
                    variant="outline"
                    className="gap-1.5 border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800"
                  >
                    <ShieldCheck className="size-3.5" aria-hidden />
                    {t('manager.superAdmin')}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">{t('wall.managerPinOnly')}</p>
              </div>

              {/* ── first-time hint (only while on the default PIN) ── */}
              {usingDefaultPin && (
                <div
                  className="flex items-start gap-2.5 rounded-xl border border-amber-300/70 bg-amber-50 p-3.5 text-sm text-amber-900"
                  role="note"
                >
                  <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="leading-relaxed">{t('manager.defaultPinHint')}</span>
                </div>
              )}

              {/* ── the keypad — the only thing between him and his desk ── */}
              <PinKeypad
                value={pin}
                loading={pinLoading}
                error={pinError}
                shake={shake}
                loadingLabel={t('auth.signingIn')}
                onDigit={pressDigit}
                onBackspace={backspacePin}
                onClear={clearPin}
              />

              {/* ── classic sign-in options (email / demo / register) ── */}
              <button
                type="button"
                onClick={() => setShowClassic(true)}
                className="mx-auto flex min-h-8 items-center gap-1.5 rounded text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <KeyRound className="size-3.5" aria-hidden />
                {t('manager.moreOptions')}
              </button>
            </>
          )}
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
          <LogIn className="size-3 opacity-60 rtl:rotate-180" aria-hidden />
          {restaurantName} · {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
