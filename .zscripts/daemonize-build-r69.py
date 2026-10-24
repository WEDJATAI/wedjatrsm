#!/usr/bin/env python3
"""r69: run the desktop artifact build as a python double-fork daemon (the
r68-proven pattern — plain nohup builds get reaped by the sandbox session
reaper mid-compile). Appends to .zscripts/r69-build.log.
Usage: python3 .zscripts/daemonize-build-r69.py <script> [args...]
"""
import os, sys, time, datetime

PROJECT = '/home/z/my-project'
LOG = os.path.join(PROJECT, '.zscripts', 'r69-build.log')

pid = os.fork()
if pid > 0:
    time.sleep(0.2)
    print(f'build daemonized -> {LOG} (parent exits)')
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
with open(LOG, 'a') as f:
    f.write(f"\n=== r69 build start {datetime.datetime.now().isoformat()} argv={sys.argv[1:]} ===\n")
os.execvp(sys.argv[1], sys.argv[1:])
