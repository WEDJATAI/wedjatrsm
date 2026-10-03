import { PrismaClient as PgClient } from '../../pgtmp-client'
import { neonPooledUrl } from '../lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const c = await pg.$queryRawUnsafe(`SELECT id, name FROM customers ORDER BY id`) as any[]
    console.log('Neon customers (all):', JSON.stringify(c))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
