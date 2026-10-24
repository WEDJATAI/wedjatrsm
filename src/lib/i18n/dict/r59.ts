import type { DictPair } from '../index'

// ─── R59 dictionary — honest hub-mode sync surfaces + desktop downloads ──
// Keys used by:
//   · src/components/admin/hybrid-sync-card.tsx — the HUB panel (cloud
//     deployment): the old terminal panel counted the cursor-based
//     delivery stream as "pending uploads" and showed a permanent,
//     misleading "LOCAL MODE — N changes waiting to sync" banner on the
//     cloud. The hub panel shows datastore health, connected devices,
//     live event flow and the delivery stream honestly.
//   · src/components/admin/sync-card.tsx — calm cloud-plane note (the
//     manual-export pending count is informational on the hub).
//   · src/components/admin/desktop-download-card.tsx — BOTH full desktop
//     versions (Windows .exe + macOS universal .zip) one click from
//     Settings, the same installers the Home screen offers.
// Egyptian Arabic, Latin digits (per i18n conventions).

export const r59Dict: DictPair = {
  en: {
    // ── hybrid card — HUB mode (cloud deployment) ──
    'hybrid.hubBannerLive': 'CLOUD HUB — live · {n} desktop device(s) connected',
    'hybrid.hubBannerNoDevices': 'CLOUD HUB — live · no desktop devices connected yet',
    'hybrid.hubBannerDown': 'CLOUD HUB — datastore unreachable',
    'hybrid.hubDatastore': 'Datastore',
    'hybrid.hubDevices': 'Connected devices',
    'hybrid.hubEventsHour': 'Events this hour',
    'hybrid.hubLastContact': 'Last device contact',
    'hybrid.hubStream': 'Delivery stream',
    'hybrid.hubStreamHint':
      'Cloud-origin events served to the desktop versions via cursor-based pulls — this is the live feed, not a queue; nothing waits.',
    'hybrid.hubLastEvent': 'Last event',
    'hybrid.hubConflicts': 'Conflicts resolved',
    'hybrid.hubInternet': 'Internet',
    'hybrid.hubTerminal': 'Terminal',
    'hybrid.hubPlatform': 'Platform',
    'hybrid.hubStatus': 'Status',
    'hybrid.hubNote':
      'This deployment is the cloud hub: every change lands here first and streams live to the connected desktop versions — nothing waits in a queue. Downloads: Home screen → Windows / macOS, or Settings → Desktop downloads.',
    'hybrid.platform.macos': 'macOS',

    // ── r15 sync card — cloud-plane calm note ──
    'sync.cloudAuto': 'Live sync — handled automatically',
    'sync.cloudAutoNote':
      'This is the cloud deployment: every change syncs live to the connected desktop versions, so nothing queues here. The tools below are the manual export/import kit for offline-first installs.',

    // ── desktop downloads card (Settings) — full versions ──
    'desktop.fullTitle': 'Full desktop versions — recommended',
    'desktop.fullSubtitle':
      'One file: it installs itself, enrolls with the cloud and keeps live two-way sync between the desktop and this cloud version (POS, kitchen, inventory, reports — everything).',
    'desktop.fullWindows': 'Windows — full version',
    'desktop.fullMacos': 'macOS — full version',
    'desktop.fullNote':
      'The same downloads the Home screen offers — the download password is required (ask the manager). Windows: SmartScreen may ask "More info → Run anyway" the first time; macOS: right-click → Open the first time.',
  },
  ar: {
    // ── بطاقة المزامنة — وضع المركز السحابي ──
    'hybrid.hubBannerLive': 'المركز السحابي — حي · {n} جهاز ديسكتوب متصل',
    'hybrid.hubBannerNoDevices': 'المركز السحابي — حي · لا توجد أجهزة ديسكتوب متصلة بعد',
    'hybrid.hubBannerDown': 'المركز السحابي — قاعدة البيانات غير متاحة',
    'hybrid.hubDatastore': 'قاعدة البيانات',
    'hybrid.hubDevices': 'الأجهزة المتصلة',
    'hybrid.hubEventsHour': 'الأحداث هذه الساعة',
    'hybrid.hubLastContact': 'آخر تواصل جهاز',
    'hybrid.hubStream': 'تدفق التسليم',
    'hybrid.hubStreamHint':
      'أحداث تُنشأ هنا وتُسلَّم لنسخ الديسكتوب بالسحب التدريجي — هذا بث حي وليس طابور انتظار؛ لا شيء ينتظر.',
    'hybrid.hubLastEvent': 'آخر حدث',
    'hybrid.hubConflicts': 'تعارضات تم حلها',
    'hybrid.hubInternet': 'الإنترنت',
    'hybrid.hubTerminal': 'الجهاز',
    'hybrid.hubPlatform': 'النظام',
    'hybrid.hubStatus': 'الحالة',
    'hybrid.hubNote':
      'هذا النشر هو المركز السحابي: كل تغيير يصل هنا أولًا ويُبث مباشرة إلى نسخ الديسكتوب المتصلة — لا شيء ينتظر في طابور. التحميل: الشاشة الرئيسية → Windows / macOS، أو الإعدادات → تحميل نسخة الديسكتوب.',
    'hybrid.platform.macos': 'ماك',

    // ── بطاقة المزامنة اليدوية — ملاحظة المركز السحابي ──
    'sync.cloudAuto': 'مزامنة حية — تتم تلقائيًا',
    'sync.cloudAutoNote':
      'هذا هو النشر السحابي: كل تغيير يتزامن مباشرة مع نسخ الديسكتوب المتصلة، فلا شيء ينتظر هنا. الأدوات بالأسفل هي طقم التصدير/الاستيراد اليدوي لنسخ العمل بدون إنترنت.',

    // ── بطاقة تحميل الديسكتوب (الإعدادات) — النسخ الكاملة ──
    'desktop.fullTitle': 'نسخ الديسكتوب الكاملة — موصى بها',
    'desktop.fullSubtitle':
      'ملف واحد: يثبّت نفسه ويسجل نفسه مع السحابة ويحافظ على مزامنة حية في الاتجاهين بين الديسكتوب ونسخة السحابة (المبيعات والمطبخ والمخزون والتقارير — كل شيء).',
    'desktop.fullWindows': 'ويندوز — النسخة الكاملة',
    'desktop.fullMacos': 'ماك — النسخة الكاملة',
    'desktop.fullNote':
      'نفس التحميلات المتاحة في الشاشة الرئيسية — كلمة مرور التحميل مطلوبة (اسأل المدير). ويندوز: قد يطلب SmartScreen «More info → Run anyway» أول مرة؛ ماك: كليك يمين ← Open أول مرة.',
  },
}
