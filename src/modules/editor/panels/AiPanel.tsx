import { useEffect, useRef, useState } from 'react';
import { correctBuildSpelling } from '../../ai/spelling';
import { applyHouseKnowledge } from '../../ai/houseKnowledge';
import { applyMapTraining } from '../../ai/mapTrainer';
import type { MapTrainer } from '../useMapTrainer';
import { interpretOnline } from '../../ai/onlineInterpreter';
import { initialShapeModel, readShapeModel, saveShapeModel, resetShapeModel, trainShapeModel } from '../../ai/shapeLearner';
import { generateWorldPlanWithReport } from '../../../core/generation/generateWorld';
import type { PromptInterpretation } from '../../ai/types';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import { NumberField, SelectField } from '../../../ui/controls';
import { TextEditPanel } from './TextEditPanel';
import { ResearchResults } from './ResearchResults';
import { PhotoStudio } from './PhotoStudio';
import { ReferenceSceneWorkflow } from './ReferenceSceneWorkflow';
import { addPhotoModels } from '../../ai/photoModel';
import { planPhotoRequests, type PhotoRequest } from '../../ai/photoRequests';
import { type WorldPlan } from '../../../core/world-plan/schema';
import { normalizeAssetText, parseAssetRequests } from '../../ai/assetRequests';
import { classifyTopic, isLandscapeKind } from '../../ai/topicClassification';
import { analyzeApproximation, hasExplicitColor, matchReferenceApproximation, containsApproximation, type Approximation } from '../../ai/referenceUnderstanding';
import { applyWikiArticleHint } from '../../ai/wikiReference';
import { researchUnknown, unknownTopics, type ResearchReport } from '../../ai/unknownResearch';
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

export function AiPanel({ notify, mapTrainer, variant = 'panel', onOpenStudio, active = true }: {
  mapTrainer: MapTrainer;
  variant?: 'panel' | 'forge';
  active?: boolean;
  onOpenStudio?: () => void;
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}) {
  const { state, dispatch, setConstructionPreview } = useEditor();
  const currentPlan = useRef(state.plan); currentPlan.current = state.plan;
  const [shapeModel, setShapeModel] = useState(() => {
    try { return readShapeModel(window.localStorage); } catch { return initialShapeModel(); }
  });
  const [studioPending, setStudioPending] = useState(false);
  const [studio, setStudio] = useState<{ requests: PhotoRequest[]; index: number; plan: WorldPlan; text: string } | null>(null);
  const [research, setResearch] = useState<ResearchReport | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const researchSequence = useRef(0);
  const researchAbort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; researchSequence.current++; researchAbort.current?.abort(); }; }, []);
  const researchFor = async (text: string) => {
    researchAbort.current?.abort();
    const controller = new AbortController(); researchAbort.current = controller;
    const id = ++researchSequence.current;
    setResearch(null); setProgress(null);
    if (!unknownTopics(text).terms.length) { setResearchBusy(false); return { topics: [], truncated: false }; }
    setResearchBusy(true);
    const report = await researchUnknown(text, { signal: controller.signal, onProgress: (partial, done, total) => {
      if (id === researchSequence.current) { setResearch(partial); setProgress({ done, total }); }
    } });
    if (id === researchSequence.current) { setResearch(report); setResearchBusy(false); }
    return report;
  };
  const [trainingMessage, setTrainingMessage] = useState('');
  const learnSelected = () => {
    try {
      const id = state.selection[state.selection.length - 1];
      const object = state.plan.objects.find((item) => item.id === id);
      if (!object) throw new Error('اختر بيتاً أو شجرة عريضة الأوراق أو صخرة مستديرة من المشهد أولاً.');
      const updated = trainShapeModel(shapeModel, object);
      saveShapeModel(window.localStorage, updated);
      setShapeModel(updated);
      setTrainingMessage('تم التدريب على أبعاد العنصر المحدد وحفظ النموذج على هذا المتصفح. أنشئ مشهداً جديداً لرؤية تأثيره.');
    } catch (error) { setTrainingMessage(error instanceof Error ? error.message : 'تعذّر حفظ التدريب على الهاتف.'); }
  };
  const resetTraining = () => {
    try { setShapeModel(resetShapeModel(window.localStorage)); setTrainingMessage('تم حذف التدريب الشخصي واستعادة الأمثلة الأصلية.'); }
    catch { setTrainingMessage('تعذّر حذف التدريب من المتصفح.'); }
  };
  const [prompt, setPrompt] = useState('');
  const currentPrompt = useRef(prompt); currentPrompt.current = prompt;
  const [worldName, setWorldName] = useState('');
  const [useReference,setUseReference]=useState(false);
  const [referenceFlow,setReferenceFlow]=useState<{prompt:string;plan:WorldPlan;id:number}|null>(null);
  const referenceSequence=useRef(0);
  const [seed, setSeed] = useState<number>(() => randomSeed());
  const [style, setStyle] = useState<WorldStyle | 'auto'>('auto');
  const [scale, setScale] = useState<WorldScale | 'auto'>('auto');
  const [density, setDensity] = useState<WorldDensity | 'auto'>('auto');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PromptInterpretation | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [stats, setStats] = useState<{ objects: number; groups: number } | null>(null);
  const [generationError, setGenerationError] = useState('');
  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    if(useReference) { researchSequence.current++;researchAbort.current?.abort();setResearch(null);setStudio(null);setStudioPending(false);setResearchBusy(false);setResult(null);setNotes([]);setStats(null);setReferenceFlow({prompt:text,plan:state.plan,id:++referenceSequence.current});setGenerationError('');return; }
    const originalPlan = state.plan;
    const correctedText = correctBuildSpelling(text).text;
    setGenerationError('');
    researchSequence.current++;
    setResearch(null); setStudio(null); setStudioPending(false); setResearchBusy(false);
    setResult(null);
    setNotes([]);
    setStats(null);
    setGenerating(true);
    try {
      // Yield one frame so the button's busy state paints on slower phones.
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      const interpretation = await interpretOnline(text, {
        seed,
        ...(style !== 'auto' ? { style } : {}),
        ...(scale !== 'auto' ? { scale } : {}),
        ...(density !== 'auto' ? { density } : {}),
      }, false, unknownTopics(correctedText).terms.length > 0);
      if (!alive.current) return;
      const discovered = await researchFor(correctedText);
      const singleTopic = discovered.topics.length === 1 && !discovered.truncated ? discovered.topics[0] : undefined;
      const ambiguousPhoto = singleTopic && (singleTopic.images.length > 1 || (singleTopic.images.length > 0 && singleTopic.imageNext != null)) && planPhotoRequests(correctedText, [singleTopic]).requests.length > 0;
      const match = !interpretation.intent.features?.farm && !ambiguousPhoto && !(singleTopic && isLandscapeKind(classifyTopic(singleTopic).kind)) ? matchReferenceApproximation(correctedText, discovered) : null;
      let approximate: Approximation | null = match;
      if (match) {
        setResearchBusy(true);
        approximate = await analyzeApproximation(match);
        setResearchBusy(false);
        setResearch({ ...discovered, approximation: approximate });
        const assets = parseAssetRequests(approximate.rewritten, true)!;
        interpretation.intent.assets = assets.map((item) => item.assetId === 'house' && approximate?.color && !hasExplicitColor(text) ? { ...item, referenceColor: approximate.color } : item);
        interpretation.intent.cues = [...interpretation.intent.cues.filter((cue) => !cue.startsWith('default counts')), `${match.sourceKind === 'dictionary' ? 'Wiktionary' : 'Wikipedia'} approximate ${match.assetLabel ?? 'house'}: ${match.term}`];
        interpretation.intent.summary += ` · ${match.term}: approximate ${match.assetLabel ?? 'house'}`;
        interpretation.notes = [`«${match.term}» ممثل ب${match.assetLabel ?? 'بيت'} تقريبي وفق ${match.sourceKind === 'dictionary' ? 'تعريف معجمي محدود' : 'مقتطف ويكيبيديا'}؛ لا يتم استنتاج شكل 3D من الصورة.${approximate.color && !hasExplicitColor(text) ? ' لُوّن البيت بمتوسط مركز الصورة، وقد يكون لون الخلفية.' : hasExplicitColor(text) ? ' لم يُستخدم لون الصورة؛ لون الوصف لا يُطبّق تلقائياً هنا ويمكن تغييره في Inspect.' : ' لم يُستخدم لون الصورة.'}`, ...(interpretation.notes ?? [])];
      }
      if (discovered.topics.length) {
        const names = discovered.topics.map((topic) => `«${topic.term}»`).join('، ');
        interpretation.notes = [`بحثت عن ${names}؛ ${match ? 'استُخدم تقريب من أصل موجود، وليس بناءً مطابقاً.' : 'سنحاول بناء العناصر المجهولة من الصور عندما يكون الطلب مناسباً؛ راجع التنبيهات للعناصر التي لم تُبنَ.'}`, ...(interpretation.notes ?? [])];
        // Use only an exact article-title match, only for a single candidate, and only
        // the fixed terrain vocabulary. Search results are untrusted and not 3D data.
        const topic = discovered.topics.length === 1 && !discovered.truncated ? discovered.topics[0] : undefined;
        const clean = (value: string) => normalizeAssetText(value).trim().replace(/^ال/u, '').replace(/\s+/g, ' ');
        const article = topic?.articles.find((item) => clean(item.title) === clean(topic.term));
        if (article && topic && classifyTopic(topic).biome && ['terrain', 'biome'].includes(classifyTopic(topic).kind)) {
          const biome = classifyTopic(topic).biome;
          const applied = applyWikiArticleHint(interpretation.intent, article, biome === 'desert' || biome === 'forest' || biome === 'mountains' || biome === 'island' ? biome : undefined);
          interpretation.intent = applied.intent;
          interpretation.notes = [applied.hint, ...interpretation.notes];
        }
        const classification = topic ? classifyTopic(topic) : undefined;
        if (classification?.kind === 'water' && classification.water === 'standing' && !interpretation.intent.features?.farm && !/(?:بدون|دون|بلا|without|\bno\b)/iu.test(normalizeAssetText(text))) {
          interpretation.intent.water = true;
          interpretation.intent.cues.push('Wikipedia approximate standing water');
          interpretation.notes = ['أُضيف ماء عام تقريبي إلى العالم بناءً على تعريف المسطح المائي؛ ليس شكلاً مطابقاً أو خريطة للموقع.', ...interpretation.notes];
        }
      }
      interpretation.intent = applyMapTraining(interpretation.intent, mapTrainer.model);
      interpretation.intent.shapeModel = interpretation.houseLearning ? applyHouseKnowledge(shapeModel, interpretation.houseLearning, text) : shapeModel;
      const report = generateWorldPlanWithReport(interpretation.intent);
      if (!report.validation.valid) {
        const first = report.validation.errors[0]?.message ?? 'Unknown validation error.';
        throw new Error(`The generated plan is invalid: ${first}`);
      }
      if (!alive.current || researchAbort.current?.signal.aborted) throw new DOMException('أُوقف البحث؛ لم يُنشأ العالم.', 'AbortError');
      if (currentPlan.current !== originalPlan || currentPrompt.current.trim() !== text) throw new Error('تغيّر العالم أثناء البحث أو تغيّر الوصف؛ لم نستبدله. أعد الإنشاء إذا أردت.');
      const plan = variant === 'forge' && worldName.trim() ? { ...report.plan, name: worldName.trim() } : report.plan;
      if (approximate && !containsApproximation(plan, approximate)) {
        interpretation.notes = [
          `صُنّف «${approximate.term}» كتقريب لـ${approximate.assetLabel ?? 'بيت'}، لكن لم يوضع نموذج له في الماب. راجع تنبيهات الموضع والسعة.`,
          ...(interpretation.notes ?? []).filter((note) => !note.includes('ممثل ب') && !note.includes('استُخدم تقريب من أصل موجود')),
        ];
      }
      dispatch({ type: 'replacePlan', plan });
      const photos = match ? { requests: [], warnings: [] } : planPhotoRequests(correctedText, discovered.topics);
      if (photos.requests.length) {
        setStudio({ requests: photos.requests, index: 0, plan, text }); setStudioPending(true);
      }
      if (approximate) setResearch({ ...discovered, approximation: { ...approximate,
        applied: containsApproximation(plan, approximate),
        colorApplied: Boolean(approximate.color && !hasExplicitColor(text) && plan.objects.some((object) => object.kind === 'building' && object.variant === 'house')) } });
      setResult(interpretation);
      const learnedCount = report.plan.objects.filter((object) => object.meta.learnedShape).length;
      const hasMine = report.plan.objects.some((object) => object.kind === 'primitive' && object.primitive === 'mine-entrance');
      setNotes([...photos.warnings, ...report.warnings, ...(interpretation.notes ?? []),
        ...(hasMine ? ['المنجم مدخل زخرفي يوحي بالعمق فقط؛ لا توجد أنفاق محفورة أو قابلة للدخول، والأدوات والحفارات ثابتة.'] : []),
        learnedCount ? `تم توليد ${learnedCount} من أشكال البيت أو الشجرة عريضة الأوراق أو الصخرة من النموذج الصغير.` :
          'لم يُستخدم تدريب الأشكال لهذا الوصف؛ جرّب وصفاً مثل: بيت وشجرة وصخرة. المزارع تحتفظ بقالبها الخاص.',
        ]);
      setStats({ objects: report.plan.objects.length, groups: report.plan.groups.length });
      notify(
        report.warnings.length > 0
          ? `World generated with ${report.warnings.length} warning(s). Undo restores the previous world.`
          : 'New world generated. Undo restores the previous world.',
        'success',
      );
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? 'أُوقف البحث؛ لم يُنشأ العالم.' : error instanceof Error ? error.message : 'تعذّر إنشاء العالم. حاول مجدداً.';
      setGenerationError(message);
      notify(message, 'danger');
    } finally {
      setResearchBusy(false);
      setGenerating(false);
    }
  };

  return (
    <div className={`panel-scroll ${variant === 'forge' ? 'forge-ai' : ''}`}>
      {variant === 'panel' && <TextEditPanel shapeModel={shapeModel} />}
      {studio && <div dir="rtl">
        <p role="status">العنصر {studio.index + 1} من {studio.requests.length} · العدد المطلوب: {studio.requests[studio.index]!.count}</p>
        <PhotoStudio key={`${studio.index}:${studio.requests[studio.index]!.topic.term}`} topic={studio.requests[studio.index]!.topic} initialMeshStyle={studio.requests[studio.index]!.meshStyle}
          cancelLabel="تخطّي هذا العنصر" onCancel={() => {
            const item = studio.requests[studio.index]!;
            setNotes((old) => [`تم تخطي «${item.topic.term}» دون إضافته.`, ...old]);
            if (studio.index + 1 < studio.requests.length) setStudio({ ...studio, index: studio.index + 1 });
            else { setStudio(null); setStudioPending(false); }
          }} onPreview={setConstructionPreview} showMapPreview={variant === 'forge' && active}
          onPrepare={(model) => {
            if (currentPlan.current !== studio.plan || currentPrompt.current.trim() !== studio.text) throw new Error('تغيّر العالم أو الوصف؛ أوقف البناء وأعد المحاولة.');
            const item = studio.requests[studio.index]!;
            return { base: studio.plan, before: studio.plan, after: addPhotoModels(studio.plan, model, item.topic.term, item.count, item.relation) };
          }} onComplete={(model, prepared) => {
            const item = studio.requests[studio.index]!;
            if (!prepared || currentPlan.current !== studio.plan || currentPrompt.current.trim() !== studio.text) {
              setGenerationError('تغيّر العالم أو الوصف أثناء البناء؛ أُوقفت بقية الإضافات.'); setStudio(null); setStudioPending(false); return;
            }
            const next = prepared.after;
            dispatch({ type: 'replacePlan', plan: next });
            const added = next.objects.filter((object) => !prepared.base.objects.some((old) => old.id === object.id));
            if (added.length) dispatch({ type: 'select', ids: [added[added.length - 1]!.id], mode: 'replace' });
            setStats({ objects: next.objects.length, groups: next.groups.length });
            setNotes((old) => [model.mode === 'full-image-slab' ? `أُضيف ${item.count} من «${item.topic.term}»: لوح الصورة كاملة بما فيها الخلفية.` : item.count === 1 ? `أُضيف مجسم الصورة التقريبي؛ «${item.topic.term}»، الخلف والعمق افتراضيان.` : `أُضيف ${item.count} من «${item.topic.term}» من الصورة تقريبياً؛ الخلف والعمق افتراضيان.`, ...old]);
            if (studio.index + 1 < studio.requests.length) setStudio({ ...studio, index: studio.index + 1, plan: next });
            else { setStudio(null); setStudioPending(false); }
          }} />
        <button type="button" className="btn btn-small" onClick={() => { setNotes((old) => ['أُوقف بناء بقية العناصر؛ احتفظنا بما أُضيف سابقاً.', ...old]); setStudio(null); setStudioPending(false); }}>إيقاف بناء البقية</button>
      </div>}
      {researchBusy && <button type="button" className="btn btn-small" onClick={() => researchAbort.current?.abort()}>إيقاف البحث</button>}
      <ResearchResults report={research} busy={researchBusy} progress={progress} />
      {variant !== 'forge' && <div className="create-intro" dir="rtl">
        <div className="create-eyebrow"><span>✦</span> استوديو العوالم</div>
        <h2>خيالك، أصبح عالماً.</h2>
        <p>صف المكان الذي تتخيله، وشاهده يتحول إلى عالم ثلاثي الأبعاد.</p>
      </div>}

      <label className="field">
        <span className="field-label prompt-label">وصف العالم <span>01</span></span>
        <textarea
          className="prompt-input"
          aria-label="Description"
          dir="auto"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="مثلاً: جزيرة استوائية فيها نخيل وبحر عند الغروب..."
          rows={4}
          maxLength={4000}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void generate();
            }
          }}
        />
      </label>

      {variant === 'forge' && <label className="field forge-name" dir="rtl">
        <span className="field-label">اسم العالم (اختياري)</span>
        <input className="input" aria-label="اسم العالم (اختياري)" value={worldName} onChange={(event) => setWorldName(event.target.value)} maxLength={80} placeholder="مثلاً: أرض الأحلام" />
      </label>}

      <label dir="rtl"><input type="checkbox" checked={useReference} onChange={(event)=>{setUseReference(event.target.checked);setReferenceFlow(null);}} /> استخدم صورة مرجعية ووصف ويكيبيديا ضمن إنشاء العالم</label>
      <p className="generate-caption" dir="rtl">يبحث المساعد تلقائياً عن كلمات قد لا يعرفها في ويكيبيديا وWikimedia Commons؛ تُرسل هذه الكلمات إلى الموقعين. التعرّف تقريبي؛ قد نستخدم صوراً ذات خلفية بسيطة لبناء أحجام تقديرية متناظرة لعناصر متعددة.</p>
      {generationError && <p className="online-error" role="alert" dir="rtl">{generationError}</p>}

      <button
        type="button"
        className="btn btn-primary generate-btn"
        onClick={() => void generate()}
        disabled={!prompt.trim() || generating}
        aria-label="Generate world"
      >
        {generating ? <span className="spinner small" /> : <Icon name="sparkles" size={17} />}
        {generating ? 'جاري تحليل الوصف وبناء العالم…' : 'أنشئ العالم'} <span className="generate-arrow">←</span>
      </button>
      <p className="generate-caption" dir="rtl">✦ يتطلب الإنترنت وخادم الهاتف في Termux، دون تنزيل نموذج كبير</p>
      {referenceFlow && <ReferenceSceneWorkflow key={referenceFlow.id} prompt={referenceFlow.prompt} basePlan={referenceFlow.plan} mode="create" canApply={()=>currentPrompt.current.trim()===referenceFlow.prompt} onCancel={()=>setReferenceFlow(null)} onApplied={()=>{setReferenceFlow(null);notify('أُنشئ المشهد من العناصر المحددة؛ يمكن التراجع بـ Undo.','success');}} onOpenStudio={onOpenStudio}/>}
      {result && (
        <div className="ai-result">
          <div className="ai-result-head">
            <span className="ai-result-icon">
              <Icon name="check" size={15} />
            </span>
            <strong>World generated</strong>
          </div>
          {onOpenStudio && <button type="button" className="btn btn-primary open-studio-btn" onClick={onOpenStudio} disabled={studioPending} title={studioPending ? 'انتظر بناء المجسم أو أغلق الاستوديو' : undefined}>فتح العالم في المحرر ←</button>}
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
      <div className="settings-heading" dir="rtl"><span>إعدادات متقدمة</span><span>02</span></div>
      <div className="seed-row">
        <NumberField
          label="Seed"
          value={seed}
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
        نفس الوصف والبذرة وبيانات التدريب تعيد الشكل والتوزيع؛ التدريب التلقائي أو نتائج البحث قد تغيّر النتيجة لاحقاً.
      </p>


      </details>
      <details className="forge-disclosure" dir="rtl">
        <summary>التعلّم والتدريب وحالة المصادر</summary>
      <div className="online-settings" dir="rtl">
        <div className="online-heading"><span className="online-dot" /> المساعد الخفيف + ويكيبيديا</div>
        <p>يفهم كلمات محدودة ويصنع أشكالاً إجرائية للبيوت والأشجار عريضة الأوراق والصخور المستديرة. ليس نموذج لغة أو مولّد نماذج عام. يحتاج اتصالاً بالإنترنت قبل كل إنشاء.</p>
        <p>يمكنه البحث أيضاً عند ذكر «ابحث» أو «ويكيبيديا». يقرأ كلمات محدودة من النتائج لتقدير البيئة فقط؛ بحث المقالات يقتصر على ويكيبيديا؛ البحث التلقائي عن الصور وتدريب صور البيوت يستخدمان Wikimedia Commons.</p>
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">التعلّم التلقائي من ويكيبيديا</div>
        <p>يفحص خادم Termux موضوعات محددة عن التضاريس كل خمس دقائق تقريباً ويحفظ ارتباطات كلمات محدودة محلياً، حتى بعد إغلاق الصفحة ما دام الخادم يعمل. يستخدم الإنترنت والبطارية؛ قد يوقف Android الخادم في الخلفية. لا يتعلم تحويل الصور إلى 3D من نصوص ويكيبيديا.</p>
        {result?.wikiLearning ? <>
          <p>المقالات المستخدمة: {result.wikiLearning.documents} · الحالة: {result.wikiLearning.status === 'unavailable' ? 'تعذّر آخر تحديث (الإنترنت أو التخزين)' : result.wikiLearning.status === 'capacity' ? 'بلغ حد التخزين' : result.wikiLearning.status === 'no_new_articles' ? 'لا توجد مقالات جديدة في آخر بحث' : result.wikiLearning.status === 'starting' ? 'يبدأ' : 'يعمل'}.</p>
          {result.wikiLearning.sources.length > 0 && <div className="online-sources"><strong>أحدث مصادر التعلّم</strong>{result.wikiLearning.sources.map((source) => <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}</div>}
        </> : <p>تظهر حالة التعلّم ومصادره بعد إنشاء عالم.</p>}
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">تجربة تعلّم البيوت من الصور</div>
        <p>خادم Termux يبحث كل نحو 10 دقائق عن صور بيوت مرخّصة في Wikimedia Commons. يقارن رندراً مبسطاً من زاوية واحدة بالصورة، ويعدّل أبعاد البيت وتفاصيله فقط، ويستفيد من كلمات قليلة في وصف المصدر مثل صغير أو طويل. ليست شبكة عصبية ولا تحويلاً عاماً للصور إلى 3D؛ الخلفية والزاوية قد تضللان المقارنة.</p>
        <p>التدريب يحتاج python-pillow وإنترنت، وقد يستهلك بيانات وبطارية. يستمر بعد إغلاق الصفحة فقط ما دام Termux يعمل؛ يمكن أن يوقفه Android. لا تُحفظ الصور، وتُحفظ الإحصاءات وروابط الترخيص محلياً.</p>
        {result?.houseLearning ? <>
          <p>الصور المقبولة: {result.houseLearning.samples} · الحالة: {result.houseLearning.status === 'missing_pillow' ? 'ثبّت python-pillow' : result.houseLearning.status === 'unavailable' ? 'تعذّر الاتصال أو قراءة الصورة أو الحفظ' : result.houseLearning.status === 'no_new_images' ? 'لم توجد صور مناسبة جديدة' : result.houseLearning.status === 'no_improvement' ? 'لم تتحسن التجربة الأخيرة' : result.houseLearning.status === 'starting' ? 'يبدأ' : 'يتعلّم'}.</p>
          {result.houseLearning.sources.length > 0 && <details><summary>مصادر الصور والتراخيص</summary><div className="online-sources">{result.houseLearning.sources.slice().reverse().map((source) => <span key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> · {source.author} · <a href={source.license_url} target="_blank" rel="noopener noreferrer">الترخيص</a></span>)}</div></details>}
        </> : <p>تظهر الحالة بعد إنشاء عالم.</p>}
      </div>
      <div className="online-settings" dir="rtl">
        <div className="online-heading">تعلّم تلقائي للخرائط</div>
        <p>يجرب التطبيق خرائط صغيرة ويقارن التوزيع وعدد الأنواع والتحذيرات، ثم يحتفظ أحياناً بإعداد أفضل وفق هذه المعايير البسيطة. التدريب يجري على الجهاز عندما تكون الصفحة ظاهرة، مرة تقريباً كل 45 ثانية؛ وهذا التدريب المحلي منفصل عن تعلّم كلمات ويكيبيديا ولا يختبر متعة اللعب.</p>
        <p>التجارب: {mapTrainer.model.attempts} · التغييرات المقبولة: {mapTrainer.model.accepted}. تؤثر النتائج في كثافة العناصر للمناظر العامة فقط، ولا تغيّر الأعداد الصريحة أو المزرعة.</p>
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
        <span>الأشكال تُبنى محلياً بقواعد بسيطة وفق الأبعاد المتعلَّمة؛ لا تُستورد نماذج من المواقع، ولا تتعلم أوزان الأشكال من نص ويكيبيديا. قد لا تكون النتيجة نسخة دقيقة من مكان حقيقي.</span>
      </div>
    </div>
  );
}
