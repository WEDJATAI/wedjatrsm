import type { DictPair } from '../index'

// ─── R45 dictionary — Mazaj hookah-platform integration ──
// Keys used by:
//   · src/components/pos/pos-view.tsx — MazajShishaButton (order header)
//   · src/components/admin/integrations-view.tsx — Mazaj card (settings)
// Egyptian Arabic, Latin digits (per i18n conventions).

export const r45Dict: DictPair = {
  en: {
    // ── POS button ──
    'pos.mazajOrder': 'Order Shisha',
    'pos.mazajOrderHint': 'Open the Mazaj hookah page — the order lands on this table’s check automatically',
    'pos.mazajOrderHintNoTable': 'Open the Mazaj hookah ordering page',
    // ── Integrations card ──
    'integrations.mazaj.title': 'Mazaj — Hookah Platform',
    'integrations.mazaj.desc':
      'In-cafe hookah ordering: guests order flavors on Mazaj and the items land on the table’s check with house prices. Shisha availability mirrors the Mazaj inventory.',
    'integrations.mazaj.orderUrl': 'Guest ordering page URL',
    'integrations.mazaj.orderUrlHint':
      'Shown as an “Order Shisha” button in POS. Empty = the built-in Mazaj page (wmazaj.vercel.app); type “off” to hide the button. Placeholders: {tableId} (recommended — unique) and {table} (display name); both are also appended as URL params',
    'integrations.mazaj.categoryNames': 'Shisha category names',
    'integrations.mazaj.categoryNamesHint':
      'Comma-separated category names gated by the Mazaj inventory (default: Shisha, شيشة, Hookah, Mazaj)',
    'integrations.mazaj.save': 'Save Mazaj settings',
    'integrations.mazaj.scope': '{cats} category(ies) · {products} shisha products · {available} available now',
    'integrations.mazaj.noScope':
      'No matching category yet — create a “Shisha” category (or set the names above) and add your flavors with prices',
    'integrations.mazaj.endpointsTitle': 'Mazaj-side endpoints (same x-rsm-key as the delivery webhook)',
    'integrations.mazaj.ordersDoc':
      'orders (provider "mazaj", tableId/tableNumber/table, items[] — matched to your menu, added to the table’s check)',
    'integrations.mazaj.inventoryDoc':
      'inventory (items[] with available/quantity — mirrors availability onto your shisha menu)',
    'integrations.mazaj.catalogDoc':
      'catalog (products[] with sku/name/price — creates & re-prices the shisha types automatically; managed SKUs start with MAZAJ-)',
    'integrations.mazaj.statusDoc':
      'status (tables + shisha menu + tracked check statuses — powers the Mazaj table picker & revocation polling)',
    'integrations.mazaj.lastSync': 'Last inventory push: {time} · {matched} matched',
    'integrations.mazaj.unmatched': '{n} unmatched (add them to the menu)',
    'integrations.mazaj.noSyncYet': 'No inventory push received yet',
  },
  ar: {
    // ── POS button ──
    'pos.mazajOrder': 'اطلب شيشة',
    'pos.mazajOrderHint': 'افتح صفحة مزاج للشيشة — الطلب يُضاف تلقائيًا على فاتورة هذا الطاولة',
    'pos.mazajOrderHintNoTable': 'افتح صفحة طلب الشيشة من مزاج',
    // ── Integrations card ──
    'integrations.mazaj.title': 'مزاج — منصة الشيشة',
    'integrations.mazaj.desc':
      'طلب الشيشة داخل الكافيه: الضيف يطلب النكهات من مزاج وتُضاف على فاتورة الطاولة بأسعار المطعم. وتتوفر النكهات حسب مخزون مزاج.',
    'integrations.mazaj.orderUrl': 'رابط صفحة الطلب',
    'integrations.mazaj.orderUrlHint':
      'يظهر كزر «اطلب شيشة» في نقطة البيع. فارغ = صفحة مزاج المدمجة (wmazaj.vercel.app)؛ اكتب «off» لإخفاء الزر. المتغيرات: {tableId} (الموصى به — فريد) و {table} (الاسم المعروض)؛ ويُضافان أيضًا كباراميترات في الرابط',
    'integrations.mazaj.categoryNames': 'أسماء أقسام الشيشة',
    'integrations.mazaj.categoryNamesHint':
      'أقسام مفصولة بفاصلة تتحكم بها مخزون مزاج (الافتراضي: Shisha, شيشة, Hookah, Mazaj)',
    'integrations.mazaj.save': 'حفظ إعدادات مزاج',
    'integrations.mazaj.scope': '{cats} قسم · {products} منتج شيشة · {available} متاح الآن',
    'integrations.mazaj.noScope':
      'لا يوجد قسم مطابق بعد — أنشئ قسم «شيشة» (أو اضبط الأسماء أعلاه) وأضف نكهاتك بالأسعار',
    'integrations.mazaj.endpointsTitle': 'روابط الربط لمنصة مزاج (نفس مفتاح x-rsm-key الخاص بالـ webhook)',
    'integrations.mazaj.ordersDoc':
      'الطلبات (provider «mazaj» مع tableId/tableNumber/table و items — تُطابق مع قائمتك وتُضاف على فاتورة الطاولة)',
    'integrations.mazaj.inventoryDoc':
      'المخزون (items مع available/quantity — يعكس التوفر على قائمة الشيشة)',
    'integrations.mazaj.catalogDoc':
      'الكتالوج (products مع sku/name/price — ينشئ أنواع الشيشة ويحدّث أسعارها تلقائيًا؛ الأصناف المُدارة تبدأ بـ MAZAJ-)',
    'integrations.mazaj.statusDoc':
      'الحالة (الطاولات + قائمة الشيشة + حالة الفواتير المتابعة — تشغّل اختيار الطاولة ومتابعة الإلغاء في مزاج)',
    'integrations.mazaj.lastSync': 'آخر تحديث مخزون: {time} · تم مطابقة {matched}',
    'integrations.mazaj.unmatched': '{n} غير مطابق (أضفها إلى القائمة)',
    'integrations.mazaj.noSyncYet': 'لم يصل أي تحديث مخزون بعد',
  },
}
