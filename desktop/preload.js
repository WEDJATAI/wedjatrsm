/**
 * RSM Restaurant Platform — preload (Task 22-c).
 *
 * Minimal, safe bridge: the ONLY thing exposed to the web app is a tiny
 * `window.rsmDesktop` marker so the platform UI can detect it is running
 * inside the desktop shell (e.g. to hide "download the desktop app" hints).
 * No Node APIs, no IPC, no privileged surface — contextIsolation stays on.
 */

'use strict'

const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('rsmDesktop', {
  /** Electron / Chrome / Node versions of the embedded runtime. */
  versions: process.versions,
  /** e.g. 'win32' — lets the UI adapt platform-specific hints. */
  platform: process.platform,
})
