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

    // R22 self-registration (name + PIN, service roles)
    'auth.registerLink': 'New staff member? Create an account',
    'auth.registerTitle': 'Create account',
    'auth.registerSub':
      'Enter your name and a 6-digit PIN — you will use this PIN to sign in every shift',
    'auth.registerName': 'Full name',
    'auth.registerNamePlaceholder': 'e.g. Sara Mahmoud',
    'auth.registerRole': 'Role',
    'auth.registerPin': '6-digit PIN',
    'auth.registerPinConfirm': 'Confirm PIN',
    'auth.registerSubmit': 'Create account',
    'auth.registerCreating': 'Creating account…',
    'auth.registerBack': 'Back to sign in',
    'auth.registerSuccess': 'Account created — welcome, {name}',
    'auth.registerNameShort': 'Enter your full name (at least 2 characters)',
    'auth.registerPinInvalid': 'PIN must be exactly 6 digits',
    'auth.registerPinMismatch': 'PINs do not match',
    'auth.registerRoleWaiter': 'Waiter — takes orders at tables',
    'auth.registerRoleKitchen': 'Kitchen — prepares the orders',
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

    // R22 self-registration (name + PIN, service roles)
    'auth.registerLink': 'موظف جديد؟ أنشئ حساباً',
    'auth.registerTitle': 'إنشاء حساب',
    'auth.registerSub':
      'أدخل اسمك ورمزاً سرياً من 6 أرقام — ستستخدم هذا الرمز للدخول في كل مرة',
    'auth.registerName': 'الاسم الكامل',
    'auth.registerNamePlaceholder': 'مثال: سارة محمود',
    'auth.registerRole': 'الدور',
    'auth.registerPin': 'رمز سري من 6 أرقام',
    'auth.registerPinConfirm': 'تأكيد الرمز السري',
    'auth.registerSubmit': 'إنشاء الحساب',
    'auth.registerCreating': 'جارٍ إنشاء الحساب…',
    'auth.registerBack': 'العودة لتسجيل الدخول',
    'auth.registerSuccess': 'تم إنشاء الحساب — أهلاً {name}',
    'auth.registerNameShort': 'أدخل اسمك الكامل (حرفان على الأقل)',
    'auth.registerPinInvalid': 'يجب أن يكون الرمز السري 6 أرقام بالضبط',
    'auth.registerPinMismatch': 'الرمزان السريان غير متطابقين',
    'auth.registerRoleWaiter': 'نادل — يستقبل الطلبات على الطاولات',
    'auth.registerRoleKitchen': 'مطبخ — يحضّر الطلبات',
  },
}
