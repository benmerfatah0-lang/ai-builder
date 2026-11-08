import { useEffect, useRef, useState } from 'react';
import { searchImageReferencePage, searchWikiArticlePage } from '../../ai/onlineInterpreter';
import type { TopicResearch } from '../../ai/unknownResearch';
import { dictionaryPage } from '../../ai/dictionary';
import { ReferenceThumbnail } from './ReferenceThumbnail';
import type { ResearchReport } from '../../ai/unknownResearch';

export function ResearchResults({ report, busy, progress }: { report: ResearchReport | null; busy: boolean; progress?: { done: number; total: number } | null }) {
  if (!report || !report.topics.length) return busy ? <p role="status" className="hint-text" dir="rtl">أبحث تلقائياً في ويكيبيديا وويكاموس وWikimedia Commons… {progress ? `${progress.done} / ${progress.total}` : ''}</p> : null;
  return <section className="wiki-library" dir="rtl" aria-label="نتائج البحث التلقائي">
    <strong>بحث تلقائي عن كلمات قد لا أفهمها</strong>
    {busy && <p role="status">البحث جارٍ… {progress ? `${progress.done} / ${progress.total}` : ''}</p>}
    <p>التعرف تقريبي وقد لا تكون النتائج مطابقة. في الحالات البسيطة يمكن محاولة فصل شكل الصورة وبناء حجم تقريبي متناظر؛ ليست استعادة حقيقية للجوانب المخفية. راجع المصادر والتراخيص.</p>
    {report.approximation && <div className="wiki-entry">
      <p>{report.approximation.sourceKind === 'dictionary' ? 'تعريف المعجم صنّف' : 'مقتطف المقالة صنّف'} «{report.approximation.term}» ك{report.approximation.assetLabel ?? 'بيت'}؛ {report.approximation.applied ? 'استُخدم' : 'اقتُرح'} نموذج {report.approximation.assetLabel ?? 'بيت'} موجود كتقريب وليس نموذجاً مطابقاً.</p>
      <p>المصدر: <a href={report.approximation.articleUrl} target="_blank" rel="noopener noreferrer">{report.approximation.articleTitle} ↗</a></p>
      {report.approximation.color && <p>متوسط لون مركز أول صورة: <strong>{report.approximation.color}</strong>. {report.approximation.colorApplied ? 'استُخدم كلون البيت.' : 'لم يُطبّق اللون.'} قد يمثل الخلفية، وليس لون الجسم.</p>}
      {report.approximation.imageError && <p className="online-error">{report.approximation.imageError} استُخدم اللون الافتراضي.</p>}
      {!report.approximation.image && <p>لم تُستخدم صورة؛ الشكل من مكتبة التطبيق وليس مستخرجاً من ويكيبيديا.</p>}
      {report.approximation.image && <p>مصدر التحليل: <a href={report.approximation.image.url} target="_blank" rel="noopener noreferrer">{report.approximation.image.title}</a> · {report.approximation.image.author} · <a href={report.approximation.image.license_url} target="_blank" rel="noopener noreferrer">{report.approximation.image.license_name}</a></p>}
    </div>}
    {report.topics.map((topic) => <ResearchTopic topic={topic} key={topic.term} />)}
  </section>;
}

function ResearchTopic({ topic }: { topic: TopicResearch }) {
  const [articles, setArticles] = useState(topic.articles);
  const [images, setImages] = useState(topic.images);
  const [thumbnailRetry, setThumbnailRetry] = useState(0);
  const [articleNext, setArticleNext] = useState(topic.articleNext ?? null);
  const [imageNext, setImageNext] = useState(topic.imageNext ?? null);
  const [articleBusy, setArticleBusy] = useState(false), [imageBusy, setImageBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const requests = useRef(new Set<AbortController>());
  useEffect(() => { setArticles(topic.articles); setImages(topic.images); setArticleNext(topic.articleNext ?? null); setImageNext(topic.imageNext ?? null); setPageError(''); setArticleBusy(false); setImageBusy(false);
    const active = requests.current;
    return () => { active.forEach((request) => request.abort()); active.clear(); };
  }, [topic]);
  const more = async (kind: 'article' | 'image') => {
    const offset = kind === 'article' ? articleNext : imageNext;
    if (offset === null || (kind === 'article' ? articleBusy : imageBusy)) return;
    const controller = new AbortController(); requests.current.add(controller);
    if (kind === 'article') setArticleBusy(true); else setImageBusy(true);
    setPageError('');
    try {
      if (kind === 'article') {
        const page = await searchWikiArticlePage(topic.term, offset, controller.signal);
        setArticles((old) => [...old, ...page.results.filter((item) => !old.some((entry) => entry.url === item.url))]); setArticleNext(page.next);
      } else {
        const page = await searchImageReferencePage(topic.imageQuery ?? topic.term, offset, controller.signal);
        setImages((old) => [...old, ...page.results.filter((item) => !old.some((entry) => entry.url === item.url))]); setImageNext(page.next);
      }
    } catch (error) { if (!controller.signal.aborted) setPageError(error instanceof Error ? error.message : 'تعذّر تحميل المزيد.'); }
    finally { requests.current.delete(controller); if (!controller.signal.aborted) { if (kind === 'article') setArticleBusy(false); else setImageBusy(false); } }
  };
  return <article className="wiki-entry">
    <strong>البحث عن: {topic.term}</strong>
    {topic.articleNotice && <p>{topic.articleNotice}</p>}
    {topic.wikiError ? <p className="online-error">تعذّر البحث في ويكيبيديا؛ لم تُستخدم نتائج منها لهذا الموضوع. {topic.wikiError}</p> : <div className="wiki-list"><span>مقالات ويكيبيديا</span>
      {!articles.length && <p>لم تظهر نتائج في هذه الصفحات.</p>}
      {articles.map((entry) => <div key={entry.url}><a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title} ↗</a><p>{entry.content}</p></div>)}
      {articleNext !== null && <button type="button" className="btn btn-small" disabled={articleBusy} onClick={() => void more('article')}>{articleBusy ? 'جارٍ تحميل المقالات…' : 'المزيد من المقالات'}</button>}
    </div>}
    {topic.dictionaryError ? <p className="online-error">{topic.dictionaryError}</p> : topic.dictionary && <div className="wiki-list">
      <span><a href={dictionaryPage(topic.term)} target="_blank" rel="noopener noreferrer">ويكاموس: {topic.term} ↗</a> · تعريفات بالإنجليزية</span>
      {!topic.dictionary.entries.length ? <p>لم نجد تعريفاً عربياً أو فرنسياً أو إنجليزياً لهذه الكلمة.</p> : topic.dictionary.entries.map((entry, index) => <p key={index}><b>{({ ar: 'عربية', fr: 'فرنسية', en: 'إنجليزية' } as const)[entry.language]}</b> · {entry.partOfSpeech}: {entry.definition}</p>)}
      {!topic.dictionary.complete && <p>نتائج المعجم مختصرة؛ افتح المصدر لباقي المعاني.</p>}
    </div>}
    {topic.imageNotice && <p>{topic.imageNotice}</p>}
    {topic.imageError ? <p className="online-error">تعذّر البحث عن الصور في Wikimedia Commons. {topic.imageError}</p> : <div className="wiki-list"><span>صور من Wikimedia Commons للمراجعة؛ اختر الصورة من استوديو البناء إذا ظهر.</span>
      {!images.length && <p>لم تظهر صور بالتراخيص والبيانات المدعومة في هذه الصفحات.</p>}
      {images.map((image, index) => <div className="image-ref-card" key={image.url}><ReferenceThumbnail key={thumbnailRetry} image={image} alt={`صورة مرجعية: ${image.title}`} eager={index < 4} />
        <div><a href={image.url} target="_blank" rel="noopener noreferrer">{image.title} ↗</a><p>المؤلف: {image.author} · <a href={image.license_url} target="_blank" rel="noopener noreferrer">{image.license_name}</a></p></div></div>)}
      {!!images.length && <button type="button" className="btn btn-small" onClick={() => setThumbnailRetry((old) => old + 1)}>إعادة تحميل الصور</button>}
      {imageNext !== null && <button type="button" className="btn btn-small" disabled={imageBusy} onClick={() => void more('image')}>{imageBusy ? 'جارٍ تحميل الصور…' : 'المزيد من الصور'}</button>}
    </div>}
    {pageError && <p className="online-error" role="alert">{pageError} يمكنك إعادة المحاولة.</p>}
  </article>;
}
