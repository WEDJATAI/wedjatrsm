'use client'

// ─── R13: Integrations hub (admin) ───────────────────────────────────
// Three cards: (1) delivery-aggregator webhook — key generation, endpoint
// URL + copy, request docs, live "send test order" and the recent webhook
// orders; (2) loyalty rules — enable + earn/redeem rates with a live
// preview; (3) ETA e-invoicing — taxpayer fields + a date-range JSON
// export of closed checks as submission-ready documents.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BadgeCheck,
  Copy,
  Download,
  FileJson,
  KeyRound,
  Loader2,
  Plug,
  Send,
  Sparkles,
  Webhook,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { Order } from '@/lib/types'

type IntegrationsState = {
  loyalty: { enabled: boolean; pointsPerEgp: number; egpPerPoint: number }
  deliveryWebhook: {
    key: string | null
    recentOrders: {
      id: number
      externalRef: string | null
      clientName: string | null
      deliveryPhone: string | null
      totalAmount: number
      status: string
      createdAt: string
    }[]
  }
  eta: { registrationNumber: string; address: string }
}

type InvoiceExport = {
  count: number
  totals: { netAmount: number; taxAmount: number; totalAmount: number }
  invoices: unknown[]
}

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export default function IntegrationsView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['integrations'],
    queryFn: () => fetcher<IntegrationsState>('/api/integrations'),
  })

  // ── loyalty form ──
  const [loyaltyEnabled, setLoyaltyEnabled] = useState<boolean | null>(null)
  const [pointsPerEgp, setPointsPerEgp] = useState('')
  const [egpPerPoint, setEgpPerPoint] = useState('')

  // ── ETA form ──
  const [etaReg, setEtaReg] = useState('')
  const [etaAddress, setEtaAddress] = useState('')
  const [fromValue, setFromValue] = useState(() => toLocalInputValue(new Date(Date.now() - 7 * 86400000)))
  const [toValue, setToValue] = useState(() => toLocalInputValue(new Date()))
  const [invoiceExport, setInvoiceExport] = useState<InvoiceExport | null>(null)

  // hydrate the form once data arrives (null = untouched → server value)
  const hydrated = data != null && loyaltyEnabled === null && pointsPerEgp === ''
  if (hydrated && data) {
    setLoyaltyEnabled(data.loyalty.enabled)
    setPointsPerEgp(String(data.loyalty.pointsPerEgp))
    setEgpPerPoint(String(data.loyalty.egpPerPoint))
    setEtaReg(data.eta.registrationNumber)
    setEtaAddress(data.eta.address)
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<IntegrationsState>('/api/integrations', { method: 'PUT', body }),
    onSuccess: async (fresh) => {
      toast.success(t('integrations.saved'))
      setLoyaltyEnabled(fresh.loyalty.enabled)
      setPointsPerEgp(String(fresh.loyalty.pointsPerEgp))
      setEgpPerPoint(String(fresh.loyalty.egpPerPoint))
      setEtaReg(fresh.eta.registrationNumber)
      setEtaAddress(fresh.eta.address)
      await queryClient.invalidateQueries({ queryKey: ['integrations'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const saveLoyalty = () =>
    saveMutation.mutate({
      loyalty: {
        enabled: loyaltyEnabled ?? true,
        pointsPerEgp: Number(pointsPerEgp) || 0,
        egpPerPoint: Number(egpPerPoint) || 1,
      },
    })

  const saveEta = () =>
    saveMutation.mutate({ eta: { registrationNumber: etaReg, address: etaAddress } })

  const regenerateKey = () => saveMutation.mutate({ regenerateWebhookKey: true })

  // ── test webhook (real POST through the public endpoint) ──
  const [testing, setTesting] = useState(false)
  const webhookKey = data?.deliveryWebhook.key ?? null
  const endpointUrl = useMemo(
    () => (typeof window === 'undefined' ? '' : `${window.location.origin}/api/integrations/delivery/webhook`),
    [],
  )

  const sendTestOrder = async () => {
    if (!webhookKey || testing) return
    setTesting(true)
    try {
      const res = await fetch(endpointUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-rsm-key': webhookKey },
        body: JSON.stringify({
          provider: 'generic',
          externalId: `rsm-test-${new Date().toISOString().slice(0, 10)}`,
          customerName: 'Webhook Test',
          customerPhone: '01000000000',
          address: 'Test order from the Integrations screen',
          items: [{ name: 'Koshari', quantity: 1 }],
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        order?: Order
        duplicate?: boolean
        error?: string
      }
      if (!res.ok) throw new Error(payload.error ?? `HTTP ${res.status}`)
      toast.success(payload.duplicate ? t('integrations.delivery.testDup') : t('integrations.delivery.testOk'))
      await queryClient.invalidateQueries({ queryKey: ['integrations'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    } catch (err) {
      toast.error(t('integrations.delivery.testFail', { error: err instanceof Error ? err.message : '—' }))
    } finally {
      setTesting(false)
    }
  }

  const exportMutation = useMutation({
    mutationFn: () =>
      fetcher<InvoiceExport>(
        `/api/invoices?from=${encodeURIComponent(`${fromValue}T00:00:00`)}&to=${encodeURIComponent(`${toValue}T23:59:59`)}`,
      ),
    onSuccess: (payload) => {
      setInvoiceExport(payload)
      if (payload.count === 0) toast.info(t('integrations.eta.noInvoices'))
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const downloadJson = () => {
    if (!invoiceExport) return
    const blob = new Blob([JSON.stringify(invoiceExport, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `rsm-eta-invoices-${fromValue}-to-${toValue}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('integrations.delivery.copied'))
    } catch {
      toast.error('Clipboard unavailable')
    }
  }

  const loyaltyPreview = (() => {
    const perEgp = Number(pointsPerEgp) || 0
    const perPoint = Number(egpPerPoint) || 0
    return {
      earned: (500 * perEgp).toFixed(perEgp < 1 ? 1 : 0),
      redeem: formatCurrency(50 * perPoint),
    }
  })()

  return (
    <section className="flex-1 space-y-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-[#714B67] text-white shadow">
          <Plug className="size-6" aria-hidden />
        </div>
        <div>
          <h1 className="text-xl font-bold">{t('integrations.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('integrations.subtitle')}</p>
        </div>
      </div>

      {isLoading || data == null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* ── Card 1: delivery webhook ── */}
          <Card className="space-y-4 p-4 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <Webhook className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold">{t('integrations.delivery.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('integrations.delivery.desc')}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-endpoint">{t('integrations.delivery.endpointLabel')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="webhook-endpoint"
                    readOnly
                    value={endpointUrl}
                    className="h-11 font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11 shrink-0"
                    aria-label={t('integrations.delivery.copied')}
                    onClick={() => void copy(endpointUrl)}
                  >
                    <Copy className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="webhook-key">{t('integrations.delivery.keyLabel')}</Label>
                {webhookKey ? (
                  <div className="flex gap-2">
                    <Input
                      id="webhook-key"
                      readOnly
                      value={webhookKey}
                      className="h-11 font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-11 shrink-0"
                      aria-label={t('integrations.delivery.copied')}
                      onClick={() => void copy(webhookKey)}
                    >
                      <Copy className="size-4" aria-hidden />
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    className="h-11 w-full rounded-xl bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
                    disabled={saveMutation.isPending}
                    onClick={regenerateKey}
                  >
                    <KeyRound className="size-4" aria-hidden />
                    {t('integrations.delivery.generate')}
                  </Button>
                )}
              </div>
            </div>

            {webhookKey && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-xl"
                  disabled={saveMutation.isPending}
                  onClick={regenerateKey}
                >
                  <KeyRound className="size-4" aria-hidden />
                  {t('integrations.delivery.regenerate')}
                </Button>
                <Button
                  type="button"
                  className="h-11 rounded-xl bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
                  disabled={testing}
                  onClick={() => void sendTestOrder()}
                >
                  {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" aria-hidden />}
                  {testing ? t('integrations.delivery.testing') : t('integrations.delivery.testBtn')}
                </Button>
              </div>
            )}

            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠️ {t('integrations.delivery.keyWarning')}
            </p>

            {/* request format */}
            <details className="rounded-lg border border-[#E2E2E0] bg-muted/30 p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                {t('integrations.delivery.docsTitle')}
              </summary>
              <pre className="rms-scroll mt-2 max-h-56 overflow-auto rounded-md bg-zinc-900 p-3 text-[11px] leading-relaxed text-zinc-100" dir="ltr">
{`POST ${endpointUrl || '/api/integrations/delivery/webhook'}
x-rsm-key: <${t('integrations.delivery.keyLabel')}>

{
  "provider": "talabat" | "elmenus" | "generic",
  "externalId": "platform-order-123",     // idempotency key
  "customerName": "Ahmed Mohamed",
  "customerPhone": "01001234567",
  "address": "12 Tahrir St, Dokki",
  "items": [
    { "name": "Koshari", "quantity": 2 },
    { "sku": "SHI-01",  "quantity": 1 }   // matches by name (EN/AR), SKU or productId
  ]
}`}
              </pre>
            </details>

            {/* recent webhook orders */}
            <div>
              <p className="mb-2 text-sm font-semibold">{t('integrations.delivery.recent')}</p>
              {data.deliveryWebhook.recentOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('integrations.delivery.noOrders')}</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.deliveryWebhook.recentOrders.map((o) => (
                    <li
                      key={o.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#E2E2E0] bg-white px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-semibold">#{o.id}</span> · {o.clientName ?? '—'}
                        <span className="ms-2 text-xs text-muted-foreground">{o.externalRef}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{formatCurrency(o.totalAmount)}</span>
                        <Badge variant="outline" className="capitalize">{o.status}</Badge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          {/* ── Card 2: loyalty rules ── */}
          <Card className="space-y-4 p-4 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[#714B67]/15 text-[#714B67]">
                <Sparkles className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold">{t('integrations.loyalty.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('integrations.loyalty.desc')}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-[#E2E2E0] bg-white px-3">
                <span className="text-sm font-medium">{t('integrations.loyalty.enabled')}</span>
                <Switch
                  checked={loyaltyEnabled ?? true}
                  onCheckedChange={setLoyaltyEnabled}
                  aria-label={t('integrations.loyalty.enabled')}
                />
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="points-per-egp">{t('integrations.loyalty.pointsPerEgp')}</Label>
                <Input
                  id="points-per-egp"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={pointsPerEgp}
                  onChange={(e) => setPointsPerEgp(e.target.value)}
                  className="h-11"
                  disabled={loyaltyEnabled === null}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="egp-per-point">{t('integrations.loyalty.egpPerPoint')}</Label>
                <Input
                  id="egp-per-point"
                  type="number"
                  min={0.05}
                  max={50}
                  step={0.25}
                  value={egpPerPoint}
                  onChange={(e) => setEgpPerPoint(e.target.value)}
                  className="h-11"
                  disabled={loyaltyEnabled === null}
                />
              </div>
            </div>

            <p className="rounded-lg bg-[#714B67]/[0.06] px-3 py-2 text-sm text-[#714B67]">
              {t('integrations.loyalty.preview', loyaltyPreview)}
            </p>

            <Button
              type="button"
              className="h-11 rounded-xl bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
              disabled={saveMutation.isPending || loyaltyEnabled === null}
              onClick={saveLoyalty}
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" aria-hidden />}
              {t('customers.save')}
            </Button>
          </Card>

          {/* ── Card 3: ETA e-invoicing ── */}
          <Card className="space-y-4 p-4 sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700">
                <FileJson className="size-5" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="font-bold">{t('integrations.eta.title')}</h2>
                <p className="text-sm text-muted-foreground">{t('integrations.eta.desc')}</p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="eta-reg">{t('integrations.eta.reg')}</Label>
                <Input
                  id="eta-reg"
                  value={etaReg}
                  onChange={(e) => setEtaReg(e.target.value)}
                  maxLength={30}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eta-address">{t('integrations.eta.address')}</Label>
                <Input
                  id="eta-address"
                  value={etaAddress}
                  onChange={(e) => setEtaAddress(e.target.value)}
                  maxLength={200}
                  className="h-11"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-xl"
              disabled={saveMutation.isPending}
              onClick={saveEta}
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <BadgeCheck className="size-4" aria-hidden />}
              {t('customers.save')}
            </Button>

            <div className="grid gap-3 rounded-xl border border-[#E2E2E0] bg-muted/30 p-3 sm:grid-cols-[1fr_1fr_auto]">
              <div className="space-y-1.5">
                <Label htmlFor="eta-from">{t('integrations.eta.from')}</Label>
                <Input
                  id="eta-from"
                  type="date"
                  value={fromValue}
                  onChange={(e) => setFromValue(e.target.value)}
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="eta-to">{t('integrations.eta.to')}</Label>
                <Input
                  id="eta-to"
                  type="date"
                  value={toValue}
                  onChange={(e) => setToValue(e.target.value)}
                  className="h-11"
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  className="h-11 rounded-xl bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
                  disabled={exportMutation.isPending}
                  onClick={() => exportMutation.mutate()}
                >
                  {exportMutation.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <FileJson className="size-4" aria-hidden />
                  )}
                  {exportMutation.isPending ? t('integrations.eta.exporting') : t('integrations.eta.export')}
                </Button>
              </div>
            </div>

            {invoiceExport && invoiceExport.count > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="text-sm font-medium text-emerald-800">
                  {t('integrations.eta.summary', {
                    n: invoiceExport.count,
                    net: invoiceExport.totals.netAmount.toFixed(2),
                    tax: invoiceExport.totals.taxAmount.toFixed(2),
                    total: invoiceExport.totals.totalAmount.toFixed(2),
                  })}
                </p>
                <Button
                  type="button"
                  className="h-11 rounded-xl bg-emerald-600 font-semibold text-white hover:bg-emerald-700"
                  onClick={downloadJson}
                >
                  <Download className="size-4" aria-hidden />
                  {t('integrations.eta.download')}
                </Button>
              </div>
            )}

            <p className="text-xs text-muted-foreground">{t('integrations.eta.note')}</p>
          </Card>
        </>
      )}
    </section>
  )
}
