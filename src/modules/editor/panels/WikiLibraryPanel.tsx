import { useEffect, useState } from 'react';
import { searchWikiArticles } from '../../ai/onlineInterpreter';
import { readWikiLibrary, removeWikiArticle, saveWikiArticle, WIKI_LIBRARY_KEY, WIKI_LIBRARY_LIMIT, type WikiArticle } from '../../ai/wikiLibrary';

const LIBRARY_CHANGED = 'worldforge-wiki-library-changed';

export function WikiLibraryPanel({ selected, onSelect }: { selected: WikiArticle | null; onSelect: (entry: WikiArticle | null) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WikiArticle[]>([]);
  const [articles, setArticles] = useState<WikiArticle[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => {
      try {
        const latest = readWikiLibrary(window.localStorage);
        setArticles(latest);
        if (selected) {
          const current = latest.find((entry) => entry.url === selected.url);
          if (!current) onSelect(null);
          else if (current.title !== selected.title || current.content !== selected.content) onSelect(current);
        }
      }
      catch { setError('تعذّر قراءة مكتبة ويكيبيديا على هذا المتصفح. لم تُحذف البيانات.'); }
    };
    refresh();
    window.addEventListener(LIBRARY_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(LIBRARY_CHANGED, refresh); window.removeEventListener('storage', refresh); };
  }, [selected, onSelect]);
  const search = async () => {
    if (!query.trim() || busy) return;
    setBusy(true); setError(''); setMessage(''); setResults([]);
    try {
      const found = await searchWikiArticles(query);
      setResults(found.filter((entry, index) => found.findIndex((other) => other.url === entry.url) === index));
      if (!found.length) setMessage('لم تظهر نتائج لهذا البحث.');
    } catch (err) { setError(err instanceof Error ? err.message : 'تعذّر البحث.'); }
    finally { setBusy(false); }
  };
  const save = (entry: WikiArticle) => {
    try {
      setArticles(saveWikiArticle(window.localStorage, entry));
      window.dispatchEvent(new Event(LIBRARY_CHANGED));
      setError(''); setMessage(`حُفظ «${entry.title}» في هذا المتصفح. عند امتلاء المكتبة يُزال أقدم مرجع.`);
    } catch { setError('تعذّر حفظ المرجع؛ تحقق من مساحة التخزين أو بيانات المكتبة.'); }
  };
  const remove = (entry: WikiArticle) => {
    try {
      setArticles(removeWikiArticle(window.localStorage, entry.url));
      if (selected?.url === entry.url) onSelect(null);
      window.dispatchEvent(new Event(LIBRARY_CHANGED));
      setError(''); setMessage(`حُذف «${entry.title}» من المكتبة.`);
    } catch { setError('تعذّر حذف المرجع من التخزين.'); }
  };
  const clear = () => {
    if (!window.confirm('حذف كل مراجع ويكيبيديا المحفوظة في هذا المتصفح؟')) return;
    try {
      window.localStorage.removeItem(WIKI_LIBRARY_KEY);
      setArticles([]); onSelect(null); window.dispatchEvent(new Event(LIBRARY_CHANGED));
      setError(''); setMessage('حُذفت المكتبة المحلية.');
    } catch { setError('تعذّر حذف المكتبة من التخزين.'); }
  };
  return <details className="wiki-library" dir="rtl">
    <summary>مكتبة ويكيبيديا للبحث والبناء</summary>
    <p>ابحث عن موضوع واحفظ المراجع التي تختارها. المكتبة تحفظ مقتطفات قصيرة فقط، بحد {WIKI_LIBRARY_LIMIT} مرجعاً في هذا المتصفح، لا مقالات ويكيبيديا كلها. البحث يحتاج الإنترنت وخادم Termux.</p>
    <p>يمكن للمرجع المختار اقتراح بيئة من أربع بيئات عند وجود كلمة واضحة؛ لا يحوّل المقال إلى نموذج 3D ولا يفهم كل ما فيه. <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener noreferrer">ترخيص النصوص والإسناد</a>.</p>
    <label className="field"><span className="field-label">موضوع البحث</span>
      <input className="input" aria-label="موضوع البحث في ويكيبيديا" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={400} placeholder="مثلاً: واحة" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} />
    </label>
    <button className="btn btn-secondary" type="button" onClick={() => void search()} disabled={busy || !query.trim()}>{busy ? 'جاري البحث…' : 'ابحث في ويكيبيديا'}</button>
    {error && <p className="online-error" role="alert">{error}</p>}
    {message && <p className="hint-text" role="status">{message}</p>}
    {results.length > 0 && <div className="wiki-list"><strong>نتائج البحث</strong>{results.map((entry) => <article className="wiki-entry" key={entry.url}>
      <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title} ↗</a>
      <p>{entry.content || 'لا يتوفر مقتطف لهذه النتيجة.'}</p>
      <button className="btn btn-secondary" type="button" onClick={() => save(entry)} aria-label={`حفظ ${entry.title}`}>حفظ المرجع</button>
    </article>)}</div>}
    <div className="wiki-list"><strong>مكتبتي ({articles.length}/{WIKI_LIBRARY_LIMIT})</strong>
      {!articles.length && <p>لم تحفظ أي مرجع بعد.</p>}
      {articles.map((entry) => <article className="wiki-entry" key={entry.url}>
        <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title} ↗</a>
        <p>{entry.content || 'لا يتوفر مقتطف لهذا المرجع.'}</p>
        <div className="wiki-actions">
          <button className="btn btn-secondary" type="button" onClick={() => onSelect(selected?.url === entry.url ? null : entry)} aria-label={`اختيار ${entry.title} للتوليد`} aria-pressed={selected?.url === entry.url}>{selected?.url === entry.url ? 'إلغاء الاختيار' : 'استخدم في العالم التالي'}</button>
          <button className="btn btn-secondary" type="button" onClick={() => remove(entry)} aria-label={`حذف ${entry.title}`}>حذف</button>
        </div>
      </article>)}
      {selected && <p className="hint-text">المرجع المختار للعالم التالي: {selected.title}</p>}
      <button className="btn btn-secondary" type="button" onClick={clear}>حذف المكتبة المحلية</button>
    </div>
  </details>;
}
