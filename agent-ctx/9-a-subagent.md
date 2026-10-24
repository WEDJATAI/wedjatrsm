# Task 9-a — RSM AI Vision BACKEND (engine + /api/vision/**)

Agent: 9-a (subagent) — backend owner
Scope: `src/lib/vision.ts`, `src/app/api/vision/**`, one additive helper in `src/lib/orders.ts`
(`rehouseOpenOrder`), refactor of `src/app/api/orders/[id]/transfer/route.ts` to call it.
NOT touched: page.tsx, components, i18n, prisma/schema.prisma, types.ts/constants.ts/audit.ts
(all pre-done by the main agent; `src/components/vision/**` + i18n/dict/vision.ts belong to the
parallel frontend agent 9-b).

## What was built

**src/lib/vision.ts (2160 lines) — the whole engine:**
- Config in AppSetting KV (`visionConfig`): `getVisionConfig` (merge over
  VISION_DEFAULT_CONFIG + sanitize), `saveVisionConfig` (validates high/medium in (0,1],
  medium < high, integer timings ≥ 1 → ApiError 400, upsert, returns merged).
- Ingest key: `getOrCreateIngestKey` (`rms-vision-` + 32 hex, node crypto randomBytes),
  `rotateIngestKey`, `maskKey` (12 chars + …), `maskStreamUrl` (strips userinfo, truncates 80).
- `validateVisionEvent` — strict per-type validation (OCCUPANCY_CHANGED / MOVEMENT_DETECTED /
  CAMERA_STATUS, confidence rules, tolerant numeric id coercion, garbage rejected).
- `ingestVisionEvent(raw, source)` — NEVER throws for bad events; pipeline order:
  validate → duplicate (no row) → camera lookup (active, else `unknown_camera`) → stale
  (maxEventAgeSeconds) → per-type:
  - CAMERA_STATUS: camera {status, lastSeenAt (only if newer), lastError}; offline/error →
    every ACTIVE zone's table state → 'unknown' (peopleCount/confidence KEPT) — never 'empty'.
  - OCCUPANCY_CHANGED: zone resolve (must exist+active+on this camera → else `unknown_zone`),
    table resolve (table_id override must be active → else `rejected`; else zone.tableId; else
    `rejected` 'zone not mapped to a table'); upsert state row; out-of-order guard; manual hold
    (update lastEventAt only, outcome 'applied' + 'manual hold active — display state held');
    low confidence (< mediumConfidence → 'low_confidence', state unchanged); OCCUPIED applies
    (stateSince reset only on state change); EMPTY = vacancy debounce (pendingEmptySince,
    grace → 'vacancy grace — awaiting sustained absence', sustained → 'empty').
  - MOVEMENT_DETECTED: low conf → 'low_confidence'; both tables active else 'rejected';
    findOpenOrderOnTable(from) → orderId; dedupe merge into pending candidate (eventIds capped
    10, 'merged into candidate #ID'); cooldown after rejection ('cooldown_suppressed', no row);
    else create candidate (unique correlationKey `${from}:${to}:${order|none}:${ts}`, evidence
    JSON). ALWAYS persists the VisionEvent row (payload JSON, model, modelVersion).
- `ingestVisionEvents(body, source)` — single event OR `{events:[…]}` (≤ 100 else 400) →
  `{results}` in order; individual bad events = 'rejected' results.
- `resolveEffectiveVisionState` — read-time lazy vacancy resolution (occupied + pending elapsed
  → effective 'empty'); overview persists the transition.
- Movement decisions (HUMAN-confirmed only): `confirmMovement(user, id, mode, reason?)` —
  idempotent re-confirm when applied and order already on target; rejected/expired → 409;
  conflict → 409 'Conflicting state'; live re-validation: order open (else candidate→conflict +
  409 'Order is no longer open'), order on source (else conflict + 409), target active (400) /
  dirty (409 'Target table needs cleaning first') / other open order (409); THE ONLY vision
  write of `tables.status`: `db.$transaction(rehouseOpenOrder(tx, order, to))` + candidate
  confirmed/appliedAt; after tx vision states swap (from 'empty', to 'occupied', confidence 1,
  holds cleared). table_only (or orderId null) → NO POS/order writes, vision states only.
  `rejectMovement` (idempotent when rejected; confirmed+applied → 409 'use undo');
  `undoMovement` (re-validates order open + on target + source free + not dirty → rehouse back,
  candidate rejected `undo: …`, appliedAt null, vision swap back; table_only → states only).
- `overrideTableState(user, tableId, state, peopleCount?, reason?)` — upsert with confidence 1,
  stateSince now, manualHoldUntil = now + manualHoldMinutes; audit 'vision.override'.
- Serializers: serializeCamera (zoneCount via _count, floorPlanName, masked streamUrl),
  serializeZone (polygon parsed, cameraCode, tableName), serializeVisionEvent,
  serializeMovement(+WithOrder / MovementsWithOrders batch) with live currentState
  (from/to table status + order status + order.tableId), serializeTableState(WithConfig)
  via resolveEffectiveVisionState. All dates .toISOString().
- `buildVisionOverview` — active cameras (+zones/_count/floorPlan), zoneByTable (first active
  zone per table), floors via `serializeFloorPlans` (POS statuses + open order extras) with
  per-table {zoneId, zoneName, cameraCode, vision (default unknown), mismatch
  seated_no_order / left_check_open}; KPIs (totalGuests, occupiedTables, availableTables,
  posOccupied, pendingMovements, reviewRequired, coveredTables, occupancyPct round 1,
  avgDwellMinutes round 1 (null when none), camerasOnline/Total); alerts (no_order warning/
  critical at serviceDelay/2×, left_check_open info/warning, camera_offline warning /
  camera_error critical) sorted severity desc then since desc; config; updatedAt.
- `buildVisionAnalytics(from, to)` — occupancy periods from applied OCCUPANCY_CHANGED events
  per table (OCCUPIED opens, next EMPTY closes, unclosed ends at `to`); avgDwellMinutes,
  avgTurnoverMinutes, occupiedTableHours, totalGuestsObserved; occupancyByHour 0..23
  (overlap minutes, occupiedPct = 100 × overlap / (numDays × 60 × distinctTablesSeen),
  peopleCount-weighted avgGuests); movementStats (+confirmRate = confirmed/(confirmed+rejected));
  eventStats {total, applied, duplicates, stale, lowConfidence}; perTable top 10 by dwell;
  cameraUptime (onlinePct from CAMERA_STATUS events, lastSeenAt); revenuePerOccupiedTableHour
  (Σ paid orders closedAt in window / occupiedTableHours, round2, null when no hours).

**src/lib/orders.ts** — ONE additive export `rehouseOpenOrder(tx, order, targetTableId)` (the
transfer route's transaction body verbatim: primary moves, extras released, previous tables
freed when no other open order references them, target marked occupied). NOTHING else changed.

**src/app/api/orders/[id]/transfer/route.ts** — refactored to call `rehouseOpenOrder` inside its
existing transaction (guards/audit/response identical).

**Routes (14):**
- `cameras` GET/POST (code regex, unique 409, name 1..60, streamUrl must match
  VISION_STREAM_URL_RE and contain NO '@' → 400 credentials message, floorPlan active, status
  'offline', audit without URL; 201) · `cameras/[id]` PUT (partial; active=false → 'disabled',
  active=true → 'offline') / DELETE (zones>0 → 409 `Camera still has {n} zone(s)`)
- `zones` GET/POST (camera active, name, kind, tableId active, polygon 3..24 clamped 0..1,
  seats 0..20, createdBy) · `zones/[id]` PUT (optimistic `version` mismatch → 409, version++,
  updatedBy, unmapped table state → 'unknown') / DELETE (same reset)
- `overview` GET (perm 'vision')
- `movements` GET ?status= (default pending, 'all'; take 200; perms waiter/admin/pos/vision)
- `movements/[id]/confirm|reject|undo` POST (mode/reason validation; same perms; 409s pass
  through)
- `tables/[id]/override` POST (state occupied|empty, peopleCount 0..50, table 404)
- `events` GET ?limit=1..200 (perm 'vision', newest first) + POST = edge ingest (auth:
  session 'vision' OR Bearer/x-vision-key ingest key, else 401 'Unauthorized vision client';
  403 passes through for authed non-vision sessions; rate limit AFTER auth
  `vision-ingest:{key|ip}` 120/min → 429 + Retry-After; single event or {events} ≤ 100 else
  400; invalid JSON → 400 'Invalid JSON body'; response 200 {results})
- `analytics` GET ?from&to (YYYY-MM-DD, defaults 7d→today, from>to → 400)
- `config` GET (masked key + endpoint) / PUT (partial config + rotateIngestKey → FULL key,
  audits 'vision.configUpdate' changed keys + 'vision.ingestKeyRotate')
- `simulate` POST (perm 'vision') — edge SIMULATOR: setup_demo (idempotent CAM-001/CAM-002 +
  Z-{table} box polygon ±6pp clamped, seats=capacity, CAMERA_STATUS 'online' through the real
  pipeline), seat / vacate / walkby (conf 0.35) / move / camera_status / stale (30-min-old);
  all events 'sim-'+randomUUID, model rms-edge-sim 1.0; audit 'vision.simulate' per scenario.

## Verification (curl :3000, jars /tmp/v9a — full 20-item checklist, ALL PASS)

1. logins admin/waiter/kitchen → 200 ×3
2. cameras: `rtsp://user:pass@cam.local/stream` → 400 credentials message; CAM-T01 → 201;
   duplicate → 409; GET masked; PUT active=false → 'disabled', active=true → 'offline';
   DELETE → 200 {ok}
3. setup_demo → 2 cameras online + 6 zones (floor-1 tables 1/2/3 + Terrace P1-P3, polygons);
   repeat → '0 zone(s) created, 2 cameras ensured' (idempotent)
4. config vacancyDelaySeconds=1 → seat table 1 (4 people) → overview: occupied/peopleCount 4/
   KPIs (totalGuests 4, covered 3, occupancyPct 33.3, mismatch seated_no_order); vacate ×2
   (2s apart) → 'vacancy grace…' then 'empty'; restored 45
5. walkby → 'low_confidence' (state unchanged); stale (30-min-old) → 'stale'
6. config GET → key `rms-vision-1…`; PUT rotateIngestKey → full key; keyed POST → 'applied';
   SAME event_id → 'duplicate'; wrong key → 401; waiter session → 403; malformed JSON → 400;
   batch [valid, unknown-camera, invalid] → 200 + applied/unknown_camera/rejected; bonus
   101-event batch → 400
7. order #116 (waiter, table 2, guests 3, 1 item) → simulate move 2→1 → candidate #10
   (orderId 116, orderTotal, evidence eventIds); same move again → ONE pending, 2 eventIds
   ('merged into candidate #10'); reject → rejected; same move → 'cooldown_suppressed'
8. order #117 → candidate #11 → confirm (admin, table_and_order) → 200, order.tableId=1,
   floorplans 2 free / 1 occupied(+openOrderId), candidate confirmed+appliedAt, audit
   `AI movement 2 → 1 confirmed by Amina Hassan (mode table_and_order, 4 guests, 92% conf,
   order #117 moved)`; re-confirm → 200 idempotent
9. conflicts: cancel-then-confirm → 409 'Order is no longer open — movement needs review'
   (candidate → conflict 'order is no longer open'); manual transfer then confirm → 409
   'Order is no longer on the source table…'; target with another open order → 409 'Target
   table already has another open order'
10. table_only (no order) → confirm → vision states swapped (P2 empty / P3 occupied people 2
    conf 1), POS statuses UNCHANGED (both free)
11. undo #11 → 200: order back on table 2, candidate rejected 'undo: guests changed their
    mind', appliedAt null, vision swapped back, audit vision.movementUndo
12. override table 3 occupied 5 → manualHoldUntil set; vacate during hold → 'applied' +
    'manual hold active — display state held'; overview STILL occupied 5
13. CAM-001 offline → tables 1/2/3 vision 'unknown' (people 0/4/5 KEPT), POS floorplans
    byte-identical before/after; alert camera_offline/warning; error → camera_error/critical;
    back online → 2/2 cameras online
14. perms: waiter overview 403 / waiter movements 200 / kitchen simulate 403 / anon events
    POST 401 / anon cameras GET 401
15. 125 rapid keyed POSTs ({} bodies) → 120× 200 + 5× 429 + `Retry-After: 59`
16. analytics today → 18 guests observed, 0.3 occupied hours, 24 occupancyByHour entries
    (hour 23 = 6.6%), movementStats {15 total: 4 confirmed/7 rejected/0 pending/4 conflict/
    0 expired, confirmRate 0.36}, eventStats {69/58/0/2/2}, perTable top 3, cameraUptime
    (CAM-001 70%, CAM-002 100%); from>to → 400
17. transfer regression: order #122 table 1 → existing /api/orders/[id]/transfer → 200, order
    on table 2, table 1 free / table 2 occupied
18. events GET ?limit=5 → newest-first (detectedAt desc verified), limit=0 → 400
19. cleanup: my test orders 116-122 cancelled; 0 pending candidates (statuses 7 rejected /
    4 confirmed / 4 conflict); vision-occupied tables overridden to 'empty' (+ post-outage
    'unknown' Main-Hall tables recovered to human-confirmed 'empty' via the override API);
    config restored (vacancy 45, manualHold 10); ingest key rotated one final time; CAM-001/
    002 + zones + 71 events + decided candidates KEPT as demo data. Final floorplans:
    Main Hall [(1,'occupied' — order #123 by the CONCURRENT frontend agent, not a vision
    artifact), (2,'free'), (3,'free')], main []. NOTE: 9-b is live-testing in parallel (order
    #123 created mid-cleanup by admin through the UI) — left untouched on purpose; the vision
    layer honestly reports mismatch 'left_check_open' (info alert) for it.
20. `bunx tsc --noEmit` → 0 errors; `bun run lint` → 0 findings; dev.log → 0 × 500
    (vision routes: 246× events 200, 236× overview 200, 12× 429, plus 400/401/403/409/201 as
    expected)

## Deviations & notes

- Session continuation: an interrupted first run of this same task had already produced the
  files (no records left). I reviewed every file against the spec, fixed 2 deviations
  (below) and re-ran the ENTIRE checklist fresh.
- FIX 1: cameras PUT active=true now always sets status 'offline' (spec) — it previously
  kept 'disabled'.
- FIX 2: confirmMovement inactive TARGET table now 400 (spec "exists+active (404/400)") —
  was 409.
- After an undo, a fresh candidate for the same (from,to,orderId) is correctly
  cooldown-suppressed (undo leaves status 'rejected' + decidedAt=now) — spec-conformant;
  encountered during the 9a conflict test, worked around with a fresh order.
- `eventStats.duplicates` is structurally always 0: duplicate event_ids are never persisted
  as VisionEvent rows (spec: duplicate → return only, no row). The 'duplicate' outcome is
  verified in the ingest response.
- `/agent-ctx` at filesystem root is not writable (uid 1001); records live in
  `/home/z/my-project/agent-ctx/`.
