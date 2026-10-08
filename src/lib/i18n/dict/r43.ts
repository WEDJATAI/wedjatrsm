/**
 * r43 — full Windows desktop version + live two-way sync health.
 *
 *  1. The Launcher's Microsoft/Windows icon now downloads the FULL platform
 *     installer (RSM-Platform-Setup.exe): the complete app installs itself on
 *     the PC (desktop icon, auto-start), enrolls with the cloud automatically
 *     and keeps GitHub · Vercel · Turso · Neon · Inngest in two-way sync.
 *  2. The sync health pill (Launcher hero — shown to roles that can open
 *     Settings) renders the LIVE two-way connection on both the cloud
 *     version (hub mode) and the desktop version (terminal mode).
 *
 * Registered LAST in DICT_PAIRS so these keys override their r25 ancestors.
 */
import type { DictPair } from '../index'

export const r43Dict: DictPair = {
  en: {
    // ── r43-a: the full Windows version (overrides the r32 agent copy) ──
    'home.windowsApp': 'Windows App',
    'home.windowsAppTitle': 'Download the full Windows version',
    'home.windowsAppDesc':
      'The complete RSM platform in one .exe: it installs itself on the PC, creates the desktop icon, and keeps your data in automatic two-way sync with the cloud — GitHub, Vercel, Turso, Neon and Inngest — with live sync health shown on both the desktop and the cloud.',
    'home.windowsAppFeatureOne':
      'The FULL platform on your PC — POS, kitchen, inventory, reports — installs itself and works offline too.',
    'home.windowsAppFeatureTwo':
      'Automatic two-way cloud sync from the first launch — no manual setup, your data stays live everywhere.',
    'home.windowsAppFeatureThree':
      'Connects GitHub · Vercel · Turso · Neon · Inngest and shows their live status plus sync health.',
    'home.windowsAppPasswordLabel': 'Download password',
    'home.windowsAppDownload': 'Download .exe',
    'home.windowsAppDownloading': 'Downloading…',
    'home.windowsAppDone': 'Downloaded ({size}) — double-click it on the PC to install the full platform.',
    'home.windowsAppSaveFile': 'Save RSM-Platform-Setup.exe ({size})',
    'home.windowsAppIframeHint':
      'Note: if the preview blocks downloads, press “Open in New Tab” above the preview panel and try again — or copy the link into a new tab.',

    // ── r43-b: live sync health pill ──
    'home.syncChecking': 'Sync…',
    'home.syncLive': 'Cloud sync live',
    'home.syncPending': 'Sync catching up',
    'home.syncOffline': 'Sync offline',
    'home.syncPaused': 'Sync paused',
    'home.syncHubLive': 'Cloud live',
    'home.syncHubDown': 'Cloud DB down',
    'home.syncDetailTitle': 'Two-way sync health',
    'home.syncEngine': 'Sync engine',
    'home.syncEngineRunning': 'Running',
    'home.syncEngineStopped': 'Stopped',
    'home.syncEnginePaused': 'Paused',
    'home.syncCloudReachable': 'Cloud reachable',
    'home.syncCloudYes': 'Yes',
    'home.syncCloudNo': 'No',
    'home.syncCloudUnknown': 'Not checked yet',
    'home.syncLastPush': 'Last push',
    'home.syncLastPull': 'Last pull',
    'home.syncQueue': 'Queue',
    'home.syncQueueValue': '{up} up · {down} down',
    'home.syncDevice': 'This device',
    'home.syncTarget': 'Sync target',
    'home.syncNever': 'never',
    'home.syncJustNow': 'just now',
    'home.syncAgo': '{minutes}m ago',
    'home.syncAgoHours': '{hours}h ago',
    'home.syncHubDb': 'Cloud datastore',
    'home.syncActiveDevices': 'Connected devices',
    'home.syncLastContact': 'Last device contact',
    'home.syncEventsHour': 'Events (last hour)',
    'home.syncFooter':
      'Live status · refreshed every 30 s — the same health the desktop app shows in its agent dashboard.',
  },
  ar: {
    // ── r43-a: نسخة ويندوز الكاملة ──
    'home.windowsApp': 'تطبيق ويندوز',
    'home.windowsAppTitle': 'تحميل النسخة الكاملة لويندوز',
    'home.windowsAppDesc':
      'منصة RSM كاملة في ملف exe واحد: يثبّت نفسه على الجهاز، ويعمل أيقونة على الديسكتوب، ويزامن بياناتك تلقائيًا في الاتجاهين مع السحابة — GitHub وVercel وTurso وNeon وInngest — مع عرض حالة المزامنة الحية على النسخة الديسكتوب والسحابة.',
    'home.windowsAppFeatureOne':
      'المنصة كاملة على جهازك — نقاط البيع والمطبخ والمخزون والتقارير — تثبّت نفسها وتشتغل حتى من غير إنترنت.',
    'home.windowsAppFeatureTwo':
      'مزامنة سحابية تلقائية في الاتجاهين من أول تشغيل — من غير أي إعداد، وبياناتك حية في كل مكان.',
    'home.windowsAppFeatureThree':
      'يتصل بـ GitHub وVercel وTurso وNeon وInngest ويعرض حالتهم وحالة المزامنة لحظة بلحظة.',
    'home.windowsAppPasswordLabel': 'كلمة سر التحميل',
    'home.windowsAppDownload': 'تحميل ملف exe',
    'home.windowsAppDownloading': 'جاري التحميل…',
    'home.windowsAppDone': 'تم التحميل ({size}) — دوس عليه دوبل كليك على الجهاز لتثبيت المنصة كاملة.',
    'home.windowsAppSaveFile': 'احفظ RSM-Platform-Setup.exe ({size})',
    'home.windowsAppIframeHint':
      'ملاحظة: لو المعاينة تمنع التحميل، اضغط «Open in New Tab» فوق لوحة المعاينة وحاول تاني — أو انسخ الرابط وافتحه في تاب جديد.',

    // ── r43-b: حالة المزامنة الحية ──
    'home.syncChecking': 'مزامنة…',
    'home.syncLive': 'المزامنة السحابية حية',
    'home.syncPending': 'المزامنة بتلحق',
    'home.syncOffline': 'المزامنة مفصولة',
    'home.syncPaused': 'المزامنة متوقفة',
    'home.syncHubLive': 'السحابة حية',
    'home.syncHubDown': 'قاعدة السحابة واقفة',
    'home.syncDetailTitle': 'حالة المزامنة في الاتجاهين',
    'home.syncEngine': 'محرك المزامنة',
    'home.syncEngineRunning': 'شغال',
    'home.syncEngineStopped': 'متوقف',
    'home.syncEnginePaused': 'متوقف مؤقتًا',
    'home.syncCloudReachable': 'الاتصال بالسحابة',
    'home.syncCloudYes': 'متصل',
    'home.syncCloudNo': 'مقفول',
    'home.syncCloudUnknown': 'لم يتم الفحص بعد',
    'home.syncLastPush': 'آخر إرسال',
    'home.syncLastPull': 'آخر استلام',
    'home.syncQueue': 'قائمة الانتظار',
    'home.syncQueueValue': '{up} للطرد · {down} للسحب',
    'home.syncDevice': 'هذا الجهاز',
    'home.syncTarget': 'هدف المزامنة',
    'home.syncNever': 'أبدًا',
    'home.syncJustNow': 'الآن',
    'home.syncAgo': 'منذ {minutes} دقيقة',
    'home.syncAgoHours': 'منذ {hours} ساعة',
    'home.syncHubDb': 'قاعدة بيانات السحابة',
    'home.syncActiveDevices': 'الأجهزة المتصلة',
    'home.syncLastContact': 'آخر تواصل من جهاز',
    'home.syncEventsHour': 'الأحداث (آخر ساعة)',
    'home.syncFooter': 'حالة حية · بتتحدث كل 30 ثانية — نفس الحالة اللي بتظهر في لوحة الوكيل على النسخة الديسكتوب.',
  },
}
