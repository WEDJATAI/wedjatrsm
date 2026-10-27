/**
 * r72: publish the v2.7.3 desktop payload to the platform-setup-v2 release.
 * In-place update path: PATCH the release title/notes (the update-manifest
 * parses the version from the release NAME) and replace ONLY the payload
 * asset — the v2.7.2 installers remain for first install and self-update
 * on first run (the r68 design). Then verify anonymous availability.
 * Usage: bun scripts/r72/release-update.ts
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { envLocal } from '../lib/env-local'

const token = envLocal('GITHUB_TOKEN')
const repo = envLocal('GITHUB_REPO')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'
const TAG = 'platform-setup-v2'
const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rsm-r72' }
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex')

const PAYLOAD = { file: 'agent-desktop/dist/rsm-platform-payload.zip', name: 'rsm-platform-payload.zip' }

async function main() {
  const relRes = await fetch(`${API}/repos/${repo}/releases/tags/${TAG}`, { headers })
  if (!relRes.ok) throw new Error(`release fetch failed: ${relRes.status} ${await relRes.text()}`)
  const rel = (await relRes.json()) as { id: number; assets: Array<{ id: number; name: string }> }

  const sha = sha256(PAYLOAD.file)
  const bytes = statSync(PAYLOAD.file).size

  const notes = [
    '**RSM Platform v2.7.3 (r72)** — app updates install IN PLACE (no re-download needed — the agent checks the cloud hourly and updates itself).',
    '',
    "## What's new (r72 — full cross-plane 2-way sync audit)",
    '- **Cross-plane parity restored to ZERO divergences** — every synced table now verified id-level in BOTH directions across local, Neon and the Turso replica (22 missing audit rows replayed down, 1 local audit pushed up, 2 stale cloud item rows removed with evidence, 1 item replayed).',
    '- **Drawer-audit sync fix** — cash-drawer audit entries (open / paid in / paid out / close) now sync to every terminal and the cloud like all other audits (previously they stayed on whichever plane recorded them).',
    '- **Verified live** — a full drawer cycle flowed to the cloud within seconds; the Turso replica resynced and matched all planes exactly.',
    '',
    'The v2.7.2 installers below remain the first-install entry point — a fresh install self-updates to v2.7.3 on first run.',
    '',
    '## SHA-256',
    `- \`${PAYLOAD.name}\`: \`${sha}\` (${bytes.toLocaleString('en-US')} B)`,
  ].join('\n')

  const patch = await fetch(`${API}/repos/${repo}/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RSM Platform — full desktop version (r72 · v2.7.3)', body: notes, draft: false }),
  })
  if (!patch.ok) throw new Error(`release patch failed: ${patch.status} ${await patch.text()}`)
  console.log('· release retitled → "RSM Platform — full desktop version (r72 · v2.7.3)"')

  const existing = rel.assets.find((a) => a.name === PAYLOAD.name)
  if (existing) {
    const del = await fetch(`${API}/repos/${repo}/releases/assets/${existing.id}`, { method: 'DELETE', headers })
    if (!del.ok) throw new Error(`asset delete failed: ${del.status}`)
  }
  const up = await fetch(`${UPLOADS}/repos/${repo}/releases/${rel.id}/assets?name=${encodeURIComponent(PAYLOAD.name)}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body: readFileSync(PAYLOAD.file),
  })
  if (!up.ok) throw new Error(`asset upload failed: ${up.status} ${await up.text()}`)
  console.log(`· payload replaced: ${PAYLOAD.name} (${bytes.toLocaleString('en-US')} B)`)

  const head = await fetch(`https://github.com/${repo}/releases/download/${TAG}/${PAYLOAD.name}`, { method: 'HEAD', redirect: 'follow' })
  console.log(`· anonymous mirror: ${head.status}`)
  console.log('· payload sha256:', sha)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
