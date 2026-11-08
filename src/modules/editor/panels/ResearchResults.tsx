import type { ResearchReport } from '../../ai/unknownResearch';

export function ResearchResults({ report, busy }: { report: ResearchReport | null; busy: boolean }) {
  if (busy) return <p role="status" className="hint-text" dir="rtl">أبحث تلقائياً في ويكيبيديا وWikimedia Commons عن الكلمات غير المعروفة…</p>;
  if (!report || !report.topics.length) return null;
  return <section className="wiki-library" dir="rtl" aria-label="نتائج البحث التلقائي">
    <strong>بحث تلقائي عن كلمات قد لا أفهمها</strong>
    <p>التعرف تقريبي وقد لا تكون النتائج مطابقة. يستطيع التطبيق في حالة محدودة تحليل لون مركز صورة؛ لا يفصل الجسم عن الخلفية ولا يستخرج شكلاً ثلاثي الأبعاد. راجع المصادر والتراخيص.</p>
    {report.approximation && <div className="wiki-entry">
      <p>مقتطف المقالة صنّف «{report.approximation.term}» كبيت؛ {report.approximation.applied ? 'استُخدم' : 'اقتُرح'} نموذج بيت موجود كتقريب وليس نموذجاً مطابقاً.</p>
      {report.approximation.color && <p>متوسط لون مركز أول صورة: <strong>{report.approximation.color}</strong>. {report.approximation.colorApplied ? 'استُخدم كلون البيت.' : 'لم يُطبّق اللون.'} قد يمثل الخلفية، وليس لون الجسم.</p>}
      {report.approximation.imageError && <p className="online-error">{report.approximation.imageError} استُخدم اللون الافتراضي.</p>}
      {!report.approximation.image && <p>لم تتوفر صورة مناسبة؛ استُخدم اللون الافتراضي.</p>}
      {report.approximation.image && <p>مصدر التحليل: <a href={report.approximation.image.url} target="_blank" rel="noopener noreferrer">{report.approximation.image.title}</a> · {report.approximation.image.author} · <a href={report.approximation.image.license_url} target="_blank" rel="noopener noreferrer">{report.approximation.image.license_name}</a></p>}
    </div>}
    {report.truncated && <p>بحثت عن أول موضوعين فقط لتقليل الطلبات؛ قسّم الوصف للبحث عن البقية.</p>}
    {report.topics.map((topic) => <article className="wiki-entry" key={topic.term}>
      <strong>البحث عن: {topic.term}</strong>
      {topic.wikiError ? <p className="online-error">تعذّر البحث في ويكيبيديا؛ لم تُستخدم نتائج منها لهذا الموضوع. {topic.wikiError}</p> : !topic.articles.length ? <p>لم تظهر نتائج من ويكيبيديا.</p> :
        <div className="wiki-list"><span>مقالات ويكيبيديا</span>{topic.articles.slice(0, 2).map((entry) => <div key={entry.url}>
          <a href={entry.url} target="_blank" rel="noopener noreferrer">{entry.title} ↗</a><p>{entry.content}</p>
        </div>)}</div>}
      {topic.imageError ? <p className="online-error">تعذّر البحث عن الصور في Wikimedia Commons. {topic.imageError}</p> : !topic.images.length ? <p>لم تظهر صور بالتراخيص والبيانات المدعومة.</p> :
        <div className="wiki-list"><span>صور من Wikimedia Commons</span>{topic.images.slice(0, 4).map((image) => <div className="image-ref-card" key={image.url}>
          <img src={image.thumbnail} alt={`صورة مرجعية: ${image.title}`} loading="lazy" referrerPolicy="no-referrer" width="240" />
          <div><a href={image.url} target="_blank" rel="noopener noreferrer">{image.title} ↗</a><p>المؤلف: {image.author} · <a href={image.license_url} target="_blank" rel="noopener noreferrer">{image.license_name}</a></p></div>
        </div>)}</div>}
    </article>)}
  </section>;
}
