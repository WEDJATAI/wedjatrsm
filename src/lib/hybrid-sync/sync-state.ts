/**
 * R30 hybrid sync — engine state (HybridSyncState key/value store).
 *
 * Small, entirely-local operational state: pull cursor, cloud reachability,
 * pause flag, local device identity, staged-restore marker. Never replicated
 * (one of the HYBRID_QUEUE_TABLES) and never part of any wire payload.
 */
import { db } from '@/lib/db'
import {
  STATE_PULL_CURSOR,
  STATE_PULL_REMAINING,
  STATE_LAST_PUSH_AT,
  STATE_LAST_PULL_AT,
  STATE_LAST_RECONCILE_AT,
  STATE_CLOUD_REACHABLE,
  STATE_CLOUD_LAST_CHECKED,
  STATE_CLOUD_AUTH_FAILED,
  STATE_RESTORE_PENDING,
  STATE_ENGINE_RUNNING_SINCE,
  STATE_SYNC_PAUSED,
  STATE_LOCAL_DEVICE_ID,
  STATE_LOCAL_DEVICE_KEY,
} from './constants'

export {
  STATE_PULL_CURSOR,
  STATE_PULL_REMAINING,
  STATE_LAST_PUSH_AT,
  STATE_LAST_PULL_AT,
  STATE_LAST_RECONCILE_AT,
  STATE_CLOUD_REACHABLE,
  STATE_CLOUD_LAST_CHECKED,
  STATE_CLOUD_AUTH_FAILED,
  STATE_RESTORE_PENDING,
  STATE_ENGINE_RUNNING_SINCE,
  STATE_SYNC_PAUSED,
  STATE_LOCAL_DEVICE_ID,
  STATE_LOCAL_DEVICE_KEY,
}

/** Read one state key (null when unset). */
export async function getState(key: string): Promise<string | null> {
  const row = await db.hybridSyncState.findUnique({ where: { key } })
  return row?.value ?? null
}

/** Write one state key (upsert). */
export async function setState(key: string, value: string): Promise<void> {
  await db.hybridSyncState.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  })
}

/** Read several state keys at once (missing keys map to null). */
export async function getMany(keys: string[]): Promise<Record<string, string | null>> {
  if (keys.length === 0) return {}
  const rows = await db.hybridSyncState.findMany({ where: { key: { in: keys } } })
  const out: Record<string, string | null> = {}
  for (const key of keys) out[key] = null
  for (const row of rows) out[row.key] = row.value
  return out
}

/** Remove a state key (used when clearing flags like cloud.authFailed). */
export async function clearState(key: string): Promise<void> {
  await db.hybridSyncState.deleteMany({ where: { key } })
}
