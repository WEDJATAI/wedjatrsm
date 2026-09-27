/**
 * R30: local-first hybrid sync engine — shared design constants.
 *
 * The engine runs INSIDE the local (SQLite) instance and exchanges
 * `rsm-hybrid/1` events with a cloud instance:
 *  - PUSH: durable outbox (HybridEvent direction 'out') → POST /api/hybrid/push
 *  - PULL: GET /api/hybrid/pull → applied locally via per-entity policy
 *
 * The legacy one-way rsm-sync/1 export/import (src/lib/sync.ts, /api/sync/*)
 * is PRESERVED untouched and continues to work independently.
 */

/** Wire format version of hybrid events and bootstrap bundles. */
export const HYBRID_FORMAT = 'rsm-hybrid/1'

/** Outbox events claimed and pushed per cycle. */
export const HYBRID_BATCH_SIZE = 50

/** Events requested per pull call. */
export const HYBRID_PULL_LIMIT = 100

/** Hard cap on events per push request (server rejects beyond this with 429). */
export const HYBRID_PUSH_MAX_EVENTS = 200

/** Hard cap on events per pull response (server clamps the limit query). */
export const HYBRID_PULL_MAX_LIMIT = 200

/** Network timeout for a push request. */
export const HYBRID_PUSH_TIMEOUT_MS = 15_000

/** Network timeout for a pull request. */
export const HYBRID_PULL_TIMEOUT_MS = 15_000

/** Outbox attempts before an event is moved to 'dead' (never retried again). */
export const HYBRID_MAX_ATTEMPTS = 20

/** Pull-side retry budget for received events that failed to apply (FK gaps). */
export const HYBRID_IN_MAX_ATTEMPTS = 10

/** Engine tick interval (push cycle, then pull cycle). */
export const HYBRID_ENGINE_INTERVAL_MS = 30_000

/** Max rows per entity served by the bootstrap provisioning download. */
export const HYBRID_BOOTSTRAP_CAP = 5_000

// ─── canonical HybridSyncState keys (see sync-state.ts) ────────────────

export const STATE_PULL_CURSOR = 'pull.cursor'
export const STATE_PULL_REMAINING = 'pull.remaining'
export const STATE_LAST_PUSH_AT = 'lastPushAt'
export const STATE_LAST_PULL_AT = 'lastPullAt'
export const STATE_LAST_RECONCILE_AT = 'lastReconcileAt'
export const STATE_CLOUD_REACHABLE = 'cloud.reachable' // 'yes' | 'no' | 'unknown'
export const STATE_CLOUD_LAST_CHECKED = 'cloud.lastCheckedAt'
export const STATE_CLOUD_AUTH_FAILED = 'cloud.authFailed'
export const STATE_RESTORE_PENDING = 'restore.pending'
export const STATE_ENGINE_RUNNING_SINCE = 'engine.runningSince'
export const STATE_SYNC_PAUSED = 'sync.paused'
export const STATE_LOCAL_DEVICE_ID = 'local.deviceId'
export const STATE_LOCAL_DEVICE_KEY = 'local.deviceKey'
