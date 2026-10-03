// /api/download/windows — password-gated download of the Windows 10 agent .exe.
//
// r34 made this a NATIVE browser download (GET + signed link) with the public
// GitHub Release mirror as the always-on fallback — the old POST-only JS-blob
// download was silently blocked inside sandboxed preview iframes, and the
// Vercel deployment had no .exe at all (agent-desktop/dist is gitignored).
//
// r36: the shared transport logic lives in @/lib/desktop-download (the macOS
// agent download uses the identical factory). This route keeps its exact
// behavior: POST { password } → JSON grant { url, name, size, mirror };
// GET ?token=<exp>.<sig> streams the LOCAL .exe with a per-download RSMCFG1
// PE-overlay tail (sync server = the origin the user downloaded from + the
// durable cloud hub), or 302-redirects to the GitHub mirror when no local
// build exists (the Vercel path).
import path from 'node:path'

import { buildWindowsConfigTail, createDesktopDownloadRoute } from '@/lib/desktop-download'

const route = createDesktopDownloadRoute({
  routePath: '/api/download/windows',
  artifactPath: path.join(process.cwd(), 'agent-desktop', 'dist', 'RSM-Windows-Agent-Setup.exe'),
  artifactName: 'RSM-Windows-Agent-Setup.exe',
  mirrorUrl:
    process.env.WINDOWS_AGENT_MIRROR ??
    'https://github.com/WEDJATAI/wedjatrsm/releases/download/windows-agent-v1/RSM-Windows-Agent-Setup.exe',
  tokenPurpose: 'dlwin',
  rateKey: 'win',
  label: 'Windows agent .exe',
  // PE-overlay tail bytes reserved in the announced size
  tailBytes: 256,
  buildTail: buildWindowsConfigTail,
})

export const GET = route.GET
export const POST = route.POST
