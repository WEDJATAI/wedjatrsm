// /api/integrations/mazaj/config — R45 public mazaj config for the POS
// "Order Shisha" button. The guest-ordering page URL is NOT a secret (it
// is the page cafe guests open on their phones), so no auth is required —
// any authenticated-free surface can light the button up when configured.
//
//   GET → { enabled: boolean, orderUrl: string | null, default: boolean }
//
// Resolution (R46):
//   · AppSetting mazajOrderUrl set to a http(s) URL → used as-is.
//   · AppSetting set to "off" / "disabled"          → button hidden.
//   · AppSetting ABSENT/empty                       → MAZAJ_DEFAULT_ORDER_URL
//     (the owner's live mazaj deployment — lights the button up on every
//     terminal without per-terminal setup; per-terminal app_settings are
//     local-first by the r39 design decision).
// The response's `default` flag tells the UI the URL came from the
// built-in default rather than an explicit setting.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { MAZAJ_DEFAULT_ORDER_URL, MAZAJ_ORDER_URL_KEY } from '@/lib/constants'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest) {
  const row = await db.appSetting.findUnique({ where: { key: MAZAJ_ORDER_URL_KEY } })
  const raw = row?.value?.trim() ?? ''
  if (/^(off|disabled|none|hidden)$/i.test(raw)) {
    return NextResponse.json({ enabled: false, orderUrl: null, default: false })
  }
  const isUrl = /^https?:\/\//i.test(raw)
  const url = isUrl ? raw : MAZAJ_DEFAULT_ORDER_URL
  return NextResponse.json({
    enabled: true,
    orderUrl: url,
    default: !isUrl,
  })
}
