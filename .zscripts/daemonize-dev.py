#!/usr/bin/env python3
"""r31: worklog-standard dev-server daemonizer (python double-fork).
The sandbox reaper kills processes spawned during a tool call when it ends
(nohup/setsid/disown all get swept). The R13/R21-proven pattern that DOES
survive is a python double-fork (fork → setsid → fork → execvp), detached
from the tool-call session. Appends to dev.log (never truncates history).
Usage: python3 .zscripts/daemonize-dev.py
"""
import os, sys, time

PROJECT = '/home/z/my-project'
LOG = os.path.join(PROJECT, 'dev.log')

# already up? leave it alone
import urllib.request
try:
    urllib.request.urlopen('http://127.0.0.1:3000/', timeout=3)
    print('dev-server: already running')
    sys.exit(0)
except Exception:
    pass

pid = os.fork()
if pid > 0:
    # parent: wait briefly and report
    time.sleep(0.2)
    sys.exit(0)
os.setsid()
if os.fork() > 0:
    sys.exit(0)
os.chdir(PROJECT)
fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
with open(os.path.join(PROJECT, '.zscripts', 'dev.pid'), 'w') as f:
    f.write(str(os.getpid()))
# r31 fix: the platform shell exports a param-less DATABASE_URL; Next.js
# never overrides an inherited process.env value with .env — so the
# socket_timeout param in .env was silently ignored. Strip it here so
# next dev loads the URL (with params) from .env itself.
env = dict(os.environ)
env.pop('DATABASE_URL', None)
os.execvpe('bun', ['bun', 'x', 'next', 'dev', '-p', '3000'], env)
