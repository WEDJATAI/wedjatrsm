import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const cols = await pg.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name='categories' ORDER BY ordinal_position`) as any[]
    console.log('columns:', cols.map((c: any) => c.column_name).join(', '))
    await pg.$executeRawUnsafe(`INSERT INTO categories (id, name, display_order, active) VALUES (6, 'Ingredients (internal)', 99, false) ON CONFLICT (id) DO NOTHING`)
    const row = await pg.$queryRawUnsafe(`SELECT id, name, active FROM categories WHERE id = 6`) as any[]
    console.log('Neon category 6 now:', JSON.stringify(row))
    await pg.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('categories','id'), GREATEST((SELECT MAX(id) FROM categories), 1))`)
    console.log('categories sequence synced')
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
