import { useEffect, useRef, useState } from 'react';
import { researchUnknown, unknownTopics, type ResearchReport } from '../../ai/unknownResearch';
import { ResearchResults } from './ResearchResults';
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
  const sequence = useRef(0);
  const currentEditor = useRef(state); currentEditor.current = state;
  const currentCommand = useRef(command); currentCommand.current = command;
  useEffect(() => () => { sequence.current++; }, []);
  const lookup = async (text: string) => {
    const current = ++sequence.current;
    const original = currentEditor.current;
    setResearch(null);
    if (!unknownTopics(text).terms.length) { setBusy(false); return; }
    setBusy(true);
    const report = await researchUnknown(text);
    if (current !== sequence.current) return;
    // Only additions can be approximated: never reinterpret delete/move commands.
    const isAdd = /^(?:اضف|ضع|add|ajoute|ajouter)\s/iu.test(text.trim().replace(/[أإآ]/g, 'ا'));
    const match = isAdd ? matchHouseApproximation(text, report) : null;
    if (!match) { setResearch(report); setBusy(false); return; }
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
      sequence.current++; setResearch(null); setBusy(false);
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
      <ResearchResults report={research} busy={busy} />
      <details className="text-edit-help"><summary>الأوامر المتاحة</summary><p>مثال: «أضف شجرتين على يمين البيت»، «لوّن البيت أحمر»، «كبّر البيت»، «احذف البيت»، أو «حرّك البيت إلى يسار الشجرة». إذا وُجد أكثر من عنصر مطابق، اختر واحداً في المشهد أولاً. يمكن كتابة «العنصر المحدد». الأوامر المحدودة تعمل محلياً؛ اليمين واليسار حسب محاور العالم، وليس اتجاه الكاميرا.</p></details>
    </section>
  );
}
