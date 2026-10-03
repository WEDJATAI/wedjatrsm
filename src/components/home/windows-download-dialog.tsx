'use client'

// ─── r32/r34: Windows 10 agent download — password-gated dialog ──────
// ─── r36: generalized to DesktopDownloadDialog — the same dialog serves
// the macOS (Intel x64) agent download. Opened from the Launcher Home
// icon buttons. Both agents (built with `bun build --compile` — the Bun
// runtime embedded, zero dependencies) install themselves, enroll as a
// hybrid sync device and keep GitHub · Vercel · Turso · Neon · Inngest
// in two-way sync automatically.
//
// r34: the download uses a NATIVE browser download (GET + signed link)
// instead of the old JS-blob path — blob downloads are silently blocked
// inside sandboxed preview iframes, which is why "the app didn't
// download". After the password is accepted the dialog keeps the direct
// link + the public GitHub mirror on screen so every context (embedded
// preview, full tab, another browser) has a working path.
//
// r36 macOS notes: the artifact is a .zip containing the installer app;
// the ready state carries the one-time Gatekeeper instructions (the
// agent is not notarized — right-click → Open, or the copyable Terminal
// command) because macOS blocks unsigned downloads exactly once.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Copy, Download, ExternalLink, Loader2, ShieldCheck, TerminalSquare } from 'lucide-react'

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

export type DesktopPlatform = 'windows' | 'macos'

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

/** The Apple silhouette (Lucide ships no brand logos). */
export function AppleLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M17.05 12.54c-.03-2.89 2.36-4.27 2.47-4.34-1.34-1.96-3.43-2.23-4.18-2.26-1.78-.18-3.47 1.05-4.37 1.05-.9 0-2.29-1.02-3.77-1-1.94.03-3.72 1.13-4.72 2.86-2.01 3.49-.51 8.66 1.45 11.49.96 1.38 2.1 2.93 3.6 2.87 1.45-.06 2-.93 3.74-.93s2.24.93 3.77.9c1.56-.03 2.55-1.41 3.5-2.8 1.1-1.61 1.55-3.16 1.58-3.24-.04-.02-3.03-1.16-3.07-4.6zM14.16 4.06c.8-.97 1.34-2.31 1.19-3.66-1.17.05-2.6.78-3.43 1.75-.74.86-1.39 2.23-1.22 3.55 1.31.1 2.65-.67 3.46-1.64z"
      />
    </svg>
  )
}

function formatSize(bytes: number | null, platform: DesktopPlatform): string {
  if (bytes == null) return platform === 'macos' ? '≈ 27 MB' : '≈ 98 MB'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type DownloadGrant = {
  url: string | null
  name: string
  size: number | null
  mirror: string
}

type DesktopDownloadDialogProps = {
  platform: DesktopPlatform
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DesktopDownloadDialog({ platform, open, onOpenChange }: DesktopDownloadDialogProps) {
  const { t } = useI18n()
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // r34: the accepted grant — the dialog switches to a "ready" state with
  // the direct link + mirror so the user always has a visible path.
  const [grant, setGrant] = useState<DownloadGrant | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedCmd, setCopiedCmd] = useState(false)

  const isMac = platform === 'macos'
  const k = (key: string, vars?: Record<string, string | number>) => t(`home.${platform}App${key}`, vars)

  // fresh state whenever the dialog re-opens
  useEffect(() => {
    if (open) {
      setPassword('')
      setError(null)
      setPending(false)
      setGrant(null)
      setCopied(false)
      setCopiedCmd(false)
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
      const res = await fetch(`/api/download/${platform}`, {
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

      toast.success(k('Started'))
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
      toast.success(k('Copied'))
      setTimeout(() => setCopied(false), 2500)
    } catch {
      toast.error(t('common.error'))
    }
  }

  const copyTerminalCommand = async () => {
    try {
      await navigator.clipboard.writeText(k('TerminalCmd'))
      setCopiedCmd(true)
      toast.success(k('TerminalCopied'))
      setTimeout(() => setCopiedCmd(false), 2500)
    } catch {
      toast.error(t('common.error'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span
              className={
                isMac
                  ? 'grid size-10 place-items-center rounded-xl bg-stone-500/10 text-stone-600 dark:text-stone-300'
                  : 'grid size-10 place-items-center rounded-xl bg-sky-600/10 text-sky-700'
              }
            >
              {isMac ? <AppleLogo className="size-5" /> : <WindowsLogo className="size-5" />}
            </span>
            {k('Title')}
          </DialogTitle>
          <DialogDescription className="pt-1 leading-relaxed">{k('Desc')}</DialogDescription>
        </DialogHeader>

        {!grant ? (
          <>
            <ul className="grid gap-2 rounded-xl border bg-muted/30 p-3 text-sm">
              {(['FeatureOne', 'FeatureTwo', 'FeatureThree'] as const).map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                  <span>{k(key)}</span>
                </li>
              ))}
            </ul>

            <div className="grid gap-2">
              <Label htmlFor={`${platform}-download-password`}>{k('PasswordLabel')}</Label>
              <Input
                id={`${platform}-download-password`}
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
                {pending ? k('Downloading') : k('Download')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {/* r34: ready state — the download has been triggered; the
                direct link + GitHub mirror stay visible for every context */}
            <div className="flex items-start gap-3 rounded-xl border border-emerald-600/30 bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-400">
              <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
              <p className="leading-relaxed">{k('Ready', { size: formatSize(grant.size, platform) })}</p>
            </div>

            <div className="grid gap-2">
              {/* primary: real anchor → native browser download */}
              <Button asChild className="h-12 rounded-xl text-base font-semibold">
                <a href={grant.url ?? grant.mirror} download={grant.name}>
                  <Download className="size-5" />
                  {k('SaveFile', { size: formatSize(grant.size, platform) })}
                </a>
              </Button>

              {/* fallback: public GitHub Release mirror (always reachable) */}
              <Button asChild variant="outline" className="h-11 rounded-xl">
                <a href={grant.mirror} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                  {k('Mirror')}
                </a>
              </Button>

              {/* copyable link for stubborn contexts (e.g. strict iframes) */}
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  dir="ltr"
                  className="h-10 rounded-lg font-mono text-xs"
                  value={new URL(grant.url ?? grant.mirror, window.location.origin).toString()}
                  aria-label={k('CopyLink')}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 shrink-0 rounded-lg px-3"
                  onClick={() => void copyLink()}
                  aria-label={k('CopyLink')}
                >
                  {copied ? <CheckCircle2 className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                </Button>
              </div>
            </div>

            {/* r36: macOS one-time first-run instructions (Gatekeeper:
                unsigned download → right-click Open / Open Anyway / the
                copyable Terminal command that works on every version) */}
            {isMac && (
              <div className="grid gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
                <p className="font-semibold">{k('FirstRunTitle')}</p>
                <ol className="list-decimal space-y-1.5 ps-5 leading-relaxed">
                  <li>{k('Step1')}</li>
                  <li>{k('Step2')}</li>
                  <li>{k('Step3')}</li>
                </ol>
                <p className="text-xs text-muted-foreground">{k('TerminalLabel')}</p>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    dir="ltr"
                    className="h-10 rounded-lg bg-background font-mono text-[11px]"
                    value={k('TerminalCmd')}
                    aria-label={k('TerminalLabel')}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0 rounded-lg px-3"
                    onClick={() => void copyTerminalCommand()}
                    aria-label={k('TerminalLabel')}
                  >
                    {copiedCmd ? (
                      <CheckCircle2 className="size-4 text-emerald-600" />
                    ) : (
                      <TerminalSquare className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            )}

            <p className="text-xs leading-relaxed text-muted-foreground" dir="auto">
              {k('IframeHint')}
            </p>

            <DialogFooter>
              <Button variant="outline" className="h-11 rounded-xl" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </>
        )}

        <p className="text-center text-xs text-muted-foreground" dir="auto">
          {k('Hint')}
        </p>
      </DialogContent>
    </Dialog>
  )
}

/** r32/r34 back-compat wrapper — the Windows flavor of the dialog. */
export function WindowsDownloadDialog(props: Omit<DesktopDownloadDialogProps, 'platform'>) {
  return <DesktopDownloadDialog {...props} platform="windows" />
}
