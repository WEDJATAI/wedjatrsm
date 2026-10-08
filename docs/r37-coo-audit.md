# R37 — COO/CTO/CFO + Restaurant-System Audit Report

**Date:** 2026-10-04 · **Round:** r37 · **Auditor:** main agent (5-role mandate)
**Scope:** full platform — every API route, every view, every tab, every action; backup + harden + end-to-end wiring/API/mapping + full stress testing.
**Method:** zero-trust re-verification (nothing taken on faith from prior rounds), research subagents for exhaustive mapping, live HTTP stress suites, browser E2E with screenshots, production deploy verification.

---

## 1. Executive summary

| Dimension | Verdict |
|---|---|
| Wiring (frontend ↔ API) | **116/116 references resolve — 0 broken** across 134 routes / 184 handlers |
| Security guards | **0 unguarded mutations**; layered session → permission → device-key → HMAC → SDK-sig |
| Money integrity | exact (14% VAT + 12% service, r31-verified; re-confirmed zero zombies post-storm) |
| Write path under load | **FIXED THIS ROUND**: was collapsed (p50 26.5s, 93% cancel failures) → now **34 writes/sec sustained, 0 errors** |
| Data safety | **NOTHING LOST** — every baseline count identical; 965 stress orders = documented, cancelled, synced |
| i18n (EN/AR) | 2,312/2,324 → **2,336/2,336** after fixes (12 real gaps + 12 future-proofed) |
| Browser E2E | 11 screenshots; zero console errors, zero failed API calls, footer + mobile verified |
| Production | deployed READY; CRON doors now enforced (were open locally); 5 clouds connected |

**The one CRITICAL issue found** was not a feature bug but a recurring **environment regression** — details in §3.

---

## 2. Backup & anti-rollback (executed BEFORE any change)

1. DB snapshot → `backups/custom-manual-20261004-061649.db`
2. Full git bundle (complete history, single-file restore) → `backups/repo-snapshot-20261004-061649.bundle` (166 MB)
3. Env vault copies → `backups/r37-env-20261004/` (.env + deploy-creds)
4. Anti-rollback branch `backup/r37-pre-audit` pushed to GitHub + closeout commits `40193ef → 69b9a4b → b7dd08b`

---

## 3. CRITICAL finding — write-path collapse (found, root-caused, FIXED, proven)

**Symptom:** first stress run: order-create p50 **26.5 seconds**, 11/13 cancels 500 (P1008 transaction timeouts). Reads fine.

**Root cause:** the r31 fix (`?socket_timeout=30000&connection_limit=1` on DATABASE_URL) had regressed — **third occurrence** (r31 fixed it, r33 restored it, r37 found it gone). The platform shell exports a param-less `DATABASE_URL` that silently beats `.env`, and `.env` itself had been rewritten param-less. Without the params, SQLite write-convoy deadlock returns (the exact r31-documented circular wait between the write lock and the hybrid engine).

**Fix (two layers):**
1. Params restored to `.env` (matches the vault, which still had them).
2. **Code-level self-heal in `src/lib/db.ts`** — if `DATABASE_URL` is ever param-less `file:` again, the client appends the r31 params itself before the first connection. The regression can never silently return.

**Proof after fix:** 12,383 requests / **0 errors**; write path 937 creates + 937 cancels at **34 req/sec sustained** (create p50 345 ms under mixed load, p99 1.68 s); reads p95 203 ms under write load. All 937 test orders cancelled cleanly, zero zombies, baseline counts exact.

---

## 4. Hardening shipped this round

| # | Item | Where |
|---|---|---|
| 1 | CRON_SECRET generated; cron doors 401 without it (were open locally) | `.env` + vault + Vercel project env (encrypted, prod+preview) — **enforced live in production** |
| 2 | Role-gate unions: dashboard-perm roles reach sales/forecast/low-stock/AI-briefing; products-perm roles reach modifier writes | 6 route guards fixed (was 403 walls for custom roles) |
| 3 | DB URL param self-heal | `src/lib/db.ts` (see §3) |
| 4 | Mobile More-sheet +4 views (purchases, stock counts, promotions, payroll) | `mobile-shell.tsx` — now mirrors desktop navbar exactly (22 admin views) |
| 5 | 3 stale-cache mutations (bundle import, hybrid sync-now, reconcile) now invalidate ALL queries | `sync-card.tsx`, `hybrid-sync-card.tsx` |
| 6 | users-view duplicate `['me']` query → shared `['session']` key | `users-view.tsx` |
| 7 | 24 i18n keys added EN+AR: 8 permission descriptions (roles editor), `nav.audit`, `status.order.revoked`, 2 PIN-pad aria labels, 12 QuickCheckinSheet keys | `dict/admin.ts`, `common.ts`, `pos.ts` |
| 8 | KDS item-advance button 36px → **44px** touch target | `kitchen-order-card.tsx` |

---

## 5. Stress-test evidence

**Gates audit (35/35 PASS)** — `scripts/r37/gates-audit.ts`:
- r37 gate fixes verified with real custom role (مينا): briefing/sales/forecast/low-stock 200, modifier POST passes gate (400 validation), waiter still 403, unauth 401
- CRON: no-secret 401 / correct secret 200 / wrong secret 401 / query-param path 200
- Downloads (Windows + macOS): unauth 401, wrong password 403 (600 ms penalty), correct password grants signed URL, tokenless GET 401, **cross-platform token rejected** (purpose-scoped)
- Rate limits: same-identifier brute force → 429 at attempt #11 exactly
- Robustness: 404s/400s/malformed JSON/SQLi-shaped inputs — never a 500

**Load suite (12,383 reqs / 0 errors):**

| Phase | Result |
|---|---|
| Read-heavy 60s | 6,712 reqs @ 111.8 rps, p99 380 ms |
| Write-path 45s | 937 create + 937 cancel @ 34 rps, p99 789 ms |
| Burst 10s | 981 reqs @ 96.2 rps, 0 errors |
| Reports 15s | 1,278 reqs @ 85 rps |
| KDS+POS mixed 30s | 1,840 reqs @ 61.1 rps; reads p95 203 ms under write load |

**Post-storm integrity:** outbox burst of 3,544 events drained to Neon (2 transient failures auto-retried OK) → 0 pending / 0 failed / cloud reachable.

**Browser E2E:** team wall → manager door → launcher (Windows + macOS download buttons live) → macOS gate wrong/correct password → POS floor (live table states) → 8 admin views with live data → mobile 390 px More-sheet complete → footer sticky/push correct. Zero console errors.

---

## 6. Honest findings register

**Fixed this round:** everything in §3 + §4.

**Documented, intentionally not "fixed" (no-deletion policy / owner decisions):**
1. **Super-admin PIN still default 123456** — the "Change my PIN" prompt appears every session *by design* until the owner sets his own. The public manager-login GET discloses name + `usingDefaultPin:true` (kiosk UX). **Owner action: set your PIN** (Settings → Change my PIN).
2. **Enroll key 180787 is baked into the public GitHub mirror binaries** — anyone extracting it can self-enroll a hybrid device. Mitigations: rate limits, audit trail, admin-revocable devices. Trade-off accepted in r32–r36 (password gate is for download UX, not a security boundary).
3. **Revoke authority = any staff PIN** (waiter can revoke their own paid check) — documented design, dual-attributed in audit log.
4. **6 dead endpoints** (orders/[id]/close, tables/status, ai/menu-search, ai/status, categories/reorder, products/reorder) — superseded or never wired; left intact per no-deletion policy.
5. **agent-desktop/dist wiped** (gitignored) → downloads 302 to the GitHub mirror — functional, documented (r34 design).
6. **QuickCheckinSheet is orphaned** (unwired component) — NOT deleted; its 12 i18n keys were added so it is safe to mount anytime.
7. **898 hybrid conflicts on record** — all carry resolutions (864 rejected / 21 remote-wins / 13 local-wins); they are the historical audit trail, not open conflicts.
8. **Turso replica lags between daily 03:00 refreshes** — documented (r36); hub (Neon) is always current.

---

## 7. Recommendations (ranked)

1. **Owner: set your own manager PIN** — the single highest-value 30-second action; eliminates the default-credential note entirely.
2. **Rotate the download/enroll key per release** (or add a first-run app token) if the mirror distribution ever needs to be a true security boundary; today's rate-limit + revocation posture is reasonable for a restaurant.
3. **Adopt stress-as-release-gate** (already scripted: `scripts/r37/gates-audit.ts` + `scripts/r31-stress.ts`) — run both before any deploy that touches `lib/db.ts`, orders, or the hybrid engine.
4. **Consider wiring drag-reorder → the existing batch reorder endpoints** (categories/products) to retire two of the six dead endpoints with zero new API surface.
5. **Optional notarization** for the macOS agent (needs an Apple Developer account) to remove the one-time Gatekeeper bypass step.

---

*Evidence: screenshots/r37/*.png (11), agent-ctx/r37-gates-results.json, /tmp/r31-stress-results.json, worklog.md r37 entry.*
