import type { DictPair } from '../index'

// ─── AI dictionary (R9 feature, restored R17) ───────────────────────
// Keys for the manager AI briefing card + copilot chat sheet. The
// components existed since R9 but their dictionary was lost when the
// render wiring was orphaned — rebuilt here (EN/AR) so t() never falls
// through to raw key tails.

export const aiDict: DictPair = {
  en: {
    'ai.briefingTitle': 'Morning Briefing',
    'ai.briefingSubtitle': "AI summary of yesterday's performance",
    'ai.briefingRefresh': 'Refresh',
    'ai.briefingRetry': 'Retry',
    'ai.briefingCached': 'cached',
    'ai.briefingOffline': 'AI briefing unavailable right now',
    'ai.statRevenue': 'Revenue',
    'ai.statOrders': 'Orders',
    'ai.statAvgCheck': 'Avg. check',
    'ai.statTips': 'Tips',
    'ai.copilotTitle': 'Copilot',
    'ai.copilotSubtitle': 'Ask anything about your restaurant',
    'ai.copilotPlaceholder': 'e.g. What were my best sellers yesterday?',
    'ai.copilotSend': 'Send',
    'ai.copilotThinking': 'Thinking…',
    'ai.copilotError': 'The copilot could not answer — try again',
    'ai.copilotSuggest1': 'What were my best sellers yesterday?',
    'ai.copilotSuggest2': 'How is this week vs last week?',
    'ai.copilotSuggest3': 'Which items are low on stock?',
    'ai.copilotSuggest4': 'Summarize my top waiter by sales',
    'ai.providerZai': 'Z.ai',
  },
  ar: {
    'ai.briefingTitle': 'الموجز الصباحي',
    'ai.briefingSubtitle': 'ملخص ذكي لأداء الأمس',
    'ai.briefingRefresh': 'تحديث',
    'ai.briefingRetry': 'إعادة المحاولة',
    'ai.briefingCached': 'مخزن مؤقتًا',
    'ai.briefingOffline': 'الموجز الذكي غير متاح حاليًا',
    'ai.statRevenue': 'الإيرادات',
    'ai.statOrders': 'الطلبات',
    'ai.statAvgCheck': 'متوسط الفاتورة',
    'ai.statTips': 'الإكراميات',
    'ai.copilotTitle': 'المساعد الذكي',
    'ai.copilotSubtitle': 'اسأل أي شيء عن مطعمك',
    'ai.copilotPlaceholder': 'مثال: ما أكثر الأصناف مبيعًا أمس؟',
    'ai.copilotSend': 'إرسال',
    'ai.copilotThinking': 'جارٍ التفكير…',
    'ai.copilotError': 'تعذر على المساعد الإجابة — حاول مجددًا',
    'ai.copilotSuggest1': 'ما أكثر الأصناف مبيعًا أمس؟',
    'ai.copilotSuggest2': 'كيف يسير هذا الأسبوع مقارنة بالماضي؟',
    'ai.copilotSuggest3': 'أي الأصناف قارب على النفاد؟',
    'ai.copilotSuggest4': 'لخّص أداء أفضل نادل في المبيعات',
    'ai.providerZai': 'Z.ai',
  },
}
