import { useState } from 'react';
import { editWorldByText } from '../../ai/worldEdit';
import type { ShapeModel } from '../../ai/shapeLearner';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';

export function TextEditPanel({ shapeModel }: { shapeModel: ShapeModel }) {
  const { state, dispatch } = useEditor();
  const [command, setCommand] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const apply = () => {
    try {
      const result = editWorldByText(state.plan, state.selection, command, shapeModel);
      dispatch({ type: 'replacePlan', plan: result.plan });
      setFeedback({ text: `${result.message} يمكنك التراجع من زر Undo.`, error: false });
      setCommand('');
    } catch (error) {
      setFeedback({ text: error instanceof Error ? error.message : 'تعذّر تنفيذ التعديل؛ لم يتغير العالم.', error: true });
    }
  };
  return (
    <section className="text-edit" dir="rtl" aria-labelledby="text-edit-heading">
      <div className="text-edit-heading"><span><Icon name="sparkles" size={17} /></span><div><h2 id="text-edit-heading">عدّل عالمك بالكتابة</h2><p>تعديل واحد على العالم الحالي، دون إنشاء عالم جديد.</p></div></div>
      <label className="field">
        <span className="field-label">اكتب التعديل</span>
        <textarea className="prompt-input text-edit-input" aria-label="تعديل العالم بالكتابة" value={command} onChange={(event) => setCommand(event.target.value)} dir="auto" maxLength={400} rows={3} placeholder="مثلاً: أضف شجرتين على يمين البيت" />
      </label>
      <button type="button" className="btn btn-primary text-edit-button" onClick={apply} disabled={!command.trim()}>
        <Icon name="sparkles" size={16} /> تطبيق التعديل
      </button>
      {feedback && <p className={feedback.error ? 'online-error' : 'text-edit-success'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
      <details className="text-edit-help"><summary>الأوامر المتاحة</summary><p>مثال: «أضف شجرتين على يمين البيت»، «لوّن البيت أحمر»، «كبّر البيت»، «احذف البيت»، أو «حرّك البيت إلى يسار الشجرة». إذا وُجد أكثر من عنصر مطابق، اختر واحداً في المشهد أولاً. يمكن كتابة «العنصر المحدد». الأوامر المحدودة تعمل محلياً؛ اليمين واليسار حسب محاور العالم، وليس اتجاه الكاميرا.</p></details>
    </section>
  );
}
