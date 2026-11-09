import { useEffect, useRef, useState } from 'react';
import type { MapTrainer } from '../useMapTrainer';
import { initialShapeModel, readShapeModel, saveShapeModel, resetShapeModel, trainShapeModel } from '../../ai/shapeLearner';
import { generateWorldPlanWithReport } from '../../../core/generation/generateWorld';
import type { PromptInterpretation } from '../../ai/types';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import { NumberField, SelectField } from '../../../ui/controls';
import { TextEditPanel } from './TextEditPanel';
import { type WorldPlan } from '../../../core/world-plan/schema';
import { correctBuildSpelling } from '../../ai/spelling';
import { unknownTopics } from '../../ai/unknownResearch';
import { LibraryWorldComposer } from './LibraryWorldComposer';
import { cloudWorldShell, MAX_CLOUD_OBJECTS, type CloudWorldItem } from '../../ai/cloudWorld';
import { textWorldItems, imageWorldParts, mergeWorldItems, terrainDescription } from '../../ai/unifiedWorld';
import { localSceneVision } from '../../ai/localVision';
import { loadVisionImage } from '../../ai/visionImage';
import { interpretPromptLocally } from '../../ai/promptInterpreter';
import { seedFromPrompt } from '../../../core/world-plan/factory';
import type { WorldDensity, WorldScale, WorldStyle } from '../../ai/types';

const EXAMPLES = [
  'مدينة صحراوية قديمة فيها منجم عميق للذهب بعربات ومعاول وحفارات وصناديق',
  'بيت على يمين شجرة و 3 صخور',
  'منزل بجانب برج و 2 نخلة',
  'جزيرة استوائية فيها نخيل وبحر عند الغروب',
  'قرية وسط غابة كثيفة مع نهر وجبال',
  'مزرعة صغيرة فيها حظيرة وحقول قمح وجسر',
  'صحراء واسعة فيها واحة ونخيل',
];

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

export function AiPanel({ notify, mapTrainer, variant = 'panel', onOpenStudio }: {
  mapTrainer: MapTrainer;
  variant?: 'panel' | 'forge';
  active?: boolean;
  onOpenStudio?: () => void;
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}) {
  const { state, dispatch } = useEditor();
  const currentPlan = useRef(state.plan); currentPlan.current = state.plan;
  const [shapeModel, setShapeModel] = useState(() => {
    try { return readShapeModel(window.localStorage); } catch { return initialShapeModel(); }
  });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [trainingMessage, setTrainingMessage] = useState('');
  const learnSelected = () => {
    try {
      const id = state.selection[state.selection.length - 1];
      const object = state.plan.objects.find((item) => item.id === id);
      if (!object) throw new Error('اختر بيتاً أو شجرة عريضة الأوراق أو صخرة مستديرة من المشهد أولاً.');
      const updated = trainShapeModel(shapeModel, object);
      saveShapeModel(window.localStorage, updated);
      setShapeModel(updated);
      setTrainingMessage('تم التدريب على أبعاد العنصر المحدد وحفظ النموذج محلياً. يُستخدم في بعض التعديلات، وليس في إنشاء الوصف فقط.');
    } catch (error) { setTrainingMessage(error instanceof Error ? error.message : 'تعذّر حفظ التدريب على الهاتف.'); }
  };
  const resetTraining = () => {
    try { setShapeModel(resetShapeModel(window.localStorage)); setTrainingMessage('تم حذف التدريب الشخصي واستعادة الأمثلة الأصلية.'); }
    catch { setTrainingMessage('تعذّر حذف التدريب من المتصفح.'); }
  };
  const [prompt, setPrompt] = useState('');
  const currentPrompt = useRef(prompt); currentPrompt.current = prompt;
  const [worldName, setWorldName] = useState('');
  const [imageFile,setImageFile]=useState<File|null>(null);
  const imageInput=useRef<HTMLInputElement|null>(null);
  const currentImage=useRef(imageFile);currentImage.current=imageFile;
  const [localOnly,setLocalOnly]=useState(false);
  const [seed, setSeed] = useState<number | null>(null);
  const [style, setStyle] = useState<WorldStyle | 'auto'>('auto');
  const [scale, setScale] = useState<WorldScale | 'auto'>('auto');
  const [density, setDensity] = useState<WorldDensity | 'auto'>('auto');
  const [generating, setGenerating] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [libraryDraft,setLibraryDraft]=useState<{items:CloudWorldItem[];prompt:string;plan:WorldPlan;shell:WorldPlan;file:File|null;id:number}|null>(null);
  const libraryDraftId=useRef(0);
  const cloudController = useRef<AbortController | null>(null);
  useEffect(() => () => cloudController.current?.abort(), []);
  const [result, setResult] = useState<PromptInterpretation | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [stats, setStats] = useState<{ objects: number; groups: number } | null>(null);
  const [generationError, setGenerationError] = useState('');
  const generateUnified = async () => {
    const text=prompt.trim(), file=imageFile;
    if ((!text && !file) || generating || batchBusy) return;
    if(localOnly && !file){void generate();return;}
    if(text.length>400){setGenerationError('الحد الأقصى للوصف في هذا المسار 400 حرف.');return;}
    const original=state.plan,controller=new AbortController();cloudController.current=controller;
    setGenerationError('');setResult(null);setNotes([]);setStats(null);setLibraryDraft(null);setGenerating(true);
    let release:(()=>void)|undefined;
    try {
      let imageItems:CloudWorldItem[]=[], hints:string[]=[], imageNotice='';
      if(file){
        const loaded=await loadVisionImage(file,controller.signal);release=loaded.release;
        const labels=await localSceneVision(loaded.image,controller.signal);
        const detected=imageWorldParts(labels);
        if(detected.truncated)throw new Error('الصورة تحتوي مناطق أكثر من الحد المسموح. اختر صورة أبسط؛ لم يُنشأ العالم.');
        imageItems=detected.items;hints=detected.terrainHints;
        if(!imageItems.length && !hints.length && !text)throw new Error('لم أجد عناصر أو تضاريس واضحة في الصورة.');
        imageNotice=`تحليل الصورة تقريبي وقد يدمج العناصر؛ ${detected.ignored.length?'عوملت بعض المناطق كخلفية.':''}`;
      }
      if(controller.signal.aborted || !alive.current || currentPlan.current!==original || currentPrompt.current.trim()!==text || currentImage.current!==file)throw new Error('تغيّر العالم أو الوصف أو الصورة؛ لم يُنشأ شيء.');
      const items=mergeWorldItems(textWorldItems(text),imageItems);
      if(items.length>MAX_CLOUD_OBJECTS)throw new Error(`الطلب يتجاوز الحد ${MAX_CLOUD_OBJECTS} عنصراً في العالم الواحد. قلّل العدد وأعد المحاولة.`);
      const terrainText=terrainDescription(text,hints);
      const shell=cloudWorldShell(original,terrainText?'text':'image',terrainText,{
        seed:seed ?? seedFromPrompt(text || 'image'),
        ...(style!=='auto'?{style}:{}),...(scale!=='auto'?{scale}:{}),...(density!=='auto'?{density}:{})
      });
      if(worldName.trim())shell.name=worldName.trim().slice(0,80);
      setNotes(imageNotice?[imageNotice]:[]);
      setLibraryDraft({items,prompt:text,plan:original,shell,file,id:++libraryDraftId.current});
    } catch(error){
      if(alive.current){const message=controller.signal.aborted?'أُلغي التحليل؛ لم يتغير العالم.':error instanceof Error?error.message:'تعذّر تجهيز العالم.';setGenerationError(message);notify(message,'danger');}
    } finally {release?.();if(cloudController.current===controller)cloudController.current=null;if(alive.current)setGenerating(false);}
  };
  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating || batchBusy) return;
    setLibraryDraft(null);
    const originalPlan = state.plan;
    setGenerationError('');setResult(null);setNotes([]);setStats(null);setGenerating(true);
    try {
      // Give the phone a frame to display progress before procedural generation.
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      if (!alive.current) return;
      if (currentPlan.current !== originalPlan || currentPrompt.current.trim() !== text) throw new Error('تغيّر العالم أو الوصف؛ لم يُنشأ شيء. أعد المحاولة.');
      const interpretation = interpretPromptLocally(text, {
        ...(seed !== null ? { seed } : {}),
        ...(style !== 'auto' ? { style } : {}),
        ...(scale !== 'auto' ? { scale } : {}),
        ...(density !== 'auto' ? { density } : {}),
      });
      const report = generateWorldPlanWithReport(interpretation.intent);
      if (!report.validation.valid) throw new Error(`تعذّر بناء العالم: ${report.validation.errors[0]?.message ?? 'خطة غير صالحة'}`);
      if (!alive.current || currentPlan.current !== originalPlan || currentPrompt.current.trim() !== text) throw new Error('تغيّر العالم أو الوصف؛ لم يُنشأ شيء. أعد المحاولة.');
      const plan = variant === 'forge' && worldName.trim() ? { ...report.plan, name: worldName.trim() } : report.plan;
      const unknown = unknownTopics(correctBuildSpelling(text).text).terms;
      const hasMine = plan.objects.some((object) => object.kind === 'primitive' && object.primitive === 'mine-entrance');
      dispatch({ type:'replacePlan', plan });
      setResult(interpretation);
      setNotes([
        ...report.warnings,
        ...(interpretation.notes ?? []),
        ...(unknown.length ? [`قد لا يفهم البناء النصي هذه الكلمات أو الأسماء: ${unknown.slice(0,10).map(term=>`«${term}»`).join('، ')}${unknown.length>10?' وغيرها':''}. لم تُستخدم صور لتخمينها.`] : []),
        ...(/بكسل|فوكسل|ناعم|pixel|voxel|smooth/i.test(text) ? ['لا يغيّر منشئ الوصف حالياً سطح كل الأصول إلى بكسلي أو ناعم؛ راجع النتيجة وعدّلها في المحرر.'] : []),
        ...(hasMine ? ['المنجم مدخل زخرفي؛ لا توجد أنفاق محفورة أو قابلة للدخول.'] : []),
      ]);
      setStats({objects:plan.objects.length,groups:plan.groups.length});
      notify('أُنشئ العالم محلياً من الوصف؛ يمكن التراجع عنه.', 'success');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذّر إنشاء العالم. حاول مجدداً.';
      setGenerationError(message);notify(message,'danger');
    } finally {if(alive.current)setGenerating(false);}
  };

  return (
    <div className={`panel-scroll ${variant === 'forge' ? 'forge-ai' : ''}`}>
      {variant === 'panel' && <TextEditPanel shapeModel={shapeModel} onOpenStudio={onOpenStudio} />}
      {variant !== 'forge' && <div className="create-intro" dir="rtl">
        <div className="create-eyebrow"><span>✦</span> استوديو العوالم</div>
        <h2>خيالك، أصبح عالماً.</h2>
        <p>صف المكان الذي تتخيله، وشاهده يتحول إلى عالم ثلاثي الأبعاد.</p>
      </div>}

      <label className="field">
        <span className="field-label prompt-label">وصف العالم <span>01</span></span>
        <textarea
          className="prompt-input"
          aria-label="وصف العالم"
          dir="auto"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="مثلاً: جزيرة استوائية فيها نخيل وبحر عند الغروب..."
          rows={4}
          maxLength={4000}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void generateUnified();
            }
          }}
        />
      </label>

      {generationError && <p className="online-error" role="alert" dir="rtl">{generationError}</p>}
      <label className="field" dir="rtl"><span className="field-label">صورة اختيارية للعالم</span><input aria-label="صورة العالم الاختيارية" ref={imageInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={generating||batchBusy} onChange={event=>{setImageFile(event.target.files?.[0]??null);setGenerationError('');}}/></label>
      {imageFile && <p dir="rtl">الصورة: {imageFile.name} · ستُحلّل محلياً، مع الوصف إن كتبته. <button type="button" className="btn btn-small" disabled={generating||batchBusy} onClick={()=>{setImageFile(null);if(imageInput.current)imageInput.current.value='';}}>إزالة الصورة</button></p>}
      <div className="create-actions" dir="rtl">
        <button type="button" className="btn btn-primary generate-btn" onClick={() => void generateUnified()} disabled={(!prompt.trim()&&!imageFile)||generating||batchBusy} aria-label="إنشاء العالم">
          <Icon name="sparkles" size={17}/>{generating||batchBusy?'جاري إنشاء العالم…':'إنشاء العالم'}
        </button>
        {generating && <button type="button" className="btn" onClick={()=>cloudController.current?.abort()}>إلغاء تحليل الصورة</button>}
      </div>
      <p className="create-actions-hint" dir="rtl">الأرض والماء من التطبيق؛ يبحث خادم الهاتف تلقائياً عن المجسمات المجانية. أضف صورة اختيارية مع الوصف أو بدونه. أسماء العناصر تُرسل للمصادر، لا الصورة. لا تكتب بيانات خاصة.</p>
      {!result && notes.map(note=><p key={note} dir="rtl">{note}</p>)}
      {libraryDraft && <LibraryWorldComposer key={libraryDraft.id} initialItems={libraryDraft.items} initialPlan={libraryDraft.plan} shell={libraryDraft.shell} description={libraryDraft.prompt} mode="text" canApply={()=>currentPrompt.current.trim()===libraryDraft.prompt && currentImage.current===libraryDraft.file} onBusyChange={setBatchBusy} onClose={()=>setLibraryDraft(null)} onOpenStudio={onOpenStudio}/>}
      {result && (
        <div className="ai-result">
          <div className="ai-result-head">
            <span className="ai-result-icon">
              <Icon name="check" size={15} />
            </span>
            <strong>World generated</strong>
          </div>
          {onOpenStudio && <button type="button" className="btn btn-primary open-studio-btn" onClick={onOpenStudio} >فتح العالم في المحرر ←</button>}
          <p className="ai-summary">{result.intent.summary}{result.sources?.map((source, index) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`المصدر ${index + 1}: ${source.title}`}> [{index + 1}]</a>
          ))}</p>
          {result.searched && <p className="hint-text" dir="rtl">تم البحث في ويكيبيديا في هذا الطلب.</p>}
          {result.searched && !result.sources?.length && <p className="hint-text" dir="rtl">لم يُعثر على روابط مصادر من ويكيبيديا لهذا الطلب.</p>}
          {result.sources && result.sources.length > 0 && (
            <div className="online-sources" dir="rtl">
              <strong>مصادر ويكيبيديا</strong>
              {result.sources.map((source) => <a href={source.url} key={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}
            </div>
          )}
          {stats && (
            <p className="hint-text">
              {stats.objects} objects · {stats.groups} groups · plan v3
            </p>
          )}
          <div className="cue-list">
            {result.intent.cues.map((cue) => (
              <span className="cue" key={cue}>
                {cue}
              </span>
            ))}
          </div>
          {notes.length > 0 && (
            <div className="ai-warnings">
              <span className="field-label">Warnings</span>
              <ul>
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="hint-text">
            Seed {result.intent.seed} · {result.providerLabel} · {result.offline ? 'offline' : 'internet'}
          </p>
        </div>
      )}

      <details className="forge-disclosure extra-tools" dir="rtl">
        <summary>إعدادات وأدوات إضافية</summary>
      {variant === 'forge' && <label className="field forge-name"><span>اسم العالم (اختياري)</span><input className="input" aria-label="اسم العالم (اختياري)" value={worldName} onChange={(event) => setWorldName(event.target.value)} maxLength={80} placeholder="مثلاً: أرض الأحلام" /></label>}
      <details className="forge-disclosure" dir="rtl">
        <summary>أمثلة جاهزة للإلهام</summary>
      <div className="example-list">
        <span className="field-label examples-label">تحتاج بعض الإلهام؟ <span>جرّب مثالاً</span></span>
        {EXAMPLES.map((example) => (
          <button
            type="button"
            className="prompt-example"
            key={example}
            onClick={() => setPrompt(example)}
          >
            {example}
          </button>
        ))}
      </div>

      </details>
      <details className="forge-disclosure" dir="rtl">
        <summary>إعدادات العالم المتقدمة</summary>
      <label className="field" dir="rtl"><span><input type="checkbox" aria-label="استخدام البناء المحلي فقط" checked={localOnly} onChange={event=>setLocalOnly(event.target.checked)}/> استخدام البناء المحلي فقط دون البحث عن مجسمات (عند عدم إضافة صورة)</span></label>
      <div className="settings-heading" dir="rtl"><span>إعدادات متقدمة</span><span>02</span></div>
      <div className="seed-row">
        <NumberField
          label="Seed"
          value={seed ?? seedFromPrompt(prompt)}
          min={0}
          max={4294967295}
          step={1}
          onCommit={(value) => setSeed(Math.round(value))}
        />
        <button type="button" className="btn btn-small" onClick={() => setSeed(randomSeed())}>
          Reroll
        </button>
      </div>
      <div className="ai-controls">
        <SelectField
          label="Style"
          value={style}
          options={[
            { value: 'auto', label: 'Auto (from prompt)' },
            { value: 'cartoon', label: 'Cartoon low-poly' },
            { value: 'stylized', label: 'Stylized' },
            { value: 'natural', label: 'Natural' },
          ]}
          onChange={(value) => setStyle(value as WorldStyle | 'auto')}
        />
        <SelectField
          label="World size"
          value={scale}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
          onChange={(value) => setScale(value as WorldScale | 'auto')}
        />
        <SelectField
          label="Density"
          value={density}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'sparse', label: 'Sparse' },
            { value: 'normal', label: 'Normal' },
            { value: 'dense', label: 'Dense' },
          ]}
          onChange={(value) => setDensity(value as WorldDensity | 'auto')}
        />
      </div>
      <p className="hint-text">
        نفس الوصف والإعدادات والبذرة تعيد شكل العالم وتوزيعه؛ البذرة الافتراضية مشتقة من الوصف.
      </p>


      </details>
      <details className="forge-disclosure" dir="rtl">
        <summary>التعلّم والتدريب وحالة المصادر</summary>
      <div className="online-settings" dir="rtl">
        <div className="online-heading"><span className="online-dot" /> المساعد الخفيف + ويكيبيديا</div>
        <p>يفهم البناء النصي مفردات محدودة ويستخدم أشكالاً إجرائية محلياً دون بحث أو صور. ليس نموذج لغة أو مولّداً عاماً.</p>
        <p>إنشاء العالم يبحث عن المجسمات افتراضياً؛ خيار البناء المحلي يتجاوز البحث عند عدم إضافة صورة.</p>
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">التعلّم التلقائي من ويكيبيديا</div>
        <p>يفحص خادم Termux موضوعات محددة عن التضاريس كل خمس دقائق تقريباً ويحفظ ارتباطات كلمات محدودة محلياً، حتى بعد إغلاق الصفحة ما دام الخادم يعمل. يستخدم الإنترنت والبطارية؛ قد يوقف Android الخادم في الخلفية. لا يتعلم تحويل الصور إلى 3D من نصوص ويكيبيديا.</p>
        {result?.wikiLearning ? <>
          <p>المقالات المستخدمة: {result.wikiLearning.documents} · الحالة: {result.wikiLearning.status === 'unavailable' ? 'تعذّر آخر تحديث (الإنترنت أو التخزين)' : result.wikiLearning.status === 'capacity' ? 'بلغ حد التخزين' : result.wikiLearning.status === 'no_new_articles' ? 'لا توجد مقالات جديدة في آخر بحث' : result.wikiLearning.status === 'starting' ? 'يبدأ' : 'يعمل'}.</p>
          {result.wikiLearning.sources.length > 0 && <div className="online-sources"><strong>أحدث مصادر التعلّم</strong>{result.wikiLearning.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}</div>}
        </> : <p>لا يستخدم زر الوصف نتائج هذا التعلّم.</p>}
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">تجربة تعلّم البيوت من الصور</div>
        <p>خادم Termux يبحث كل نحو 10 دقائق عن صور بيوت مرخّصة في Wikimedia Commons. يقارن رندراً مبسطاً من زاوية واحدة بالصورة، ويعدّل أبعاد البيت وتفاصيله فقط، ويستفيد من كلمات قليلة في وصف المصدر مثل صغير أو طويل. ليست شبكة عصبية ولا تحويلاً عاماً للصور إلى 3D؛ الخلفية والزاوية قد تضللان المقارنة.</p>
        <p>التدريب يحتاج python-pillow وإنترنت، وقد يستهلك بيانات وبطارية. يستمر بعد إغلاق الصفحة فقط ما دام Termux يعمل؛ يمكن أن يوقفه Android. لا تُحفظ الصور، وتُحفظ الإحصاءات وروابط الترخيص محلياً.</p>
        {result?.houseLearning ? <>
          <p>الصور المقبولة: {result.houseLearning.samples} · الحالة: {result.houseLearning.status === 'missing_pillow' ? 'ثبّت python-pillow' : result.houseLearning.status === 'unavailable' ? 'تعذّر الاتصال أو قراءة الصورة أو الحفظ' : result.houseLearning.status === 'no_new_images' ? 'لم توجد صور مناسبة جديدة' : result.houseLearning.status === 'no_improvement' ? 'لم تتحسن التجربة الأخيرة' : result.houseLearning.status === 'starting' ? 'يبدأ' : 'يتعلّم'}.</p>
          {result.houseLearning.sources.length > 0 && <details><summary>مصادر الصور والتراخيص</summary><div className="online-sources">{result.houseLearning.sources.slice().reverse().map((source) => <span key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> · {source.author} · <a href={source.license_url} target="_blank" rel="noopener noreferrer">الترخيص</a></span>)}</div></details>}
        </> : <p>لا يستخدم زر الوصف نتائج تدريب الصور.</p>}
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">تعلّم تلقائي للخرائط</div>
        <p>يجرب التطبيق خرائط صغيرة ويقارن التوزيع وعدد الأنواع والتحذيرات، ثم يحتفظ أحياناً بإعداد أفضل وفق هذه المعايير البسيطة. التدريب يجري على الجهاز عندما تكون الصفحة ظاهرة، مرة تقريباً كل 45 ثانية؛ وهذا التدريب المحلي منفصل عن تعلّم كلمات ويكيبيديا ولا يختبر متعة اللعب.</p>
        <p>التجارب: {mapTrainer.model.attempts} · التغييرات المقبولة: {mapTrainer.model.accepted}. تجارب مستقلة؛ لا تغيّر نتيجة زر الوصف فقط.</p>
        <button type="button" className="btn btn-small" onClick={() => mapTrainer.setEnabled(!mapTrainer.model.enabled)}>
          {mapTrainer.model.enabled ? 'إيقاف التعلّم التلقائي' : 'تشغيل التعلّم التلقائي'}
        </button>{' '}
        <button type="button" className="btn btn-small" onClick={mapTrainer.reset}>حذف تعلّم الخرائط</button>
        {mapTrainer.error && <p role="alert">{mapTrainer.error}</p>}
        <p>التقييم آلي ومحدود، ولا يعني أن المساعد صار محترفاً أو يصمم خرائط ألعاب قابلة للعب وحده.</p>
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">تدريب الأشكال على الهاتف</div>
        <p>هذا نموذج إحصائي صغير يتعلّم متوسط الأبعاد والتفاصيل، وليس شبكة تولّد أي شكل. لتدريبه: اختر بيتاً أو شجرة عريضة الأوراق أو صخرة مستديرة من المشهد، وعدّل حجمها في لوحة Inspect، ثم اضغط الزر. تتعلم الفئة من المثال الذي اخترته فقط.</p>
        <p>الأمثلة الشخصية: {shapeModel.house.count + shapeModel.tree.count + shapeModel.rock.count - 9}. التدريب محفوظ في هذا المتصفح فقط.</p>
        <button type="button" className="btn btn-small" onClick={learnSelected}>تعلّم من العنصر المحدد</button>{' '}
        <button type="button" className="btn btn-small" onClick={resetTraining}>حذف التدريب الشخصي</button>
        {trainingMessage && <p role="status">{trainingMessage}</p>}
      </div>
      </details>
      <div className="callout callout-info" dir="rtl">
        <Icon name="info" size={16} />
        <span>الأشكال في مسار الوصف تُبنى محلياً بقواعد بسيطة دون الرجوع إلى الصور أو بيانات التدريب. قد لا تكون النتيجة نسخة دقيقة من مكان حقيقي.</span>
      </div>
      </details>
    </div>
  );
}
