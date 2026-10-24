import type { DictPair } from '../index'

// ─── R61 dictionary — cloud-update visibility on terminals ──────────
// Owner directive: "If anything has been modified on cloud it has to be
// synced to desktop too and automatically update it. Also if there are any
// updates for the cloud, a notification on the desktop version and updates
// automatically." Keys for CloudUpdateWatcher (toast + live refresh) and
// the launcher's cloud-update pill context. Bilingual EN/AR.

export const r61Dict: DictPair = {
  en: {
    // ── cloud-update watcher (desktop / terminal planes) ──
    'sync.cloudUpdate.title': 'Updated from cloud',
    'sync.cloudUpdate.body': '{n} change(s) applied — {areas}',
    'sync.cloudUpdate.menu': 'menu updated',
    'sync.cloudUpdate.orders': 'orders updated',
    'sync.cloudUpdate.data': 'data updated',
    'sync.cloudUpdate.areas.menu': 'menu',
    'sync.cloudUpdate.areas.orders': 'orders',
    'sync.cloudUpdate.areas.tables': 'tables',
    'sync.cloudUpdate.areas.customers': 'customers',
    'sync.cloudUpdate.areas.people': 'people',
    'sync.cloudUpdate.areas.promotions': 'promotions',
    'sync.cloudUpdate.areas.other': 'other data',
  },
  ar: {
    // ── cloud-update watcher (desktop / terminal planes) ──
    'sync.cloudUpdate.title': 'تم التحديث من السحابة',
    'sync.cloudUpdate.body': 'تم تطبيق {n} من التغييرات — {areas}',
    'sync.cloudUpdate.menu': 'تم تحديث المنيو',
    'sync.cloudUpdate.orders': 'تم تحديث الطلبات',
    'sync.cloudUpdate.data': 'تم تحديث البيانات',
    'sync.cloudUpdate.areas.menu': 'المنيو',
    'sync.cloudUpdate.areas.orders': 'الطلبات',
    'sync.cloudUpdate.areas.tables': 'الطاولات',
    'sync.cloudUpdate.areas.customers': 'العملاء',
    'sync.cloudUpdate.areas.people': 'فريق العمل',
    'sync.cloudUpdate.areas.promotions': 'العروض',
    'sync.cloudUpdate.areas.other': 'بيانات أخرى',
  },
}
