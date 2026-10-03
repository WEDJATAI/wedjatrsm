import { db } from '../src/lib/db'
async function main() {
  // release the failed events for immediate retry now that the FK parent exists
  const res = await db.hybridEvent.updateMany({
    where: { direction: 'out', status: 'pending', nextAttemptAt: { not: null } },
    data: { nextAttemptAt: new Date(), attempts: 0 },
  })
  console.log('events released for retry:', res.count)
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
