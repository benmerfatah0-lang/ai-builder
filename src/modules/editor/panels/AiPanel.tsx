import { useState } from 'react';
import { interpretOnline } from '../../ai/onlineInterpreter';
import { generateWorldPlanWithReport } from '../../../core/generation/generateWorld';
import type { PromptInterpretation } from '../../ai/types';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import { NumberField, SelectField } from '../../../ui/controls';
import type { WorldDensity, WorldScale, WorldStyle } from '../../ai/types';

const EXAMPLES = [
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

export function AiPanel({ notify }: {
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}) {
  const { dispatch } = useEditor();
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
      });
      const report = generateWorldPlanWithReport(interpretation.intent);
      if (!report.validation.valid) {
        const first = report.validation.errors[0]?.message ?? 'Unknown validation error.';
        throw new Error(`The generated plan is invalid: ${first}`);
      }
      dispatch({ type: 'replacePlan', plan: report.plan });
      setResult(interpretation);
      setNotes([...(interpretation.notes ?? []), ...report.warnings].slice(0, 12));
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
        <div className="online-heading"><span className="online-dot" /> Qwen محلي + بحث ويكيبيديا</div>
        <p>يعمل النموذج على الهاتف دون حساب أو مفتاح. يحتاج التطبيق إلى الإنترنت للتحقق من الاتصال والبحث في ويكيبيديا عند الحاجة؛ لا يبحث في بقية الويب. قد يكون النموذج الصغير بطيئاً أو يخطئ.</p>
        <p>استخدم خادم الهاتف المرفق واترك Termux يعمل. عند البحث تُرسل عبارة البحث إلى ويكيبيديا.</p>
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
      <p className="generate-caption" dir="rtl">✦ يتطلب الإنترنت وتشغيل النموذج المحلي في Termux</p>
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
        نفس المخطط والبذرة يعيدان التوزيع، لكن نتائج الذكاء الاصطناعي والبحث قد تتغير بين الطلبات.
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
            Seed {result.intent.seed} · {result.providerLabel} · {result.offline ? 'offline' : 'remote'}
          </p>
        </div>
      )}

      <div className="callout callout-info" dir="rtl">
        <Icon name="info" size={16} />
        <span>البحث يساعد على فهم وصفك، لكن البناء يقتصر على عناصر المكتبة الحالية؛ لا تُستورد نماذج جديدة من المواقع. قد لا تكون النتيجة نسخة دقيقة من مكان حقيقي.</span>
      </div>
    </div>
  );
}
