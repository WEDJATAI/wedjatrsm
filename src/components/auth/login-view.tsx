'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Delete,
  KeyRound,
  Loader2,
  Mail,
  UtensilsCrossed,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch, setSessionToken } from '@/lib/api'
import { RESTAURANT_NAME } from '@/lib/constants'
import type { SessionUser } from '@/lib/types'
import { cn } from '@/lib/utils'

const PIN_LENGTH = 4

const DEMO_ACCOUNTS: [string, string][] = [
  ['admin@rms.com', 'admin123'],
  ['waiter@rms.com', 'waiter123'],
  ['kitchen@rms.com', 'kitchen123'],
]

export default function LoginView({ onLogin }: { onLogin: () => void }) {
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
        toast.error('Please enter your email and password')
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
        toast.success(`Welcome back, ${user.name}`)
        onLogin()
      } catch (err) {
        setEmailError(true)
        toast.error(err instanceof Error ? err.message : 'Login failed')
      } finally {
        setEmailLoading(false)
      }
    },
    [email, emailLoading, onLogin, password],
  )

  // ── PIN quick login ──────────────────────────────────────────────
  const [tab, setTab] = useState<'email' | 'pin'>('email')
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
        toast.success(`Welcome back, ${user.name}`)
        onLogin()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Login failed')
        setPin('')
        setPinError(true)
        setShake(true)
        if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current)
        shakeTimer.current = window.setTimeout(() => {
          setShake(false)
          setPinError(false)
          shakeTimer.current = null
        }, 500)
      } finally {
        setPinLoading(false)
      }
    },
    [onLogin],
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

  // Keep latest handlers in a ref so the window keydown listener never goes stale
  const keyHandlersRef = useRef({ press: pressDigit, back: backspacePin, clear: clearPin })
  useEffect(() => {
    keyHandlersRef.current = { press: pressDigit, back: backspacePin, clear: clearPin }
  })

  // Physical keyboard support while the PIN tab is active
  useEffect(() => {
    if (tab !== 'pin') return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (e.repeat) return
      if (/^[0-9]$/.test(e.key)) keyHandlersRef.current.press(e.key)
      else if (e.key === 'Backspace') keyHandlersRef.current.back()
      else if (e.key === 'Escape') keyHandlersRef.current.clear()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tab])

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
        <div className="bg-card flex w-full flex-col gap-6 rounded-xl border p-8 shadow-lg">
          {/* Brand header — Odoo plum logo mark */}
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="bg-primary text-primary-foreground grid h-12 w-12 place-items-center rounded-lg shadow-sm">
              <UtensilsCrossed className="h-6 w-6" aria-hidden />
            </span>
            <div className="space-y-1">
              <h1 className="text-2xl font-bold tracking-tight">{RESTAURANT_NAME}</h1>
              <p className="text-sm text-muted-foreground">Restaurant Management System</p>
            </div>
          </div>

          <Tabs value={tab} onValueChange={(v) => setTab(v as 'email' | 'pin')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="email">
                <Mail className="h-4 w-4" aria-hidden />
                Email
              </TabsTrigger>
              <TabsTrigger value="pin">
                <KeyRound className="h-4 w-4" aria-hidden />
                PIN
              </TabsTrigger>
            </TabsList>

            {/* Email + password */}
            <TabsContent value="email" className="mt-4">
              <form className="space-y-4" onSubmit={handleEmailSubmit} noValidate>
                <div className="space-y-2">
                  <Label htmlFor="login-email">Email</Label>
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
                  <Label htmlFor="login-password">Password</Label>
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

                <Button type="submit" className="h-11 w-full text-sm" disabled={emailLoading}>
                  {emailLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      Signing in…
                    </>
                  ) : (
                    'Sign in'
                  )}
                </Button>
              </form>
            </TabsContent>

            {/* PIN keypad */}
            <TabsContent value="pin" className="mt-4">
              <div className="space-y-5">
                <div
                  className={cn('grid grid-cols-4 gap-3', shake && 'rms-shake')}
                  role="group"
                  aria-label={`PIN code, ${pin.length} of ${PIN_LENGTH} digits entered`}
                >
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                    <div
                      key={i}
                      className={cn(
                        'grid h-14 place-items-center rounded-xl border-2 text-2xl font-bold tabular-nums transition-colors',
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
                  <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground" role="status">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Signing in…
                  </p>
                )}

                <div className="grid grid-cols-3 gap-3">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <KeypadButton
                      key={digit}
                      label={`Digit ${digit}`}
                      disabled={pinLoading}
                      onClick={() => pressDigit(digit)}
                    >
                      {digit}
                    </KeypadButton>
                  ))}
                  <KeypadButton label="Clear PIN" disabled={pinLoading || pin.length === 0} onClick={clearPin}>
                    <X className="h-6 w-6" aria-hidden />
                  </KeypadButton>
                  <KeypadButton label="Digit 0" disabled={pinLoading} onClick={() => pressDigit('0')}>
                    0
                  </KeypadButton>
                  <KeypadButton label="Backspace" disabled={pinLoading || pin.length === 0} onClick={backspacePin}>
                    <Delete className="h-6 w-6" aria-hidden />
                  </KeypadButton>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* Demo credentials hint */}
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Demo credentials
            </p>
            <div className="space-y-1 font-mono text-xs text-muted-foreground">
              {DEMO_ACCOUNTS.map(([mail, pass]) => (
                <div key={mail}>
                  {mail} / {pass}
                </div>
              ))}
              <div className="mt-2 border-t pt-2">PINs: 1234 / 1111 / 2222</div>
            </div>
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          {RESTAURANT_NAME} · {new Date().getFullYear()}
        </p>
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
