RSM Cloud Agent — macOS (Intel x64)
====================================

English
-------
**What this is:** the RSM restaurant-platform cloud agent for Intel-based
Macs (x86_64). It installs itself, enrolls with your cloud and keeps your
data in TWO-WAY sync with GitHub · Vercel · Turso · Neon · Inngest
automatically (every 30 seconds), with a live dashboard at
http://127.0.0.1:9753

**Requirements:** an Intel-based Mac (2012 or newer), macOS 10.13 or newer.
(Apple-Silicon Macs run it through Rosetta 2 as well.)

**First run (once):**
1. Double-click `RSM-macOS-Agent-Setup.zip` to unzip it (if your browser
   did not already do that).
2. macOS blocks apps it cannot verify, because the agent is not
   notarized. Use ONE of these once:
   - Right-click `RSM-macOS-Agent-Setup.app` → **Open** → **Open**
     (macOS 10.15 – 14), or
   - System Settings → Privacy & Security → **Open Anyway** (macOS 15), or
   - Terminal (works on every version):
     `xattr -dr com.apple.quarantine ~/Downloads/RSM-macOS-Agent-Setup.app && open ~/Downloads/RSM-macOS-Agent-Setup.app`
3. The installer does everything else by itself:
   - installs to `~/Applications/RSM Cloud Agent.app` (no admin password),
   - creates a Desktop shortcut,
   - registers a Login Item so it starts with your Mac,
   - enrolls with the cloud and starts syncing immediately,
   - opens the live dashboard in your browser.

**Where things live:**
- App:        `~/Applications/RSM Cloud Agent.app`
- Data:       `~/Library/Application Support/RSMCloudAgent`
- Dashboard:  http://127.0.0.1:9753

**Uninstall:** drag `~/Applications/RSM Cloud Agent.app` to the Trash,
remove the Desktop shortcut, remove the Login Item (System Settings →
General → Login Items) and delete the data folder above.

العربية
-------
**ما هذا:** وكيل السحابة لمنصة RSM لأجهزة ماك إنتل (x86_64). يثبّت نفسه
ويسجّل مع السحابة ويزامن بياناتك في الاتجاهين مع GitHub وVercel وTurso
وNeon وInngest تلقائيًا (كل 30 ثانية)، مع لوحة حالة حية على
http://127.0.0.1:9753

**المتطلبات:** ماك بمعالج إنتل (2012 أو أحدث)، macOS 10.13 أو أحدث.

**أول تشغيل (مرة واحدة):**
1. فك ضغط `RSM-macOS-Agent-Setup.zip` بالدوبل كليك (لو المتصفح مافكّهوش).
2. نظام ماك يمنع التطبيقات غير الموثقة — اعمل واحدة من دول مرة واحدة:
   - كليك يمين على `RSM-macOS-Agent-Setup.app` ← **فتح** ← **فتح**
     (macOS 10.15 – 14)، أو
   - إعدادات النظام ← الخصوصية والأمان ← **فتح بأي حال** (macOS 15)، أو
   - من التيرمنال (بيشتغل على كل النسخ):
     `xattr -dr com.apple.quarantine ~/Downloads/RSM-macOS-Agent-Setup.app && open ~/Downloads/RSM-macOS-Agent-Setup.app`
3. المثبّت يعمل كل حاجة بنفسه:
   - يثبّت نفسه في `~/Applications/RSM Cloud Agent.app` (من غير باسوورد)،
   - يعمل اختصار على الديسكتوب،
   - يسجّل نفسه ليشتغل تلقائيًا مع تشغيل الماك،
   - يسجّل مع السحابة ويبدأ المزامنة فورًا،
   - يفتح لوحة الحالة في المتصفح.

**إلغاء التثبيت:** اسحب `~/Applications/RSM Cloud Agent.app` إلى سلة
المهملات، واحذف اختصار الديسكتوب، وعنصر تسجيل الدخول (إعدادات النظام ←
عام ← عناصر تسجيل الدخول)، واحذف مجلد البيانات في
`~/Library/Application Support/RSMCloudAgent`.
