/**
 * R23: Inngest serve endpoint — registers the app's functions with Inngest
 * Cloud (the Vercel integration set INNGEST_SIGNING_KEY / INNGEST_EVENT_KEY
 * on the project) and receives scheduled invocations.
 *
 * Local check: with no INNGEST_SIGNING_KEY, every environment answers 503
 * with the self-describing diagnostic below (the raw SDK error was opaque).
 * With a signing key present (integration re-connected, or INNGEST_SIGNING_KEY
 * set locally) the serve handlers answer normally (401 auth wall / registry).
 *
 * p12 addition (diagnostic wrapper): when this deployment has no
 * INNGEST_SIGNING_KEY (the Vercel↔Inngest integration detached — external
 * regression observed Oct 1 2026, see worklog p11-addendum), the SDK's raw
 * handler answers 500 {"code":"internal_server_error"}, which is
 * indistinguishable from a real app fault. The wrapper converts that into a
 * self-describing 503 so monitors can tell "integration detached" (known
 * cause, cron mirrors keep the business functions running) apart from a
 * genuine 500. Purely additive: when the key IS present, behavior is
 * byte-identical to the raw serve() handlers.
 */
import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import { functions } from '@/inngest/functions'

export const dynamic = 'force-dynamic'

const handlers = serve({ client: inngest, functions }) as unknown as {
  GET: (r: Request) => Promise<Response>
  POST: (r: Request) => Promise<Response>
  PUT: (r: Request) => Promise<Response>
}

async function withDiagnostics(name: 'GET' | 'POST' | 'PUT', req: Request): Promise<Response> {
  const res = await handlers[name](req)
  if (res.status >= 400 && !process.env.INNGEST_SIGNING_KEY) {
    return Response.json(
      {
        error: 'inngest unreachable',
        hint: 'No INNGEST_SIGNING_KEY on this deployment — the Vercel↔Inngest integration is detached. Re-connect it in the Vercel dashboard (or set INNGEST_SIGNING_KEY) and redeploy.',
        crons: 'The Vercel-native cron mirrors (daily-digest 15 6 * * *, turso-sync 0 3 * * *) remain scheduled — business functions unaffected.',
      },
      { status: 503 },
    )
  }
  return res
}

export const GET = (req: Request) => withDiagnostics('GET', req)
export const POST = (req: Request) => withDiagnostics('POST', req)
export const PUT = (req: Request) => withDiagnostics('PUT', req)
