import type { DictPair } from '../index'

// ─── Auth / login dictionary (owner: agent 6-d) ─────────────────────
// 6-d may add keys here; everyone may read. Login + employee check-in card.

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
  },
}
