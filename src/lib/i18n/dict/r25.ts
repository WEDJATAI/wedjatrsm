import type { DictPair } from '../index'

// ─── R25 dictionary — "Team Wall everywhere" platform UI scaling ────
// Owner: main agent (25-a/25-b). Keys used by:
//   · home/launcher-view.tsx  (Launcher Home tiles + greeting)
//   · kitchen-view.tsx        (25-d: new-order sound toggle + alert)
//   · pos/product-grid.tsx    (25-c: visual tile upgrade, if needed)
// Egyptian Arabic, Latin digits (per i18n conventions).

export const r25Dict: DictPair = {
  en: {
    // Launcher Home — greeting + status
    'home.greetingMorning': 'Good morning',
    'home.greetingAfternoon': 'Good afternoon',
    'home.greetingEvening': 'Good evening',
    'home.onShift': 'On shift now',
    'home.offShift': 'Not on shift',
    'home.workedSince': 'since {time}',
    'home.tapToStart': 'Tap a tile to start',
    'home.youAre': 'You are',

    // live badge counters
    'home.openOrders': '{n} open orders',
    'home.openOrdersOne': '1 open order',
    'home.pendingItems': '{n} to prepare',
    'home.lowStock': '{n} low stock',
    'home.onShiftTeam': '{n} on shift',

    // section headers
    'home.groupOperations': 'Work',
    'home.groupManage': 'Manage',
    'home.groupTeam': 'Team & System',

    // floor-tile plain-words sublabels (zero-reading promise)
    'home.posSub': 'Take orders',
    'home.kitchenSub': 'Prepare food',
    'home.reservationsSub': 'Bookings',
    'home.cashdrawerSub': 'Money',
    'home.visionSub': 'Cameras',
    'home.dashboardSub': 'Today at a glance',
    'home.reportsSub': 'Sales & numbers',
    'home.inventorySub': 'Stock levels',

    // KDS (25-d) — new-order sound
    'kds.soundOn': 'Sound on — rings when a new order arrives',
    'kds.soundOff': 'Sound off',
    'kds.newOrderAlert': 'New order!',

    // r32: Windows 10 agent download (password-gated .exe from the Launcher)
    'home.windowsApp': 'Windows App',
    'home.windowsAppTitle': 'Download for Windows 10',
    'home.windowsAppDesc':
      'A single .exe that installs itself on the PC and keeps your data in two-way sync with the cloud — GitHub, Vercel, Turso, Neon and Inngest — automatically, ready to work right away.',
    'home.windowsAppFeatureOne': 'Installs itself: shortcuts, auto-start with Windows, zero dependencies.',
    'home.windowsAppFeatureTwo': 'Two-way sync every 30 seconds + a live dashboard at 127.0.0.1:9753.',
    'home.windowsAppFeatureThree':
      'Connects to GitHub · Vercel · Turso · Neon · Inngest and shows their live status.',
    'home.windowsAppPasswordLabel': 'Download password',
    'home.windowsAppDownload': 'Download .exe',
    'home.windowsAppDownloading': 'Downloading…',
    'home.windowsAppDone': 'Downloaded ({size}) — double-click it on the PC to install.',
    'home.windowsAppHint':
      'Ask the manager for the download password. The agent enrolls itself and starts syncing immediately.',
  },
  ar: {
    // Launcher Home — greeting + status
    'home.greetingMorning': 'صباح الخير',
    'home.greetingAfternoon': 'مساء الخير',
    'home.greetingEvening': 'مساء الخير',
    'home.onShift': 'في الشغل دلوقتي',
    'home.offShift': 'مش في الشغل',
    'home.workedSince': 'من الساعة {time}',
    'home.tapToStart': 'دوس على أي زرار عشان تبدأ',
    'home.youAre': 'إنت',

    // live badge counters
    'home.openOrders': '{n} طلبات مفتوحة',
    'home.openOrdersOne': 'طلب واحد مفتوح',
    'home.pendingItems': '{n} لسه يتجهز',
    'home.lowStock': '{n} ناقص في المخزون',
    'home.onShiftTeam': '{n} في الشغل',

    // section headers
    'home.groupOperations': 'الشغل',
    'home.groupManage': 'الإدارة',
    'home.groupTeam': 'الفريق والنظام',

    // floor-tile plain-words sublabels (zero-reading promise)
    'home.posSub': 'خد الطلبات',
    'home.kitchenSub': 'جهّز الأكل',
    'home.reservationsSub': 'الحجوزات',
    'home.cashdrawerSub': 'الفلوس',
    'home.visionSub': 'الكاميرات',
    'home.dashboardSub': 'نظرة على النهاردة',
    'home.reportsSub': 'المبيعات والأرقام',
    'home.inventorySub': 'المخزون',

    // KDS (25-d) — new-order sound
    'kds.soundOn': 'الصوت شغال — بيرن لما ييجي أوردر جديد',
    'kds.soundOff': 'الصوت مقفول',
    'kds.newOrderAlert': 'أوردر جديد!',

    // r32: تحميل وكيل ويندوز 10 (ملف exe بكلمة سر من الشاشة الرئيسية)
    'home.windowsApp': 'تطبيق ويندوز',
    'home.windowsAppTitle': 'تحميل نسخة ويندوز 10',
    'home.windowsAppDesc':
      'ملف exe واحد يثبّت نفسه على الجهاز ويزامن بياناتك في الاتجاهين مع السحابة — GitHub وVercel وTurso وNeon وInngest — تلقائيًا، وجاهز للشغل على طول.',
    'home.windowsAppFeatureOne': 'يثبّت نفسه: اختصارات وتشغيل تلقائي مع ويندوز، من غير أي متطلبات.',
    'home.windowsAppFeatureTwo': 'مزامنة في الاتجاهين كل 30 ثانية + لوحة حالة حية على 127.0.0.1:9753.',
    'home.windowsAppFeatureThree':
      'يتصل بـ GitHub وVercel وTurso وNeon وInngest ويعرض حالتهم لحظة بلحظة.',
    'home.windowsAppPasswordLabel': 'كلمة سر التحميل',
    'home.windowsAppDownload': 'تحميل ملف exe',
    'home.windowsAppDownloading': 'جاري التحميل…',
    'home.windowsAppDone': 'تم التحميل ({size}) — دوس عليه دوبل كليك على الجهاز عشان يثبّت.',
    'home.windowsAppHint':
      'اطلب كلمة سر التحميل من المدير. الوكيل يسجّل نفسه ويبدأ المزامنة فورًا.',
  },
}
