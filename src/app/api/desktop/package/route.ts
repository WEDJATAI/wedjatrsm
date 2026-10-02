// /api/desktop/package — R15 Windows package download (admin/settings).
// GET ?data=live|demo (default live):
//  - live: ships a consistent snapshot of the CURRENT database
//  - demo: ships a freshly generated + seeded demo database
// Builds the package in a temp dir, buffers the zip, ALWAYS cleans up, then
// streams it back as an attachment (rsm-windows-x64.zip).

import { NextRequest, NextResponse } from 'next/server'
import { readFile } from 'node:fs/promises'

import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { buildWindowsPackage, WINDOWS_ZIP_NAME } from '@/lib/windows-package'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'settings'])

    const dataParam = req.nextUrl.searchParams.get('data') ?? 'live'
    if (dataParam !== 'live' && dataParam !== 'demo') {
      throw new ApiError('data must be "live" or "demo"', 400)
    }

    const pkg = await buildWindowsPackage(dataParam)

    // Buffer first, then cleanup — the response never depends on the temp tree.
    let zip: Buffer
    try {
      zip = await readFile(pkg.filePath)
    } finally {
      await pkg.cleanup()
    }

    await logAudit({
      user,
      action: 'desktop.package',
      entity: 'system',
      entityId: null,
      details: `Windows package generated (${dataParam} data): ${WINDOWS_ZIP_NAME} (${zip.length} bytes)`,
    })

    return new Response(new Uint8Array(zip), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${WINDOWS_ZIP_NAME}"`,
        'content-length': String(zip.length),
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
