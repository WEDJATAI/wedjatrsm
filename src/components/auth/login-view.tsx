'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChefHat,
  CheckCircle2,
  Clock,
  ConciergeBell,
  Delete,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Mail,
  ShieldCheck,
  Timer,
  UserCheck,
  UtensilsCrossed,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch, setSessionToken } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { SessionUser } from '@/lib/types'
import { useAppSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'

const PIN_LENGTH = 6

type DemoRole = 'admin' | 'waiter' | 'kitchen'

const DEMO_ACCOUNTS: [role: DemoRole, email: string, password: string, pin: string][] = [
  ['admin', 'admin@rms.com', 'admin123', '123456'],
  ['waiter', 'waiter@rms.com', 'waiter123', '111111'],
  ['kitchen', 'kitchen@rms.com', 'kitchen123', '222222'],
]

const DEMO_ROLE_ICONS: Record<DemoRole, typeof ShieldCheck> = {
  admin: ShieldCheck,
  waiter: ConciergeBell,
  kitchen: ChefHat,
}

// ── Public attendance API shapes (POST /api/attendance/check-in|out) ─
type AttendanceUser = {
  id: number
  name: string
  role: string
  roleLabel: string
  roleName: string | null
}
type ShiftInfo = { id: number; name: string; startTime: string; endTime: string }
type CheckInResponse = {
  user: AttendanceUser
  attendance: { checkInAt: string; checkOutAt: string | null; lateMinutes: number }
  late: boolean
  lateMinutes: number
  shift: ShiftInfo | null
}
type CheckOutResponse = {
  user: AttendanceUser
  attendance: { checkInAt: string; checkOutAt: string; workedMinutes: number }
  workedMinutes: number
  shift: ShiftInfo | null
}

/** workedMinutes → "Xh Ym" / "Xm" (Latin digits in both languages). */
function formatWorkedMinutes(minutes: number): string {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

type KeypadHandlers = { press: (digit: string) => void; back: () => void; clear: () => void }

export default function LoginView({ onLogin }: { onLogin: () => void }) {
  const { t } = useI18n()
  const { restaurantName } = useAppSettings()

  // ── Shared shake animation (wrong PIN on either keypad) ───────────
  const [shake, setShake] = useState(false)
  const shakeTimer = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    }
  }, [])

  const triggerShake = useCallback(() => {
    setShake(true)
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
    shakeTimer.current = window.setTimeout(() => {
      setShake(false)
      shakeTimer.current = null
    }, 500)
  }, [])

  // ── Email / password ─────────────────────────────────────────────
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)
  const [emailError, setEmailError] = useState(false)

  const handleEmailSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (emailLoading) return
      if (!email.trim() || !password) {
        setEmailError(true)
        toast.error(t('auth.enterEmailPassword'))
        return
      }
      setEmailLoading(true)
      setEmailError(false)
      try {
        const { user, token } = await apiFetch<{
          user: SessionUser
          token?: string
        }>('/api/auth/login', {
          body: { email: email.trim().toLowerCase(), password },
        })
        if (token) setSessionToken(token)
        toast.success(t('auth.welcomeBack', { name: user.name }))
        onLogin()
      } catch (err) {
        setEmailError(true)
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setEmailLoading(false)
      }
    },
    [email, emailLoading, onLogin, password, t],
  )

  // ── Sign-in tab: email | PIN ──────────────────────────────────────
  const [topTab, setTopTab] = useState<'signin' | 'checkin'>('signin')
  const [tab, setTab] = useState<'email' | 'pin'>('email')
  const [pin, setPin] = useState('')
  const [pinLoading, setPinLoading] = useState(false)
  const [pinError, setPinError] = useState(false)

  const submitPin = useCallback(
    async (value: string) => {
      setPinLoading(true)
      try {
        const { user, token } = await apiFetch<{
          user: SessionUser
          token?: string
        }>('/api/auth/login', {
          body: { pin: value },
        })
        if (token) setSessionToken(token)
        toast.success(t('auth.welcomeBack', { name: user.name }))
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

  // ── One-click demo sign-in (dev/demo convenience) ───────────────
  /** role key of the account currently being quick-signed-in (null = idle) */
  const [quickLoading, setQuickLoading] = useState<DemoRole | null>(null)

  const quickLogin = useCallback(
    async (role: DemoRole, mail: string, pass: string) => {
      if (quickLoading) return
      setQuickLoading(role)
      try {
        const { user, token } = await apiFetch<{
          user: SessionUser
          token?: string
        }>('/api/auth/login', {
          body: { email: mail, password: pass },
        })
        if (token) setSessionToken(token)
        toast.success(t('auth.welcomeBack', { name: user.name }))
        onLogin()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setQuickLoading(null)
      }
    },
    [onLogin, quickLoading, t],
  )

  const pressDigit = useCallback(
    (digit: string) => {
      if (pinLoading || pin.length >= PIN_LENGTH) return
      const next = (pin + digit).slice(0, PIN_LENGTH)
      setPin(next)
      setPinError(false)
      if (next.length === PIN_LENGTH) void submitPin(next)
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

  // ── Employee check-in (public, NEVER sets a session) ──────────────
  const [username, setUsername] = useState('')
  const [attPin, setAttPin] = useState('')
  const [attLoading, setAttLoading] = useState(false)
  const [attPinError, setAttPinError] = useState(false)
  /** 429 rate-limit message shown inline inside the check-in card */
  const [attRateMessage, setAttRateMessage] = useState<string | null>(null)
  const [attResult, setAttResult] = useState<CheckInResponse | null>(null)
  const [attCheckedOut, setAttCheckedOut] = useState<CheckOutResponse | null>(null)
  const usernameRef = useRef<HTMLInputElement>(null)

  const submitCheckIn = useCallback(
    async (value: string) => {
      if (attLoading || attResult) return
      if (value.length !== PIN_LENGTH) {
        toast.error(t('auth.pinIncomplete'))
        return
      }
      const name = username.trim()
      if (!name) {
        toast.error(t('auth.nameRequired'))
        usernameRef.current?.focus()
        return
      }
      setAttLoading(true)
      setAttRateMessage(null)
      try {
        const res = await apiFetch<CheckInResponse>('/api/attendance/check-in', {
          body: { username: name, pin: value },
        })
        setAttResult(res)
        toast.success(t('auth.checkInSuccess'))
      } catch (err) {
        const message = err instanceof Error ? err.message : t('auth.checkInFailed')
        toast.error(message)
        if (/too many attempts/i.test(message)) setAttRateMessage(message)
        setAttPin('')
        setAttPinError(true)
        triggerShake()
      } finally {
        setAttLoading(false)
      }
    },
    [attLoading, attResult, t, triggerShake, username],
  )

  const pressAttDigit = useCallback(
    (digit: string) => {
      if (attLoading || attResult) return
      const next = (attPin + digit).slice(0, PIN_LENGTH)
      setAttPin(next)
      setAttPinError(false)
      if (next.length === PIN_LENGTH) void submitCheckIn(next)
    },
    [attLoading, attPin, attResult, submitCheckIn],
  )

  const backspaceAttPin = useCallback(() => {
    if (attResult) return
    setAttPin((p) => p.slice(0, -1))
  }, [attResult])

  const clearAttPin = useCallback(() => {
    if (attResult) return
    setAttPin('')
    setAttPinError(false)
  }, [attResult])

  const submitCheckOut = useCallback(async () => {
    if (attLoading || !attResult || attCheckedOut) return
    setAttLoading(true)
    try {
      const res = await apiFetch<CheckOutResponse>('/api/attendance/check-out', {
        body: { username: username.trim(), pin: attPin },
      })
      setAttCheckedOut(res)
      toast.success(t('auth.checkOutSuccess'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('auth.checkOutFailed'))
      triggerShake()
    } finally {
      setAttLoading(false)
    }
  }, [attCheckedOut, attLoading, attPin, attResult, t, triggerShake, username])

  const resetCheckIn = useCallback(() => {
    setAttResult(null)
    setAttCheckedOut(null)
    setAttPin('')
    setAttPinError(false)
    setAttRateMessage(null)
    setUsername('')
  }, [])

  // ── Physical keyboard support (whichever keypad is on screen) ─────
  // Keep latest handlers in a ref so the window keydown listener never goes stale
  const keypadHandlersRef = useRef<Record<'login' | 'attendance', KeypadHandlers>>({
    login: { press: pressDigit, back: backspacePin, clear: clearPin },
    attendance: { press: pressAttDigit, back: backspaceAttPin, clear: clearAttPin },
  })
  useEffect(() => {
    keypadHandlersRef.current = {
      login: { press: pressDigit, back: backspacePin, clear: clearPin },
      attendance: { press: pressAttDigit, back: backspaceAttPin, clear: clearAttPin },
    }
  })

  // Digits type into the login keypad (PIN sub-tab) or the check-in keypad
  // (check-in tab, form state only — never while the success panel is up).
  const keypadMode: 'login' | 'attendance' | null =
    topTab === 'checkin' ? (attResult ? null : 'attendance') : tab === 'pin' ? 'login' : null

  useEffect(() => {
    if (!keypadMode) return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.repeat) return
      const handlers = keypadHandlersRef.current[keypadMode]
      if (/^[0-9]$/.test(e.key)) handlers.press(e.key)
      else if (e.key === 'Backspace') handlers.back()
      else if (e.key === 'Escape') handlers.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keypadMode])

  return (
    <div className="grid min-h-screen w-full place-items-center bg-background p-4 sm:p-6">
      {/* Shake animation (used on PIN errors) */}
      <style>{`
        @keyframes rmsShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(6px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(4px); }
        }
        .rms-shake { animation: rmsShake 0.45s ease; }
      `}</style>

      <div className="w-full max-w-md">
        <div className="bg-card flex w-full flex-col gap-6 rounded-xl border p-6 shadow-lg sm:p-8">
          {/* Brand header — Odoo plum logo mark */}
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="bg-primary text-primary-foreground grid h-12 w-12 place-items-center rounded-lg shadow-sm">
              <UtensilsCrossed className="h-6 w-6" aria-hidden />
            </span>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{restaurantName}</h1>
              <p className="text-sm text-muted-foreground">{t('auth.subtitle')}</p>
            </div>
          </div>

          {/* Top level: system sign-in | employee attendance check-in */}
          <Tabs value={topTab} onValueChange={(v) => setTopTab(v as 'signin' | 'checkin')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signin">
                <LogIn className="h-4 w-4" aria-hidden />
                {t('auth.title')}
              </TabsTrigger>
              <TabsTrigger value="checkin">
                <UserCheck className="h-4 w-4" aria-hidden />
                {t('auth.checkInTab')}
              </TabsTrigger>
            </TabsList>

            {/* ── Sign in (email + password / PIN) ── */}
            <TabsContent value="signin" className="mt-4">
              <Tabs value={tab} onValueChange={(v) => setTab(v as 'email' | 'pin')}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="email">
                    <Mail className="h-4 w-4" aria-hidden />
                    {t('auth.emailTab')}
                  </TabsTrigger>
                  <TabsTrigger value="pin">
                    <KeyRound className="h-4 w-4" aria-hidden />
                    {t('auth.pinTab')}
                  </TabsTrigger>
                </TabsList>

                {/* Email + password */}
                <TabsContent value="email" className="mt-4">
                  <form className="space-y-4" onSubmit={handleEmailSubmit} noValidate>
                    <div className="space-y-2">
                      <Label htmlFor="login-email">{t('common.email')}</Label>
                      <Input
                        id="login-email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        placeholder="you@restaurant.com"
                        className="h-11"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value)
                          if (emailError) setEmailError(false)
                        }}
                        aria-invalid={emailError || undefined}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="login-password">{t('common.password')}</Label>
                      <Input
                        id="login-password"
                        type="password"
                        autoComplete="current-password"
                        placeholder="••••••••"
                        className="h-11"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value)
                          if (emailError) setEmailError(false)
                        }}
                        aria-invalid={emailError || undefined}
                      />
                    </div>

                    <Button
                      type="submit"
                      className="h-11 w-full text-sm"
                      disabled={emailLoading}
                    >
                      {emailLoading ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          {t('auth.signingIn')}
                        </>
                      ) : (
                        t('auth.signIn')
                      )}
                    </Button>
                  </form>
                </TabsContent>

                {/* PIN keypad (auto-submits at 6 digits) */}
                <TabsContent value="pin" className="mt-4">
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
                </TabsContent>
              </Tabs>
            </TabsContent>

            {/* ── Employee check-in (public — no system sign-in) ── */}
            <TabsContent value="checkin" className="mt-4">
              {attResult ? (
                <div className={cn('space-y-5', shake && 'rms-shake')} role="status">
                  {/* Result header */}
                  <div className="flex flex-col items-center gap-2 text-center">
                    <span
                      className={cn(
                        'grid h-12 w-12 place-items-center rounded-full',
                        attCheckedOut
                          ? 'bg-primary/10 text-primary'
                          : 'bg-emerald-100 text-emerald-600',
                      )}
                    >
                      {attCheckedOut ? (
                        <LogOut className="h-6 w-6" aria-hidden />
                      ) : (
                        <CheckCircle2 className="h-6 w-6" aria-hidden />
                      )}
                    </span>
                    <p className="text-lg font-semibold leading-tight">
                      {t('attendance.welcome', { name: attResult.user.name })}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t('attendance.roleDetected', { role: attResult.user.roleLabel })}
                    </p>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-xs',
                        attResult.late
                          ? 'border-amber-300 bg-amber-100 text-amber-800'
                          : 'border-emerald-300 bg-emerald-100 text-emerald-800',
                      )}
                    >
                      {attResult.late
                        ? t('attendance.lateBy', { minutes: attResult.lateMinutes })
                        : t('attendance.onTime')}
                    </Badge>
                  </div>

                  {/* Details card */}
                  <div className="space-y-2.5 rounded-lg border bg-muted/50 p-4 text-sm">
                    <div className="flex items-center gap-2">
                      <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span>
                        {t('attendance.checkedInAt', {
                          time: formatTime(attResult.attendance.checkInAt),
                        })}
                      </span>
                    </div>
                    {attResult.shift && (
                      <div className="flex items-center gap-2">
                        <Clock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="font-medium">{attResult.shift.name}</span>
                        <span className="text-muted-foreground tabular-nums" dir="ltr">
                          {attResult.shift.startTime}–{attResult.shift.endTime}
                        </span>
                      </div>
                    )}
                    {attCheckedOut && (
                      <>
                        <div className="flex items-center gap-2">
                          <LogOut
                            className="h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span>
                            {t('attendance.checkedOutAt', {
                              time: formatTime(attCheckedOut.attendance.checkOutAt),
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Timer className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span>
                            {t('attendance.worked')}:{' '}
                            <span className="font-semibold tabular-nums">
                              {formatWorkedMinutes(attCheckedOut.workedMinutes)}
                            </span>
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Actions */}
                  {!attCheckedOut ? (
                    <div className="space-y-2.5">
                      <Button
                        type="button"
                        className="h-11 w-full bg-emerald-600 text-sm text-white shadow-sm hover:bg-emerald-700"
                        onClick={() => void submitCheckOut()}
                        disabled={attLoading}
                      >
                        {attLoading ? (
                          <>
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            {t('auth.checkingOut')}
                          </>
                        ) : (
                          t('attendance.checkOut')
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full text-sm"
                        onClick={resetCheckIn}
                        disabled={attLoading}
                      >
                        {t('common.done')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11 w-full text-sm"
                      onClick={resetCheckIn}
                    >
                      {t('common.done')}
                    </Button>
                  )}
                </div>
              ) : (
                <form
                  className="space-y-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void submitCheckIn(attPin)
                  }}
                  noValidate
                >
                  <p className="text-center text-sm text-muted-foreground">
                    {t('auth.checkInSub')}
                  </p>

                  <div className="space-y-2">
                    <Label htmlFor="att-username">{t('attendance.username')}</Label>
                    <Input
                      id="att-username"
                      ref={usernameRef}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t('auth.enterName')}
                      className="h-11"
                      value={username}
                      onChange={(e) => {
                        setUsername(e.target.value)
                        if (attPinError) setAttPinError(false)
                      }}
                      aria-invalid={attPinError || undefined}
                      disabled={attLoading}
                    />
                  </div>

                  {/* Rate-limit message (429) shown inside the card, not just a toast */}
                  {attRateMessage && (
                    <div
                      className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                      role="alert"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>{attRateMessage}</span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label>{t('attendance.pin')}</Label>
                    <PinKeypad
                      value={attPin}
                      loading={attLoading}
                      error={attPinError}
                      shake={shake}
                      loadingLabel={t('auth.checkingIn')}
                      onDigit={pressAttDigit}
                      onBackspace={backspaceAttPin}
                      onClear={clearAttPin}
                    />
                  </div>

                  <Button
                    type="submit"
                    className="h-11 w-full text-sm"
                    disabled={attLoading || attPin.length !== PIN_LENGTH}
                  >
                    {attLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        {t('auth.checkingIn')}
                      </>
                    ) : (
                      t('attendance.checkIn')
                    )}
                  </Button>
                </form>
              )}
            </TabsContent>
          </Tabs>

          {/* One-click demo sign-in (dev convenience) + credentials reference */}
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground rtl:tracking-normal">
              {t('auth.oneClick')}
            </p>
            <div className="space-y-1.5">
              {DEMO_ACCOUNTS.map(([role, mail, pass, pinCode]) => {
                const RoleIcon = DEMO_ROLE_ICONS[role]
                const busy = quickLoading === role
                return (
                  <button
                    key={mail}
                    type="button"
                    onClick={() => void quickLogin(role, mail, pass)}
                    disabled={quickLoading !== null}
                    aria-label={t('auth.oneClickA11y', {
                      role: t(`auth.role${role.charAt(0).toUpperCase()}${role.slice(1)}`),
                    })}
                    className="flex w-full items-center gap-3 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 min-h-11"
                  >
                    {busy ? (
                      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden />
                    ) : (
                      <RoleIcon className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium capitalize">
                        {t(`auth.role${role.charAt(0).toUpperCase()}${role.slice(1)}`)}
                      </span>
                      <span className="inline-flex flex-wrap items-center gap-x-2 truncate font-mono text-[10px] text-muted-foreground">
                        <span className="tabular-nums">{mail}</span>
                        <span className="inline-flex items-center gap-0.5 tabular-nums">
                          <KeyRound className="h-3 w-3" aria-hidden />
                          {pinCode}
                        </span>
                      </span>
                    </span>
                    {busy ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('auth.signingIn')}
                      </span>
                    ) : (
                      <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                  </button>
                )
              })}
            </div>
            <p className="mt-2 border-t pt-2 text-xs leading-relaxed text-muted-foreground">
              {t('auth.oneClickHint')}
            </p>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {restaurantName} · {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}

// ── Shared 6-digit PIN keypad (login PIN tab + employee check-in) ────
function PinKeypad({
  value,
  loading,
  error,
  shake,
  loadingLabel,
  onDigit,
  onBackspace,
  onClear,
}: {
  value: string
  loading: boolean
  error: boolean
  shake: boolean
  loadingLabel: string
  onDigit: (digit: string) => void
  onBackspace: () => void
  onClear: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-4">
      <div
        className={cn('grid grid-cols-6 gap-2', shake && 'rms-shake')}
        role="group"
        aria-label={t('auth.pinStatus', { n: value.length, total: PIN_LENGTH })}
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'grid h-12 place-items-center rounded-xl border-2 text-xl font-bold tabular-nums transition-colors sm:h-14 sm:text-2xl',
              error
                ? 'border-destructive bg-destructive/5 text-destructive'
                : i < value.length
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-muted/40 text-muted-foreground',
            )}
            aria-hidden
          >
            {i < value.length ? value[i] : '•'}
          </div>
        ))}
      </div>

      {loading && (
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {loadingLabel}
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <KeypadButton
            key={digit}
            label={t('auth.digit', { d: digit })}
            disabled={loading}
            onClick={() => onDigit(digit)}
          >
            {digit}
          </KeypadButton>
        ))}
        <KeypadButton
          label={t('common.clear')}
          disabled={loading || value.length === 0}
          onClick={onClear}
        >
          <X className="h-6 w-6" aria-hidden />
        </KeypadButton>
        <KeypadButton
          label={t('auth.digit', { d: '0' })}
          disabled={loading}
          onClick={() => onDigit('0')}
        >
          0
        </KeypadButton>
        <KeypadButton
          label={t('auth.backspace')}
          disabled={loading || value.length === 0}
          onClick={onBackspace}
        >
          <Delete className="h-6 w-6" aria-hidden />
        </KeypadButton>
      </div>
    </div>
  )
}

function KeypadButton({
  children,
  onClick,
  label,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className="h-14 rounded-xl border bg-card text-xl font-bold text-foreground shadow-sm transition select-none touch-manipulation hover:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}
