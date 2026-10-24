import type { DictPair } from '../index'

// ─── R62 dictionary — the v11 menu reimport notification ───────────
// Owner directive: "the attached menu is the only source of truth … be sure
// to push to cloud and to desktop." A menu reimport streams 400+ hybrid
// events, which lands in CloudUpdateWatcher's bulk-catch-up silence band
// (>100 events/window stays quiet for fresh installs). The dedicated
// pull.menuReimportAt stamp (set by the pull cycle when the menu.reimport
// audit event applies) gets its OWN toast so the owner always sees that the
// menu itself was updated from the cloud — on every terminal, every plane.

export const r62Dict: DictPair = {
  en: {
    // ── menu-reimport notification (terminal planes) ──
    'sync.cloudUpdate.menuToast.title': 'Menu updated from cloud',
    'sync.cloudUpdate.menuToast.body':
      'A new menu version was just applied — the menu now reflects the latest attached menu. All screens have refreshed automatically.',
  },
  ar: {
    // ── menu-reimport notification (terminal planes) ──
    'sync.cloudUpdate.menuToast.title': 'تم تحديث المنيو من السحابة',
    'sync.cloudUpdate.menuToast.body':
      'تم تطبيق نسخة جديدة من المنيو للتو — المنيو الآن يعكس آخر منيو مرفق. تم تحديث جميع الشاشات تلقائياً.',
  },
}
