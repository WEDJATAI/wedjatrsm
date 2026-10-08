// /api/download/macos — password-gated download of the macOS (Intel x64)
// agent, r36's sibling of /api/download/windows (same factory, same password,
// same GitHub-mirror fallback strategy).
//
// The artifact is a .zip containing the one-shot installer app
// (RSM-macOS-Agent-Setup.app). The bootstrap config rides as a SIDE-CAR
// resource inside the bundle (Contents/Resources/RSMCFG.json) — the Mach-O
// executable is code-signed and its signature must remain the last thing in
// the binary, so no RSMCFG1 tail is appended on macOS (that is the Windows
// PE-overlay trick). Both the local build and the GitHub mirror carry the
// baked hub-first config (durable cloud hub = primary), which is the v1.1+
// sync policy the Windows agent ships as well.
import path from 'node:path'

import { createDesktopDownloadRoute } from '@/lib/desktop-download'

const route = createDesktopDownloadRoute({
  routePath: '/api/download/macos',
  artifactPath: path.join(process.cwd(), 'agent-desktop', 'dist', 'RSM-macOS-Agent-Setup.zip'),
  artifactName: 'RSM-macOS-Agent-Setup.zip',
  mirrorUrl:
    process.env.MACOS_AGENT_MIRROR ??
    'https://github.com/WEDJATAI/wedjatrsm/releases/download/windows-agent-v1/RSM-macOS-Agent-Setup.zip',
  tokenPurpose: 'dlmac',
  rateKey: 'mac',
  label: 'macOS agent .zip',
})

export const GET = route.GET
export const POST = route.POST
