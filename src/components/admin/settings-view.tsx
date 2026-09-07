'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarClock,
  Clock,
  DatabaseBackup,
  Info,
  Loader2,
  MoonStar,
  Pencil,
  Plus,
  Save,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatTime } from '@/lib/format'
import type { AppSettings, BackupInfo, Shift } from '@/lib/types'
import { useAppSettings, updateAppSettings } from '@/lib/use-settings'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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

const TIME_INPUT_CLASS = 'h-11 text-base'

/** true when the shift crosses midnight (e.g. 23:00 → 07:00). */
function isOvernight(shift: Pick<Shift, 'startTime' | 'endTime'>): boolean {
  return shift.endTime < shift.startTime
}

// ─── View ───────────────────────────────────────────────────────────

export default function SettingsView() {
  const { t } = useI18n()
  const { query: settingsQuery, settings, restaurantName, restaurantNameAr } = useAppSettings()

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header — Odoo control-panel style */}
      <div className="space-y-1">
        <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
          <span>{t('nav.home')}</span>
          <span className="mx-1.5" aria-hidden>
            /
          </span>
          <span className="font-medium text-primary">{t('nav.settings')}</span>
        </nav>
        <h1 className="text-2xl font-bold tracking-tight">{t('nav.settings')}</h1>
        <p className="text-sm text-muted-foreground">{t('admin.settingsSubtitle')}</p>
      </div>

      {/* Card 1 — restaurant profile */}
      {settingsQuery.isLoading ? (
        <Card className="space-y-4 p-6">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-28" />
        </Card>
      ) : settingsQuery.isError ? (
        <Card className="flex flex-col items-center justify-center gap-3 p-8 text-center">
          <TriangleAlert className="size-10 text-destructive" aria-hidden />
          <p className="font-medium">
            {settingsQuery.error?.message ?? t('error.generic')}
          </p>
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void settingsQuery.refetch()}
          >
            {t('common.retry')}
          </Button>
        </Card>
      ) : (
        // Keyed by the loaded names: the form (re)mounts with the fresh values
        // after the query loads or after a successful save invalidation.
        <ProfileForm
          key={`${settings?.restaurantName ?? restaurantName}|${settings?.restaurantNameAr ?? restaurantNameAr}`}
          initialName={settings?.restaurantName ?? restaurantName}
          initialNameAr={settings?.restaurantNameAr ?? restaurantNameAr}
        />
      )}

      {/* Card 2 — security (item-deletion PIN) */}
      <SecurityCard />

      {/* Card 3 — data & backups (one-click SQLite snapshot) */}
      <BackupCard />

      {/* Card 4 — shifts */}
      <ShiftsCard />
    </div>
  )
}

// ─── Restaurant profile form ────────────────────────────────────────

function ProfileForm({ initialName, initialNameAr }: { initialName: string; initialNameAr: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [name, setName] = useState(initialName)
  const [nameAr, setNameAr] = useState(initialNameAr)

  const saveMutation = useMutation({
    mutationFn: () =>
      updateAppSettings(queryClient, {
        restaurantName: name.trim() || initialName,
        restaurantNameAr: nameAr,
      }),
    onSuccess: () => toast.success(t('settings.saved')),
    onError: (err: Error) => toast.error(err.message),
  })

  const dirty = name.trim() !== initialName.trim() || nameAr.trim() !== initialNameAr.trim()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile')}</CardTitle>
        <CardDescription>{t('admin.settingsProfileDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="restaurant-name">{t('settings.restaurantName')}</Label>
          <Input
            id="restaurant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11"
            maxLength={60}
            placeholder="Saffron Table"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="restaurant-name-ar">{t('settings.restaurantNameAr')}</Label>
          <Input
            id="restaurant-name-ar"
            lang="ar"
            dir="rtl"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            className="h-11"
            maxLength={60}
            placeholder="ليلو كافيه ومطعم"
          />
          <p className="text-xs text-muted-foreground">{t('settings.restaurantNameArHint')}</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            className="h-11"
            disabled={saveMutation.isPending || !dirty}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Security card (item-deletion PIN) ───────────────────────────────

/** Digit-only filter for the PIN input (paste-safe). */
const DIGITS_ONLY = /\D/g

function SecurityCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // The PIN is write-only (GET /api/settings never returns it), so the input
  // starts EMPTY: saving requires typing all 6 digits; leaving it blank keeps
  // the current PIN (no request is sent).
  const [pin, setPin] = useState('')

  const saveMutation = useMutation({
    mutationFn: () =>
      updateAppSettings(queryClient, { deleteItemPin: pin } as Partial<AppSettings>),
    onSuccess: () => {
      toast.success(t('settings.deletePinSaved'))
      setPin('')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const pinInvalid = pin !== '' && !/^\d{6}$/.test(pin)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-5 text-primary" aria-hidden />
          {t('settings.security')}
        </CardTitle>
        <CardDescription>{t('settings.deletePinHint')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="delete-item-pin">{t('settings.deletePin')}</Label>
          <Input
            id="delete-item-pin"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(DIGITS_ONLY, '').slice(0, 6))}
            className="h-11"
            maxLength={6}
            placeholder="••••••"
            aria-invalid={pinInvalid || undefined}
          />
          {pinInvalid ? (
            <p className="text-destructive text-xs" role="alert">
              {t('settings.deletePinInvalid')}
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">
              {t('auth.pinStatus', { n: pin.length, total: 6 })}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            className="h-11"
            disabled={saveMutation.isPending || pin === '' || pinInvalid}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Data & backups card (one-click SQLite snapshot) ────────────────

/** Human-readable file size: B below 1 KB, then KB / MB with one decimal. */
function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function BackupCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Shown when the API answers 501 (remote database — no local file to copy).
  const [unavailable, setUnavailable] = useState(false)

  const backupsQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => fetcher<{ backups: BackupInfo[] }>('/api/admin/backup'),
    refetchInterval: 15000,
  })

  const backupMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ backup: BackupInfo }>('/api/admin/backup', { method: 'POST' }),
    onSuccess: (data) => {
      setUnavailable(false)
      toast.success(t('admin.backupDone', { name: data.backup.name }))
      void queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (err: Error) => {
      if (/unavailable/i.test(err.message)) {
        // 501 — remote-database deployment: friendly amber note, no red toast.
        setUnavailable(true)
        toast(err.message)
      } else {
        toast.error(err.message)
      }
    },
  })

  const backups = backupsQuery.data?.backups ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="size-5 text-primary" aria-hidden />
          {t('admin.backupTitle')}
        </CardTitle>
        <CardDescription>{t('admin.backupSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-end gap-2">
          <Button
            className="h-11"
            disabled={backupMutation.isPending}
            onClick={() => backupMutation.mutate()}
          >
            {backupMutation.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <DatabaseBackup className="size-4" />
            )}
            {backupMutation.isPending ? t('admin.backupBackingUp') : t('admin.backupNow')}
          </Button>
        </div>

        {unavailable ? (
          <p
            className="flex items-start gap-2 rounded-lg border border-amber-600/40 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400"
            role="note"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{t('admin.backupUnavailable')}</span>
          </p>
        ) : null}

        <div className="grid gap-2">
          <p className="text-sm font-medium">{t('admin.backupListTitle')}</p>
          {backupsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : backupsQuery.isError ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <TriangleAlert className="size-10 text-destructive" aria-hidden />
              <div>
                <p className="font-medium">{t('admin.backupLoadFailed')}</p>
                <p className="text-muted-foreground text-sm">
                  {backupsQuery.error?.message ?? t('common.error')}
                </p>
              </div>
              <Button
                variant="outline"
                className="h-11"
                onClick={() => void backupsQuery.refetch()}
              >
                {t('common.retry')}
              </Button>
            </div>
          ) : backups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-8 text-center">
              <DatabaseBackup className="size-10 text-muted-foreground/40" aria-hidden />
              <p className="font-medium">{t('admin.backupEmpty')}</p>
            </div>
          ) : (
            <div className="rms-scroll max-h-64 overflow-y-auto rounded-lg border">
              <table className="w-full">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th
                      scope="col"
                      className="p-2.5 text-start text-xs font-medium text-muted-foreground"
                    >
                      {t('admin.backupName')}
                    </th>
                    <th
                      scope="col"
                      className="w-20 p-2.5 text-end text-xs font-medium text-muted-foreground"
                    >
                      {t('admin.backupSize')}
                    </th>
                    <th
                      scope="col"
                      className="w-16 p-2.5 text-end text-xs font-medium text-muted-foreground"
                    >
                      {t('admin.backupCreated')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {backups.map((backup, i) => (
                    <tr
                      key={backup.name}
                      className={cn(i === 0 && 'bg-amber-50/50 dark:bg-amber-500/5')}
                    >
                      <td className="max-w-0 truncate p-2.5 font-mono text-xs">
                        {backup.name}
                      </td>
                      <td className="p-2.5 text-end text-xs tabular-nums text-muted-foreground">
                        {formatBackupSize(backup.sizeBytes)}
                      </td>
                      <td className="p-2.5 text-end text-xs tabular-nums text-muted-foreground">
                        {formatTime(backup.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ─── Shifts card ────────────────────────────────────────────────────

type ShiftForm = { name: string; startTime: string; endTime: string }

const EMPTY_SHIFT_FORM: ShiftForm = { name: '', startTime: '09:00', endTime: '17:00' }

function ShiftsCard() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Shift | null>(null)
  const [form, setForm] = useState<ShiftForm>(EMPTY_SHIFT_FORM)

  const shiftsQuery = useQuery({
    queryKey: ['shifts'],
    queryFn: () => fetcher<{ shifts: Shift[] }>('/api/shifts'),
  })

  const shifts = [...(shiftsQuery.data?.shifts ?? [])].sort((a, b) => a.id - b.id)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        startTime: form.startTime,
        endTime: form.endTime,
      }
      return editing === null
        ? apiFetch<{ shift: Shift }>('/api/shifts', { method: 'POST', body: payload })
        : apiFetch<{ shift: Shift }>(`/api/shifts/${editing.id}`, {
            method: 'PUT',
            body: payload,
          })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['shifts'] })
      toast.success(editing === null ? t('admin.shiftCreated') : t('admin.shiftUpdated'))
      setDialogOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: number; active: boolean }) =>
      apiFetch<{ shift: Shift }>(`/api/shifts/${id}`, { method: 'PUT', body: { active } }),
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: ['shifts'] })
      const prev = queryClient.getQueryData<{ shifts: Shift[] }>(['shifts'])
      if (prev) {
        queryClient.setQueryData(['shifts'], {
          shifts: prev.shifts.map((s) => (s.id === id ? { ...s, active } : s)),
        })
      }
      return { prev }
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.active ? t('admin.shiftActivated') : t('admin.shiftDeactivated'))
    },
    onError: (err: Error, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['shifts'], ctx.prev)
      toast.error(err.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['shifts'] })
    },
  })

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_SHIFT_FORM)
    setDialogOpen(true)
  }

  function openEdit(shift: Shift) {
    setEditing(shift)
    setForm({ name: shift.name, startTime: shift.startTime, endTime: shift.endTime })
    setDialogOpen(true)
  }

  const isCreate = editing === null
  const nameError = form.name.trim() === '' ? t('admin.shiftNameRequired') : undefined
  const timesError =
    form.startTime === '' || form.endTime === '' ? t('admin.shiftTimesRequired') : undefined

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span>{t('shift.shifts')}</span>
          <Button variant="outline" size="sm" className="h-9" onClick={openCreate}>
            <Plus className="size-4" /> {t('admin.addShift')}
          </Button>
        </CardTitle>
        <CardDescription>{t('admin.settingsShiftsDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {shiftsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : shiftsQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.loadShiftsFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {shiftsQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void shiftsQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : shifts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
            <CalendarClock className="size-10 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">{t('admin.noShifts')}</p>
            <p className="text-sm text-muted-foreground">{t('admin.noShiftsHint')}</p>
            <Button variant="outline" className="h-11" onClick={openCreate}>
              <Plus /> {t('admin.addShift')}
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {shifts.map((shift) => (
              <div
                key={shift.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 p-3',
                  !shift.active && 'bg-muted/40',
                )}
              >
                <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className={cn(
                        'truncate text-sm font-semibold',
                        !shift.active && 'text-muted-foreground',
                      )}
                    >
                      {shift.name}
                    </p>
                    {isOvernight(shift) && (
                      <Badge
                        variant="outline"
                        className="gap-1 border-violet-500/30 bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400"
                      >
                        <MoonStar className="size-3" aria-hidden />
                        {t('admin.overnight')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                    {shift.startTime} – {shift.endTime}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 text-muted-foreground"
                    onClick={() => openEdit(shift)}
                    aria-label={`${t('common.edit')} ${shift.name}`}
                  >
                    <Pencil />
                  </Button>
                  <Switch
                    checked={shift.active}
                    disabled={toggleMutation.isPending && toggleMutation.variables?.id === shift.id}
                    onCheckedChange={(checked) =>
                      toggleMutation.mutate({ id: shift.id, active: checked })
                    }
                    aria-label={`${t('common.active')}: ${shift.name}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="flex items-start gap-2 rounded-lg border border-dashed bg-muted/30 p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t('shift.note')}</span>
        </p>
      </CardContent>

      {/* Add / edit shift dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isCreate ? t('admin.addShift') : `${t('admin.editShift')} — ${editing?.name ?? ''}`}
            </DialogTitle>
            <DialogDescription>{t('admin.shiftDialogDesc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="shift-name">{t('admin.shiftName')} *</Label>
              <Input
                id="shift-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t('admin.shiftNamePlaceholder')}
                className="h-11"
                aria-invalid={nameError ? true : undefined}
              />
              {nameError ? <p className="text-destructive text-xs">{nameError}</p> : null}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="shift-start">{t('shift.startTime')} *</Label>
                <Input
                  id="shift-start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                  className={TIME_INPUT_CLASS}
                  aria-invalid={timesError ? true : undefined}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="shift-end">{t('shift.endTime')} *</Label>
                <Input
                  id="shift-end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                  className={TIME_INPUT_CLASS}
                  aria-invalid={timesError ? true : undefined}
                />
              </div>
            </div>
            {timesError ? <p className="text-destructive text-xs">{timesError}</p> : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => setDialogOpen(false)}
              disabled={saveMutation.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11"
              disabled={saveMutation.isPending || nameError !== undefined || timesError !== undefined}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              {isCreate ? t('admin.addShift') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
