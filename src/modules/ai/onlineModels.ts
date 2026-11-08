import { z } from 'zod';
import type { WorldObject } from '../../core/world-plan/schema';
import { generatedGlbToWorld } from './generatedMesh';
import { compactCloudMesh } from './cloudWorld';

const resultSchema=z.object({
  id:z.string().regex(/^\d{1,12}$/), version:z.string().regex(/^\d{1,5}$/),
  slug:z.string().regex(/^[a-z0-9-]{1,160}$/), title:z.string().min(1).max(120),
  triangles:z.number().int().min(1).max(10000),
}).strict();
export type OnlineModel = z.infer<typeof resultSchema>;

export async function searchOnlineModels(query:string,signal:AbortSignal):Promise<OnlineModel[]> {
  const response=await fetch('/api/asset-library/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query}),signal});
  if(!response.ok) throw new Error('تعذر البحث في المكتبة المجانية؛ تحقق من الاتصال أو حاول لاحقاً.');
  const result=z.object({results:z.array(resultSchema).max(12)}).strict().safeParse(await response.json());
  if(!result.success)throw new Error('استجابة المكتبة غير صالحة.');
  return result.data.results;
}

export async function loadOnlineModel(model:OnlineModel,signal:AbortSignal,maxBytes:number):Promise<WorldObject> {
  const response=await fetch('/api/asset-library/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:model.id,version:model.version}),signal});
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
  const plan=await generatedGlbToWorld(bytes.buffer as ArrayBuffer,model.title,undefined,'3DAssets.dev');
  const object=plan.objects[0]!;
  if(!object.meta.generatedMesh)throw new Error('المجسم غير صالح.');
  return {...object,meta:{...object.meta,source:'library',generatedMesh:object.meta.generatedMesh.data.length<=maxBytes ? object.meta.generatedMesh : compactCloudMesh(object.meta.generatedMesh,maxBytes)}};
}
