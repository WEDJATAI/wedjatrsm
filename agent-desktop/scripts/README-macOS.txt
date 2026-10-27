RSM Platform — macOS full desktop version (universal: Intel x64 + Apple Silicon arm64)
======================================================================================

English
-------
**What this is:** the FULL RSM restaurant platform for your Mac — the same
complete desktop version as Windows. One double-click installs everything:
the whole app runs locally on your Mac (http://localhost:3000), keeps your
data in TWO-WAY sync with the cloud (GitHub · Vercel · Turso · Neon ·
Inngest), and shows a live status dashboard at http://127.0.0.1:9753

The installer is a UNIVERSAL binary — it runs natively on Intel Macs
(x86_64) AND Apple-Silicon Macs (M1/M2/M3/M4). No Rosetta needed.

**Requirements:** any Mac from 2012 onward, macOS 10.15 or newer, internet
for the one-time setup (it downloads the Bun runtime and your data).

**First run (once):**
1. Double-click `RSM-Platform-Setup-macOS.zip` to unzip it (if your browser
   did not already do that).
2. macOS blocks apps it cannot verify, because the installer is not
   notarized. Use ONE of these once:
   - Right-click `RSM Platform Setup.app` → **Open** → **Open**
     (macOS 10.15 – 14), or
   - System Settings → Privacy & Security → **Open Anyway** (macOS 15+), or
   - Terminal (works on every version):
     `xattr -dr com.apple.quarantine ~/Downloads/RSM\ Platform\ Setup.app && open ~/Downloads/RSM\ Platform\ Setup.app`
3. The installer does everything else by itself:
   - installs to `~/Applications/RSM Cloud Agent.app` (no admin password),
   - creates a Desktop shortcut and a Login Item (starts with your Mac),
   - installs the full platform into `~/.rsm-platform` (app + your data),
   - enrolls with the cloud and starts two-way sync immediately,
   - opens the live dashboard, then the platform itself, in your browser.

**Upgrading from the old thin agent:** open the dashboard
(http://127.0.0.1:9753), click **Stop agent**, then run this installer once
more — it replaces the old agent in place (same app, same Login Item, your
data is kept).

**Where things live:**
- App:        `~/Applications/RSM Cloud Agent.app`
- Platform:   `~/.rsm-platform` (the full app + database)
- Data:       `~/Library/Application Support/RSMCloudAgent`
- Platform:   http://localhost:3000 · Dashboard: http://127.0.0.1:9753

**Uninstall:** open the dashboard → **Stop agent**, drag
`~/Applications/RSM Cloud Agent.app` to the Trash, remove the Desktop
shortcut, remove the Login Item (System Settings → General → Login Items),
then delete `~/.rsm-platform` and the data folder above.

العربية
-------
**ما هذا:** منصة RSM الكاملة لجهاز الماك — نفس النسخة الكاملة بتاعة
الويندوز. دوبل كليك واحدة تثبّت كل حاجة: التطبيق كله يشتغل محليًا على
الماك (http://localhost:3000)، وبياناتك متزامنة في الاتجاهين مع السحابة
(GitHub · Vercel · Turso · Neon · Inngest)، مع لوحة حالة حية على
http://127.0.0.1:9753

المثبّت نسخة يونيفرسال — يشتغل أصليًا على ماك إنتل (x86_64) وماك
Apple Silicon (M1/M2/M3/M4) من غير Rosetta.

**المتطلبات:** أي ماك من 2012 أو أحدث، macOS 10.15 أو أحدث، وإنترنت
للإعداد الأول مرة واحدة (بيحمّل runtime Bun وبياناتك).

**أول تشغيل (مرة واحدة):**
1. فك ضغط `RSM-Platform-Setup-macOS.zip` بالدوبل كليك (لو المتصفح مافكّهوش).
2. نظام ماك يمنع التطبيقات غير الموثقة — اعمل واحدة من دول مرة واحدة:
   - كليك يمين على `RSM Platform Setup.app` ← **فتح** ← **فتح**
     (macOS 10.15 – 14)، أو
   - إعدادات النظام ← الخصوصية والأمان ← **فتح بأي حال** (macOS 15+)، أو
   - من التيرمنال (بيشتغل على كل النسخ):
     `xattr -dr com.apple.quarantine ~/Downloads/RSM\ Platform\ Setup.app && open ~/Downloads/RSM\ Platform\ Setup.app`
3. المثبّت يعمل كل حاجة بنفسه:
   - يثبّت نفسه في `~/Applications/RSM Cloud Agent.app` (من غير باسوورد)،
   - يعمل اختصار على الديسكتوب ويشتغل تلقائيًا مع تشغيل الماك،
   - يثبّت المنصة كاملة في `~/.rsm-platform` (التطبيق + قاعدة بياناتك)،
   - يسجّل مع السحابة ويبدأ المزامنة في الاتجاهين فورًا،
   - يفتح لوحة الحالة وبعدها المنصة نفسها في المتصفح.

**الترقية من الوكيل القديم:** افتح لوحة الحالة
(http://127.0.0.1:9753)، دوس **Stop agent**، وشغّل المثبّت ده مرة تانية —
هيستبدل الوكيل القديم في مكانه (نفس التطبيق، نفس إعداد التشغيل التلقائي،
وبياناتك محفوظة).

**إلغاء التثبيت:** افتح لوحة الحالة ← **Stop agent**، واسحب
`~/Applications/RSM Cloud Agent.app` إلى سلة المهملات، واحذف اختصار
الديسكتوب وعنصر تسجيل الدخول (إعدادات النظام ← عام ← عناصر تسجيل
الدخول)، بعدين احذف `~/.rsm-platform` ومجلد البيانات في
`~/Library/Application Support/RSMCloudAgent`.
