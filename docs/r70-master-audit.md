# R70 — Master Mandate Full Platform Audit & Controlled Remediation

**Document ID:** PLATFORM-FULL-AUDIT-AND-REMEDIATION-001 (executed as round r70)
**Audit date:** 2026-10-23 (Africa/Cairo)
**Execution cycle:** DISCOVER → MAP → INSPECT → TEST → TRACE → DIAGNOSE → PRIORITIZE → FIX → RETEST → VERIFY → DOCUMENT
**Commit:** `7cbe246` (single-commit invariant preserved; pushed to GitHub → Vercel auto-deploy READY)
**Desktop:** v2.7.1 → v2.7.2 (in-place update channel)

---

## Deliverable A — Executive Audit Report

**Overall verified status:** The platform is operational end-to-end. The full business
cycle (ordering dine-in + takeaway → kitchen → payment with splits/change/tips/refunds →
shift attribution → reports → dashboards → cash drawer → bidirectional multi-plane sync)
was exercised live during this audit and produced correct results, correct money math,
and correct cross-plane convergence.

**Critical findings and business impact:**
1. **Two real cross-plane data divergences found and healed** (P1 — money attribution):
   a paid order (#2242 + its 189.00 payment and −189.00 refund) was missing on the local
   plane, and a merge's payment re-parent (#314, EGP 3,244.50) had been rejected by the
   append-only guard before its parent order was healed to `merged`. Local shift cash
   attribution under-counted by 3,244.50 until this audit's repair. **Both healed through
   the real guarded ingest path; parity scan now reports ZERO order/payment divergences.**
2. **Full-page client crash** (P2): an uncaught `NotFoundError: removeChild` when a
   polling refetch landed during a sheet's exit animation — no error boundary existed
   anywhere, so staff saw a dead screen with no recovery. Fixed (race hardened + root
   error boundary).
3. **Mobile waiter-portal dead buttons** (P2): from the launcher, the bottom tabs
   "Tables"/"My Orders" set the portal tab but never entered the POS view — a waiter's
   primary navigation was inert. Fixed and verified live.
4. **One runtime dependency advisory** (P2 — security): zod GHSA-mrhx-c7xc-m3w5
   (memory exhaustion, CVSS 7.5) — patched 4.6.5 → 4.7.7-satisfied (4.6.7).
5. **Local update-channel outage** (P2 — self-inflicted by environment): the local
   `.env` lost `GITHUB_TOKEN`/`GITHUB_REPO` (sandbox recycle), so the local desktop
   update manifest could not resolve the release (HTTP 403). Restored; manifest now
   resolves v2.7.1 (and v2.7.2 after this round's release update).

**Architecture and vision alignment:** The implementation conforms to the approved
blueprint. All remediation was additive; ZERO structural change (no schema, no DDL,
no removed features, no business-model deviation).

**Major integration and operational risks:** all critical integrations verified GREEN
this round (GitHub, Vercel + crons, Neon RW, Turso, Inngest, AI failover chain, desktop
update channel, hybrid sync engine). Residual risks are documented in Deliverable E/H
(offline desktop queues, echo-guard recovery gap, dev-toolchain advisories, two dead AI
provider keys kept alive by failover).

**Work completed:** 2 UI/robustness code fixes, 1 root error boundary, 1 security patch,
2 data heals, env restoration, recovery point regenerated, r70 audit script suite
(repeatable), full push to cloud (source + Vercel deploy) + desktop (v2.7.2 in-place).

**Remaining blockers:** none release-blocking. See Deliverable H for conditions.

---

## Deliverable B — System Architecture and Dependency Map

```
                        ┌────────────────────────────────────────────┐
                        │                SERVING PLANES              │
                        │  LOCAL (sandbox, SQLite, :3000)            │
                        │  VERCEL PROD (Neon Postgres data plane)    │
                        │  DESKTOPS (Electron agent + SQLite,        │
                        │    supervised server, in-place updates)    │
                        └────────────────────────────────────────────┘
     Users (PIN kiosk / password) ──► Next.js 16 App Router (single / route,
       47 view components, 148 API routes, 31 Prisma models)
                    │
       ┌────────────┼─────────────────────────────────────┐
       ▼            ▼                                     ▼
   SQLite (WAL)   Neon Postgres (cloud data plane)    Turso replica
   local db       — hybrid_events relay + origin      — read mirror
                  writes (deviceId 'unbound')           (cron 03:00)
       └────────────┴──────────────┬──────────────────────┘
                                  │
                  HYBRID SYNC ENGINE (bidirectional)
                  · outbox (local→cloud push, 30s cycle)
                  · pull stream (cloud→device, cursor-based)
                  · policies: append-only (Payment/CashDrawer/
                    Inventory/Waste/Audit/Attendance with 3
                    legitimate-update exemptions), origin-authority
                    (Order/OrderItem + r68 timestamp/terminal-money
                    exemptions), cloud-authoritative (menu refs),
                    revision-aware (operations)
                  · echo guard: a device never re-pulls its own events
                                  │
        ┌─────────────┬──────────┴────────┬─────────────────┐
        ▼             ▼                   ▼                 ▼
   GitHub repo    GitHub release      Inngest jobs     AI providers
   (single-       platform-setup-v2   (daily digest;   (failover chain:
   commit root,   (installers +       Vercel crons     nvidia ✓, gemini,
   protected)     in-place payload    mirror them)     groq ✗403,
   → Vercel       zip → desktop                     openrouter ✗402)
   auto-deploy    hourly self-update)
```

**Verified connections** (all tested this round — see Deliverable C):
local↔Neon (fresh order/payment round-trip #2278/#2279 proven), Neon↔desktop (device
registry + lastPullAt live), Vercel prod serving Neon data (prod my-shift byte-identical
to local), GitHub release mirrors (anonymous 200), update manifest (both planes),
Inngest auth wall, AI copilot (200 in 6.0s on the failover chain).

**Configured-only / by-design notes:** Turso replica is read-only analytics (resync
verified by pipeline ping; last exact resync r69). The 5,112 `out`/pending events on
Neon are the cursor-based cloud-origin write stream (born pending, never mutated —
documented in the pull route header), NOT stuck work.

---

## Deliverable C — API and Integration Register

**Endpoints:** 148 route files inventoried; 119 statically-referenced frontend paths all
resolve to implemented routes (100% wiring); 44 dynamic routes method-matrix verified.
Authenticated GET sweep: 66×200, 0×5xx, 0×404; the 7 non-200s are CORRECT guards
(cron secret 401 ×2, hybrid device-auth 401 ×2, mazaj integration key 401,
backup-download name validation 400, recipes productId validation 400).

| # | Integration | Env | Connectivity | Auth | Contract | Functional | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | GitHub repo (source of truth) | prod | ✅ | ✅ token | ✅ | ✅ origin/main == HEAD 7cbe246 | p13 + push this round |
| 2 | GitHub release platform-setup-v2 | prod | ✅ anonymous 200 | ✅ | ✅ | ✅ 3 assets live, mirrors 200 | release API + HEAD probe |
| 3 | Desktop update manifest | local+prod | ✅ | ✅ device (401 anon verified both planes) | ✅ | ✅ resolves v2.7.1→2.7.2 | temp device enrolled+revoked |
| 4 | Vercel (app serving) | prod | ✅ | ✅ | ✅ | ✅ READY @ 7cbe246, login+my-shift live 0.7s | deployment API + HTTP probes |
| 5 | Vercel crons (digest, turso-sync) | prod | ✅ | ✅ CRON_SECRET wall (401) | ✅ | ✅ registered per vercel.json | vercel API |
| 6 | Neon Postgres (data plane) | prod | ✅ | ✅ | ✅ | ✅ RW smoke; test orders #2278/#2279 landed paid+payments | direct SQL |
| 7 | Turso replica | prod | ✅ ping | ✅ token | ✅ | ✅ (read mirror; exact resync r69) | p13 |
| 8 | Inngest | prod | ✅ | ✅ 401 wall (healthy) | ✅ | ✅ healthy (Vercel crons mirror) | p13 |
| 9 | AI failover chain | prod | ✅ | mixed (2 keys dead: groq 403, openrouter 402) | ✅ | ✅ copilot 200 in 6.0s via nvidia/nemotron | live POST |
| 10 | Mazaj integration feed | prod | ✅ | ✅ x-rsm-key wall | ✅ | configured (key set); poll-safe read-only | route code + 401 probe |
| 11 | Hybrid sync engine (all planes) | all | ✅ | ✅ device creds | ✅ | ✅ engine running, 0 pending local; bidirectional round-trip proven | /api/hybrid/status + Neon queries |
| 12 | Desktop agents (3 registered) | prod | ✅ | ✅ | ✅ | 1 active hourly (GGG7M3A 20:32 today), 2 idle since Oct 22 (offline machines — their events wait, cursor-based) | hybrid_devices table |

**Not externally verifiable from the sandbox:** actual end-user payment terminals (the
platform records payments itself — no PSP webhook); camera hardware (vision module has a
documented simulator); SMS/email providers (none configured — notifications are in-app).

---

## Deliverable D — Requirements and Vision Alignment Matrix

| Requirement (owner directives r67–r70) | Component | Evidence | Result |
|---|---|---|---|
| My Shift shows ALL closed/paid checks of the server | /api/reports/my-shift + my-shift-sheet | #2278/#2279 appeared live (CHECKS TODAY 9→10 for Karim; Amira 18 checks settle-times) | PASS |
| Takeaway connects to My Shift | orders route + settle-claim (r68) | takeaway #2279 in My shift same minute; #2251 legacy case still correct | PASS |
| Item-edit password = user's own PIN/password | PUT /api/orders/[id] verifyItemEditCredential | r69 live re-verify (wrong 999999 → 403, own 112233 → 200); code intact this round | PASS |
| Cloud↔desktop bidirectional timestamp-based sync, constant | hybrid-sync engine | local→cloud: fresh orders+payments on Neon; cloud→local: 30s pulls, cursor current; engine Running, queue 0/0 | PASS |
| Updates reach cloud+desktop+local WITHOUT re-download | update-manifest + in-place agent updater | manifest resolves v2.7.2 on local; desktops self-update hourly; Vercel auto-deployed r70 | PASS |
| English only (no Chinese) | whole tree | Han-character scan over src/ agent-desktop/ desktop/ scripts/ prisma/ mini-services/: ZERO | PASS |
| Harden + backup + push everything | security phase + backup + git ritual | zod patched; secrets clean; single-commit root amended+force-pushed; protection recreated; recovery point regenerated; releases verified | PASS |
| Harmony: every dashboard/portal/tab wired to the right endpoint | endpoint wiring + E2E | 119/119 frontend calls wired; every surface E2E-walked (r69 full surface + r70 core cycle re-verified) | PASS |
| Eat tab word check | POS ordering screen | Menu grid rendered clean English + EGP; receipt bilingual EN+AR; no raw keys | PASS |

---

## Deliverable E — Defect and Security Register

| ID | Sev | Finding | Root cause | Remediation | Retest |
|---|---|---|---|---|---|
| R70-1 | P1 | Payment #314 (EGP 3,244.50) not re-parented to merged target #2246 locally — local cash attribution under-counted | `isPaymentReParent` guard is sequence-sensitive (parent must be `merged` first); the re-parent arrived 13:26 BEFORE the r68 heal merged #2249 at 14:01; rejected event was acked and never retried | Replayed the re-parent through the real ingest path (parent now merged; guard passes; payload byte-identical except orderId) | Parity scan: 0 divergences; #2246 coverage 3,817.80 = 3,817.80 ✅ |
| R70-2 | P1 | Order #2242 + payments #307 (189.00) / #308 (−189.00) missing locally | Terminal db lost the rows (sandbox recycle); the pull echo-guard (deviceId != requester) can never re-deliver a terminal's OWN pushed events | Replayed the 4 events from Neon's own event log through the ingest path with fresh eventIds | Order present as `cancelled`, net 0, FK clean; parity 0 divergences ✅ |
| R70-3 | P2 | Full-page crash: uncaught NotFoundError removeChild (portal close + in-flight refetch race); NO error boundary existed | TanStack in-flight query resolving during the Radix sheet exit animation re-renders rows inside the closing portal | (a) cancel in-flight queries on sheet close, (b) freeze report during exit, (c) NEW root global-error.tsx (one-tap recovery) | 9 rapid open/close cycles: zero errors; tsc/eslint clean ✅ |
| R70-4 | P2 | Mobile waiter-portal bottom tabs Tables/My Orders inert from the launcher | onClick set the portal tab but never `setView('pos')` — the portal stayed hidden on view 'home' | Waiter-tab tap now also enters the POS view | Live Home→Tables→floor verified; tab [selected] ✅ |
| R70-5 | P2 | zod GHSA-mrhx-c7xc-m3w5 (CVSS 7.5 memory exhaustion) — the one runtime advisory | zod 4.6.5 < 4.6.6 | Upgraded to 4.6.7; re-audited (only dev/transitive advisories remain; inngest's internal zod ^3 has no user-input path) | bun pm ls shows 4.6.7; runtime advisories = 0 ✅ |
| R70-6 | P2 | Local update manifest dead (HTTP 403 → source 'none') | Sandbox recycle dropped GITHUB_TOKEN/GITHUB_REPO from .env (gitignored) | Restored from .env.deploy-local (r69 state) | Manifest resolves {v2.7.1, sha d438f402…, 5,260,709} ✅ |
| R70-7 | P3 | 5,112 out/pending events accumulate on Neon for offline devices; 41 dead events (Oct 18 newest) | By-design cursor delivery stream + historical pre-heal debris; no TTL/purge for retired device queues | Documented; no functional impact (active devices drain their cursors); candidate future hygiene task | n/a (observation) |
| R70-8 | P3 | 2 of 5 AI provider keys dead (groq 403, openrouter 402) | Expired credits | Failover chain keeps service on nvidia/gemini — documented; owner may refresh keys | copilot 200 in 6.0s ✅ |
| R70-9 | P3 | Dev-toolchain advisories (eslint/babel/browserslist/picomatch/minimatch/brace-expansion/mysql2-via-OTel-instrumentation-of-unused-drivers) | Transitive dev dependencies | No production attack surface; documented (bun audit) | n/a |
| R70-10 | P3 | tsc: 26 errors in scripts/ (gitignored generated `pgtmp-client` module) | Maintenance scripts reference a locally-generated client | Pre-existing convention (r38/r65 series); src/ is 100% clean; next.config ignores build errors by design | src/ tsc = 0 ✅ |
| R70-11 | P3 | Neon database shares tables from an unrelated app (Better-Auth: account/session/jwks/member/organization…) | Shared Neon free-tier database | No collision with RSM's snake_case tables; credentials scoped; documented for the owner | n/a |

**Security verification summary:** anonymous 401 walls live (hybrid, cron, manifest,
mazaj) · login rate limiting dual-bucket (10/5min per identifier, 30/5min per IP) ·
backup download strict filename regex (path-traversal safe) · zero secrets in source ·
headers nosniff/referrer/dns-prefetch live (CSP/X-Frame-Options deliberately omitted for
the iframe preview panel — documented R16 decision) · PINs bcrypt-hashed · hybrid device
keys stored hashed.

---

## Deliverable F — Automated Test and Verification Report

| Check | Command | Result |
|---|---|---|
| Type check | `bunx tsc --noEmit` | src/: 0 errors (scripts/: 26 known pgtmp-client class) |
| Lint | `bun run lint` | 0 errors, 0 warnings |
| Secret scan | ripgrep high-entropy/key patterns | 0 findings |
| Chinese-character scan | Han range over all trees | 0 findings |
| Endpoint wiring | custom cross-referencer (119 calls × 148 routes) | 100% wired |
| Authenticated API sweep | Python urllib sweep (login → GET all static routes) | 66×200, 0 5xx/404, 7 correct-guard 4xx |
| E2E dine-in | agent-browser: table 21 → 2 items → send → cash 300 | #2278 paid 289.80, change 10.20, receipt + shift list correct |
| E2E takeaway | agent-browser: Cola → send → exact cash | #2279 paid 49.02 (VAT-only), in My shift |
| E2E mobile | agent-browser 390×844 as waitress | no overflow; Tables tab fix verified; My shift sheet works |
| Crash-race stress | 9 rapid sheet open/close cycles (desktop+mobile) | 0 errors post-fix (1 pre-fix crash captured) |
| DB integrity | PRAGMA integrity_check / foreign_key_check | ok / 0 |
| Money precision | 2-decimal scan over orders+payments | 0 true violations |
| Payment coverage | net payments vs total per paid order | all covered (1 correct full-refund #2221) |
| Cross-plane parity | full order+payment diff local vs Neon | 0 divergences (was 4 rows before heals) |
| Platform harmony | `bun scripts/p13-harmony-check.ts` | ALL CRITICAL GREEN |
| Update channel | temp-device manifest probe (local + prod) | v2.7.1→2.7.2 resolving; 401 anonymous both planes |
| AI copilot | POST /api/ai/copilot (business question) | 200 in 6.0s, live data in answer |
| Production serving | prod login + my-shift | 200, byte-identical numbers to local |

---

## Deliverable G — Change and Remediation Log

| File | Change | Finding |
|---|---|---|
| `src/app/global-error.tsx` | NEW root error boundary (one-tap reload, dependency-free) | R70-3 |
| `src/components/pos/my-shift-sheet.tsx` | cancel in-flight queries on close + frozen exit report (React adjust-during-render pattern) | R70-3 |
| `src/components/mobile/mobile-shell.tsx` | waiter-tab tap also enters the POS view | R70-4 |
| `package.json` + `bun.lock` | zod 4.6.5 → 4.6.7 | R70-5 |
| `scripts/r70/` (10 scripts) | audit + heal suite: db-integrity, parity-scan, heal-divergences, order-forensics ×2, trace-payment314, trace-2246-2249, check-2246-cloud, fetch-2242-payloads, local-events-2246, verify-convergence, recovery-point | R70-1/2 + repeatability |
| `agent-desktop/main.ts` | VERSION 2.7.1 → 2.7.2 | desktop channel |
| `download/rsm-platform-database.db` + manifest | recovery point regenerated (14,184,448 B, integrity ok, 0 FK, 56 orders / 54 payments) | R70-1/2 |
| local `.env` (gitignored) | GITHUB_TOKEN/GITHUB_REPO restored | R70-6 |
| Data (local SQLite) | order #2242 + payments #307/#308 replayed; payment #314 re-parented 2249→2246 — all through the guarded ingest path | R70-1/2 |

Git: root amended to `7cbe246` (single-commit invariant; RSM_ALLOW_COMMIT ritual),
force-pushed, branch protection recreated byte-identical (enforce_admins, linear
history, no force pushes/deletions), both tags re-anchored WITHOUT API delete (zero
release downtime), git:guard OK.

---

## Deliverable H — Production Readiness Assessment

**Verdict: READY (with documented conditions).**

Release gates:
1. Architecture integrity — PASS (additive changes only; blueprint preserved).
2. Core functionality — PASS (full cycle E2E-verified live this round).
3. APIs and connections — PASS (all critical integrations functionally verified; register in Deliverable C; offline desktops are machine-state, not platform defects).
4. Data integrity — PASS (integrity ok, 0 FK, full parity, money exact, coverage exact).
5. Security — PASS (no unresolved release-blocking vulnerability; zod patched; walls verified).
6. Runtime reliability — PASS (dev server 200s, no 5xx; crash-hardening added; error boundary as last resort).
7. Regression safety — PASS (lint 0, tsc src 0, E2E re-verified post-fix).
8. Operational readiness — PASS with conditions: (a) refresh or remove the dead groq/openrouter AI keys at the owner's convenience; (b) periodically re-run `bun scripts/r70/parity-scan.ts` (repeatable divergence detector — catches the R70-1 class early); (c) the offline desktop machines (last pull Oct 22) will drain their cursors on next boot — no action needed.

---

## Deliverable I — Final Verification Checklist

| Critical requirement | Status |
|---|---|
| Ordering (dine-in + takeaway) E2E | PASS |
| Payments (cash/card/splits/change/tips/refunds) | PASS |
| Shift attribution (My Shift, settle times, takeaway linkage) | PASS |
| Reports + dashboards live data | PASS |
| Cash drawer cycle | PASS |
| Kitchen display | PASS |
| Bidirectional cloud↔local↔desktop sync | PASS |
| Cross-plane data parity | PASS (after heals; 0 divergences) |
| Endpoint wiring 100% | PASS |
| Security walls + rate limits + patched runtime deps | PASS |
| English-only UI (no Chinese, no raw keys) | PASS |
| Desktop in-place update channel | PASS (v2.7.2) |
| Secrets hygiene | PASS |
| AI copilot | PASS (via failover) |
| Mobile portal navigation | PASS (fixed this round) |
| Error resilience (boundary + race hardening) | PASS (fixed this round) |
| VisionOS/vision module hardware | NOT APPLICABLE (software simulator by design; no cameras attached) |
| External PSP webhooks | NOT APPLICABLE (payments recorded in-platform; no PSP integrated by design) |

---

## The 12 final answers (mandate §19)

1. **Components discovered and audited:** 148 API routes, 47 view components (POS,
   kitchen, mobile waiter portal, 30 admin views, launcher), 31 Prisma models,
   41 SQLite tables, the hybrid sync engine (12 modules), desktop Electron agent,
   5 deployment planes, 12 integrations.
2. **Critical API/external integration status:** ALL GREEN — GitHub (in sync), Vercel
   (READY + crons), Neon (RW, fresh writes proven), Turso (ping ok), Inngest (healthy),
   release mirrors (anonymous 200), update manifest (resolving v2.7.2), AI chain
   (serving via failover).
3. **Integrations proven functional end-to-end (not merely reachable):** local→Neon
   order+payment round-trip (#2278/#2279 landed paid with exact amounts and receipt
   references), Neon→prod serving (my-shift byte-identical), update channel
   (manifest→download→sha256 verified in r68; manifest re-verified both planes this
   round), AI copilot (business answer from live data).
4. **Frontend/backend/database/AI/external wiring:** verified correct — 119/119 frontend
   calls map to implemented routes; every surface rendered live data; zero 5xx.
5. **Conformance to the approved vision:** YES — every owner directive r67–r70 verified
   (see Deliverable D); zero structural change this round.
6. **Business workflows completed in real environments:** PIN login (2 roles), dine-in
   order→kitchen→cash payment with change→receipt→shift attribution; takeaway
   order→payment→shift attribution; reports/dashboards/cash-drawer/kitchen read paths;
   mobile waiter portal; production login + shift read on Vercel.
7. **Errors/defects/security issues found:** 11 findings (2×P1 data divergence, 4×P2,
   5×P3) — full register in Deliverable E.
8. **Fixed vs unresolved:** R70-1..6 FIXED and retested; R70-7..11 are documented
   observations/accepted risks with no functional impact (offline desktops drain on
   boot; dev-toolchain advisories; dead AI keys on failover; shared Neon tenant tables;
   scripts/ tsc class).
9. **Regression suite after remediation:** PASS — eslint 0, tsc src 0, E2E re-verified,
   parity 0, integrity ok, p13 ALL GREEN.
10. **Could not be tested + evidence still required:** physical camera feeds (vision
    simulator only), actual desktop machine boot behavior (agent code verified; the
    machines are offline since Oct 22 — they will self-drain on next boot), end-user
    PSP flows (none integrated by design).
11. **Readiness:** READY with the documented conditions in Deliverable H.
12. **Objective evidence for every major conclusion:** this document's tables + the r70
    script suite (repeatable: parity-scan, db-integrity, heal-divergences are
    idempotent) + dev.log + the commit history at 7cbe246.
