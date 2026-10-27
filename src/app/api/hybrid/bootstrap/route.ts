// /api/hybrid/bootstrap — R30 new-device provisioning download.
//
// Device-authenticated. Returns a full snapshot of every hybrid entity (cap
// HYBRID_BOOTSTRAP_CAP rows per table, ordered by id) in `rsm-hybrid/1`
// bundle form — the dataset a freshly installed terminal pulls once, before
// it starts exchanging events. Raw rows are JSON-safe (dates → ISO strings).
//
// r43: the response also carries `head` — the current last id of THIS
// device's pull stream (the same filter /api/hybrid/pull serves). A freshly
// provisioned full-platform terminal writes the bootstrap rows and then sets
// its pull cursor to `head`, so it receives only events that happened AFTER
// its snapshot (older events are already baked in — replaying them would
// take an hour at 100 events / 30 s and add nothing). `head` is computed
// BEFORE the tables are read: events arriving between the two reads are in
// the tables AND after head, so they stream in later too — the duplicate
// delivery is absorbed by eventId dedupe on apply (never a gap, never a miss).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireDevice } from '@/lib/hybrid-auth'
import { db } from '@/lib/db'
import { HYBRID_ENTITIES } from '@/lib/hybrid-sync/entity-policy'
import { hybridModelFor } from '@/lib/hybrid-sync/dmmf'
import { snapshotRow } from '@/lib/hybrid-sync/outbox'
import { HYBRID_BOOTSTRAP_CAP, HYBRID_FORMAT } from '@/lib/hybrid-sync/constants'

export async function GET(req: NextRequest) {
  try {
    const device = await requireDevice(req)
    if (!device) {
      return NextResponse.json({ error: 'Unauthorized: valid device credentials required' }, { status: 401 })
    }

    const delegates = db as unknown as Record<
      string,
      { findMany: (args: { orderBy: { id: 'asc' }; take: number }) => Promise<Array<Record<string, unknown>>> }
    >

    // r43: head first (see module header) — the pull-stream position that
    // matches exactly the data below. Mirrors the pull route's stream filter.
    const isCloudDataPlane = !process.env.DATABASE_URL?.startsWith('file:')
    const streamWhere = {
      deviceId: { not: device.deviceId },
      ...(isCloudDataPlane
        ? { OR: [{ direction: 'in', status: 'applied' }, { direction: 'out', deviceId: 'unbound' }] }
        : { direction: 'in', status: 'applied' as const }),
    }
    const headRow = await db.hybridEvent.findFirst({
      where: streamWhere,
      orderBy: { id: 'desc' },
      select: { id: true },
    })
    const head = headRow?.id ?? 0

    const tables: Record<string, Array<Record<string, unknown>>> = {}
    for (const entity of Object.keys(HYBRID_ENTITIES)) {
      const model = hybridModelFor(entity)
      const delegate = model ? delegates[model.accessor] : undefined
      if (!model || !delegate) continue
      const rows = await delegate.findMany({ orderBy: { id: 'asc' }, take: HYBRID_BOOTSTRAP_CAP })
      tables[entity] = rows.map((row) => snapshotRow(row))
    }

    // ── r63: revision-floor skeleton + sequence alignment ──────────────
    // A freshly provisioned terminal starts with EMPTY hybrid_events, so
    // its nextRevision() returns 1 for rows that already carry revision
    // history HERE — the hub's revision floor then conflict-rejects the
    // fresh terminal's first local edit of any existing row (found live in
    // the r63 DESKTOP-N6S2K0O incident: table-status updates, product
    // toggles and an entire order silently swallowed as 'stale-revision'
    // conflicts). The setup script seeds these watermarks as minimal
    // 'applied' in-event rows so the terminal's revision counters and
    // floors start level with the hub. Sequences: the snapshot rows
    // themselves advance SQLite's sqlite_sequence, but ids allocated HERE
    // after the snapshot generation would collide with the terminal's
    // next local id (the r63 order-#2228 collision) — the script aligns
    // every table's sequence to the hub's current max.
    const floorRows = await db.hybridEvent.groupBy({
      by: ['entity', 'entityId'],
      _max: { revision: true },
    })
    const floors = floorRows
      .map((r) => ({ entity: r.entity, entityId: r.entityId, revision: r._max.revision ?? 1 }))
      .filter((r) => Number.isInteger(r.entityId) && Number.isInteger(r.revision) && r.revision > 0)

    const sequences: Record<string, number> = {}
    for (const entity of Object.keys(HYBRID_ENTITIES)) {
      const model = hybridModelFor(entity)
      const delegate = model ? delegates[model.accessor] : undefined
      if (!model || !delegate) continue
      const agg = (db as unknown as Record<
        string,
        { aggregate: (args: { _max: { id: true } }) => Promise<{ _max: { id: number | null } }> }
      >)[model.accessor]
      if (!agg) continue
      const max = await agg.aggregate({ _max: { id: true } }).catch(() => null)
      if (max?._max?.id) sequences[model.table] = max._max.id
    }

    return NextResponse.json({
      format: HYBRID_FORMAT,
      generatedAt: new Date().toISOString(),
      head,
      tables,
      floors,
      sequences,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
