// /api/download/macos — password-gated download of the FULL macOS desktop
// version installer (r58: universal x64 + arm64, full platform payload).
//
// The artifact is a .zip containing the one-shot installer app
// (RSM Platform Setup.app):
//   Contents/MacOS/RSMPlatformSetup        — Mach-O UNIVERSAL binary (both
//                                            Intel and Apple-Silicon Macs,
//                                            each slice's code signature
//                                            intact)
//   Contents/Resources/RSMCFG.json         — side-car bootstrap config
//                                            (hub-first + enrollment key)
//   Contents/Resources/platform-payload.zip — the FULL platform payload (the
//                                            same package the Windows .exe
//                                            embeds — on macOS it rides as a
//                                            resource because the Mach-O
//                                            signature must stay last)
//
// Both the local build and the GitHub mirror carry the baked hub-first
// config WITH the enrollment key (the r58 Windows-mirror fix applies here
// too — without the key the desktop can never enroll and sync never arms).
import path from 'node:path'

import { createDesktopDownloadRoute } from '@/lib/desktop-download'

const route = createDesktopDownloadRoute({
  routePath: '/api/download/macos',
  artifactPath: path.join(process.cwd(), 'agent-desktop', 'dist', 'RSM-Platform-Setup-macOS.zip'),
  artifactName: 'RSM-Platform-Setup-macOS.zip',
  mirrorUrl:
    process.env.MACOS_AGENT_MIRROR ??
    'https://github.com/WEDJATAI/wedjatrsm/releases/download/platform-setup-v2/RSM-Platform-Setup-macOS.zip',
  tokenPurpose: 'dlmac',
  rateKey: 'mac',
  label: 'macOS full-version installer .zip',
})

export const GET = route.GET
export const POST = route.POST
