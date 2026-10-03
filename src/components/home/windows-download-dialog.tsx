'use client'

// ─── r32/r34: Windows 10 agent download — password-gated dialog ──────
// Opened from the Launcher Home icon button. The .exe (built with
// `bun build --compile` — Bun runtime embedded, zero dependencies)
// installs itself on the PC, enrolls as a hybrid sync device and keeps
// GitHub · Vercel · Turso · Neon · Inngest in two-way sync automatically.
//
// r34: the download uses a NATIVE browser download (GET + signed link)
// instead of the old JS-blob path — blob downloads are silently blocked
// inside sandboxed preview iframes, which is why "the app didn't
// download". After the password is accepted the dialog keeps the direct
// link + the public GitHub mirror on screen so every context (embedded
// preview, full tab, another browser) has a working path.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Copy, Download, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'

import { getSessionToken } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** The classic 4-pane Windows mark (Lucide ships no brand logos). */
export function WindowsLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M3 5.7 10.6 4.6v6.9H3V5.7zm8.6-1.2L21 3.2v8.3h-9.4V4.5zM3 12.5h7.6v6.9L3 18.3v-5.8zm8.6 0H21v8.3l-9.4-1.3v-7z"
      />
    </svg>
  )
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '≈ 98 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type DownloadGrant = {
  url: string | null
  name: string
  size: number | null
  mirror: string
}

type WindowsDownloadDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function WindowsDownloadDialog({ open, onOpenChange }: WindowsDownloadDialogProps) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // r34: the accepted grant — the dialog switches to a "ready" state with
  // the direct link + mirror so the user always has a visible path.
  const [grant, setGrant] = useState<DownloadGrant | null>(null)
  const [copied, setCopied] = useState(false)

  // fresh state whenever the dialog re-opens
  useEffect(() => {
    if (open) {
      setPassword('')
      setError(null)
      setPending(false)
      setGrant(null)
      setCopied(false)
    }
  }, [open])

  const requestDownload = async () => {
    if (!password.trim() || pending) return
    setPending(true)
    setError(null)
    try {
      // session cookie + Bearer fallback (same contract as apiFetch — the
      // preview iframe is cross-site, cookies are not always sent back)
      const token = getSessionToken()
      const res = await fetch('/api/download/windows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `Download failed (${res.status})`)
      }
      const data = (await res.json()) as DownloadGrant
      setGrant(data)

      // native download attempt — a real anchor navigation to the signed
      // GET link (works in full tabs and download-capable iframes; the
      // visible links below cover every other context)
      const link = document.createElement('a')
      link.href = data.url ?? data.mirror
      link.download = data.name
      document.body.appendChild(link)
      link.click()
      link.remove()

      toast.success(t('home.windowsAppStarted'))
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      toast.error(message)
    } finally {
      setPending(false)
    }
  }

  const copyLink = async () => {
    if (!grant) return
    try {
      await navigator.clipboard.writeText(new URL(grant.url ?? grant.mirror, window.location.origin).toString())
      setCopied(true)
      toast.success(t('home.windowsAppCopied'))
      setTimeout(() => setCopied(false), 2500)
    } catch {
      toast.error(t('common.error'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="grid size-10 place-items-center rounded-xl bg-sky-600/10 text-sky-700">
              <WindowsLogo className="size-5" />
            </span>
            {t('home.windowsAppTitle')}
          </DialogTitle>
          <DialogDescription className="pt-1 leading-relaxed">
            {t('home.windowsAppDesc')}
          </DialogDescription>
        </DialogHeader>

        {!grant ? (
          <>
            <ul className="grid gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
              {(['one', 'two', 'three'] as const).map((k) => (
                <li key={k} className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>{t(`home.windowsAppFeature${k.charAt(0).toUpperCase()}${k.slice(1)}`)}</span>
                </li>
              ))}
            </ul>

            <div className="grid gap-2">
              <Label htmlFor="windows-download-password">{t('home.windowsAppPasswordLabel')}</Label>
              <Input
                id="windows-download-password"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                dir="ltr"
                className="h-11 rounded-xl text-center text-lg tracking-[0.4em]"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void requestDownload()
                }}
                placeholder="••••••"
                aria-invalid={error ? true : undefined}
              />
              {error && (
                <p className="text-sm font-medium text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                className="h-11 rounded-xl"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="h-11 rounded-xl font-semibold"
                disabled={pending || password.trim().length === 0}
                onClick={() => void requestDownload()}
              >
                {pending ? <Loader2 className="animate-spin" /> : <Download className="size-4" />}
                {pending ? t('home.windowsAppDownloading') : t('home.windowsAppDownload')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {/* r34: ready state — the download has been triggered; the
                direct link + GitHub mirror stay visible for every context */}
            <div className="flex items-start gap-3 rounded-xl border border-emerald-600/30 bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
              <p className="leading-relaxed">{t('home.windowsAppReady', { size: formatSize(grant.size) })}</p>
            </div>

            <div className="grid gap-2">
              {/* primary: real anchor → native browser download */}
              <Button asChild className="h-12 rounded-xl text-base font-semibold">
                <a href={grant.url ?? grant.mirror} download={grant.name}>
                  <Download className="size-5" />
                  {t('home.windowsAppSaveFile', { size: formatSize(grant.size) })}
                </a>
              </Button>

              {/* fallback: public GitHub Release mirror (always reachable) */}
              <Button asChild variant="outline" className="h-11 rounded-xl">
                <a href={grant.mirror} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                  {t('home.windowsAppMirror')}
                </a>
              </Button>

              {/* copyable link for stubborn contexts (e.g. strict iframes) */}
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  dir="ltr"
                  className="h-10 rounded-lg font-mono text-xs"
                  value={new URL(grant.url ?? grant.mirror, window.location.origin).toString()}
                  aria-label={t('home.windowsAppCopyLink')}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 rounded-lg px-3"
                  onClick={() => void copyLink()}
                  aria-label={t('home.windowsAppCopyLink')}
                >
                  {copied ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                </Button>
              </div>
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground" dir="auto">
              {t('home.windowsAppIframeHint')}
            </p>

            <DialogFooter>
              <Button variant="outline" className="h-11 rounded-xl" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        )}

        <p className="text-center text-xs text-muted-foreground" dir="auto">
          {t('home.windowsAppHint')}
        </p>
      </DialogContent>
    </Dialog>
  )
}
