'use client'

// ─── R29: Customers CRM Pro (admin) ──────────────────────────────────
// The loyalty directory, promoted to a working CRM:
//   · KPI insight row — active / VIP / at-risk / new / tracked revenue
//     (one tap on a KPI jumps straight to that segment)
//   · smart segments — All · VIP · At risk · New · Inactive with counts
//   · tier system — Bronze → Silver → Gold → Diamond, graded from
//     lifetime spend (computed, never stored — upgrades itself the
//     moment a check closes) with a progress bar to the next tier
//   · rich profiles — hero identity, stat grid, guest notes, full
//     order history (server · table · items · points) + reservations
//   · outreach — call / WhatsApp one tap from every card
// Same warm identity system as the Team Wall (shared person-style lib).

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUpDown,
  Banknote,
  Cake,
  CalendarCheck,
  Crown,
  Gem,
  Loader2,
  Medal,
  MessageCircle,
  Pencil,
  Phone,
  Plus,
  Receipt,
  Search,
  Sparkles,
  TriangleAlert,
  UserRound,
  UserRoundPlus,
  Users,
  Wallet,
  type LucideIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency, formatDate } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import {
  avatarColor,
  initialsOf,
  isVipTier,
  nextTierProgress,
  telHref,
  tierOf,
  whatsappHref,
  type TierDef,
} from '@/lib/person-style'
import type { Customer, Order, Reservation } from '@/lib/types'
import { cn } from '@/lib/utils'

// ── segment + sort model ─────────────────────────────────────────────
type Segment = 'all' | 'vip' | 'atrisk' | 'new' | 'inactive'
type SortKey = 'lastVisit' | 'spend' | 'visits' | 'points'

/** A guest has lapsed when their last visit is 30+ days old (mirrors the stats API). */
const RISK_MS = 30 * 86_400_000

function ts(iso: string | null): number {
  return iso ? new Date(iso).getTime() : 0
}

function classify(c: Customer): { vip: boolean; atRisk: boolean; isNew: boolean } {
  const now = Date.now()
  return {
    vip: c.active && isVipTier(tierOf(c.totalSpent)),
    atRisk: c.active && c.visits > 0 && now - ts(c.lastVisitAt) > RISK_MS,
    isNew: c.active && now - new Date(c.createdAt).getTime() < RISK_MS,
  }
}

const SEGMENTS: { key: Segment; labelKey: string }[] = [
  { key: 'all', labelKey: 'customers.tabAll' },
  { key: 'vip', labelKey: 'customers.tabVip' },
  { key: 'atrisk', labelKey: 'customers.tabAtRisk' },
  { key: 'new', labelKey: 'customers.tabNew' },
  { key: 'inactive', labelKey: 'customers.tabInactive' },
]

const SORT_OPTIONS: { key: SortKey; labelKey: string }[] = [
  { key: 'lastVisit', labelKey: 'customers.sortLastVisit' },
  { key: 'spend', labelKey: 'customers.sortSpend' },
  { key: 'visits', labelKey: 'customers.sortVisits' },
  { key: 'points', labelKey: 'customers.sortPoints' },
]

function sortCustomers(list: Customer[], sort: SortKey): Customer[] {
  const out = [...list]
  switch (sort) {
    case 'spend':
      return out.sort((a, b) => b.totalSpent - a.totalSpent)
    case 'visits':
      return out.sort((a, b) => b.visits - a.visits || b.totalSpent - a.totalSpent)
    case 'points':
      return out.sort((a, b) => b.points - a.points)
    default:
      // most-recent visitors first; never-visited guests at the end
      return out.sort((a, b) => ts(b.lastVisitAt) - ts(a.lastVisitAt))
  }
}

// ── KPI payload (GET /api/customers/stats) ───────────────────────────
type CustomerStats = {
  totalActive: number
  inactive: number
  vip: number
  atRisk: number
  atRiskDays: number
  newThisMonth: number
  trackedRevenue: number
  totalPoints: number
  avgSpendPerVisit: number
  tierCounts: Record<string, number>
}

// ── tier chip (icon per tier; colors from the shared tier engine) ────
const TIER_ICONS: Record<string, LucideIcon> = {
  bronze: Medal,
  silver: Medal,
  gold: Crown,
  diamond: Gem,
}

function TierChip({ tier, className }: { tier: TierDef; className?: string }) {
  const { t } = useI18n()
  const Icon = TIER_ICONS[tier.key] ?? Medal
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide',
        tier.chip,
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t(tier.labelKey)}
    </span>
  )
}

export default function CustomersView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [segment, setSegment] = useState<Segment>('all')
  const [sort, setSort] = useState<SortKey>('lastVisit')
  const [editOpen, setEditOpen] = useState(false)
  const [editing, setEditing] = useState<Customer | null>(null) // null = create
  const [detailId, setDetailId] = useState<number | null>(null)

  // form state (create / edit)
  const [formName, setFormName] = useState('')
  const [formPhone, setFormPhone] = useState('')
  const [formNotes, setFormNotes] = useState('')
  const [pointsDelta, setPointsDelta] = useState('')
  const [pointsReason, setPointsReason] = useState('')

  // list — always includes inactive profiles so the Inactive segment has
  // data; the "All" tab then filters to active client-side.
  const { data, isLoading } = useQuery({
    queryKey: ['customers', 'admin', search, 'all'],
    queryFn: () =>
      fetcher<{ customers: Customer[] }>(
        `/api/customers?q=${encodeURIComponent(search)}&limit=50&all=1`,
      ),
    staleTime: 15_000,
  })

  const statsQuery = useQuery({
    queryKey: ['customers', 'stats'],
    queryFn: () => fetcher<{ stats: CustomerStats }>('/api/customers/stats'),
    staleTime: 30_000,
  })
  const stats = statsQuery.data?.stats

  const customers = useMemo(() => data?.customers ?? [], [data])

  // segment memberships + counts (client-side over the loaded page)
  const classified = useMemo(
    () => new Map(customers.map((c) => [c.id, classify(c)])),
    [customers],
  )
  const counts = useMemo(() => {
    const acc: Record<Segment, number> = { all: 0, vip: 0, atrisk: 0, new: 0, inactive: 0 }
    for (const c of customers) {
      if (!c.active) {
        acc.inactive += 1
        continue
      }
      acc.all += 1
      const m = classified.get(c.id)
      if (m?.vip) acc.vip += 1
      if (m?.atRisk) acc.atrisk += 1
      if (m?.isNew) acc.new += 1
    }
    return acc
  }, [customers, classified])

  const visible = useMemo(() => {
    const filtered = customers.filter((c) => {
      if (segment === 'inactive') return !c.active
      if (!c.active) return false
      const m = classified.get(c.id)
      if (segment === 'vip') return m?.vip ?? false
      if (segment === 'atrisk') return m?.atRisk ?? false
      if (segment === 'new') return m?.isNew ?? false
      return true
    })
    return sortCustomers(filtered, sort)
  }, [customers, classified, segment, sort])

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

  const emptyKey =
    search.trim().length > 0
      ? 'customers.emptySearch'
      : segment === 'vip'
        ? 'customers.emptyVip'
        : segment === 'atrisk'
          ? 'customers.emptyAtRisk'
          : segment === 'new'
            ? 'customers.emptyNew'
            : segment === 'inactive'
              ? 'customers.emptyInactive'
              : 'customers.empty'

  const sortLabelKey = SORT_OPTIONS.find((o) => o.key === sort)?.labelKey ?? 'customers.sortLastVisit'

  return (
    <section className="flex-1 space-y-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-white shadow">
            <UserRound className="size-6" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold">{t('customers.title')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('customers.subtitle', { n: visible.length })}
            </p>
          </div>
        </div>
        <Button
          onClick={openCreate}
          className="h-11 rounded-xl bg-primary font-semibold text-white hover:bg-primary/90"
        >
          <UserRoundPlus className="size-4" aria-hidden />
          {t('customers.new')}
        </Button>
      </div>

      {/* KPI insight row — one tap jumps to the segment */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard
          label={t('customers.kpiActive')}
          value={stats ? String(stats.totalActive) : undefined}
          sub={stats && stats.inactive > 0 ? t('customers.kpiActiveSub', { n: stats.inactive }) : undefined}
          icon={Users}
          tone="border-primary/30 bg-primary/[0.06] text-primary"
          active={segment === 'all'}
          onClick={() => setSegment('all')}
        />
        <KpiCard
          label={t('customers.kpiVip')}
          value={stats ? String(stats.vip) : undefined}
          sub={t('customers.kpiVipSub')}
          icon={Crown}
          tone="border-amber-300 bg-amber-50 text-amber-700"
          active={segment === 'vip'}
          onClick={() => setSegment('vip')}
        />
        <KpiCard
          label={t('customers.kpiAtRisk')}
          value={stats ? String(stats.atRisk) : undefined}
          sub={t('customers.kpiAtRiskSub')}
          icon={TriangleAlert}
          tone="border-rose-300 bg-rose-50 text-rose-700"
          active={segment === 'atrisk'}
          onClick={() => setSegment('atrisk')}
        />
        <KpiCard
          label={t('customers.kpiNew')}
          value={stats ? String(stats.newThisMonth) : undefined}
          sub={t('customers.kpiNewSub')}
          icon={UserRoundPlus}
          tone="border-emerald-300 bg-emerald-50 text-emerald-700"
          active={segment === 'new'}
          onClick={() => setSegment('new')}
        />
        <KpiCard
          label={t('customers.kpiRevenue')}
          value={stats ? formatCurrency(stats.trackedRevenue) : undefined}
          sub={stats ? t('customers.kpiRevenueSub', { egp: formatCurrency(stats.avgSpendPerVisit) }) : undefined}
          icon={Banknote}
          tone="border-teal-300 bg-teal-50 text-teal-700"
          active={false}
          onClick={() => setSegment('all')}
        />
      </div>

      {/* Search + sort */}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-11 min-w-11 gap-2 rounded-xl">
              <ArrowUpDown className="size-4" aria-hidden />
              <span className="hidden sm:inline">
                {t('customers.sortLabel')}: {t(sortLabelKey)}
              </span>
              <span className="sr-only sm:hidden">{t('customers.sortLabel')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {SORT_OPTIONS.map((o) => (
              <DropdownMenuItem
                key={o.key}
                onClick={() => setSort(o.key)}
                className={cn(sort === o.key && 'font-semibold')}
              >
                {t(o.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Segment tabs */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('customers.title')}>
        {SEGMENTS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={segment === tab.key}
            onClick={() => setSegment(tab.key)}
            className={cn(
              'inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              segment === tab.key
                ? 'border-primary bg-primary text-white shadow-sm'
                : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {t(tab.labelKey)}
            <span
              className={cn(
                'rounded-full px-1.5 text-xs font-bold tabular-nums',
                segment === tab.key ? 'bg-white/20' : 'bg-muted',
              )}
            >
              {counts[tab.key]}
            </span>
          </button>
        ))}
      </div>

      {/* List */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
          <UserRound className="size-12 text-muted-foreground/40" aria-hidden />
          <p className="font-medium text-muted-foreground">{t(emptyKey)}</p>
          {segment === 'all' && search.trim().length === 0 && (
            <>
              <p className="max-w-md text-sm text-muted-foreground/80">{t('customers.emptyHint')}</p>
              <Button onClick={openCreate} variant="outline" className="h-11 rounded-xl">
                <Plus className="size-4" aria-hidden />
                {t('customers.new')}
              </Button>
            </>
          )}
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => (
            <CustomerCard
              key={c.id}
              customer={c}
              onOpen={() => setDetailId(c.id)}
              onEdit={() => openEdit(c)}
            />
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
              <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/[0.04] p-3">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-primary">
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
                  <span className="font-semibold tabular-nums text-primary">
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
              className="h-11 bg-primary font-semibold text-white hover:bg-primary/90"
              disabled={saveMutation.isPending || !canSave}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : t('customers.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog — the rich profile */}
      <Dialog open={detailId != null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
          {detailQuery.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : detailQuery.data ? (
            <CustomerProfile customer={detailQuery.data.customer} />
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── KPI card (segment launcher) ──────────────────────────────────────
function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone,
  active,
  onClick,
}: {
  label: string
  value?: string
  sub?: string
  icon: LucideIcon
  tone: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex min-h-24 flex-col items-start gap-2 rounded-xl border p-4 text-start shadow-sm transition',
        'hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]',
        tone,
        active && 'ring-2 ring-ring/40',
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide opacity-80">{label}</span>
        <Icon className="size-4 shrink-0 opacity-70" aria-hidden />
      </span>
      {value == null ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <span className="text-2xl font-bold leading-none tabular-nums">{value}</span>
      )}
      {sub && value != null && <span className="text-[11px] leading-tight opacity-75">{sub}</span>}
    </button>
  )
}

// ── customer card ────────────────────────────────────────────────────
function CustomerCard({
  customer,
  onOpen,
  onEdit,
}: {
  customer: Customer
  onOpen: () => void
  onEdit: () => void
}) {
  const { t } = useI18n()
  const tier = tierOf(customer.totalSpent)
  const progress = nextTierProgress(customer.totalSpent)
  const vip = isVipTier(tier)
  const phone = customer.phone

  return (
    <Card className="gap-0 overflow-hidden p-0 transition hover:shadow-md">
      <button
        type="button"
        onClick={onOpen}
        className="w-full space-y-3 p-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        title={t('customers.recentOrders')}
      >
        <div className="flex items-start gap-3">
          <span className="relative shrink-0">
            <span
              className={cn(
                'grid size-12 place-items-center rounded-full text-sm font-bold text-white ring-4 ring-offset-2 ring-offset-card',
                avatarColor(customer.name),
                tier.ring,
              )}
              aria-hidden
            >
              {initialsOf(customer.name)}
            </span>
            {vip && (
              <span
                className="absolute -end-1 -top-1 grid size-5 place-items-center rounded-full bg-amber-400 text-white shadow"
                title={t(tier.labelKey)}
              >
                <Crown className="size-3" aria-hidden />
              </span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold leading-tight">{customer.name}</span>
            </span>
            <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Phone className="size-3 shrink-0" aria-hidden />
              {phone ?? '—'}
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <TierChip tier={tier} />
              {!customer.active && <Badge variant="secondary">{t('customers.inactive')}</Badge>}
            </span>
          </span>
        </div>

        <span className="grid grid-cols-3 gap-2 text-center">
          <span className="rounded-lg bg-muted/60 px-1.5 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t('customers.visits')}
            </span>
            <span className="block text-sm font-bold tabular-nums">{customer.visits}</span>
          </span>
          <span className="rounded-lg bg-primary/[0.08] px-1.5 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-primary/80">
              {t('customers.points')}
            </span>
            <span className="block text-sm font-bold tabular-nums text-primary">{customer.points}</span>
          </span>
          <span className="rounded-lg bg-emerald-50 px-1.5 py-2">
            <span className="block text-[10px] font-medium uppercase tracking-wide text-emerald-700/80">
              {t('customers.totalSpent')}
            </span>
            <span className="block text-sm font-bold tabular-nums text-emerald-700">
              {formatCurrency(customer.totalSpent)}
            </span>
          </span>
        </span>

        {/* progress toward the next tier (Diamond = maxed) */}
        <span className="block">
          <span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <span
              className={cn('block h-full rounded-full transition-all', tier.bar)}
              style={{ width: `${progress.pct}%` }}
            />
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {progress.next
              ? t('customers.toNextTier', {
                  egp: formatCurrency(progress.remaining),
                  tier: t(progress.next.labelKey),
                })
              : t('customers.topTier')}
          </span>
        </span>

        <span className="block text-xs text-muted-foreground">
          {customer.lastVisitAt
            ? `${t('customers.lastVisit')}: ${formatDate(customer.lastVisitAt)}`
            : t('customers.neverVisited')}
        </span>
      </button>

      {/* outreach row — call / WhatsApp / edit */}
      <div className="grid grid-cols-3 border-t bg-muted/30">
        {phone ? (
          <>
            <a
              href={telHref(phone)}
              className="flex min-h-11 items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <Phone className="size-4" aria-hidden />
              {t('customers.call')}
            </a>
            <a
              href={whatsappHref(phone)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center justify-center gap-1.5 border-x border-border text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <MessageCircle className="size-4" aria-hidden />
              {t('customers.whatsapp')}
            </a>
          </>
        ) : (
          <span className="col-span-2" />
        )}
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('customers.edit')}
          className="flex min-h-11 items-center justify-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Pencil className="size-4" aria-hidden />
          <span className="sr-only sm:not-sr-only">{t('customers.edit')}</span>
        </button>
      </div>
    </Card>
  )
}

// ── rich profile dialog body ─────────────────────────────────────────
function CustomerProfile({ customer }: { customer: Customer }) {
  const { t } = useI18n()
  const tier = tierOf(customer.totalSpent)
  const vip = isVipTier(tier)
  const avgPerVisit = customer.visits > 0 ? customer.totalSpent / customer.visits : 0
  const orders = customer.orders ?? []
  const reservations = customer.reservations ?? []
  const phone = customer.phone

  return (
    <div className="space-y-5">
      <DialogHeader className="space-y-4 text-start">
        <DialogTitle className="sr-only">{customer.name}</DialogTitle>
        {/* hero identity */}
        <div className="flex flex-wrap items-start gap-4">
          <span className="relative shrink-0">
            <span
              className={cn(
                'grid size-16 place-items-center rounded-2xl text-lg font-bold text-white ring-4 ring-offset-2 ring-offset-background',
                avatarColor(customer.name),
                tier.ring,
              )}
              aria-hidden
            >
              {initialsOf(customer.name)}
            </span>
            {vip && (
              <span className="absolute -end-1.5 -top-1.5 grid size-6 place-items-center rounded-full bg-amber-400 text-white shadow">
                <Crown className="size-3.5" aria-hidden />
              </span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-xl font-bold leading-tight">{customer.name}</h3>
              <TierChip tier={tier} />
              {!customer.active && <Badge variant="secondary">{t('customers.inactive')}</Badge>}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              {phone ? (
                <>
                  <Phone className="size-3.5" aria-hidden />
                  <span className="tabular-nums">{phone}</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span>
                {t('customers.memberSince')} {formatDate(customer.createdAt)}
              </span>
            </p>
          </div>
          {phone && (
            <div className="flex gap-2">
              <Button asChild variant="outline" size="sm" className="h-10 gap-1.5 rounded-lg">
                <a href={telHref(phone)}>
                  <Phone className="size-4" aria-hidden />
                  {t('customers.call')}
                </a>
              </Button>
              <Button asChild size="sm" className="h-10 gap-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
                <a href={whatsappHref(phone)} target="_blank" rel="noopener noreferrer">
                  <MessageCircle className="size-4" aria-hidden />
                  {t('customers.whatsapp')}
                </a>
              </Button>
            </div>
          )}
        </div>
      </DialogHeader>

      {/* stat grid */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-muted/60 p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('customers.visits')}
          </p>
          <p className="mt-0.5 text-lg font-bold tabular-nums">{customer.visits}</p>
        </div>
        <div className="rounded-xl bg-primary/[0.08] p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/80">
            {t('customers.points')}
          </p>
          <p className="mt-0.5 flex items-center justify-center gap-1 text-lg font-bold tabular-nums text-primary">
            <Sparkles className="size-3.5" aria-hidden />
            {customer.points}
          </p>
        </div>
        <div className="rounded-xl bg-emerald-50 p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700/80">
            {t('customers.totalSpent')}
          </p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-emerald-700">
            {formatCurrency(customer.totalSpent)}
          </p>
        </div>
        <div className="rounded-xl bg-amber-50 p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700/80">
            {t('customers.avgPerVisit')}
          </p>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-amber-700">
            {formatCurrency(avgPerVisit)}
          </p>
        </div>
      </div>

      {/* guest notes */}
      {customer.notes && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <Cake className="mt-0.5 size-4 shrink-0 text-amber-700" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-800/80">
              {t('customers.notesTitle')}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-amber-900">{customer.notes}</p>
          </div>
        </div>
      )}

      {/* order history */}
      <section>
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Receipt className="size-4 text-muted-foreground" aria-hidden />
          {t('customers.recentOrders')}
        </p>
        {orders.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('customers.noOrdersYet')}</p>
        ) : (
          <ul className="space-y-1.5">
            {orders.map((order: Order) => (
              <li
                key={order.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
              >
                <span className="font-semibold tabular-nums">#{order.id}</span>
                <span className="text-xs text-muted-foreground">{formatDate(order.createdAt)}</span>
                {order.table?.name && (
                  <span className="text-xs text-muted-foreground">· {order.table.name}</span>
                )}
                {order.user?.name && (
                  <span className="text-xs text-muted-foreground">· {order.user.name}</span>
                )}
                <span className="text-xs text-muted-foreground">
                  · {t('customers.orderItems', { n: order.items.length })}
                </span>
                <span className="ms-auto flex items-center gap-2">
                  {order.pointsEarned > 0 && (
                    <Badge className="border-primary/30 bg-primary/10 text-primary" variant="outline">
                      {t('customers.pointsEarnedShort', { n: order.pointsEarned })}
                    </Badge>
                  )}
                  {order.pointsRedeemed > 0 && (
                    <Badge className="border-amber-300 bg-amber-50 text-amber-700" variant="outline">
                      {t('customers.pointsRedeemedShort', { n: order.pointsRedeemed })}
                    </Badge>
                  )}
                  <span className="font-semibold tabular-nums">{formatCurrency(order.totalAmount)}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      order.status === 'paid' && 'border-emerald-300 text-emerald-700',
                      order.status === 'open' && 'border-amber-300 text-amber-700',
                      order.status === 'deferred' && 'border-violet-300 text-violet-700',
                      order.status === 'cancelled' && 'border-rose-300 text-rose-700',
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

      {/* upcoming reservations */}
      <section>
        <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <CalendarCheck className="size-4 text-muted-foreground" aria-hidden />
          {t('customers.upcomingRes')}
        </p>
        {reservations.length === 0 ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <ul className="space-y-1.5">
            {reservations.map((res: Reservation) => (
              <li
                key={res.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm"
              >
                <span className="font-medium">{formatDate(res.reservedAt)}</span>
                <Badge variant="outline">{res.partySize} pax</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
