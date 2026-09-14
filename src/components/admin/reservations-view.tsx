'use client'

// ─── R11: Reservations — the booking board (admin) ───────────────────
// Table bookings end to end: create + edit while pending, seat at a free
// clean table (table goes 'reserved', booking 'seated'), cancel / no-show
// with confirmations, and read-only history. Seated parties order through
// the normal POS floor flow — the order auto-links to the reservation and
// the status derives 'completed' server-side once the check closes.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { format as formatDateFns, isToday, isTomorrow } from 'date-fns'
import { ar as arLocale, enGB as enGBLocale } from 'date-fns/locale'
import {
  Armchair,
  CalendarCheck,
  CalendarClock,
  CalendarX2,
  Check,
  Loader2,
  MapPin,
  Pencil,
  Phone,
  Plus,
  Receipt,
  StickyNote,
  TriangleAlert,
  UserX,
  Users,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch, fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { FloorPlan, Reservation, RestaurantTable } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Translate with interpolation (mirrors the i18n `t` signature). */
type Translate = (key: string, vars?: Record<string, string | number>) => string

// ─── Filters & status styling ───────────────────────────────────────

type BoardFilter = 'today' | 'upcoming' | 'pending' | 'seated' | 'all'

const FILTER_KEYS: Record<BoardFilter, string> = {
  today: 'reservations.filterToday',
  upcoming: 'reservations.filterUpcoming',
  pending: 'reservations.filterPending',
  seated: 'reservations.filterSeated',
  all: 'reservations.filterAll',
}

/** Status badge colors: pending amber · seated violet · completed emerald ·
 *  cancelled muted/stone · no_show rose. */
const STATUS_BADGE_CLASSES: Record<string, string> = {
  pending: 'border-amber-500/40 bg-amber-50 text-amber-700 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-400',
  seated: 'border-violet-500/40 bg-violet-50 text-violet-700 dark:border-violet-400/40 dark:bg-violet-400/10 dark:text-violet-400',
  completed: 'border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400',
  cancelled: 'border-stone-400/40 bg-stone-100 text-stone-600 dark:border-stone-500/40 dark:bg-stone-500/10 dark:text-stone-400',
  no_show: 'border-rose-500/40 bg-rose-50 text-rose-700 dark:border-rose-400/40 dark:bg-rose-400/10 dark:text-rose-400',
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Local "now + 1h rounded up to the next half hour" as a datetime-local
 *  value — a sensible default for a new booking. */
function nextSlotDatetimeLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(d.getMinutes() >= 30 ? 60 : 30, 0, 0)
  return toDatetimeLocalValue(d)
}

/** Date → 'yyyy-MM-ddTHH:mm' for <input type="datetime-local"> (local tz). */
function toDatetimeLocalValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 'yyyy-MM-ddTHH:mm' → Date (local tz); null when malformed. */
function fromDatetimeLocalValue(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v.trim())) return null
  const d = new Date(v.trim())
  return Number.isNaN(d.getTime()) ? null : d
}

/** Locale-aware "EEE d MMM · HH:mm" for the booking time. */
function formatReservedAt(iso: string, lang: 'en' | 'ar'): string {
  return formatDateFns(new Date(iso), 'EEE d MMM · HH:mm', {
    locale: lang === 'ar' ? arLocale : enGBLocale,
  })
}

// ─── Booking form (create + edit while pending) ─────────────────────

type BookingForm = {
  customerName: string
  customerPhone: string
  partySize: string
  reservedAt: string // datetime-local value
  tableId: string // '' = any table
  notes: string
}

type BookingFormErrors = Partial<Record<'customerName' | 'reservedAt', string>>

function validateBookingForm(form: BookingForm, t: Translate): BookingFormErrors {
  const errors: BookingFormErrors = {}
  if (form.customerName.trim() === '') errors.customerName = t('reservations.nameRequired')
  const when = fromDatetimeLocalValue(form.reservedAt)
  if (form.reservedAt.trim() === '') errors.reservedAt = t('reservations.whenRequired')
  else if (!when) errors.reservedAt = t('reservations.whenInvalid')
  return errors
}

function toBookingForm(r: Reservation): BookingForm {
  const d = new Date(r.reservedAt)
  return {
    customerName: r.customerName,
    customerPhone: r.customerPhone ?? '',
    partySize: String(r.partySize),
    reservedAt: toDatetimeLocalValue(d),
    tableId: r.tableId != null ? String(r.tableId) : '',
    notes: r.notes ?? '',
  }
}

// ─── View ───────────────────────────────────────────────────────────

export default function ReservationsView() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  const [filter, setFilter] = useState<BoardFilter>('today')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Reservation | null>(null)
  const [form, setForm] = useState<BookingForm>(() => ({
    customerName: '',
    customerPhone: '',
    partySize: '2',
    reservedAt: nextSlotDatetimeLocal(),
    tableId: '',
    notes: '',
  }))
  const [seatTarget, setSeatTarget] = useState<Reservation | null>(null)
  const [seatTableId, setSeatTableId] = useState<string>('')
  const [cancelTarget, setCancelTarget] = useState<Reservation | null>(null)
  const [noShowTarget, setNoShowTarget] = useState<Reservation | null>(null)

  // Booking board — 15s live refetch.
  const reservationsQuery = useQuery({
    queryKey: ['reservations'],
    queryFn: () => fetcher<{ reservations: Reservation[] }>('/api/reservations'),
    refetchInterval: 15000,
  })

  // Floor plans for the table pickers (new/edit pre-selection + seating).
  const floorPlansQuery = useQuery({
    queryKey: ['floorplans'],
    queryFn: () => fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans'),
  })

  const reservations = useMemo(
    () => reservationsQuery.data?.reservations ?? [],
    [reservationsQuery.data],
  )

  const startOfTomorrow = useMemo(() => {
    const d = new Date()
    d.setHours(24, 0, 0, 0)
    return d
  }, [])

  // Client-side grouping for the board tabs.
  const filtered = useMemo(() => {
    const byFilter = (r: Reservation) => {
      switch (filter) {
        case 'today':
          return isToday(new Date(r.reservedAt))
        case 'upcoming':
          return new Date(r.reservedAt).getTime() >= startOfTomorrow.getTime()
        case 'pending':
          return r.status === 'pending'
        case 'seated':
          return r.status === 'seated'
        default:
          return true
      }
    }
    return reservations.filter(byFilter).sort(
      (a, b) => new Date(a.reservedAt).getTime() - new Date(b.reservedAt).getTime(),
    )
  }, [reservations, filter, startOfTomorrow])

  const countFor = (f: BoardFilter) => {
    switch (f) {
      case 'today':
        return reservations.filter((r) => isToday(new Date(r.reservedAt))).length
      case 'upcoming':
        return reservations.filter((r) => new Date(r.reservedAt).getTime() >= startOfTomorrow.getTime()).length
      case 'pending':
        return reservations.filter((r) => r.status === 'pending').length
      case 'seated':
        return reservations.filter((r) => r.status === 'seated').length
      default:
        return reservations.length
    }
  }

  const isCreate = editing === null
  const errors = validateBookingForm(form, t)
  const hasErrors = Object.values(errors).some(Boolean)

  const invalidateReservations = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['reservations'] }),
      queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
    ])
  }

  // ── Create / edit booking ─────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const when = fromDatetimeLocalValue(form.reservedAt)
      const payload = {
        customerName: form.customerName.trim(),
        customerPhone: form.customerPhone.trim(),
        partySize: Math.max(1, Math.min(30, Math.round(Number(form.partySize) || 2))),
        reservedAt: when ? when.toISOString() : '',
        notes: form.notes.trim(),
        ...(form.tableId !== '' ? { tableId: Number(form.tableId) } : {}),
      }
      return editing === null
        ? apiFetch<{ reservation: Reservation }>('/api/reservations', { method: 'POST', body: payload })
        : apiFetch<{ reservation: Reservation }>(`/api/reservations/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      toast.success(editing === null ? t('reservations.bookingCreated') : t('reservations.bookingUpdated'))
      setFormOpen(false)
      void invalidateReservations()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Seat a pending booking at a free, clean table ─────────────────
  const seatMutation = useMutation({
    mutationFn: (vars: { id: number; tableId: number }) =>
      apiFetch<{ reservation: Reservation }>(`/api/reservations/${vars.id}/seat`, {
        method: 'POST',
        body: { tableId: vars.tableId },
      }),
    onSuccess: (_data, vars) => {
      const table =
        floorPlansQuery.data?.floorPlans.flatMap((fp) => fp.tables).find((tb) => tb.id === vars.tableId)
      toast.success(t('reservations.seatedToast', { name: seatTarget?.customerName ?? '', table: table?.name ?? `#${vars.tableId}` }))
      setSeatTarget(null)
      setSeatTableId('')
      void invalidateReservations()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Cancel / no-show a pending booking ────────────────────────────
  const statusMutation = useMutation({
    mutationFn: (vars: { id: number; status: 'cancelled' | 'no_show' }) =>
      apiFetch<{ reservation: Reservation }>(`/api/reservations/${vars.id}`, {
        method: 'PUT',
        body: { status: vars.status },
      }),
    onSuccess: (_data, vars) => {
      toast.success(vars.status === 'cancelled' ? t('reservations.bookingCancelledToast') : t('reservations.noShowToast'))
      setCancelTarget(null)
      setNoShowTarget(null)
      void invalidateReservations()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function openCreate() {
    setEditing(null)
    setForm({
      customerName: '',
      customerPhone: '',
      partySize: '2',
      reservedAt: nextSlotDatetimeLocal(),
      tableId: '',
      notes: '',
    })
    setFormOpen(true)
  }

  function openEdit(r: Reservation) {
    setEditing(r)
    setForm(toBookingForm(r))
    setFormOpen(true)
  }

  function openSeat(r: Reservation) {
    setSeatTarget(r)
    setSeatTableId(r.tableId != null ? String(r.tableId) : '')
  }

  // Free + clean tables (no open order), grouped by floor — the seat picker.
  const freeTablesByFloor = useMemo(() => {
    return (floorPlansQuery.data?.floorPlans ?? [])
      .filter((fp) => fp.active)
      .map((fp) => ({
        plan: fp,
        tables: fp.tables.filter(
          (tb) => tb.active && tb.status === 'free' && tb.openOrderId == null,
        ),
      }))
      .filter((group) => group.tables.length > 0)
  }, [floorPlansQuery.data])

  const seatTargetParty = seatTarget?.partySize ?? 0

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('nav.reservations')}</h1>
          <p className="text-muted-foreground text-sm">{t('reservations.subtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('reservations.newBooking')}
        </Button>
      </div>

      {/* Status filter tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {(Object.keys(FILTER_KEYS) as BoardFilter[]).map((f) => {
          const active = filter === f
          const count = countFor(f)
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={active}
              className={cn(
                'h-11 rounded-full border px-4 text-sm font-medium transition-colors',
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-[#E2E2E0] bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {t(FILTER_KEYS[f])}
              <span className="ms-1.5 tabular-nums opacity-70">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Booking board */}
      <Card className="p-4">
        {reservationsQuery.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2 rounded-xl border p-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : reservationsQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('reservations.loadFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {reservationsQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button variant="outline" className="h-11" onClick={() => void reservationsQuery.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <CalendarCheck className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('reservations.noBookings')}</p>
              <p className="text-muted-foreground text-sm">{t('reservations.noBookingsHint')}</p>
            </div>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> {t('reservations.newBooking')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((r) => (
              <BookingCard
                key={r.id}
                reservation={r}
                lang={lang}
                t={t}
                onSeat={() => openSeat(r)}
                onEdit={() => openEdit(r)}
                onCancel={() => setCancelTarget(r)}
                onNoShow={() => setNoShowTarget(r)}
              />
            ))}
          </div>
        )}
      </Card>

      {/* ── Create / edit dialog ── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isCreate ? t('reservations.newBooking') : t('reservations.editBooking')}
            </DialogTitle>
            <DialogDescription>
              {isCreate ? t('reservations.subtitle') : t('reservations.editBookingDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="booking-name">
                  {t('reservations.customer')} *
                </Label>
                <Input
                  id="booking-name"
                  value={form.customerName}
                  onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                  placeholder={t('reservations.namePh')}
                  className="h-11"
                  maxLength={60}
                  autoFocus
                  aria-invalid={errors.customerName ? true : undefined}
                />
                {errors.customerName && (
                  <p className="text-destructive text-xs">{errors.customerName}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="booking-phone">{t('reservations.phone')}</Label>
                <Input
                  id="booking-phone"
                  type="tel"
                  inputMode="tel"
                  value={form.customerPhone}
                  onChange={(e) => setForm({ ...form, customerPhone: e.target.value })}
                  placeholder={t('reservations.phonePh')}
                  className="h-11"
                  maxLength={20}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="booking-party">{t('reservations.partySize')}</Label>
                <Input
                  id="booking-party"
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  inputMode="numeric"
                  value={form.partySize}
                  onChange={(e) => setForm({ ...form, partySize: e.target.value })}
                  className="h-11 tabular-nums"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="booking-when">
                  {t('reservations.when')} *
                </Label>
                <Input
                  id="booking-when"
                  type="datetime-local"
                  value={form.reservedAt}
                  onChange={(e) => setForm({ ...form, reservedAt: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.reservedAt ? true : undefined}
                />
                {errors.reservedAt && (
                  <p className="text-destructive text-xs">{errors.reservedAt}</p>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="booking-table">{t('reservations.table')}</Label>
              <Select
                value={form.tableId === '' ? 'none' : form.tableId}
                onValueChange={(v) => setForm({ ...form, tableId: v === 'none' ? '' : v })}
              >
                <SelectTrigger id="booking-table" className="h-11 w-full">
                  <SelectValue placeholder={t('reservations.anyTable')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('reservations.anyTable')}</SelectItem>
                  {(floorPlansQuery.data?.floorPlans ?? [])
                    .filter((fp) => fp.active)
                    .flatMap((fp) => fp.tables.filter((tb) => tb.active).map((tb) => ({ fp, tb })))
                    .map(({ fp, tb }) => (
                      <SelectItem key={tb.id} value={String(tb.id)}>
                        {fp.name} · {tb.name} ({tb.capacity})
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="booking-notes">{t('common.notes')}</Label>
              <Textarea
                id="booking-notes"
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder={t('reservations.notesPh')}
                maxLength={300}
                rows={2}
                className="min-h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setFormOpen(false)} disabled={saveMutation.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loader2 className="animate-spin" /> : <Check />}
              {isCreate ? t('reservations.createBooking') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Seat dialog — pick a free, clean table ── */}
      <Dialog
        open={seatTarget != null}
        onOpenChange={(o) => {
          if (!o && !seatMutation.isPending) {
            setSeatTarget(null)
            setSeatTableId('')
          }
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Armchair className="size-5 text-violet-600" aria-hidden />
              {t('reservations.seatTitle', { name: seatTarget?.customerName ?? '' })}
            </DialogTitle>
            <DialogDescription>{t('reservations.seatDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div>
              <p className="mb-2 text-sm font-semibold">{t('reservations.seatPickTable')}</p>
              {floorPlansQuery.isLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : freeTablesByFloor.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center">
                  <MapPin className="size-8 text-muted-foreground/50" aria-hidden />
                  <p className="text-sm text-muted-foreground">{t('reservations.noFreeTables')}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {freeTablesByFloor.map(({ plan, tables }) => (
                    <div key={plan.id} className="space-y-1.5">
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {plan.name}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {tables.map((tb) => (
                          <SeatTableChip
                            key={tb.id}
                            table={tb}
                            partySize={seatTargetParty}
                            selected={seatTableId === String(tb.id)}
                            onSelect={() => setSeatTableId(String(tb.id))}
                            t={t}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => {
                setSeatTarget(null)
                setSeatTableId('')
              }}
              disabled={seatMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11 bg-violet-600 text-white hover:bg-violet-700"
              disabled={seatMutation.isPending || seatTableId === ''}
              title={seatTableId === '' ? t('reservations.seatNeedTable') : undefined}
              onClick={() => {
                if (seatTarget && seatTableId !== '') {
                  seatMutation.mutate({ id: seatTarget.id, tableId: Number(seatTableId) })
                }
              }}
            >
              {seatMutation.isPending ? <Loader2 className="animate-spin" /> : <Armchair />}
              {t('reservations.seat')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Cancel confirm ── */}
      <AlertDialog
        open={cancelTarget != null}
        onOpenChange={(o) => !o && setCancelTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CalendarX2 className="size-5 text-destructive" aria-hidden />
              {t('reservations.cancelBooking')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('reservations.cancelBookingDesc', { name: cancelTarget?.customerName ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={statusMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-destructive text-white hover:bg-destructive/90"
              disabled={statusMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (cancelTarget) statusMutation.mutate({ id: cancelTarget.id, status: 'cancelled' })
              }}
            >
              {statusMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              {t('common.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── No-show confirm ── */}
      <AlertDialog
        open={noShowTarget != null}
        onOpenChange={(o) => !o && setNoShowTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <UserX className="size-5 text-rose-600" aria-hidden />
              {t('reservations.noShow')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('reservations.noShowDesc', { name: noShowTarget?.customerName ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={statusMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-rose-600 text-white hover:bg-rose-700"
              disabled={statusMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (noShowTarget) statusMutation.mutate({ id: noShowTarget.id, status: 'no_show' })
              }}
            >
              {statusMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              {t('reservations.noShow')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Seat-picker table chip ─────────────────────────────────────────

function SeatTableChip({
  table,
  partySize,
  selected,
  onSelect,
  t,
}: {
  table: RestaurantTable
  partySize: number
  selected: boolean
  onSelect: () => void
  t: Translate
}) {
  const fits = partySize > 0 && table.capacity >= partySize
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'inline-flex h-11 items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors',
        selected
          ? 'border-violet-600 bg-violet-600 text-white'
          : fits
            ? 'border-violet-300 bg-violet-50 text-violet-800 hover:border-violet-500 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-300'
            : 'border-[#E2E2E0] bg-card text-muted-foreground hover:border-violet-400/50',
      )}
    >
      <Armchair className="size-4" aria-hidden />
      {table.name}
      <span className="text-xs font-normal tabular-nums opacity-80">
        {t('reservations.seatsFit', { n: table.capacity })}
      </span>
    </button>
  )
}

// ─── Booking card ───────────────────────────────────────────────────

function BookingCard({
  reservation: r,
  lang,
  t,
  onSeat,
  onEdit,
  onCancel,
  onNoShow,
}: {
  reservation: Reservation
  lang: 'en' | 'ar'
  t: Translate
  onSeat: () => void
  onEdit: () => void
  onCancel: () => void
  onNoShow: () => void
}) {
  const when = new Date(r.reservedAt)
  const today = isToday(when)
  const tomorrow = isTomorrow(when)
  const pending = r.status === 'pending'
  const seated = r.status === 'seated'

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm',
        pending && 'border-amber-500/40',
        seated && 'border-violet-500/40',
      )}
    >
      {/* Header: customer + status */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold">{r.customerName}</p>
          <p className="flex items-center gap-1 text-muted-foreground text-sm">
            <Phone className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{r.customerPhone || t('reservations.noPhone')}</span>
          </p>
        </div>
        <Badge variant="outline" className={cn('shrink-0', STATUS_BADGE_CLASSES[r.status])}>
          {t(`reservations.status.${r.status}`)}
        </Badge>
      </div>

      {/* Party + time + table */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1 font-medium tabular-nums">
          <Users className="size-4 text-muted-foreground" aria-hidden />
          {t('reservations.partyShort', { n: r.partySize })}
        </span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          {formatReservedAt(r.reservedAt, lang)}
        </span>
        {today && (
          <Badge variant="outline" className="h-5 border-amber-500/40 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
            {t('reservations.todayChip')}
          </Badge>
        )}
        {tomorrow && (
          <Badge variant="outline" className="h-5 border-sky-500/40 px-1.5 text-[10px] font-semibold text-sky-700 dark:text-sky-400">
            {t('reservations.tomorrowChip')}
          </Badge>
        )}
      </div>

      {/* Assigned floor/table chip */}
      {r.table ? (
        <span className="inline-flex w-fit items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium">
          <Armchair className="size-3.5 text-muted-foreground" aria-hidden />
          {r.floorPlan ? `${r.floorPlan.name} · ` : ''}
          {r.table.name}
        </span>
      ) : (
        <span className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground">
          <MapPin className="size-3.5" aria-hidden />
          {t('reservations.anyTable')}
        </span>
      )}

      {/* Seated → linked order + POS hint */}
      {seated && (
        <div className="rounded-lg bg-violet-50 p-2.5 text-xs text-violet-800 dark:bg-violet-500/10 dark:text-violet-300">
          {r.order ? (
            <p className="mb-1 inline-flex items-center gap-1 font-semibold">
              <Receipt className="size-3.5" aria-hidden />
              {t('reservations.linkedOrder', { id: r.order.id })}
            </p>
          ) : null}
          <p>{t('reservations.seatedHint')}</p>
        </div>
      )}

      {/* Notes + createdBy */}
      {r.notes && (
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
          <StickyNote className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="line-clamp-2">{r.notes}</span>
        </p>
      )}
      <p className="text-muted-foreground/70 text-[11px]">
        {t('reservations.bookedBy')} {r.createdBy ?? '—'}
      </p>

      {/* Actions: pending → Seat / Edit / Cancel / No-show; terminal → none */}
      {pending && (
        <div className="flex flex-wrap gap-2 border-t pt-3">
          <Button
            size="sm"
            className="h-11 rounded-xl bg-violet-600 text-white hover:bg-violet-700"
            onClick={onSeat}
          >
            <Armchair className="size-4" /> {t('reservations.seat')}
          </Button>
          <Button size="sm" variant="outline" className="h-11 rounded-xl" onClick={onEdit}>
            <Pencil className="size-4" /> {t('common.edit')}
          </Button>
          <Button size="sm" variant="outline" className="h-11 rounded-xl text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onCancel}>
            <CalendarX2 className="size-4" /> {t('common.cancel')}
          </Button>
          <Button size="sm" variant="outline" className="h-11 rounded-xl text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-500/10" onClick={onNoShow}>
            <UserX className="size-4" /> {t('reservations.noShow')}
          </Button>
        </div>
      )}
    </div>
  )
}
