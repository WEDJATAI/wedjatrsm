import { db } from '../../src/lib/db'
const users = await db.user.findMany({ select: { id: true, name: true, email: true, role: true, active: true }, orderBy: { id: 'asc' } })
console.log(JSON.stringify(users, null, 1))
await db.$disconnect()
