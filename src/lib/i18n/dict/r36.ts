import type { DictPair } from '../index'

// ─── R36 dictionary — macOS desktop-version download ────────────────
// Owner: main agent (r36, rewritten r58). Keys used by:
//   · home/windows-download-dialog.tsx  (DesktopDownloadDialog, macos flavor)
//   · home/launcher-view.tsx            (the "macOS App" hero button)
// Mirrors the r25/r32/r43 windowsApp* keys so the two dialogs share one
// component. r58: the macOS artifact is now the FULL platform installer
// (universal x64 + arm64) — the copy matches the Windows full version.
// Egyptian Arabic, Latin digits (per i18n conventions).

export const r36Dict: DictPair = {
  en: {
    // r58: macOS FULL desktop version (universal) — password-gated .zip from the Launcher
    'home.macosApp': 'macOS App',
    'home.macosAppTitle': 'Download the full macOS version',
    'home.macosAppDesc':
      'The complete RSM platform for your Mac — universal (Intel + Apple Silicon). It installs the full app, enrolls with the cloud and keeps your data in two-way sync with GitHub, Vercel, Turso, Neon and Inngest automatically.',
    'home.macosAppFeatureOne':
      'Installs the FULL platform: the whole app runs locally (localhost:3000) — POS, menu, floor plans, reports.',
    'home.macosAppFeatureTwo': 'Two-way sync every 30 seconds + a live dashboard at 127.0.0.1:9753.',
    'home.macosAppFeatureThree':
      'Universal binary — runs natively on Intel and Apple-Silicon Macs (M1/M2/M3/M4), zero dependencies.',
    'home.macosAppPasswordLabel': 'Download password',
    'home.macosAppDownload': 'Download .zip',
    'home.macosAppDownloading': 'Downloading…',
    'home.macosAppStarted': 'Download started — if nothing happens, use the direct link',
    'home.macosAppReady':
      'Download unlocked ({size}). If it didn’t start automatically, use the buttons below.',
    'home.macosAppSaveFile': 'Save RSM-Platform-Setup-macOS.zip ({size})',
    'home.macosAppMirror': 'Direct GitHub mirror (always available)',
    'home.macosAppCopyLink': 'Copy download link',
    'home.macosAppCopied': 'Link copied',
    'home.macosAppIframeHint':
      'Tip: if this preview blocks downloads, click “Open in New Tab” above the preview panel and try the button again — or copy the link and paste it into a new tab.',
    'home.macosAppHint':
      'Ask the manager for the download password. The installer enrolls itself and starts syncing immediately.',
    // one-time first-run instructions (Gatekeeper: unsigned download)
    'home.macosAppFirstRunTitle': 'First run on the Mac (once)',
    'home.macosAppStep1': 'Unzip the download — you get “RSM Platform Setup.app”.',
    'home.macosAppStep2':
      'macOS asks once because the app is not notarized: right-click the app → Open → Open (macOS 15: System Settings → Privacy & Security → Open Anyway).',
    'home.macosAppStep3':
      'It installs the full platform, creates a Desktop shortcut, starts with your Mac and opens the live dashboard.',
    'home.macosAppTerminalLabel': 'Or one Terminal command (works on every macOS version):',
    'home.macosAppTerminalCmd':
      'xattr -dr com.apple.quarantine ~/Downloads/RSM\\ Platform\\ Setup.app && open ~/Downloads/RSM\\ Platform\\ Setup.app',
    'home.macosAppTerminalCopied': 'Terminal command copied',
  },
  ar: {
    // r58: النسخة الكاملة للماك (يونيفرسال) — ملف zip بكلمة سر من الشاشة الرئيسية
    'home.macosApp': 'تطبيق ماك',
    'home.macosAppTitle': 'تحميل النسخة الكاملة للماك',
    'home.macosAppDesc':
      'منصة RSM كاملة على الماك — نسخة يونيفرسال (إنتل + Apple Silicon). تثبّت التطبيق كامل، وتسجّل مع السحابة، وتزامن بياناتك في الاتجاهين مع GitHub وVercel وTurso وNeon وInngest تلقائيًا.',
    'home.macosAppFeatureOne':
      'تثبّت المنصة كاملة: التطبيق كله يشتغل محليًا (localhost:3000) — نقطة البيع والمنيو والمخططات والتقارير.',
    'home.macosAppFeatureTwo': 'مزامنة في الاتجاهين كل 30 ثانية + لوحة حالة حية على 127.0.0.1:9753.',
    'home.macosAppFeatureThree':
      'نسخة يونيفرسال — تشتغل أصليًا على ماك إنتل وماك Apple Silicon (M1/M2/M3/M4)، من غير أي متطلبات.',
    'home.macosAppPasswordLabel': 'كلمة سر التحميل',
    'home.macosAppDownload': 'تحميل ملف zip',
    'home.macosAppDownloading': 'جاري التحميل…',
    'home.macosAppStarted': 'بدأ التحميل — لو ما حصلش شيء استخدم الرابط المباشر',
    'home.macosAppReady': 'تم فتح التحميل ({size}). لو ما بدأش تلقائيًا استخدم الأزرار بالأسفل.',
    'home.macosAppSaveFile': 'احفظ RSM-Platform-Setup-macOS.zip ({size})',
    'home.macosAppMirror': 'مرآة GitHub المباشرة (متاحة دائمًا)',
    'home.macosAppCopyLink': 'نسخ رابط التحميل',
    'home.macosAppCopied': 'تم نسخ الرابط',
    'home.macosAppIframeHint':
      'ملاحظة: لو المعاينة تمنع التحميل، اضغط «Open in New Tab» فوق لوحة المعاينة وحاول تاني — أو انسخ الرابط وافتحه في تاب جديد.',
    'home.macosAppHint':
      'اطلب كلمة سر التحميل من المدير. المثبّت يسجّل نفسه ويبدأ المزامنة فورًا.',
    // تعليمات أول تشغيل (مرة واحدة — حماية Gatekeeper)
    'home.macosAppFirstRunTitle': 'أول تشغيل على الماك (مرة واحدة)',
    'home.macosAppStep1': 'فك ضغط الملف — هيظهرلك «RSM Platform Setup.app».',
    'home.macosAppStep2':
      'نظام ماك هيسأل مرة واحدة لأن التطبيق مش موثّق: كليك يمين عليه ← فتح ← فتح (في macOS 15: إعدادات النظام ← الخصوصية والأمان ← فتح بأي حال).',
    'home.macosAppStep3':
      'هيثبّت المنصة كاملة، ويعمل اختصار على الديسكتوب، ويشتغل تلقائيًا مع الماك، ويفتح لوحة الحالة.',
    'home.macosAppTerminalLabel': 'أو أمر واحد في التيرمنال (بيشتغل على كل نسخ ماك):',
    'home.macosAppTerminalCmd':
      'xattr -dr com.apple.quarantine ~/Downloads/RSM\\ Platform\\ Setup.app && open ~/Downloads/RSM\\ Platform\\ Setup.app',
    'home.macosAppTerminalCopied': 'تم نسخ أمر التيرمنال',
  },
}
