# تقرير المرحلة السادسة — اشتراكات الملاك وسعة الأسرّة + تقسيم فواتير المرافق (اختياري) (Phase 6 — Owner Subscriptions & Bed Capacity + Optional Utility Bill Splitting)

## اسم المرحلة ورقمها

**المرحلة السادسة: اشتراكات الملاك وسعة الأسرّة (Owner Subscriptions & Bed Capacity)، مع ميزة إضافية اختيارية هذه المرحلة: تقسيم فواتير المرافق (Optional Utility Bill Splitting) — Phase 6.**

---

## الهدف من المرحلة

**الجزء الأصلي (Subscriptions):** تتبع باقة اشتراك كل مالك (سعة الأسرّة/المباني المسموح بها) ودعم طلبات توسيع هذه السعة، تمهيدًا لطابور الموافقات في المرحلة السابعة (Super-Admin).

**الجزء الجديد هذه المرحلة (Utility Bill Splitting):** ميزة **اختيارية بالكامل (opt-in)** لتقسيم فواتير الكهرباء/المياه/الغاز على الطلاب الحاليين في الشقة، لصالح الملاك اللي بيأجّروا بدون تضمين المرافق في الإيجار الشهري. أي مبنى غير مُعدَّل يستمر بنفس السلوك الحالي تمامًا (المرافق مُتضمَّنة بالإيجار) — لا تغيير على الإطلاق ما لم يُفعِّل المالك الخيار صراحة لمبنى معيّن.

---

## الملفات والمجلدات اللي اتعملت فعليًا

### 1. موديول الاشتراكات (Subscriptions Module) — تم بناء المحتوى بالكامل (كان placeholder فارغ)
```
src/modules/subscriptions/
├── subscription.model.js        → owner_id (فريد)، tier_name، total_bed_capacity، monthly_price،
│                                    status (active/overdue/suspended)، renewal_date،
│                                    expansion_requests[] (مصفوفة مضمَّنة — انظر القرارات التقنية)
├── subscription.repository.js   → طبقة الوصول لقاعدة البيانات، بما فيها push ذرّي لطلب التوسيع
├── subscription.service.js      → حساب الاستخدام، عتبة تحذير 90%، إنشاء طلب توسيع، انتقالات الحالة
├── subscription.controller.js   → GET /me (الاشتراك + الاستخدام)، POST /expansion-requests
└── subscription.routes.js       → مقيَّدة لصاحب المبنى فقط
```

### 2. موديول فواتير المرافق (Utilities Module) — جديد بالكامل هذه المرحلة
```
src/modules/utilities/
├── utility-bill.model.js        → apartment، building/owner_id (منسوخة)، bill_type (electricity/water/gas)،
│                                    billing_period، total_amount، split[] (student/rental/payment/share_amount)،
│                                    entered_by، entered_at
├── utility-bill.repository.js   → طبقة الوصول، قوائم مُصفَّاة بـ owner_id لكل شقة/مبنى
├── utility-bill.service.js      → منطق التقسيم المتساوي (splitAmountEqually)، رفض الحالات غير المسموحة،
│                                    الربط مع payment.service لتطبيق الحصص
├── utility-bill.controller.js   → تقديم فاتورة، عرض فواتير شقة/مبنى — كل ذلك مربوط بالملكية
└── utility-bill.routes.js       → مقيَّدة لصاحب المبنى فقط
```

### 3. ملفات اختبار جديدة
```
tests/integration/subscriptions-utilities.test.js   → اختبارات تكامل شاملة للمرحلة السادسة (تفاصيل في قسم الاختبارات)
```

### 4. ملفات معدَّلة في موديولات مغلقة من مراحل سابقة (Retrofits إضافية فقط)
```
src/config/constants.config.js                → إضافة SUBSCRIPTION_STATUS، EXPANSION_REQUEST_STATUS، UTILITY_BILL_TYPE
src/modules/buildings/building.model.js       → إضافة utilities_included_in_rent (boolean، افتراضي true)
src/modules/buildings/building.service.js     → إضافة setUtilitiesIncludedInRent() + سجل تدقيق مخصص
src/modules/buildings/building.controller.js  → إضافة updateUtilitiesSetting() (نمط normalizeError الجديد — انظر القرارات)
src/modules/buildings/building.routes.js      → PATCH /:buildingId/utilities-setting
src/modules/payments/payment.model.js         → إضافة rent_amount (افتراضي = amount_due عبر دالة)، utility_amount (افتراضي 0)
src/modules/payments/payment.repository.js    → إضافة addUtilityCharge() (تحديث ذرّي)
src/modules/payments/payment.service.js       → createInitialPaymentForRental()/generateNextPeriodPayment() تضبط
│                                                 rent_amount/utility_amount صراحة؛ إضافة ensurePaymentForPeriod()
│                                                 وapplyUtilityCharge()
src/modules/beds/bed.repository.js            → إضافة countByOwner()
src/modules/beds/bed.service.js               → إضافة countBedsForOwner() (لحساب استخدام الاشتراك)
src/modules/rentals/rental.repository.js      → إضافة findActiveOrVacatingForBeds()
src/modules/rentals/rental.service.js         → إضافة listActiveOrVacatingRentalsForBeds() (مصدر "الطلاب النشطين" للتقسيم)
src/app.entry.js                              → ربط /api/subscriptions و/api/utilities
Docs/phase-6-subscriptions.md                 → استبدال كامل بالنسخة النهائية المرفقة من صاحب المشروع
```

---

## شرح تفصيلي لكل خطوة اتنفذت

### أ. الاشتراكات (النطاق الأصلي)

**الخطوة 1 — نموذج الاشتراك:** يحتوي على كل الحقول المطلوبة بالنص حرفيًا (`owner_id`, `tier_name`, `total_bed_capacity`, `monthly_price`, `status`, `renewal_date`)، بالإضافة إلى `expansion_requests[]` مضمَّنة — انظر القرار التقني رقم 1 لتفصيل سبب هذا الاختيار.

**الخطوة 2 — حساب الاستخدام:** `subscription.service.getUsageForOwner()` يجيب العدد الفعلي لكل أسرّة المالك (عبر `bedService.countBedsForOwner()` الجديدة — لا وصول مباشر لموديول Beds) ويقارنه بـ `total_bed_capacity`، ويرجّع `beds_used`, `percent_used`, `is_near_capacity`.

**الخطوة 3 — عتبة التحذير:** `USAGE_WARNING_THRESHOLD = 0.9` (90%) — يُرجَّع كـ `is_near_capacity: true/false` ضمن استجابة `GET /api/subscriptions/me`، جاهز لعرضه كتنبيه في لوحة التحكم مستقبلًا.

**الخطوة 4 — طلب توسيع السعة:** `POST /api/subscriptions/expansion-requests` — يرفض أي طلب لا يتجاوز فعليًا السعة الحالية (422)، وإلا يُضاف كسجل فرعي بحالة `pending` عبر `$push` ذرّي (لا قراءة-ثم-كتابة على المصفوفة كاملة)، مع سجل تدقيق `subscription_expansion_requested`.

**الخطوة 5 — انتقالات الحالة:** `subscription.service.updateStatus()` ينتقل بين `active/overdue/suspended` مع سجل تدقيق `subscription_status_changed`. القاعدة التجارية "المالك المُعلَّق ممنوع من قبول طلبات جديدة" مبنية كدالة نقية `canAcceptNewRequests(ownerId)`، وهي الآن **مربوطة فعليًا** بموديول Requests (المرحلة الرابعة) — انظر قسم "تحديث لاحق للمرحلة" أسفل هذا التقرير للتفاصيل الكاملة وسبب القرار.

**الخطوة 6 — العزل حسب الملكية:** كل نقاط النهاية تعمل على `req.user.ownerId` من التوكن مباشرة، بلا أي `:ownerId` قابل للتلاعب في الرابط نفسه — عزل ضمني بالتصميم، مع اختبار عزل صريح رغم ذلك (قسم الاختبارات).

### ب. تقسيم فواتير المرافق (الجزء الجديد)

**الخطوة 7 — Retrofit على `building.model` (المرحلة الثالثة):** إضافة `utilities_included_in_rent` (boolean، افتراضي `true`) — لا يغيّر سلوك أي مبنى موجود. نقطة نهاية جديدة `PATCH /api/buildings/:buildingId/utilities-setting` لتفعيل/تعطيل الخيار لكل مبنى على حدة، مربوطة بالملكية ومسجَّلة في سجل التدقيق (`building_utilities_setting_changed`).

**الخطوة 8 — Retrofit على `payment.model` (المرحلة الخامسة):** إضافة `rent_amount` و`utility_amount`، بحيث `amount_due = rent_amount + utility_amount`. لكل سجل دفعة **جديد** يتم إنشاؤه من الآن فصاعدًا (الدفعة الأولى، الترحيل الشهري، أو `ensurePaymentForPeriod` الجديدة)، تُضبط القيمتان صراحة (`rent_amount = rental.monthly_rent`, `utility_amount = 0`). للسجلات **القديمة** الموجودة فعليًا في قاعدة البيانات من قبل هذه المرحلة (بدون هذين الحقلين على الإطلاق): تم استخدام default بصيغة **دالة** على `rent_amount` (`function() { return this.amount_due; }`) بدل قيمة ثابتة — Mongoose يُطبِّق الـ defaults تلقائيًا عند "hydration" أي مستند قادم من الاستعلام لا يحتوي على الحقل أصلًا، والدالة تُنفَّذ بـ `this` مربوطة بنفس المستند المحمَّل، فتقرأ `amount_due` الفعلي لهذا السجل بالذات. النتيجة: `rent_amount = amount_due` و`utility_amount = 0` لكل سجل قديم **بدون الحاجة لسكريبت هجرة بيانات منفصل** — تم التحقق من هذا السلوك باختبار مخصص (قسم الاختبارات).

**الخطوة 9 — منطق التقسيم (`utility-bill.service.submitBill`):**
1. يرفض الطلب (409) لو `building.utilities_included_in_rent === true`.
2. يجيب الإيجارات النشطة فعليًا في الشقة عبر `rentalService.listActiveOrVacatingRentalsForBeds()` الجديدة (لا وصول مباشر لموديول Rentals).
3. يرفض الطلب (409) لو كان عدد الطلاب النشطين صفرًا.
4. يقسّم `total_amount` بالتساوي عبر `splitAmountEqually()` — حساب بوحدة "القرش" الصحيح (integer cents)، وليس قسمة عشرية عائمة، لضمان أن مجموع الحصص = `total_amount` بالضبط دائمًا، مع وضع الباقي الناتج عن التقريب على **آخر طالب** في القائمة.
5. لكل طالب: `paymentService.ensurePaymentForPeriod()` (إيجاد أو إنشاء دفعة الفترة — يُعيد استخدام منطق إنشاء الدفعة من المرحلة الخامسة حرفيًا)، ثم `paymentService.applyUtilityCharge()` (تحديث ذرّي يضيف الحصة لـ `utility_amount` ويعيد حساب `amount_due` من `rent_amount + utility_amount`).
6. يُسجَّل التقسيم الكامل (`split[]`) على مستند `UtilityBill` نفسه للشفافية وحل النزاعات.

**الخطوة 10 — نقاط النهاية:** `POST /api/utilities/apartments/:apartmentId/bills` (تقديم فاتورة)، `GET /api/utilities/apartments/:apartmentId/bills` و`GET /api/utilities/buildings/:buildingId/bills` (قوائم مُصفَّاة بالملكية، مع Pagination).

**الخطوة 11 — التسجيل في سجل التدقيق:** `utility_bill_created` (على مستوى الفاتورة كاملة، من `utility-bill.service`) + `payment_utility_charge_applied` (لكل طالب على حدة، من `payment.service.applyUtilityCharge`) — كلاهما مُنفَّذ فعليًا، وليس أحدهما فقط.

---

## أي قرارات تقنية اتاخدت أثناء التنفيذ

1. **طلبات التوسيع مُضمَّنة كمصفوفة فرعية على `subscription.model`، لا موديل/ملف منفصل**: قائمة الملفات في نص المرحلة تذكر 4 ملفات فقط تحت `src/modules/subscriptions/` (بدون ملف موديل مستقل لطلبات التوسيع). التضمين يحافظ على هذه القائمة حرفيًا، ويجعل العزل حسب الملكية تلقائيًا (طلب التوسيع هو مستند فرعي داخل اشتراك المالك نفسه — لا يوجد collection منفصل يقدر مالك آخر يستعلم عنه أصلًا). **إن احتاجت المرحلة السابعة (طابور الموافقات لدى Super-Admin) عرضًا مُسطَّحًا عبر كل الملاك بصفحات منفصلة، فترقية هذه المصفوفة لموديل/collection مستقل هي الخطوة الطبيعية التالية** — تم تجهيز `subscriptionRepository.findWithPendingExpansionRequests()` كنقطة بداية جاهزة لذلك دون بنائه بالكامل مسبقًا (تفاديًا للبناء الزائد على افتراضات مرحلة لم تبدأ بعد، وفق البند 7.5 من CLAUDE.md).

2. **قاعدة "المالك المُعلَّق ممنوع من قبول طلبات جديدة" (خطوة 5 بالنص) — تم ربطها فعليًا بموديول Requests بعد قرار صريح من صاحب المشروع**: كانت هذه النقطة مطروحة في المسودة الأولى لهذا التقرير كقرار مفتوح (لأن تعليمات بدء هذه المرحلة حدَّدت صراحةً موديولين فقط للـ retrofit — `building.model`/`payment.model` — بدون ذكر `request.service`). ورد قرار صريح من صاحب المشروع بالربط الآن، وليس تأجيله للمرحلة السابعة — التفاصيل الكاملة (الملفات، الاختبارات، السبب) موثَّقة في قسم "تحديث لاحق للمرحلة" أسفل هذا التقرير.

3. **دالة `default` على `rent_amount` بدل قيمة ثابتة** (تفصيل كامل في الخطوة 8 أعلاه) — لضمان عدم كسر أي سجل دفعة قديم بدون سكريبت هجرة منفصل، بالضبط كما طلب النص.

4. **حساب التقسيم بوحدة "القرش الصحيح" (integer cents) بدل القسمة العشرية المباشرة**: `100 / 3 = 33.333...` بحساب عائم عادي قد يترك ناتج التقريب أقل أو أكثر من `total_amount` بقرش واحد حسب اتجاه التقريب. تم بناء `splitAmountEqually()` بحيث تُحوَّل `total_amount` لقروش صحيحة أولًا (`Math.round(totalAmount * 100)`)، والباقي الناتج عن القسمة الصحيحة يُضاف بالكامل لآخر طالب — هذا يضمن أن المجموع النهائي يساوي `total_amount` بالضبط في كل الحالات، تم التحقق منه باختبار حسابي مباشر (قسم الاختبارات).

5. **تحديث ذرّي (`addUtilityCharge`) بدل قراءة-ثم-كتابة**: بنفس منطق `atomicConfirm` من المرحلة الخامسة (البند 6.2 من CLAUDE.md) — يعيد حساب `amount_due = rent_amount + utility_amount` من القيم المُحدَّثة فعليًا داخل نفس عملية الـ pipeline، ولا يلمس الحالة `overdue` (دفعة متأخرة تبقى متأخرة حتى بعد إضافة رسوم مرافق عليها، بدل إعادة ضبطها لـ `pending` بشكل مضلِّل).

6. **`updateUtilitiesSetting` الجديد في `building.controller.js` يستخدم `normalizeError()`**، رغم أن باقي هذا الملف (من المرحلة الثالثة) لا يزال يستخدم النمط القديم (`err.statusCode || 400`) الذي يسبق قرار البند 7.3a من CLAUDE.md (المُتخذ بعد تصحيح خلل في المرحلة الرابعة). تم تطبيق النمط الصحيح على الكود **الجديد** فقط دون لمس بقية الملف — وفق مبدأ عدم إعادة فتح كود مقبول من مرحلة مغلقة أثناء عمل تكميلي ضيق، **لكن هذا يُرصَد صراحة هنا** كفجوة موجودة في `building.controller.js` تستحق تصحيحًا شاملًا في مرحلة لاحقة مخصصة لذلك.

7. **`USAGE_WARNING_THRESHOLD = 0.9` (90%)**: قيمة عمل افتراضية غير محددة رقميًا بالنص (النص يذكر "e.g., 90%+" كمثال فقط) — تم اعتمادها حرفيًا كما وردت في المثال.

---

## الاختبارات اللي اتعملت والنتايج

تم إنشاء `tests/integration/subscriptions-utilities.test.js` ويغطي:

- **الاشتراكات — الاستخدام والسعة**: 404 عند عدم وجود اشتراك؛ حساب `beds_used`/`percent_used` صحيح؛ `is_near_capacity = true` عند 90% بالضبط، و`false` تحت العتبة.
- **الاشتراكات — طلبات التوسيع**: إنشاء طلب `pending` مع سجل تدقيق `subscription_expansion_requested`؛ رفض طلب لا يتجاوز السعة الحالية (422)؛ رفض قيمة غير رقمية (422).
- **الاشتراكات — العزل حسب الملكية**: مالك B لا يرى اشتراك مالك A مطلقًا عبر `/me` (404، ليس بيانات مالك A).
- **الاشتراكات — حدود الأدوار**: رفض توكن طالب (403)، رفض الوصول من غير توكن (401).
- **Retrofit مبنى — إعداد المرافق**: القيمة الافتراضية `true` عند الإنشاء؛ تفعيل التبديل لـ `false` مع سجل تدقيق `building_utilities_setting_changed`؛ رفض قيمة غير Boolean (422)؛ **اختبار العزل الصريح**: مالك B لا يقدر يعدّل إعداد مبنى مالك A (403)، مع التأكد أن المبنى نفسه لم يتأثر.
- **رياضيات التقسيم**: تقسيم متساوٍ بدون باقٍ؛ **حالة الباقي الناتج عن التقريب** (100 على 3 طلاب = 33.33/33.33/33.34، والمجموع = 100 بالضبط).
- **تقديم الفاتورة**: رفض (409) عندما `utilities_included_in_rent === true`؛ رفض (409) عندما لا يوجد طلاب نشطون في الشقة؛ رفض `total_amount` غير موجب (422)؛ **الحالة الأساسية الناجحة**: تقسيم فاتورة على 3 طلاب نشطين، التحقق من تحديث `utility_amount`/`amount_due` الفعلي على كل دفعة، ووجود سجلي التدقيق (`utility_bill_created` و`payment_utility_charge_applied` لكل طالب).
- **العزل حسب الملكية (فواتير المرافق) — اختبار سلبي صريح**: مالك B لا يقدر يقدّم فاتورة لشقة مالك A (403، ولا يُنشأ أي سجل فاتورة فعليًا)؛ مالك B لا يقدر يعرض قوائم فواتير شقة أو مبنى مالك A (403 في الحالتين).
- **الـ Pagination**: قائمة فواتير الشقة محدودة بحجم الصفحة المطلوب مع `meta.total` صحيح.
- **Retrofit موديل الدفعة**: كل دفعة جديدة تُنشأ بـ `rent_amount = monthly_rent` و`utility_amount = 0`؛ **اختبار الترحيل الخلفي (backward-compatibility)**: إدخال سجل دفعة "قديم" مباشرة في قاعدة البيانات بدون حقلي `rent_amount`/`utility_amount` على الإطلاق (بنفس الشكل الذي كانت عليه سجلات المرحلة الخامسة قبل هذا الـ retrofit)، والتحقق أن قراءته عبر Mongoose تُطبِّق `rent_amount = amount_due` و`utility_amount = 0` تلقائيًا دون أي سكريبت هجرة.

**نتيجة التشغيل الفعلي:** تم التحقق من خلو جميع الملفات الجديدة والمعدَّلة من أخطاء التحميل والـ syntax فعليًا (تحميل `app.entry.js` بكامل شجرة الموديولات، بما فيها موديولي Subscriptions وUtilities الجديدين، نجح بدون أي خطأ). تم أيضًا التحقق العددي المباشر (بمعزل عن قاعدة البيانات) لدالة `splitAmountEqually()` بعدة حالات (تقسيم متساوٍ، باقي تقريب، مبالغ عشرية) — كل النتائج صحيحة والمجموع يطابق `total_amount` بالضبط في كل حالة.

**لم يتم تشغيل مجموعة اختبارات `mongodb-memory-server` (`tests/integration/subscriptions-utilities.test.js` وإعادة تشغيل `tests/integration/cash-payment.test.js` كاملة) فعليًا داخل بيئة الـ sandbox** — نفس القيد الموثَّق من المراحل السابقة، برصد إضافي دقيق هذه المرة: عند محاولة التشغيل، حاولت المكتبة تحميل ثنائي MongoDB بمعمارية **Windows** (`mongodb-windows-x86_64-6.0.14.zip`) رغم أن بيئة الـ sandbox نفسها Linux — وهذا يفشل حتمًا في هذه البيئة بغض النظر عن سرعة الشبكة. تم تنظيف ملفات التحميل الجزئية (`*.downloading`, `*.lock`) من الكاش المحلي حتى لا تعطّل أي محاولة تشغيل لاحقة. **GitHub Actions على جهاز صاحب المشروع (عبر `push.bat`) يبقى الطريقة الوحيدة الموثوقة للتحقق الفعلي من نجاح الاختبارات** — لكل من اختبارات هذه المرحلة، وإعادة تشغيل مجموعة اختبارات المرحلة الخامسة كاملة (`cash-payment.test.js`) للتأكد من عدم كسر أي شيء بسبب الـ retrofit على `payment.model`، كما طلب صاحب المشروع صراحة.

---

## أي انحراف عن الخطة الأصلية

### تم استبدال نسخة `Docs/phase-6-subscriptions.md` القديمة بالكامل
كانت هناك نسخة أقدم (النطاق الأصلي فقط، بدون تقسيم فواتير المرافق) من هذا الملف موجودة من الإعداد الأولي للمشروع. تم استبدالها بالكامل بالنسخة النهائية المرفقة من صاحب المشروع (استبدال كامل، وليس دمجًا)، بناءً على طلب صريح.

### انحرافات/قرارات ثانوية (موثَّقة بالتفصيل في قسم القرارات التقنية أعلاه)
- طلبات التوسيع مُضمَّنة كمصفوفة فرعية بدل موديل منفصل (قرار 1) — يطابق قائمة الملفات المذكورة بالنص حرفيًا.
- قاعدة "حظر الطلبات الجديدة للمالك المُعلَّق" **تم ربطها فعليًا** بموديول Requests بعد قرار صريح لاحق من صاحب المشروع (قرار 2) — انظر "تحديث لاحق للمرحلة" أدناه.
- فجوة معيارية موجودة مسبقًا (`err.statusCode || 400`) في باقي `building.controller.js` (من المرحلة الثالثة) تم رصدها دون تصحيحها بالكامل هذه المرحلة (قرار 6) — تستحق مراجعة مخصصة.
- عتبة تحذير الاستخدام 90% (قرار 7) — قيمة عمل مُعتمَدة من نفس المثال الوارد بالنص.

---

## الحالة النهائية للمرحلة

**الحالة: مكتملة من ناحية الكود والاختبارات المكتوبة (بما في ذلك تحديث ربط قاعدة الحظر بموديول Requests)، بانتظار الدفع (push) عبر `push.bat` من جهاز صاحب المشروع والتحقق الفعلي عبر GitHub Actions — بما في ذلك التأكد الصريح من عدم كسر أي اختبار من مجموعتي اختبارات المرحلتين الرابعة (`booking-engine.test.js`) والخامسة (`cash-payment.test.js`).**

كل خطوات التنفيذ المطلوبة (النطاق الأصلي: 1-6، وتقسيم فواتير المرافق: 7-12) اتنفذت بالكامل، بلا أي خطوة مُتجاهَلة أو مُبسَّطة بصمت. لم يتم تشغيل الاختبارات فعليًا داخل بيئة الـ sandbox للسبب التقني الموثَّق أعلاه (عدم توافق معمارية ثنائي MongoDB القابل للتحميل مع بيئة Linux الخاصة بالـ sandbox). لا أوامر Git تم تنفيذها من هذه الجلسة إطلاقًا (وفق البند 11 من CLAUDE.md) — كل الملفات جاهزة على القرص فقط، بانتظار الدفع اليدوي.

---

## تحديث لاحق للمرحلة (بعد المراجعة الأولى للتقرير)

بعد مراجعة صاحب المشروع لهذا التقرير، ورد قرار صريح بخصوص القرار المفتوح رقم 2 أعلاه:

### القرار المستلم
ربط قاعدة "المالك المُعلَّق ممنوع من قبول طلبات جديدة" بموديول Requests **الآن**، وليس تأجيلها للمرحلة السابعة. الأسباب اللي أوردها صاحب المشروع: (أ) دالة الفحص (`canAcceptNewRequests`) مبنية فعلًا ومُختبَرة بمعزل عن أي موديول آخر، (ب) المخاطرة منخفضة حاليًا لأن لا شيء في الكود يقدر يضع اشتراكًا في حالة `suspended` قبل وجود المرحلة السابعة (فالقاعدة حاليًا "خامدة" عمليًا، بلا أثر فعلي على أي تدفق قائم)، (ج) تأجيلها يخاطر بنسيانها لاحقًا، لأن تركيز المرحلة السابعة الفعلي سيكون بناء تدفّق التعليق نفسه لدى Super-Admin، لا مراجعة موديول Requests من جديد.

### التنفيذ
تم تعديل `src/modules/requests/request.service.js` فقط — إضافة استيراد `subscriptionService`، وإضافة فحص واحد (guard clause) داخل `createRequest()` مباشرة بعد جلب السرير (`bed`) وقبل عملية القفل الذرّي للسرير:

```js
const ownerCanAcceptRequests = await subscriptionService.canAcceptNewRequests(bed.owner_id);
if (!ownerCanAcceptRequests) {
  throw new AppError("This building's owner account is currently suspended and cannot accept new requests.", 403);
}
```

- **مصدر `owner_id`**: `bed.owner_id` مباشرة — نفس النمط المُستخدَم في كل مكان آخر بالكود (denormalized على مستوى السرير)، بدون الحاجة لمرور عبر الشقة/المبنى.
- **الترتيب**: الفحص يحدث **قبل** `bedService.atomicTransition(...)` — بنفس منطق سقف الطلبات المكررة (Duplicate-Request Cap) الموجود فوقه في نفس الدالة: رفض سريع بدون قفل سرير سيُرفض طلبه على أي حال.
- **كود الحالة**: `403` (Forbidden) — تم اختياره بدل `409` لأنه أقرب لفئة "حساب المالك غير مسموح له حاليًا"، بنفس نمط أكواد الأدوار/الصلاحيات المُستخدَم في باقي الكود (`requireRole`, `ownershipScoping`)، لا فئة "تعارض حالة على المورد نفسه".
- **لا توجد دائرة استيراد (require cycle)**: `subscription.service` يعتمد فقط على `bed.service` و`audit.service`، وليس له أي مسار عودة لـ `request.service` أو لأي موديول يعتمد عليه.

### ملفات مُعدَّلة/مُضافة في هذا التحديث
```
src/modules/requests/request.service.js         → استيراد subscription.service + guard clause في createRequest()
tests/integration/booking-engine.test.js         → استيراد Subscription model/subscription.service، تنظيف Subscription
│                                                    في beforeEach، وdescribe block جديد "Subscription Gating
│                                                    (Phase 6 retrofit)" بثلاثة اختبارات (تفاصيل أدناه)
Docs/reports/phase-6-subscriptions-report.md     → هذا التحديث
```

### اختبارات هذا التحديث
تم إضافة `describe('Subscription Gating (Phase 6 retrofit)')` داخل `tests/integration/booking-engine.test.js` (المرحلة الرابعة)، يحتوي على:

- **الاختبار الأساسي المطلوب صراحة**: مالك عنده اشتراك بحالة `suspended` → طلب طالب لإنشاء حجز على سرير هذا المالك يُرفض بـ `403`، **والتأكد أن السرير لم يُقفَل** (لسه `available`) — الفحص يحدث قبل القفل الذرّي، بنفس نمط اختبار سقف الطلبات المكررة الموجود بالفعل بنفس الملف.
- **اختبار مُكمِّل (عدم اشتراك أصلًا)**: مالك بدون أي سجل اشتراك على الإطلاق (الحالة الواقعية لكل الملاك الحاليين قبل توفير Phase 7) → الطلب يُقبَل بشكل طبيعي (`201`) — يتأكد أن الفحص "no-op" وليس متطلبًا صارمًا، وأنه لا يكسر السلوك الحالي لأي مالك بلا اشتراك مُفعَّل.
- **اختبار مُكمِّل (اشتراك نشط)**: مالك عنده اشتراك بحالة `active` → الطلب يُقبَل بشكل طبيعي (`201`) — يتأكد أن الفحص لا يحظر التدفّق الطبيعي بالخطأ.

### نتيجة التشغيل الفعلي لهذا التحديث
تم التحقق من خلو `request.service.js` و`booking-engine.test.js` (والملفات الأخرى المعدَّلة سابقًا) من أخطاء الـ syntax (`node --check`)، وتم التأكد أن `app.entry.js` بكامل شجرة الموديولات (بما فيها الربط الجديد بين Requests وSubscriptions) لسه يُحمَّل بدون أي خطأ — أي لا توجد دائرة استيراد ولا خطأ تحميل ناتج عن هذا التغيير.

**لم يتم تشغيل مجموعتي الاختبارات فعليًا (`booking-engine.test.js` كاملة، ولا `cash-payment.test.js`، ولا `subscriptions-utilities.test.js`) داخل بيئة الـ sandbox** — نفس القيد التقني الموثَّق سابقًا في هذا التقرير بالضبط (محاولة تحميل ثنائي MongoDB بمعمارية Windows داخل بيئة Linux). تم إعادة محاولة التشغيل وتنظيف ملفات التحميل الجزئية من الكاش مرة أخرى في هذه الجولة، لكن السبب الجذري (معمارية الثنائي الخاطئة) بيئي وليس شيئًا يمكن حله من داخل الـ sandbox. **بانتظار الدفع عبر `push.bat` ونتيجة GitHub Actions الحقيقية** — لتأكيد أن مجموعتي اختبارات المرحلتين الرابعة والخامسة، بالإضافة لمجموعة اختبارات هذه المرحلة، تنجح **معًا** بدون أي تعارض ناتج عن هذا الربط الجديد، كما طلب صاحب المشروع صراحة.

---

## إصلاح خلل حقيقي بعد أول تشغيل CI حقيقي (GitHub Actions)

بعد الدفع الفعلي عبر `push.bat` وتشغيل GitHub Actions لأول مرة، ظهر خطأ حقيقي وقت التشغيل من `subscription.controller.getMySubscription`:

```
TypeError: bedRepository.countByOwner is not a function
    at bed.service.js:52:24 (countBedsForOwner)
    at subscription.service.js:64:37 (getUsageForOwner)
```

### السبب الجذري
**نفس نمط الخلل الحقيقي المُكتشَف في المرحلة الرابعة بالضبط** (الموثَّق في البند 7.3a من CLAUDE.md: `bedRepository.conditionalUpdateStatus` كانت مبنية لكن غير مُصدَّرة من `module.exports`). في هذه الحالة: دالة `countByOwner()` في `src/modules/beds/bed.repository.js` كانت **مكتوبة فعليًا وصحيحة منطقيًا** (السطور 33-35 من الملف)، لكنها **لم تُضَف لكائن `module.exports`** أسفل الملف — فكانت `bedRepository.countByOwner` تُقيَّم إلى `undefined` وقت التشغيل الفعلي، رغم أن الدالة موجودة في الملف ورغم أن كل الفحوصات الثابتة اللي تمت هذه المرحلة (`node --check` وتحميل `app.entry.js` بالكامل) **لا يمكنها اكتشاف هذا النوع من الأخطاء** — `require()` لا يفشل ولا يُحمِّل خطأً عند نسيان تصدير دالة واحدة من كائن موجود بالفعل؛ الخطأ يظهر فقط عند **استدعاء** الدالة الناقصة فعليًا، أي وقت تنفيذ اختبار حقيقي أو طلب HTTP حقيقي — بالضبط السبب اللي يجعل البند 7.3a من CLAUDE.md مهمًا: تصنيف الخطأ الصحيح (`TypeError` غير مُتوقَّعة، وليست `AppError` عادية) + تسجيلها فعليًا في اللوج (`console.error`) هو اللي خلّى تشخيص السبب فوريًا من أول سطر في اللوج، بدل رسالة عامة "400 Bad Request" مُبهمة.

### الإصلاح
تعديل سطر واحد في `src/modules/beds/bed.repository.js` — إضافة `countByOwner` لكائن `module.exports`:

```js
module.exports = {
  create,
  findById,
  findByApartment,
  countByApartment,
  countByOwner,        // ← كانت ناقصة
  findAllByApartmentIds,
  updateById,
  conditionalUpdateStatus,
  deleteById,
  aggregateStatusCounts,
};
```

### فحص شامل لنفس النمط عبر كل ملفات هذه المرحلة
بعد الإصلاح، تم عمل مسح شامل (سكريبت Node واحد، بمعزل عن كل ملفات `repository`/`service`/`controller` التي لمستها هذه المرحلة أو المرحلة السابقة من هذا التحديث) يقارن كل دالة مُعرَّفة بصيغة `function` على المستوى الأعلى في كل ملف مقابل ما هو مُصدَّر فعليًا من `module.exports`، للتأكد من عدم وجود نسخة أخرى من نفس الخلل مختبئة في مكان آخر. النتيجة: **الحالة الوحيدة الحقيقية كانت `bedRepository.countByOwner`**؛ باقي الدوال غير المُصدَّرة اللي ظهرت في المسح (`handleControllerError`, `validateBillFields`, `validateBuildingFields`, `buildFilter`, `toObjectId`) هي دوال مساعدة داخلية مقصودة عمدًا بدون تصدير — نفس النمط المُتَّبع في كل موديول آخر بالكود قبل هذه المرحلة (مثال: `buildFilter` في `payment.repository.js` نفسها لم تكن مُصدَّرة من الأساس منذ المرحلة الخامسة، وهذا صحيح ومقصود). تم أيضًا التأكد صراحة (باستدعاء فعلي لا فحص نصي فقط) أن كل دالة عابرة للموديولات أضافتها هذه المرحلة قابلة للاستدعاء فعليًا وقت التشغيل: `bedService.countBedsForOwner`, `rentalService.listActiveOrVacatingRentalsForBeds`, `paymentService.ensurePaymentForPeriod`, `paymentService.applyUtilityCharge`, `buildingService.setUtilitiesIncludedInRent`.

### ملفات مُعدَّلة في هذا الإصلاح
```
src/modules/beds/bed.repository.js               → إضافة countByOwner لـ module.exports (السطر الناقص فقط)
Docs/reports/phase-6-subscriptions-report.md      → هذا القسم
```

**لم تُلمَس ملفات المرحلتين الرابعة والخامسة (`booking-engine.test.js`, `cash-payment.test.js`) إطلاقًا في هذا الإصلاح** — تأكيد صاحب المشروع أن كلا المجموعتين نجحتا 100% في نفس تشغيل GitHub Actions يعني أن أي تعديل إضافي عليهما غير مبرر وغير مطلوب.

**نتيجة التحقق المحلي لهذا الإصلاح:** تم استدعاء `bedRepository.countByOwner` و`bedService.countBedsForOwner` و`subscriptionService.getUsageForOwner` فعليًا (لا فحص نصي فقط) والتأكد أنها دوال قابلة للاستدعاء (`typeof === 'function'`)، وتم إعادة تحميل `app.entry.js` بالكامل للتأكد من عدم وجود أي كسر آخر. **بانتظار إعادة الدفع عبر `push.bat` وتأكيد GitHub Actions أن 169/169 اختبارًا تنجح فعليًا** (مجموعات المراحل الرابعة والخامسة والسادسة معًا) بعد هذا الإصلاح.
