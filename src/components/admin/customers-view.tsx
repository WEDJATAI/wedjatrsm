'use client'

// ─── R13: Customers & Loyalty (admin) ────────────────────────────────
// The loyalty directory: profiles with visits / points / total spend,
// search, create + edit (name/phone/notes), manual points adjustments
// (reason required → audit log), and a per-customer detail dialog with
// recent orders + upcoming reservations. The POS attaches customers to
// orders; this screen is where the program is understood and maintained.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Loader2,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Search,
  Sparkles,
  UserRound,
  UserRoundPlus,
  Wallet,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { Customer, Order, Reservation } from '@/lib/types'
import { cn } from '@/lib/utils'

export default function CustomersView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null) // null = create
  const [detailId, setDetailId] = useState<number | null>(null)

  // form state (create / edit)
  const [formName, setFormName] = useState('')
  const [formPhone, setFormPhone] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [pointsDelta, setPointsDelta] = useState('')
  const [pointsReason, setPointsReason] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['customers', 'admin', search, showAll],
    queryFn: () =>
      fetcher<{ customers: Customer[] }>(
        `/api/customers?q=${encodeURIComponent(search)}&limit=50${showAll ? '&all=1' : ''}`,
      ),
    staleTime: 15_000,
  })

  const customers = useMemo(() => data?.customers ?? [], [data])

  const detailQuery = useQuery({
    queryKey: ['customers', 'detail', detailId],
    queryFn: () => fetcher<{ customer: Customer }>(`/api/customers/${detailId}`),
    enabled: detailId != null,
    staleTime: 10_000,
  })

  const openCreate = () => {
    setEditing(null)
    setFormName('')
    setFormPhone('')
    setFormNotes('')
    setPointsDelta('')
    setPointsReason('')
    setEditOpen(true)
  }

  const openEdit = (customer: Customer) => {
    setEditing(customer)
    setFormName(customer.name)
    setFormPhone(customer.phone ?? '')
    setFormNotes(customer.notes ?? '')
    setPointsDelta('')
    setPointsReason('')
    setEditOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: formName,
        phone: formPhone.trim() || null,
        notes: formNotes.trim() || null,
        ...(editing?.active === false ? { active: true } : {}),
      }
      if (pointsDelta.trim()) {
        body.pointsAdjust = { delta: Number(pointsDelta), reason: pointsReason }
      }
      return apiFetch<{ customer: Customer }>(
        editing ? `/api/customers/${editing.id}` : '/api/customers',
        { method: editing ? 'PUT' : 'POST', body },
      )
    },
    onSuccess: async () => {
      toast.success(t('customers.saved'))
      setEditOpen(false)
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleActive = useMutation({
    mutationFn: (customer: Customer) =>
      apiFetch<{ customer: Customer }>(`/api/customers/${customer.id}`, {
        method: 'PUT',
        body: { active: !customer.active },
      }),
    onSuccess: async ({ customer }) => {
      toast.success(customer.active ? t('customers.activate') : t('customers.deactivate'))
      await queryClient.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const canSave =
    formName.trim().length >= 2 &&
    (!pointsDelta.trim() || (Number(pointsDelta) !== 0 && pointsReason.trim().length >= 3))

  return (
    <section className="flex-1 space-y-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-[#714B67] text-white shadow">
            <UserRound className="size-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('customers.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('customers.subtitle', { n: customers.length })}
            </p>
          </div>
        </div>
        <Button
          onClick={openCreate}
          className="h-11 rounded-xl bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
        >
          <UserRoundPlus className="size-4" aria-hidden />
          {t('customers.new')}
        </Button>
      </div>

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('customers.searchPh')}
            className="h-11 ps-9"
            inputMode="search"
          />
        </div>
        <label className="flex h-11 cursor-pointer items-center gap-2 rounded-xl border border-[#E2E2E0] bg-white px-3 text-sm font-medium">
          <Switch checked={showAll} onCheckedChange={setShowAll} aria-label={t('customers.activeOnly')} />
          {t('customers.activeOnly')}
        </label>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : customers.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          <UserRound className="size-12 text-muted-foreground/40" aria-hidden />
          <p className="font-medium text-muted-foreground">{t('customers.empty')}</p>
          {/* R13: empty-state coaching */}
          <p className="max-w-md text-sm text-muted-foreground/80">{t('customers.emptyHint')}</p>
          <Button onClick={openCreate} variant="outline" className="h-11 rounded-xl">
            <Plus className="size-4" aria-hidden />
            {t('customers.new')}
          </Button>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {customers.map((c) => (
            <Card key={c.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setDetailId(c.id)}
                  className="min-w-0 flex-1 text-start"
                  title={t('customers.recentOrders')}
                >
                  <p className="truncate font-semibold">{c.name}</p>
                  <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <Phone className="size-3 shrink-0" aria-hidden />
                    {c.phone ?? '—'}
                  </p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={() => openEdit(c)}
                  aria-label={t('customers.edit')}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-muted/60 px-1.5 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t('customers.visits')}
                  </p>
                  <p className="text-sm font-bold tabular-nums">{c.visits}</p>
                </div>
                <div className="rounded-lg bg-[#714B67]/[0.08] px-1.5 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[#714B67]/80">
                    {t('customers.points')}
                  </p>
                  <p className="flex items-center justify-center gap-1 text-sm font-bold tabular-nums text-[#714B67]">
                    <Sparkles className="size-3" aria-hidden />
                    {c.points}
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-50 px-1.5 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-emerald-700/80">
                    {t('customers.totalSpent')}
                  </p>
                  <p className="text-sm font-bold tabular-nums text-emerald-700">
                    {formatCurrency(c.totalSpent)}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {t('customers.lastVisit')}:{' '}
                  {c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : t('customers.never')}
                </span>
                {!c.active && <Badge variant="secondary">{t('customers.inactive')}</Badge>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t('customers.edit') : t('customers.create')}</DialogTitle>
            <DialogDescription>{t('customers.emptyHint')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="customer-name">{t('customers.name')}</Label>
              <Input
                id="customer-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                maxLength={60}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customer-phone">{t('customers.phone')}</Label>
              <Input
                id="customer-phone"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                maxLength={20}
                inputMode="tel"
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="customer-notes">{t('customers.notes')}</Label>
              <Textarea
                id="customer-notes"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                rows={2}
                maxLength={300}
              />
            </div>

            {/* manual points adjustment (edit only) */}
            {editing && (
              <div className="space-y-2 rounded-xl border border-[#714B67]/25 bg-[#714B67]/[0.04] p-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-[#714B67]">
                  <Sparkles className="size-4" aria-hidden />
                  {t('customers.adjustPoints')}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="points-delta" className="text-xs">
                      {t('customers.pointsDelta')}
                    </Label>
                    <Input
                      id="points-delta"
                      type="number"
                      step="1"
                      value={pointsDelta}
                      onChange={(e) => setPointsDelta(e.target.value)}
                      placeholder="±0"
                      className="h-10"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="points-reason" className="text-xs">
                      {t('customers.reason')}
                    </Label>
                    <Input
                      id="points-reason"
                      value={pointsReason}
                      onChange={(e) => setPointsReason(e.target.value)}
                      placeholder={t('customers.reasonPh')}
                      maxLength={200}
                      className="h-10"
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('customers.points')}: {editing.points} →{' '}
                  <span className="font-semibold tabular-nums text-[#714B67]">
                    {pointsDelta.trim() ? (editing.points + Number(pointsDelta)).toFixed(0) : editing.points}
                  </span>
                </p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            {editing && (
              <Button
                type="button"
                variant="outline"
                className="h-11"
                disabled={toggleActive.isPending}
                onClick={() => toggleActive.mutate(editing)}
              >
                {editing.active ? t('customers.deactivate') : t('customers.activate')}
              </Button>
            )}
            <Button
              type="button"
              className="h-11 bg-[#714B67] font-semibold text-white hover:bg-[#714B67]/90"
              disabled={saveMutation.isPending || !canSave}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : t('customers.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog — recent orders + upcoming reservations */}
      <Dialog open={detailId != null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserRound className="size-5 text-[#714B67]" aria-hidden />
              {detailQuery.data?.customer.name ?? '…'}
            </DialogTitle>
            <DialogDescription>
              {detailQuery.data?.customer.phone ??
                ''}{' '}
              {detailQuery.data?.customer.phone ? '· ' : ''}
              {t('customers.points')}: {detailQuery.data?.customer.points ?? 0} ·{' '}
              {t('customers.visits')}: {detailQuery.data?.customer.visits ?? 0}
            </DialogDescription>
          </DialogHeader>

          {detailQuery.isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-4">
              <section>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <Receipt className="size-4 text-muted-foreground" aria-hidden />
                  {t('customers.recentOrders')}
                </p>
                {(detailQuery.data?.customer.orders ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {(detailQuery.data?.customer.orders ?? []).map((order: Order) => (
                      <li
                        key={order.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[#E2E2E0] bg-white px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          #{order.id} · {new Date(order.createdAt).toLocaleDateString()}
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums">{formatCurrency(order.totalAmount)}</span>
                          <Badge
                            variant="outline"
                            className={cn(
                              order.status === 'paid' && 'border-emerald-300 text-emerald-700',
                              order.status === 'open' && 'border-amber-300 text-amber-700',
                              order.status === 'deferred' && 'border-violet-300 text-violet-700',
                            )}
                          >
                            {order.status}
                          </Badge>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <Wallet className="size-4 text-muted-foreground" aria-hidden />
                  {t('customers.upcomingRes')}
                </p>
                {(detailQuery.data?.customer.reservations ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">—</p>
                ) : (
                  <ul className="space-y-1.5">
                    {(detailQuery.data?.customer.reservations ?? []).map((res: Reservation) => (
                      <li
                        key={res.id}
                        className="flex items-center justify-between gap-2 rounded-lg border border-[#E2E2E0] bg-white px-3 py-2 text-sm"
                      >
                        <span className="font-medium">
                          {new Date(res.reservedAt).toLocaleString()}
                        </span>
                        <Badge variant="outline">{res.partySize} pax</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
