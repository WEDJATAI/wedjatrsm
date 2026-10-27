'use client'

// R65 Deductions control center — the lateness rules (the manager, or a
// 'deductions'-permission holder, decides them) plus manual salary
// deductions per staff member, connected to the attendance days/hours
// of the selected payroll month. The rules are saved via
// PUT /api/deductions/rules and applied LIVE by every payroll and
// deductions report; manual rows are POST /api/deductions and
// DELETE /api/deductions/[id] (both audited).

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarDays,
  Clock,
  Plus,
  Scale,
  Trash2,
  TriangleAlert,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { DeductionsReport, DeductionsUserLine, SalaryDeductionRow } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Period = 'this' | 'last'

function monthString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  waiter:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  kitchen:
    'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
  custom:
    'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
}

const ROLE_AVATAR_CLASS: Record<string, string> = {
  admin: 'bg-primary/15 text-primary',
  waiter: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
  kitchen: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400',
  custom: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400',
}

function roleLabelKey(role: string): string {
  return role === 'admin' || role === 'waiter' || role === 'kitchen' || role === 'custom'
    ? `role.${role}`
    : 'role.custom'
}

type RulesForm = {
  enabled: boolean
  perMinute: string
  perOccurrence: string
  cap: string
}

// ─── View ───────────────────────────────────────────────────────────

export default function DeductionsView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [period, setPeriod] = useState<Period>('this')
  const month = useMemo(() => {
    const now = new Date()
    // 'last' = previous calendar month relative to the client clock
    return monthString(new Date(now.getFullYear(), now.getMonth() + (period === 'last' ? -1 : 0), 1))
  }, [period])

  const reportQuery = useQuery({
    queryKey: ['deductions-report', month],
    queryFn: () => fetcher<DeductionsReport>(`/api/deductions?month=${month}`),
  })

  const report = reportQuery.data
  const lines = report?.lines ?? []
  const loading = reportQuery.isLoading

  // ── lateness rules form (derived from the report's rules until the
  // manager edits it — no effect needed, the draft sticks once touched) ─
  const [rulesDraft, setRulesDraft] = useState<RulesForm | null>(null)
  const reportRules = report?.rules
  const rulesForm: RulesForm | null =
    rulesDraft ??
    (reportRules === undefined
      ? null
      : {
          enabled: reportRules.enabled,
          perMinute: String(reportRules.perMinuteEgp),
          perOccurrence: String(reportRules.perOccurrenceEgp),
          cap: String(reportRules.capEgp),
        })

  const saveRules = useMutation({
    mutationFn: (body: {
      enabled: boolean
      perMinuteEgp: number
      perOccurrenceEgp: number
      capEgp: number
    }) =>
      apiFetch<{ rules: DeductionsReport['rules'] }>('/api/deductions/rules', {
        method: 'PUT',
        body,
      }),
    onSuccess: (data) => {
      toast.success(t('r65.deductions.rulesSaved'))
      // the server clamps values to its bounds — sync the form to what
      // was actually persisted
      setRulesDraft({
        enabled: data.rules.enabled,
        perMinute: String(data.rules.perMinuteEgp),
        perOccurrence: String(data.rules.perOccurrenceEgp),
        cap: String(data.rules.capEgp),
      })
      void queryClient.invalidateQueries({ queryKey: ['deductions-report'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function submitRules() {
    if (rulesForm === null) return
    // invalid/negative entries clamp to 0 (the API clamps to its own bounds)
    const clamp = (v: string): number => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }
    saveRules.mutate({
      enabled: rulesForm.enabled,
      perMinuteEgp: clamp(rulesForm.perMinute),
      perOccurrenceEgp: clamp(rulesForm.perOccurrence),
      capEgp: clamp(rulesForm.cap),
    })
  }

  // ── add-deduction dialog (per staff member) ───────────────────────
  const [addFor, setAddFor] = useState<number | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const addLine = addFor === null ? null : (lines.find((l) => l.userId === addFor) ?? null)

  function openAdd(line: DeductionsUserLine) {
    setAmount('')
    setReason('')
    setAddFor(line.userId)
  }

  const addDeduction = useMutation({
    mutationFn: (body: { userId: number; amount: number; reason: string; month: string }) =>
      apiFetch<{ deduction: SalaryDeductionRow }>('/api/deductions', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      toast.success(t('r65.deductions.created'))
      setAddFor(null)
      void queryClient.invalidateQueries({ queryKey: ['deductions-report'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function confirmAdd() {
    if (addFor === null) return
    const parsed = Number(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) {
      toast.error(t('r65.deductions.needAmount'))
      return
    }
    if (reason.trim() === '') {
      toast.error(t('r65.deductions.needReason'))
      return
    }
    addDeduction.mutate({ userId: addFor, amount: parsed, reason: reason.trim(), month })
  }

  // ── remove-deduction confirm (audited) ────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<SalaryDeductionRow | null>(null)

  const deleteDeduction = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ ok: boolean; id: number }>(`/api/deductions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success(t('r65.deductions.deleted'))
      setDeleteTarget(null)
      void queryClient.invalidateQueries({ queryKey: ['deductions-report'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const periods: { key: Period; label: string }[] = [
    { key: 'this', label: t('r17.payroll.thisMonth') },
    { key: 'last', label: t('r17.payroll.lastMonth') },
  ]

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header — Odoo control-panel style */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('nav.deductions')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('r65.deductions.title')}</h1>
        </div>
      </div>

      {/* Header card: subtitle + period control */}
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">{t('r65.deductions.subtitle')}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {report ? (
                <>
                  {t('r17.common.from')} {report.from} {t('r17.common.to')} {report.to}
                </>
              ) : (
                <span className="invisible">—</span>
              )}
            </p>
          </div>
          <div className="flex gap-2" role="group" aria-label={t('r17.payroll.period')}>
            {periods.map((p) => (
              <Button
                key={p.key}
                variant={period === p.key ? 'default' : 'outline'}
                size="sm"
                className="h-11"
                aria-pressed={period === p.key}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {reportQuery.isError ? (
        <Card className="p-4">
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('r17.common.error')}</p>
              <p className="text-muted-foreground text-sm">
                {reportQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void reportQuery.refetch()}
            >
              {t('r17.common.retry')}
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {/* Lateness rules card */}
          <Card className="gap-3 p-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <Scale className="size-4.5" aria-hidden />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold leading-none">
                    {t('r65.deductions.rulesTitle')}
                  </h2>
                  {report !== undefined && !report.rules.enabled ? (
                    <Badge
                      variant="outline"
                      className="border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400"
                    >
                      {t('r65.deductions.rulesOff')}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
            {rulesForm === null ? (
              <div className="flex flex-wrap items-end gap-4">
                <Skeleton className="h-6 w-44" />
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-11 w-20" />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-4">
                  <div className="flex items-center gap-2 pb-1.5">
                    <Switch
                      id="lateness-rules-enabled"
                      checked={rulesForm.enabled}
                      onCheckedChange={(enabled) => setRulesDraft({ ...rulesForm, enabled })}
                    />
                    <Label htmlFor="lateness-rules-enabled" className="text-sm">
                      {t('r65.deductions.rulesEnabled')}
                    </Label>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lateness-per-minute" className="text-xs text-muted-foreground">
                      {t('r65.deductions.rulesPerMinute')}
                    </Label>
                    <Input
                      id="lateness-per-minute"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.5}
                      className="w-28"
                      value={rulesForm.perMinute}
                      onChange={(e) =>
                        setRulesDraft({ ...rulesForm, perMinute: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label
                      htmlFor="lateness-per-occurrence"
                      className="text-xs text-muted-foreground"
                    >
                      {t('r65.deductions.rulesPerOccurrence')}
                    </Label>
                    <Input
                      id="lateness-per-occurrence"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.5}
                      className="w-28"
                      value={rulesForm.perOccurrence}
                      onChange={(e) =>
                        setRulesDraft({ ...rulesForm, perOccurrence: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="lateness-cap" className="text-xs text-muted-foreground">
                      {t('r65.deductions.rulesCap')}
                    </Label>
                    <Input
                      id="lateness-cap"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.5}
                      className="w-28"
                      value={rulesForm.cap}
                      onChange={(e) => setRulesDraft({ ...rulesForm, cap: e.target.value })}
                    />
                  </div>
                  <Button
                    className="h-11"
                    disabled={saveRules.isPending}
                    onClick={submitRules}
                  >
                    {saveRules.isPending ? t('r17.common.loading') : t('r17.common.save')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('r65.deductions.rulesGraceNote')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('r65.deductions.rulesComputeNote')}
                </p>
              </>
            )}
          </Card>

          {/* Staff deductions table */}
          <Card className="p-4">
            <h2 className="mb-3 font-semibold">{t('r65.deductions.tableTitle', { month })}</h2>
            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                    <Skeleton className="size-9 rounded-full" />
                    <Skeleton className="h-4 w-36" />
                    <Skeleton className="ms-auto h-4 w-16" />
                    <Skeleton className="h-4 w-14" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            ) : lines.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <CalendarDays className="size-10 text-muted-foreground/50" aria-hidden />
                <div>
                  <p className="font-medium">{t('r65.deductions.empty')}</p>
                  <p className="text-muted-foreground text-sm">
                    {t('r65.deductions.emptyHint')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rms-scroll max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-card">
                    <TableRow>
                      <TableHead>{t('r65.deductions.user')}</TableHead>
                      <TableHead className="hidden md:table-cell">
                        {t('r65.deductions.days')}
                      </TableHead>
                      <TableHead className="hidden text-right md:table-cell">
                        {t('r65.deductions.hours')}
                      </TableHead>
                      <TableHead className="text-right">{t('r65.deductions.late')}</TableHead>
                      <TableHead className="text-right">
                        {t('r65.deductions.latenessDeduction')}
                      </TableHead>
                      <TableHead className="text-right">
                        {t('r65.deductions.manualDeductions')}
                      </TableHead>
                      <TableHead className="text-right">{t('r65.deductions.total')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.userId} className="h-16">
                        {/* team member */}
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-9">
                              <AvatarFallback
                                className={cn(
                                  'text-xs font-semibold',
                                  ROLE_AVATAR_CLASS[line.role] ?? ROLE_AVATAR_CLASS.custom,
                                )}
                              >
                                {initials(line.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{line.name}</div>
                              <Badge
                                variant="outline"
                                className={cn(
                                  'mt-0.5 px-1.5 text-[10px]',
                                  ROLE_BADGE_CLASS[line.role] ?? ROLE_BADGE_CLASS.custom,
                                )}
                              >
                                {t(roleLabelKey(line.role))}
                              </Badge>
                            </div>
                          </div>
                        </TableCell>
                        {/* days with a check-in */}
                        <TableCell className="hidden tabular-nums md:table-cell">
                          {line.days}
                        </TableCell>
                        {/* worked hours */}
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {line.hours.toFixed(2)}
                        </TableCell>
                        {/* late minutes + occurrences */}
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            line.lateMinutes > 0
                              ? 'font-medium text-amber-700 dark:text-amber-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {line.lateMinutes > 0 ? (
                              <Clock className="size-3" aria-hidden />
                            ) : null}
                            {line.lateMinutes}
                          </span>
                          {line.lateCount > 0 ? (
                            <div className="text-[10px] font-normal text-muted-foreground">
                              {line.lateCount}×
                            </div>
                          ) : null}
                        </TableCell>
                        {/* lateness deduction (computed from the rules) */}
                        <TableCell
                          className={cn(
                            'text-right tabular-nums',
                            line.latenessDeduction > 0
                              ? 'text-rose-700 dark:text-rose-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          {formatCurrency(line.latenessDeduction)}
                        </TableCell>
                        {/* manual deductions — total + rows with remove */}
                        <TableCell className="text-right">
                          <div
                            className={cn(
                              'tabular-nums',
                              line.manualDeductionTotal > 0
                                ? 'text-rose-700 dark:text-rose-400'
                                : 'text-muted-foreground',
                            )}
                          >
                            {formatCurrency(line.manualDeductionTotal)}
                          </div>
                          {line.manualDeductions.length > 0 ? (
                            <div className="mt-1 space-y-1">
                              {line.manualDeductions.map((d) => (
                                <div
                                  key={d.id}
                                  className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground"
                                >
                                  <span
                                    className="min-w-0 truncate"
                                    title={d.reason ?? undefined}
                                  >
                                    {formatCurrency(d.amount)}
                                    {d.reason ? ` — ${d.reason}` : ''}
                                  </span>
                                  {d.createdByName ? (
                                    <span className="shrink-0">
                                      (
                                      {t('r65.deductions.recordedBy', {
                                        name: d.createdByName,
                                      })}
                                      )
                                    </span>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                                    aria-label={t('r65.deductions.deleteConfirm')}
                                    title={t('r65.deductions.deleteConfirm')}
                                    onClick={() => setDeleteTarget(d)}
                                  >
                                    <Trash2 className="size-3" aria-hidden />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </TableCell>
                        {/* total + add deduction */}
                        <TableCell className="text-right">
                          <div
                            className={cn(
                              'font-semibold tabular-nums',
                              line.totalDeductions > 0
                                ? 'text-rose-700 dark:text-rose-400'
                                : 'text-muted-foreground',
                            )}
                          >
                            {formatCurrency(line.totalDeductions)}
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="mt-1 h-8 gap-1 px-2 text-xs text-muted-foreground hover:text-primary"
                            aria-label={t('r65.deductions.addDeduction')}
                            onClick={() => openAdd(line)}
                          >
                            <Plus className="size-3.5" aria-hidden />
                            <span className="hidden sm:inline">
                              {t('r65.deductions.addDeduction')}
                            </span>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter className="sticky bottom-0 bg-card">
                    <TableRow>
                      <TableCell className="font-medium">
                        {t('r65.deductions.totalsRow')}
                      </TableCell>
                      <TableCell className="hidden md:table-cell" />
                      <TableCell className="hidden md:table-cell" />
                      <TableCell />
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(report?.totalLateness ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(report?.totalManual ?? 0)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(report?.totalDeductions ?? 0)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              </div>
            )}
          </Card>
        </>
      )}

      {/* Add deduction dialog */}
      <Dialog
        open={addFor !== null}
        onOpenChange={(open) => {
          if (!open) setAddFor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('r65.deductions.addTitle', { name: addLine?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {t('r65.deductions.addDesc', { month })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="deduction-amount">{t('r65.deductions.amount')}</Label>
              <Input
                id="deduction-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmAdd()
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deduction-reason">{t('r65.deductions.reason')}</Label>
              <Input
                id="deduction-reason"
                maxLength={200}
                value={reason}
                placeholder={t('r65.deductions.reasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmAdd()
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="h-11" onClick={() => setAddFor(null)}>
              {t('r17.common.cancel')}
            </Button>
            <Button className="h-11" disabled={addDeduction.isPending} onClick={confirmAdd}>
              {addDeduction.isPending ? t('r17.common.loading') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove deduction confirm (audited) */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('r65.deductions.deleteConfirm')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget !== null
                ? `${formatCurrency(deleteTarget.amount)}${deleteTarget.reason ? ` — ${deleteTarget.reason}` : ''} · ${t('r65.deductions.deleteDesc', { month })}`
                : t('r65.deductions.deleteDesc', { month })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">{t('r17.common.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              className="h-11"
              disabled={deleteDeduction.isPending}
              onClick={() => {
                if (deleteTarget !== null) deleteDeduction.mutate(deleteTarget.id)
              }}
            >
              {deleteDeduction.isPending ? t('r17.common.loading') : t('common.remove')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
