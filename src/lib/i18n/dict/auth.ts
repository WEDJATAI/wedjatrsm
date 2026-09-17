import type { DictPair } from '../index'

// ─── Auth / login dictionary (owner: agent 6-d) ─────────────────────
// 6-d may add keys here; everyone may read. Login + employee check-in card.
// Reused from common.ts: common.email, common.password, common.clear,
// common.done, attendance.username, attendance.pin, attendance.checkIn,
// attendance.checkOut, attendance.checkedInAt/checkedOutAt/worked,
// attendance.lateBy/onTime/welcome/roleDetected, attendance.shift.

export const authDict: DictPair = {
  en: {
    'auth.title': 'Sign in',
    'auth.subtitle': 'Restaurant Management System',
    'auth.welcome': 'Welcome back',
    'auth.welcomeSub': 'Sign in to your account to continue',
    'auth.emailTab': 'Email',
    'auth.pinTab': 'PIN',
    'auth.signIn': 'Sign in',
    'auth.signingIn': 'Signing in…',
    'auth.demo': 'Demo credentials',
    'auth.checkInTab': 'Employee check-in',
    'auth.checkInTitle': 'Employee check-in',
    'auth.checkInSub': 'Enter your name and PIN — your role is detected automatically',
    'auth.checkInSuccess': 'Checked in',
    'auth.checkOutSuccess': 'Checked out',
    'auth.enterName': 'Your name or email',
    'auth.enterPin': 'PIN',

    // keypad / keyboard a11y + hints
    'auth.pinStatus': 'PIN: {n} of {total} digits entered',
    'auth.digit': 'Digit {d}',
    'auth.backspace': 'Backspace',

    // toasts / error fallbacks
    'auth.welcomeBack': 'Welcome back, {name}',
    'auth.enterEmailPassword': 'Please enter your email and password',
    'auth.loginFailed': 'Login failed',
    'auth.nameRequired': 'Please enter your name or email first',
    'auth.pinIncomplete': 'Enter your 6-digit PIN',
    'auth.checkInFailed': 'Check-in failed',
    'auth.checkOutFailed': 'Check-out failed',
    'auth.checkingIn': 'Checking in…',
    'auth.checkingOut': 'Checking out…',

    // demo credentials card + one-click sign-in (R18 dev convenience)
    'auth.demoHint':
      'Employees: check in from the “Employee check-in” tab with your name and PIN.',
    'auth.oneClick': 'One-click sign-in',
    'auth.whoIsUsing': 'Who is using this device?',
    'auth.whoIsUsingSub':
      'Select your name — checks and item moves will be attributed to you.',
    'auth.continueAsAccount': 'Continue as {name} (account level)',
    'auth.oneClickHint': 'Tap a role to sign in instantly — demo & development convenience.',
    'auth.oneClickA11y': 'Sign in instantly as {role}',
    'auth.roleAdmin': 'Admin',
    'auth.roleWaiter': 'Waiter',
    'auth.roleKitchen': 'Kitchen',
  },
  ar: {
    'auth.title': 'تسجيل الدخول',
    'auth.subtitle': 'نظام إدارة المطاعم',
    'auth.welcome': 'أهلاً بعودتك',
    'auth.welcomeSub': 'سجّل الدخول إلى حسابك للمتابعة',
    'auth.emailTab': 'البريد الإلكتروني',
    'auth.pinTab': 'الرمز السري',
    'auth.signIn': 'تسجيل الدخول',
    'auth.signingIn': 'جارٍ تسجيل الدخول…',
    'auth.demo': 'بيانات تجريبية',
    'auth.checkInTab': 'حضور الموظفين',
    'auth.checkInTitle': 'حضور الموظفين',
    'auth.checkInSub': 'أدخل اسمك والرمز السري — سيتم التعرف على دورك تلقائياً',
    'auth.checkInSuccess': 'تم تسجيل الحضور',
    'auth.checkOutSuccess': 'تم تسجيل الانصراف',
    'auth.enterName': 'اسمك أو بريدك الإلكتروني',
    'auth.enterPin': 'الرمز السري',

    // keypad / keyboard a11y + hints
    'auth.pinStatus': 'الرمز السري: تم إدخال {n} من {total} أرقام',
    'auth.digit': 'رقم {d}',
    'auth.backspace': 'حذف',

    // toasts / error fallbacks
    'auth.welcomeBack': 'أهلاً بعودتك، {name}',
    'auth.enterEmailPassword': 'يرجى إدخال البريد الإلكتروني وكلمة المرور',
    'auth.loginFailed': 'فشل تسجيل الدخول',
    'auth.nameRequired': 'أدخل اسمك أو بريدك الإلكتروني أولاً',
    'auth.pinIncomplete': 'أدخل الرمز السري المكوّن من 6 أرقام',
    'auth.checkInFailed': 'تعذّر تسجيل الحضور',
    'auth.checkOutFailed': 'تعذّر تسجيل الانصراف',
    'auth.checkingIn': 'جارٍ تسجيل الحضور…',
    'auth.checkingOut': 'جارٍ تسجيل الانصراف…',

    // demo credentials card + one-click sign-in (R18 dev convenience)
    'auth.demoHint': 'للموظفين: سجّلوا الحضور من تبويب «حضور الموظفين» بالاسم والرمز السري.',
    'auth.oneClick': 'دخول بضغطة واحدة',
    'auth.whoIsUsing': 'من يستخدم هذا الجهاز؟',
    'auth.whoIsUsingSub': 'اختر اسمك — سيتم نسب الفواتير ونقل الأصناف إليك.',
    'auth.continueAsAccount': 'المتابعة باسم {name} (مستوى الحساب)',
    'auth.oneClickHint': 'اضغط على الدور للدخول فوراً — للاستخدام التجريبي والتطوير.',
    'auth.oneClickA11y': 'الدخول فوراً كـ {role}',
    'auth.roleAdmin': 'مدير',
    'auth.roleWaiter': 'نادل',
    'auth.roleKitchen': 'مطبخ',
  },
}
