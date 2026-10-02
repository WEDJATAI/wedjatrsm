// Shared loader for deployment credentials.
// SECURITY (audit finding 2026-10-01): credentials must NEVER be hardcoded in
// git-tracked source. The single source of truth is the gitignored
// .env.deploy-local (covered by the `.env*` .gitignore rule). The Neon pooled
// URL contains '&' — never `source` the file in bash; always read it here.
import { readFileSync } from 'node:fs'

const FILE = '/home/z/my-project/.env.deploy-local'

export function envLocal(key: string): string {
  const m = readFileSync(FILE, 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'))
  if (!m || !m[1].trim()) {
    throw new Error('Missing ' + key + ' in ' + FILE + ' (gitignored credential store — see worklog)')
  }
  return m[1].trim()
}

/** Neon pooled connection string (contains & — do not source in bash). */
export const neonPooledUrl = (): string => envLocal('NEON_DATABASE_URL')

/** Turso auth JWT. */
export const tursoAuthToken = (): string => envLocal('TURSO_AUTH_TOKEN')

/** Turso libsql:// URL. */
export const tursoDatabaseUrl = (): string => envLocal('TURSO_DATABASE_URL')

/** Turso Hrana pipeline endpoint derived from the libsql URL. */
export const tursoPipelineUrl = (): string =>
  'https://' + tursoDatabaseUrl().replace(/^libsql:\/\//, '') + '/v2/pipeline'
