# Task 17-d — Payroll-lite + Sales Forecast (subagent 17-d)

## Status: COMPLETE (verified end-to-end)

## Files owned / final
- `src/app/api/reports/payroll/route.ts` — from partial 17-d incarnation, line-by-line reviewed vs contract: compliant, kept as-is.
- `src/app/api/reports/forecast/route.ts` — same: reviewed, compliant, kept.
- `src/components/admin/payroll-view.tsx` — reviewed + 2 fixes: (1) invalid-rate toast now uses a bilingual component-local literal (`rateInvalidMsg`) instead of echoing the field label; (2) `lang` destructured from useI18n.
- `src/components/admin/dashboard-view.tsx` — surgical ForecastCard insert reviewed + 1 fix: mini 7-bar chart now renders on a fixed `h-16` (64px) track with heights scaled to ≤64px (previous draft scaled to 100px inside a ~62px flex area → tallest bar overflowed into the value label; DOM-verified after fix: max bar = 64px, parent = 64px, overflow=false on all 7).
- `src/app/api/users/route.ts` + `[id]/route.ts` — hourlyRate pass-through was already in place from the partial incarnation; reviewed (number ≥ 0 / null / '' clear, 400 otherwise; surfaced in list + PUT serializer; `payroll.rateUpdate` audit on change with old→new) and re-verified live.
- `scripts/r17d-attendance-demo.ts` — NEW one-off demo seed (documented below).

## Verified numbers (2026-09-17, server TZ = UTC)
- Users rates: admin 85, waiter 60, kitchen null (70→null clear path tested).
- Attendance (all 3 sessions CREATED via real API check-in/check-out, timestamps adjusted by the seed script to realistic shifts since the API can only stamp `now`):
  - #8 waiter Sep 15 09:22→17:05 = 7.7167h late 7
  - #9 admin Sep 16 08:55→14:30 = 5.5833h late 0
  - #10 waiter Sep 17 09:05→13:42:56 late 0
- Payroll 2026-09: waiter 12.35h × 60 = 741.00 (2 sessions, 7 late); admin 5.58h × 85 = 474.30; totals 17.93h / 1215.30; sorted grossPay desc; open-session accrual (up to `now`) verified live before checkout; August = empty state; ?month=banana → 400.
- Forecast: 28 history days (Aug 20→Sep 16, today excluded; 9 days with data, 19 zero-filled), 7 projections (Sep 17→23): Mon avg(8038.50, 630.00)=4334.25, Tue avg(3528.30, 186.48)=1857.39, single-data weekdays pass through; avgDaily = 30032.76/9 = 3336.97; projectedWeekTotal = 23841.12 = Σ projections (verified in-script).
- Auth matrix: no token 401 / waiter 403 / admin 200 on BOTH routes.
- UI (agent-browser): dashboard forecast card (title/ar title literals, avg, week total, 7 bars, aria-label, 64px track), payroll table + KPIs + totals + inline rate edit 60→65→60 with toasts + live gross recompute (802.75 / 1277.05 while at 65), Last-month empty state + hint, 390px mobile zero overflow, Arabic RTL fully translated zero overflow, zero console/page errors.
- Quality gates: lint 0 findings, tsc 0 src errors, dev.log zero 5xx on my routes.

## Incident (platform, not mine)
Dev server died ~13:46 (mid-verification; no next/bun process, port closed) and self-recovered via the sandbox supervisor ("✓ Ready in 795ms") within ~2 min. I did NOT restart it manually. All routes re-verified 200 post-recovery with identical data.

## Do NOT touch (17-c parallel)
promotions API/lib/view, POS cart components.
