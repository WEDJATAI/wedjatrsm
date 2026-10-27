import type { DictPair } from '../index'

// ─── r65 dictionary — attendance-gated sign-in, developer-PIN gates,
// cancel-after-close, service-fee removal copy, attendance-connected
// payroll (days + deductions), and the Deductions control center.
// Owner: r65 (main agent). Keys are flat with dot namespaces.

export const r65Dict: DictPair = {
  en: {
    // ── attendance-gated sign-in (login refusal message) ──
    'auth.attendanceRequired':
      'You must check in (attendance) before signing in — use the Employee check-in tab',

    // ── cancel a CLOSED (paid) check — manager/developer + developer PIN ──
    'pos.cancelPaidTitle': 'Cancel a closed check?',
    'pos.cancelPaidDesc':
      'This check is already PAID. Cancelling it reverses the money taken (a negative payment is recorded) and marks the order cancelled. Only a manager or the developer can do this, with the developer PIN.',
    'pos.cancelPaidAction': 'Cancel check',
    'pos.cancelPaidPinLabel': 'Developer PIN',
    'pos.cancelPaidDone': 'Closed check #{order} cancelled — EGP {amount} reversed',
    'pos.cancelPaidBtn': 'Cancel check',

    // ── payroll: attendance-connected salary columns ──
    'r17.payroll.days': 'Days',
    'r17.payroll.salary': 'Salary/mo',
    'r17.payroll.setSalary': 'Set monthly salary',
    'r17.payroll.salaryInvalid': 'Enter a valid monthly salary (0 or more)',
    'r17.payroll.salarySaved': 'Monthly salary saved',
    'r17.payroll.basePay': 'Base pay',
    'r17.payroll.deductions': 'Deductions',
    'r17.payroll.netPay': 'Net pay',
    'r17.payroll.totalDeductions': 'Total deductions',
    'r17.payroll.totalNet': 'Total net pay',
    'r17.payroll.latenessDeduction': 'Lateness',
    'r17.payroll.manualDeductions': 'Manual',
    'r17.payroll.rulesNote':
      'Lateness deductions follow the rules set in Deductions (Admin menu). Monthly salary takes precedence over the hourly rate.',

    // ── deductions control center (new module) ──
    'r65.deductions.title': 'Salary Deductions',
    'r65.deductions.subtitle':
      'Lateness rules and manual deductions applied to staff salaries — connected to attendance days and hours',
    'r65.deductions.rulesTitle': 'Lateness rules',
    'r65.deductions.rulesEnabled': 'Deduct for lateness',
    'r65.deductions.rulesPerMinute': 'Deduction per late minute (EGP)',
    'r65.deductions.rulesPerOccurrence': 'Deduction per late arrival (EGP)',
    'r65.deductions.rulesCap': 'Monthly cap per staff member (EGP, 0 = no cap)',
    'r65.deductions.rulesGraceNote':
      'A check-in counts as late after the 15-minute system grace (set at check-in time).',
    'r65.deductions.rulesSaved': 'Lateness rules saved',
    'r65.deductions.rulesComputeNote':
      'The lateness deduction is computed live from these rules and each staff member\u2019s attendance — changing the rules updates every report immediately.',
    'r65.deductions.tableTitle': 'Staff deductions — {month}',
    'r65.deductions.user': 'Team member',
    'r65.deductions.days': 'Days',
    'r65.deductions.hours': 'Hours',
    'r65.deductions.late': 'Late',
    'r65.deductions.latenessDeduction': 'Lateness deduction',
    'r65.deductions.manualDeductions': 'Manual deductions',
    'r65.deductions.total': 'Total',
    'r65.deductions.addDeduction': 'Add deduction',
    'r65.deductions.empty': 'No staff activity this month',
    'r65.deductions.emptyHint':
      'Staff appear here once they clock in (attendance) or have a deduction recorded.',
    'r65.deductions.addTitle': 'Add deduction — {name}',
    'r65.deductions.addDesc': 'Recorded against {month} payroll. The reason is kept in the activity log.',
    'r65.deductions.amount': 'Amount (EGP)',
    'r65.deductions.reason': 'Reason',
    'r65.deductions.reasonPlaceholder': 'e.g. absence, damage, advance…',
    'r65.deductions.needAmount': 'Enter an amount greater than zero',
    'r65.deductions.needReason': 'A reason is required',
    'r65.deductions.created': 'Deduction recorded',
    'r65.deductions.deleted': 'Deduction removed',
    'r65.deductions.deleteConfirm': 'Remove this deduction?',
    'r65.deductions.deleteDesc': 'The deduction is removed from {month} payroll. This is audited.',
    'r65.deductions.recordedBy': 'by {name}',
    'r65.deductions.totalsRow': 'Totals',
    'r65.deductions.perMinuteShort': 'EGP {amount}/min',
    'r65.deductions.perOccurrenceShort': 'EGP {amount} per late arrival',
    'r65.deductions.rulesOff': 'Lateness deductions are OFF',
    'r65.deductions.graceShort': '15 min grace',

    // ── settings: the security card is now informational (developer PIN) ──
    'settings.securityDevPinNote':
      'Removing items from an order and approving discounts are protected by the DEVELOPER PIN — the same PIN used at the Developer corner of the sign-in screen. Change it from there (Developer corner → change PIN).',
  },
  ar: {
    // ── البحضور شرط قبل تسجيل الدخول ──
    'auth.attendanceRequired':
      'يجب تسجيل الحضور أولًا قبل تسجيل الدخول — استخدم تبويب تسجيل حضور الموظفين',

    // ── إلغاء فاتورة مغلقة (مدفوعة) — مدير/مطور + رمز المطور ──
    'pos.cancelPaidTitle': 'إلغاء فاتورة مغلقة؟',
    'pos.cancelPaidDesc':
      'هذه الفاتورة مدفوعة بالفعل. الإلغاء يُرجع المبالغ المقبوضة (يُسجل دفعة سالبة) ويحوّل الطلب إلى ملغي. المدير أو المطور فقط يمكنه ذلك، برمز المطور.',
    'pos.cancelPaidAction': 'إلغاء الفاتورة',
    'pos.cancelPaidPinLabel': 'رمز المطور',
    'pos.cancelPaidDone': 'تم إلغاء الفاتورة المغلقة #{order} — تم إرجاع {amount} جنيه',
    'pos.cancelPaidBtn': 'إلغاء الفاتورة',

    // ── الرواتب: أعمدة الراتب المرتبط بالحضور ──
    'r17.payroll.days': 'أيام',
    'r17.payroll.salary': 'راتب/شهر',
    'r17.payroll.setSalary': 'تحديد الراتب الشهري',
    'r17.payroll.salaryInvalid': 'أدخل راتبًا شهريًا صحيحًا (0 أو أكثر)',
    'r17.payroll.salarySaved': 'تم حفظ الراتب الشهري',
    'r17.payroll.basePay': 'الأجر الأساسي',
    'r17.payroll.deductions': 'الخصومات',
    'r17.payroll.netPay': 'الصافي',
    'r17.payroll.totalDeductions': 'إجمالي الخصومات',
    'r17.payroll.totalNet': 'إجمالي الصافي',
    'r17.payroll.latenessDeduction': 'تأخير',
    'r17.payroll.manualDeductions': 'يدوي',
    'r17.payroll.rulesNote':
      'خصومات التأخير تتبع القواعد المحددة في صفحة الخصومات (قائمة الإدارة). الراتب الشهري له الأولوية على أجر الساعة.',

    // ── مركز الخصومات (وحدة جديدة) ──
    'r65.deductions.title': 'خصومات الرواتب',
    'r65.deductions.subtitle':
      'قواعد التأخير والخصومات اليدوية على رواتب الموظفين — مرتبطة بأيام وساعات الحضور',
    'r65.deductions.rulesTitle': 'قواعد التأخير',
    'r65.deductions.rulesEnabled': 'الخصم للتأخير',
    'r65.deductions.rulesPerMinute': 'الخصم عن كل دقيقة تأخير (جنيه)',
    'r65.deductions.rulesPerOccurrence': 'الخصم عن كل مرة تأخير (جنيه)',
    'r65.deductions.rulesCap': 'الحد الشهري الأقصى للموظف (جنيه، 0 = بلا حد)',
    'r65.deductions.rulesGraceNote':
      'يُحتسب التسجيل متأخرًا بعد مهلة النظام البالغة 15 دقيقة (تُحدد وقت تسجيل الحضور).',
    'r65.deductions.rulesSaved': 'تم حفظ قواعد التأخير',
    'r65.deductions.rulesComputeNote':
      'يُحسب خصم التأخير مباشرة من هذه القواعد ومن حضور كل موظف — أي تعديل على القواعد ينعكس فورًا على كل التقارير.',
    'r65.deductions.tableTitle': 'خصومات الموظفين — {month}',
    'r65.deductions.user': 'الموظف',
    'r65.deductions.days': 'أيام',
    'r65.deductions.hours': 'ساعات',
    'r65.deductions.late': 'تأخير',
    'r65.deductions.latenessDeduction': 'خصم التأخير',
    'r65.deductions.manualDeductions': 'خصومات يدوية',
    'r65.deductions.total': 'الإجمالي',
    'r65.deductions.addDeduction': 'إضافة خصم',
    'r65.deductions.empty': 'لا يوجد نشاط للموظفين هذا الشهر',
    'r65.deductions.emptyHint':
      'يظهر الموظفون هنا بعد تسجيل حضورهم أو عند تسجيل خصم لهم.',
    'r65.deductions.addTitle': 'إضافة خصم — {name}',
    'r65.deductions.addDesc': 'يُسجل على رواتب {month}. يُحفظ السبب في سجل النشاط.',
    'r65.deductions.amount': 'المبلغ (جنيه)',
    'r65.deductions.reason': 'السبب',
    'r65.deductions.reasonPlaceholder': 'مثال: غياب، تلف، سلفة…',
    'r65.deductions.needAmount': 'أدخل مبلغًا أكبر من صفر',
    'r65.deductions.needReason': 'السبب مطلوب',
    'r65.deductions.created': 'تم تسجيل الخصم',
    'r65.deductions.deleted': 'تم إزالة الخصم',
    'r65.deductions.deleteConfirm': 'إزالة هذا الخصم؟',
    'r65.deductions.deleteDesc': 'سيُزال الخصم من رواتب {month}. هذا الإجراء يُسجل في سجل النشاط.',
    'r65.deductions.recordedBy': 'بواسطة {name}',
    'r65.deductions.totalsRow': 'الإجماليات',
    'r65.deductions.perMinuteShort': '{amount} ج/دقيقة',
    'r65.deductions.perOccurrenceShort': '{amount} جنيه عن كل تأخير',
    'r65.deductions.rulesOff': 'خصومات التأخير متوقفة',
    'r65.deductions.graceShort': 'مهلة 15 دقيقة',

    // ── الإعدادات: بطاقة الأمان أصبحت معلوماتية (رمز المطور) ──
    'settings.securityDevPinNote':
      'حذف الأصناف من الطلب واعتماد الخصومات محميان برمز المطور — نفس الرمز المستخدم في ركن المطور بشاشة الدخول. غيّره من هناك (ركن المطور → تغيير الرمز).',
  },
}
