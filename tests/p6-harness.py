#!/usr/bin/env python3
"""P6 test harness — helpers for hybrid failure-scenario testing.

Usage: python3 tests/p6-harness.py <command> [args]
Commands:
  target <url|''>     set local sync.targetUrl (direct sqlite)
  outbox              snapshot of local outbox (out events)
  conflicts           local hybrid_conflicts rows
  state               local HybridSyncState (cloud flags, cursor)
  peer-counts         business row counts on the peer (3100)
  local-counts        business row counts on the local dev DB
  inject-dup <entity> <entityId> <op>  duplicate a synthetic pending out event
"""
import sqlite3
import sys
import uuid
import secrets
from datetime import datetime

LOCAL = '/home/z/my-project/db/custom.db'
PEER = '/home/z/rsm-peer/desktop/server/db/custom.db'


def q(db, sql, args=()):
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(sql, args).fetchall()
    con.close()
    return rows


def rw(db, sql, args=()):
    con = sqlite3.connect(db)
    con.execute(sql, args)
    con.commit()
    con.close()


def cmd_target(url):
    rw(LOCAL, "UPDATE app_settings SET value=? WHERE key='sync.targetUrl'", (url,))
    row = q(LOCAL, "SELECT value FROM app_settings WHERE key='sync.targetUrl'")
    print('targetUrl =', repr(row[0]['value']))


def cmd_outbox():
    rows = q(LOCAL, "SELECT id, entity, entityId, operation, status, attempts, lastError, nextAttemptAt, substr(payload,1,40) AS p FROM hybrid_events WHERE direction='out' ORDER BY id DESC LIMIT 15")
    if not rows:
        print('outbox: EMPTY')
        return
    for r in rows:
        nxt = r['nextAttemptAt'] or '-'
        err = r['lastError'] or '-'
        print(f"#{r['id']} {r['entity']}/{r['entityId']} {r['operation']} {r['status']} att={r['attempts']} next={nxt} err={err}")


def cmd_conflicts():
    rows = q(LOCAL, "SELECT id, entity, entityId, reason, resolution, substr(detail,1,60) AS d, createdAt FROM hybrid_conflicts ORDER BY id DESC LIMIT 10")
    if not rows:
        print('conflicts: EMPTY')
        return
    for r in rows:
        print(f"#{r['id']} {r['entity']}/{r['entityId']} reason={r['reason']} resolution={r['resolution']} detail={r['d']}")


def cmd_state():
    rows = q(LOCAL, "SELECT key, value FROM hybrid_sync_state ORDER BY key")
    for r in rows:
        v = r['value']
        if 'deviceKey' in r['key']:
            v = v[:8] + '…REDACTED'
        print(f"{r['key']} = {v}")


def counts(db, label):
    tables = ['customers', 'orders', 'order_items', 'payments', 'attendance', 'hybrid_events', 'hybrid_conflicts']
    out = []
    for t in tables:
        try:
            n = q(db, f'SELECT COUNT(*) AS n FROM {t}')[0]['n']
            out.append(f'{t}={n}')
        except Exception:
            out.append(f'{t}=ERR')
    print(f'{label}: ' + ' '.join(out))


def cmd_inject_dup(entity, entity_id, op):
    """Inject a synthetic pending out event duplicating an existing business row —
    simulates a buggy/duplicated sender pushing a create for a row the cloud
    already has (append-only duplicate) or an older revision (stale)."""
    eid = str(uuid.uuid4())
    now = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')
    payload = '{"__p6":"synthetic-duplicate"}'
    rw(LOCAL,
       "INSERT INTO hybrid_events (eventId, deviceId, entity, entityId, operation, revision, payloadHash, payload, direction, status, attempts, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,'out','pending',0,?,?)",
       (eid, '413e1476-32e6-449b-bfb7-8c8d6068fc57', entity, int(entity_id), op, 1, 'p6-synth', payload, now, now))
    print(f'injected out event {eid}: {entity}/{entity_id} {op} (pending)')


CMDS = {
    'target': lambda a: cmd_target(a[0]),
    'outbox': lambda a: cmd_outbox(),
    'conflicts': lambda a: cmd_conflicts(),
    'state': lambda a: cmd_state(),
    'peer-counts': lambda a: counts(PEER, 'PEER'),
    'local-counts': lambda a: counts(LOCAL, 'LOCAL'),
    'inject-dup': lambda a: cmd_inject_dup(a[0], a[1], a[2]),
}

if __name__ == '__main__':
    if len(sys.argv) < 2 or sys.argv[1] not in CMDS:
        print(__doc__)
        sys.exit(1)
    CMDS[sys.argv[1]](sys.argv[2:])
