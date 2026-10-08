'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ListPlus, MoreHorizontal, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { MAX_OPTIONS_PER_GROUP } from '@/lib/constants'
import type { ModifierGroupDTO } from '@/lib/types'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'

// ─── Form state & validation (mirrors the API rules) ────────────────

type OptionRow = {
  key: string // stable React key (new rows have no DB id yet)
  id?: number // present = update the existing option on save
  name: string
  nameAr: string
  priceDelta: string // '' = 0
  sortOrder: string
}

type GroupForm = {
  name: string
  nameAr: string
  minSelect: string
  maxSelect: string
  sortOrder: string
  options: OptionRow[]
}

type GroupFormErrors = {
  name?: string
  minSelect?: string
  maxSelect?: string
  sortOrder?: string
  optionsName?: string
}

function validateGroupForm(form: GroupForm, t: (key: string) => string): GroupFormErrors {
  const errors: GroupFormErrors = {}
  if (form.name.trim() === '') errors.name = t('admin.nameRequired')

  const min = Number(form.minSelect)
  const minOk =
    form.minSelect.trim() !== '' && Number.isInteger(min) && min >= 0 && min <= 10
  if (!minOk) errors.minSelect = t('admin.orderWhole')

  const max = Number(form.maxSelect)
  const maxOk =
    form.maxSelect.trim() !== '' && Number.isInteger(max) && max >= 1 && max <= 10
  if (!maxOk) errors.maxSelect = t('admin.orderWhole')

  if (minOk && maxOk && min > max) {
    // groupHint explains the rule: max ≥ 1 required at the POS, etc.
    errors.maxSelect = t('admin.groupHint')
  }

  const sort = Number(form.sortOrder)
  if (form.sortOrder.trim() === '' || !Number.isInteger(sort) || sort < 0) {
    errors.sortOrder = t('admin.orderWhole')
  }

  if (form.options.some((o) => o.name.trim() === '')) {
    errors.optionsName = t('admin.nameRequired')
  }
  return errors
}

/** Non-finite / non-integer option inputs block saving (visual state only). */
function optionRowInvalid(o: OptionRow): boolean {
  const price = o.priceDelta.trim()
  if (price !== '' && !Number.isFinite(Number(price))) return true
  const order = o.sortOrder.trim()
  if (order === '' || !Number.isInteger(Number(order)) || Number(order) < 0) return true
  return false
}

function toGroupForm(g: ModifierGroupDTO): GroupForm {
  return {
    name: g.name,
    nameAr: g.nameAr ?? '',
    minSelect: String(g.minSelect),
    maxSelect: String(g.maxSelect),
    sortOrder: String(g.sortOrder),
    options: g.modifiers.map((m) => ({
      key: `opt-${m.id}`,
      id: m.id,
      name: m.name,
      nameAr: m.nameAr ?? '',
      priceDelta: String(m.priceDelta),
      sortOrder: String(m.sortOrder),
    })),
  }
}

// ─── Small presentational helpers ───────────────────────────────────

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-destructive text-xs">{message}</p>
}

function BadgeOrder({ order }: { order: number }) {
  return (
    <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] tabular-nums">
      {order}
    </Badge>
  )
}

/** Amber outline badge for untranslated items — Arabic mode only. */
function MissingArBadge({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className="h-5 shrink-0 border-amber-500/40 px-1.5 text-[10px] font-medium text-amber-700 dark:border-amber-400/40 dark:text-amber-400"
    >
      {label}
    </Badge>
  )
}

/** +EGP 8 / −EGP 3 / ±0 — explicit sign with formatCurrency. */
function PriceDeltaText({ delta }: { delta: number }) {
  if (Math.abs(delta) < 0.005) {
    return <span className="text-muted-foreground text-xs tabular-nums">±0</span>
  }
  if (delta > 0) {
    return (
      <span className="text-xs font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
        +{formatCurrency(delta)}
      </span>
    )
  }
  return (
    <span className="text-xs font-medium tabular-nums text-rose-700 dark:text-rose-400">
      −{formatCurrency(Math.abs(delta))}
    </span>
  )
}

// ─── View ───────────────────────────────────────────────────────────

export default function ModifiersView() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ModifierGroupDTO | null>(null)
  const [form, setForm] = useState<GroupForm>({
    name: '',
    nameAr: '',
    minSelect: '0',
    maxSelect: '1',
    sortOrder: '0',
    options: [],
  })
  const [deleteTarget, setDeleteTarget] = useState<ModifierGroupDTO | null>(null)

  const groupsQuery = useQuery({
    queryKey: ['modifier-groups'],
    queryFn: () => fetcher<{ groups: ModifierGroupDTO[] }>('/api/modifier-groups'),
  })

  const groups = useMemo(
    () =>
      [...(groupsQuery.data?.groups ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.id - b.id,
      ),
    [groupsQuery.data],
  )

  function nextSortOrder(): string {
    if (groups.length === 0) return '10'
    const max = groups.reduce((acc, g) => Math.max(acc, g.sortOrder), 0)
    return String(Math.min(999, max + 10))
  }

  const isCreate = editing === null
  const errors = validateGroupForm(form, t)
  const optionsInvalid = form.options.some((o) => optionRowInvalid(o))
  const hasErrors = Object.values(errors).some(Boolean) || optionsInvalid

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim(),
        minSelect: Number(form.minSelect),
        maxSelect: Number(form.maxSelect),
        sortOrder: Number(form.sortOrder),
        // full option list → replace semantics on the API
        modifiers: form.options.map((o) => ({
          ...(o.id !== undefined ? { id: o.id } : {}),
          name: o.name.trim(),
          nameAr: o.nameAr.trim(),
          priceDelta: o.priceDelta.trim() === '' ? 0 : Number(o.priceDelta),
          sortOrder: Number(o.sortOrder),
        })),
      }
      return editing === null
        ? apiFetch<{ group: ModifierGroupDTO }>('/api/modifier-groups', {
            method: 'POST',
            body: payload,
          })
        : apiFetch<{ group: ModifierGroupDTO }>(`/api/modifier-groups/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['modifier-groups'] })
      // products embed modifierGroups in their payloads — refresh them too
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(t('admin.groupSaved'))
      setFormOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ group: ModifierGroupDTO }>(`/api/modifier-groups/${id}`, {
        method: 'PUT',
        body: { active },
      }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['modifier-groups'] })
      const prev = queryClient.getQueryData<{ groups: ModifierGroupDTO[] }>([
        'modifier-groups',
      ])
      if (prev) {
        queryClient.setQueryData(['modifier-groups'], {
          groups: prev.groups.map((g) => (g.id === id ? { ...g, active } : g)),
        })
      }
      return { prev }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] })
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['modifier-groups'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['modifier-groups'] })
    },
  })

  // hard delete (past order items keep their JSON snapshot)
  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean }>(`/api/modifier-groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['modifier-groups'] })
      void queryClient.invalidateQueries({ queryKey: ['products'] })
      toast.success(t('common.done'))
      setDeleteTarget(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function openCreate() {
    setEditing(null)
    setForm({
      name: '',
      nameAr: '',
      minSelect: '0',
      maxSelect: '1',
      sortOrder: nextSortOrder(),
      options: [],
    })
    setFormOpen(true)
  }

  function openEdit(group: ModifierGroupDTO) {
    setEditing(group)
    setForm(toGroupForm(group))
    setFormOpen(true)
  }

  function addOption() {
    setForm((f) => ({
      ...f,
      options: [
        ...f.options,
        {
          key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: '',
          nameAr: '',
          priceDelta: '',
          sortOrder: String(f.options.length + 1),
        },
      ],
    }))
  }

  function updateOption(index: number, patch: Partial<Omit<OptionRow, 'key' | 'id'>>) {
    setForm((f) => ({
      ...f,
      options: f.options.map((o, i) => (i === index ? { ...o, ...patch } : o)),
    }))
  }

  function removeOption(index: number) {
    setForm((f) => ({ ...f, options: f.options.filter((_, i) => i !== index) }))
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">{t('admin.modifiersTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('admin.modifiersSubtitle')}</p>
        </div>
        <Button className="h-11" onClick={openCreate}>
          <Plus /> {t('admin.newGroup')}
        </Button>
      </div>

      {/* Group cards */}
      <Card className="p-4">
        {groupsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-56" />
                </div>
                <Skeleton className="h-5 w-16" />
                <Skeleton className="size-11 rounded-md" />
              </div>
            ))}
          </div>
        ) : groupsQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('common.error')}</p>
              <p className="text-muted-foreground text-sm">
                {groupsQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void groupsQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <ListPlus className="size-10 text-muted-foreground/50" aria-hidden />
            <p className="text-muted-foreground">{t('admin.noGroups')}</p>
            <Button className="h-11" onClick={openCreate}>
              <Plus /> {t('admin.newGroup')}
            </Button>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] space-y-3 overflow-y-auto">
            {groups.map((g) => (
              <div
                key={g.id}
                className={cn(
                  'rounded-lg border p-3 sm:p-4',
                  !g.active && 'bg-muted/40',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p
                        className={cn(
                          'truncate font-medium',
                          !g.active && 'text-muted-foreground',
                        )}
                      >
                        {localizedName(g.name, g.nameAr, lang)}
                      </p>
                      {lang === 'ar' && !(g.nameAr ?? '').trim() && (
                        <MissingArBadge label={t('admin.missingAr')} />
                      )}
                      <BadgeOrder order={g.sortOrder} />
                      {g.minSelect >= 1 ? (
                        <Badge
                          variant="outline"
                          className="border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400"
                        >
                          {t('admin.requiredGroup')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground">
                          {t('admin.optionalGroup')}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-muted-foreground">
                        {g.maxSelect === 1
                          ? t('admin.pickOne')
                          : t('admin.pickUpTo', { n: g.maxSelect })}
                      </Badge>
                      <Badge variant="outline" className="text-muted-foreground">
                        {t('admin.attachedProducts', { n: g.productCount ?? 0 })}
                      </Badge>
                    </div>
                    {lang === 'ar' && g.name !== localizedName(g.name, g.nameAr, lang) ? (
                      <p className="truncate text-muted-foreground text-xs">{g.name}</p>
                    ) : lang === 'en' && (g.nameAr ?? '').trim() ? (
                      <p className="truncate text-muted-foreground text-xs" dir="rtl" lang="ar">
                        {g.nameAr}
                      </p>
                    ) : null}

                    {/* Options */}
                    {g.modifiers.length === 0 ? (
                      <p className="text-muted-foreground text-sm">{t('admin.noOptions')}</p>
                    ) : (
                      <div className="space-y-0.5">
                        {g.modifiers.map((m) => (
                          <div key={m.id} className="flex items-center gap-2 text-sm">
                            <span className="w-7 shrink-0 text-end font-mono text-[10px] text-muted-foreground/70 tabular-nums">
                              {m.sortOrder}
                            </span>
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate',
                                !m.active && 'text-muted-foreground/60',
                              )}
                            >
                              {localizedName(m.name, m.nameAr, lang)}
                              {!m.active && (
                                <span className="text-muted-foreground text-xs">
                                  {' '}
                                  · {t('common.inactive')}
                                </span>
                              )}
                            </span>
                            <PriceDeltaText delta={m.priceDelta} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={g.active}
                      disabled={
                        toggleMutation.isPending && toggleMutation.variables?.id === g.id
                      }
                      onCheckedChange={(checked) =>
                        toggleMutation.mutate({ id: g.id, active: checked })
                      }
                      aria-label={`${g.active ? t('admin.deactivate') : t('admin.activate')} ${g.name}`}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-11 text-muted-foreground"
                          aria-label={t('admin.actionsFor', { name: g.name })}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(g)}>
                          <Pencil /> {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(g)}>
                          <Trash2 /> {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Create / edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{isCreate ? t('admin.newGroup') : t('admin.editGroup')}</DialogTitle>
            <DialogDescription>{t('admin.groupHint')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="modifier-group-name">
                  {t('admin.groupName')} *
                </Label>
                <Input
                  id="modifier-group-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.name ? true : undefined}
                />
                <FieldError message={errors.name} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="modifier-group-name-ar">{t('admin.groupNameAr')}</Label>
                <Input
                  id="modifier-group-name-ar"
                  lang="ar"
                  dir="rtl"
                  value={form.nameAr}
                  onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
                  placeholder={t('admin.nameArPlaceholder')}
                  className="h-11"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="modifier-group-min">{t('admin.minSelect')}</Label>
                <Input
                  id="modifier-group-min"
                  type="number"
                  step={1}
                  min={0}
                  max={10}
                  inputMode="numeric"
                  value={form.minSelect}
                  onChange={(e) => setForm({ ...form, minSelect: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.minSelect ? true : undefined}
                />
                <FieldError message={errors.minSelect} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="modifier-group-max">{t('admin.maxSelect')}</Label>
                <Input
                  id="modifier-group-max"
                  type="number"
                  step={1}
                  min={1}
                  max={10}
                  inputMode="numeric"
                  value={form.maxSelect}
                  onChange={(e) => setForm({ ...form, maxSelect: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.maxSelect ? true : undefined}
                />
                <FieldError message={errors.maxSelect} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="modifier-group-sort">{t('admin.sortOrder')}</Label>
                <Input
                  id="modifier-group-sort"
                  type="number"
                  step={1}
                  min={0}
                  inputMode="numeric"
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  className="h-11"
                  aria-invalid={errors.sortOrder ? true : undefined}
                />
                <FieldError message={errors.sortOrder} />
              </div>
            </div>

            {/* Options editor (full replace on save) */}
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{t('admin.options')}</Label>
                <Button
                  variant="outline"
                  className="h-11"
                  onClick={addOption}
                  disabled={form.options.length >= MAX_OPTIONS_PER_GROUP}
                >
                  <Plus /> {t('admin.newOption')}
                </Button>
              </div>

              {form.options.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-center text-muted-foreground text-sm">
                  {t('admin.noOptions')}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="hidden gap-2 text-muted-foreground text-xs sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.5rem_4.5rem_2.75rem] sm:items-center">
                    <span>{t('admin.optionName')}</span>
                    <span>{t('admin.optionNameAr')}</span>
                    <span>{t('admin.priceDelta')}</span>
                    <span className="text-end">{t('admin.sortOrder')}</span>
                    <span className="sr-only">{t('common.actions')}</span>
                  </div>
                  {form.options.map((o, i) => (
                    <div
                      key={o.key}
                      className="grid grid-cols-2 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6.5rem_4.5rem_2.75rem]"
                    >
                      <Input
                        aria-label={t('admin.optionName')}
                        value={o.name}
                        onChange={(e) => updateOption(i, { name: e.target.value })}
                        className="col-span-2 h-11 sm:col-span-1"
                        aria-invalid={o.name.trim() === '' ? true : undefined}
                      />
                      <Input
                        aria-label={t('admin.optionNameAr')}
                        lang="ar"
                        dir="rtl"
                        value={o.nameAr}
                        onChange={(e) => updateOption(i, { nameAr: e.target.value })}
                        className="col-span-2 h-11 sm:col-span-1"
                      />
                      <Input
                        aria-label={t('admin.priceDelta')}
                        type="number"
                        step={0.01}
                        inputMode="decimal"
                        value={o.priceDelta}
                        onChange={(e) => updateOption(i, { priceDelta: e.target.value })}
                        placeholder="0"
                        className="h-11"
                        aria-invalid={optionRowInvalid(o) ? true : undefined}
                      />
                      <Input
                        aria-label={t('admin.sortOrder')}
                        type="number"
                        step={1}
                        min={0}
                        inputMode="numeric"
                        value={o.sortOrder}
                        onChange={(e) => updateOption(i, { sortOrder: e.target.value })}
                        className="h-11"
                        aria-invalid={optionRowInvalid(o) ? true : undefined}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="col-span-2 h-11 sm:col-span-1 sm:justify-self-end"
                        onClick={() => removeOption(i)}
                        aria-label={t('common.remove')}
                      >
                        <Trash2 className="text-muted-foreground" />
                      </Button>
                    </div>
                  ))}
                  <FieldError message={errors.optionsName} />
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setFormOpen(false)}
              disabled={saveMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || hasErrors}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? t('admin.saving') : isCreate ? t('common.create') : t('admin.saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm (hard delete — past checks keep their options) */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.deleteGroupTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.deleteGroupDesc')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              className="h-11"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id)
              }}
            >
              {t('common.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
