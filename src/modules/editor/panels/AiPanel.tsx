import { useState } from 'react';
import { interpretOnline } from '../../ai/onlineInterpreter';
import { deleteLocalKey, hasLocalKey, saveLocalKey, unlockLocalKey } from '../../ai/localKeyVault';
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

export function AiPanel({
  notify,
  apiKey,
  onApiKeyChange,
  searchKey, onSearchKeyChange,
}: {
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  searchKey: string;
  onSearchKeyChange: (value: string) => void;
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
  const [vaultState] = useState(() => {
    try { return { stored: hasLocalKey(), error: '' }; }
    catch { return { stored: false, error: 'تعذّر الوصول إلى تخزين المتصفح.' }; }
  });
  const [accountError, setAccountError] = useState(vaultState.error);
  const [accountBusy, setAccountBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [storedKey, setStoredKey] = useState(vaultState.stored);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerationError('');
    setResult(null);
    setNotes([]);
    setStats(null);
    if (!apiKey.trim() || !searchKey.trim()) {
      setGenerationError('أدخل مفتاحي Groq وTavily أو افتحهما من الحفظ أولاً.');
      return;
    }
    setGenerating(true);
    try {
      // Yield one frame so the button's busy state paints on slower phones.
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      const interpretation = await interpretOnline(text, { groq: apiKey, tavily: searchKey }, {
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
        <div className="online-heading"><span className="online-dot" /> Groq + Tavily · بدون استضافة سحابية</div>
        <p>استخدم الخطتين المجانيتين فقط، ولا تفعّل الدفع أو الاستخدام الإضافي. النموذج والبحث لهما حدود وقد يتوقفان عند بلوغها. التطبيق لا يستطيع التحقق من خطتك؛ الحساب المدفوع قد يُحاسَب.</p>
        <p>يُرسل الوصف إلى Groq، وعبارة البحث إلى Tavily عند الحاجة، وقد تُرسل نتائج البحث إلى Groq. يمر المفتاحان عبر خادم محلي على هاتفك فقط.</p>
        <label className="field"><span className="field-label">مفتاح Groq API</span>
          <input className="input online-key" type="password" autoComplete="off" spellCheck={false} value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)} placeholder="مفتاح Groq" aria-label="Groq API key" />
        </label>
        <label className="field"><span className="field-label">مفتاح Tavily للبحث</span>
          <input className="input online-key" type="password" autoComplete="off" spellCheck={false} value={searchKey}
            onChange={(event) => onSearchKeyChange(event.target.value)} placeholder="مفتاح Tavily" aria-label="Tavily API key" />
        </label>
        <p>لحفظ المفتاحين على هذا الهاتف، اختر كلمة مرور قوية. لن تتم مزامنتهما مع أي حساب أو جهاز آخر.</p>
        <label className="field"><span className="field-label">كلمة مرور حفظ المفتاحين</span>
          <input className="input online-key" type="password" autoComplete="new-password" value={password}
            onChange={(event) => setPassword(event.target.value)} aria-label="كلمة مرور حفظ المفتاح" placeholder="8 أحرف على الأقل" />
        </label>
        <div className="account-actions">
          <button type="button" className="btn btn-small" disabled={accountBusy || !apiKey.trim() || !searchKey.trim() || !password} onClick={() => {
            setAccountBusy(true); setAccountError('');
            void saveLocalKey({ groq: apiKey, tavily: searchKey }, password).then(() => { setStoredKey(true); setPassword(''); notify('حُفظ المفتاحان مشفّرين على الهاتف.', 'success'); })
              .catch((error: unknown) => setAccountError(error instanceof Error ? error.message : 'تعذّر حفظ المفتاحين.'))
              .finally(() => setAccountBusy(false));
          }}>حفظ مشفّر</button>
          {storedKey && <button type="button" className="btn btn-small" disabled={accountBusy || !password} onClick={() => {
            setAccountBusy(true); setAccountError('');
            void unlockLocalKey(password).then((keys) => { onApiKeyChange(keys.groq); onSearchKeyChange(keys.tavily); setPassword(''); notify('فُتح المفتاحان لهذا الاستخدام.', 'success'); })
              .catch((error: unknown) => setAccountError(error instanceof Error ? error.message : 'تعذّر فتح المفتاحين.'))
              .finally(() => setAccountBusy(false));
          }}>فتح المفتاحين</button>}
          {storedKey && <button type="button" className="btn btn-small" disabled={accountBusy} onClick={() => {
            try { deleteLocalKey(); setStoredKey(false); onApiKeyChange(''); onSearchKeyChange(''); setPassword(''); setAccountError(''); notify('حُذف المفتاحان المحفوظان.', 'success'); }
            catch (error) { setAccountError(error instanceof Error ? error.message : 'تعذّر حذف المفتاحين.'); }
          }}>حذف المفتاحين</button>}
        </div>
        {accountError && <p className="online-error" role="alert">{accountError}</p>}
        <p>{storedKey ? 'يوجد مفتاحان مشفّران في هذا المتصفح. أدخل كلمة المرور ثم اضغط فتح المفتاحين بعد إعادة فتح الصفحة.' : 'الحفظ اختياري. دون حفظ، يبقى المفتاحان في ذاكرة الصفحة فقط.'} لن تتمكن من فتحهما إذا نسيت كلمة المرور. التشفير لا يحمي من الإضافات الخبيثة أو جهاز مخترق؛ استخدم هاتفاً موثوقاً.</p>
        <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">الحصول على مفتاح Groq ↗</a><br />
        <a href="https://app.tavily.com/" target="_blank" rel="noopener noreferrer">الحصول على مفتاح Tavily ↗</a>
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
      <p className="generate-caption" dir="rtl">✦ يتطلب اتصالاً بالإنترنت ومفتاحي Groq وTavily</p>
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
          <p className="hint-text" dir="rtl">{result.searched ? 'تم استخدام البحث عبر الإنترنت في هذا الطلب.' : 'لم يُجرَ بحث عبر الإنترنت في هذا الطلب.'}</p>
          {result.searched && !result.sources?.length && <p className="hint-text" dir="rtl">لم تُرفق الخدمة روابط مصادر لهذا الطلب.</p>}
          {result.sources && result.sources.length > 0 && (
            <div className="online-sources" dir="rtl">
              <strong>مصادر البحث</strong>
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
