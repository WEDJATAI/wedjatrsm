'use client'

// ─── R24 Team Wall — zero-reading sign-in & attendance kiosk ─────────
// The new DEFAULT pre-auth screen, designed for floor staff who may not
// read fluently (COO creative brief):
//   1. WALL      — big colorful face cards (initials + role icon + live
//                  green dot). Recognition instead of typing/spelling.
//   2. PIN       — giant keypad, audio tick + haptic per digit.
//   3. ACTION    — ONE giant decision per screen: START WORK (green) or
//                  FINISH WORK (red) with a live ticking hours counter.
//   4. CELEBRATE — full-screen success (chime), auto-returns to the wall.
// Plus “MY SCREEN” for POS/KDS roles (reuses the already-verified PIN)
// and a tucked-away Manager corner that renders the classic LoginView.
// All labels are bilingual (EN + Egyptian Arabic) and icon-led.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Briefcase,
  Check,
  ChefHat,
  ConciergeBell,
  Delete,
  Languages,
  Loader2,
  LogIn,
  Moon,
  ShieldCheck,
  Smartphone,
  Sun,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { apiFetch, fetcher, setSessionToken } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { SessionUser } from '@/lib/types'
import { useAppSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import LoginView from '@/components/auth/login-view'

const PIN_LENGTH = 6

// ── API shapes ────────────────────────────────────────────────────────
type WallUser = {
  id: number
  name: string
  role: string
  roleLabel: string
  roleName: string | null
  canUseApp: boolean
  onShift: boolean
  checkedInAt: string | null
}
type WallRoster = { team: WallUser[]; onShiftCount: number }
type WallShift = { id: number; name: string; startTime: string; endTime: string }
type WallStatus = {
  ok: true
  user: { id: number; name: string; role: string; roleLabel: string; roleName: string | null }
  onShift: boolean
  checkedInAt: string | null
  shift: WallShift | null
}
type WallPunchIn = {
  ok: true
  action: 'in'
  user: { id: number; name: string }
  checkInAt: string
  late: boolean
  lateMinutes: number
  shift: WallShift | null
}
type WallPunchOut = {
  ok: true
  action: 'out'
  user: { id: number; name: string }
  checkInAt: string
  checkOutAt: string
  workedMinutes: number
}

// ── Deterministic warm avatar palette (no blue/indigo per house style) ─
const AVATAR_PALETTE = [
  'bg-amber-600',
  'bg-orange-600',
  'bg-rose-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-fuchsia-600',
  'bg-red-600',
  'bg-lime-700',
]

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.charAt(0) ?? '?'
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''
  return (first + second).toUpperCase()
}

function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

const ROLE_ICONS: Record<string, typeof ConciergeBell> = {
  waiter: ConciergeBell,
  kitchen: ChefHat,
  admin: ShieldCheck,
  custom: Briefcase,
}

/** workedMinutes → "Xh Ym" / "Xm" (Latin digits in both languages). */
function formatWorked(minutes: number): string {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

// ── WebAudio feedback (no assets — pure oscillators) ─────────────────
// Green chime for clock-in, lower tone for clock-out, buzz for errors:
// staff who can't read still get instant confirmation by EAR.
let audioCtx: AudioContext | null = null

function tone(freqs: number[], duration = 0.09, type: OscillatorType = 'sine', gain = 0.1) {
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      audioCtx = new Ctor()
    }
    void audioCtx.resume()
    let t = audioCtx.currentTime
    for (const f of freqs) {
      const osc = audioCtx.createOscillator()
      const g = audioCtx.createGain()
      osc.type = type
      osc.frequency.value = f
      g.gain.setValueAtTime(gain, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration)
      osc.connect(g).connect(audioCtx.destination)
      osc.start(t)
      osc.stop(t + duration)
      t += duration * 0.85
    }
  } catch {
    // audio is a bonus — never break the flow over it
  }
}

const sndDigit = () => tone([660], 0.06, 'sine', 0.06)
const sndError = () => tone([170, 140], 0.14, 'sawtooth', 0.08)
const sndIn = () => tone([523.25, 783.99], 0.12, 'sine', 0.12) // C5 → G5 up
const sndOut = () => tone([783.99, 523.25], 0.12, 'sine', 0.12) // G5 → C5 down

function haptic(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // ignore
  }
}

// ─── Component ───────────────────────────────────────────────────────
export default function TeamWall({ onLogin }: { onLogin: () => void }) {
  const { t, lang, toggleLang } = useI18n()
  const { restaurantName } = useAppSettings()
  const queryClient = useQueryClient()

  // Manager corner → classic full sign-in card (email/PIN/demo/register)
  const [managerMode, setManagerMode] = useState(false)

  // state machine: wall → pin → action → celebrate
  const [selected, setSelected] = useState<WallUser | null>(null)
  const [pin, setPin] = useState('')
  const [pinLoading, setPinLoading] = useState(false)
  const [pinError, setPinError] = useState(false)
  const [shake, setShake] = useState(false)
  const [rateMessage, setRateMessage] = useState<string | null>(null)
  const [status, setStatus] = useState<WallStatus | null>(null)
  const [punchLoading, setPunchLoading] = useState<'in' | 'out' | null>(null)
  const [celebration, setCelebration] = useState<{
    kind: 'in' | 'out'
    name: string
    workedMinutes?: number
    late?: boolean
    lateMinutes?: number
  } | null>(null)
  const [appLoading, setAppLoading] = useState(false)
  const [pendingPeople, setPendingPeople] = useState<{ id: number; name: string }[] | null>(null)

  // the verified PIN lives ONLY in this ref (never rendered) so “MY SCREEN”
  // can reuse it; cleared the moment we leave the action screen.
  const verifiedPinRef = useRef('')

  // live roster (auto-refresh keeps the green dots honest)
  const rosterQuery = useQuery({
    queryKey: ['team-wall'],
    queryFn: () => fetcher<WallRoster>('/api/auth/team-wall'),
    refetchInterval: 20_000,
    staleTime: 10_000,
  })
  const team = rosterQuery.data?.team ?? []

  // live clock + ticking worked timer
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => window.clearInterval(id)
  }, [])

  // celebration auto-return (6.5s) — tap anywhere returns sooner
  useEffect(() => {
    if (!celebration) return
    const id = window.setTimeout(() => {
      setCelebration(null)
    }, 6500)
    return () => window.clearTimeout(id)
  }, [celebration])

  const workedMinutes = useMemo(() => {
    if (!status?.onShift || !status.checkedInAt) return null
    const started = new Date(status.checkedInAt).getTime()
    return Math.max(0, Math.floor((now - started) / 60000))
  }, [now, status?.checkedInAt, status?.onShift])

  // shake helper
  const shakeTimer = useRef<number | null>(null)
  useEffect(() => () => {
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
  }, [])
  const triggerShake = useCallback(() => {
    setShake(true)
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    shakeTimer.current = window.setTimeout(() => setShake(false), 500)
  }, [])

  const backToWall = useCallback(() => {
    setSelected(null)
    setPin('')
    setPinError(false)
    setRateMessage(null)
    setStatus(null)
    verifiedPinRef.current = ''
    setPendingPeople(null)
  }, [])

  const wallError = useCallback(
    (err: unknown, fallbackKey: string) => {
      const message = err instanceof Error ? err.message : t(fallbackKey)
      toast.error(message)
      if (/too many attempts/i.test(message)) setRateMessage(message)
      setPin('')
      setPinError(true)
      sndError()
      haptic(40)
      triggerShake()
    },
    [t, triggerShake],
  )

  // ── PIN verify (wall status) ──────────────────────────────────────
  const submitPin = useCallback(
    async (value: string) => {
      if (!selected || pinLoading) return
      setPinLoading(true)
      setRateMessage(null)
      try {
        const res = await apiFetch<WallStatus>('/api/attendance/wall', {
          body: { userId: selected.id, pin: value },
        })
        verifiedPinRef.current = value
        setStatus(res)
        setPin('')
        setPinError(false)
        sndDigit()
      } catch (err) {
        wallError(err, 'wall.wrongPin')
      } finally {
        setPinLoading(false)
      }
    },
    [pinLoading, selected, wallError],
  )

  const pressDigit = useCallback(
    (digit: string) => {
      if (pinLoading || status) return
      const next = (pin + digit).slice(0, PIN_LENGTH)
      setPin(next)
      setPinError(false)
      sndDigit()
      haptic(8)
      if (next.length === PIN_LENGTH) void submitPin(next)
    },
    [pin, pinLoading, status, submitPin],
  )

  const backspacePin = useCallback(() => setPin((p) => p.slice(0, -1)), [])
  const clearPin = useCallback(() => {
    setPin('')
    setPinError(false)
  }, [])

  // physical keyboard support on the PIN screen
  useEffect(() => {
    if (!selected || status) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.repeat) return
      if (/^[0-9]$/.test(e.key)) pressDigit(e.key)
      else if (e.key === 'Backspace') backspacePin()
      else if (e.key === 'Escape') clearPin()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [backspacePin, clearPin, pressDigit, selected, status])

  // ── punch in / out ────────────────────────────────────────────────
  const punch = useCallback(
    async (action: 'in' | 'out') => {
      if (!selected || !status || punchLoading) return
      setPunchLoading(action)
      try {
        if (action === 'in') {
          const res = await apiFetch<WallPunchIn>('/api/attendance/wall', {
            body: { userId: selected.id, pin: verifiedPinRef.current, action: 'in' },
          })
          sndIn()
          haptic([20, 40, 20])
          setCelebration({
            kind: 'in',
            name: res.user.name,
            late: res.late,
            lateMinutes: res.lateMinutes,
          })
        } else {
          const res = await apiFetch<WallPunchOut>('/api/attendance/wall', {
            body: { userId: selected.id, pin: verifiedPinRef.current, action: 'out' },
          })
          sndOut()
          haptic([40, 20])
          setCelebration({
            kind: 'out',
            name: res.user.name,
            workedMinutes: res.workedMinutes,
          })
        }
        // refresh the live dots immediately
        void queryClient.invalidateQueries({ queryKey: ['team-wall'] })
        backToWall()
      } catch (err) {
        wallError(err, action === 'in' ? 'auth.checkInFailed' : 'auth.checkOutFailed')
      } finally {
        setPunchLoading(null)
      }
    },
    [backToWall, punchLoading, queryClient, selected, status, wallError],
  )

  // ── MY SCREEN — enter the app with the already-verified PIN ────────
  const enterApp = useCallback(async () => {
    if (appLoading || !selected) return
    setAppLoading(true)
    try {
      const { user, token, people } = await apiFetch<{
        user: SessionUser
        token?: string
        people?: { id: number; name: string }[]
      }>('/api/auth/login', {
        body: { pin: verifiedPinRef.current },
      })
      if (user.personId == null && people && people.length > 1) {
        // shared account → who exactly is working? (same flow as LoginView)
        if (token) setSessionToken(token)
        setPendingPeople(people)
        return
      }
      if (token) setSessionToken(token)
      toast.success(t('auth.welcomeBack', { name: user.name }))
      onLogin()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('auth.loginFailed')
      toast.error(message)
    } finally {
      setAppLoading(false)
    }
  }, [appLoading, onLogin, selected, t])

  const selectLoginPerson = useCallback(
    async (person: { id: number; name: string } | null) => {
      if (appLoading) return
      setAppLoading(true)
      try {
        if (person) {
          const { token } = await apiFetch<{ user: SessionUser; token?: string }>(
            '/api/auth/person',
            { body: { personId: person.id } },
          )
          if (token) setSessionToken(token)
          toast.success(t('auth.welcomeBack', { name: person.name }))
        }
        setPendingPeople(null)
        onLogin()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setAppLoading(false)
      }
    },
    [appLoading, onLogin, t],
  )

  // ── Manager corner renders the classic sign-in card unchanged ─────
  if (managerMode) {
    return <LoginView onLogin={onLogin} onBackToWall={() => setManagerMode(false)} />
  }

  // ── Person picker (shared account, MY SCREEN) ─────────────────────
  if (pendingPeople) {
    return (
      <div className="grid min-h-screen w-full place-items-center bg-background p-4 sm:p-6">
        <div className="w-full max-w-md">
          <div className="bg-card flex w-full flex-col gap-6 rounded-xl border p-6 shadow-lg sm:p-8">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="bg-primary text-primary-foreground grid h-12 w-12 place-items-center rounded-lg shadow-sm">
                <Users className="h-6 w-6" aria-hidden />
              </span>
              <h1 className="text-xl font-bold tracking-tight">{t('auth.whoIsUsing')}</h1>
              <p className="text-sm text-muted-foreground">{t('auth.whoIsUsingSub')}</p>
            </div>
            <div className="space-y-2" role="listbox" aria-label={t('auth.whoIsUsing')}>
              {pendingPeople.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => void selectLoginPerson(person)}
                  disabled={appLoading}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg border bg-background px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                >
                  <span
                    className={cn(
                      'grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white',
                      avatarColor(person.name),
                    )}
                    aria-hidden
                  >
                    {initialsOf(person.name)}
                  </span>
                  <span className="flex-1 truncate text-base font-semibold">{person.name}</span>
                  {appLoading ? (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden />
                  ) : (
                    <LogIn className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void selectLoginPerson(null)}
              disabled={appLoading}
              className="rounded text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('auth.continueAsAccount', { name: selected?.name ?? '' })}
            </button>
            <button
              type="button"
              onClick={backToWall}
              className="mx-auto flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
              {t('wall.backToWall')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── CELEBRATION (full-screen success) ────────────────────────────
  if (celebration) {
    const isIn = celebration.kind === 'in'
    return (
      <button
        type="button"
        aria-label={t('wall.backToWall')}
        onClick={() => setCelebration(null)}
        className={cn(
          'fixed inset-0 z-50 flex w-full flex-col items-center justify-center gap-6 p-6 text-center transition-colors',
          isIn ? 'bg-emerald-600' : 'bg-amber-600',
        )}
      >
        <style>{`
          @keyframes rmsPop { 0% { transform: scale(0.4); opacity: 0; } 70% { transform: scale(1.12); } 100% { transform: scale(1); opacity: 1; } }
          .rms-pop { animation: rmsPop 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }
        `}</style>

        <span
          className={cn(
            'rms-pop grid h-32 w-32 place-items-center rounded-full bg-white/20 shadow-2xl sm:h-40 sm:w-40',
          )}
        >
          {isIn ? (
            <Sun className="h-16 w-16 text-white drop-shadow sm:h-20 sm:w-20" aria-hidden />
          ) : (
            <Moon className="h-16 w-16 text-white drop-shadow sm:h-20 sm:w-20" aria-hidden />
          )}
        </span>

        <div className="rms-pop space-y-3" style={{ animationDelay: '0.15s' }}>
          <p className="text-3xl font-black leading-tight text-white drop-shadow-sm sm:text-5xl">
            {isIn
              ? t('wall.haveGreatShift', { name: firstNameOf(celebration.name) })
              : t('wall.greatWorkToday')}
          </p>
          {!isIn && typeof celebration.workedMinutes === 'number' && (
            <p className="text-2xl font-bold tabular-nums text-white/95 sm:text-4xl">
              {t('wall.workedDuration', { duration: formatWorked(celebration.workedMinutes) })}
            </p>
          )}
          {isIn && celebration.late && (
            <p className="text-lg font-semibold text-white/90 sm:text-2xl">
              {t('attendance.lateBy', { minutes: celebration.lateMinutes ?? 0 })}
            </p>
          )}
        </div>

        <p className="absolute bottom-8 text-sm font-medium text-white/80">
          {t('wall.backToWall')}
        </p>
      </button>
    )
  }

  // ─── PIN screen (giant keypad) ────────────────────────────────────
  if (selected && !status) {
    return (
      <div className="flex min-h-screen w-full flex-col bg-background">
        <style>{`
          @keyframes rmsShake { 0%, 100% { transform: translateX(0); } 20% { transform: translateX(-7px); } 40% { transform: translateX(7px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(4px); } }
          .rms-shake { animation: rmsShake 0.45s ease; }
        `}</style>

        {/* header: back + who */}
        <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
          <button
            type="button"
            onClick={backToWall}
            className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-5 w-5 rtl:rotate-180" aria-hidden />
            <span className="hidden sm:inline">{t('wall.changePerson')}</span>
          </button>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'grid h-11 w-11 place-items-center rounded-full text-base font-black text-white shadow',
                avatarColor(selected.name),
              )}
              aria-hidden
            >
              {initialsOf(selected.name)}
            </span>
            <div className="text-right">
              <p className="text-base font-bold leading-tight sm:text-lg">{selected.name}</p>
              <p className="text-xs text-muted-foreground">{selected.roleLabel}</p>
            </div>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 p-4 sm:p-6">
          <p className="text-center text-xl font-bold tracking-tight sm:text-2xl">
            {t('wall.pinTitle')} 🔑
          </p>

          {/* 6 digit boxes */}
          <div
            className={cn('grid grid-cols-6 gap-2', shake && 'rms-shake')}
            role="group"
            aria-label={t('auth.pinStatus', { n: pin.length, total: PIN_LENGTH })}
          >
            {Array.from({ length: PIN_LENGTH }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'grid h-14 place-items-center rounded-xl border-2 text-2xl font-bold tabular-nums transition-colors sm:h-16 sm:text-3xl',
                  pinError
                    ? 'border-destructive bg-destructive/5 text-destructive'
                    : i < pin.length
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border bg-muted/40 text-muted-foreground',
                )}
                aria-hidden
              >
                {i < pin.length ? pin[i] : '•'}
              </div>
            ))}
          </div>

          {pinLoading && (
            <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {t('auth.signingIn')}
            </p>
          )}

          {pinError && !pinLoading && (
            <p
              className="flex items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-center text-sm font-semibold text-destructive"
              role="alert"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {rateMessage ?? t('wall.wrongPin')}
            </p>
          )}

          {/* giant keypad */}
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
              <button
                key={digit}
                type="button"
                aria-label={t('auth.digit', { d: digit })}
                disabled={pinLoading}
                onClick={() => pressDigit(digit)}
                className="h-16 rounded-2xl border bg-card text-3xl font-bold text-foreground shadow-sm transition select-none touch-manipulation hover:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sm:h-20 sm:text-4xl"
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              aria-label={t('common.clear')}
              disabled={pinLoading || pin.length === 0}
              onClick={clearPin}
              className="grid h-16 place-items-center rounded-2xl border bg-card text-muted-foreground shadow-sm transition select-none touch-manipulation hover:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sm:h-20"
            >
              <X className="h-7 w-7" aria-hidden />
            </button>
            <button
              type="button"
              aria-label={t('auth.digit', { d: '0' })}
              disabled={pinLoading}
              onClick={() => pressDigit('0')}
              className="h-16 rounded-2xl border bg-card text-3xl font-bold text-foreground shadow-sm transition select-none touch-manipulation hover:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sm:h-20 sm:text-4xl"
            >
              0
            </button>
            <button
              type="button"
              aria-label={t('auth.backspace')}
              disabled={pinLoading || pin.length === 0}
              onClick={backspacePin}
              className="grid h-16 place-items-center rounded-2xl border bg-card text-muted-foreground shadow-sm transition select-none touch-manipulation hover:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 sm:h-20"
            >
              <Delete className="h-7 w-7" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── ACTION screen (one giant decision) ───────────────────────────
  if (selected && status) {
    const RoleIcon = ROLE_ICONS[status.user.role] ?? Briefcase
    const onShift = status.onShift
    return (
      <div className="flex min-h-screen w-full flex-col bg-background">
        {/* header: back + who */}
        <div className="flex items-center justify-between gap-3 border-b p-4 sm:p-5">
          <button
            type="button"
            onClick={backToWall}
            className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-5 w-5 rtl:rotate-180" aria-hidden />
            <span className="hidden sm:inline">{t('wall.backToWall')}</span>
          </button>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'grid h-11 w-11 place-items-center rounded-full text-base font-black text-white shadow',
                avatarColor(status.user.name),
              )}
              aria-hidden
            >
              {initialsOf(status.user.name)}
            </span>
            <div className="text-right">
              <p className="text-base font-bold leading-tight sm:text-lg">{status.user.name}</p>
              <p className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                <RoleIcon className="h-3.5 w-3.5" aria-hidden />
                {status.user.roleLabel}
              </p>
            </div>
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-5 p-4 py-8 sm:p-6">
          {/* live status card */}
          <div
            className={cn(
              'flex items-center justify-between gap-4 rounded-2xl border p-5',
              onShift ? 'border-emerald-300 bg-emerald-50' : 'bg-muted/50',
            )}
          >
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                {onShift ? (
                  <>
                    <span className="relative flex h-3 w-3" aria-hidden>
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-emerald-600" />
                    </span>
                    {t('wall.onShift')}
                  </>
                ) : (
                  <>
                    <Moon className="h-4 w-4" aria-hidden />
                    {t('wall.offShift')}
                  </>
                )}
              </p>
              {onShift && status.checkedInAt && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('wall.startedAt', { time: formatTime(status.checkedInAt) })}
                </p>
              )}
              {!onShift && status.shift && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {status.shift.name} ·{' '}
                  <span className="tabular-nums" dir="ltr">
                    {status.shift.startTime}–{status.shift.endTime}
                  </span>
                </p>
              )}
            </div>
            {onShift && workedMinutes !== null && (
              <p className="text-4xl font-black tabular-nums text-emerald-700 sm:text-5xl" dir="ltr">
                {formatWorked(workedMinutes)}
              </p>
            )}
          </div>

          {/* THE one giant action */}
          {onShift ? (
            <Button
              type="button"
              disabled={punchLoading !== null}
              onClick={() => void punch('out')}
              className="h-24 w-full flex-col gap-1.5 rounded-3xl bg-rose-600 text-2xl font-black tracking-wide text-white shadow-lg transition hover:bg-rose-700 active:scale-[0.98] sm:h-28 sm:text-3xl"
            >
              {punchLoading === 'out' ? (
                <>
                  <Loader2 className="h-9 w-9 animate-spin" aria-hidden />
                  {t('wall.finishingWork')}
                </>
              ) : (
                <>
                  <Moon className="h-10 w-10" aria-hidden />
                  {t('wall.finishWork')}
                </>
              )}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={punchLoading !== null}
              onClick={() => void punch('in')}
              className="h-24 w-full flex-col gap-1.5 rounded-3xl bg-emerald-600 text-2xl font-black tracking-wide text-white shadow-lg transition hover:bg-emerald-700 active:scale-[0.98] sm:h-28 sm:text-3xl"
            >
              {punchLoading === 'in' ? (
                <>
                  <Loader2 className="h-9 w-9 animate-spin" aria-hidden />
                  {t('wall.startingWork')}
                </>
              ) : (
                <>
                  <Sun className="h-10 w-10" aria-hidden />
                  {t('wall.startWork')}
                </>
              )}
            </Button>
          )}

          {/* MY SCREEN — POS/KDS entry with the verified PIN */}
          {selected.canUseApp && (
            <Button
              type="button"
              variant="outline"
              disabled={punchLoading !== null || appLoading}
              onClick={() => void enterApp()}
              className="h-16 w-full rounded-2xl text-lg font-bold transition active:scale-[0.99] sm:h-[4.5rem] sm:text-xl"
            >
              {appLoading ? (
                <Loader2 className="h-6 w-6 animate-spin" aria-hidden />
              ) : (
                <Smartphone className="h-7 w-7 text-primary" aria-hidden />
              )}
              {t('wall.myScreen')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  // ─── THE WALL (face grid — default screen) ────────────────────────
  const clock = new Date(now)
  const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`

  return (
    <div className="flex min-h-screen w-full flex-col bg-background">
      {/* live board header */}
      <header className="border-b bg-card/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3">
            <span className="bg-primary text-primary-foreground grid h-11 w-11 place-items-center rounded-xl shadow-sm">
              <Users className="h-6 w-6" aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-black leading-tight tracking-tight sm:text-2xl">
                {t('wall.title')}
              </h1>
              <p className="text-xs font-medium text-muted-foreground sm:text-sm">
                {t('wall.subtitle')}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-2xl font-black tabular-nums leading-none" dir="ltr">
                {hhmm}
              </p>
              <p className="text-xs font-semibold text-emerald-700">
                {t('wall.hereNow', { n: rosterQuery.data?.onShiftCount ?? 0 })}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleLang}
              aria-label={lang === 'en' ? 'العربية' : 'English'}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-bold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Languages className="h-4 w-4" aria-hidden />
              {lang === 'en' ? 'ع' : 'EN'}
            </button>
          </div>
        </div>
      </header>

      {/* face grid */}
      <main className="mx-auto w-full max-w-5xl flex-1 p-4 sm:p-6">
        {rosterQuery.isLoading ? (
          <div className="grid min-h-[50vh] place-items-center" role="status">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="h-8 w-8 animate-spin" aria-hidden />
              <p className="text-sm font-medium">{t('wall.loadingTeam')}</p>
            </div>
          </div>
        ) : rosterQuery.isError ? (
          <div className="grid min-h-[50vh] place-items-center">
            <div className="flex flex-col items-center gap-3 text-center">
              <p className="text-sm font-semibold text-destructive">{t('auth.loginFailed')}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void rosterQuery.refetch()}
                className="min-h-11"
              >
                {t('wall.retry')}
              </Button>
            </div>
          </div>
        ) : team.length === 0 ? (
          <div className="grid min-h-[50vh] place-items-center text-center">
            <p className="max-w-sm text-sm text-muted-foreground">{t('wall.notListed')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 md:grid-cols-4 lg:grid-cols-5">
            {team.map((member) => {
              const RoleIcon = ROLE_ICONS[member.role] ?? Briefcase
              return (
                <button
                  key={member.id}
                  type="button"
                  onClick={() => {
                    setSelected(member)
                    sndDigit()
                    haptic(8)
                  }}
                  aria-label={member.name}
                  className={cn(
                    'group relative flex min-h-36 flex-col items-center justify-center gap-2.5 rounded-2xl border bg-card p-4 shadow-sm transition select-none touch-manipulation hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-44 sm:gap-3 sm:p-5',
                    member.onShift && 'border-emerald-300 bg-emerald-50/50',
                  )}
                >
                  {/* live on-shift badge */}
                  {member.onShift && (
                    <span
                      className="absolute top-2.5 end-2.5 flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm"
                      title={t('wall.onShift')}
                    >
                      <span className="relative flex h-1.5 w-1.5" aria-hidden>
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-70" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white" />
                      </span>
                      {t('wall.onShift')}
                    </span>
                  )}

                  <span
                    className={cn(
                      'grid h-16 w-16 place-items-center rounded-full text-xl font-black text-white shadow-md transition-transform group-hover:scale-105 sm:h-20 sm:w-20 sm:text-2xl',
                      avatarColor(member.name),
                    )}
                    aria-hidden
                  >
                    {initialsOf(member.name)}
                  </span>

                  <span className="flex max-w-full flex-col items-center gap-0.5">
                    <span className="w-full truncate text-center text-base font-bold leading-tight sm:text-lg">
                      {member.name}
                    </span>
                    <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <RoleIcon className="h-3.5 w-3.5" aria-hidden />
                      {member.roleLabel}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </main>

      {/* manager corner + onboarding hint */}
      <footer className="mt-auto border-t bg-card/60 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
          <p className="text-xs text-muted-foreground">{t('wall.notListed')}</p>
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold text-muted-foreground sm:hidden">
              {t('wall.hereNow', { n: rosterQuery.data?.onShiftCount ?? 0 })} ·{' '}
              <span className="tabular-nums" dir="ltr">
                {hhmm}
              </span>
            </p>
            <button
              type="button"
              onClick={() => setManagerMode(true)}
              className="flex min-h-11 items-center gap-2 rounded-lg border bg-card px-4 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShieldCheck className="h-4 w-4" aria-hidden />
              {t('wall.manager')}
            </button>
          </div>
        </div>
        <p className="pb-2 text-center text-[10px] text-muted-foreground/70">
          {restaurantName} · {new Date().getFullYear()}
        </p>
      </footer>
    </div>
  )
}
