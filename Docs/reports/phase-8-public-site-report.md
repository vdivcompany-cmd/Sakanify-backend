# تقرير المرحلة الثامنة — Public Site API

## اسم المرحلة ورقمها
**المرحلة 8: Public Site API** (Phase 8 — Docs/phase-8-public-site.md) — آخر مرحلة backend في المشروع.

## الهدف من المرحلة
بناء الـ API اللي بتشغّل الموقع العام ("Main Site") اللي بيعرض للزوّار (من غير تسجيل دخول) بس المباني المشتركة فعليًا في Sakanify (subscription نشطة)، مع فلترة بالمنطقة (area) مش بالمسافة، وتفاصيل مبنى بدون كشف بيانات حساسة، وطريقة يقدر بيها الزائر يعبّر عن اهتمامه بسرير معيّن.

**النقطة الأهم في المرحلة دي**، وده اللي خلاها مختلفة عن أي مرحلة سابقة: هي أول سطح (surface) في الباك إند كله من غير أي مصادقة (authentication) على الإطلاق. المستند المرفق صحّح ثغرة أمنية حقيقية كانت في الـ scope الأصلي — تفاصيلها في القسم الجاي.

## قرار التصميم الحرج اللي المستند صحّحه — الـ Public Leads مش Requests

الـ scope الأصلي كان بيقول إن endpoint "Request to View/Book" لازم ينشئ سجل مباشرة في موديول الـ Requests بتاع المرحلة 4، "بالظبط زي لو اتبعت من خلال الـ flow بتاع الطالب المسجّل". **ده اتصحّح في المستند المرفق — ومينفعش يتنفذ كده خالص.**

السبب: `request.service.createRequest` بيعمل عملية قفل حقيقية وذرّية (atomic lock) على السرير (`available` → `pending`)، وبيفترض إن اللي بيطلب هو طالب مسجّل ومتحقق منه (KYC). لو ربطنا فورم عام مجهول الهوية مباشرة بالـ flow ده، أي حد — من غير حساب، من غير OTP، من غير KYC — هيقدر "يقفل" أي سرير حقيقي من غير أي مقاومة. على حجم المشروع المستهدف (~500 ألف سرير)، ده باب واسع جدًا لهجوم حرمان من الخدمة (denial-of-service): سكريبت واحد يقدر يقفل كل الأسرّة المتاحة بمدينة كاملة بمجرد spam على الـ endpoint ده.

**التصميم المصحّح المنفّذ فعليًا**: تقديم اهتمام عام بيُنشئ سجل خفيف ومستقل اسمه `PublicLead` (الاسم، التليفون، ملاحظة، مرجع السرير/المبنى، الوقت) — **من غير أي لمسة لحالة السرير، ومن غير إنشاء مستند Request خالص**. الـ owner بيشوف الـ leads دي في قايمة منفصلة تمامًا عن قايمة الـ Pending Requests الحقيقية بتاعته.

## الملفات والمجلدات اللي اتعملت فعلياً

### ملفات جديدة (موديول public-site — كانت موجودة فاضية في الريبو واتملت)
- `src/modules/public-site/public-lead.model.js`
- `src/modules/public-site/public-lead.repository.js` — **ملف إضافي مش مذكور صراحة في قائمة ملفات المستند (اللي بتذكر بس model وservice)، اتضاف عشان يماشي نفس نمط الـ repository layer المتّبع في كل موديول تاني في المشروع (نفس القرار اللي اتاخد مع `pagination.util.js` في المرحلة 3)**
- `src/modules/public-site/public-lead.service.js`
- `src/modules/public-site/public.service.js` — كان فاضي، اتملى بالكامل
- `src/modules/public-site/public.controller.js` — كان فاضي، اتملى بالكامل
- `src/modules/public-site/public.routes.js` — كان فاضي، اتملى بالكامل

### تعديلات على Phase 6 (Subscriptions) — عشان الموقع العام يعرف مين "مشترك فعليًا"
- `src/modules/subscriptions/subscription.repository.js` — إضافة `findActiveOwnerIds()`
- `src/modules/subscriptions/subscription.service.js` — إضافة `getActiveOwnerIds()`, `isOwnerPubliclyListed(ownerId)`

### تعديلات على Phase 3 (Buildings) — لبناء الدليل العام (public directory)
- `src/modules/buildings/building.repository.js` — إضافة `findPublic()`, `countPublic()`
- `src/modules/buildings/building.service.js` — إضافة `listPublicBuildings()`, `getPublicBuildingDetail()`, `countPublicBuildings()`

### تعديلات على config
- `src/config/constants.config.js` — إضافة `PUBLIC_LEAD_STATUS` (new / contacted / dismissed)

### Wiring
- `src/app.entry.js` — تركيب `/api/public` router

### الوثائق
- `Docs/phase-8-public-site.md` — استبدال كامل بالنسخة المرفقة من المستخدم (فيها قسم "Critical Design Decision")

### الاختبارات
- `tests/integration/public-site.test.js` — ملف اختبارات تكاملية جديد بالكامل للمرحلة 8

**ملاحظة**: مفيش أي تعديل على موديول الـ Requests (المرحلة 4) نفسه — ده متعمد ومركزي في التصميم: الـ decoupling بين الـ PublicLead والـ Request لازم يكون كامل، مش بس "منطقي" — يعني مفيش حتى import واحد من `public-lead.service.js` لملفات المرحلة 4.

## شرح تفصيلي لكل خطوة اتنفذت

### 1-2. دليل المباني العام (`GET /api/public/buildings`)
بيرجّع بس المباني اللي الـ owner بتاعها عنده subscription بحالة `ACTIVE` فعليًا (مش بس subscription موجودة — لازم تكون active تحديدًا). الآلية:
1. `subscriptionService.getActiveOwnerIds()` — استعلام واحد (`distinct('owner_id', {status: 'active'})`) بيرجّع كل الـ owner_ids المؤهلة.
2. `buildingRepository.findPublic({ownerIds, area, skip, limit})` — بيفلتر على الـ owner_ids دي، مع فلتر اختياري بالـ `area` (منطقة/حي، مش مسافة — بالظبط زي ما طلب المستند).

لو مفيش أي owner مشترك حاليًا، بترجع صفحة فاضية (مش error) — ده حالة طبيعية ومتوقعة، مش فشل.

الاستعلام بيستخدم `.select()` على مستوى الـ query نفسه (مش بس تنضيف الـ response بعد كده) عشان `owner_id` و`address.details` **ميتسحبوش من الداتابيز أصلاً** لهذا الـ endpoint.

### 3. تفاصيل مبنى واحد (`GET /api/public/buildings/:buildingId`)
بيرجّع: الاسم، المنطقة، المدينة والشارع بس (من غير `details`)، نسبة إشغال مقرّبة (`occupancy_percent`)، وبادچ "verified".

**قرار مهم**: لو الـ owner مش مشترك فعليًا (suspended, overdue, أو مفيش subscription أصلاً)، الـ endpoint بيرجّع **404، مش 403** — عمدًا، عشان مينفعش حد يستخدم الـ endpoint ده يتأكد إن مبنى معيّن "موجود بس مش ظاهر" (existence leakage). ده نفس مبدأ الـ data minimization اللي CLAUDE.md بيطلبه، لكن مطبّق هنا على مستوى "هل المصدر موجود أصلاً" مش بس على مستوى الحقول.

نسبة الإشغال بتتحسب من `bedService.computeOccupancy` (نفس الدالة الموجودة من المرحلة 3)، لكن **بترجع رقم واحد مقرّب بس** — مش الـ breakdown الخام (available/occupied/pending/maintenance) اللي الدالة الأصلية بترجعه، لأن الـ breakdown ده لمبنى صغير بيقرب جدًا من خريطة سرير-بسرير (per-bed map)، وده بالظبط اللي خطوة 6 في المستند بتمنعه.

**قرار تقني حول معنى "verified"**: المستند بيطلب "verified badge" من غير ما يحدد إيه اللي بيتحقق منه بالظبط. مفيش أي نظام تحقق (verification) تاني للمباني في المشروع (على عكس الطلاب اللي عندهم KYC حقيقي). فاتّخذنا قرار إن "verified" = "وصلنا للنقطة دي، يبقى الاشتراك ACTIVE فعليًا" — وهو أصلًا الشرط الوحيد اللي بيخلّي المبنى يظهر في الدليل من الأساس. موثق كقرار تقني.

### 4. تقديم Lead عام (`POST /api/public/leads`)
دي أهم نقطة في المرحلة. الـ flow بالظبط:
1. تحقق من الحقول المطلوبة (`name`, `phone`, `bed_id` إجبارية؛ `note` اختياري بحد أقصى 500 حرف).
2. `bedService.getBedById(bedId)` — **قراءة بس**، من غير أي استدعاء لـ `bedService.atomicTransition`.
3. `subscriptionService.isOwnerPubliclyListed(bed.owner_id)` — لو الـ owner بتاع السرير ده مش مشترك فعليًا، بترجع **404 "Bed not found"** (نفس شكل السرير الغير موجود، عشان مينفعش حد يستنتج إن owner معيّن اتعلّق أو وقف اشتراكه).
4. `publicLeadRepository.create(...)` — إدخال واحد في كوليكشن `public_leads`، فيه `bed`, `building`, `owner_id` (denormalized زي أي موديول تاني في المشروع).
5. `auditService.writeAuditLog({actor: null, action: 'public_lead_submitted', ...})`.

**مفيش أي خطوة فيها `Request.create` أو `bed.status` بيتغيّر** — اتفحص ده صراحة في الاختبارات (قسم الاختبارات تحت).

الـ response بيرجّع بس `{id, status}` — مش بيرجّع الاسم/التليفون/الملاحظة اللي المستخدم بعتها، ومفيش أي بيانات سرير أو مبنى في الرد، لأن مفيش لسه اتحجز فعليًا.

### قايمة الـ Owner للـ Leads بتاعته (`GET /api/public/leads/mine`, `GET /api/public/leads/mine/:leadId`)
Endpoints محمية بـ `verifyToken` + `requireRole(OWNER)`، ومفلترة بـ `owner_id` على مستوى الـ query (نفس النمط المتّبع من المرحلة 3 في كل موديول). الـ endpoint المفرد بيعمل fetch-then-check: يجيب الـ lead الأول، وبعدين `ownershipScoping(req.user.ownerId, lead.owner_id)` — بالظبط نفس نمط `building.controller.js` و`request.controller.js`.

### 5. عدّادات الشفافية العامة (`GET /api/public/counters`)
بترجّع رقمين بس، من غير أي تفاصيل حساسة:
- `total_verified_buildings` — عن طريق `buildingService.countPublicBuildings()` (نفس الآلية بتاعة الـ listing، بس `countDocuments` مش `find`).
- `total_verified_students` — بإعادة استخدام `kycService.countVerifiedStudents()` **الموجودة أصلًا من المرحلة 7** من غير أي تعديل عليها.

**التخزين المؤقت (caching)**: المستند بيقول صراحة إن الـ caching مش مطلوب دلوقتي، بس المطلوب إن التصميم الحالي "ميعملش مشكلة" لو حد ضاف caching بعدين. الدالة الحالية (`getTransparencyCounters`) من غير أي side effects وبترجع نفس الشكل كل مرة، يعني سهل حد يحطها ورا أي كاش (زي Redis TTL قصير) من غير أي تعديل في المنطق نفسه.

### 6. تقليل البيانات (Data Minimization) — تحقق على مستوى كل endpoint
- الـ listing: `.select()` بيستبعد `owner_id` و`address.details` من الاستعلام نفسه.
- التفاصيل: الـ response بيتبني يدويًا (مش `building.toObject()` مباشرة) — فمفيش احتمال إن حقل حساس "يسرب" بالغلط لو حد ضاف حقل جديد للموديل بعدين.
- مفيش أي endpoint بيرجّع خريطة سرير-بسرير (per-bed availability map) — أقصى تفصيل هو نسبة إشغال مقرّبة على مستوى المبنى كله.

### 7. الـ Rate Limiting بالـ IP
كل الـ endpoints في الموديول ده متغطاة بـ IP-based rate limiter، فوق الـ limiter العام الموجود في `app.entry.js`. نفس نمط `auth.routes.js` بالظبط (`MemoryStore` منفصل لكل limiter عشان الاختبارات تقدر تعمل `resetAll()`):
- **browsingLimiter**: 120 طلب / 15 دقيقة — للـ listing/detail/counters.
- **leadLimiter**: 5 طلبات بس / 15 دقيقة — لـ `POST /leads` تحديدًا، لأنها الـ endpoint الوحيدة اللي بتكتب بيانات، وهي الهدف الأجذب لأي هجوم spam (بالظبط زي ما المستند حدد في خطوة 7).

### 8. الاختبارات المطلوبة صراحة في المستند
اتغطت في `tests/integration/public-site.test.js` — تفاصيلها في القسم الجاي.

## أي قرارات تقنية اتاخدت أثناء التنفيذ

1. **إضافة `public-lead.repository.js`** رغم إن قائمة الملفات في المستند بتذكر بس model وservice — عشان يتماشى مع نمط الـ repository layer المستخدم في كل موديول تاني بدون استثناء (buildings, requests, subscriptions...). موثق فوق كانحراف إضافي بسيط.

2. **حقل `submitted_at` بدل `created_at`** على موديل `PublicLead` — اتّبعنا التسمية الحرفية اللي المستند طلبها بالظبط، رغم إن كل موديل تاني في المشروع بيستخدم `created_at`/`updated_at`. القرار: الموديل ده جديد بالكامل، مفيش convention سابق يتكسر، فمفيش سبب نخالف التسمية الصريحة في المستند.

3. **"verified badge" = الاشتراك ACTIVE** — موضح بالتفصيل في القسم 3 فوق. مفيش نظام تحقق مباني تاني موجود في الكود نرجع له.

4. **404 بدل 403 لمبنى/سرير غير مشترك فعليًا** — قرار أمني متعمد لمنع الـ existence leakage على أول سطح عام في الباك إند. اتطبّق في مكانين: `building.service.getPublicBuildingDetail` و`public-lead.service.createLead`.

5. **`isOwnerPubliclyListed` منفصلة عن `canAcceptNewRequests` الموجودة من المرحلة 6** — رغم إن الاتنين بيفحصوا حالة الاشتراك، الاتنين ليهم معنى مختلف تمامًا: `canAcceptNewRequests` بترجع `true` لو مفيش subscription أصلاً (مناسب لحارس قبول الطلبات في المرحلة 4)، لكن `isOwnerPubliclyListed` بترجع `false` في نفس الحالة (owner من غير subscription خالص مينفعش يظهر في الدليل العام). دمج الدالتين كان هيعمل باگ خطير — استخدام واحدة بدل التانية بالغلط.

6. **كتابة audit log لتقديم الـ lead** رغم إن CLAUDE.md Section 3.9 بتذكر صراحة بس (KYC، مدفوعات، تعليق حساب، انتحال شخصية) — قرار متعمد بالتوسّع، موثق في `public-lead.service.js` نفسها: كل عملية كتابة بيانات تانية في المشروع (زي `request_created`) بتتسجل في الـ audit log، وده هيفيد V Div لو حصل نزاع/إساءة استخدام حول lead معيّن.

## الاختبارات اللي اتعملت والنتايج

اتكتب ملف اختبارات تكاملية جديد بالكامل (`tests/integration/public-site.test.js`) بيغطي:
- **الدليل العام**: مبنى owner مشترك (ACTIVE) بيظهر، مبنى owner معلّق (SUSPENDED) أو متأخر (OVERDUE) أو من غير subscription خالص **ميظهرش**؛ فلترة بالـ area؛ الـ pagination.
- **تقليل البيانات**: تأكيد إن `owner_id` و`address.details` مش موجودين في رد الـ listing، ومفيش أي breakdown سرير-بسرير في رد التفاصيل.
- **تفاصيل المبنى**: نسبة إشغال صح (100% لسرير واحد occupied من إجمالي واحد)، بادچ `verified: true`، و404 (مش 403) لمبنى owner متعلّق أو ID مش موجود.
- **العدّادات العامة**: شكل الرد صح.
- **الاختبار الأهم في المرحلة**: تقديم lead بيتأكد إنه (أ) بينشئ `PublicLead` واحد، (ب) `Bed.status` **ميتغيّرش خالص**، (ج) `RequestModel.countDocuments({})` **يفضل صفر**. اتكرر الاختبار كمان مع تقديم 3 leads متتالية بسرعة على نفس السرير عشان نتأكد إن الآلية مش "بتتسرّب" حتى مع محاولات متكررة.
- **رفض lead لسرير owner مش مشترك فعليًا** — بترجع 404، وبتتأكد إن مفيش `PublicLead` اتعمل.
- **Validation**: رفض 422 لو الحقول المطلوبة ناقصة.
- **Audit log**: التأكد إن `public_lead_submitted` بيتسجل بـ `actor: null`.
- **Rate limiting**: 6 محاولات تقديم lead متتالية من نفس الـ IP — المحاولة السادسة بترجع 429 (الحد الأقصى 5).
- **قايمة الـ leads بتاعة الـ owner**: كل owner بيشوف بس الـ leads بتاعته (isolation)، رفض توكن طالب/super-admin (403)، رفض طلب من غير توكن خالص (401).
- **Ownership isolation صريح (CLAUDE.md Section 6.3)**: Owner B مش قادر يقرأ lead تبع Owner A — اختبار negative صريح، مش بس اختبار إن Owner A قادر يقرأ بتاعه.

### ⚠️ ملاحظة مهمة عن تنفيذ الاختبارات الفعلي
بيئة الـ sandbox الحالية (Cowork) **معندهاش وصول شبكة لتحميل الـ mongodb-memory-server binary** — نفس القيد المسجّل قبل كده في ذاكرة المشروع (Sakanify sandbox network limits)، واللي اتسجّل برضو في تقرير المرحلة 7. حاولنا تشغيل `npx jest tests/integration/public-site.test.js` وعُلّق من غير أي output لغاية ما ضرب الـ timeout — نفس العرض بالظبط، مش خطأ في الكود.

**اللي اتعمل بدل التشغيل الفعلي**:
1. فحص syntax (`node --check`) على كل الملفات الـ13 الجديدة/المعدّلة — كلها عدّت من غير أي خطأ.
2. تحميل فعلي (`require`) لكل الملفات الجديدة والمعدّلة جوه عملية Node حقيقية (بما فيها `app.entry.js` نفسه بكل الـ routers) — اتأكدنا إن مفيش أي circular require أو export ناقص بين `public-site` و`buildings` و`subscriptions`.
3. مراجعة يدوية دقيقة لكل مسار حرج (خصوصًا `public-lead.service.createLead`) سطر بسطر، للتأكد إن مفيش أي مسار بيوصل لـ `bedService.atomicTransition` أو `requestRepository.create`.

**التحقق الحقيقي (تشغيل الاختبارات + regression على المراحل من 0 لحد 7) محتاج يتم على جهازك بعد الـ push**، بالظبط زي كل مرحلة سابقة — هستنى نتيجة الـ GitHub Actions الحقيقية منك.

## أي انحراف عن الخطة الأصلية

1. **إضافة `public-lead.repository.js`** — موثق بالتفصيل في قسم "قرارات تقنية" فوق، بند 1.
2. **تعديل ملفات من مرحلتين سابقتين (3 و6) بدل ما تفضل "مغلقة"** — كل تعديل كان إضافي (additive) بحت: دوال جديدة اتضافت للـ services/repositories الموجودة، من غير ما يتغيّر أي سلوك قديم موجود فعلاً لأي endpoint سابق. اتفحص ده صراحة بمراجعة كل ملف تم تعديله سطر بسطر.
3. **مفيش endpoint لتغيير حالة الـ lead (new → contacted/dismissed)** رغم إن الموديل فيه حقل `status` بثلاث قيم — المستند طلب صراحة بس "list/view"، فماتعملش أي endpoint إضافي لتعديل الحالة عشان نتجنب scope creep (CLAUDE.md Section 7.5). الحقل موجود وجاهز لمرحلة مستقبلية لو اتطلب.
4. **مسار الـ mount اتحدد كـ `/api/public`** — المستند مذكرش prefix محدد صراحة، فاتّخذ قرار بسيط ومتّسق مع باقي أسماء الـ routers في المشروع.

## الحالة النهائية للمرحلة

**مكتملة من ناحية الكود (code-complete)**، مع نفس التحفظ اللي اتسجل في تقرير المرحلة 7: **التحقق الفعلي بتشغيل الاختبارات (بما فيها regression على المراحل من 0 لحد 7) لسه محتاج يحصل على جهازك** بسبب قيود الشبكة في بيئة الـ sandbox. الكود اتفحص syntax-wise بالكامل، واتأكدنا من الـ requires والـ exports فعليًا جوه Node، واتراجع يدويًا بعناية خصوصًا المسار الحرج بتاع تقديم الـ lead. لكن "الكود شغال" مش دليل كافي لوحده — التحقق الحقيقي هيكون من نتيجة الـ GitHub Actions بعد الـ push.

**لم يتم تشغيل أي أمر git من جانبي** — دوري خلص عند تعديل/إنشاء الملفات على الديسك، حسب Section 11 من CLAUDE.md.
