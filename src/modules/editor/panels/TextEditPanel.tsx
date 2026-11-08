import { useEffect, useRef, useState } from 'react';
import { researchUnknown, unknownTopics, type ResearchReport } from '../../ai/unknownResearch';
import { ResearchResults } from './ResearchResults';
import { PhotoStudio } from './PhotoStudio';
import { addPhotoModels } from '../../ai/photoModel';
import { planPhotoRequests, type PhotoRequest } from '../../ai/photoRequests';
import { findAssetMentions, normalizeAssetText } from '../../ai/assetRequests';
import type { WorldPlan } from '../../../core/world-plan/schema';
import { analyzeApproximation, hasExplicitColor, matchHouseApproximation } from '../../ai/referenceUnderstanding';
import { editWorldByText } from '../../ai/worldEdit';
import type { ShapeModel } from '../../ai/shapeLearner';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';

export function TextEditPanel({ shapeModel }: { shapeModel: ShapeModel }) {
  const { state, dispatch } = useEditor();
  const [command, setCommand] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [research, setResearch] = useState<ResearchReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [studio, setStudio] = useState<{ requests: PhotoRequest[]; index: number; plan: WorldPlan; draft: WorldPlan; selection: string; command: string; seq: number } | null>(null);
  const sequence = useRef(0);
  const researchAbort = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const currentEditor = useRef(state); currentEditor.current = state;
  const currentCommand = useRef(command); currentCommand.current = command;
  useEffect(() => () => { sequence.current++; researchAbort.current?.abort(); }, []);
  const lookup = async (text: string) => {
    researchAbort.current?.abort();
    const controller = new AbortController(); researchAbort.current = controller;
    const current = ++sequence.current;
    setProgress(null);
    const original = currentEditor.current;
    setResearch(null); setStudio(null);
    if (!unknownTopics(text).terms.length) { setBusy(false); return; }
    setBusy(true);
    let report: ResearchReport;
    try {
      report = await researchUnknown(text, { signal: controller.signal, onProgress: (partial, done, total) => {
        if (current === sequence.current) { setResearch(partial); setProgress({ done, total }); }
      } });
    } catch (error) {
      if (current === sequence.current) { setBusy(false); setFeedback({ text: controller.signal.aborted ? 'أُوقف البحث؛ لم يُطبّق تعديل.' : (error instanceof Error ? error.message : 'تعذّر البحث.'), error: true }); }
      return;
    }
    if (current !== sequence.current) return;
    // Only additions can be approximated: never reinterpret delete/move commands.
    const isAdd = /^(?:اضف|اضيف|ضع|اصنع|انشئ|ابني|اعمل|صمم|add|ajoute|ajouter)\s/iu.test(text.trim().replace(/[أإآ]/g, 'ا'));
    const singleTopic = report.topics.length === 1 && !report.truncated ? report.topics[0] : undefined;
    // If the images are ambiguous, ask before using one instead of coloring a house from the first hit.
    const match = isAdd && !(singleTopic && (singleTopic.images.length > 1 || singleTopic.imageNext != null) && planPhotoRequests(text, [singleTopic]).requests.length > 0) ? matchHouseApproximation(text, report) : null;
    if (!match) {
      setResearch(report); setBusy(false);
      const photos = planPhotoRequests(text, report.topics);
      // Never silently omit catalog items in an atomic edit: mixed additions need a separate command.
      const mixed = findAssetMentions(normalizeAssetText(text)).length > 0;
      if (isAdd && mixed && !(photos.requests.length === 1 && photos.requests[0]?.relation && !photos.warnings.length)) setFeedback({ text: 'في التعديل المركب، أضف العناصر المعروفة والمجهولة في أوامر منفصلة؛ لم يتغير العالم.', error: true });
      else if (isAdd && photos.warnings.length) setFeedback({ text: `${photos.warnings.join(' ')} لم يتغير العالم.`, error: true });
      else if (isAdd && photos.requests.length) {
        setStudio({ requests: photos.requests, index: 0, plan: original.plan, draft: original.plan, selection: original.selection.join('\0'), command: text, seq: current });
        setFeedback({ text: 'وجدت صوراً؛ سأحاول بناء أشكال تقريبية منها، إذا كانت الخلفيات مناسبة.', error: false });
      }
      return;
    }
    const approximation = await analyzeApproximation(match);
    if (current !== sequence.current) return;
    setResearch({ ...report, approximation }); setBusy(false);
    if (currentEditor.current.plan !== original.plan || currentEditor.current.selection.join('\0') !== original.selection.join('\0') || currentCommand.current !== text) {
      setFeedback({ text: 'تغيّر العالم أو الأمر أثناء البحث؛ لم يُطبّق التعديل. أعد المحاولة.', error: true }); return;
    }
    try {
      const edit = editWorldByText(original.plan, original.selection, approximation.rewritten, shapeModel, !hasExplicitColor(text) ? approximation.color : undefined);
      dispatch({ type: 'replacePlan', plan: edit.plan });
      setResearch({ ...report, approximation: { ...approximation, applied: true, colorApplied: Boolean(approximation.color && !hasExplicitColor(text)) } });
      setFeedback({ text: `أُضيف «${match.term}» كنموذج بيت تقريبي من ${match.sourceKind === 'dictionary' ? 'المعجم' : 'المقالة'}. ${edit.message} يمكنك التراجع من Undo.`, error: false });
      setCommand('');
    } catch (error) { setFeedback({ text: error instanceof Error ? error.message : 'تعذّر تطبيق التقريب؛ لم يتغير العالم.', error: true }); }
  };
  const apply = () => {
    try {
      const result = editWorldByText(state.plan, state.selection, command, shapeModel);
      dispatch({ type: 'replacePlan', plan: result.plan });
      sequence.current++; researchAbort.current?.abort(); setResearch(null); setStudio(null); setBusy(false);
      setFeedback({ text: `${result.message} يمكنك التراجع من زر Undo.`, error: false });
      setCommand('');
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : 'تعذّر تنفيذ التعديل؛ لم يتغير العالم.', error: true });
      void lookup(command);
    }
  };
  return (
    <section className="text-edit" dir="rtl" aria-labelledby="text-edit-heading">
      <div className="text-edit-heading"><span><Icon name="sparkles" size={17} /></span><div><h2 id="text-edit-heading">عدّل عالمك بالكتابة</h2><p>تعديل واحد على العالم الحالي، دون إنشاء عالم جديد. إذا لم أفهم كلمات فقد أرسلها للبحث في ويكيبيديا وويكاموس وCommons.</p></div></div>
      <label className="field">
        <span className="field-label">اكتب التعديل</span>
        <textarea className="prompt-input text-edit-input" aria-label="تعديل العالم بالكتابة" value={command} onChange={(event) => setCommand(event.target.value)} dir="auto" maxLength={400} rows={3} placeholder="مثلاً: أضف شجرتين على يمين البيت" />
      </label>
      <button type="button" className="btn btn-primary text-edit-button" onClick={apply} disabled={!command.trim()}>
        <Icon name="sparkles" size={16} /> تطبيق التعديل
      </button>
      {feedback && <p className={feedback.error ? 'online-error' : 'text-edit-success'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      {studio && <div dir="rtl">
        <p role="status">العنصر {studio.index + 1} من {studio.requests.length} · العدد المطلوب: {studio.requests[studio.index]!.count}</p>
        <PhotoStudio key={`${studio.index}:${studio.requests[studio.index]!.topic.term}`} topic={studio.requests[studio.index]!.topic} cancelLabel="إلغاء التعديل"
          onCancel={() => { sequence.current++; setStudio(null); setFeedback({ text: 'أُلغي التعديل؛ لم يتغير العالم.', error: true }); }} onComplete={(model) => {
          const item = studio.requests[studio.index]!;
          if (studio.seq !== sequence.current || currentEditor.current.plan !== studio.plan || currentEditor.current.selection.join('\0') !== studio.selection || currentCommand.current !== studio.command) {
            setFeedback({ text: 'تغيّر العالم أو التحديد أو الأمر أثناء البناء؛ لم يُضف المجسم. أعد المحاولة.', error: true }); setStudio(null); return;
          }
          try {
            const draft = addPhotoModels(studio.draft, model, item.topic.term, item.count, item.relation);
            if (studio.index + 1 < studio.requests.length) { setStudio({ ...studio, draft, index: studio.index + 1 }); return; }
            dispatch({ type: 'replacePlan', plan: draft });
            setFeedback({ text: studio.requests.length === 1 && item.count === 1 ? 'أُضيف مجسم الصورة التقريبي في مكان متاح؛ الخلف والعمق تقديريان. يمكن التراجع بـ Undo.' : 'أُضيفت مجسمات الصور التقريبية معاً؛ الخلف والعمق تقديريان. يمكن التراجع عن التعديل كاملاً بـ Undo.', error: false });
            setCommand(''); setStudio(null);
          } catch (error) { setFeedback({ text: `${error instanceof Error ? error.message : 'تعذّر إضافة المجسم.'} لم يُطبّق أي جزء من التعديل.`, error: true }); setStudio(null); }
        }} />
      </div>}
      {busy && <button type="button" className="btn btn-small" onClick={() => { sequence.current++; researchAbort.current?.abort(); setBusy(false); setFeedback({ text: 'أُوقف البحث؛ لم يُطبّق تعديل.', error: true }); }}>إيقاف البحث</button>}
      <ResearchResults report={research} busy={busy} progress={progress} />
      <details className="text-edit-help"><summary>الأوامر المتاحة</summary><p>مثال: «اصنع لي نهراً يمر وسط القرية»، «أضف شجرتين على يمين البيت»، «لوّن البيت أحمر»، «كبّر البيت»، «احذف البيت»، أو «حرّك البيت إلى يسار الشجرة». إذا وُجد أكثر من عنصر مطابق، اختر واحداً في المشهد أولاً. يمكن كتابة «العنصر المحدد». النهر عنصر مرئي زخرفي لا يحفر التضاريس؛ يقدّر القرية من تجمع البيوت ويحاول تجنب العناصر، ويمكن التراجع عنه. يصحح التطبيق أخطاء إملائية محدودة ويعرض التصحيح، ولا يصحح أوامر الحذف والتحريك تلقائياً. الأوامر المحدودة تعمل محلياً؛ اليمين واليسار حسب محاور العالم، وليس اتجاه الكاميرا.</p></details>
    </section>
  );
}
