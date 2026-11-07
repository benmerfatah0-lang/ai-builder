import { useState } from 'react';
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

export function AiPanel({ notify, mapTrainer }: {
  mapTrainer: MapTrainer;
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}) {
  const { state, dispatch } = useEditor();
  const [shapeModel, setShapeModel] = useState(() => {
    try { return readShapeModel(window.localStorage); } catch { return initialShapeModel(); }
  });
  const [searchWikipedia, setSearchWikipedia] = useState(false);
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
    setGenerationError('');
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
      }, searchWikipedia);
      interpretation.intent = applyMapTraining(interpretation.intent, mapTrainer.model);
      interpretation.intent.shapeModel = interpretation.houseLearning ? applyHouseKnowledge(shapeModel, interpretation.houseLearning, text) : shapeModel;
      const report = generateWorldPlanWithReport(interpretation.intent);
      if (!report.validation.valid) {
        const first = report.validation.errors[0]?.message ?? 'Unknown validation error.';
        throw new Error(`The generated plan is invalid: ${first}`);
      }
      dispatch({ type: 'replacePlan', plan: report.plan });
      setResult(interpretation);
      const learnedCount = report.plan.objects.filter((object) => object.meta.learnedShape).length;
      const hasMine = report.plan.objects.some((object) => object.kind === 'primitive' && object.primitive === 'mine-entrance');
      setNotes([...(interpretation.notes ?? []),
        ...(hasMine ? ['المنجم مدخل زخرفي يوحي بالعمق فقط؛ لا توجد أنفاق محفورة أو قابلة للدخول، والأدوات والحفارات ثابتة.'] : []),
        learnedCount ? `تم توليد ${learnedCount} من أشكال البيت أو الشجرة عريضة الأوراق أو الصخرة من النموذج الصغير.` :
          'لم يُستخدم تدريب الأشكال لهذا الوصف؛ جرّب وصفاً مثل: بيت وشجرة وصخرة. المزارع تحتفظ بقالبها الخاص.',
        ...report.warnings].slice(0, 12));
      setStats({ objects: report.plan.objects.length, groups: report.plan.groups.length });
      notify(
        report.warnings.length > 0
          ? `World generated with ${report.warnings.length} warning(s). Undo restores the previous world.`
          : 'New world generated. Undo restores the previous world.',
        'success',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'تعذّر إنشاء العالم. حاول مجدداً.';
      setGenerationError(message);
      notify(message, 'danger');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="panel-scroll">
      <div className="create-intro" dir="rtl">
        <div className="create-eyebrow"><span>✦</span> استوديو العوالم</div>
        <h2>خيالك، أصبح عالماً.</h2>
        <p>صف المكان الذي تتخيله، وشاهده يتحول إلى عالم ثلاثي الأبعاد.</p>
      </div>

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
          maxLength={400}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void generate();
            }
          }}
        />
      </label>

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

      <div className="online-settings" dir="rtl">
        <div className="online-heading"><span className="online-dot" /> المساعد الخفيف + ويكيبيديا</div>
        <p>يفهم كلمات محدودة ويصنع أشكالاً إجرائية للبيوت والأشجار عريضة الأوراق والصخور المستديرة. ليس نموذج لغة أو مولّد نماذج عام. يحتاج اتصالاً بالإنترنت قبل كل إنشاء.</p>
        <label><input type="checkbox" checked={searchWikipedia} onChange={(event) => setSearchWikipedia(event.target.checked)} /> ابحث في ويكيبيديا عن هذا الوصف</label>
        <p>يمكنه البحث أيضاً عند ذكر «ابحث» أو «ويكيبيديا». يقرأ كلمات محدودة من النتائج لتقدير البيئة فقط؛ التعلّم التلقائي يقتصر على ويكيبيديا وليس كل الويب.</p>
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


      {result && (
        <div className="ai-result">
          <div className="ai-result-head">
            <span className="ai-result-icon">
              <Icon name="check" size={15} />
            </span>
            <strong>World generated</strong>
          </div>
          <p className="ai-summary">{result.intent.summary}{result.sources?.map((source, index) => (
            <a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer" aria-label={`المصدر ${index + 1}: ${source.title}`}> [{index + 1}]</a>
          ))}</p>
          <p className="hint-text" dir="rtl">{result.searched ? 'تم البحث في ويكيبيديا في هذا الطلب.' : 'لم يُجرَ بحث في ويكيبيديا في هذا الطلب.'}</p>
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

      <div className="callout callout-info" dir="rtl">
        <Icon name="info" size={16} />
        <span>الأشكال تُبنى محلياً بقواعد بسيطة وفق الأبعاد المتعلَّمة؛ لا تُستورد نماذج من المواقع، ولا تتعلم أوزان الأشكال من نص ويكيبيديا. قد لا تكون النتيجة نسخة دقيقة من مكان حقيقي.</span>
      </div>
    </div>
  );
}
