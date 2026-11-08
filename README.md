# AI World Builder

A 3D world editor for the browser with lightweight local planning and optional Wikipedia search. Describe a world in
text, inspect and edit it in a Three.js viewport, save it locally, and export it
as a project file or a glTF 2.0 model for Godot and Unity.

> **Phase 3 status:** prompts now become a validated, versioned WorldPlan that is
> built by a structured procedural planner — including a complete cartoon farm
> with a farmhouse, barn, wheat fields, chicken coop, fences, lanes, orchard and
> optional river/bridge. Every generated object is editable, and one object or a
> whole region can be re-rolled in place. Full audit, architecture, risks and
> remaining work are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## تشغيل نسخة الهاتف في Termux (مساعد خفيف + تعلّم تجريبي)

النسخة المصغرة لا تحتاج إلى Qwen أو llama.cpp أو ملف نموذج كبير أو حساب أو مفتاح API. تستخدم تفسيراً محلياً قائماً على كلمات محدودة، ونموذجاً إحصائياً صغيراً يتعلم متوسط الأبعاد من أمثلة مبدئية مصممة للتطبيق ومن العناصر التي تختارها للتدريب. يبني البرنامج هندسة إجرائية لبيت وشجرة عريضة الأوراق وصخرة مستديرة؛ **ليس نموذج لغة أو نموذجاً عاماً يتعلم أشكالاً جديدة من الإنترنت**. يتطلب الاتصال بويكيبيديا قبل كل إنشاء، ويمكن البحث فيها عند الطلب. يبحث التدريب التجريبي للصور في Wikimedia Commons، لا في الإنترنت كله. يتعلم الخادم إحصائياً كلمات قليلة من مقتطفات ويكيبيديا عن التضاريس، لتقدير البيئة فقط؛ لا يتعلم صناعة الأشكال أو تحويل الصور إلى 3D من نصوص ويكيبيديا.

1. أوقف الخادم القديم في Termux بالضغط على Ctrl+C، ثم ثبّت Python وcurl وPillow للصور:

   ```sh
   pkg update && pkg install python curl python-pillow
   ```
2. نزّل **الملفات الأربعة معاً** لتحديث نسختك وشغّل الخادم:

   ```sh
   mkdir -p ~/world-builder && cd ~/world-builder && \
   curl -fL 'https://github.com/benmerfatah0-lang/ai-builder/raw/refs/heads/arena/6c5ab37a-ai-builder/world-builder-mobile.html' -o world-builder-mobile.html && \
   curl -fL 'https://github.com/benmerfatah0-lang/ai-builder/raw/refs/heads/arena/6c5ab37a-ai-builder/world-builder-server.py' -o world-builder-server.py && \
   curl -fL 'https://github.com/benmerfatah0-lang/ai-builder/raw/refs/heads/arena/6c5ab37a-ai-builder/wiki_learner.py' -o wiki_learner.py && \
   curl -fL 'https://github.com/benmerfatah0-lang/ai-builder/raw/refs/heads/arena/6c5ab37a-ai-builder/house_learner.py' -o house_learner.py && \
   python world-builder-server.py
   ```

3. اترك Termux مفتوحاً وافتح **http://127.0.0.1:8080/world-builder-mobile.html** في متصفح الهاتف، ثم حدّث الصفحة. من صفحة Forge اكتب مثلاً «بيت وشجرة وصخرة» واضغط «أنشئ العالم»، ثم «فتح العالم في المحرر». زر Builder يفتح المحرر مباشرة، وGrimoire يفتح مكتبة عوالم هذا التطبيق المحفوظة في المتصفح. إذا كان المنفذ مستخدماً أوقف الخادم القديم أولاً. لإعادة التشغيل لاحقاً: `cd ~/world-builder && python world-builder-server.py`.
4. لتدريب الأشكال اختر بيتاً أو شجرة عريضة الأوراق أو صخرة مستديرة من المشهد، وعدّل حجمها في **Inspect**، ثم افتح **AI**، وافتح «التعلّم والتدريب وحالة المصادر»، واضغط «تعلّم من العنصر المحدد». يعيد ذلك حساب متوسط أبعاد فئتها. أنشئ مشهداً جديداً لرؤية تأثيره؛ البيانات تحفظ في المتصفح ويمكن حذفها من اللوحة. الأشكال المدربة تطبّق على طلبات الأصول الصريحة، لا قالب المزرعة أو النباتات الأخرى.
5. **تعلّم الخرائط التلقائي:** عند فتح الصفحة وظهورها يجرّب التطبيق كل نحو 45 ثانية خرائط صغيرة من أوصاف محلية اصطناعية. يقارن تجربة جديدة بالسابقة على الوصف والبذرة نفسيهما وفق معايير بسيطة للتوزيع وتنوع الأنواع والتحذيرات، ويحتفظ بالتغييرات المقبولة في المتصفح. يغير ثلاثة معاملات لكثافة الأشجار والصخور والمباني للمناظر العامة فقط؛ لا يغير الأعداد الصريحة، أو تخطيط الأصول المحددة، أو قالب المزرعة. يتوقف عندما تكون الصفحة مخفية أو مغلقة ويمكن إيقافه أو حذفه من لوحة AI. قد يستهلك بعض البطارية والمعالج، ولم يُقَس على هاتف حقيقي.
6. هذا التقييم ليس تقييماً بشرياً لجودة التصميم أو متعة اللعب؛ التدريب المحلي للخرائط لا يقرأ الإنترنت، ولا يعلّم المساعد هندسة جديدة أو كيفية بناء مراحل قابلة للعب، ولا يضمن التحسّن المستمر أو بلوغ الاحتراف. لا يؤثر تعطيل التدريب على إنشاء المشهد بعد التحقق من الإنترنت.
7. يبحث التطبيق تلقائياً عن الكلمات التي يشتبه بأنها غير معروفة في ويكيبيديا وWikimedia Commons كما هو موضح أدناه. ويمكن كتابة «ابحث» لطلب البحث عن وصف معروف في ويكيبيديا. فشل التحقق من الاتصال يمنع الإنشاء؛ فشل البحث التلقائي عن كلمة يظهر بوضوح ولا يمنع إنشاء عالم تقريبي بالعناصر المعروفة.

### البحث التلقائي عن الأشياء غير المعروفة

عند إنشاء عالم، يفحص المساعد الوصف تلقائياً؛ إذا رصد كلمات يشتبه أنها غير معروفة، حتى بجانب عناصر يعرفها، يبحث عن أول موضوعين في ويكيبيديا وWikimedia Commons، ويعرض المقتطفات وروابط المصادر وصوراً مصغرة مع المؤلف والترخيص. عند فشل أمر تعديل نصي، يبحث أيضاً عن الكلمات غير المعروفة المحتملة دون تعديل العالم. لا يلزم حفظ مرجع أو فتح مكتبة. في حالة محدودة جداً قد يستنتج المساعد من مقتطف مقال مطابق أن الشيء نوع من البيت، فيمثّله بنموذج بيت موجود تقريبياً؛ في الحالات الأخرى قد يُهمل العنصر المجهول ويظهر تحذير. فشل أحد البحثين يظهر منفصلاً ولا يمنع إنشاء عالم تقريبي.

التعرّف قائم على قاموس وقواعد محدودة وليس فهماً عاماً؛ قد يبحث عن كلمة معروفة أو يفوّت كلمة مجهولة، ولا يُبحث إلا عن أول موضوعين لتقليل الطلبات. تُرسل كلمات البحث إلى ويكيبيديا وCommons تلقائياً، ويتصل المتصفح بـWikimedia لعرض الصور المصغرة. يعرض البحث حتى 8 صور JPEG أو PNG بنتائج Commons المرخصة CC BY أو CC BY-SA أو CC0 ومع بيانات المؤلف المطلوبة. راجع المصدر والترخيص وشروط الإسناد قبل إعادة الاستخدام؛ لا يُضمن أن النتائج تطابق الطلب. في تقريب البيت المحدود، يحسب التطبيق متوسط لون وسط أول صورة مصغرة ويستخدمه للون جدران البيت إن لم يحدد المستخدم لوناً؛ قد تكون الصورة غير مطابقة أو يكون لون الخلفية. لا يتعرف على محتوى الصورة، ولا يستخرج شكل 3D منها.

عندما يوجد موضوع واحد ونتيجة ويكيبيديا مطابقة لعنوانه، قد يستعمل التطبيق كلمات تضاريس محددة في المقتطف لتقدير البيئة فقط، ما لم يحدد المستخدم بيئة أو مزرعة. وإذا احتوى المقتطف تعريفاً محدوداً واضحاً من نوع «هو منزل»، يمكن تمثيل الموضوع بنموذج البيت الموجود في المكتبة؛ لا يحصل ذلك إذا اختلط الطلب ببيت آخر أو عدة موضوعات مجهولة أو قالب المزرعة. يمكن مثلاً أن يضيف «أضف كوخ» بيتاً تقريبياً إذا تطابقت النتيجة واحتوت تعريفاً مدعوماً. يعمل ذلك للإضافة فقط، وليس للأوامر الخطرة كالحذف. يمكن التراجع عنه؛ وإذا تغيّر العالم أو الأمر أثناء البحث لن يُطبَّق. قد تكون النتيجة أو صورة البحث غير مناسبة، فراجعها.

تحليل الصورة يتطلب `python-pillow` في Termux ويحمل صورة مصغرة واحدة (بحد ميغابايت) من عنوان Wikimedia موثوق، ويحلل متوسط اللون بعد تصغيرها، ولا يحفظ بكسلاتها. عند غياب Pillow أو فشل تحليل الصورة يستعمل اللون الافتراضي ويظهر السبب. لا يجري تعلم عام ولا استخراج شكل أو أبعاد من الصورة أو المقالة؛ حالات الفيل وغيرها ما زالت غير مدعومة. إن ذكر الوصف لوناً فلا يُطبّق لون الصورة، لكن لون الوصف نفسه لا يُطبّق تلقائياً في هذا المسار؛ غيّره من Inspect. تظهر روابط المصدر أثناء النتيجة فقط ولا تُضمّن حالياً في المشروع أو ملف GLB، فاحتفظ بالإسناد بنفسك قبل المشاركة. البحث الجديد لا يحفظ مكتبة مراجع محلية. المراجع التي حُفظت في الإصدار السابق لا تُستخدم ولا تُحذف تلقائياً؛ بيانات تعلّم التضاريس وصور البيوت السابقة منفصلة ولم تُمسّ.

### تعديل العالم بالكتابة

بعد إنشاء العالم اختر **Builder**، ثم في الهاتف افتح **AI** من الشريط السفلي. في «عدّل عالمك بالكتابة» اكتب أمراً واحداً واضغط «تطبيق التعديل». أمثلة: «أضف شجرتين على يمين البيت»، «لوّن البيت أحمر»، «كبّر البيت»، «احذف البيت»، «حرّك البيت إلى يسار الشجرة». تعمل هذه الأوامر المحدودة محلياً على العالم المفتوح ولا تستبدله بعالم آخر؛ الإنشاء الجديد يظل وظيفة منفصلة. للحذف والتحريك وتغيير الحجم واللون تُعدَّل قطعة واحدة في كل مرة، وللإضافة 20 قطعة كحد أقصى في الأمر الواحد. اليمين واليسار والأمام والخلف حسب محاور العالم، لا الكاميرا. في حالة تشابه العناصر اختر العنصر المطلوب أولاً، أو استخدم «العنصر المحدد» بعد تحديده. العناصر المقفلة لا تُعدّل؛ تحريك أو تكبير العناصر داخل مجموعة يتطلب استخدام لوحة Inspect حالياً. إذا لم يفهم البرنامج الأمر أو لم تتوفر مساحة كافية فلن يُطبَّق، ويمكن التراجع عن التعديل من قائمة المشروع ← Undo. فحص التداخل تقريبي، ويترك الطرق والأنهار والأرضيات تحت الأصول.

تحسّن فهم الأعداد والمفرد والمثنى وبعض أوصاف أحجام العناصر والمواضع في إنشاء العوالم أيضاً. المعاني مدعومة بقواعد محدودة وليست فهماً عاماً، وقد يُتجاهل وصف غير معروف. الجبل تضاريس في هذه النسخة وليس عنصراً مستقلاً يمكن تثبيت المواضع نسبةً إليه؛ يظهر تحذير عند طلب ذلك. وظائف التعلّم السابقة منفصلة عن هذه القواعد.

### واجهة WorldForge

أُعيد تصميم الصفحة الرئيسية والمحرر بألوان وتخطيط مستوحاة من ملفات WorldForge النصية المرفقة، مع استخدام منشئ المشاهد والتخزين والتصدير الحاليين. علامة Forge تفتح الإنشاء، وGrimoire تفتح المكتبة المحلية، وBuilder يفتح المحرر. التطبيق القديم كان يستخدم واجهات وخدمات مختلفة، ولذلك لم ننقل واجهاته الخلفية أو وعودها حول رفع الصور. ملف النص يذكر ملفات ZIP ثنائية لم تُرفق محتوياتها، لذا لم تُستورد منها أصول أو عوالم قديمة. المشاريع المحفوظة لهذا التطبيق تبقى في تخزين المتصفح كما هي.

### التعلّم المحدود من ويكيبيديا في Termux

أثناء تشغيل `world-builder-server.py`، يجري خيط خلفي بحثاً كل خمس دقائق تقريباً في ويكيبيديا فقط عن موضوعات ثابتة للتضاريس. يستخرج مفردات من قائمة ثابتة ويحدّث إحصاءات ارتباطها بالصحراء والغابة والجبل والجزيرة، ويحفظها ومراجعها في `~/world-builder/wiki-map-learning.json`. تُستخدم الارتباطات عند تعذّر تحديد البيئة بكلمات الوصف المعتادة؛ مصادر التدريب وحالة آخر تحديث تظهر بعد إنشاء عالم. هذه إحصاءات بسيطة وليست تدريب شبكة عصبية، ولا تعلّم هندسة 3D أو تحويل الصور إلى 3D أو اللعب. لا تُرسل أوصاف المستخدم أثناء التدريب الدوري، لكن الاستعلامات الثابتة ترسل لويكيبيديا ويُستهلك الإنترنت والبطارية.

يمكن إغلاق صفحة المتصفح ويبقى التدريب ما دامت عملية Termux تعمل والإنترنت متاحاً. لا يعمل عند إيقاف Termux أو إعادة تشغيل الهاتف ما لم يُشغَّل الخادم ثانية، وقد يوقف Android العملية أو يؤخرها في الخلفية؛ لا يُضمن تشغيل دائم. إذا لم تظهر مقالات جديدة فلا تتغير الإحصاءات؛ يحتفظ بمراجع أحدث 200 مقالة كحد أقصى. تعذّر الاتصال أو حفظ الملف يظهر في حالة التدريب. يمكن حذف ملف التعلم يدوياً والخادم متوقف إذا رغبت في البدء من جديد.

### تجربة محدودة لتعلم البيوت من الصور

يبحث خيط منفصل في خادم Termux كل عشر دقائق تقريباً في Wikimedia Commons بعبارات ثابتة عن صور بيوت، ويختار فقط ملفات ذات رابط ترخيص CC BY أو CC BY-SA أو CC0 وبيانات إسناد متاحة. يُنزّل صورة مصغرة واحدة بحد أقصى ميغابايت، لا تُحفظ صورتها، ويجرّب 32 تعديلاً لأبعاد نموذج إجرائي ثلاثي الأبعاد (جدران وسقف وأبواب ونوافذ). يقارن الإسقاط من زاوية ثابتة بالصورة المصغرة 64×64 وفق فرق بكسلات بسيط؛ يحتفظ بالنتيجة إذا تحسن الفرق، ثم ينتقل للبحث التالي حتى لو لم تتحسن. الخلفيات والزوايا والألوان والرسوم غير المتعلقة بالبيوت قد تضلل هذا المقياس، ولا يعرف الجوانب المخفية ولا يضمن جودة أو تشابهاً حقيقياً.

هذه **ليست شبكة عصبية أو نموذجاً عاماً يحوّل الصور إلى 3D**: لا تُنشأ هندسة جديدة، ولا تتعلم التجربة المشاهد أو الحدائق والأسوار. يصنّف عنوان الصورة ووصفها وفق كلمات قليلة مثل small وtall وwide فقط؛ ويمكن أن يكون التصنيف خاطئاً. تمزج إحصاءات الأبعاد المحفوظة مع تدريب المستخدم الشخصي عند إنشاء بيت مطلوب صراحة مثل «بيت صغير»؛ إذا لم توجد بيانات للفئة، تستخدم الإحصاءات العامة إن وُجدت. تدريب المستخدم لا يُحذف، والأعداد الصريحة وأصول الشجرة والصخرة وقالب المزرعة لا تتغير. عند عدم قبول أي صورة لا يحدث أثر على البيوت.

تحفظ آخر 100 نتيجة مقبولة في `~/world-builder/house-image-learning.json` مع اسم المصدر والمؤلف ورابط الملف وترخيصه، وتُزال مساهمة النتيجة الأقدم عند تجاوز الحد. راجع روابط المصادر في لوحة AI بعد إنشاء عالم؛ عند مشاركة نتائج مستوحاة من الصور تحقّق من شروط الإسناد والترخيص ومتطلبات مشاركة التعديلات في صفحات الملفات. لم تُستخدم صورة Pngtree المرفقة في التدريب لأن ترخيصها لم يُتحقق منه. يبقى التدريب يعمل بعد إغلاق الصفحة فقط ما دام Termux والإنترنت يعملان، وقد يوقفه Android؛ يستهلك البطارية والبيانات. عند غياب `python-pillow` أو فشل الإنترنت أو الحفظ تظهر الحالة ولا يتعطل الخادم؛ إن لم يجد صوراً مناسبة فلن يتعلم من صور. لم تُجرَ تجربة على الهاتف أو الشبكة الحقيقية في بيئة الاختبار.

### مثال مدينة التعدين الصحراوية

يمكن تجربة «مدينة صحراوية قديمة فيها منجم عميق للذهب بعربات ومعاول وحفارات وصناديق». يفهم التطبيق هذه الكلمات ويضع مدخل منجم، ومعدات وصناديق قربه، وخمسة بيوت رملية افتراضياً إذا طُلبت مدينة ولم يُحدَّد عدد البيوت. يمكن تعديل الأعداد صراحة. العناصر نماذج زخرفية ثابتة؛ واجهة المنجم توحي بالعمق لكنها **لا تحفر الأرض ولا تتضمن أنفاقاً أو منجماً قابلاً للدخول**. أُضيف المثال والقواعد يدوياً إلى الكود، وليس نتيجة تعلّم المساعد ذاتياً من محادثة المستخدم.

النموذج القديم `~/world-builder/model.gguf` لم يعد يُستخدم ولا يُحذف تلقائياً. لا تحذف بيانات المتصفح قبل تصدير المشاريع المهمة؛ مسحها قد يحذف التدريب والمشاريع. لا يجري أي اختبار سرعة أو اختبار على جهاز Android حقيقي ضمن اختبارات المشروع.

To rebuild the standalone phone file after source changes, run `npm run build:mobile`.

## What works today

- **3D viewport (real WebGL 2)** — a live `THREE.WebGLRenderer` on a WebGL 2
  context with ACES filmic tone mapping, sRGB output, PCF soft shadows, a
  procedural **shader sky** (gradient + sun disc that follows the world sun),
  **animated water** (GLSL ripple injected into the PBR material), orbit/pan/zoom
  for mouse and touch, grid and ground plane, terrain, click/tap selection with
  outlines, double-click framing, and a move/rotate/scale **gizmo** with
  world/local space and snapping. The HUD reports the live GPU API, FPS and draw
  calls, and the camera button exports the current frame as a PNG.
- **Procedural worlds** — five terrain styles (hills, flat, mountains, dunes,
  islands), seeded object scatter, settlements, ruins, lanterns, palms, cacti,
  biome palettes and day/sunset/night lighting.
- **Structured farm generation** — the planner lays out a real farm instead of
  scattering primitives: a grounded farmhouse, gabled barn with lean-to and hay,
  grain silo, chicken coop with run and chickens, fenced wheat fields with
  instanced crops, connecting dirt lanes that follow the terrain, an orchard,
  windbreak trees, and an optional creek with a planked bridge. Footprints are
  collision-checked against a spatial grid, so solids do not intersect.
- **Text-to-world generation** — a limited rule-based interpreter recognises
  descriptions and can use Wikipedia biome hints before building a validated, bounded list of assets.
  The local procedural planner builds that list into a **WorldPlan v3**.
  A tiny trainable statistical model affects procedural house, broadleaf and boulder shapes for explicit asset requests. The same plan and seed rebuild the same placement, but search results can vary.
- **Validate before build** — every plan is checked structurally (Zod +
  hierarchy) and semantically (unsupported geometry, out-of-bounds objects,
  floating/buried solids, overlapping buildings, a bridge without a river).
  Blocking errors stop generation; warnings are reported and recoverable
  problems can be repaired.
- **Scene hierarchy** — a real tree (`role="tree"`) with groups, parent/child
  nesting up to 8 levels, inline rename, filter, per-node visibility and lock
  (both inherited by children), multi-select and reparent-by-grouping.
- **Transform editing** — drag the gizmo or type exact **position / rotation
  (XYZ degrees) / scale** values in the inspector, which also shows world-space
  values for grouped nodes. Snapping: 0.5 units, 15°, 0.1 scale.
- **Editor operations** — group, ungroup, duplicate (deep copy with new IDs),
  delete, snap-to-ground, colour and material editing (roughness, metalness,
  emissive), asset library (now incl. barn, coop, bush, dirt path, fence, wheat
  field and bridge), undo/redo and keyboard shortcuts (below).
- **Regenerate in place** — the inspector shows each object's geometry id,
  source, status, region and variation seed. **Regenerate** re-rolls that
  object's species/shape/palette/crop pattern without moving it; **Region**
  re-rolls every generated object in the same region. Both are single undo steps
  and only the affected scene nodes are rebuilt.
- **Local saving** — debounced autosave to IndexedDB, manual “Save now”, a
  multi-world library (open, duplicate, delete), in-app status, import/export of
  `.world.json` project files, and a session fallback when IndexedDB is blocked.
  Damaged project files are repaired on import (unreadable nodes dropped,
  orphans re-rooted, cycles broken) with visible warnings.
- **Export** — lossless WorldPlan JSON and binary glTF 2.0 (`.glb`) built from
  the same scene as the viewport. The glTF exporter is lazy-loaded.
- **Responsive UI** — desktop three-column layout (scene tree, viewport with
  floating toolbar, inspector) and a mobile layout with a bottom dock, bottom
  sheet, touch orbit + pinch-zoom, safe-area handling and 16 px inputs.

Planning uses a local rule-based interpreter, a trainable statistical shape model, automatic density tuning on synthetic scenes, and a bounded Wikipedia vocabulary learner and an experimental Wikimedia Commons house-image fitting worker in the Termux process, with Wikipedia search when requested and a required internet check before each generation.
No external 3D assets are downloaded; rendering, saving and export are local.

### What is deliberately not there yet

No placeholder buttons or mock features are shipped:

- Web search informs the AI but does not import new models or guarantee an exact
  replica; available 3D objects and compositions are limited by the local catalog.
- No click-to-place on terrain, box selection or terrain sculpting yet. Buildings
  are grounded, but terrain edits do not re-snap existing objects.
- GLB export has geometry, materials, vertex colours and generated textures, but no lights, colliders,
  LODs or native Godot/Unity project files.
- The WebGL rendering path could not be visually tested in the development
  sandbox (no GPU); real desktop/Android QA remains the first task.
- Farm layouts are authored around one yard template with seeded mirroring and
  variation; larger settlements/road graphs are future work.

Full risk list and roadmap: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start

Requirements: **Node.js 20.19+ or 22.12+** (Vite 7). Online generation also
requires internet and the loopback-only Python phone server; no LLM or downloaded model is required. Vite proxies `/api` to this server on port 8080; start it separately as above. The static website server does not provide the AI API.

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview    # serves dist/ on http://localhost:4173
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server bound to `0.0.0.0`. |
| `npm run build` | Strict type-check, then production build to `dist/`. |
| `npm run preview` | Preview the production build. |
| `npm run typecheck` | `tsc --noEmit` with strict settings. |
| `npm test` | Vitest: schema/migration, farm + scatter generation, validation/repair, regeneration, persistence, export, store, procedural scene, DOM runtime. |
| `npm run test:watch` | Watch mode. |
| `npm run schema:export` | Regenerate `docs/worldplan.schema.json` from the Zod schema. |
| `npm run render:preview` | Render a generated world to a PNG with a dependency-free software rasteriser (visual QA without a GPU). |
| `npm run site` | Serve the project website and the editor at `http://localhost:4173` (`/app/`). |
| `npm run site:build` | Rebuild the site playground bundle and the editor build in `website/public/`. |

---

## Project structure

```
src/
  app/                 React entry composition
  core/
    world-plan/        WorldPlan v3 schema, factory, migration, hierarchy, transform math,
                       generation metadata, geometry registry, semantic validation, colours
    generation/        seeded RNG, terrain sampler, biomes, scatter generator, farm planner,
                       spatial placement ledger, per-object/region regeneration, starter
    assets/            procedural asset library, structures (barn/coop/silo/path/fence/field/river/bridge)
    persistence/       IndexedDB/memory repositories, project file I/O
    export/            glTF 2.0 (.glb) exporter + export target metadata
    scene/             shared Three.js scene builder (viewport + exporter), kit + Phase 3 geometry
    utils/             IDs, hashing, clamping
  modules/
    ai/                intent types, provider contract, offline interpreter
    editor/            reducer store, autosave, gizmo viewport, toolbar, hierarchy/inspector panels, shell
  ui/                  icons, controls, top bar, library dialog, export menu, toast
  styles/              design tokens + responsive CSS
  test/                Vitest setup (fake IndexedDB, GLB FileReader shim)
scripts/               schema export, offline preview renderer
website/               project site (static page + in-browser playground + static server)
docs/                  architecture report, WorldPlan reference, JSON Schema
```

Key design rule: the **WorldPlan document is the only source of truth**, and the
viewport and exporters share one scene builder. React never owns scene objects
outside the viewport component, and all hierarchy edits (group, ungroup,
reparent, duplicate) are pure functions over the document — the gizmo only
reports back a transform, which the reducer sanitises and records for undo.

---

## Saving and backup

Worlds autosave to this browser's IndexedDB after ~0.65 s of inactivity and are
listed in the world library. Browser storage can be cleared by the user, the
browser or private mode, so use **Export → Project file** for anything important.
Project files are self-contained, versioned and re-importable; they are also the
way to move worlds between devices.

The document format is documented in [`docs/WORLDPLAN.md`](docs/WORLDPLAN.md),
with a generated JSON Schema at
[`docs/worldplan.schema.json`](docs/worldplan.schema.json).

---

## Exporting to Godot and Unity

**Export → 3D model** produces a binary glTF 2.0 file:

- **Godot 4** imports `.glb` natively (drag it into the project).
- **Unity** needs a free glTF importer package; the file is standard glTF 2.0.
- Materials use PBR metallic-roughness with vertex colours on the terrain.
- Lights, collision and LODs are not exported yet.

**Export → Project file** is the lossless format for re-opening in this editor.

---

## Rendering

The viewport is a genuine WebGL 2 renderer, not a 2D fallback:

| Layer | Implementation |
| --- | --- |
| Context | `WebGLRenderer` with WebGL 2; retries with simpler attributes if a device rejects antialiasing or `high-performance` |
| Colour | ACES filmic tone mapping, sRGB output, PCF soft shadows |
| Sky | Custom GLSL dome: zenith/horizon gradient plus a physically aligned sun disc and glow |
| Water | PBR water with a per-pixel ripple injected into the standard shader (no textures, no extra pass) |
| Performance | Pixel-ratio cap, lower shadow resolution and point-light budget on phones, automatic resolution step-down if FPS stays below 28 |
| Resilience | GPU context-loss recovery, clear WebGL 2 error message with a retry button |
| Proof | Live HUD: `WebGL 2 · <fps> fps · <draws> draws`; hover for the GPU/vendor string. Camera button exports a PNG of the current frame |

Surface textures are generated in the browser without a CDN. Grass, sand, stone, wood, bark, roofs and foliage use small shared tiled maps; browser GLB exports embed these maps. AI planning checks connectivity with Wikipedia and can search it for the current prompt. The running phone server also sends fixed Wikipedia searches periodically for the vocabulary learner.

---

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `G` / `R` / `S` | Move / Rotate / Scale gizmo |
| `X` / `Y` / `Z` | Toggle the X / Y / Z gizmo handles |
| `F` | Frame the selection (or the whole world) |
| `Ctrl/Cmd+S` | Save now |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`) | Undo / Redo |
| `Ctrl/Cmd+G` / `Ctrl/Cmd+Shift+G` | Group / Ungroup selection |
| `Ctrl/Cmd+D` | Duplicate selection |
| `Ctrl/Cmd+A` | Select everything |
| `Delete` / `Backspace` | Delete selection |
| `Esc` | Clear selection / close the open panel |
| `Enter` / `Space` / `F2` in the tree | Select / rename a focused node |

On touch devices the same operations are available from the bottom dock, the
scene tree's per-row buttons and the inspector.

---

## Try the acceptance scenario

### Farm pipeline (Phase 3)

![Generated farm, rendered from the real scene graph](docs/farm-preview.png)

*The farm brief above, generated deterministically (seed 20261020) and rendered
straight from the scene graph that the viewport builds. Reproduce it with
`npm run render:preview`.*

1. Open **AI** and use the first example: *“Create a large cartoon low-poly farm
   with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and
   connected dirt paths.”* Press **Generate world**.
2. Inspect the result in **Scene**: Farmstead (Barn, Farmhouse, Chicken coop),
   Wheat fields, Paths, Fences and Landscape groups.
3. Select the farmhouse and change position/rotation in **Inspect**; open
   **Generated** and press **Regenerate** on the barn, or **Region** to re-roll
   every field.
4. Press **Save now**, reopen the project from the library, and confirm the farm
   and your edits are intact.

### Editor baseline (Phase 2)

1. Open **Assets** and add **Ground plane**, **Cube**, **Pine tree** and **House**.
2. Select each one in the **Scene** tree (or tap it in the viewport) and use the
   gizmo — or type exact values in the **Inspect** panel: position, rotation
   (XYZ degrees) and scale.
3. Shift-click the tree and house, press **Group** (`Ctrl/Cmd+G`), then move and
   rotate the group.
4. Press **Save now** and reload the page: the world is restored from IndexedDB
   with every transform and hierarchy entry intact.
5. Repeat the transform steps on Android Chrome to confirm touch orbit,
   tap selection and the inspector sheet.

---

## Project website

`website/` is a static site that ships with the repository:

- a landing page explaining the pipeline with renders taken from the real scene
  graph and real WebGL 2 screenshots of the editor;
- a **playground** that runs the actual prompt interpreter and farm generator in
  the browser (`website/src/demo.ts` → `website/public/demo.js` by esbuild) and
  draws the resulting WorldPlan as a top-down map — no server, no API key;
- the compiled editor served under `/app/`.

```bash
npm run site:build   # playground bundle + editor build
npm run site         # http://localhost:4173/  (site)  ·  /app/ (editor)
```

The zero-dependency server (`website/server.mjs`) binds `0.0.0.0`, so the same
command works behind a preview proxy and from a phone on the local network.

---

## Tech stack

React 19 · TypeScript 5.9 · Vite 7 · Three.js r186 · Zod 4 · IndexedDB · Vitest ·
Testing Library · happy-dom · fake-indexeddb. AI planning uses local rules, a statistical shape model and optional Wikipedia search.

---

## Verification (Phase 3)

- `npm run typecheck` — clean (strict, `noUncheckedIndexedAccess`).
- `npm test` — **113 tests / 13 files passing**, including a real binary GLB
  parse, IndexedDB CRUD, deterministic generation, farm planning, semantic
  validation/repair, regeneration, hierarchy/transform math, the gizmo's API
  contract, and DOM runtime flows on desktop and mobile widths.
- **Farm acceptance (UI)**: prompt → plan → generated hierarchy → edit the
  farmhouse (position/rotation) and the chicken coop (position/scale) →
  regenerate the barn → save → reopen → all edits and farm content verified.
- **Editor acceptance**: ground plane + cube + tree + house → move/resize/rotate
  → group → save → reload → every transform and hierarchy entry verified in the
  document **and** the rendered scene graph.
- `npm run build` — success. Initial gzip payload ≈ 309 kB; exporter deferred.
- Dev and preview servers return HTTP 200 for all assets through a proxied host.
- Real WebGL/GPU and physical-device testing remains outstanding (see risks).

---

## Roadmap

Phases 1–3 are complete pending real-device acceptance on desktop and Android.
Next: click-to-place and terrain snapping → terrain sculpting/flattened building
pads → performance profiling at 500+ objects → improved local language understanding →
richer asset pipeline → native engine exports → PWA/offline install. Details and
acceptance criteria are tracked in the architecture report.
