# تقرير إتمام المرحلة — Remediation Pass 3: Redis-Backed Rate Limiting (SEC-004)

## اسم المرحلة ورقمها

**Remediation Pass 3 — Redis-Backed Rate Limiting (SEC-004)**، بناءً على المستند `remediation-pass-3-redis.md`، وامتدادًا لتقريري `ENTERPRISE_BACKEND_AUDIT_REPORT.md` و`Docs/reports/remediation-pass-2-mfa-report.md`.

**التاريخ:** 2026-08-02

**الحالة الحالية عند كتابة هذا التقرير:** الكود مكتمل بالكامل، تم فحصه بشكل ثابت (static)، وتم تشغيل مجموعة اختبارات جديدة فعليًا عبر Jest داخل هذا الـ sandbox بنجاح تام. **لم يتم بعد** تأكيد عدم وجود أي regression على باقي المجموعة الكاملة (integration tests + وحدات mongoose) عبر GitHub Actions الحقيقي — هذا التقرير لن يُعتبر "مؤكد بالكامل" (fully verified) إلا بعد استلام نتيجة الـ CI الحقيقية بالأرقام الدقيقة (Test Suites / Tests)، بنفس المعيار المتبع في كل مرحلة سابقة.

---

## الهدف من المرحلة

استبدال مخزن (store) الـ rate-limiting القائم بالكامل على الذاكرة المحلية (in-memory) بمخزن مشترك (shared) مبني على Redis، حتى يظل الـ rate limiting فعّالًا بمجرد نشر الـ backend على أكثر من instance واحد في نفس الوقت — لأن أي in-memory store لا يرى إلا الطلبات التي وصلت لنفس الـ process، فإذا كان هناك أكثر من سيرفر يعمل خلف load balancer، يمكن لمهاجم تجاوز الحد المسموح به بسهولة عبر توزيع الطلبات على أكثر من instance.

هذا هو الإصلاح المؤجَّل رسميًا SEC-004 من التقرير الأصلي `ENTERPRISE_BACKEND_AUDIT_REPORT.md`، والذي تم تأجيله عمدًا في كل من Remediation Pass 1 وPass 2 لحين وجود نطاق عمل (scope) واضح ومحدد له — وهو ما تم توفيره في `remediation-pass-3-redis.md`.

---

## الملفات والمجلدات اللي اتعملت فعلياً

### ملفات جديدة (Created)
- `src/shared/utils/redis-rate-limit-store.js` — الـ Store الجديد المشترك (الملف الأساسي في هذه المرحلة).
- `tests/unit/redis-rate-limit-store.test.js` — اختبارات الوحدة (unit tests) الجديدة للـ Store.
- `Docs/reports/remediation-pass-3-redis-report.md` — هذا التقرير نفسه.

### ملفات معدَّلة (Modified)
- `src/config/env.config.js` — إضافة متغيرَي البيئة الاختياريَّين `UPSTASH_REDIS_REST_URL` و`UPSTASH_REDIS_REST_TOKEN`.
- `src/middleware/rate-limiter.middleware.js` — الـ limiter العام (global) أصبح يستخدم الـ store المشترك الجديد بدلاً من الـ store الافتراضي الضمني الذي كان ينشئه express-rate-limit تلقائيًا.
- `src/modules/auth/auth.routes.js` — أربعة limiters (`otpStore`, `loginStore`, `passwordResetStore`, `refreshTokenStore`) أصبحوا يستخدمون الـ factory المشترك بدلاً من إنشاء `MemoryStore` مباشرة.
- `src/modules/auth/mfa.routes.js` — ثلاثة limiters من Remediation Pass 2 (`setupStore`, `verifySetupStore`, `verifyLoginStore`) تم تحديثهم بنفس الطريقة.
- `src/modules/public-site/public.routes.js` — اثنان limiters (`browsingStore`, `leadStore`) تم تحديثهم بنفس الطريقة.
- `.env.example` — إضافة توثيق للمتغيرين الجديدين، مع توضيح أنهما اختياريان تمامًا.

لم يتم تعديل أي ملف آخر خارج هذه القائمة — لم تُلمَس منطق أي limiter (القيم القصوى `max`، أو مدة النافذة `windowMs`) في أي من الملفات أعلاه، فقط مصدر الـ `store` الذي يُمرَّر لكل limiter.

---

## شرح تفصيلي لكل خطوة اتنفذت

### 1. فحص البنية الحالية قبل البدء

قبل كتابة أي كود، تم قراءة `rate-limiter.middleware.js` والملفات الأربعة التي تحتوي على limiters (`auth.routes.js`, `mfa.routes.js`, `public.routes.js`, والـ global limiter) للتأكد من فهم النمط الحالي بالضبط: كل limiter كان يُنشئ نسخة خاصة به من `MemoryStore` (من مكتبة `express-rate-limit` نفسها) فقط لغرض واحد — السماح للاختبارات (tests) باستدعاء `store.resetAll()` بين كل مجموعة اختبارات، لأن كل الطلبات في بيئة الاختبار (supertest) تأتي من نفس الـ IP المُحاكى، فبدون إعادة التصفير كانت أول 3 طلبات OTP في كامل تشغيل الاختبارات تستهلك حد كل الاختبارات اللاحقة.

كما تم التأكد من أن مكتبة `@upstash/redis` (الإصدار `1.34.3` في `package.json`، والإصدار الفعلي المُثبَّت `1.38.0`) كانت بالفعل موجودة كـ dependency في المشروع من قبل (تُستخدم في مكان آخر غير مرتبط، على الأرجح لعمل LangChain الخاص بـ vector store)، وتم التأكد من نسخة `express-rate-limit` المُثبَّتة (`7.5.1`) وقراءة تعريف الـ `Store` interface الخاص بها (`node_modules/express-rate-limit/dist/index.d.ts`) لمعرفة الدوال المطلوب تنفيذها بالضبط: `init`, `get`, `increment`, `decrement`, `resetKey`, وبشكل اختياري `resetAll`/`shutdown`.

### 2. بناء `redis-rate-limit-store.js`

هذا هو الملف الجوهري في هذه المرحلة. يحتوي على:

- **دالة factory واحدة مُصدَّرة، `createRateLimitStore(prefix)`** — وهي النقطة الوحيدة التي يجب أن يمر بها أي limiter في المشروع لإنشاء الـ store الخاص به. هذا يضمن أن قرار "استخدام Redis أم لا" مُتخذ في مكان واحد فقط، ولا يمكن لأي route مستقبلي تجاوز آلية fallback الإلزامية بالخطأ.
- **كلاس `RedisRateLimitStore`** — تنفيذ فعلي لـ الـ `Store` interface مبني فوق `@upstash/redis`، باستخدام خوارزمية "fixed window" بالضبط مثل `MemoryStore` نفسها (نفس السلوك الظاهر للمستخدم، فقط مكان تخزين العداد يتغير):
  - `increment(key)`: يستخدم أمر `INCR` في Redis. عند أول hit في نافذة زمنية جديدة (عندما يرجع `INCR` القيمة `1`)، يتم ضبط الـ TTL على المفتاح عبر `EXPIRE` بمدة تساوي `windowMs` محوَّلة لثوانٍ. هذا التمييز بين "أول hit" و"hit لاحق" مهم جدًا: لو تم إعادة ضبط الـ TTL في كل مرة، كانت النافذة الزمنية ستستمر في "التدحرج" (rolling window) بدلاً من الانتهاء في وقت ثابت — وهذا ليس نفس سلوك `MemoryStore` الأصلي، وكان سيجعل الـ limiter الجديد أكثر صرامة من القديم بدون داعٍ.
  - `decrement(key)`: يتحقق أولًا من القيمة الحالية عبر `GET`، ولا يستدعي `DECR` إلا إذا كانت القيمة أكبر من صفر — لأن أمر `DECR` في Redis يمكن أن يجعل القيمة سالبة، بينما `MemoryStore` لا يسمح بذلك أبدًا (يوقف عند صفر)، فتم محاكاة نفس السلوك بالضبط.
  - `resetKey(key)`: يحذف المفتاح مباشرة عبر `DEL`.
  - `get(key)`: يرجع `{totalHits, resetTime}` أو `undefined` إذا لم يكن هناك أي سجل للمفتاح.
  - **لم يتم تنفيذ `resetAll()`/`shutdown()` لهذا الكلاس عمدًا** — لأن `resetAll()` الحقيقي على Redis يتطلب أمر `SCAN` على كل المفاتيح تحت بادئة (prefix) معينة، وهو أمر مكلف وغير آمن على قاعدة بيانات حقيقية مشتركة (production)، فقط لدعم راحة الاختبارات. بما أن قرار المنتج رقم 2 يضمن أن أي اختبار في هذا المشروع لن يُشغَّل أبدًا ضد Redis حقيقي (لأن متغيرات البيئة ستكون دائمًا غير موجودة في بيئة الاختبار)، فهذه الدالة غير مطلوبة أصلًا على هذا المسار — وexpress-rate-limit نفسه يتعامل مع غيابها بسلاسة (اختيارية حسب الـ interface نفسه).
- **آلية تسمية (namespacing) المفاتيح** — كل limiter يمرر `prefix` مميز خاص به (مثل `'otp:'`, `'login:'`, `'public-browse:'`) بحيث لا يتصادم عداد أي limiter مع عداد limiter آخر داخل نفس قاعدة بيانات Redis المشتركة. تم اختبار هذا صراحة (انظر قسم الاختبارات).
- **تسجيل (logging) وضع التشغيل مرة واحدة فقط عند الإقلاع** — عبر متغير module-level (`hasLoggedModeOnce`) يضمن ظهور سطر واحد فقط في اللوج يوضح "Redis-backed store active" أو "in-memory fallback"، وليس سطرًا لكل طلب — تحديدًا كما طلبت خطوة التنفيذ رقم 2 في المستند الأصلي ("visible... without being noisy").
- **آلية fallback التلقائية** — الدالة `createRateLimitStore()` تتحقق من `env.redis.isConfigured` (المُحسوبة في `env.config.js`)، وإذا كانت `false`، تُرجع ببساطة `new MemoryStore()` — وهي **نفس الكلاس بالضبط** الذي كان يُستخدم في كل مكان قبل هذه المرحلة، وليس تنفيذًا مخصصًا مشابهًا له. هذا القرار التصميمي هو ما يجعل جملة "لا يوجد أي تغيير سلوكي في بيئة التطوير المحلي أو CI" (من المستند الأصلي) حقيقية فعلًا، وليست مجرد ادعاء — لأن كل استدعاءات `store.resetAll()` الموجودة بالفعل في ملفات الاختبار الحالية (`auth.test.js`, `mfa.test.js`, إلخ) ستستمر بالعمل دون أي تعديل عليها.

### 3. تحديث `env.config.js`

تمت إضافة قسم `redis` جديد إلى الكائن المُصدَّر من `env.config.js`:
```js
redis: {
  isConfigured: Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
  url: process.env.UPSTASH_REDIS_REST_URL || null,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || null,
},
```
**عمدًا لم تتم إضافة هذين المتغيرين إلى `REQUIRED_VARS`** — طبقًا لقرار المنتج رقم 2 الصريح في المستند الأصلي. كما تمت إضافة تحذير (وليس فشلًا قاتلًا/fatal) في حالة وجود أحد المتغيرين فقط دون الآخر (تهيئة جزئية) — بنفس النمط المُستخدم بالفعل مع متغيرات الـ `STORAGE_*` الخمسة في نفس الملف.

### 4. تحديث كل الـ limiters الأربعة

في كل ملف من `auth.routes.js`, `mfa.routes.js`, `public.routes.js`, و`rate-limiter.middleware.js`، تم استبدال:
```js
const { MemoryStore } = require('express-rate-limit');
const xStore = new MemoryStore();
```
بـ:
```js
const { createRateLimitStore } = require('../../shared/utils/redis-rate-limit-store');
const xStore = createRateLimitStore('x:');
```
مع الحفاظ على كل شيء آخر كما هو تمامًا — القيم القصوى (`max`)، مدة النافذة (`windowMs`)، الرسائل، وآلية `router.rateLimitStores` التي تعرض هذه الـ stores للاختبارات — لم يتغير أي من ذلك.

### 5. تحديث `.env.example`

تمت إضافة قسم جديد يوثق `UPSTASH_REDIS_REST_URL` و`UPSTASH_REDIS_REST_TOKEN` مع توضيح صريح أنهما اختياريان تمامًا، وأن غيابهما يعني العودة التلقائية للتخزين المحلي — بدون قيم حقيقية بالطبع، طبقًا لقواعد المشروع بخصوص الأسرار (`CLAUDE.md` القسم 9).

### 6. كتابة الاختبارات

ملف واحد جديد، `tests/unit/redis-rate-limit-store.test.js`، يحتوي على 12 اختبارًا مقسَّمة إلى مجموعتين:

**المجموعة الأولى — منطق الـ Redis store (باستخدام عميل @upstash/redis وهمي/mocked):**
تم عمل mock كامل لمكتبة `@upstash/redis` (لا يوجد أي اتصال شبكة حقيقي على الإطلاق، طبقًا لتعليمات المستند الأصلي الصريحة بعدم إضافة اختبار Redis حي/live). تغطي هذه المجموعة: أن أول `increment()` يضبط الـ TTL مرة واحدة فقط، أن الـ hits اللاحقة لا تُعيد ضبط الـ TTL، أن `decrement()` لا يستدعي `DECR` إذا كانت القيمة صفرًا أو غير موجودة، أن `resetKey()` يحذف المفتاح الصحيح المُسمَّى (namespaced)، أن `get()` يرجع القيم الصحيحة، وأن اثنين limiters بـ prefix مختلف لا يتصادمان أبدًا على نفس مفتاح Redis.

**المجموعة الثانية — آلية fallback التلقائية (قرار المنتج رقم 2):**
تؤكد أن `createRateLimitStore()` يرجع كائن `MemoryStore` حقيقي (وليس `RedisRateLimitStore`) عندما يكون كلا متغيرَي البيئة غائبَين، وأيضًا عندما يكون أحدهما فقط موجودًا (تهيئة جزئية) — وتؤكد أن هذا الـ `MemoryStore` الراجع يعمل فعليًا من طرف لطرف (increment ثم resetAll يعيد التصفير)، بالضبط كما تعتمد عليه كل اختبارات integration الحالية في المشروع.

---

## أي قرارات تقنية اتاخدت أثناء التنفيذ

1. **مشاركة عميل Redis واحد (shared client) بين كل الـ stores، مع تمييز المفاتيح بالـ prefix فقط.** المستند الأصلي لم يحدد صراحة هل يجب أن يكون هناك اتصال Redis واحد مشترك أم اتصال منفصل لكل limiter — تم اختيار عميل واحد مشترك لأن عميل `@upstash/redis` هو REST client بسيط (بدون اتصال مستمر/persistent يحتاج لإدارة pool)، فإنشاء عميل منفصل لكل limiter لن يكون له أي فائدة حقيقية، فقط تكرار غير ضروري.
2. **عدم تنفيذ `resetAll()` على المسار الخاص بـ Redis** (مذكور بالتفصيل في القسم السابق) — قرار مبني على أن `SCAN` على قاعدة بيانات مشتركة حقيقية في production غير آمن، وغير مطلوب أصلًا لأن الاختبارات لن تُشغَّل ضد Redis حقيقي أبدًا حسب قرار المنتج رقم 2.
3. **الـ limiter العام (global limiter) في `rate-limiter.middleware.js` تم تحديثه أيضًا رغم أنه لم يكن يمتلك `store` صريحًا من قبل (كان يعتمد على الـ store الافتراضي الضمني لمكتبة express-rate-limit).** هذا لم يكن مطلوبًا صراحة في قائمة الملفات في المستند الأصلي بنفس التفصيل الذي وُصفت به الـ limiters الأخرى، لكن تم تضمينه لتحقيق الاتساق الكامل ("every limiter" كما ورد في قرار المنتج رقم 3) — بحيث يصبح هذا الـ limiter أيضًا يعمل عبر Redis بمجرد ضبط بيانات Upstash، وليس فقط limiters المسارات الفردية.
4. **صيغة مفتاح Redis:** `sakanify:ratelimit:{prefix}{key}` — تمت إضافة بادئة عامة (`sakanify:ratelimit:`) فوق بادئة كل limiter الخاصة به، حتى تكون كل مفاتيح هذه الميزة قابلة للبحث/الحذف الجماعي بسهولة (عبر `SCAN sakanify:ratelimit:*`) في قاعدة بيانات Upstash التي قد تحتوي مستقبلًا على مفاتيح أخرى غير مرتبطة (مثل استخدام LangChain الحالي لنفس الحزمة).

لا توجد أي انحرافات (deviations) عن الخطة الأصلية تستدعي قرارات لم تُذكر أعلاه.

---

## الاختبارات اللي اتعملت والنتايج

### اختبارات تم تشغيلها فعليًا (تنفيذ حقيقي عبر Jest، وليس قراءة كود فقط)

هذا الملف الجديد (`redis-rate-limit-store.test.js`) **لا يستدعي mongoose على الإطلاق** (بعكس ملفات اختبار المصادقة/MFA السابقة)، لذلك — وعلى عكس القيود الموثقة في تقارير المراحل السابقة بخصوص بطء mongoose على القرص المُركَّب (mounted drive) في هذا الـ sandbox — تمكَّن هذا الاختبار من العمل فعليًا عبر Jest الحقيقي داخل هذا الـ sandbox، وليس فقط عبر تنفيذ Node مباشر بديل كما حدث في المرحلة السابقة:

```
Test Suites: 1 passed, 1 total
Tests:       12 passed, 12 total
Snapshots:   0 total
Time:        16.307 s
```

كما تم تشغيل هذا الملف مع اثنين من اختبارات الوحدة الأخرى الموجودة مسبقًا واللذين لا يعتمدان على mongoose أيضًا (`metadata-strip.util.test.js`, `error-handler.normalize.test.js`) في نفس عملية Jest واحدة، للتأكد من عدم وجود أي تعارض:

```
Test Suites: 3 passed, 3 total
Tests:       27 passed, 27 total
Time:        17.006 s
```

### فحص إقلاع التطبيق الكامل (full app boot)

تم تشغيل `require('./src/app.entry.js')` مباشرة (يشمل كل ملفات الـ routes الأربعة المُعدَّلة) — اكتمل بنجاح تام خلال حوالي 42 ثانية (وقت متوقع تمامًا، متسق مع القيد الموثق سابقًا لبطء القرص المُركَّب عند التحميل البارد لـ mongoose)، مع ظهور سطر لوج واحد فقط بالضبط يوضح "in-memory fallback" (لأن متغيرات Upstash غير مضبوطة في بيئة هذا الـ sandbox) — يؤكد أن `logModeOnce()` تعمل كما هو مطلوب، وأن كل الـ routes الأربعة حمَّلت الملف الجديد بدون أي خطأ.

تم أيضًا اختبار المسار الآخر مباشرة (تعيين متغيرَي Upstash وهميين، دون شبكة حقيقية) للتأكد أن بناء `RedisRateLimitStore` نفسه لا يفشل عند مجرد الإنشاء (construction) — نجح بدون أي استثناء (exception)، وهو متوقع لأن عميل REST الخاص بـ Upstash لا يقوم بأي اتصال شبكة فعلي إلا عند تنفيذ أمر حقيقي.

### ما لم يتم تشغيله فعليًا من داخل هذا الـ sandbox (قيود موثقة ومسبقة، غير مرتبطة بهذه المرحلة تحديدًا)

- **اختبارات الوحدة التي تستدعي mongoose** (`auth-jwt-algorithm.test.js`, `database.config.pool.test.js`, `mfa.service.test.js`) — استمرت في تجاوز مهلة 45 ثانية الخاصة بهذا الـ sandbox عند تشغيلها عبر Jest، بنفس القيد الموثَّق في تقرير Remediation Pass 2 (تراكم بطء mongoose الباردة + overhead الخاص بـ Jest نفسه). هذا **قيد سابق للمرحلة الحالية وغير ناتج عنها** — تم التأكد من عدم تعطّل هذه الملفات نفسها عبر فحص الصياغة (`node --check`) لكل الملفات المتأثرة، وعبر فحص إقلاع التطبيق الكامل الناجح أعلاه.
- **كل اختبارات integration** (التي تحتاج `mongodb-memory-server`) — لا يمكن تشغيلها في هذا الـ sandbox لأن تحميل ملف MongoDB الثنائي محظور على مستوى الشبكة (`fastdl.mongodb.org`)، بنفس القيد الموثَّق منذ المرحلة الأولى.
- **اختبار Redis حي (live)** — لم يُضَف عمدًا، بناءً على تعليمة صريحة في المستند الأصلي (خطوة التنفيذ رقم 6): يُترك كخطوة تحقق يدوية قبل الإطلاق (manual pre-launch verification)، بنفس أسلوب التعامل مع فحص Atlas IP-allowlist حاليًا.

**التأكيد المطلوب من GitHub Actions الحقيقي:** بما أن هذه المرحلة تلمس middleware مشترك تستخدمه وحدات متعددة (auth، public-site، وMFA من المرحلة السابقة)، فإن العدد الكامل والدقيق لـ `Test Suites` و`Tests` من تشغيل CI حقيقي مطلوب لتأكيد عدم وجود أي regression — تمامًا كما طُلب صراحة. هذا التقرير لن يعتبر "مؤكَّد بالكامل" قبل استلام هذا الرقم.

---

## أي انحراف عن الخطة الأصلية

لا يوجد أي انحراف عن الخطوات العشر (implementation steps) أو القرارات الثلاثة (product decisions) الواردة في `remediation-pass-3-redis.md`. تم تنفيذ كل بند كما هو مكتوب. البند الوحيد الذي تطلَّب قرارًا تقنيًا لم يُذكر صراحة في المستند هو تحديث الـ global limiter في `rate-limiter.middleware.js` رغم أنه لم يكن يمتلك `store` صريحًا من قبل — تم توضيح المنطق وراء هذا القرار في قسم "القرارات التقنية" أعلاه، وهو امتداد طبيعي لقرار المنتج رقم 3 ("Apply the shared store to every existing limiter") وليس تجاوزًا له.

---

## الحالة النهائية للمرحلة

**مكتملة من ناحية الكود (code-complete)، وتم التحقق منها بشكل مباشر داخل هذا الـ sandbox حيثما كان ذلك ممكنًا — بما في ذلك تشغيل فعلي وحقيقي عبر Jest لأول مرة في هذه السلسلة من المراحل لملف اختبار جديد (12/12 نجح).** لا توجد أي انحرافات عن الخطة، ولا توجد أي مشكلة معروفة في التنفيذ. الجزء المتبقي الوحيد هو **تأكيد GitHub Actions الحقيقي** لعدد الـ suites/tests الكامل (خاصة الملفات التي لا يمكن تشغيلها في هذا الـ sandbox: اختبارات integration واختبارات الوحدة المرتبطة بـ mongoose) — لم يتم إرسال أي أمر git من قِبَل Claude Desktop في هذه المرحلة، طبقًا للقسم 11 من `CLAUDE.md`، وينتظر هذا التقرير تحديثًا نهائيًا بمجرد استلام نتيجة الدفع (push) والتشغيل الحقيقي على GitHub Actions.

**ملاحظة جانبية:** ظهرت ملفان تشخيصيان مؤقتان (`_boot_diag3_tmp.js`, `_redis_construct_check_tmp.js`) على القرص المُركَّب أثناء هذا التحقق، ولم يمكن حذفهما (نفس مشكلة الصلاحيات المتكررة الموثقة في التقارير السابقة) — غير متتبَّعين في git (`untracked`)، ويحتاجان حذفًا يدويًا من قِبَل صاحب المشروع عند الحاجة، ولا يمنعان أي شيء.
