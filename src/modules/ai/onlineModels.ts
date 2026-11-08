import { z } from 'zod';
import type { WorldObject } from '../../core/world-plan/schema';
import { generatedGlbToWorld } from './generatedMesh';
import { compactCloudMesh } from './cloudWorld';
import { englishWikiTitle } from './onlineInterpreter';

const resultSchema=z.discriminatedUnion('source',[
  z.object({source:z.literal('3dassets'),id:z.string().regex(/^\d{1,12}$/),version:z.string().regex(/^\d{1,5}$/),slug:z.string().regex(/^[a-z0-9-]{1,160}$/),title:z.string().min(1).max(120),triangles:z.number().int().min(1).max(10000)}).strict(),
  z.object({source:z.literal('gobkit'),id:z.string().regex(/^[A-Za-z0-9]{1,80}$/),version:z.literal('1'),slug:z.literal('nature-kit'),title:z.string().min(1).max(120),triangles:z.null()}).strict(),
]);
export type OnlineModel = z.infer<typeof resultSchema>;
export interface OnlineSearch {results:OnlineModel[]; warnings:string[]}

export async function searchOnlineModels(query:string,signal:AbortSignal):Promise<OnlineSearch> {
  // Wikipedia language links help with exact Arabic nouns; it is not a general translator.
  let search=query;
  if (/[\u0600-\u06ff]/u.test(query)) {
    try {search=(await englishWikiTitle(query,signal)) || query;} catch(e) {if(signal.aborted)throw e;}
  }
  const response=await fetch('/api/asset-library/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:search}),signal});
  if(!response.ok) throw new Error('تعذر البحث في المصادر المجانية؛ تحقق من الاتصال أو حاول لاحقاً.');
  const result=z.object({results:z.array(resultSchema).max(12),warnings:z.array(z.enum(['3DAssets.dev','Gobkit'])).max(2)}).strict().safeParse(await response.json());
  if(!result.success)throw new Error('استجابة المكتبة غير صالحة؛ حدّث خادم الهاتف.');
  return result.data;
}

export async function findAndLoadOnline(query:string,signal:AbortSignal,maxBytes:number,cache=new Map<string,WorldObject>()):Promise<{object:WorldObject;model:OnlineModel;warnings:string[]}> {
  const found=await searchOnlineModels(query,signal);
  for(const model of found.results) {
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    try {
      const key=`${model.source}:${model.id}:${model.version}`;
      const object=cache.get(key) ?? await loadOnlineModel(model,signal,maxBytes);
      cache.set(key,object);
      return {object,model,warnings:found.warnings};
    } catch(e) {if(signal.aborted)throw e;}
  }
  const unavailable=found.warnings.length ? ` مصادر تعذرت: ${found.warnings.join('، ')}.` : '';
  throw new Error(`لم أجد مجسماً متوافقاً مع الهاتف لـ «${query}». جرّب اسماً إنجليزياً آخر.${unavailable}`);
}

export async function loadOnlineModel(model:OnlineModel,signal:AbortSignal,maxBytes:number):Promise<WorldObject> {
  const response=await fetch('/api/asset-library/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:model.id,version:model.version,source:model.source}),signal});
  if(!response.ok)throw new Error(`تعذر تنزيل ${model.title}.`);
  const limit=2_000_000, length=Number(response.headers.get('Content-Length'));
  if(length>limit)throw new Error('ملف المجسم أكبر من الحد المسموح.');
  const reader=response.body?.getReader();let bytes:Uint8Array;
  if(reader){
    const chunks:Uint8Array[]=[];let total=0;
    try {for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit){await reader.cancel();throw new Error('ملف المجسم أكبر من الحد المسموح.');}chunks.push(value);}}
    finally{reader.releaseLock();}
    bytes=new Uint8Array(total);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  }else{bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>limit)throw new Error('ملف المجسم أكبر من الحد المسموح.');}
  const plan=await generatedGlbToWorld(bytes.buffer as ArrayBuffer,model.title,undefined,model.source==='gobkit'?'Gobkit':'3DAssets.dev');
  const object=plan.objects[0]!;
  if(!object.meta.generatedMesh || object.meta.generatedMesh.indices>30000)throw new Error('المجسم غير صالح أو يتجاوز 10000 مثلث.');
  return {...object,meta:{...object.meta,source:'library',generatedMesh:object.meta.generatedMesh.data.length<=maxBytes ? object.meta.generatedMesh : compactCloudMesh(object.meta.generatedMesh,maxBytes)}};
}
