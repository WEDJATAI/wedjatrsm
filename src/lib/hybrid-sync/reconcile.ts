/**
 * R30 hybrid sync — reconciliation (local vs cloud entity counts).
 *
 * A lightweight drift detector: per hybrid entity, compare the local row
 * count with the cloud's (via POST /api/hybrid/reconcile { probe:true } —
 * the cloud answers with ITS stats for the same registry). Counts are not
 * diffs of content — they surface "this table has rows the other side has
 * never seen", which after an outage or a fresh device is the first thing
 * an admin needs to know. Content-level disagreements are the job of the
 * conflict log (HybridConflict).
 */
import { db } from '@/lib/db'
import { HYBRID_ENTITIES } from './entity-policy'
import { hybridModelFor } from './dmmf'
import { hybridFetch } from './cloud-client'
import { readHybridTargetUrl } from './push'
import { getLocalDevice } from './device-identity'
import { HYBRID_PULL_TIMEOUT_MS, STATE_LAST_RECONCILE_AT, STATE_LOCAL_DEVICE_KEY } from './constants'
import { getState, setState } from './sync-state'

export type EntityStats = {
  entity: string
  count: number
  maxId: number | null
  latestAt: string | null
}

type LooseStatsDelegate = {
  count: () => Promise<number>
  aggregate: (args: Record<string, unknown>) => Promise<{ _max?: Record<string, unknown> }>
}

/** Local per-entity stats over the whole hybrid registry. */
export async function localEntityStats(): Promise<EntityStats[]> {
  const delegates = db as unknown as Record<string, LooseStatsDelegate | undefined>
  const out: EntityStats[] = []
  for (const entity of Object.keys(HYBRID_ENTITIES)) {
    const model = hybridModelFor(entity)
    const delegate = model ? delegates[model.accessor] : undefined
    if (!model || !delegate) continue
    const idField = model.fields.find((f) => f.kind === 'scalar' && f.name === 'id')
    const maxSelect: Record<string, true> = {}
    if (idField) maxSelect.id = true
    if (model.fields.some((f) => f.name === 'createdAt')) maxSelect.createdAt = true
    if (model.hasUpdatedAt) maxSelect.updatedAt = true
    const [count, agg] = await Promise.all([
      delegate.count(),
      delegate.aggregate({ _max: maxSelect }),
    ])
    const createdAtMax = agg._max?.createdAt
    const updatedAtMax = agg._max?.updatedAt
    const latestMs = Math.max(
      Number.isFinite(Date.parse(String(createdAtMax))) ? Date.parse(String(createdAtMax)) : 0,
      Number.isFinite(Date.parse(String(updatedAtMax))) ? Date.parse(String(updatedAtMax)) : 0,
    )
    out.push({
      entity,
      count,
      maxId: typeof agg._max?.id === 'number' ? (agg._max.id as number) : null,
      latestAt: latestMs > 0 ? new Date(latestMs).toISOString() : null,
    })
  }
  return out
}

export type ReconcileEntityReport = {
  entity: string
  localCount: number
  cloudCount: number | null
  /** cloudCount − localCount (null when the cloud was unreachable) */
  drift: number | null
}

export type ReconciliationReport = {
  cloudReachable: boolean
  entities: ReconcileEntityReport[]
  conflictsTotal: number
  reconciledAt: string
}

/**
 * Run one reconciliation. When the cloud is reachable, its stats are fetched
 * and compared; otherwise a local-only report is produced (cloudReachable
 * false, cloudCount null) so the admin UI still shows what we know.
 */
export async function runReconciliation(): Promise<ReconciliationReport> {
  const local = await localEntityStats()
  const localByEntity = new Map(local.map((s) => [s.entity, s]))

  const entities: ReconcileEntityReport[] = local.map((s) => ({
    entity: s.entity,
    localCount: s.count,
    cloudCount: null,
    drift: null,
  }))

  let cloudReachable = false
  const target = await readHybridTargetUrl()
  if (target) {
    const device = await getLocalDevice()
    const deviceKey = await getState(STATE_LOCAL_DEVICE_KEY)
    if (device && deviceKey) {
      const res = await hybridFetch(target, '/api/hybrid/reconcile', {
        method: 'POST',
        deviceId: device.deviceId,
        deviceKey,
        timeoutMs: HYBRID_PULL_TIMEOUT_MS,
        body: { probe: true },
      })
      if (res.ok && res.status === 200) {
        const body = (res.json ?? {}) as { stats?: Array<{ entity: string; count: number }> }
        const cloudByEntity = new Map(
          (body.stats ?? []).map((s) => [String(s.entity), Number(s.count)]),
        )
        cloudReachable = true
        for (const report of entities) {
          const cloudCount = cloudByEntity.get(report.entity)
          if (cloudCount !== undefined && Number.isFinite(cloudCount)) {
            report.cloudCount = cloudCount
            report.drift = cloudCount - report.localCount
          }
        }
      }
    }
  }

  const conflictsTotal = await db.hybridConflict.count()
  const reconciledAt = new Date().toISOString()
  await setState(STATE_LAST_RECONCILE_AT, reconciledAt)

  return { cloudReachable, entities, conflictsTotal, reconciledAt }
}
