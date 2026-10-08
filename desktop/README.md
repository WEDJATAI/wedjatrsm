# RSM Desktop — Electron shell (developer notes)

Windows 10/11 (x64) packaging of the RSM Restaurant Platform. For the
user-facing download & update instructions see the **repo root README**.

## Structure

```
desktop/
├── main.js             Electron main process (see below)
├── preload.js          exposes window.rsmDesktop { versions, platform } — nothing else
├── prepare-server.mjs  assembles desktop/server from the Next standalone build
├── package.json        electron-builder config (NSIS + portable, GitHub publish)
├── resources/
│   ├── icon.png        app icon (buildResources dir, committed)
│   └── seed.db         CI-GENERATED from download/rsm-platform-database.db — never committed
├── server/             CI-GENERATED Next.js standalone tree (prepare-server.mjs) — never committed
├── dist/               electron-builder output (installers) — never committed
└── node_modules/       desktop toolchain (electron, electron-builder) — never committed
```

`main.js` in one paragraph: single-instance lock → per-user data dir
(`%APPDATA%/rsm-desktop/data`, seeded on first run from the packaged
`seed.db`) → per-installation JWT secret (persisted, 64 hex chars, so
sessions survive restarts) → free-port search (4312, 4313..4321, then OS
pick) → spawn the bundled Next standalone server with
`ELECTRON_RUN_AS_NODE=1` (the Electron binary doubles as Node — no separate
Node runtime is shipped; `asar: false` so `server/server.js` and the Prisma
native engine are real files on disk) → poll `http://127.0.0.1:<port>/`
until it answers (max 60 s) → open the 1280×800 window → start
auto-update checks.

## How CI builds it

`.github/workflows/desktop-release.yml` — triggered by a `desktop-v*` tag
push (or manual `workflow_dispatch`). On `windows-latest`:

1. `bun install --frozen-lockfile` (root dependencies)
2. `bunx prisma generate` (regenerates the client with Windows engine paths)
3. seed DB staged to `db/custom.db` (in case build-time code paths touch it)
4. `bunx next build` (standalone output — NOT `bun run build`, whose script
   uses POSIX `cp`)
5. `node desktop/prepare-server.mjs` (standalone + static + public + Prisma
   safety net → `desktop/server`)
6. fresh seed DB staged to `desktop/resources/seed.db`
7. `npm install` in `desktop/` (Electron toolchain)
8. `npx electron-builder --win nsis portable --publish always`
   (`GH_TOKEN` = the per-run `GITHUB_TOKEN`, `CSC_IDENTITY_AUTO_DISCOVERY=false`
   because the exe is unsigned)

Artifacts published to the release:
- `RSM-Restaurant-Platform-Setup-<version>.exe` — NSIS installer
  (one-click, per-user, no admin) → **this is the auto-updatable channel**
- `RSM-Restaurant-Platform-Portable-<version>.exe` — portable single exe
- `latest.yml` — the electron-updater feed (consumed by installed apps)

## Cutting a new version

1. Bump `"version"` in `desktop/package.json` (e.g. `1.0.0` → `1.0.1`).
2. Commit & push that change.
3. Tag it and push the tag: `git tag desktop-v1.0.1 && git push origin desktop-v1.0.1`.
4. CI builds and publishes the release. **Installed apps pick it up
   automatically** — electron-updater checks GitHub on every launch and
   every 30 minutes, downloads in the background, and installs on the next
   app quit (`autoInstallOnAppQuit`; `quitAndInstall` is deliberately never
   called so a shift is never interrupted).

Keep the tag suffix in sync with the version — electron-builder versions
the artifacts/`latest.yml` from `desktop/package.json` and attaches the
release to the pushed tag.

## Local testing (on the dev machine)

```bash
bunx prisma generate
bunx next build
node desktop/prepare-server.mjs
cp download/rsm-platform-database.db desktop/resources/seed.db
cd desktop && npm install && npm start
```

The app runs exactly like the packaged build except auto-update is disabled
in dev (`app.isPackaged` is false). Remember that `desktop/server/`,
`desktop/resources/seed.db` and `desktop/node_modules/` are gitignored —
regenerate them after each `next build`.
