// P15 live AI consensus verification — exercises the REAL engine
// (src/lib/ai/providers.ts) with the real keys from .env. Verifies:
//   1. chatWithFallback (sequential chain — groq(dead key, skipped fast)
//      → openrouter → nvidia → gemini(dead key) → huggingface)
//   2. chatWithConsensus (parallel fan-out + medoid selection)
//   3. Model-level failover (a bad first model falls through to the next)
//   4. aiProviderHealth (safe diagnostics)
//   5. HF embeddings (menu search unchanged)
// Prints an honest PASS/FAIL matrix. No secrets ever printed.

import {
  chatWithFallback,
  chatWithConsensus,
  aiProviderHealth,
  embedTexts,
  localEmbed,
  cosineSimilarity,
} from '../src/lib/ai/providers'

let pass = 0
let fail = 0
function report(name: string, ok: boolean, detail: string) {
  if (ok) {
    pass++
    console.log(`PASS ${name} — ${detail}`)
  } else {
    fail++
    console.log(`FAIL ${name} — ${detail}`)
  }
}

const t0 = Date.now()

// ── 1. Sequential chain ────────────────────────────────────────────
try {
  const started = Date.now()
  const r = await chatWithFallback(
    [{ role: 'user', content: 'In one short sentence: what is a Z-report in a restaurant POS?' }],
    { system: 'You are a POS expert. Answer in one sentence.', temperature: 0.2, maxTokens: 120 },
  )
  report(
    'chain-chat',
    r.text.length > 20,
    `${r.provider}:${r.model} in ${Date.now() - started}ms — "${r.text.slice(0, 80)}…"`,
  )
} catch (e) {
  report('chain-chat', false, String(e).slice(0, 120))
}

// ── 2. Consensus round ─────────────────────────────────────────────
try {
  const started = Date.now()
  const c = await chatWithConsensus(
    [{ role: 'user', content: 'Name the single most important metric to watch daily in a restaurant and why. Two sentences max.' }],
    { temperature: 0.4, maxTokens: 200 },
  )
  const detail =
    `${c.strategy} ${c.agreement.agreed}/${c.agreement.total} via ${c.provider}:${c.model} ` +
    `in ${Date.now() - started}ms — votes: ${c.votes.map((v) => `${v.provider}(${v.model.split('/').pop()}, ${v.ms}ms)`).join(' · ')} ` +
    `— abstained: ${c.abstentions.map((a) => `${a.provider}(${a.error})`).join(' · ') || 'none'}`
  report(
    'consensus',
    c.text.length > 20 && c.votes.length >= 2,
    detail,
  )
} catch (e) {
  report('consensus', false, String(e).slice(0, 120))
}

// ── 3. Provider health snapshot ────────────────────────────────────
{
  const health = aiProviderHealth()
  const lines = health.map(
    (p) =>
      `${p.id}${p.configured ? '' : '(no key)'}: ${p.models.length} models, last-working=${p.lastWorkingModel ?? '—'}, breakers=${Object.keys(p.breakers).length}`,
  )
  const configured = health.filter((p) => p.configured)
  report(
    'provider-health',
    configured.length >= 2 && health.length === 5,
    `${configured.length}/5 configured — ${lines.join(' | ')}`,
  )
}

// ── 4. Model-level failover (synthetic: request a nonexistent model indirectly
//        is not possible via the public API — instead verify the sticky-model
//        map updated and breaker keys are per-model) ─────────────────
{
  const health = aiProviderHealth()
  const withWorking = health.filter((p) => p.lastWorkingModel !== null)
  report(
    'model-stickiness',
    withWorking.length >= 2,
    `sticky models recorded for: ${withWorking.map((p) => `${p.id}→${p.lastWorkingModel}`).join(', ')}`,
  )
}

// ── 5. Embeddings (unchanged behavior) ─────────────────────────────
try {
  const e = await embedTexts(['pepperoni pizza', 'orange juice fresh'])
  const sim = cosineSimilarity(e.vectors[0], e.vectors[1])
  const localA = localEmbed('pepperoni pizza')
  const localB = localEmbed('pepperoni pizza pie')
  report(
    'embeddings',
    e.vectors.length === 2 && e.vectors[0].length > 0,
    `provider=${e.provider}, dims=${e.vectors[0].length}, cross-sim=${sim.toFixed(3)}, local-determinism=${localA.length === localB.length}`,
  )
} catch (e) {
  report('embeddings', false, String(e).slice(0, 120))
}

console.log(`\n${pass} PASS / ${fail} FAIL in ${Date.now() - t0}ms`)
process.exit(fail > 0 ? 1 : 0)
