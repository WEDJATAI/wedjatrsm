// /api/sync/status — R15 Sync Center status (admin/settings).
// GET: sync settings DTO — target URL, auto-export flag, watermark
// timestamps, masked sync key and per-table pending counts (rows created
// since the last export). Creates the sync key lazily on first read.

import { NextRequest, NextResponse } from 'next/server'

import { requireAuth, errorResponse } from '@/lib/auth'
import { getSyncStatus } from '@/lib/sync'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    return NextResponse.json({ sync: await getSyncStatus() })
  } catch (err) {
    return errorResponse(err)
  }
}
