import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from '../lib/env-local'
const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) }) // r49: Prisma 7 adapter
const rows = (await pg.$queryRawUnsafe(`SELECT id, name, phone FROM customers ORDER BY id`)) as Array<{ id: number; name: string; phone: string | null }>
console.log(`NEON customers (${rows.length}):`)
for (const r of rows) console.log(`  #${r.id} ${r.name} ${r.phone ?? ''}`)
const seq = (await pg.$queryRawUnsafe(`SELECT last_value, is_called FROM customers_id_seq`)) as Array<{ last_value: bigint; is_called: boolean }>
console.log('customers_id_seq:', JSON.stringify(seq[0]))
await pg.$disconnect()
