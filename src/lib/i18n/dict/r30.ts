import type { DictPair } from '../index'

// ─── R30 dictionary — Hybrid Sync Center (event-based device sync) ──
// Keys used by admin/hybrid-sync-card.tsx (status tiles, calm-mode
// banner, admin controls, errors dialog, backups, device management)
// and the POS header status pill (pos-view.tsx).
// Egyptian Arabic, Latin digits (per i18n conventions).

export const r30Dict: DictPair = {
  en: {
    // ── card header ──
    'hybrid.title': 'Hybrid Sync Center',
    'hybrid.subtitle':
      'Event-based device sync — every change is queued locally and replicated to your cloud and other devices automatically.',
    'hybrid.noTargetHint':
      'Cloud target not configured — set it in the Sync Center above to enable cloud synchronization',

    // ── calm-mode banner ──
    'hybrid.mode.local': 'LOCAL MODE — OPERATING NORMALLY',
    'hybrid.mode.cloud': 'CLOUD SYNC — CONNECTED',
    'hybrid.mode.waiting': 'LOCAL MODE — {n} CHANGES WAITING TO SYNC',

    // ── status tile labels ──
    'hybrid.localSystem': 'Local system',
    'hybrid.localDatabase': 'Local database',
    'hybrid.internet': 'Internet',
    'hybrid.cloud': 'Cloud',
    'hybrid.lastPush': 'Last push',
    'hybrid.lastPull': 'Last pull',
    'hybrid.lastReconcile': 'Last reconciliation',
    'hybrid.pendingUploads': 'Pending uploads',
    'hybrid.pendingDownloads': 'Pending downloads',
    'hybrid.failedEvents': 'Failed events',
    'hybrid.device': 'Device',
    'hybrid.sync': 'Sync',
    'hybrid.backup': 'Backup',

    // ── status tile values ──
    'hybrid.healthy': 'Healthy',
    'hybrid.warning': 'Warning',
    'hybrid.error': 'Error',
    'hybrid.stopped': 'Stopped',
    'hybrid.connected': 'Connected',
    'hybrid.offline': 'Offline',
    'hybrid.unavailable': 'Unavailable',
    'hybrid.notConfigured': 'Not configured',
    'hybrid.paused': 'Paused',
    'hybrid.enabled': 'Enabled',
    'hybrid.never': 'never',
    'hybrid.authFailedHint': 'Re-register this device in Device Management',

    // ── relative time ──
    'hybrid.justNow': 'just now',
    'hybrid.nMinAgo': '{n}m ago',
    'hybrid.nHourAgo': '{n}h ago',
    'hybrid.nDayAgo': '{n}d ago',

    // ── admin controls ──
    'hybrid.syncNow': 'Sync now',
    'hybrid.syncing': 'Syncing…',
    'hybrid.syncDone': 'Sync complete — {pushed} pushed · {acked} acked · {applied} applied',
    'hybrid.syncBusy': 'Sync already running — try again in a moment',
    'hybrid.pauseSync': 'Pause sync',
    'hybrid.resumeSync': 'Resume sync',
    'hybrid.pausedToast': 'Hybrid sync paused — changes keep queuing locally',
    'hybrid.resumedToast': 'Hybrid sync resumed',
    'hybrid.retryFailed': 'Retry failed',
    'hybrid.retryNone': 'No failed events to retry',
    'hybrid.retried': '{n} events queued for retry',
    'hybrid.viewErrors': 'View sync errors',
    'hybrid.runReconciliation': 'Run reconciliation',
    'hybrid.reconcileDone': 'Reconciliation complete — {n} drifted entities',
    'hybrid.createBackup': 'Create backup',
    'hybrid.restoreBackup': 'Restore backup',

    // ── errors dialog ──
    'hybrid.errorsTitle': 'Sync errors',
    'hybrid.errorsEmpty': 'No failed events — the queues are clean',
    'hybrid.includeDead': 'Include dead-lettered',
    'hybrid.entity': 'Entity',
    'hybrid.operation': 'Operation',
    'hybrid.direction': 'Direction',
    'hybrid.attempts': 'Attempts',
    'hybrid.lastError': 'Last error',
    'hybrid.directionOut': 'Upload',
    'hybrid.directionIn': 'Download',
    'hybrid.statusFailed': 'Failed',
    'hybrid.statusDead': 'Dead',

    // ── reconciliation dialog ──
    'hybrid.driftTitle': 'Reconciliation report',
    'hybrid.driftLocal': 'Local',
    'hybrid.driftCloud': 'Cloud',
    'hybrid.drift': 'Drift',
    'hybrid.driftConflicts': '{n} conflicts recorded',
    'hybrid.cloudUnreachable': 'Cloud unreachable — local counts only',

    // ── backups / restore ──
    'hybrid.confirmRestoreTitle': 'Restore this backup?',
    'hybrid.confirmRestoreBody':
      'A safety snapshot is created automatically. The application must be restarted to complete the restore.',
    'hybrid.restoreStaged': 'Restore staged — restart required',
    'hybrid.restoreAction': 'Restore',

    // ── device management ──
    'hybrid.deviceSection': 'Device management',
    'hybrid.deviceSectionSub': 'Register the Windows / Linux instances that replicate with this database',
    'hybrid.registerDevice': 'Register device',
    'hybrid.deviceRegistered': 'Device registered — copy the key now',
    'hybrid.keyRotated': 'New key generated — copy it now',
    'hybrid.deviceName': 'Device name',
    'hybrid.devicePlatform': 'Platform',
    'hybrid.platform.windows': 'Windows',
    'hybrid.platform.linux': 'Linux',
    'hybrid.showOnce': 'Shown once — store it now',
    'hybrid.keyWarning': 'Store this key now — it cannot be shown again',
    'hybrid.copy': 'Copy',
    'hybrid.copied': 'Copied',
    'hybrid.deviceIdLabel': 'Device ID',
    'hybrid.deviceKeyLabel': 'Device key',
    'hybrid.lastSeen': 'Last seen',
    'hybrid.noDevices': 'No devices registered yet',
    'hybrid.actions.rename': 'Rename',
    'hybrid.actions.rotate': 'Rotate key',
    'hybrid.actions.pause': 'Pause',
    'hybrid.actions.resume': 'Resume',
    'hybrid.actions.revoke': 'Revoke',
    'hybrid.renameTitle': 'Rename device',
    'hybrid.rotateConfirmTitle': 'Rotate device key?',
    'hybrid.rotateConfirmBody':
      'A new key is generated and shown once. The old key stops working immediately — update the device right after.',
    'hybrid.revokeConfirmTitle': 'Revoke this device?',
    'hybrid.revokeConfirmBody':
      'The device can no longer connect or sync. To use it again you must register it from scratch.',
    'hybrid.deviceDone': 'Device updated',
  },

  ar: {
    // ── card header ──
    'hybrid.title': 'مركز المزامنة الهجينة',
    'hybrid.subtitle':
      'مزامنة قائمة على الأحداث — كل تغيير يُحفظ في طابور محلي ويُنسخ للسحابة وبقية الأجهزة تلقائيًا.',
    'hybrid.noTargetHint':
      'لا يوجد هدف سحابي مضبوط — اضبطه في مركز المزامنة بالأعلى لتفعيل المزامنة السحابية',

    // ── calm-mode banner ──
    'hybrid.mode.local': 'الوضع المحلي — كل شيء يعمل طبيعي',
    'hybrid.mode.cloud': 'مزامنة سحابية — متصلة',
    'hybrid.mode.waiting': 'الوضع المحلي — {n} تغييرات في انتظار المزامنة',

    // ── status tile labels ──
    'hybrid.localSystem': 'النظام المحلي',
    'hybrid.localDatabase': 'قاعدة البيانات المحلية',
    'hybrid.internet': 'الإنترنت',
    'hybrid.cloud': 'السحابة',
    'hybrid.lastPush': 'آخر إرسال',
    'hybrid.lastPull': 'آخر جلب',
    'hybrid.lastReconcile': 'آخر مطابقة',
    'hybrid.pendingUploads': 'بانتظار الرفع',
    'hybrid.pendingDownloads': 'بانتظار التنزيل',
    'hybrid.failedEvents': 'أحداث فاشلة',
    'hybrid.device': 'الجهاز',
    'hybrid.sync': 'المزامنة',
    'hybrid.backup': 'النسخة الاحتياطية',

    // ── status tile values ──
    'hybrid.healthy': 'سليم',
    'hybrid.warning': 'تحذير',
    'hybrid.error': 'خطأ',
    'hybrid.stopped': 'متوقف',
    'hybrid.connected': 'متصل',
    'hybrid.offline': 'غير متصل',
    'hybrid.unavailable': 'غير متاح',
    'hybrid.notConfigured': 'غير مضبوط',
    'hybrid.paused': 'موقوف مؤقتًا',
    'hybrid.enabled': 'مُفعّل',
    'hybrid.never': 'أبدًا',
    'hybrid.authFailedHint': 'أعد تسجيل هذا الجهاز من إدارة الأجهزة',

    // ── relative time ──
    'hybrid.justNow': 'الآن',
    'hybrid.nMinAgo': 'منذ {n} د',
    'hybrid.nHourAgo': 'منذ {n} س',
    'hybrid.nDayAgo': 'منذ {n} يوم',

    // ── admin controls ──
    'hybrid.syncNow': 'زامن الآن',
    'hybrid.syncing': 'جارٍ المزامنة…',
    'hybrid.syncDone': 'تمت المزامنة — {pushed} مُرسل · {acked} مؤكد · {applied} مطبق',
    'hybrid.syncBusy': 'المزامنة جارية بالفعل — حاول بعد لحظات',
    'hybrid.pauseSync': 'إيقاف المزامنة',
    'hybrid.resumeSync': 'استئناف المزامنة',
    'hybrid.pausedToast': 'تم إيقاف المزامنة مؤقتًا — التغييرات تستمر في الحفظ محليًا',
    'hybrid.resumedToast': 'تم استئناف المزامنة',
    'hybrid.retryFailed': 'إعادة المحاولة',
    'hybrid.retryNone': 'لا توجد أحداث فاشلة لإعادة محاولتها',
    'hybrid.retried': 'تمت إعادة {n} حدثًا للطابور',
    'hybrid.viewErrors': 'عرض أخطاء المزامنة',
    'hybrid.runReconciliation': 'تشغيل المطابقة',
    'hybrid.reconcileDone': 'تمت المطابقة — {n} كيانات مختلفة',
    'hybrid.createBackup': 'إنشاء نسخة احتياطية',
    'hybrid.restoreBackup': 'استعادة نسخة',

    // ── errors dialog ──
    'hybrid.errorsTitle': 'أخطاء المزامنة',
    'hybrid.errorsEmpty': 'لا أحداث فاشلة — الطوابير نظيفة',
    'hybrid.includeDead': 'شامل الأحداث الميتة',
    'hybrid.entity': 'الكيان',
    'hybrid.operation': 'العملية',
    'hybrid.direction': 'الاتجاه',
    'hybrid.attempts': 'المحاولات',
    'hybrid.lastError': 'آخر خطأ',
    'hybrid.directionOut': 'رفع',
    'hybrid.directionIn': 'تنزيل',
    'hybrid.statusFailed': 'فاشل',
    'hybrid.statusDead': 'ميت',

    // ── reconciliation dialog ──
    'hybrid.driftTitle': 'تقرير المطابقة',
    'hybrid.driftLocal': 'محلي',
    'hybrid.driftCloud': 'سحابي',
    'hybrid.drift': 'الفرق',
    'hybrid.driftConflicts': '{n} تعارضات مسجلة',
    'hybrid.cloudUnreachable': 'السحابة غير متاحة — أعداد محلية فقط',

    // ── backups / restore ──
    'hybrid.confirmRestoreTitle': 'استعادة هذه النسخة؟',
    'hybrid.confirmRestoreBody':
      'تُنشأ نسخة أمان تلقائيًا. يجب إعادة تشغيل التطبيق لإكمال الاستعادة.',
    'hybrid.restoreStaged': 'تم تجهيز الاستعادة — مطلوب إعادة تشغيل',
    'hybrid.restoreAction': 'استعادة',

    // ── device management ──
    'hybrid.deviceSection': 'إدارة الأجهزة',
    'hybrid.deviceSectionSub': 'سجّل أجهزة ويندوز / لينكس التي تزامن مع قاعدة البيانات دي',
    'hybrid.registerDevice': 'تسجيل جهاز',
    'hybrid.deviceRegistered': 'تم تسجيل الجهاز — انسخ المفتاح الآن',
    'hybrid.keyRotated': 'تم إنشاء مفتاح جديد — انسخه الآن',
    'hybrid.deviceName': 'اسم الجهاز',
    'hybrid.devicePlatform': 'النظام',
    'hybrid.platform.windows': 'ويندوز',
    'hybrid.platform.linux': 'لينكس',
    'hybrid.showOnce': 'يُعرض مرة واحدة — احفظه الآن',
    'hybrid.keyWarning': 'احفظ المفتاح الآن — لن يمكن إظهاره مرة أخرى',
    'hybrid.copy': 'نسخ',
    'hybrid.copied': 'تم النسخ',
    'hybrid.deviceIdLabel': 'معرّف الجهاز',
    'hybrid.deviceKeyLabel': 'مفتاح الجهاز',
    'hybrid.lastSeen': 'آخر ظهور',
    'hybrid.noDevices': 'لا أجهزة مسجلة بعد',
    'hybrid.actions.rename': 'إعادة تسمية',
    'hybrid.actions.rotate': 'تدوير المفتاح',
    'hybrid.actions.pause': 'إيقاف مؤقت',
    'hybrid.actions.resume': 'استئناف',
    'hybrid.actions.revoke': 'إلغاء',
    'hybrid.renameTitle': 'إعادة تسمية الجهاز',
    'hybrid.rotateConfirmTitle': 'تدوير مفتاح الجهاز؟',
    'hybrid.rotateConfirmBody':
      'سيُنشأ مفتاح جديد ويُعرض مرة واحدة. المفتاح القديم يتوقف فورًا — حدّث الجهاز بعدها مباشرة.',
    'hybrid.revokeConfirmTitle': 'إلغاء هذا الجهاز؟',
    'hybrid.revokeConfirmBody':
      'لن يستطيع الجهاز الاتصال أو المزامنة. لاستخدامه مجددًا يجب تسجيله من جديد.',
    'hybrid.deviceDone': 'تم تحديث الجهاز',
  },
}
