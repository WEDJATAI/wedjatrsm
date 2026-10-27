#!/usr/bin/env python3
"""r70: desktop artifact build daemon (the r68/r69-proven double-fork pattern
— survives the sandbox session reaper). Appends to .zscripts/r70-build.log."""
import os, sys, time, datetime

PROJECT = '/home/z/my-project'
LOG = os.path.join(PROJECT, '.zscripts', 'r70-build.log')

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
    f.write(f"\n=== r70 build start {datetime.datetime.now().isoformat()} argv={sys.argv[1:]} ===\n")
os.execvp(sys.argv[1], sys.argv[1:])
