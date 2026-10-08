import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const p = new PrismaClient({ adapter: new PrismaLibSql({ url: ('file:/home/z/my-project/db/restore-pending.db').split('?')[0] }), log: ['error'] }) /* r49 */
const st = (await p.$queryRawUnsafe("SELECT key FROM hybrid_sync_state WHERE key='restore.pending'")) as Array<{ key: string }>
console.log('staged restore.pending marker:', st.length ? 'PRESENT (must clear!)' : 'absent (clean)')
const tgt = await p.appSetting.findUnique({ where: { key: 'sync.targetUrl' } })
console.log('staged sync.targetUrl:', tgt?.value ?? '(unset)')
const dev = await p.hybridDevice.findMany({ select: { deviceId: true, name: true, status: true } })
console.log('staged devices:', JSON.stringify(dev))
await p.$disconnect()
