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
  UserPlus,
  UtensilsCrossed,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

type RegisterRoleOption = { value: string; label: string }

// Built-in picker fallback — replaced by GET /api/auth/register (which also
// lists admin-approved custom service roles) as soon as it resolves.
const REGISTER_ROLES_FALLBACK: RegisterRoleOption[] = [
  { value: 'waiter', label: 'Waiter' },
  { value: 'kitchen', label: 'Kitchen' },
]

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

  // ── R19 person picker — “who is using this device?” ─────────────
  // After a successful login on an account with SEVERAL registered people,
  // we ask which staff member is operating the device before entering the
  // app (checks & item moves are attributed to them). One person → already
  // embedded by the server; zero people → straight in (backward compatible).
  const [pendingPeople, setPendingPeople] = useState<{ id: number; name: string }[] | null>(null)
  const [personLoadingId, setPersonLoadingId] = useState<number | 'none' | null>(null)
  // the account name is kept for the “continue as …” escape hatch
  const [pendingAccountName, setPendingAccountName] = useState('')

  const finishLogin = useCallback(
    (user: SessionUser, token: string | undefined, people: { id: number; name: string }[]) => {
      if (token) setSessionToken(token)
      if (user.personId == null && people.length > 1) {
        setPendingAccountName(user.name)
        setPendingPeople(people)
        return // pick a person first — one extra tap, full attribution
      }
      toast.success(t('auth.welcomeBack', { name: user.name }))
      onLogin()
    },
    [onLogin, t],
  )

  const selectLoginPerson = useCallback(
    async (person: { id: number; name: string } | null) => {
      if (personLoadingId !== null) return
      setPersonLoadingId(person?.id ?? 'none')
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
        setPersonLoadingId(null)
      }
    },
    [onLogin, personLoadingId, t],
  )

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
        const { user, token, people } = await apiFetch<{
          user: SessionUser
          people?: { id: number; name: string }[]
          token?: string
        }>('/api/auth/login', {
          body: { email: email.trim().toLowerCase(), password },
        })
        finishLogin(user, token, people ?? [])
      } catch (err) {
        setEmailError(true)
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setEmailLoading(false)
      }
    },
    [email, emailLoading, finishLogin, password, t],
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
        const { user, token, people } = await apiFetch<{
          user: SessionUser
          people?: { id: number; name: string }[]
          token?: string
        }>('/api/auth/login', {
          body: { pin: value },
        })
        finishLogin(user, token, people ?? [])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
        setPin('')
        setPinError(true)
        triggerShake()
      } finally {
        setPinLoading(false)
      }
    },
    [finishLogin, t, triggerShake],
  )

  // ── One-click demo sign-in (dev/demo convenience) ───────────────
  /** role key of the account currently being quick-signed-in (null = idle) */
  const [quickLoading, setQuickLoading] = useState<DemoRole | null>(null)

  const quickLogin = useCallback(
    async (role: DemoRole, mail: string, pass: string) => {
      if (quickLoading) return
      setQuickLoading(role)
      try {
        const { user, token, people } = await apiFetch<{
          user: SessionUser
          people?: { id: number; name: string }[]
          token?: string
        }>('/api/auth/login', {
          body: { email: mail, password: pass },
        })
        finishLogin(user, token, people ?? [])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setQuickLoading(null)
      }
    },
    [finishLogin, quickLoading, t],
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

  // ── R22 self-registration (name + PIN, service roles) ────────────
  const [showRegister, setShowRegister] = useState(false)
  const [regName, setRegName] = useState('')
  const [regRole, setRegRole] = useState('waiter')
  const [regRoles, setRegRoles] = useState<RegisterRoleOption[]>(REGISTER_ROLES_FALLBACK)
  const [regPin, setRegPin] = useState('')
  const [regPinConfirm, setRegPinConfirm] = useState('')
  const [regLoading, setRegLoading] = useState(false)
  /** inline error inside the register card (server 4xx / local validation) */
  const [regError, setRegError] = useState<string | null>(null)

  // Role list comes from the server so admin-approved custom service roles
  // (e.g. “Host”) appear automatically — built-ins stay as the fallback.
  useEffect(() => {
    if (!showRegister) return
    let cancelled = false
    apiFetch<{ roles: RegisterRoleOption[] }>('/api/auth/register', { method: 'GET' })
      .then((res) => {
        if (!cancelled && Array.isArray(res.roles) && res.roles.length > 0) {
          setRegRoles(res.roles)
        }
      })
      .catch(() => {
        // offline/fallback — the built-in list stays
      })
    return () => {
      cancelled = true
    }
  }, [showRegister])

  const roleOptionLabel = useCallback(
    (r: RegisterRoleOption) =>
      r.value === 'waiter'
        ? t('auth.registerRoleWaiter')
        : r.value === 'kitchen'
          ? t('auth.registerRoleKitchen')
          : r.label,
    [t],
  )

  const submitRegister = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (regLoading) return
      const name = regName.trim()
      if (name.length < 2) {
        setRegError(t('auth.registerNameShort'))
        return
      }
      if (!/^\d{6}$/.test(regPin)) {
        setRegError(t('auth.registerPinInvalid'))
        return
      }
      if (regPin !== regPinConfirm) {
        setRegError(t('auth.registerPinMismatch'))
        return
      }
      setRegLoading(true)
      setRegError(null)
      try {
        const { user, token, people } = await apiFetch<{
          user: SessionUser
          people?: { id: number; name: string }[]
          token?: string
        }>('/api/auth/register', {
          body: { name, pin: regPin, confirmPin: regPinConfirm, role: regRole },
        })
        toast.success(t('auth.registerSuccess', { name: user.name }))
        // identical shape to a login response → same post-login flow
        finishLogin(user, token, people ?? [])
      } catch (err) {
        setRegError(err instanceof Error ? err.message : t('auth.loginFailed'))
      } finally {
        setRegLoading(false)
      }
    },
    [finishLogin, regLoading, regName, regPin, regPinConfirm, regRole, t],
  )

  const openRegister = useCallback(() => {
    setRegError(null)
    setRegPin('')
    setRegPinConfirm('')
    setShowRegister(true)
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
  // The register form uses real inputs, so no keypad is active there.
  const keypadMode: 'login' | 'attendance' | null =
    topTab === 'checkin'
      ? attResult
        ? null
        : 'attendance'
      : showRegister || tab !== 'pin'
        ? null
        : 'login'

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

  if (pendingPeople) {
    return (
      <div className="grid min-h-screen w-full place-items-center bg-background p-4 sm:p-6">
        <div className="w-full max-w-md">
          <div className="bg-card flex w-full flex-col gap-6 rounded-xl border p-6 shadow-lg sm:p-8">
            {/* Brand header (same mark as the sign-in card) */}
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="bg-primary text-primary-foreground grid h-12 w-12 place-items-center rounded-lg shadow-sm">
                <UserCheck className="h-6 w-6" aria-hidden />
              </span>
              <div className="space-y-1">
                <h1 className="text-xl font-bold tracking-tight">{t('auth.whoIsUsing')}</h1>
                <p className="text-sm text-muted-foreground">{t('auth.whoIsUsingSub')}</p>
              </div>
            </div>

            {/* One tap per person — big touch targets for POS devices */}
            <div className="space-y-2" role="listbox" aria-label={t('auth.whoIsUsing')}>
              {pendingPeople.map((person) => {
                const busy = personLoadingId === person.id
                return (
                  <button
                    key={person.id}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => void selectLoginPerson(person)}
                    disabled={personLoadingId !== null}
                    className="flex min-h-14 w-full items-center gap-3 rounded-lg border bg-background px-4 py-3 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                  >
                    {busy ? (
                      <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden />
                    ) : (
                      <span className="bg-primary/10 text-primary grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold" aria-hidden>
                        {person.name.trim().charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="flex-1 truncate text-sm font-semibold">{person.name}</span>
                    <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => void selectLoginPerson(null)}
              disabled={personLoadingId !== null}
              className="rounded text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t('auth.continueAsAccount', { name: pendingAccountName })}
            </button>
          </div>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            {restaurantName} · {new Date().getFullYear()}
          </p>
        </div>
      </div>
    )
  }

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

          {/* R22: self-registration swaps the card body (tabs + demo list)
              for the create-account form — same card, same brand header. */}
          {showRegister ? (
            <form className="space-y-4" onSubmit={submitRegister} noValidate>
              <div className="space-y-1.5 text-center">
                <h2 className="text-lg font-bold tracking-tight">
                  {t('auth.registerTitle')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t('auth.registerSub')}
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-name">{t('auth.registerName')}</Label>
                <Input
                  id="reg-name"
                  type="text"
                  autoComplete="name"
                  placeholder={t('auth.registerNamePlaceholder')}
                  className="h-11"
                  maxLength={60}
                  value={regName}
                  onChange={(e) => {
                    setRegName(e.target.value)
                    if (regError) setRegError(null)
                  }}
                  aria-invalid={regError || undefined}
                  disabled={regLoading}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="reg-role">{t('auth.registerRole')}</Label>
                <Select value={regRole} onValueChange={setRegRole} disabled={regLoading}>
                  <SelectTrigger id="reg-role" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {regRoles.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {roleOptionLabel(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="reg-pin">{t('auth.registerPin')}</Label>
                  <Input
                    id="reg-pin"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    dir="ltr"
                    placeholder="••••••"
                    className="h-11 text-center font-mono text-lg tracking-[0.35em]"
                    maxLength={6}
                    value={regPin}
                    onChange={(e) => {
                      setRegPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                      if (regError) setRegError(null)
                    }}
                    aria-invalid={regError || undefined}
                    disabled={regLoading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reg-pin-confirm">{t('auth.registerPinConfirm')}</Label>
                  <Input
                    id="reg-pin-confirm"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    dir="ltr"
                    placeholder="••••••"
                    className="h-11 text-center font-mono text-lg tracking-[0.35em]"
                    maxLength={6}
                    value={regPinConfirm}
                    onChange={(e) => {
                      setRegPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 6))
                      if (regError) setRegError(null)
                    }}
                    aria-invalid={regError || undefined}
                    disabled={regLoading}
                  />
                </div>
              </div>

              {regError && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
                  role="alert"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{regError}</span>
                </div>
              )}

              <Button type="submit" className="h-11 w-full text-sm" disabled={regLoading}>
                {regLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {t('auth.registerCreating')}
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4" aria-hidden />
                    {t('auth.registerSubmit')}
                  </>
                )}
              </Button>

              <button
                type="button"
                onClick={() => setShowRegister(false)}
                disabled={regLoading}
                className="mx-auto flex min-h-8 items-center gap-1.5 rounded text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <LogIn className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden />
                {t('auth.registerBack')}
              </button>
            </form>
          ) : (
            <>
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

              {/* R22: self-registration entry point (service roles only —
                  admins are provisioned from the Users screen) */}
              <p className="pt-1 text-center text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={openRegister}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <UserPlus className="h-3.5 w-3.5" aria-hidden />
                  {t('auth.registerLink')}
                </button>
              </p>
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
            </>
          )}
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
