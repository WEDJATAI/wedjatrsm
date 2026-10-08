'use client'

// ─── R15: Download for Windows card (Settings) ──────────────────────
// Offline-first desktop deployment: explains the Windows package, lets
// the owner choose live vs demo data, downloads the ZIP via the
// authenticated blob helper (same pattern as backup downloads) and
// walks through the 5 setup steps. All strings via t() (r15-sync dict).

import { useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  CloudUpload,
  HardDrive,
  Laptop,
  Loader2,
  MonitorDown,
  WifiOff,
} from 'lucide-react'

import { apiFetchBlob } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

/** Human-readable file size: MB above 1 MB, else KB (matches backups card). */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type DataMode = 'live' | 'demo'

export function DesktopDownloadCard() {
  const { t } = useI18n()
  const [dataMode, setDataMode] = useState<DataMode>('live')
  const [downloading, setDownloading] = useState(false)

  /** Authenticated ZIP download — same flow as the backup .db download. */
  const downloadPackage = async () => {
    setDownloading(true)
    try {
      const blob = await apiFetchBlob(`/api/desktop/package?data=${dataMode}`)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'rsm-windows-x64.zip'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success(t('desktop.downloadDone', { size: formatSize(blob.size) }))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Card id="desktop-download-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorDown className="size-5 text-primary" aria-hidden />
          {t('desktop.title')}
        </CardTitle>
        <CardDescription>{t('desktop.subtitle')}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5">
        {/* ── benefits ── */}
        <ul className="grid gap-2 sm:grid-cols-3">
          <li className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3 text-sm">
            <WifiOff className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{t('desktop.benefit1')}</span>
          </li>
          <li className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3 text-sm">
            <HardDrive className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{t('desktop.benefit2')}</span>
          </li>
          <li className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3 text-sm">
            <CloudUpload className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{t('desktop.benefit3')}</span>
          </li>
        </ul>

        {/* ── data choice ── */}
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t('desktop.dataLabel')}</legend>
          <RadioGroup
            value={dataMode}
            onValueChange={(v) => setDataMode(v as DataMode)}
            className="grid gap-2 sm:grid-cols-2"
          >
            <div className="flex items-start gap-3 rounded-lg border p-3 has-[button[data-state=checked]]:border-primary/60 has-[button[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="live" id="desktop-data-live" className="mt-1" />
              <Label
                htmlFor="desktop-data-live"
                className="cursor-pointer text-sm font-medium leading-snug"
              >
                {t('desktop.dataLive')}
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {t('desktop.dataLiveHint')}
                </span>
              </Label>
            </div>
            <div className="flex items-start gap-3 rounded-lg border p-3 has-[button[data-state=checked]]:border-primary/60 has-[button[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="demo" id="desktop-data-demo" className="mt-1" />
              <Label
                htmlFor="desktop-data-demo"
                className="cursor-pointer text-sm font-medium leading-snug"
              >
                {t('desktop.dataDemo')}
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {t('desktop.dataDemoHint')}
                </span>
              </Label>
            </div>
          </RadioGroup>
        </fieldset>

        {/* ── download ── */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="h-11"
            disabled={downloading}
            onClick={() => void downloadPackage()}
          >
            {downloading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Laptop className="size-4" />
            )}
            {downloading ? t('desktop.downloading') : t('desktop.download')}
          </Button>
          <span className="text-xs text-muted-foreground" dir="ltr">
            rsm-windows-x64.zip
          </span>
        </div>

        {/* ── how to run (collapsible steps) ── */}
        <Collapsible className="rounded-lg border">
          <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 p-3 text-sm font-semibold hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <span className="flex items-center gap-2">
              <Laptop className="size-4 text-primary" aria-hidden />
              {t('desktop.howto')}
            </span>
            <ChevronDown
              className="size-4 shrink-0 transition-transform duration-200 group-data-[state=open]/collapsible-trigger:rotate-180"
              aria-hidden
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 border-t p-3">
            <ol className="list-decimal space-y-1.5 ps-5 text-sm">
              <li>{t('desktop.step1')}</li>
              <li>{t('desktop.step2')}</li>
              <li>{t('desktop.step3')}</li>
              <li>
                <span dir="ltr" className="font-mono text-xs">
                  {t('desktop.step4')}
                </span>
              </li>
              <li>{t('desktop.step5')}</li>
            </ol>
            <p className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground" dir="auto">
              {t('desktop.howtoNote')}
            </p>
            <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs font-medium text-primary" dir="auto">
              {t('desktop.howtoPointer')}
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
