import { searchImageReferencePage, searchWikiArticlePage, readWikiArticle } from './onlineInterpreter';
import type { ImageReference } from './imageReferences';
import type { WikiArticle } from './wikiReference';

export interface SemanticResearchResult { label:string; article:WikiArticle|null; images:ImageReference[]; errors:string[] }
/** Research each distinct predicted class, at most two classes concurrently. Never choose a photo as an exact match. */
export async function researchDetectedClasses(labels:string[], signal:AbortSignal, onProgress?:(done:number,total:number)=>void):Promise<SemanticResearchResult[]> {
  const unique=[...new Set(labels)].slice(0,30), results:(SemanticResearchResult|undefined)[]=new Array(unique.length);let cursor=0,done=0;
  async function worker(){while(cursor<unique.length){
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const i=cursor++,label=unique[i]!,errors:string[]=[];
    const [wiki,images]=await Promise.allSettled([searchWikiArticlePage(label,0,signal),searchImageReferencePage(label,0,signal)]);
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    let article:WikiArticle|null=null;
    if(wiki.status==='fulfilled'){
      const exact=wiki.value.results.find(a=>a.title.trim().toLowerCase()===label.toLowerCase());
      if(exact){try{const full=await readWikiArticle(exact.title,signal);article=full?.title===exact.title?full:exact;if(!full || full.title!==exact.title) errors.push('تعذرت قراءة مقدمة المقالة المطابقة');}catch{if(signal.aborted)throw new DOMException('Cancelled','AbortError');article=exact;errors.push('تعذرت قراءة مقدمة المقالة');}}
      else if(wiki.value.results.length) errors.push('لم توجد مقالة مطابقة للاسم تماماً');
    } else errors.push('تعذر بحث ويكيبيديا');
    if(images.status==='rejected')errors.push('تعذر بحث الصور');
    results[i]={label,article,images:images.status==='fulfilled'?images.value.results:[],errors};
    onProgress?.(++done,unique.length);
  }}
  await Promise.all(Array.from({length:Math.min(2,unique.length)},()=>worker()));
  return results.filter((value):value is SemanticResearchResult=>!!value);
}
