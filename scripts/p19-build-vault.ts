/**
 * p19 HARDENING: build `.git/env-vault.env` — the recycle-proof credential vault.
 *
 * WHY: the sandbox recycle (8 events so far) wipes .env (stripped to 2 keys),
 * .env.deploy-local, /home/z/.deploy-creds*.env — but has NEVER touched files
 * inside .git/ (proven 8 times: .git/deploy-creds.env survived every recycle).
 * The vault lives at .git/env-vault.env (inside .git, NOT a tracked object, so
 * it never leaves this machine in a push — same protection model as
 * .git/deploy-creds.env) and holds the FULL union of every credential the
 * platform needs. auto-heal (scripts/auto-heal.ts + src/lib/recycle-guard.ts)
 * rebuilds every other store from it.
 *
 * Usage: bun scripts/p19-build-vault.ts
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'

const ROOT = '/home/z/my-project'

/** Parse a KEY=VALUE env file into an ordered map (comments/blank lines skipped). */
function parseEnv(file: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim())
  }
  return out
}

const sources = [
  `${ROOT}/.env`,                    // live app env (DATABASE_URL, JWT_SECRET, AI keys, Turso, Inngest)
  `${ROOT}/.env.deploy-local`,       // deploy creds + AI keys
  `${ROOT}/.git/deploy-creds.env`,   // proven recycle survivor (deploy creds)
]

const vault = new Map<string, string>()
const origin: Record<string, string> = {}
for (const src of sources) {
  for (const [k, v] of parseEnv(src)) {
    if (!vault.has(k)) {
      vault.set(k, v)
      origin[k] = src.replace(ROOT + '/', '')
    }
  }
}

const REQUIRED = [
  'DATABASE_URL', 'JWT_SECRET',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY',
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
  'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY',
  'GITHUB_TOKEN', 'GITHUB_REPO', 'VERCEL_TOKEN', 'VERCEL_PROJECT', 'VERCEL_PROD_URL',
  'NEON_DATABASE_URL', 'NEON_UNPOOLED_DATABASE_URL', 'NEON_USER', 'NEON_PASSWORD', 'NEON_DATABASE',
]
const missing = REQUIRED.filter((k) => !vault.get(k))
if (missing.length > 0) {
  console.error('VAULT REFUSED — missing required keys from ALL sources:', missing.join(', '))
  console.error('Fix the source stores first, then re-run.')
  process.exit(1)
}

const header = `# ══════════════════════════════════════════════════════════════════════
# RSM PLATFORM CREDENTIAL VAULT (p19 hardening)
# ══════════════════════════════════════════════════════════════════════
# This file is the RECYCLE-PROOF source of truth for every credential the
# platform needs. It lives INSIDE .git/ (never a tracked object — it is not
# part of any commit, push, or bundle) because .git/ contents have survived
# all 8 sandbox recycles, while every store OUTSIDE .git/ was wiped.
#
# REBUILD EVERYTHING FROM HERE:
#   bun scripts/auto-heal.ts          # one command: env + db + /home/z copies
#
# Integrity: backups/creds-manifest.json holds sha256 of every store —
#   bun scripts/harden-verify.ts      # verifies all stores against the vault
#
# NEVER run "source" on this file in bash (Neon URLs contain '&' — use
# scripts/lib/env-local.ts or bun scripts instead).
# Rotate a key: update it HERE, run auto-heal, then update the cloud
# (Vercel env / Neon / Turso consoles) — see docs/RUNBOOK.md.
# ══════════════════════════════════════════════════════════════════════
`

const body = [...vault.entries()]
  .map(([k, v]) => `${k}=${v}`)
  .join('\n') + '\n'

writeFileSync(`${ROOT}/.git/env-vault.env`, header + body)
chmodSync(`${ROOT}/.git/env-vault.env`, 0o600)

console.log(`vault built: .git/env-vault.env — ${vault.size} keys (all ${REQUIRED.length} required present)`)
for (const [k, src] of Object.entries(origin)) console.log(`  ${k.padEnd(28)} ← ${src}`)
