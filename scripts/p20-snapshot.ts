/** p20: one manual snapshot so the tracked recovery point + manifest reflect the final repaired state (1038 orders, full parity). */
import { takeSnapshot } from '../src/lib/db-snapshot'
const r = await takeSnapshot('p20 manual: post-harmony-repair recovery point refresh')
console.log(JSON.stringify(r, null, 1))
process.exit(0)
