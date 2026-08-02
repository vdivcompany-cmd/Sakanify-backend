# تقرير المرحلة السابعة — Super-Admin / V Div Control Center

## اسم المرحلة ورقمها
**المرحلة 7: Super-Admin / V Div Control Center** (Phase 7 — Docs/phase-7-admin.md)

## الهدف من المرحلة
إعطاء فريق V Div الداخلي (Super-Admin) رؤية وتحكم كامل على مستوى المنصة كلها: كل الـ owners، كل الـ buildings، وكل الـ subscriptions. المرحلة دي مش بتعمل موديلز core جديدة (غير حاجة واحدة هنوضحها في قسم الانحرافات)، هي طبقة تجميع (aggregation layer) فوق المراحل 1 و3 و4 و5 و6.

النقطة الأهم اللي اتحددت بعد مراجعة المرحلة 6: **الـ suspend لازم يكون REAL wiring مش cosmetic flag** — يعني لازم فعلاً يوقف الـ owner عن قبول طلبات جديدة (عن طريق subscription.status)، ولازم كمان يقفل الـ session بتاعته فورًا (مش يستنى انتهاء صلاحية التوكن).

## الملفات والمجلدات اللي اتعملت فعلياً

### ملفات جديدة (Admin module)
- `src/modules/admin/admin.routes.js`
- `src/modules/admin/admin.controller.js`
- `src/modules/admin/admin.service.js`
- `src/modules/admin/admin.repository.js`
- `src/modules/admin/expansion-queue.service.js`
- `src/modules/admin/impersonation-session.model.js` — **ملف إضافي مش موجود في قائمة الملفات الأصلية بتاعة المرحلة (انحراف موثق تحت)**

### تعديلات على Phase 1 (Auth) — لإصلاح ثغرة حقيقية في آلية إلغاء الـ tokens
- `src/modules/auth/auth.model.js` — إضافة حقل `tokens_invalidated_at`
- `src/modules/auth/auth.service.js` — إضافة `invalidateAllTokensForUser`, `getUserByOwnerId`, `listOwners`, `setUserStatus`؛ تعديل `logout()` و`initiatePasswordReset()` عشان يستخدموا الآلية الحقيقية الجديدة
- `src/modules/auth/auth.repository.js` — إضافة `findUsersByRoleAnyStatus`, `countUsersByRoleAnyStatus`
- `src/middleware/auth.middleware.js` — `verifyToken` بقى async وبيعمل فحص حقيقي في الـ DB (status + `tokens_invalidated_at`) على كل request، وبيتعامل مع impersonation tokens بشكل منفصل

### تعديلات على Phase 6 (Subscriptions) — لدعم الـ admin overrides
- `src/modules/subscriptions/subscription.repository.js` — إضافة `resolveExpansionRequest`, `countWithPendingExpansionRequests`, `findByOwnerIds`
- `src/modules/subscriptions/subscription.service.js` — إضافة `manualCapacityOverride`, `listPendingExpansionRequests`, `approveExpansionRequest`, `rejectExpansionRequest`, `getSubscriptionsForOwnerIds`

### تعديلات على Phase 3 (Buildings/Beds) — لدعم الـ metrics ككلات مجمّعة (aggregated)
- `src/modules/buildings/building.repository.js` — إضافة `countAll`, `countByOwnerIds`
- `src/modules/buildings/building.service.js` — إضافة `countAllBuildings`, `countBuildingsByOwnerIds`
- `src/modules/beds/bed.repository.js` — إضافة `countByOwnerIds`
- `src/modules/beds/bed.service.js` — إضافة `countBedsForOwnerIds`

### تعديلات على Phase 2 (KYC) — لدعم metric "الطلاب المتحقق منهم"
- `src/modules/kyc/kyc.repository.js` — إضافة `countByStatus`
- `src/modules/kyc/kyc.service.js` — إضافة `countVerifiedStudents`

### تعديلات على Phase 4 (Requests) — لدعم الـ conversion funnel
- `src/modules/requests/request.repository.js` — إضافة `aggregateStatusCounts`
- `src/modules/requests/request.service.js` — إضافة `getRequestFunnelStats`

### تعديلات على Phase 3 (Audit) — لدعم فلترة بالتاريخ في الـ activity feed
- `src/modules/audit/audit.repository.js` — إضافة `startDate`/`endDate` filters في `list()`/`count()`

### Wiring
- `src/app.entry.js` — تركيب `/api/admin` router

### الوثائق
- `Docs/phase-7-admin.md` — استبدال كامل بالنسخة المرفقة من المستخدم (فيها قسم "Added After Phase 6 Review")

### الاختبارات
- `tests/integration/admin.test.js` — ملف اختبارات تكاملية جديد بالكامل للمرحلة 7 (بما فيه اختبارات الـ Reactivate اللي اتضافت بعد المراجعة)

### تعديل إضافي بعد مراجعة التقرير الأول (Reactivate Account)
- `src/modules/admin/admin.service.js` — إضافة `reactivateOwner`
- `src/modules/admin/admin.controller.js` — إضافة `reactivateOwner`
- `src/modules/admin/admin.routes.js` — إضافة `POST /api/admin/owners/:ownerId/reactivate`

## شرح تفصيلي لكل خطوة اتنفذت

### 1. جدول الـ Owners/Buildings الشامل (`GET /api/admin/owners`)
بيرجع صف لكل owner فيه: بريده الإلكتروني، حالته، عدد الـ buildings بتاعته، عدد الأسرّة (beds) المستخدمة فعليًا، وبيانات الـ subscription (الباقة، السعة الكلية، الحالة). الاستعلام مبني على 4 queries بس (owners page واحدة + 3 batch lookups بالـ owner_ids)، مش query لكل owner — ده مهم جدًا مع حجم المشروع المستهدف (~1000 مالك، ~500 ألف طالب). استخدمنا aggregation بـ `$group` على `owner_id` عشان نجيب العدّادات (counts) من غير ما نحمّل مستندات الـ buildings/beds الكاملة في الذاكرة.

### 2. Manual Capacity Override (`PATCH /api/admin/owners/:ownerId/capacity-override`)
بيغيّر `total_bed_capacity` مباشرة برة نظام الطلب/الموافقة العادي. بيسجّل before/after في الـ audit log. **لو السعة الجديدة أقل من عدد الأسرّة المستخدمة فعليًا، مش بيمنع العملية** — بيرجّعها وبيحط تحذير (`warning`) واضح في الـ response، بالظبط زي ما طلب المستخدم في نقطة المراجعة بعد المرحلة 6.

### 3. Suspend Account (`POST /api/admin/owners/:ownerId/suspend`) — أهم جزء في المرحلة
دي النقطة اللي المستخدم أكد عليها كتير، وفعلاً لقينا فيها مشكلة حقيقية في الكود الموجود من قبل (تفاصيلها في قسم "قرارات تقنية" تحت). التنفيذ النهائي بيعمل 3 حاجات معًا:
1. `subscriptionService.updateStatus(ownerId, 'suspended', ...)` — ده اللي بيفعّل الـ guard clause (`canAcceptNewRequests`) الموجود من المرحلة 6 جوه `request.service.createRequest`.
2. `authService.setUserStatus(ownerUser._id, 'suspended')` — عشان `loginOwner` يرفضه فورًا لو حاول يعمل login تاني.
3. `authService.invalidateAllTokensForUser(ownerUser._id)` — عشان أي access token عنده حاليًا يترفض على أول request بعد كده مباشرة، مش لما تنتهي صلاحيته الطبيعية (15-30 دقيقة).

كل خطوة بتتسجل في الـ audit log بشكل منفصل (`subscription_status_changed` من subscription.service، و`owner_account_suspended` من admin.service).

### 3ب. Reactivate Account (`POST /api/admin/owners/:ownerId/reactivate`) — إضافة بعد مراجعة التقرير
دي إضافة اتطلبت من صاحب المشروع بعد ما راجع التقرير الأول للمرحلة، وكانت متسيبة عمدًا في النسخة الأولى (موثقة كـ"انحراف" في القسم الخاص بيه) عشان المواصفة الأصلية طلبت "Suspend Account" بس من غير ذكر عملية عكسية. التنفيذ بيعكس أول خطوتين بالظبط من الـ suspend:
1. `subscriptionService.updateStatus(ownerId, 'active', ...)`.
2. `authService.setUserStatus(ownerUser._id, 'active')`.

**من غير عكس إلغاء الـ tokens** — مفيش داعي: التوكنات اللي كانت صادرة وقت التعليق لسه هتترفض (الـ `iat` بتاعتها قبل أو يساوي `tokens_invalidated_at`، وده صح فعليًا — التوكنات دي كانت شغالة في فترة التعليق ومفروض مترجعش تشتغل تاني). الـ owner ببساطة بيعمل login تاني، وبما إن الـ status بقى `active`، الـ `loginOwner` هيقبله عادي، والتوكن الجديد هيبقى الـ `iat` بتاعه بعد وقت الإلغاء، فهيعدي فحص الـ middleware عادي من غير أي حالة خاصة محتاجة تتضاف.

العملية دي بتتسجل في الـ audit log كـ `owner_account_reactivated`، وبيرجعلها 404 لو الـ `owner_id` مش موجود (نفس سلوك الـ suspend).

### 4. Impersonate Owner (`POST /api/admin/owners/:ownerId/impersonate` و`POST /api/admin/impersonate/:jti/end`)
بيتعمل token مختلف تمامًا عن التوكن العادي: فيه claim اسمه `type: 'impersonation'`، و`impersonating_admin_id`، ومدة صلاحية قصيرة (30 دقيقة). التوكن ده بيتفحص على كل request مقابل سجل `ImpersonationSession` (بالـ jti)، مش بس مقابل توقيع الـ JWT — ده اللي بيخلّي "end impersonation" حقيقي (revocation فعلي)، مش مجرد سطر في اللوج. بداية ونهاية كل جلسة impersonation بتتسجل في الـ audit log بشكل منفصل، فالمدة (duration) ممكن تتحسب من الفرق بينهم.

### 5. Expansion Queue (`GET/POST /api/admin/expansion-requests/...`)
List/approve/reject لطلبات توسيع السعة اللي الـ owners قدموها في المرحلة 6. الموافقة بترفع `total_bed_capacity` أوتوماتيك في نفس الـ atomic update اللي بتغيّر حالة الطلب لـ approved (مفيش لحظة يكون فيها الطلب "approved" والسعة القديمة لسه شغالة).

### 6. Activity Feed الشامل (`GET /api/admin/activity`)
بيسحب من الـ audit module الموجود من المرحلة 3، مع pagination إجباري وفلترة اختيارية بالتاريخ (`start_date`/`end_date`).

### 7. Platform Metrics (`GET /api/admin/metrics`)
- **Conversion funnel**: إجمالي الطلبات مقابل الإيجارات المؤكدة، محسوبة بـ aggregation واحدة (`$group` على الـ status) مش بتحميل الكوليكشن كله.
- **إجمالي الـ buildings النشطة**: `countDocuments` مفهرس.
- **إجمالي الطلاب المتحقق منهم (verified)**: `countDocuments` مفهرس على `verification_status`.

### 8. التحكم في الوصول (Access Control)
كل الـ routes في `admin.routes.js` محمية بـ `requireRole(SUPER_ADMIN)` مرة واحدة على مستوى الـ router كله (`router.use(...)`) — مفيش endpoint ممكن ينسى الحماية دي بالغلط.

### 9. اختبار السلسلة الكاملة (suspend → guard clause → token rejection)
ده الاختبار الأهم في المرحلة، وموجود في `admin.test.js` تحت `Phase 7 — Suspend Account: THE end-to-end wiring test`. بيتأكد من 3 حاجات مع بعض في نفس الاختبار: (أ) `subscription.status === 'suspended'` فعليًا في الداتابيز، (ب) توكن الـ owner القديم بيترفض (401) على أول request بعد الـ suspend مباشرة، (ج) طلب جديد من طالب على سرير تابع لنفس الـ owner ده بيترفض (403) بسبب الـ guard clause.

## أي قرارات تقنية اتاخدت أثناء التنفيذ

### القرار الأهم: إصلاح ثغرة حقيقية موجودة من المرحلة 1
أثناء تنفيذ متطلب "suspend لازم يلغي الـ sessions فورًا"، لقينا إن آلية إلغاء الـ tokens اللي اتعملت في المرحلة 1 (`invalidated_token_versions` في `auth.model.js`) كانت **write-only** — يعني `logout()` و`initiatePasswordReset()` كانوا بيدّوا (push) قيمة عشوائية في array، لكن مفيش حتة تانية في الكود كانت بتقرأ الـ array ده أو تقارنه بالتوكن اللي جاي في الـ request. يعني عمليًا: الـ logout والـ password reset من المرحلة 1 مكنوش بيلغوا أي access token فعليًا — كانوا بس بيمنعوا إعادة استخدام الـ refresh token string نفسه (اللي أصلاً بيتغير بعد أول استخدام).

الموضوع ده بالظبط هو نفس نوع المشكلة اللي المستخدم حذّر منها بخصوص الـ suspend ("لازم REAL wiring مش cosmetic flag") — فقررنا نصلّحه بدل ما نستخدم آلية معطوبة ونديها اسم "reuse". الحل: إضافة حقل `tokens_invalidated_at` على الـ User model، وفحص حقيقي في `auth.middleware.verifyToken` بيقارن الـ `iat` (وقت إصدار التوكن) بالتوقيت ده على كل request محمي. ده غيّر سلوك `logout()` و`initiatePasswordReset()` كمان (بقوا فعليًا بيلغوا الـ sessions فورًا، مش بس نظريًا) — مش بس كود جديد للمرحلة 7. اتحطت كتعليق تفصيلي في `auth.model.js` و`auth.middleware.js` وموثقة هنا كانحراف/إصلاح صريح.

**التكلفة**: كل request محمي دلوقتي بيعمل query واحدة إضافية على الـ User (بحث بالـ `_id`، مفهرس أصلاً). التكلفة دي مقبولة ومطلوبة عشان "immediately" في متطلبات المرحلة تبقى حقيقية فعلًا.

### قرار: إنشاء موديل جديد `ImpersonationSession` (مش في قائمة الملفات الأصلية)
قائمة الملفات في المرحلة (القديمة والجديدة) بتذكر 4 ملفات بس (`admin.routes/controller/service` و`expansion-queue.service`). لكن لتنفيذ متطلب "end impersonation لازم يكون فعّال حقيقي" (مش بس سطر في اللوج)، احتجنا حاجة نقدر نفحص التوكن مقابلها بالـ jti في كل request — الـ audit log مش مفهرس لكده وماينفعش نستخدمه كآلية revocation حية. فأضفنا موديل صغير (`impersonation-session.model.js`) وربطناه بملف `admin.repository.js` (اللي كان موجود فاضي أصلًا في الريبو). كل جلسة برضو بتتسجل في الـ audit log العام (بداية ونهاية) — الموديل الجديد ده مش بديل عن الـ audit trail، هو بس آلية الفحص السريع اللي الـ audit log مش مصمم لها.

### قرار: الـ impersonation token بيتجاهل حالة الـ owner المُعلّق (suspended)
لو الـ owner متعلّق (suspended)، توكن الـ impersonation بتاعه لسه شغال (على عكس توكن الـ owner العادي بتاعه). القرار ده متعمد: الـ Super-Admin ممكن يحتاج يعمل impersonate لأونر متعلّق عشان يشوف بالظبط اللي هو شايفه، أو يساعده يحل المشكلة اللي سببت التعليق. المواصفة مقالتش حاجة عن الحالة دي صراحة، فاتسجل كقرار تقني هنا.

### قرار: Suspend محتاج subscription موجودة الأول
لو الـ owner معندوش subscription من الأساس، الـ endpoint هيرجّع 404. السبب: `canAcceptNewRequests()` أصلًا بيرجّع `true` (يعني "مسموح") لو مفيش subscription — يبقى الـ suspend من غير subscription مش هيمنع أي حجز حقيقي، وهيبقى نفس مشكلة الـ "cosmetic suspend" اللي المرحلة دي بتحاول تتفاداها. اتوثقت كملاحظة صريحة في الكود (`admin.service.suspendOwner`) بدل ما نتجاهلها.

### قرار: "إجمالي الـ buildings النشطة" = كل الـ buildings
مفيش حقل "active/inactive" على موديل الـ Building حاليًا (الحذف بيبقى hard delete وبعد ما تتفضّى من الـ apartments بس). فاعتبرنا كل building موجودة = نشطة. لو حصل تطوير مستقبلي بيضيف حالة inactive، لازم يتراجع في المتريك ده.

## الاختبارات اللي اتعملت والنتايج

اتكتب ملف اختبارات تكاملية شامل (`tests/integration/admin.test.js`) بيغطي:
- **Access control**: رفض unauthenticated (401)، رفض student token (403)، رفض owner token (403)، قبول super-admin token (200) — على مستوى تمثيلي لكل الـ endpoints.
- **Owners table**: التأكد من صحة الـ aggregation (عدد المباني، عدد الأسرّة، بيانات الـ subscription) من غير N+1.
- **Manual capacity override**: الحالة العادية (تحذير = null)، حالة السعة الأقل من الاستخدام الفعلي (مش بيتمنع + فيه تحذير)، رفض قيمة غير رقمية (422).
- **THE critical test**: سلسلة suspend → subscription.status → token rejection → guard clause rejection، كلهم مع بعض في اختبار واحد، بالإضافة لاختبار الـ 404 لو الـ owner_id مش موجود.
- **Reactivate**: suspend ثم reactivate، والتأكد إن `subscription.status` رجعت `active`، و`User.status` رجعت `active`، وإن محاولة login جديدة بعد الـ reactivate بتنجح فعليًا (login حقيقي بالإيميل والباسورد، مش مجرد فحص حالة) — بالإضافة لاختبار 404 لو الـ owner_id مش موجود.
- **Impersonation**: إصدار توكن شغال، تسجيله في الـ audit، رفضه بعد الإنهاء (end)، ورفض محاولة إنهاء جلسة اتنهت بالفعل (404).
- **Expansion queue**: list، approve (بترفع السعة)، reject (السعة زي ما هي)، ورفض معالجة طلب اتحل قبل كده (409).
- **Activity feed**: pagination وفلترة بالتاريخ.
- **Platform metrics**: التأكد من الأرقام الأساسية للـ funnel والمباني والطلاب المتحقق منهم.
- **اختبار إضافي**: التأكد إن `logout` بقى فعليًا بيلغي التوكن فورًا (تأكيد على إصلاح ثغرة المرحلة 1).

### ⚠️ ملاحظة مهمة عن تنفيذ الاختبارات الفعلي
بيئة الـ sandbox الحالية (Cowork) **معندهاش وصول شبكة لتحميل الـ mongodb-memory-server binary** — نفس القيد اللي اتسجل قبل كده في الذاكرة الخاصة بالمشروع (Sakanify sandbox network limits). حاولنا تشغيل `npx jest tests/integration/admin.test.js` وعُلّق (hung) من غير أي output لغاية ما الـ timeout ضرب — ده أعراض تحميل binary مش متاح، مش خطأ في الكود.

**اللي اتعمل بدل التشغيل الفعلي**:
1. فحص syntax (`node --check`) على كل الملفات الجديدة والمعدّلة — كلها عدّت من غير أخطاء.
2. مراجعة يدوية دقيقة لكل مسار حرج (الـ suspend chain، الـ impersonation، الـ middleware الجديد) سطر بسطر مقابل الكود الفعلي الموجود في المشروع (مش افتراضات).
3. التأكد من عدم وجود circular requires بين الموديولز الجديدة والقديمة.

**التحقق الحقيقي (تشغيل الاختبارات + Phases 4/5/6 regression) محتاج يتم على جهازك بعد الـ push**، بالظبط زي كل مرحلة سابقة — هستنى نتيجة الـ GitHub Actions الحقيقية منك.

## أي انحراف عن الخطة الأصلية

1. **إضافة موديل جديد (`ImpersonationSession`) مش موجود في قائمة الملفات الأصلية** — موثق ومبرر بالتفصيل في قسم "قرارات تقنية" فوق.
2. **تعديل ملفات من مراحل سابقة (1، 2، 3، 4، 6) بدل ما تفضل "مغلقة"** — كل تعديل كان إضافي (additive) ومحدد بدقة: إضافة functions جديدة للـ services/repositories الموجودة، من غير ما نغيّر أي سلوك قديم موجود (ما عدا إصلاح ثغرة الـ token invalidation المذكورة فوق، اللي كانت لازمة).
3. **`auth.middleware.verifyToken` بقى async وبيعمل DB query إضافية على كل request محمي** — كان sync قبل كده. ده تغيير معماري حقيقي، لكن ضروري عشان "immediately" في متطلبات الـ suspend تبقى حقيقية، مش مجرد كلام.
4. **إضافة endpoint "Reactivate Account" (`POST /api/admin/owners/:ownerId/reactivate`)** — ده مش موجود في `Docs/phase-7-admin.md` الأصلية، لكن اتضاف بعد ما صاحب المشروع راجع التقرير الأول وطلبه صراحة (كان متسيّب عمدًا كسؤال مفتوح في النسخة الأولى من التقرير، مش تم تخمينه). التنفيذ بيعكس أول خطوتين بالظبط من الـ suspend (تفاصيله في قسم "شرح تفصيلي" فوق، خطوة 3ب) — من غير ما يعكس إلغاء الـ tokens، لأن مفيش داعي لكده كما هو موضح.

## الحالة النهائية للمرحلة

**مكتملة من ناحية الكود (code-complete)**، مع تحفظ واحد واضح: **التحقق الفعلي بتشغيل الاختبارات (بما فيها regression على Phases 4/5/6) لسه محتاج يحصل على جهازك** بسبب قيود الشبكة في بيئة الـ sandbox. الكود اتفحص syntax-wise بالكامل واتراجع يدويًا بعناية، لكن "الكود شغال" مش دليل كافي لوحده حسب قاعدة CLAUDE.md Section 6.1 — التحقق الحقيقي هيكون من نتيجة الـ GitHub Actions بعد الـ push.

**لم يتم تشغيل أي أمر git من جانبي** — دوري خلص عند تعديل/إنشاء الملفات على الديسك، حسب Section 11 من CLAUDE.md.
