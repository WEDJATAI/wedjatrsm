/**
 * r34: tombstone markers for user archive-deletion.
 *
 * Deleting a user who has operational history (orders served, attendance,
 * cash drawer sessions, issued checks…) must NEVER destroy financial
 * records — the account is archived instead: login revoked (random
 * password, no PIN, inactive) and the email replaced by a unique
 * tombstone marker that frees the original address for reuse.
 *
 * The marker is parseable so the API can surface a derived `deletedAt`
 * WITHOUT a schema change — it works identically on the local SQLite
 * terminal, the Neon (Vercel) deployment and the Turso mirror, with zero
 * DDL coordination across databases.
 *
 * Marker format: `deleted.<userId>.<epochSeconds>@deleted.rsm`
 */

const DELETED_DOMAIN = '@deleted.rsm'

/** Build the unique tombstone email for an archive-deleted user. */
export function tombstoneEmail(userId: number, at: Date = new Date()): string {
  return `deleted.${userId}.${Math.floor(at.getTime() / 1000)}${DELETED_DOMAIN}`
}

/** True when the email is an archive-deletion tombstone. */
export function isDeletedEmail(email: string): boolean {
  return email.endsWith(DELETED_DOMAIN)
}

/**
 * Parse the deletion timestamp out of a tombstone email.
 * Returns ISO string, or null for regular (live) users.
 */
export function deletedAtFromEmail(email: string): string | null {
  const m = /^deleted\.(\d+)\.(\d+)@deleted\.rsm$/.exec(email)
  if (!m) return null
  const epoch = Number(m[2])
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString() : null
}
