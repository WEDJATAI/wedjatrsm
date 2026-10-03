'use client'

// ─── r32: Windows 10 agent download — password-gated dialog ──────────
// Opened from the Launcher Home icon button. The .exe (built with
// `bun build --compile` — Bun runtime embedded, zero dependencies)
// installs itself on the PC, enrolls as a hybrid sync device and keeps
// GitHub · Vercel · Turso · Neon · Inngest in two-way sync automatically.
// The download itself is gated server-side by WINDOWS_DOWNLOAD_PASSWORD.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Download, Loader2, ShieldCheck } from 'lucide-react'

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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

  // fresh state whenever the dialog re-opens
  useEffect(() => {
    if (open) {
      setPassword('')
      setError(null)
      setPending(false)
    }
  }, [open])

  const download = async () => {
    if (!password.trim() || pending) return
    setPending(true)
    setError(null)
    try {
      // binary POST — session cookie + Bearer fallback, same as apiFetchBlob
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
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'RSM-Windows-Agent-Setup.exe'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(t('home.windowsAppDone', { size: formatSize(blob.size) }))
      onOpenChange(false)
    } catch (err) {
      const message = (err as Error).message
      setError(message)
      toast.error(message)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
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
              if (e.key === 'Enter') void download()
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
            onClick={() => void download()}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Download className="size-4" />}
            {pending ? t('home.windowsAppDownloading') : t('home.windowsAppDownload')}
          </Button>
        </DialogFooter>

        <p className="text-center text-xs text-muted-foreground" dir="auto">
          {t('home.windowsAppHint')}
        </p>
      </DialogContent>
    </Dialog>
  )
}
