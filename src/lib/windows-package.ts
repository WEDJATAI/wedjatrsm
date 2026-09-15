/**
 * R15 Windows package builder — streams a ready-to-run ZIP of the whole
 * platform for offline-first deployment on a restaurant PC.
 *
 * The package contains the complete app (src/, prisma/, public/, configs),
 * a patched package.json (Windows-safe dev/start scripts — no unix pipes),
 * a fresh .env pointing at the bundled db\custom.db via a schema-relative
 * `file:../db/custom.db` URL, a db/ folder holding either:
 *  - live: a consistent VACUUM INTO snapshot of the CURRENT database, or
 *  - demo: a freshly generated + seeded database (prisma db push + seed),
 * plus windows\install.bat / start.bat / stop.bat (CRLF) and a bilingual
 * README-WINDOWS.md. Dependencies are installed on the target PC by
 * install.bat (Bun or npm) — node_modules is never shipped.
 */
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { PrismaClient } from '@prisma/client'

import { db } from '@/lib/db'

const execFileAsync = promisify(execFile)

const PROJECT_ROOT = process.cwd()
export const WINDOWS_ZIP_NAME = 'rsm-windows-x64.zip'

/** Absolute paths are resolved against the dev server's cwd (same as backup.ts). */

// Never copied into the package (secrets, machine-specific or huge trees).
const NEVER_COPY = new Set([
  'node_modules',
  '.next',
  '.git',
  'backups',
  'screenshots',
  'download',
  'db',
  '.env',
  'scripts',
  'mini-services',
  'examples',
  'agent-ctx',
  'worklog.md',
  'dev.log',
  'dev.log.pre-r6a-restart',
  'server.log',
  'tests',
  'upload',
  'tool-results',
  'skills',
])

function isExcluded(name: string): boolean {
  return NEVER_COPY.has(name) || name.startsWith('bun.lock')
}

/** Copied verbatim from the project root (dotfiles like .env are NOT in this list). */
const ROOT_FILES = [
  'package.json',
  'next.config.ts',
  'tsconfig.json',
  'eslint.config.mjs',
  'postcss.config.mjs',
  'components.json',
  'tailwind.config.ts',
  'next-env.d.ts',
]

/** Windows batch files MUST use CRLF line endings. */
function bat(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

const INSTALL_BAT = bat([
  '@echo off',
  'title RSM Restaurant Platform - Installer',
  'echo ==========================================================',
  'echo   RSM Restaurant Platform - Windows Installer',
  'echo ==========================================================',
  'echo.',
  'cd /d "%~dp0.."',
  'where bun >nul 2>nul',
  'if %errorlevel% equ 0 goto bun',
  'where node >nul 2>nul',
  'if %errorlevel% equ 0 goto node',
  'echo [ERROR] Neither Bun nor Node.js was found on this PC.',
  'echo.',
  'echo Please install ONE of the following, then run this file again:',
  'echo    Bun:      https://bun.com',
  'echo    Node.js:  https://nodejs.org   version 20 or newer',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':bun',
  'echo [OK] Bun detected. Installing dependencies - usually 1-3 minutes...',
  'call bun install',
  'if errorlevel 1 goto installfailed',
  'echo [OK] Generating the database client...',
  'call bunx prisma generate',
  'if errorlevel 1 goto installfailed',
  'goto done',
  '',
  ':node',
  'echo [OK] Node.js detected. Installing dependencies - usually 3-10 minutes...',
  'call npm install --no-audit --no-fund',
  'if errorlevel 1 goto installfailed',
  'echo [OK] Generating the database client...',
  'call npx prisma generate',
  'if errorlevel 1 goto installfailed',
  'goto done',
  '',
  ':installfailed',
  'echo.',
  'echo [ERROR] Installation failed. Read the messages above.',
  'echo If an antivirus or firewall blocked something, allow it and run this file again.',
  'pause',
  'exit /b 1',
  '',
  ':done',
  'echo.',
  'echo ==========================================================',
  'echo   Install complete!',
  'echo   Next: double-click windows\\start.bat to run RSM.',
  'echo ==========================================================',
  'pause',
])

const START_BAT = bat([
  '@echo off',
  'title RSM Restaurant Platform',
  'cd /d "%~dp0.."',
  'if not exist node_modules goto notinstalled',
  'where bun >nul 2>nul',
  'if %errorlevel% equ 0 goto bun',
  'where node >nul 2>nul',
  'if %errorlevel% equ 0 goto node',
  'echo [ERROR] Neither Bun nor Node.js was found. Run windows\\install.bat first.',
  'pause',
  'exit /b 1',
  '',
  ':bun',
  'call bunx prisma generate >nul 2>nul',
  'echo Starting RSM... once ready, open http://localhost:3000',
  'echo Keep this window open while working. Press Ctrl+C to stop the server.',
  'echo.',
  'call bun x next dev -p 3000',
  'goto stopped',
  '',
  ':node',
  'call npx prisma generate >nul 2>nul',
  'echo Starting RSM... once ready, open http://localhost:3000',
  'echo Keep this window open while working. Press Ctrl+C to stop the server.',
  'echo.',
  'call npx next dev -p 3000',
  'goto stopped',
  '',
  ':notinstalled',
  'echo [ERROR] Dependencies are not installed yet.',
  'echo Please double-click windows\\install.bat first, then run this file again.',
  'echo.',
  'pause',
  'exit /b 1',
  '',
  ':stopped',
  'echo.',
  'echo RSM stopped. If an error appeared above, read it, fix it, then start again.',
  'pause',
])

const STOP_BAT = bat([
  '@echo off',
  'title RSM - Stop the server',
  'echo To stop the RSM server:',
  'echo.',
  'echo   1. Go to the RSM console window - the one running windows\\start.bat',
  'echo   2. Press Ctrl+C, or simply close that window.',
  'echo.',
  'echo This window is only a reminder - closing it changes nothing.',
  'echo.',
  'pause',
])

const README_WINDOWS = `# RSM Restaurant Platform — Windows Package

## English

**What this is:** the complete RSM restaurant platform (POS, kitchen
display, inventory, cash drawer, reports, reservations, loyalty, AI vision
dashboard) packaged to run **100% locally on your PC**. All data is stored
in the single file \`db\\custom.db\` (SQLite). **No internet connection is
required to operate the restaurant** — everything runs on your machine.

### Requirements
- Windows 10/11 64-bit
- **Bun** (https://bun.com) **or** Node.js 20+ (https://nodejs.org)

### Setup (once)
1. Unzip this package to a folder, e.g. \`C:\\RSM\`.
2. Double-click \`windows\\install.bat\` — it installs dependencies and the
   database client (needs internet, a few minutes, only once).
3. Double-click \`windows\\start.bat\`.
4. Open **http://localhost:3000** in Chrome/Edge.
5. Sign in:
   - Admin: \`admin@rms.com\` / \`admin123\` (PIN 1234)
   - Waiter: \`waiter@rms.com\` / \`waiter123\` (PIN 1111)
   - Kitchen: \`kitchen@rms.com\` / \`kitchen123\` (PIN 2222)

### Where your data lives & how to back it up
Everything is in \`db\\custom.db\`. From the app: **Settings → Backup** to
create and download snapshots (stored in the \`backups\\\` folder). Copy the
whole folder to move the restaurant to another PC.

### Syncing to the cloud (when online)
When the PC is connected to the internet it can export its updates to your
**hosted master instance** automatically:
1. On the PC instance open **Settings → Sync Center**.
2. Set the **Cloud target URL** to your hosted master's address
   (e.g. \`https://master.example.com\`) and paste the **sync key** from the
   master's Sync Center (Settings → Sync Center → sync key).
3. Enable **auto-export**.
4. Whenever the PC is online, its updates (orders, payments, customers,
   attendance, cash entries, reservations, activity log) export to the
   master. You can also push manually any time.

### Firewall note
The first time you start the server, Windows may ask to allow Node/Bun —
tick **Private networks** and allow it. The app only listens on your own PC
(localhost); outbound sync needs the internet.

### Troubleshooting
- **Port 3000 busy** (\`EADDRINUSE\`): another app uses the port — close it
  (or stop the other RSM console) and run \`windows\\start.bat\` again.
- **Antivirus slows the install or flags the server**: allow/whitelist the
  folder — the app is a local Node server, no external code runs on your PC.
- **Blank page on first start**: the server compiles for a minute on the
  very first run — refresh after ~60 seconds.

---

## العربية

**ما هذه الحزمة:** منصة إدارة المطاعم RSM كاملة (نقاط البيع، شاشة
المطبخ، المخزون، درج النقدية، التقارير، الحجوزات، الولاء، لوحة
الرؤية الذكية) معدّة للعمل **بالكامل على جهازك محليًا**. جميع
البيانات تُحفظ في ملف واحد \`db\\custom.db\`. **لا تحتاج اتصالًا
بالإنترنت لتشغيل المطعم** — كل شيء يعمل على جهازك.

### المتطلبات
- ويندوز 10/11 (64-بت)
- **Bun** (https://bun.com) **أو** Node.js 20 أو أحدث (https://nodejs.org)

### خطوات التشغيل (مرة واحدة)
1. فك ضغط الحزمة في مجلد مثل \`C:\\RSM\`.
2. شغّل \`windows\\install.bat\` بالنقر المزدوج — يثبّت المتطلبات وعميل
   قاعدة البيانات (يحتاج إنترنت، بضع دقائق، مرة واحدة فقط).
3. شغّل \`windows\\start.bat\` بالنقر المزدوج.
4. افتح **http://localhost:3000** في المتصفح.
5. سجّل الدخول:
   - مدير: \`admin@rms.com\` / \`admin123\` (رمز 1234)
   - نادل: \`waiter@rms.com\` / \`waiter123\` (رمز 1111)
   - مطبخ: \`kitchen@rms.com\` / \`kitchen123\` (رمز 2222)

### أين تُحفظ البيانات وكيف تأخذ نسخة احتياطية
كل شيء في \`db\\custom.db\`. من التطبيق: **الإعدادات ← النسخ الاحتياطي**
لإنشاء نسخ وتحميلها (تُحفظ في مجلد \`backups\\\`). انسخ المجلد كاملًا
لنقل المطعم إلى جهاز آخر.

### المزامنة مع السحابة (عند توفر الإنترنت)
عند اتصال الجهاز بالإنترنت يمكن تصدير التحديثات تلقائيًا إلى
**النسخة المستضافة** لديك:
1. افتح **الإعدادات ← مركز المزامنة** على جهازك.
2. ضع **عنوان النسخة السحابية** (مثل \`https://master.example.com\`)
   وألصق **مفتاح المزامنة** من مركز المزامنة في النسخة المستضافة.
3. فعّل **التصدير التلقائي**.
4. عند توفر الإنترنت تُصدَّر التحديثات (الطلبات، المدفوعات، العملاء،
   الحضور، حركات النقدية، الحجوزات، سجل النشاط) إلى النسخة الرئيسية.
   ويمكن أيضًا التصدير يدويًا في أي وقت.

### ملاحظة جدار الحماية
عند أول تشغيل قد يطلب ويندوز السماح لـ Node/Bun — اختر **الشبكات
الخاصة** واسمح بذلك. التطبيق يعمل على جهازك فقط (localhost)،
والمزامنة الصادرة تحتاج الإنترنت.

### حل المشكلات
- **المنفذ 3000 مشغول**: أغلق التطبيق الآخر الذي يستخدمه ثم شغّل
  \`windows\\start.bat\` من جديد.
- **مضاد الفيروسات يبطئ التثبيت**: اسمح للمجلد — التطبيق خادم Node
  محلي ولا يشغّل أي كود خارجي على جهازك.
- **صفحة فارغة عند أول تشغيل**: الخادم يجمع الملفات في الدقيقة الأولى —
  حدّث الصفحة بعد نحو 60 ثانية.
`

/**
 * Build the Windows package ZIP in a temp directory.
 * Returns the zip path + a cleanup() that removes the temp tree — always
 * call cleanup, including on failure paths (handled internally: any build
 * error cleans the temp dir before rethrowing).
 */
export async function buildWindowsPackage(
  data: 'live' | 'demo',
): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rsm-windows-'))
  try {
    // ── 1. app tree ──
    const filter = (src: string) => !isExcluded(path.basename(src))
    await cp(path.join(PROJECT_ROOT, 'src'), path.join(tmp, 'src'), { recursive: true, filter })
    await cp(path.join(PROJECT_ROOT, 'prisma'), path.join(tmp, 'prisma'), { recursive: true, filter })
    await cp(path.join(PROJECT_ROOT, 'public'), path.join(tmp, 'public'), { recursive: true, filter })
    for (const file of ROOT_FILES) {
      await copyFile(path.join(PROJECT_ROOT, file), path.join(tmp, file)).catch((err) => {
        // tailwind.config.ts / next-env.d.ts are "if present" — everything
        // else in the list is required for the app to build.
        if (file === 'tailwind.config.ts' || file === 'next-env.d.ts') return
        throw err
      })
    }

    // ── 2. Windows-safe package.json (no `| tee` unix pipes) ──
    const pkg = JSON.parse(await readFile(path.join(tmp, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      [key: string]: unknown
    }
    pkg.scripts.dev = 'next dev -p 3000'
    pkg.scripts.start = 'next start -p 3000'
    await writeFile(path.join(tmp, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)

    // ── 3. fresh .env — schema-relative URL, never the dev machine's path ──
    await writeFile(path.join(tmp, '.env'), 'DATABASE_URL=file:../db/custom.db\n')

    // ── 4. database ──
    await mkdir(path.join(tmp, 'db'))
    if (data === 'live') {
      // Consistent WAL-safe snapshot of the CURRENT database (backup.ts pattern).
      const target = path.join(tmp, 'db', 'custom.db')
      await db.$executeRawUnsafe(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
    } else {
      // Fresh seeded demo database. Schema is pushed + seeded from the
      // PROJECT's prisma/ (identical to the packaged copy) into the temp
      // file — the live database is never touched (env var wins over .env,
      // verified). Generation is then verified by reading it back.
      const dbUrl = `file:${path.join(tmp, 'db', 'custom.db').replaceAll('\\', '/')}`
      const env = { ...process.env, DATABASE_URL: dbUrl }
      await execFileAsync('bun', ['x', 'prisma', 'db', 'push', '--skip-generate'], {
        cwd: PROJECT_ROOT,
        env,
        timeout: 240_000,
      })
      await execFileAsync('bun', ['run', 'prisma/seed.ts'], {
        cwd: PROJECT_ROOT,
        env,
        timeout: 240_000,
      })
      const probe = new PrismaClient({ datasources: { db: { url: dbUrl } } })
      try {
        const users = await probe.user.count()
        if (users <= 0) {
          throw new Error('Demo database generation failed — seed produced no users')
        }
      } finally {
        await probe.$disconnect()
      }
    }
    const dbStat = await stat(path.join(tmp, 'db', 'custom.db'))
    if (!dbStat.isFile() || dbStat.size === 0) {
      throw new Error('Windows package database is missing or empty')
    }

    // ── 5. windows/ launcher scripts (CRLF) + README ──
    const winDir = path.join(tmp, 'windows')
    await mkdir(winDir)
    await writeFile(path.join(winDir, 'install.bat'), INSTALL_BAT)
    await writeFile(path.join(winDir, 'start.bat'), START_BAT)
    await writeFile(path.join(winDir, 'stop.bat'), STOP_BAT)
    await writeFile(path.join(tmp, 'README-WINDOWS.md'), README_WINDOWS)

    // ── 6. zip the tree (info-zip never includes its own output file) ──
    const zipPath = path.join(tmp, WINDOWS_ZIP_NAME)
    await execFileAsync(
      'zip',
      ['-r', '-q', zipPath, '.', '-x', 'node_modules/*', '.next/*', '*/node_modules/*', '*/.next/*'],
      { cwd: tmp },
    )
    const zipStat = await stat(zipPath)
    if (!zipStat.isFile() || zipStat.size < 100 * 1024) {
      throw new Error(`Windows package zip is missing or suspiciously small (${zipStat.size} bytes)`)
    }

    return {
      filePath: zipPath,
      cleanup: async () => {
        await rm(tmp, { recursive: true, force: true })
      },
    }
  } catch (err) {
    // never leak the temp tree
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}
