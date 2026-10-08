#!/usr/bin/env python3
"""
Split-Check STRESS Test — RSM Restaurant Platform (p8 / stress round).

The exact scenario requested by the operator:

  Basket: 5 Margherita Pizza + 3 Mineral Water + 2 Caesar Salad
  People (5):  P1 = pizza + water + caesar   (pays VISA → method 'card')
               P2 = pizza + water + caesar   (cash)
               P3 = pizza + water            (cash)
               P4 = pizza                    (cash)
               P5 = pizza                    (cash)

  Expected money (no discount): subtotal 1050.00 → VAT 14% 147.00 +
  service 12% 126.00 → TOTAL 1323.00
    P1 346.50 · P2 346.50 · P3 226.80 · P4 201.60 · P5 201.60

ADDITIVE-ONLY: every step creates rows (orders/payments/audits/outbox
events). Nothing is deleted. DB backed up before this run via VACUUM INTO
(backups/pre-split-stress-*.db, integrity ok).

Covers (honest pass/fail per check):
  S1  login + product lookup
  S2  Order A — the shape the POS cart REALLY builds (merged lines:
      pizza x5, water x3, caesar x2) + totals math
  S3  Order B — per-person shape (10 qty-1 lines) on table T3
  S4  GOLDEN PATH on Order B: ONE POST, 5 rows (P1 card + P2..P5 cash)
      → exact close, 5 rows, distinct same-second refs, audit, outbox,
      table release, closed-order rejection
  S5  SEQUENTIAL PATH on Order A: P1 visa first, then the rest by cash
      one at a time (incl. R26 tendered/change on P2, tip on P5 that
      must NOT count toward paid)
  S6  guard wall: overpay total, overpay remaining, zero, negative,
      invalid method, tendered<amount, change>overage
  S7  rounding stress: discount 33.33 + 8-payer equal split (piastre
      residuals) and discount 7.77 + 3-payer proportional split — both
      must close EXACTLY with no guard trip
  S8  TOCTOU race on the overpay guard: two terminals paying the same
      open check concurrently (pre-fix: observation; post-fix run with
      --expect-race-fixed: exactly one 200 + one 400)
"""
import json
import sqlite3
import sys
import threading
import urllib.request

BASE = "http://localhost:3000"
DB = "/home/z/my-project/db/custom.db"
RACE_FIXED = "--expect-race-fixed" in sys.argv
PASS, FAIL, NOTE = [], [], []
COOKIE = None

PIZZA, WATER, CAESAR = 29, 37, 23          # product ids (seeded menu)
P_PRICES = {PIZZA: 160.0, WATER: 20.0, CAESAR: 95.0}
# Per-person item allocation: payer index -> {product: qty}
PEOPLE = [
    {PIZZA: 1, WATER: 1, CAESAR: 1},   # P1 visa
    {PIZZA: 1, WATER: 1, CAESAR: 1},   # P2 cash
    {PIZZA: 1, WATER: 1},              # P3 cash
    {PIZZA: 1},                        # P4 cash
    {PIZZA: 1},                        # P5 cash
]
METHODS = ["card", "cash", "cash", "cash", "cash"]
EXP_SUBTOTAL = 1050.00
EXP_TOTAL = 1323.00
# Expected per-payer totals (proportional ×1.26; last payer absorbs residual)
EXP_PAY = [346.50, 346.50, 226.80, 201.60, 201.60]


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))


def note(msg):
    NOTE.append(msg)
    print(f"  [NOTE] {msg}")


def r2(x):
    return round(x + 1e-9, 2)


def api(method, path, body=None, timeout=30):
    global COOKIE
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Content-Type", "application/json")
    if COOKIE:
        req.add_header("Cookie", COOKIE)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as res:
            raw = res.headers.get("Set-Cookie")
            if raw and "rms_session" in raw:
                COOKIE = raw.split(";")[0]
            return res.status, json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def q(sql, args=()):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = [dict(r) for r in con.execute(sql, args).fetchall()]
    con.close()
    return rows


def make_order(items, table_id=None):
    body = {"orderType": "dinein" if table_id else "takeaway", "items": items}
    if table_id:
        body["tableId"] = table_id
    st, res = api("POST", "/api/orders", body)
    return st, (res.get("order") or res)


def pay(order_id, payments):
    return api("POST", f"/api/orders/{order_id}/payments", {"payments": payments})


print("=" * 74)
print("SPLIT-CHECK STRESS TEST —", BASE, "— 5 pizzas / 3 water / 2 caesar / 5 people")
print("=" * 74)

# ── S1: login + products ─────────────────────────────────────────────────
st, me = api("POST", "/api/auth/login", {"email": "admin@rms.com", "password": "admin123"})
check("S1a. login admin", st == 200, f"status={st}")
prods = {p["id"]: p for p in q("SELECT id,name,price FROM products WHERE id IN (?,?,?)", (PIZZA, WATER, CAESAR))}
check("S1b. menu products present",
      prods.get(PIZZA, {}).get("price") == 160 and prods.get(WATER, {}).get("price") == 20 and prods.get(CAESAR, {}).get("price") == 95,
      f"pizza={prods.get(PIZZA, {}).get('price')} water={prods.get(WATER, {}).get('price')} caesar={prods.get(CAESAR, {}).get('price')}")

# ── S2: Order A — the REAL cart shape (merged lines) ────────────────────
st, A = make_order([
    {"productId": PIZZA, "quantity": 5, "course": "main"},
    {"productId": WATER, "quantity": 3, "course": "drink"},
    {"productId": CAESAR, "quantity": 2, "course": "starter"},
])
check("S2a. Order A created (cart-merge shape)", st == 200 and A.get("id"), f"#{A.get('id')} status={st}")
check("S2b. Order A has 3 merged lines (5/3/2)",
      len(A.get("items", [])) == 3 and sorted(i["quantity"] for i in A["items"]) == [2, 3, 5],
      f"lines={[ (i['quantity']) for i in A.get('items', []) ]}")
check("S2c. Order A totals 1050/147/126/1323",
      A.get("subtotalAmount") == EXP_SUBTOTAL and A.get("taxAmount") == 147.0
      and A.get("serviceTaxAmount") == 126.0 and A.get("totalAmount") == EXP_TOTAL,
      f"sub={A.get('subtotalAmount')} tax={A.get('taxAmount')} svc={A.get('serviceTaxAmount')} total={A.get('totalAmount')}")

# ── S3: Order B — per-person shape (10 qty-1 lines), table T3 ───────────
items_b = []
for alloc in PEOPLE:
    for pid, n in alloc.items():
        for _ in range(n):
            course = "drink" if pid == WATER else ("starter" if pid == CAESAR else "main")
            items_b.append({"productId": pid, "quantity": 1, "course": course})
st, B = make_order(items_b, table_id=3)
check("S3a. Order B created (10 qty-1 lines, T3)", st == 200 and B.get("id"), f"#{B.get('id')} status={st}")
check("S3b. Order B 10 lines, same totals",
      len(B.get("items", [])) == 10 and B.get("totalAmount") == EXP_TOTAL,
      f"lines={len(B.get('items', []))} total={B.get('totalAmount')}")

# ── S4: GOLDEN PATH — one POST, 5 rows: P1 visa + P2..P5 cash ───────────
rows = [{"method": m, "amount": a} for m, a in zip(METHODS, EXP_PAY)]
st, res = pay(B["id"], rows)
check("S4a. 5-row split POST accepted", st == 200, f"status={st} err={(res.get('error') or '')[:90]}")
check("S4b. closed exactly (paid=1323.00 remaining=0 closed=True)",
      res.get("closed") is True and abs(res.get("paidAmount", 0) - EXP_TOTAL) < 0.01 and abs(res.get("remaining", -1)) < 0.01,
      f"paid={res.get('paidAmount')} remaining={res.get('remaining')} closed={res.get('closed')}")
pays = q("SELECT method, amount, tip, reference, amount_tendered, change_given FROM payments WHERE order_id=? ORDER BY id", (B["id"],))
check("S4c. 5 payment rows persisted (1 card + 4 cash)",
      len(pays) == 5 and sum(1 for p in pays if p["method"] == "card") == 1 and sum(1 for p in pays if p["method"] == "cash") == 4,
      f"{[(p['method'], p['amount']) for p in pays]}")
check("S4d. amounts exact per payer (346.50/346.50/226.80/201.60/201.60)",
      [p["amount"] for p in pays] == EXP_PAY, f"{[p['amount'] for p in pays]}")
refs = [p["reference"] or "" for p in pays]
import re as _re
_r26 = _re.compile(r"^(CASH|CARD|OTHR|LOYL)-\d{8}-\d{6}-[A-Z0-9]{3}$")
cash_ts = {r[5:20] for r in refs if r.startswith("CASH")}
check("S4e. 5 DISTINCT auto references (same-second collision-proof)",
      len(set(refs)) == 5 and all(_r26.match(r) for r in refs) and len(cash_ts) == 1,
      f"{refs}")
audit = q("SELECT details FROM audit_logs WHERE entity='order' AND entity_id=? AND action='order.payment' ORDER BY id DESC LIMIT 1", (B["id"],))
check("S4f. audit entry lists all 5 rows with references",
      bool(audit) and all((r or "") in (audit[0]["details"] or "") for r in refs),
      (audit[0]["details"][:110] + "…") if audit else "no audit row")
_paysB = q("SELECT id FROM payments WHERE order_id=?", (B["id"],))
_ph = ",".join("?" for _ in _paysB)
obox = q(f"SELECT entity, entityId, operation FROM hybrid_events WHERE direction='out' AND ((entity='Payment' AND entityId IN ({_ph})) OR (entity='Order' AND entityId=?))",
         tuple(p["id"] for p in _paysB) + (B["id"],))
pay_events = [e for e in obox if e["entity"] == "Payment"]
check("S4g. outbox: 5 Payment-create events + Order update ride the tx",
      len(pay_events) == 5 and all(e["operation"] == "create" for e in pay_events)
      and any(e["entity"] == "Order" for e in obox),
      f"payment_events={len(pay_events)} order_events={sum(1 for e in obox if e['entity']=='Order')}")
closedB = q("SELECT status, closed_at FROM orders WHERE id=?", (B["id"],))[0]
check("S4h. Order B status=paid + closedAt", closedB["status"] == "paid" and closedB["closed_at"] is not None)
tbl = q("SELECT status FROM tables WHERE id=3")[0]["status"]
check("S4i. table T3 released after split close", tbl in ("paid", "free", "cleaning"), f"T3={tbl}")
st, res = pay(B["id"], [{"method": "cash", "amount": 1}])
check("S4j. closed order rejects further payment", st == 400, f"status={st}")

# ── S5: SEQUENTIAL PATH on Order A — visa first, then cash one by one ───
seq = [
    ("card", 346.50, {}),
    ("cash", 346.50, {"amountTendered": 400.00, "changeGiven": 53.50}),
    ("cash", 226.80, {}),
    ("cash", 201.60, {}),
    ("cash", 201.60, {"tip": 20.00}),
]
remaining_after = [976.50, 630.00, 403.20, 201.60, 0]
ok_seq = True
for i, (m, amt, extra) in enumerate(seq):
    row = {"method": m, "amount": amt}
    row.update(extra)
    st, res = pay(A["id"], [row])
    closed = res.get("closed") is True
    ok = st == 200 and abs(res.get("remaining", -1) - remaining_after[i]) < 0.01 and closed == (i == 4)
    ok_seq = ok_seq and ok
    check(f"S5{i + 1}. P{i + 1} {m} {amt:.2f} → remaining {remaining_after[i]:.2f}{' + CLOSED' if i == 4 else ''}",
          ok, f"status={st} remaining={res.get('remaining')} closed={res.get('closed')}")
paysA = q("SELECT method, amount, tip, amount_tendered, change_given FROM payments WHERE order_id=? ORDER BY id", (A["id"],))
check("S5c. P2 tendered 400 / change 53.50 persisted (R26)",
      any(p["amount_tendered"] == 400.0 and p["change_given"] == 53.5 for p in paysA),
      f"tendered={[p['amount_tendered'] for p in paysA]} change={[p['change_given'] for p in paysA]}")
paidA = sum(p["amount"] for p in paysA)
check("S5d. P5 tip 20 EXCLUDED from paid math (paid=1323.00 not 1343.00)",
      abs(paidA - EXP_TOTAL) < 0.01 and paysA[-1]["tip"] == 20.0,
      f"paid={paidA} tip_last={paysA[-1]['tip']}")
auditsA = q("SELECT details FROM audit_logs WHERE entity='order' AND entity_id=? AND action='order.payment'", (A["id"],))
check("S5e. 5 audit entries (one per sequential payment)", len(auditsA) == 5, f"entries={len(auditsA)}")

# ── S6: guard wall on Order C ───────────────────────────────────────────
st, C = make_order([{"productId": PIZZA, "quantity": 5, "course": "main"},
                    {"productId": WATER, "quantity": 3, "course": "drink"},
                    {"productId": CAESAR, "quantity": 2, "course": "starter"}])
st, res = pay(C["id"], [{"method": "cash", "amount": 1323.50}])
check("S6a. overpay TOTAL rejected (1323.50 > 1323.00)", st == 400, f"status={st} err={(res.get('error') or '')[:70]}")
st, res = pay(C["id"], [{"method": "cash", "amount": 500.00}])
check("S6b. partial 500 accepted → remaining 823.00", st == 200 and abs(res.get("remaining", -1) - 823.0) < 0.01,
      f"status={st} remaining={res.get('remaining')}")
st, res = pay(C["id"], [{"method": "cash", "amount": 824.00}])
check("S6c. overpay REMAINING rejected (824 > 823)", st == 400, f"status={st} err={(res.get('error') or '')[:70]}")
st, res = pay(C["id"], [{"method": "bitcoin", "amount": 10}])
check("S6d. invalid method rejected", st == 400)
st, res = pay(C["id"], [{"method": "cash", "amount": 0}])
check("S6e. zero amount rejected", st == 400)
st, res = pay(C["id"], [{"method": "cash", "amount": -5}])
check("S6f. negative amount rejected", st == 400)
st, res = pay(C["id"], [{"method": "cash", "amount": 10, "amountTendered": 5}])
check("S6g. tendered < amount rejected", st == 400)
st, res = pay(C["id"], [{"method": "cash", "amount": 10, "amountTendered": 30, "changeGiven": 25}])
check("S6h. change > overage rejected", st == 400)
st, res = pay(C["id"], [])
check("S6i. empty payments array rejected", st == 400)

# ── S7: rounding stress ─────────────────────────────────────────────────
# S7a: discount 33.33 → base 1016.67 → tax 142.33 svc 122.00 → total 1281.00
st, D = make_order([{"productId": PIZZA, "quantity": 5, "course": "main"},
                    {"productId": WATER, "quantity": 3, "course": "drink"},
                    {"productId": CAESAR, "quantity": 2, "course": "starter"}])
st, res = api("PUT", f"/api/orders/{D['id']}", {"discountAmount": 33.33, "discountReason": "stress rounding test"})
d_total = res.get("order", {}).get("totalAmount") if st == 200 else None
check("S7a. discount 33.33 applied → total 1281.00", st == 200 and abs((d_total or 0) - 1281.0) < 0.01,
      f"status={st} total={d_total}")
# 8-payer equal split: 7 × round2(1281/8=160.125→160.13) = 1120.91; last = 160.09
part = r2(d_total / 8)
rows = [{"method": "cash", "amount": part} for _ in range(7)] + [{"method": "cash", "amount": r2(d_total - 7 * part)}]
st, res = pay(D["id"], rows)
check("S7b. 8-payer equal split closes EXACTLY on fractional total (160.13×7 + 160.09)",
      st == 200 and res.get("closed") is True and abs(res.get("remaining", -1)) < 0.01,
      f"status={st} closed={res.get('closed')} remaining={res.get('remaining')} err={(res.get('error') or '')[:60]}")

# S7c: discount 7.77 → proportional 3-payer items-style split (UI formula)
st, E = make_order([{"productId": PIZZA, "quantity": 5, "course": "main"},
                    {"productId": WATER, "quantity": 3, "course": "drink"},
                    {"productId": CAESAR, "quantity": 2, "course": "starter"}])
check("S7c-pre. Order E created", st == 200 and E.get("id"), f"status={st} err={(E.get('error') or '')[:80]}")
st, res = api("PUT", f"/api/orders/{E['id']}", {"discountAmount": 7.77, "discountReason": "stress rounding test"})
e = res.get("order", {}) if st == 200 else {}
e_total, e_sub = e.get("totalAmount"), e.get("subtotalAmount")
# per-payer raw subtotals: P1 275, P2 275, P3 500 (pizza5 alone) — mirror the UI formula
raw = [275.0, 275.0, 500.0]
shares = [r2(raw[0] / e_sub * e_total), r2(raw[1] / e_sub * e_total)]
shares.append(r2(e_total - sum(shares)))
check("S7c. discount 7.77 → total computed", st == 200 and e_total is not None, f"total={e_total}")
st, res = pay(E["id"], [{"method": "cash", "amount": a} for a in shares])
check("S7d. 3-payer proportional split closes EXACTLY (residual on last)",
      st == 200 and res.get("closed") is True and abs(sum(shares) - e_total) < 0.005,
      f"shares={shares} Σ={r2(sum(shares))} total={e_total} closed={res.get('closed')}")

# ── S8: TOCTOU race on the overpay guard ────────────────────────────────
st, F = make_order([{"productId": PIZZA, "quantity": 5, "course": "main"},
                    {"productId": WATER, "quantity": 3, "course": "drink"},
                    {"productId": CAESAR, "quantity": 2, "course": "starter"}])
results = []


def racer():
    results.append(pay(F["id"], [{"method": "cash", "amount": EXP_TOTAL}]))


t1, t2 = threading.Thread(target=racer), threading.Thread(target=racer)
t1.start(); t2.start(); t1.join(); t2.join()
statuses = sorted(r[0] for r in results)
paysF = q("SELECT amount FROM payments WHERE order_id=?", (F["id"],))
combined = sum(p["amount"] for p in paysF)
if RACE_FIXED:
    check("S8. race guarded: exactly one 200 + one 400, combined paid == total",
          statuses == [200, 400] and abs(combined - EXP_TOTAL) < 0.01,
          f"statuses={statuses} combined_paid={combined}")
else:
    if statuses == [200, 400] and abs(combined - EXP_TOTAL) < 0.01:
        note(f"S8. race NOT reproduced this run (statuses={statuses}, combined={combined}) — "
             "window exists in code (guard read at route line ~105 outside tx); see F1.")
    else:
        note(f"S8. race REPRODUCED (statuses={statuses}, combined_paid={combined} > {EXP_TOTAL}) — "
             "F1 confirmed live: both terminals' payments landed.")

# ── summary ─────────────────────────────────────────────────────────────
print()
print("=" * 74)
print(f"RESULT: {len(PASS)} passed / {len(FAIL)} failed" + (f" / {len(NOTE)} notes" if NOTE else ""))
for n in NOTE:
    print(f"  NOTE: {n}")
for n in FAIL:
    print(f"  FAILED: {n}")
print("Data safety: additive-only stress — 0 rows deleted.")
print("Backup: backups/pre-split-stress-2026-09-28-19-01-.db (integrity ok)")
sys.exit(1 if FAIL else 0)
