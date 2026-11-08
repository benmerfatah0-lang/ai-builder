import { useEffect, useRef, useState } from 'react';
import { searchImageReferences } from '../../ai/onlineInterpreter';
import { IMAGE_LIBRARY_KEY, IMAGE_LIBRARY_LIMIT, readImageReferences, removeImageReference, sameImageQuery, saveImageReference, type ImageReference } from '../../ai/imageReferences';

const CHANGED = 'worldforge-image-references-changed';
export function ImageReferencePanel({ autoRequest }: { autoRequest: { id: number; query: string } | null }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ImageReference[]>([]);
  const [saved, setSaved] = useState<ImageReference[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const requestId = useRef(0);
  useEffect(() => {
    const refresh = () => {
      try { setSaved(readImageReferences(window.localStorage)); }
      catch { setError('تعذّر قراءة مكتبة مراجع الصور؛ لم تُحذف البيانات.'); }
    };
    refresh();
    window.addEventListener(CHANGED, refresh); window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(CHANGED, refresh); window.removeEventListener('storage', refresh); requestId.current++; };
  }, []);
  const search = async (value: string, preferSaved = false) => {
    const clean = value.trim();
    if (!clean) return;
    const id = ++requestId.current;
    setBusy(true); setError(''); setMessage(''); setResults([]);
    try {
      const cached = preferSaved ? readImageReferences(window.localStorage).filter((item) => sameImageQuery(item.query, clean)) : [];
      const found = cached.length ? cached : await searchImageReferences(clean);
      if (id !== requestId.current) return;
      setResults(found);
      setMessage(cached.length ? 'عُثر على مراجع محفوظة لهذا الوصف بالضبط؛ الصور المصغرة تحتاج الإنترنت للعرض.' :
        found.length ? 'هذه نتائج بحث، وليست صوراً تحقق التطبيق من مطابقتها للوصف.' : 'لا توجد نتائج بالترخيص والبيانات المدعومة؛ جرّب كلمة أخرى.');
    } catch (err) {
      if (id === requestId.current) setError(err instanceof Error ? err.message : 'تعذّر البحث عن الصور.');
    } finally { if (id === requestId.current) setBusy(false); }
  };
  useEffect(() => {
    if (!autoRequest) return;
    setOpen(true); setQuery(autoRequest.query);
    void search(autoRequest.query, true);
    // Only new generation requests trigger the automatic lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRequest]);
  const save = (image: ImageReference) => {
    try {
      setSaved(saveImageReference(window.localStorage, image));
      window.dispatchEvent(new Event(CHANGED)); setError('');
      setMessage('حُفظ رابط المرجع وبياناته؛ عند امتلاء المكتبة يُحذف الأقدم، ولا تُحفظ الصورة نفسها.');
    } catch { setError('تعذّر حفظ المرجع؛ تحقق من التخزين وبيانات المكتبة.'); }
  };
  const remove = (image: ImageReference) => {
    try {
      setSaved(removeImageReference(window.localStorage, image.url));
      window.dispatchEvent(new Event(CHANGED)); setError(''); setMessage('حُذف مرجع الصورة المحفوظ.');
    } catch { setError('تعذّر حذف مرجع الصورة.'); }
  };
  const clear = () => {
    if (!window.confirm('حذف جميع مراجع الصور المحفوظة في هذا المتصفح؟')) return;
    try {
      window.localStorage.removeItem(IMAGE_LIBRARY_KEY); setSaved([]);
      window.dispatchEvent(new Event(CHANGED)); setError(''); setMessage('حُذفت مراجع الصور المحلية.');
    } catch { setError('تعذّر حذف مراجع الصور.'); }
  };
  const card = (image: ImageReference, isSaved: boolean) => <article className="image-ref-card" key={image.url}>
    <img src={image.thumbnail} alt={`صورة مرجعية: ${image.title}`} loading="lazy" referrerPolicy="no-referrer" width="240" />
    <div>
      <a href={image.url} target="_blank" rel="noopener noreferrer">{image.title} ↗</a>
      <p>المؤلف: {image.author} · <a href={image.license_url} target="_blank" rel="noopener noreferrer">{image.license_name}</a></p>
      <p>البحث: {image.query}</p>
      <button className="btn btn-secondary" type="button" onClick={() => isSaved ? remove(image) : save(image)} aria-label={`${isSaved ? 'حذف مرجع صورة' : 'حفظ مرجع صورة'} ${image.title}`}>{isSaved ? 'حذف المرجع' : 'حفظ المرجع'}</button>
    </div>
  </article>;
  return <details className="wiki-library image-library" dir="rtl" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>مكتبة صور Wikimedia Commons</summary>
    {open && <>
      <p>ابحث عن صور مرجعية واحفظ روابط ما تختاره. تُعرض نتائج JPEG وPNG فقط مع ترخيص CC BY أو CC BY-SA أو CC0 وبيانات الإسناد المتاحة؛ تحقق من صفحة الملف قبل إعادة الاستخدام.</p>
      <p>هذه الصور مرجع للعرض والحفظ فقط: المساعد لا يحللها بصرياً ولا يحولها إلى 3D الآن. البحث والصور المصغرة يحتاجان الإنترنت؛ قد لا تطابق النتائج ما تقصده.</p>
      <label className="field"><span className="field-label">اسم الشيء في الصور</span><input className="input" aria-label="موضوع البحث عن الصور" value={query} maxLength={400} placeholder="مثلاً: قلعة" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(query); } }} /></label>
      <button className="btn btn-secondary" type="button" disabled={busy || !query.trim()} onClick={() => void search(query)}>{busy ? 'جاري البحث عن الصور…' : 'ابحث عن صور'}</button>
      {error && <p className="online-error" role="alert">{error}</p>}
      {message && <p className="hint-text" role="status">{message}</p>}
      {results.length > 0 && <div className="wiki-list"><strong>نتائج الصور</strong>{results.map((image) => card(image, false))}</div>}
      <div className="wiki-list"><strong>مراجع الصور المحفوظة ({saved.length}/{IMAGE_LIBRARY_LIMIT})</strong>
        {!saved.length && <p>لا توجد مراجع صور محفوظة بعد.</p>}
        {saved.map((image) => card(image, true))}
        <p>يُحفظ الرابط والمؤلف والترخيص وعبارة البحث في المتصفح، لا ملف الصورة. عند امتلاء المكتبة يُحذف أقدم مرجع.</p>
        <button className="btn btn-secondary" type="button" onClick={clear}>حذف جميع مراجع الصور</button>
      </div>
    </>}
  </details>;
}
