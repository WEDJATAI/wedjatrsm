#!/bin/bash
# R21: idempotent dev-server restarter.
#
# WHY THIS EXISTS: this sandbox kills every process spawned during a tool
# call when that call ends (verified 2026-09-17: nohup + setsid + disown +
# listening sockets all get swept within ~60s). Platform-boot processes
# survive; tool-call spawns do not. Until a platform-side keepalive exists
# (cron job / user restart), this script is sourced at the start of every
# work call to bring the dev server back within seconds.
#
# Usage: bash .zscripts/ensure-dev.sh
# Exit:  0 = server up (already running or restarted), 1 = failed

if curl -s -o /dev/null -m 3 http://localhost:3000/; then
  exit 0
fi

cd /home/z/my-project || exit 1
setsid nohup bash -c 'exec bun run dev' < /dev/null > /tmp/dev-restart.log 2>&1 &
disown

for i in $(seq 1 40); do
  if curl -s -o /dev/null -m 5 http://localhost:3000/; then
    echo "dev-server: restarted (attempt ${i})"
    exit 0
  fi
  sleep 2
done
echo "dev-server: FAILED to restart — check /tmp/dev-restart.log" >&2
exit 1
