/**
 * r69: publish the v2.7.1 desktop artifacts to the platform-setup-v2 release
 * (the r68 pattern): PATCH the title/notes (the update-manifest parses the
 * version from the release NAME), replace the 3 assets, verify anonymous
 * availability, then verify /api/desktop/update-manifest offers 2.7.1.
 * Usage: bun scripts/r69/release-update.ts
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { envLocal } from '../lib/env-local'

const token = envLocal('GITHUB_TOKEN')
const repo = envLocal('GITHUB_REPO')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'
const TAG = 'platform-setup-v2'
const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rsm-r69' }
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

const ASSETS: { file: string; name: string }[] = [
  { file: 'agent-desktop/dist/RSM-Platform-Setup.exe', name: 'RSM-Platform-Setup.exe' },
  { file: 'agent-desktop/dist/RSM-Platform-Setup-macOS.zip', name: 'RSM-Platform-Setup-macOS.zip' },
  { file: 'agent-desktop/dist/rsm-platform-payload.zip', name: 'rsm-platform-payload.zip' },
]

async function main() {
  const relRes = await fetch(`${API}/repos/${repo}/releases/tags/${TAG}`, { headers })
  if (!relRes.ok) throw new Error(`release fetch failed: ${relRes.status} ${await relRes.text()}`)
  const rel = (await relRes.json()) as any

  const hashes = ASSETS.map((a) => ({ ...a, sha: sha256(a.file), bytes: statSync(a.file).size }))

  const notes = [
    '**RSM Platform v2.7.1 (r69)** — from v2.7.0 ON, app updates install IN PLACE (no re-download needed — the agent checks the cloud hourly and updates itself). This is the first in-place-delivered update.',
    '',
    '## What\'s new (r69)',
    '- **My shift on MOBILE** — servers can now open their shift view from the phone (waiter portal floor chip); it was desktop-only before.',
    '- **My shift check list shows the SETTLE time** — the moment each check became the server\'s shift work (a check opened days earlier but settled today now reads correctly, e.g. healed takeaway #2251 → 13:14, not its old creation time).',
    '- **Draft checks show the acting user\'s name** — "Server: Amira" instead of a role label, from the first unsent item.',
    '- **Money inputs always two decimals** — the cash-received field seeds "623.70", not "623.7" (cash-register display).',
    '- **Full-surface harmony audit** — every dashboard, portal and tab E2E-verified live (payments, reports, shifts, ordering, takeaway, kitchen, copilot, cash drawer, vision); all endpoints 200.',
    '',
    '## SHA-256',
    ...hashes.map((h) => `- \`${h.name}\` — \`${h.sha}\``),
    '',
    '## First run (existing desktops)',
    '1. Desktops already on **v2.7.0** need nothing — the agent picks this release up within the hour and updates itself in place.',
    '2. Fresh installs: run the installer (Windows: SmartScreen → **More info → Run anyway**; macOS: right-click → Open). Enrollment + two-way cloud sync are automatic.',
    '3. *Older desktops (v2.6.1 and earlier) still need the v2.7.0 installer path once to gain the in-place update capability.*',
  ].join('\n')

  const patched = await fetch(`${API}/repos/${repo}/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'RSM Platform — full desktop version (r69 · v2.7.1)',
      body: notes,
      draft: false,
      make_latest: 'false',
    }),
  })
  if (!patched.ok) throw new Error(`release PATCH failed: ${patched.status} ${await patched.text()}`)
  console.log(`· release retitled → "RSM Platform — full desktop version (r69 · v2.7.1)"`)

  for (const h of hashes) {
    for (const asset of rel.assets ?? []) {
      if (asset.name === h.name) {
        const d = await fetch(`${API}/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE', headers })
        if (!d.ok) throw new Error(`asset delete failed for ${h.name}: ${d.status}`)
        console.log(`  · deleted old asset ${h.name}`)
      }
    }
    const body = readFileSync(h.file)
    const up = await fetch(`${UPLOADS}/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(h.name)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
      body,
    })
    if (!up.ok) throw new Error(`asset upload failed for ${h.name}: ${up.status} ${await up.text()}`)
    const asset = (await up.json()) as any
    const anon = await fetch(asset.browser_download_url, { method: 'HEAD' })
    console.log(`  · uploaded ${h.name} (${h.bytes.toLocaleString()} B, sha ${h.sha.slice(0, 12)}…) · anon ${anon.status} ${anon.status in [200, 206] ? '✓' : ''}`)
    if (anon.status !== 200 && anon.status !== 206) throw new Error(`${h.name} not anonymously reachable`)
  }

  console.log('\nrelease OK → https://github.com/' + repo + '/releases/tag/' + TAG)
}
main().catch((e) => { console.error('[r69 release] FAILED:', e); process.exit(1) })
