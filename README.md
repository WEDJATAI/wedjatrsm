# RSM — Restaurant Management Platform

A complete, offline-first restaurant management system — point of sale, kitchen display, inventory & purchasing, reports, attendance & payroll — that runs entirely on your own machine. Use it in the browser, or install the **Windows desktop app** (built by GitHub Actions, self-updating, no internet needed to operate the restaurant).

## Feature highlights

- **Point of sale** — floor plans with zones & tables, takeaway and delivery, courses, item modifiers & notes, quick price, move/split items between checks, promotions, refunds
- **Kitchen display (KDS)** — station routing, live tickets, prep/dispatch flow, printed kitchen tickets
- **Inventory & purchasing** — recipes, stock levels, purchase orders with partial receiving, stock counts, waste tracking, inventory valuation
- **Reports** — sales, Z-report, menu engineering, demand forecast, waste, payroll
- **People & shifts** — attendance clock-in/out, cash drawer sessions, per-person attribution (who issued each check, who moved each item)
- **Customers & loyalty** — profiles, loyalty points, reservations
- **Offline sync** — 18-table sync engine between instances (Sync Center), in-app backups with automatic snapshots
- **AI modules** — dashboard briefing, natural-language menu search, copilot, vision modules (cameras, zones, events, analytics)
- **Users & permissions** — roles with granular permissions, custom user types, full audit log
- **Bilingual** — complete English / Arabic UI with RTL support

## Demo accounts

The login screen offers one-click demo buttons; PINs work on their own (no email needed).

| Account | Email | Password | PIN |
| --- | --- | --- | --- |
| Admin | `admin@rms.com` | `admin123` | `123456` |
| Waiter | `waiter@rms.com` | `waiter123` | `111111` |
| Kitchen | `kitchen@rms.com` | `kitchen123` | `222222` |
| Demo User (self-registered) | — | — | `999999` |

**New staff?** Use the **register** link on the login screen — just a name and a 6-digit PIN, no email or password required.

## Tech stack

Next.js 16 (App Router, standalone output) · React 19 · TypeScript · Tailwind CSS + shadcn/ui · TanStack Query · Prisma + SQLite (single-file database) · JWT auth (jose) + bcryptjs · Electron + electron-updater (Windows desktop) — developer notes for the desktop packaging live in [`desktop/README.md`](desktop/README.md).

## Windows 10 download & auto-update

The whole platform ships as a native **Windows 10/11 64-bit** desktop app — no browser, no Node.js install, no internet required to run the restaurant.

1. Go to <https://github.com/WEDJATAI/wedjatrsm/releases/latest>
2. Download **`RSM-Restaurant-Platform-Setup-<version>.exe`** (a portable single-exe variant is published alongside it)
3. Windows SmartScreen may warn because the exe is unsigned — click **More info → Run anyway**
4. Installation is per-user (no administrator rights needed) and takes seconds

**Where your data lives:** everything is stored in one SQLite file under `%APPDATA%\rsm-desktop\data\`. Back it up by copying that folder, or use the in-app Settings → Backup.

**Automatic updates:** the app checks GitHub on every launch and every 30 minutes. Updates download silently in the background and install automatically the next time you close the app — your data is never touched. No action is ever required on the restaurant PC.

**How new versions are published:** maintainers push a `desktop-v*` git tag; GitHub Actions builds and publishes the release, and every installed app picks it up on its own.

## Cloud deployment (R23)

The platform runs in two modes from one codebase:

| | Local / desktop app | Cloud ([wedjatrsm.vercel.app](https://wedjatrsm.vercel.app)) |
|---|---|---|
| Hosting | sandbox / Electron app | **Vercel** (auto-deploys on every push to `main`) |
| Database | SQLite (`db/custom.db`) | **Neon PostgreSQL** (us-east-1, pooled connection) |
| Backups | in-app `VACUUM INTO` snapshots (10-min watcher) | Neon point-in-time restore + **Turso replica** (daily full refresh) |
| Scheduled jobs | — | **Inngest** functions + Vercel cron |

**How it works**

- `prisma/schema.prisma` (SQLite) serves local dev + the Windows app; `prisma/schema.postgres.prisma` is an identical-models PostgreSQL mirror used by the Vercel build (`buildCommand` regenerates the Prisma client from it) — pushed to Neon, data was migrated once with `bun scripts/migrate-neon.ts` (1,635 rows, all counts verified).
- Push to `main` → Vercel builds and deploys automatically; GitHub Actions separately builds the Windows release on `desktop-v*` tags.
- Scheduled jobs (all idempotent, safe to double-fire):
  - `rsm-turso-replica-sync` — daily 03:00/03:30 UTC (Vercel cron + Inngest) full replica refresh to Turso
  - `rsm-daily-digest` — daily 06:15/06:30 UTC sales digest written to the audit log
  - `rsm-stale-order-alert` — every 30 min (Inngest only) flags items stuck "preparing" > 45 min
- Manual triggers: `curl https://wedjatrsm.vercel.app/api/cron/turso-sync?key=$CRON_SECRET` (same for `/api/cron/daily-digest`).

**Ops notes**

- `JWT_SECRET` / `CRON_SECRET` are set as encrypted Vercel env vars; the Neon/Turso/Inngest vars are managed by their Vercel integrations.
- Turso replica requires a valid `TURSO_AUTH_TOKEN` (rotate with `turso db tokens create <db>` and update the Vercel env var if syncs report 401).
- Inngest needs `INNGEST_SIGNING_KEY`/`INNGEST_EVENT_KEY` (set by the Inngest Vercel integration); the serve endpoint is `/api/inngest`.
