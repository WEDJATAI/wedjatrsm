import type { DictPair } from '../index'

// ─── R29 dictionary — Customers CRM Pro ──────────────────────────────
// Keys used by admin/customers-view.tsx (tier system, KPI insight row,
// smart segments, rich profiles, outreach quick actions).
// Egyptian Arabic, Latin digits (per i18n conventions); money arrives
// pre-formatted via formatCurrency (ج.م).

export const r29Dict: DictPair = {
  en: {
    // ── KPI insight row ──
    'customers.kpiActive': 'Active guests',
    'customers.kpiActiveSub': '{n} deactivated',
    'customers.kpiVip': 'VIP guests',
    'customers.kpiVipSub': 'Gold + Diamond tiers',
    'customers.kpiAtRisk': 'At risk',
    'customers.kpiAtRiskSub': '30+ days since last visit',
    'customers.kpiNew': 'New this month',
    'customers.kpiNewSub': 'joined in the last 30 days',
    'customers.kpiRevenue': 'Tracked revenue',
    'customers.kpiRevenueSub': 'avg {egp} / visit',

    // ── segment tabs ──
    'customers.tabAll': 'All',
    'customers.tabVip': 'VIP',
    'customers.tabAtRisk': 'At risk',
    'customers.tabNew': 'New',
    'customers.tabInactive': 'Inactive',

    // ── sort ──
    'customers.sortLabel': 'Sort',
    'customers.sortLastVisit': 'Last visit',
    'customers.sortSpend': 'Total spent',
    'customers.sortVisits': 'Most visits',
    'customers.sortPoints': 'Points',

    // ── tiers ──
    'customers.tier.bronze': 'Bronze',
    'customers.tier.silver': 'Silver',
    'customers.tier.gold': 'Gold',
    'customers.tier.diamond': 'Diamond',
    'customers.toNextTier': '{egp} to {tier}',
    'customers.topTier': 'Top tier — thank you!',

    // ── card + profile ──
    'customers.call': 'Call',
    'customers.whatsapp': 'WhatsApp',
    'customers.memberSince': 'Member since',
    'customers.avgPerVisit': 'Avg / visit',
    'customers.notesTitle': 'Notes',
    'customers.noOrdersYet': 'No orders yet',
    'customers.orderItems': '{n} items',
    'customers.pointsEarnedShort': '+{n} pts',
    'customers.pointsRedeemedShort': '−{n} pts',
    'customers.neverVisited': 'Hasn\u2019t visited yet',

    // ── empty states per segment ──
    'customers.emptyVip': 'No VIPs yet — guests reach Gold at EGP 7,500 lifetime spend',
    'customers.emptyAtRisk': 'Every guest has visited within the last 30 days',
    'customers.emptyNew': 'No new profiles in the last 30 days',
    'customers.emptyInactive': 'No deactivated profiles',
    'customers.emptySearch': 'No guests match your search',
  },

  ar: {
    // ── KPI insight row ──
    'customers.kpiActive': 'الضيوف النشطون',
    'customers.kpiActiveSub': '{n} موقوف',
    'customers.kpiVip': 'كبار الضيوف',
    'customers.kpiVipSub': 'الفئتان الذهبية والماسية',
    'customers.kpiAtRisk': 'معرضون للفقد',
    'customers.kpiAtRiskSub': 'مرّ 30 يومًا أو أكثر على آخر زيارة',
    'customers.kpiNew': 'الجدد هذا الشهر',
    'customers.kpiNewSub': 'انضموا خلال آخر 30 يومًا',
    'customers.kpiRevenue': 'الإيرادات المتتبعة',
    'customers.kpiRevenueSub': 'بمتوسط {egp} / زيارة',

    // ── segment tabs ──
    'customers.tabAll': 'الكل',
    'customers.tabVip': 'كبار الضيوف',
    'customers.tabAtRisk': 'معرضون للفقد',
    'customers.tabNew': 'الجدد',
    'customers.tabInactive': 'غير النشطين',

    // ── sort ──
    'customers.sortLabel': 'ترتيب',
    'customers.sortLastVisit': 'آخر زيارة',
    'customers.sortSpend': 'إجمالي الإنفاق',
    'customers.sortVisits': 'الأكثر زيارة',
    'customers.sortPoints': 'النقاط',

    // ── tiers ──
    'customers.tier.bronze': 'برونزي',
    'customers.tier.silver': 'فضي',
    'customers.tier.gold': 'ذهبي',
    'customers.tier.diamond': 'ماسي',
    'customers.toNextTier': 'متبقي {egp} لفئة {tier}',
    'customers.topTier': 'أعلى فئة — شكرًا لكم!',

    // ── card + profile ──
    'customers.call': 'اتصال',
    'customers.whatsapp': 'واتساب',
    'customers.memberSince': 'عضو منذ',
    'customers.avgPerVisit': 'متوسط الزيارة',
    'customers.notesTitle': 'ملاحظات',
    'customers.noOrdersYet': 'لا طلبات بعد',
    'customers.orderItems': '{n} أصناف',
    'customers.pointsEarnedShort': '+{n} نقطة',
    'customers.pointsRedeemedShort': '−{n} نقطة',
    'customers.neverVisited': 'لم يزر بعد',

    // ── empty states per segment ──
    'customers.emptyVip': 'لا كبار ضيوف بعد — يصل الضيف للفئة الذهبية عند إنفاق 7,500 ج.م',
    'customers.emptyAtRisk': 'كل الضيوف زاروا خلال آخر 30 يومًا',
    'customers.emptyNew': 'لا ملفات جديدة خلال آخر 30 يومًا',
    'customers.emptyInactive': 'لا ملفات موقوفة',
    'customers.emptySearch': 'لا ضيوف يطابقون البحث',
  },
}
