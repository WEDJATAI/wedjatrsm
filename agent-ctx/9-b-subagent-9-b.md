# Task 9-b — AI frontend (briefing card, copilot chat, POS semantic search)

Agent: subagent 9-b (Z.ai Code) · see the full entry at the END of /home/z/my-project/worklog.md (Task ID: 9-b).

## Files
- NEW  src/components/admin/ai-briefing-card.tsx — dashboard hero card (useQuery ['ai-briefing', tick] → GET /api/ai/briefing[?refresh=1], staleTime 5 min; gradient amber header, provider pill via exported aiProviderLabel, cached chip, 4 stat strip, bullet+Recommendation rendering, skeleton/503 states).
- NEW  src/components/admin/ai-copilot-sheet.tsx — {open,onOpenChange} chat Sheet (bottom mobile / right ≥768 via useIsMobile); useMutation POST /api/ai/copilot with last 10 messages; suggestion chips, amber user bubbles, thinking dots, error toast + inline retry.
- EDIT src/components/admin/dashboard-view.tsx — session ['session'] query → isAdmin role gate; "Ask AI Copilot" header button; briefing card above the KPI grid; copilot sheet mounted.
- EDIT src/components/pos/product-grid.tsx — Sparkles AI toggle in the search bar (size-11, aria-pressed); event-driven 400ms debounce (setTimeout ref in onChange, no setState in effects); useQuery ['ai-menu-search', q] enabled q≥2, apiFetch POST /api/ai/menu-search, keepPreviousData; filtered memo maps productId→Product in rank order; "AI · n%" amber tile badge; AI mode hides category/favorites pills; states: hint (<2 chars) / skeleton first load / pos.aiNoResults / toast on error; OFF = byte-identical old behavior.
- EDIT src/lib/i18n/dict/admin.ts + dict/pos.ts — ai.* (23 keys) and pos.ai* (6 keys), EN + AR appended at object tails.

## Verification
- tsc --noEmit: 0 errors in my files (3 pre-existing orders.ts errors are R9's, untouched). bun run lint: 0 findings. dev.log clean.
- Browser E2E as admin: briefing card w/ real numbers (EGP316.26/4/EGP158.13/EGP78.61 + Recommendation), refresh + reload→cached chip 'مخزَّن مؤقتاً', copilot multi-turn replies (best sellers, 2/6 tables), POS "something sweet"→8 AI-badged tiles (Basbousa 69%), Arabic "بسبوسة"→Basbousa, "حلو"→no-results, toggle off→"kosh" substring works, full AR/RTL pass. Screenshots: screenshots/9b-*.png.
