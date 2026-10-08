import type { DictPair } from '../index'

// ─── R36 dictionary — macOS (Intel x64) agent download ──────────────
// Owner: main agent (r36). Keys used by:
//   · home/windows-download-dialog.tsx  (DesktopDownloadDialog, macos flavor)
//   · home/launcher-view.tsx            (the "macOS App" hero button)
// Mirrors the r25/r32 windowsApp* keys so the two dialogs share one
// component. Egyptian Arabic, Latin digits (per i18n conventions).

export const r36Dict: DictPair = {
  en: {
    // r36: macOS (Intel x64) agent download (password-gated .zip from the Launcher)
    'home.macosApp': 'macOS App',
    'home.macosAppTitle': 'Download for macOS (Intel x64)',
    'home.macosAppDesc':
      'A single .zip that installs itself on an Intel Mac and keeps your data in two-way sync with the cloud — GitHub, Vercel, Turso, Neon and Inngest — automatically, ready to work right away.',
    'home.macosAppFeatureOne':
      'Installs itself: Desktop shortcut, starts with your Mac (Login Item), zero dependencies.',
    'home.macosAppFeatureTwo': 'Two-way sync every 30 seconds + a live dashboard at 127.0.0.1:9753.',
    'home.macosAppFeatureThree':
      'Connects to GitHub · Vercel · Turso · Neon · Inngest and shows their live status.',
    'home.macosAppPasswordLabel': 'Download password',
    'home.macosAppDownload': 'Download .zip',
    'home.macosAppDownloading': 'Downloading…',
    'home.macosAppStarted': 'Download started — if nothing happens, use the direct link',
    'home.macosAppReady':
      'Download unlocked ({size}). If it didn’t start automatically, use the buttons below.',
    'home.macosAppSaveFile': 'Save RSM-macOS-Agent-Setup.zip ({size})',
    'home.macosAppMirror': 'Direct GitHub mirror (always available)',
    'home.macosAppCopyLink': 'Copy download link',
    'home.macosAppCopied': 'Link copied',
    'home.macosAppIframeHint':
      'Tip: if this preview blocks downloads, click “Open in New Tab” above the preview panel and try the button again — or copy the link and paste it into a new tab.',
    'home.macosAppHint':
      'Ask the manager for the download password. The agent enrolls itself and starts syncing immediately.',
    // r36: one-time first-run instructions (Gatekeeper: unsigned download)
    'home.macosAppFirstRunTitle': 'First run on the Mac (once)',
    'home.macosAppStep1': 'Unzip the download — you get “RSM-macOS-Agent-Setup.app”.',
    'home.macosAppStep2':
      'macOS asks once because the app is not notarized: right-click the app → Open → Open (macOS 15: System Settings → Privacy & Security → Open Anyway).',
    'home.macosAppStep3':
      'It installs itself to ~/Applications, creates a Desktop shortcut, starts with your Mac and opens the live dashboard.',
    'home.macosAppTerminalLabel': 'Or one Terminal command (works on every macOS version):',
    'home.macosAppTerminalCmd':
      'xattr -dr com.apple.quarantine ~/Downloads/RSM-macOS-Agent-Setup.app && open ~/Downloads/RSM-macOS-Agent-Setup.app',
    'home.macosAppTerminalCopied': 'Terminal command copied',
  },
  ar: {
    // r36: تحميل وكيل ماك إنتل (ملف zip بكلمة سر من الشاشة الرئيسية)
    'home.macosApp': 'تطبيق ماك',
    'home.macosAppTitle': 'تحميل نسخة ماك (إنتل)',
    'home.macosAppDesc':
      'ملف zip واحد يثبّت نفسه على الماك (إنتل) ويزامن بياناتك في الاتجاهين مع السحابة — GitHub وVercel وTurso وNeon وInngest — تلقائيًا، وجاهز للشغل على طول.',
    'home.macosAppFeatureOne': 'يثبّت نفسه: اختصار على الديسكتوب وتشغيل تلقائي مع الماك، من غير أي متطلبات.',
    'home.macosAppFeatureTwo': 'مزامنة في الاتجاهين كل 30 ثانية + لوحة حالة حية على 127.0.0.1:9753.',
    'home.macosAppFeatureThree':
      'يتصل بـ GitHub وVercel وTurso وNeon وInngest ويعرض حالتهم لحظة بلحظة.',
    'home.macosAppPasswordLabel': 'كلمة سر التحميل',
    'home.macosAppDownload': 'تحميل ملف zip',
    'home.macosAppDownloading': 'جاري التحميل…',
    'home.macosAppStarted': 'بدأ التحميل — لو ما حصلش شيء استخدم الرابط المباشر',
    'home.macosAppReady': 'تم فتح التحميل ({size}). لو ما بدأش تلقائيًا استخدم الأزرار بالأسفل.',
    'home.macosAppSaveFile': 'احفظ RSM-macOS-Agent-Setup.zip ({size})',
    'home.macosAppMirror': 'مرآة GitHub المباشرة (متاحة دائمًا)',
    'home.macosAppCopyLink': 'نسخ رابط التحميل',
    'home.macosAppCopied': 'تم نسخ الرابط',
    'home.macosAppIframeHint':
      'ملاحظة: لو المعاينة تمنع التحميل، اضغط «Open in New Tab» فوق لوحة المعاينة وحاول تاني — أو انسخ الرابط وافتحه في تاب جديد.',
    'home.macosAppHint':
      'اطلب كلمة سر التحميل من المدير. الوكيل يسجّل نفسه ويبدأ المزامنة فورًا.',
    // r36: تعليمات أول تشغيل (مرة واحدة — حماية Gatekeeper)
    'home.macosAppFirstRunTitle': 'أول تشغيل على الماك (مرة واحدة)',
    'home.macosAppStep1': 'فك ضغط الملف — هيظهرلك «RSM-macOS-Agent-Setup.app».',
    'home.macosAppStep2':
      'نظام ماك هيسأل مرة واحدة لأن التطبيق مش موثّق: كليك يمين عليه ← فتح ← فتح (في macOS 15: إعدادات النظام ← الخصوصية والأمان ← فتح بأي حال).',
    'home.macosAppStep3':
      'هيثبّت نفسه في ~/Applications، ويعمل اختصار على الديسكتوب، ويشتغل تلقائيًا مع الماك، ويفتح لوحة الحالة.',
    'home.macosAppTerminalLabel': 'أو أمر واحد في التيرمنال (بيشتغل على كل نسخ ماك):',
    'home.macosAppTerminalCmd':
      'xattr -dr com.apple.quarantine ~/Downloads/RSM-macOS-Agent-Setup.app && open ~/Downloads/RSM-macOS-Agent-Setup.app',
    'home.macosAppTerminalCopied': 'تم نسخ أمر التيرمنال',
  },
}
