/** r69: wait for the Vercel auto-deploy to go READY at the pushed root (549bfd9). */
import { envLocal } from '../lib/env-local'
const token = envLocal('VERCEL_TOKEN')
const project = envLocal('VERCEL_PROJECT')
const EXPECTED = '549bfd9146'
const headers = { Authorization: `Bearer ${token}` }
const deadline = Date.now() + 8 * 60_000
let last = ''
while (Date.now() < deadline) {
  const list = await (await fetch(`https://api.vercel.com/v6/deployments?app=${encodeURIComponent(project)}&limit=5&target=production`, { headers })).json()
  const dep = (list.deployments ?? []).find((d: any) => d.target === 'production' || d.target === 'prod')
  if (dep) {
    last = `${dep.readyState} @ ${dep.meta?.githubCommitSha?.slice(0, 7) ?? dep.sha?.slice(0, 7) ?? '?'} (${dep.url})`
    if ((dep.meta?.githubCommitSha ?? dep.sha ?? '').startsWith(EXPECTED) && dep.readyState === 'READY') {
      console.log('VERCEL READY at', EXPECTED, '→', dep.url)
      process.exit(0)
    }
    if ((dep.meta?.githubCommitSha ?? dep.sha ?? '').startsWith(EXPECTED) && ['ERROR', 'CANCELED'].includes(dep.readyState)) {
      console.error('VERCEL FAILED:', dep.readyState, dep.url); process.exit(1)
    }
  }
  console.log(new Date().toISOString().slice(11, 19), last || 'no deployment yet…')
  await new Promise((r) => setTimeout(r, 15_000))
}
console.error('timeout waiting for Vercel READY at', EXPECTED); process.exit(1)
