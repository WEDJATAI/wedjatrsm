/**
 * R23: Inngest serve endpoint — registers the app's functions with Inngest
 * Cloud (the Vercel integration set INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY
 * on the project) and receives scheduled invocations.
 *
 * Local check: `curl localhost:3000/api/inngest` returns the function
 * registry in development mode.
 */
import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { functions } from '@/inngest/functions'

export const dynamic = 'force-dynamic'

export const { GET, POST, PUT } = serve({ client: inngest, functions })
