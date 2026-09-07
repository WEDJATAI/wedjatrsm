import type { DictPair } from '../index'

// ─── Kitchen (KDS) dictionary (owner: agent 6-c) ────────────────────
// Course chips reuse common course.* keys; item statuses reuse
// common status.item.* keys (see common.ts).

export const kitchenDict: DictPair = {
  en: {
    'kds.title': 'Kitchen Display',
    'kds.live3s': 'live · 3s',
    'kds.stats': '{n} open · {m} items pending',
    'kds.open': 'open',
    'kds.itemsPending': 'items pending',
    'kds.all': 'All',
    'kds.filterStarters': 'Starters',
    'kds.filterMains': 'Mains',
    'kds.filterDesserts': 'Desserts',
    'kds.filterDrinks': 'Drinks',
    'kds.start': 'Start',
    'kds.ready': 'Ready',
    'kds.served': 'Served',
    'kds.completed': 'Completed',
    'kds.itemsReady': '{ready}/{total} items ready',
    'kds.empty': 'No open orders — all caught up!',
    'kds.loadFailed': 'Failed to load open orders',
    'kds.updateFailed': 'Failed to update item',
    'kds.item': 'Item',
  },
  ar: {
    'kds.title': 'شاشة المطبخ',
    'kds.live3s': 'مباشر · 3ث',
    'kds.stats': '{n} مفتوح · {m} أصناف قيد الانتظار',
    'kds.open': 'مفتوح',
    'kds.itemsPending': 'أصناف قيد الانتظار',
    'kds.all': 'الكل',
    'kds.filterStarters': 'المقبلات',
    'kds.filterMains': 'الأطباق الرئيسية',
    'kds.filterDesserts': 'الحلويات',
    'kds.filterDrinks': 'المشروبات',
    'kds.start': 'بدء التحضير',
    'kds.ready': 'جاهز',
    'kds.served': 'تم التقديم',
    'kds.completed': 'مكتمل',
    'kds.itemsReady': '{ready}/{total} أصناف جاهزة',
    'kds.empty': 'لا توجد طلبات مفتوحة — كل شيء منجز!',
    'kds.loadFailed': 'فشل تحميل الطلبات المفتوحة',
    'kds.updateFailed': 'فشل تحديث الصنف',
    'kds.item': 'صنف',
  },
}
