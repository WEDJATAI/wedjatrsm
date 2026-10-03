import { PrismaClient as PgClient } from '../../pgtmp-client'
import { neonPooledUrl } from '../lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    for (const t of ['orders', 'reservations', 'hybrid_conflicts']) {
      const cols = await pg.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='${t}' ORDER BY ordinal_position`) as any[]
      console.log(t, '->', cols.map((c: any) => c.column_name).join(', '))
    }
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e.message); process.exit(1) })
