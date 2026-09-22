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
