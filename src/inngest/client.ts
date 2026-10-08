/**
 * R23: Inngest client — background-job orchestration for the cloud
 * deployment. The Inngest Vercel integration sets INNGEST_SIGNING_KEY /
 * INNGEST_EVENT_KEY on the project; the serve route is at /api/inngest
 * (Inngest cloud syncs + invokes the functions registered there).
 */
import { Inngest } from 'inngest'

export const inngest = new Inngest({ id: 'wedjatrsm' })
