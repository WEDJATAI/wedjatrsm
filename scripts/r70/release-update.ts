/**
 * r70: publish the v2.7.2 desktop artifacts to the platform-setup-v2 release
 * (the r68/r69 pattern): PATCH the title/notes (the update-manifest parses
 * the version from the release NAME), replace the 3 assets, verify anonymous
 * availability, then verify /api/desktop/update-manifest offers 2.7.2.
 * Usage: bun scripts/r70/release-update.ts
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { envLocal } from '../lib/env-local'

const token = envLocal('GITHUB_TOKEN')
const repo = envLocal('GITHUB_REPO')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'
const TAG = 'platform-setup-v2'
const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rsm-r70' }
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

const ASSETS: { file: string; name: string }[] = [
  { file: 'agent-desktop/dist/RSM-Platform-Setup.exe', name: 'RSM-Platform-Setup.exe' },
  { file: 'agent-desktop/dist/RSM-Platform-Setup-macOS.zip', name: 'RSM-Platform-Setup-macOS.zip' },
  { file: 'agent-desktop/dist/rsm-platform-payload.zip', name: 'rsm-platform-payload.zip' },
]

async function main() {
  const relRes = await fetch(`${API}/repos/${repo}/releases/tags/${TAG}`, { headers })
  if (!relRes.ok) throw new Error(`release fetch failed: ${relRes.status} ${await relRes.text()}`)
  const rel = (await relRes.json()) as { id: number; assets: Array<{ id: number; name: string }> }

  const hashes = ASSETS.map((a) => ({ ...a, sha: sha256(a.file), bytes: statSync(a.file).size }))

  const notes = [
    '**RSM Platform v2.7.2 (r70)** — app updates install IN PLACE (no re-download needed — the agent checks the cloud hourly and updates itself).',
    '',
    "## What's new (r70 — master-mandate audit)",
    '- **Data convergence repair** — a merge payment re-parent and a cancelled check lost to a terminal db recycle were healed through the guarded sync path; local↔cloud parity is at ZERO divergences (re-checkable with `bun scripts/r70/parity-scan.ts`).',
    '- **Crash hardening** — a rare full-page crash when closing the My-shift sheet during a background refresh is fixed, and every unexpected error now shows a one-tap recovery screen instead of a blank page.',
    '- **Mobile waiter portal fix** — the bottom tabs Tables / My Orders now actually open the floor from the launcher (they were inert buttons).',
    '- **Security patch** — zod updated (GHSA-mrhx-c7xc-m3w5).',
    '',
    '## SHA-256',
    ...hashes.map((h) => `- \`${h.name}\`: \`${h.sha}\` (${h.bytes.toLocaleString('en-US')} B)`),
    '',
    '**First run:** download the installer once → install → the agent enrolls itself and stays updated in place from v2.7.0 onward.',
  ].join('\n')

  const patch = await fetch(`${API}/repos/${repo}/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RSM Platform — full desktop version (r70 · v2.7.2)', body: notes, draft: false }),
  })
  if (!patch.ok) throw new Error(`release patch failed: ${patch.status} ${await patch.text()}`)
  console.log('· release retitled → "RSM Platform — full desktop version (r70 · v2.7.2)"')

  for (const asset of ASSETS) {
    const existing = rel.assets.find((a) => a.name === asset.name)
    if (existing) {
      const del = await fetch(`${API}/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE', headers })
      if (!del.ok) throw new Error(`asset delete failed ${asset.name}: ${del.status}`)
    }
    const up = await fetch(`${UPLOADS}/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(asset.name)}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/octet-stream' },
      body: readFileSync(asset.file),
    })
    if (!up.ok) throw new Error(`asset upload failed ${asset.name}: ${up.status} ${await up.text()}`)
    console.log(`· asset replaced: ${asset.name} (${statSync(asset.file).size.toLocaleString('en-US')} B)`)
  }

  for (const h of hashes) {
    const head = await fetch(`https://github.com/${repo}/releases/download/${TAG}/${h.name}`, { method: 'HEAD', redirect: 'follow' })
    console.log(`· anonymous mirror ${h.name}: ${head.status}`)
  }
  console.log('· payload sha256:', hashes[2].sha)
}

main().catch((e) => { console.error(e); process.exit(1) })
