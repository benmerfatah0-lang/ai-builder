import { useEffect, useRef, useState } from 'react';
import type { WorldPlan } from '../../../core/world-plan/schema';
import { imageReferenceSchema, type ImageReference } from '../../ai/imageReferences';
import { searchImageReferencePage, searchWikiArticlePage, readWikiArticle } from '../../ai/onlineInterpreter';
import type { WikiArticle } from '../../ai/wikiReference';
import { ImageSceneStudio } from './ImageSceneStudio';
import { ReferenceThumbnail } from './ReferenceThumbnail';

/** A conservative search phrase, editable before use. Never executed as code. */
export function referenceSearchQuery(prompt:string):string {
  return prompt.trim().replace(/^(?:(?:أ|إ|آ|ا)?(?:بني|بن|صنع|نشئ|عمل|ضف|ضيف)|اصنع|ابني|أنشئ|صمم|ضع|build|create|make|add)\s+(?:(?:لي|لنا|me)\s+)?/iu,'').trim().slice(0,400) || prompt.trim().slice(0,400);
}

export function ReferenceSceneWorkflow({prompt,basePlan,mode,canApply,onCancel,onApplied,onOpenStudio}:{prompt:string;basePlan:WorldPlan;mode:'create'|'edit';canApply:()=>boolean;onCancel:()=>void;onApplied:()=>void;onOpenStudio?:()=>void}) {
  const [query,setQuery]=useState(()=>referenceSearchQuery(prompt));
  const [images,setImages]=useState<ImageReference[]>([]), [next,setNext]=useState<number|null>(null);
  const [searchBusy,setSearchBusy]=useState(false), [error,setError]=useState('');
  const [chosen,setChosen]=useState<{file:File;reference?:ImageReference}|null>(null);
  const [articles,setArticles]=useState<WikiArticle[]>([]), [article,setArticle]=useState<WikiArticle|null>(null);
  const [wikiBusy,setWikiBusy]=useState(false), [wikiReady,setWikiReady]=useState(false), [annotating,setAnnotating]=useState(false);
  const controller=useRef<AbortController|null>(null), sequence=useRef(0), activeQuery=useRef(query);
  const begin=()=>{controller.current?.abort();const current=new AbortController();controller.current=current;return {signal:current.signal,id:++sequence.current};};
  const alive=(id:number)=>id===sequence.current && !controller.current?.signal.aborted;
  useEffect(()=>{void search(0,query);return()=>{sequence.current++;controller.current?.abort();};},[]);
  const search=async(offset:number,term:string)=>{
    const q=term.trim(); if(!q || q.length>400){setError('اكتب موضوع بحث لا يزيد على 400 حرف.');return;}
    const {signal,id}=begin(); setSearchBusy(true);setError('');activeQuery.current=q;
    try {const page=await searchImageReferencePage(q,offset,signal);if(!alive(id))return;setImages((old)=>offset?[...old,...page.results.filter(item=>!old.some(previous=>previous.url===item.url))]:page.results);setNext(page.next);}
    catch(reason){if(alive(id))setError(reason instanceof Error?reason.message:'تعذّر البحث عن الصور.');}
    finally{if(alive(id))setSearchBusy(false);}
  };
  const afterImage=async(file:File,reference?:ImageReference, id?:number, signal?:AbortSignal)=>{
    const request=id===undefined ? begin() : {id,signal:signal!};
    if(!alive(request.id))return;
    setChosen({file,...(reference?{reference}:{})});setArticles([]);setArticle(null);setWikiBusy(true);setWikiReady(false);setError('');
    try {const page=await searchWikiArticlePage(activeQuery.current,0,request.signal);if(alive(request.id))setArticles(page.results);}
    catch(reason){if(alive(request.id))setError(reason instanceof Error?reason.message:'تعذّر البحث في ويكيبيديا.');}
    finally {if(alive(request.id)){setWikiBusy(false);setWikiReady(true);}}
  };
  const chooseRemote=async(image:ImageReference)=>{
    const checked=imageReferenceSchema.safeParse(image);if(!checked.success){setError('بيانات الصورة غير صالحة.');return;}
    const {id,signal}=begin();setSearchBusy(true);setError('');
    try {
      const response=await fetch(`/api/image-thumbnail?url=${encodeURIComponent(checked.data.thumbnail)}`,{signal});
      if(!response.ok)throw new Error('تعذّر تحميل الصورة المختارة من خادم الهاتف.');
      const blob=await response.blob();
      if(!['image/jpeg','image/png','image/webp'].includes(blob.type)||!blob.size||blob.size>1_000_000) throw new Error('صيغة الصورة أو حجمها غير مدعوم.');
      if(!alive(id))return;
      setSearchBusy(false);
      await afterImage(new File([blob],checked.data.title,{type:blob.type}),checked.data,id,signal);
    } catch(reason){if(alive(id))setError(reason instanceof Error?reason.message:'تعذّر تحميل الصورة.');}
    finally{if(alive(id))setSearchBusy(false);}
  };
  const chooseArticle=async(candidate:WikiArticle)=>{
    const {id,signal}=begin();setWikiBusy(true);setError('');
    try {const found=await readWikiArticle(candidate.title,signal);if(!alive(id))return;
      if(!found || found.title!==candidate.title){setArticle(candidate);setError('تعذّرت قراءة المقدمة المطابقة؛ أعرض مقتطف البحث فقط.');}
      else setArticle(found);
    } catch(reason){if(!alive(id))return;setArticle(candidate);setError('تعذّرت قراءة المقدمة؛ أعرض مقتطف البحث فقط.');}
    finally{if(alive(id))setWikiBusy(false);}
  };
  return <section className="wiki-library" dir="rtl" aria-label="إنشاء أو تعديل باستخدام صورة مرجعية">
    <strong>{mode==='create'?'إنشاء العالم':'تعديل العالم'} من الوصف والصورة</strong>
    <p>اختر صورة أولاً، ثم مقالة مناسبة. الكلمات المقترحة من المقالة لا تثبت وجودها في الصورة؛ ستحدد العناصر بنفسك. لا يحدث أي تغيير قبل التأكيد.</p>
    {!chosen && <>
      <label className="field"><span>موضوع البحث عن الصور (يمكن تعديله)</span><input aria-label="موضوع البحث عن صور المشهد" value={query} maxLength={400} onChange={(event)=>setQuery(event.target.value)} /></label>
      <button type="button" className="btn btn-small" disabled={searchBusy} onClick={()=>void search(0,query)}>البحث عن صور</button>
      {searchBusy && <p role="status">أبحث عن صور أو أحمّل الصورة المختارة…</p>}
      <div className="wiki-list">{images.map((image,index)=><div key={image.url}><button type="button" className="image-ref-card" disabled={searchBusy} onClick={()=>void chooseRemote(image)}><ReferenceThumbnail image={image} alt={image.title} eager={index<4}/><span>اختر {image.title} · {image.author} · {image.license_name}</span></button><a href={image.url} target="_blank" rel="noopener noreferrer">المصدر ↗</a> · <a href={image.license_url} target="_blank" rel="noopener noreferrer">الترخيص ↗</a></div>)}</div>
      {!searchBusy && !images.length && <p>لم تظهر صور مقبولة. جرّب كلمات أخرى أو اختر صورة من جهازك.</p>}
      {next!==null && <button type="button" className="btn btn-small" disabled={searchBusy || query.trim()!==activeQuery.current} onClick={()=>void search(next,activeQuery.current)}>المزيد من صور المشهد</button>}
      <label className="field"><span>أو اختر صورة من الجهاز</span><input aria-label="صورة مرجعية من الجهاز" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event)=>{const file=event.target.files?.[0];event.target.value='';if(file){if(!['image/jpeg','image/png','image/webp'].includes(file.type)||!file.size||file.size>12*1024*1024){setError('اختر JPEG أو PNG أو WebP بحجم لا يتجاوز 12 ميغابايت.');return;} activeQuery.current=query.trim() || referenceSearchQuery(prompt);void afterImage(file);}}}/></label>
    </>}
    {chosen && !annotating && <>
      <p>الصورة المختارة: {chosen.reference ? <><a href={chosen.reference.url} target="_blank" rel="noopener noreferrer">{chosen.reference.title}</a> · {chosen.reference.author} · <a href={chosen.reference.license_url} target="_blank" rel="noopener noreferrer">{chosen.reference.license_name}</a></> : chosen.file.name}</p>
      {wikiBusy && <p role="status">أبحث عن مقالة ويكيبيديا أو أقرأ مقدمتها…</p>}
      {wikiReady && <><p>اختر مقالة مناسبة لقراءة مقدمتها؛ ليست كل نتيجة مطابقة:</p>{articles.map((item)=><div key={item.url}><button type="button" className="btn btn-small" disabled={wikiBusy} onClick={()=>void chooseArticle(item)}>اقرأ {item.title}</button><p>{item.content}</p></div>)}{!articles.length && <p>لم تظهر مقالات؛ يمكنك المتابعة دون مقالة.</p>}
      {article && <div><p>المقالة المختارة: <a href={article.url} target="_blank" rel="noopener noreferrer">{article.title} ↗</a></p><p>{article.content}</p></div>}
      <button type="button" className="btn btn-primary" disabled={wikiBusy} onClick={()=>setAnnotating(true)}>{article?'متابعة لتحديد العناصر':'متابعة دون مقالة'}</button></>}
    </>}
    {annotating && chosen && <ImageSceneStudio embedded initialDescription={prompt} articleText={article?.content??''} initialFile={chosen.file} reference={chosen.reference} mode={mode} basePlan={basePlan} canApply={canApply} onApplied={onApplied} onOpenStudio={onOpenStudio}/>}
    {error && <p role="alert" className="online-error">{error}</p>}
    <button type="button" className="btn btn-small" onClick={onCancel}>إلغاء واختيار أمر آخر</button>
  </section>;
}
