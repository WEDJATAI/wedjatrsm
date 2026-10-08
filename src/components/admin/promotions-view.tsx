'use client'

// R17 Promotions (Foodics happy-hour style) — automatic discount rules.
// Header card with the engine rules note, promo list (type/value chip,
// scope chip, schedule summary: day chips + time window + date range,
// inline active toggle), create/edit dialog (type, value, scope target
// category/product picker, weekday pills, time window, date range) and
// delete confirmation. Evaluation itself lives in lib/promotions.ts and
// is applied server-side at every order totals recompute.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarRange,
  Clock,
  MoreHorizontal,
  Pencil,
  Plus,
  Tag,
  Timer,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { WEEKDAY_KEYS } from '@/lib/constants'
import { localizedName, useI18n } from '@/lib/i18n'
import type { Category, Product, PromotionDTO } from '@/lib/types'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogCancel,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { Switch } from '@/components/ui/switch'

// ─── Form state & validation ────────────────────────────────────────

type PromoForm = {
  name: string
  nameAr: string
  type: 'percent' | 'fixed'
  value: string
  scope: 'order' | 'category' | 'product'
  categoryId: string // '' = not chosen
  productId: string
  days: number[] // JS getDay() digits; 7 selected (or 0) = every day
  startTime: string // 'HH:MM' or ''
  endTime: string
  startDate: string // 'YYYY-MM-DD' or ''
  endDate: string
  active: boolean
}

const EMPTY_FORM: PromoForm = {
  name: '',
  nameAr: '',
  type: 'percent',
  value: '',
  scope: 'order',
  categoryId: '',
  productId: '',
  days: [0, 1, 2, 3, 4, 5, 6],
  startTime: '',
  endTime: '',
  startDate: '',
  endDate: '',
  active: true,
}

type PromoFormErrors = Partial<Record<'name' | 'value' | 'scope', string>>

function validatePromoForm(form: PromoForm, t: (key: string) => string): PromoFormErrors {
  const errors: PromoFormErrors = {}
  if (form.name.trim() === '') errors.name = t('r17.promo.nameRequired')
  const value = Number(form.value)
  if (form.value.trim() === '' || !Number.isFinite(value) || value <= 0) {
    errors.value = t('r17.promo.valueRequired')
  } else if (form.type === 'percent' && value > 100) {
    errors.value = t('r17.promo.percentMax')
  }
  if (form.scope === 'category' && form.categoryId === '') errors.scope = t('r17.promo.scopeRequired')
  if (form.scope === 'product' && form.productId === '') errors.scope = t('r17.promo.scopeRequired')
  return errors
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

/** "−20%" / "−15 EGP" chip label for the discount type + value (EGP
 *  localized — "ج.م" in Arabic via the shared r17.common.egp key). */
function valueLabel(p: PromotionDTO, t: (key: string) => string): string {
  const v = Number(p.value.toFixed(2))
  return p.type === 'percent' ? `−${v}%` : `−${v} ${t('r17.common.egp')}`
}

function scopeLabelKey(scope: string): string {
  return scope === 'category'
    ? 'r17.promo.scopeCategory'
    : scope === 'product'
      ? 'r17.promo.scopeProduct'
      : 'r17.promo.scopeOrder'
}

// ─── View ───────────────────────────────────────────────────────────

export default function PromotionsView() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PromotionDTO | null>(null)
  const [form, setForm] = useState<PromoForm>(EMPTY_FORM)
  const [deleteTarget, setDeleteTarget] = useState<PromotionDTO | null>(null)

  const promosQuery = useQuery({
    queryKey: ['promotions'],
    queryFn: () => fetcher<{ promotions: PromotionDTO[] }>('/api/promotions'),
  })
  const promos = useMemo(() => promosQuery.data?.promotions ?? [], [promosQuery.data])

  // scope-target pickers (all=1 keeps inactive rows selectable so an
  // existing promo on a deactivated target can still be edited)
  const categoriesQuery = useQuery({
    queryKey: ['categories', 'all'],
    queryFn: () => fetcher<{ categories: Category[] }>('/api/categories?all=1'),
  })
  const productsQuery = useQuery({
    queryKey: ['products', 'all'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products?all=1'),
  })
  const categories = useMemo(
    () =>
      [...(categoriesQuery.data?.categories ?? [])].sort(
        (a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name),
      ),
    [categoriesQuery.data],
  )
  const products = useMemo(
    () => [...(productsQuery.data?.products ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [productsQuery.data],
  )

  const isCreate = editing === null
  const errors = validatePromoForm(form, t)
  const hasErrors = Object.values(errors).some(Boolean)

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() === '' ? null : form.nameAr.trim(),
        type: form.type,
        value: Number(form.value),
        scope: form.scope,
        categoryId: form.scope === 'category' ? Number(form.categoryId) : null,
        productId: form.scope === 'product' ? Number(form.productId) : null,
        daysOfWeek: form.days,
        startTime: form.startTime === '' ? null : form.startTime,
        endTime: form.endTime === '' ? null : form.endTime,
        startDate: form.startDate === '' ? null : form.startDate,
        endDate: form.endDate === '' ? null : form.endDate,
        active: form.active,
      }
      return editing === null
        ? apiFetch<{ promotion: PromotionDTO }>('/api/promotions', {
            method: 'POST',
            body: payload,
          })
        : apiFetch<{ promotion: PromotionDTO }>(`/api/promotions/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      // invalidate the whole promotions prefix — the POS active-list
      // preview shares the cache tree
      void queryClient.invalidateQueries({ queryKey: ['promotions'] })
      toast.success(t('r17.promo.saved'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ promotion: PromotionDTO }>(`/api/promotions/${id}`, {
        method: 'PUT',
        body: { active },
      }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['promotions'] })
      const prev = queryClient.getQueryData<{ promotions: PromotionDTO[] }>(['promotions'])
      if (prev) {
        queryClient.setQueryData(['promotions'], {
          promotions: prev.promotions.map((p) => (p.id === id ? { ...p, active } : p)),
        })
      }
      return { prev }
    },
    onSuccess: () => toast.success(t('r17.promo.saved')),
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['promotions'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['promotions'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean }>(`/api/promotions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['promotions'] })
      toast.success(t('r17.promo.deleted'))
      setDeleteTarget(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormOpen(true)
  }

  function openEdit(promo: PromotionDTO) {
    setEditing(promo)
    setForm({
      name: promo.name,
      nameAr: promo.nameAr ?? '',
      type: promo.type === 'fixed' ? 'fixed' : 'percent',
      value: String(Number(promo.value.toFixed(2))),
      scope: promo.scope === 'category' || promo.scope === 'product' ? promo.scope : 'order',
      categoryId: promo.categoryId != null ? String(promo.categoryId) : '',
      productId: promo.productId != null ? String(promo.productId) : '',
      days:
        promo.daysOfWeek.length === 0 || promo.daysOfWeek.length === 7
          ? [0, 1, 2, 3, 4, 5, 6]
          : [...promo.daysOfWeek].sort((a, b) => a - b),
      startTime: promo.startTime ?? '',
      endTime: promo.endTime ?? '',
      startDate: promo.startDate ?? '',
      endDate: promo.endDate ?? '',
      active: promo.active,
    })
    setFormOpen(true)
  }

  function toggleDay(day: number) {
    setForm((f) => ({
      ...f,
      days: f.days.includes(day)
        ? f.days.filter((d) => d !== day)
        : [...f.days, day].sort((a, b) => a - b),
    }))
  }

  const loading = promosQuery.isLoading

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('nav.promotions')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('r17.promo.title')}</h1>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('r17.promo.new')}
        </Button>
      </div>

      {/* Header card: subtitle + engine rules note */}
      <Card className="gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Zap className="size-4.5" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">{t('r17.promo.subtitle')}</p>
            <p className="text-xs text-muted-foreground">{t('r17.promo.rules')}</p>
          </div>
        </div>
      </Card>

      {/* Promo list */}
      <Card className="p-4">
        {promosQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('r17.common.error')}</p>
              <p className="text-muted-foreground text-sm">
                {promosQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void promosQuery.refetch()}
            >
              {t('r17.common.retry')}
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-5 w-16" />
                <Skeleton className="size-11 rounded-md" />
              </div>
            ))}
          </div>
        ) : promos.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <Zap className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('r17.promo.empty')}</p>
              <p className="text-muted-foreground text-sm">{t('r17.promo.rules')}</p>
            </div>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> {t('r17.promo.new')}
            </Button>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] space-y-2 overflow-y-auto">
            {promos.map((p) => {
              const everyDay = p.daysOfWeek.length === 0 || p.daysOfWeek.length === 7
              const timeWindow =
                p.startTime == null && p.endTime == null
                  ? null
                  : `${p.startTime ?? '00:00'}–${p.endTime ?? '24:00'}`
              return (
                <div
                  key={p.id}
                  className={cn(
                    'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3',
                    !p.active && 'bg-muted/40',
                  )}
                >
                  {/* name + type/scope/schedule */}
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p
                        className={cn(
                          'truncate font-medium',
                          !p.active && 'text-muted-foreground',
                        )}
                      >
                        {localizedName(p.name, p.nameAr, lang)}
                      </p>
                      {/* discount type + value chip */}
                      <Badge
                        variant="outline"
                        className="h-5 shrink-0 border-emerald-600/30 bg-emerald-50 px-1.5 text-[10px] font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                      >
                        {valueLabel(p, t)}
                      </Badge>
                      {/* scope chip */}
                      <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px]">
                        <Tag className="me-0.5 size-2.5" aria-hidden />
                        {p.scope === 'category'
                          ? (p.category?.name ?? t(scopeLabelKey(p.scope)))
                          : p.scope === 'product'
                            ? (p.product?.name ?? t(scopeLabelKey(p.scope)))
                            : t(scopeLabelKey(p.scope))}
                      </Badge>
                      {!p.active && (
                        <Badge
                          variant="outline"
                          className="h-5 shrink-0 border-amber-500/40 px-1.5 text-[10px] text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
                        >
                          {t('r17.common.inactive')}
                        </Badge>
                      )}
                    </div>
                    {/* schedule summary */}
                    <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
                      {everyDay ? (
                        <span className="text-xs">{t('r17.promo.daysAll')}</span>
                      ) : (
                        p.daysOfWeek.map((d) => (
                          <Badge
                            key={d}
                            variant="outline"
                            className="h-5 px-1.5 text-[10px] tabular-nums"
                          >
                            {t(`r17.day.${WEEKDAY_KEYS[d]}`)}
                          </Badge>
                        ))
                      )}
                      <span className="inline-flex items-center gap-1 text-xs">
                        <Clock className="size-3" aria-hidden />
                        {timeWindow ?? t('r17.promo.allDay')}
                      </span>
                      {(p.startDate != null || p.endDate != null) && (
                        <span className="inline-flex items-center gap-1 text-xs">
                          <CalendarRange className="size-3" aria-hidden />
                          {p.startDate ?? '…'} → {p.endDate ?? '…'}
                        </span>
                      )}
                    </div>
                  </div>
                  <Switch
                    checked={p.active}
                    disabled={toggleMutation.isPending && toggleMutation.variables?.id === p.id}
                    onCheckedChange={(checked) => toggleMutation.mutate({ id: p.id, active: checked })}
                    aria-label={`${p.name} — ${t('r17.promo.active')}`}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11 shrink-0 text-muted-foreground"
                        aria-label={t('r17.common.edit')}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(p)}>
                        <Pencil /> {t('r17.common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(p)}>
                        <Trash2 /> {t('r17.common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('r17.promo.new') : t('r17.common.edit')}</DialogTitle>
            <DialogDescription>{t('r17.promo.rules')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="promo-name">
                  {t('r17.promo.name')} *
                </Label>
                <Input
                  id="promo-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.name ? true : undefined}
                />
                <FieldError message={errors.name} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="promo-name-ar">{t('r17.promo.nameAr')}</Label>
                <Input
                  id="promo-name-ar"
                  lang="ar"
                  dir="rtl"
                  value={form.nameAr}
                  onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                  className="h-11"
                />
              </div>
            </div>

            {/* discount type + value */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>{t('r17.promo.type')}</Label>
                <div className="flex gap-2" role="group" aria-label={t('r17.promo.type')}>
                  {(['percent', 'fixed'] as const).map((type) => (
                    <Button
                      key={type}
                      type="button"
                      variant={form.type === type ? 'default' : 'outline'}
                      size="sm"
                      className="h-11 flex-1"
                      aria-pressed={form.type === type}
                      onClick={() => setForm({ ...form, type })}
                    >
                      {type === 'percent' ? (
                        t('r17.promo.typePercent')
                      ) : (
                        t('r17.promo.typeFixed')
                      )}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="promo-value">
                  {t('r17.promo.value')} ({form.type === 'percent' ? '%' : t('r17.common.egp')}) *
                </Label>
                <Input
                  id="promo-value"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={form.type === 'percent' ? 1 : 0.5}
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  className="h-11 tabular-nums"
                  aria-invalid={errors.value ? true : undefined}
                />
                <FieldError message={errors.value} />
              </div>
            </div>

            {/* scope + target */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="promo-scope">{t('r17.promo.scope')}</Label>
                <Select
                  value={form.scope}
                  onValueChange={(v) =>
                    setForm({ ...form, scope: v as PromoForm['scope'] })
                  }
                >
                  <SelectTrigger id="promo-scope" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="order">{t('r17.promo.scopeOrder')}</SelectItem>
                    <SelectItem value="category">{t('r17.promo.scopeCategory')}</SelectItem>
                    <SelectItem value="product">{t('r17.promo.scopeProduct')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {form.scope === 'category' && (
                <div className="grid gap-2">
                  <Label htmlFor="promo-category">{t('r17.promo.category')} *</Label>
                  <Select
                    value={form.categoryId}
                    onValueChange={(v) => setForm({ ...form, categoryId: v })}
                  >
                    <SelectTrigger id="promo-category" className="h-11 w-full">
                      <SelectValue placeholder={t('r17.promo.category')} />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {localizedName(c.name, c.nameAr, lang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError message={errors.scope} />
                </div>
              )}
              {form.scope === 'product' && (
                <div className="grid gap-2">
                  <Label htmlFor="promo-product">{t('r17.promo.product')} *</Label>
                  <Select
                    value={form.productId}
                    onValueChange={(v) => setForm({ ...form, productId: v })}
                  >
                    <SelectTrigger id="promo-product" className="h-11 w-full">
                      <SelectValue placeholder={t('r17.promo.product')} />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {localizedName(p.name, p.nameAr, lang)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError message={errors.scope} />
                </div>
              )}
            </div>

            {/* weekday pills */}
            <div className="grid gap-2">
              <Label>{t('r17.promo.days')}</Label>
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label={t('r17.promo.days')}
              >
                {WEEKDAY_KEYS.map((key, day) => (
                  <Button
                    key={key}
                    type="button"
                    variant={form.days.includes(day) ? 'default' : 'outline'}
                    size="sm"
                    className="h-11 min-w-11 px-2"
                    aria-pressed={form.days.includes(day)}
                    onClick={() => toggleDay(day)}
                  >
                    {t(`r17.day.${key}`)}
                  </Button>
                ))}
              </div>
              <p className="text-muted-foreground text-xs">
                {form.days.length === 7 || form.days.length === 0
                  ? t('r17.promo.daysAll')
                  : form.days
                      .slice()
                      .sort((a, b) => a - b)
                      .map((d) => t(`r17.day.${WEEKDAY_KEYS[d]}`))
                      .join(' · ')}
              </p>
            </div>

            {/* time window */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="promo-start-time">{t('r17.promo.start')}</Label>
                <Input
                  id="promo-start-time"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  className="h-11 tabular-nums"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="promo-end-time">{t('r17.promo.end')}</Label>
                <Input
                  id="promo-end-time"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  className="h-11 tabular-nums"
                />
              </div>
            </div>

            {/* date range */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="promo-start-date">{t('r17.common.from')}</Label>
                <Input
                  id="promo-start-date"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                  className="h-11 tabular-nums"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="promo-end-date">{t('r17.common.to')}</Label>
                <Input
                  id="promo-end-date"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  className="h-11 tabular-nums"
                />
              </div>
            </div>

            {/* active switch */}
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <Timer className="size-4 text-muted-foreground" aria-hidden />
                <Label htmlFor="promo-active">{t('r17.promo.active')}</Label>
              </div>
              <Switch
                id="promo-active"
                checked={form.active}
                onCheckedChange={(checked) => setForm({ ...form, active: checked })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setFormOpen(false)}
              disabled={saveMutation.isPending}
            >
              {t('r17.common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? t('r17.common.loading') : t('r17.common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('r17.promo.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? `${localizedName(deleteTarget.name, deleteTarget.nameAr, lang)} — ${valueLabel(
                    deleteTarget,
                    t,
                  )} (${
                    deleteTarget.scope === 'order'
                      ? t('r17.promo.scopeOrder')
                      : (deleteTarget.category?.name ??
                        deleteTarget.product?.name ??
                        t(scopeLabelKey(deleteTarget.scope)))
                  })`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('r17.common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              className="h-11"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
              }}
            >
              {deleteMutation.isPending ? t('r17.common.loading') : t('r17.common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
