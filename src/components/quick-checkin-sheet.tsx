'use client'

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlarmClock, Clock, Loader2, LogIn, LogOut, Timer } from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatTime, workedDuration } from '@/lib/format'
import type { AttendanceRecord, SessionUser } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'

// ─── R11: quick shift clock sheet (opened from the navbar chip) ──────
// 1 tap (chip) + 1 tap (confirm) = check-in / check-out from ANY screen.
// Posts an EMPTY body {} so the attendance routes run in session mode.

type AttendanceMe = {
  today: AttendanceRecord | null
  onShift: boolean
  workedMinutes: number | null
}

type AttendanceUserDto = {
  id: number
  name: string
  role: string
  roleLabel: string
  roleName: string | null
}

type ShiftDto = { id: number; name: string; startTime: string; endTime: string } | null

type CheckInResponse = {
  user: AttendanceUserDto
  attendance: AttendanceRecord
  late: boolean
  lateMinutes: number
  shift: ShiftDto
}

type CheckOutResponse = {
  user: AttendanceUserDto
  attendance: AttendanceRecord
  workedMinutes: number
  shift: ShiftDto
}

/* light-theme role chip tints (same palette as the admin views) */
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  waiter:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  kitchen:
    'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
  custom:
    'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function QuickCheckinSheet({
  user,
  open,
  onOpenChange,
}: {
  user: SessionUser
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [sheetError, setSheetError] = useState<string | null>(null)

  // live clock (HH:MM:SS) — one 1s interval, cleaned up on unmount
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const meQuery = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () => fetcher<AttendanceMe>('/api/attendance/me'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    enabled: open,
  })

  const record = meQuery.data?.today ?? null
  const onShift = meQuery.data?.onShift ?? false

  const checkMutation = useMutation({
    mutationFn: async (): Promise<CheckInResponse | CheckOutResponse> =>
      onShift
        ? apiFetch<CheckOutResponse>('/api/attendance/check-out', { body: {} })
        : apiFetch<CheckInResponse>('/api/attendance/check-in', { body: {} }),
    onSuccess: (res) => {
      // refresh the navbar chip + this sheet + the admin attendance lists
      void queryClient.invalidateQueries({ queryKey: ['attendance'] })
      if (onShift) {
        toast.success(t('nav.checkOutToast', { n: (res as CheckOutResponse).workedMinutes }))
      } else {
        toast.success(
          t('nav.checkInToast', {
            time: formatTime((res as CheckInResponse).attendance.checkInAt),
          }),
        )
      }
      setSheetError(null)
      onOpenChange(false)
    },
    onError: (err: Error) => {
      // keep the sheet open + surface the server message inline (e.g. the
      // duplicate-guard "Already checked in at HH:MM")
      setSheetError(err.message)
      toast.error(onShift ? t('nav.checkOutFailed') : t('nav.checkInFailed'))
    },
  })

  function handleOpenChange(next: boolean) {
    if (!next) {
      checkMutation.reset()
      setSheetError(null)
    }
    onOpenChange(next)
  }

  const roleLabel =
    user.role === 'custom' ? (user.roleName ?? t('role.custom')) : t(`role.${user.role}`)

  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('nav.shiftClock')}</DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span className="truncate font-medium text-foreground">{user.name}</span>
            <Badge
              variant="outline"
              className={cn('shrink-0', ROLE_BADGE_CLASS[user.role] ?? ROLE_BADGE_CLASS.custom)}
            >
              {roleLabel}
            </Badge>
          </DialogDescription>
        </DialogHeader>

        {/* live clock */}
        <div className="rounded-lg border bg-muted/50 py-3 text-center">
          <p className="font-mono text-3xl font-bold tabular-nums tracking-widest" aria-live="off">
            {clock}
          </p>
        </div>

        {/* status block */}
        {meQuery.isPending ? (
          <div className="grid gap-2 rounded-lg border p-3">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-6 w-24 rounded-full" />
          </div>
        ) : onShift && record ? (
          <div className="grid gap-2 rounded-lg border p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-muted-foreground">
                <LogIn className="size-4 shrink-0" aria-hidden />
                {t('attendance.checkIn')}
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {formatTime(record.checkInAt)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-muted-foreground">
                <Timer className="size-4 shrink-0" aria-hidden />
                {t('nav.workedToday')}
              </span>
              <span className="font-semibold tabular-nums">
                {workedDuration(record.checkInAt, now)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-muted-foreground">
                <AlarmClock className="size-4 shrink-0" aria-hidden />
                {t('common.status')}
              </span>
              {record.lateMinutes > 0 ? (
                <Badge
                  variant="outline"
                  className="border-rose-600/40 bg-rose-50 font-semibold text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400"
                >
                  {t('nav.lateBy', { n: record.lateMinutes })}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-emerald-600/30 bg-emerald-50 font-semibold text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                >
                  {t('nav.onTime')}
                </Badge>
              )}
            </div>
            {record.shiftName ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="size-4 shrink-0" aria-hidden />
                  {t('attendance.shift')}
                </span>
                <span className="font-medium">{record.shiftName}</span>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-3 text-center text-sm text-muted-foreground">
            {onShift ? t('nav.onShift') : t('nav.notOnShift')}
          </div>
        )}

        {sheetError ? (
          <p className="text-destructive text-sm" role="alert">
            {sheetError}
          </p>
        ) : null}

        {/* primary action — check in (emerald) / check out (rose) */}
        <Button
          type="button"
          onClick={() => checkMutation.mutate()}
          disabled={checkMutation.isPending}
          className={cn(
            'h-12 w-full text-base font-bold',
            onShift
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'bg-emerald-600 text-white hover:bg-emerald-700',
          )}
        >
          {checkMutation.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : onShift ? (
            <LogOut aria-hidden />
          ) : (
            <LogIn aria-hidden />
          )}
          {onShift ? t('nav.confirmCheckOut') : t('nav.confirmCheckIn')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export default QuickCheckinSheet
