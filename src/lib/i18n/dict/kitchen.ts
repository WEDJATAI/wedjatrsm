import type { DictPair } from '../index'

// ─── Kitchen (KDS) dictionary (owner: agent 6-c) ────────────────────

export const kitchenDict: DictPair = {
  en: {
    'kds.title': 'Kitchen Display',
    'kds.open': 'open',
    'kds.itemsPending': 'items pending',
    'kds.all': 'All',
    'kds.start': 'Start',
    'kds.ready': 'Ready',
    'kds.served': 'Served',
    'kds.completed': 'Completed',
    'kds.itemsReady': '{ready}/{total} items ready',
    'kds.empty': 'No open orders',
  },
  ar: {
    'kds.title': 'شاشة المطبخ',
    'kds.open': 'مفتوح',
    'kds.itemsPending': 'أصناف قيد الانتظار',
    'kds.all': 'الكل',
    'kds.start': 'بدء التحضير',
    'kds.ready': 'جاهز',
    'kds.served': 'تم التقديم',
    'kds.completed': 'مكتمل',
    'kds.itemsReady': '{ready}/{total} أصناف جاهزة',
    'kds.empty': 'لا توجد طلبات مفتوحة',
  },
}
