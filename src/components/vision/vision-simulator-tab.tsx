'use client'

// ─── Vision Simulator tab — emulated edge processor + docs ───────────
// Scenarios POST to /api/vision/simulate which feeds events through the
// SAME ingestion pipeline real cameras use (honest end-to-end testing).
// Also documents the edge integration: event JSON schema, endpoint,
// x-vision-key auth, event_id idempotency and the privacy model (no
// video leaves the building, no facial recognition).

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Armchair,
  BookOpen,
  DoorOpen,
  FlaskConical,
  Footprints,
  Loader2,
  MoveRight,
  Play,
  Timer,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type { FloorPlan, RestaurantTable, VisionCameraDTO } from '@/lib/types'

import { VISION_CAMERA_STATUSES } from '@/lib/constants'

type SimResult = { event_id: string; outcome: string; detail: string | null }

type Props = {
  cameras: VisionCameraDTO[]
  floorPlans: FloorPlan[]
}

const EVENT_EXAMPLES = `// OCCUPANCY_CHANGED — guests sat at / left a table zone
{
  "event_id": "evt-2026-000123",        // unique — replays return "duplicate"
  "type": "OCCUPANCY_CHANGED",
  "camera_code": "CAM-001",
  "zone_id": 7,                          // zone mapped to table T3
  "people_count": 4,
  "confidence": 0.93,
  "detected_at": "2026-09-08T14:32:05Z"  // old events are rejected as stale
}

// MOVEMENT_DETECTED — party moved between table zones
{
  "event_id": "evt-2026-000124",
  "type": "MOVEMENT_DETECTED",
  "camera_code": "CAM-001",
  "from_zone_id": 7,
  "to_zone_id": 9,
  "people_count": 3,
  "confidence": 0.88,
  "detected_at": "2026-09-08T15:01:10Z"
}

// CAMERA_STATUS — heartbeat from the edge box
{
  "event_id": "evt-2026-000125",
  "type": "CAMERA_STATUS",
  "camera_code": "CAM-002",
  "status": "online",
  "detected_at": "2026-09-08T15:02:00Z"
}`

export default function VisionSimulatorTab({ cameras, floorPlans }: Props) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const tables = useMemo<RestaurantTable[]>(
    () => floorPlans.flatMap((fp) => fp.tables.filter((tb) => tb.active)),
    [floorPlans],
  )

  const [seatTable, setSeatTable] = useState('')
  const [seatPeople, setSeatPeople] = useState('2')
  const [vacateTable, setVacateTable] = useState('')
  const [walkbyTable, setWalkbyTable] = useState('')
  const [moveFrom, setMoveFrom] = useState('')
  const [moveTo, setMoveTo] = useState('')
  const [movePeople, setMovePeople] = useState('3')
  const [statusCamera, setStatusCamera] = useState('')
  const [statusValue, setStatusValue] = useState('online')
  const [statusError, setStatusError] = useState('')
  const [staleTable, setStaleTable] = useState('')
  const [lastResults, setLastResults] = useState<SimResult[] | null>(null)

  const simMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch<{ results: SimResult[] }>('/api/vision/simulate', { body }),
    onSuccess: async (data, vars) => {
      setLastResults(data.results)
      const first = data.results[0]
      if (first) toast.info(t(`vision.outcome.${first.outcome}`))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-cameras'] }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const people = (raw: string, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 1 ? Math.min(30, Math.floor(n)) : fallback
  }

  const run = (body: Record<string, unknown>) => simMutation.mutate(body)

  const runSeat = () => {
    if (seatTable === '') return toast.error(t('vision.sim.needTable'))
    run({ scenario: 'seat', tableId: Number(seatTable), people: people(seatPeople, 2) })
  }
  const runVacate = () => {
    if (vacateTable === '') return toast.error(t('vision.sim.needTable'))
    run({ scenario: 'vacate', tableId: Number(vacateTable) })
  }
  const runWalkby = () => {
    if (walkbyTable === '') return toast.error(t('vision.sim.needTable'))
    run({ scenario: 'walkby', tableId: Number(walkbyTable) })
  }
  const runMove = () => {
    if (moveFrom === '' || moveTo === '') return toast.error(t('vision.sim.needTable'))
    if (moveFrom === moveTo) return toast.error(t('vision.sim.needTwoTables'))
    run({
      scenario: 'move',
      fromTableId: Number(moveFrom),
      toTableId: Number(moveTo),
      people: people(movePeople, 3),
    })
  }
  const runCameraStatus = () => {
    if (statusCamera === '') return toast.error(t('vision.sim.needCamera'))
    run({
      scenario: 'camera_status',
      cameraId: Number(statusCamera),
      status: statusValue,
      ...(statusError.trim() !== '' ? { error: statusError.trim() } : {}),
    })
  }
  const runStale = () => {
    if (staleTable === '') return toast.error(t('vision.sim.needTable'))
    run({ scenario: 'stale', tableId: Number(staleTable) })
  }

  const tableOptions = (value: string, onChange: (v: string) => void, id: string, label: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {tables.map((tb) => (
            <SelectItem key={tb.id} value={String(tb.id)}>
              {tb.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <section className="space-y-4">
      {/* ── intro ── */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700">
            <FlaskConical className="size-5" aria-hidden />
          </div>
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-amber-900">{t('vision.sim.subtitle')}</p>
            <p className="text-sm leading-relaxed text-amber-800/90">{t('vision.sim.intro')}</p>
          </div>
        </CardContent>
      </Card>

      {/* ── scenario cards ── */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* Seat */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Armchair className="size-4" aria-hidden />
              {t('vision.sim.seat')}
            </CardTitle>
            <CardDescription>{t('vision.sim.seatDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tableOptions(seatTable, setSeatTable, 'sim-seat-table', t('vision.sim.table'))}
            <div className="space-y-1.5">
              <Label htmlFor="sim-seat-people" className="text-xs">
                {t('vision.sim.people')}
              </Label>
              <Input
                id="sim-seat-people"
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                className="h-11"
                value={seatPeople}
                onChange={(e) => setSeatPeople(e.target.value)}
              />
            </div>
            <Button
              className="h-11 w-full gap-1.5"
              disabled={simMutation.isPending || tables.length === 0}
              onClick={runSeat}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>

        {/* Vacate */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <DoorOpen className="size-4" aria-hidden />
              {t('vision.sim.vacate')}
            </CardTitle>
            <CardDescription>{t('vision.sim.vacateDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tableOptions(vacateTable, setVacateTable, 'sim-vacate-table', t('vision.sim.table'))}
            <Button
              className="h-11 w-full gap-1.5"
              disabled={simMutation.isPending || tables.length === 0}
              onClick={runVacate}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>

        {/* Walk-by */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Footprints className="size-4" aria-hidden />
              {t('vision.sim.walkby')}
            </CardTitle>
            <CardDescription>{t('vision.sim.walkbyDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tableOptions(walkbyTable, setWalkbyTable, 'sim-walkby-table', t('vision.sim.table'))}
            <Button
              variant="outline"
              className="h-11 w-full gap-1.5"
              disabled={simMutation.isPending || tables.length === 0}
              onClick={runWalkby}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>

        {/* Move party */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <MoveRight className="size-4" aria-hidden />
              {t('vision.sim.move')}
            </CardTitle>
            <CardDescription>{t('vision.sim.moveDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tableOptions(moveFrom, setMoveFrom, 'sim-move-from', t('vision.sim.fromTable'))}
            {tableOptions(moveTo, setMoveTo, 'sim-move-to', t('vision.sim.toTable'))}
            <div className="space-y-1.5">
              <Label htmlFor="sim-move-people" className="text-xs">
                {t('vision.sim.people')}
              </Label>
              <Input
                id="sim-move-people"
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                className="h-11"
                value={movePeople}
                onChange={(e) => setMovePeople(e.target.value)}
              />
            </div>
            <Button
              className="h-11 w-full gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={simMutation.isPending || tables.length < 2}
              onClick={runMove}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>

        {/* Camera status */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4" aria-hidden />
              {t('vision.sim.cameraStatus')}
            </CardTitle>
            <CardDescription>{t('vision.sim.cameraStatusDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="sim-status-camera" className="text-xs">
                {t('vision.sim.camera')}
              </Label>
              <Select value={statusCamera} onValueChange={setStatusCamera}>
                <SelectTrigger id="sim-status-camera" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {cameras.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      <span className="font-mono text-xs uppercase">{c.code}</span> · {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-status-value" className="text-xs">
                {t('vision.sim.status')}
              </Label>
              <Select value={statusValue} onValueChange={setStatusValue}>
                <SelectTrigger id="sim-status-value" className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VISION_CAMERA_STATUSES.filter((s) => s !== 'disabled').map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(`vision.cameras.status.${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-status-error" className="text-xs">
                {t('vision.sim.errorMessage')}
              </Label>
              <Input
                id="sim-status-error"
                className="h-11"
                value={statusError}
                onChange={(e) => setStatusError(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              className="h-11 w-full gap-1.5"
              disabled={simMutation.isPending || cameras.length === 0}
              onClick={runCameraStatus}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>

        {/* Stale event */}
        <Card>
          <CardHeader className="space-y-0 pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Timer className="size-4" aria-hidden />
              {t('vision.sim.stale')}
            </CardTitle>
            <CardDescription>{t('vision.sim.staleDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tableOptions(staleTable, setStaleTable, 'sim-stale-table', t('vision.sim.table'))}
            <Button
              variant="outline"
              className="h-11 w-full gap-1.5"
              disabled={simMutation.isPending || tables.length === 0}
              onClick={runStale}
            >
              <Play className="size-4" aria-hidden />
              {t('vision.sim.run')}
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* ── last run results (mono) ── */}
      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="text-base">{t('vision.sim.results')}</CardTitle>
        </CardHeader>
        <CardContent>
          {simMutation.isPending ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t('vision.sim.running')}
            </p>
          ) : lastResults == null || lastResults.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('vision.sim.noResults')}</p>
          ) : (
            <pre className="rms-scroll max-h-40 overflow-auto rounded-lg border bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-700">
              {lastResults
                .map(
                  (r) =>
                    `${r.event_id} → ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`,
                )
                .join('\n')}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* ── edge integration docs ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" aria-hidden />
            {t('vision.docs.title')}
          </CardTitle>
          <CardDescription>{t('vision.docs.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium text-muted-foreground">{t('vision.edge.endpoint')}:</span>
            <code className="rounded border bg-stone-100 px-2 py-0.5 font-mono text-xs">
              POST /api/vision/events
            </code>
          </div>
          <pre className="rms-scroll max-h-96 overflow-auto rounded-lg border bg-stone-900 p-4 font-mono text-[11px] leading-relaxed text-stone-200">
            {EVENT_EXAMPLES}
          </pre>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden />
              {t('vision.docs.auth')}
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
              {t('vision.docs.idempotency')}
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-rose-500" aria-hidden />
              {t('vision.docs.privacy')}
            </li>
          </ul>
        </CardContent>
      </Card>
    </section>
  )
}
