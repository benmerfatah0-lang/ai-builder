import * as THREE from 'three';
import { createId } from '../../core/utils/id';
import { createTerrainSampler } from '../../core/generation/terrain';
import {makeTerrainRiver} from '../../core/generation/villageRiver';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { base64ToBytes, bytesToBase64, MAX_GENERATED_DATA, type GeneratedMeshData } from '../../core/world-plan/generatedMesh';
import { validateWorldPlan, type WorldObject, type WorldPlan } from '../../core/world-plan/schema';
import { interpretPromptLocally } from './promptInterpreter';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';
import { generatedGlbToWorld, requestGeneratedGlb } from './generatedMesh';
import { parseCountToken, normalizeAssetText, parseAssetRequests } from './assetRequests';
import type { SemanticRegion } from './semanticScene';
import type { InterpretOptions } from './types';

/** Shared free quota and phone memory make this an intentionally small, reviewable batch. */
export const MAX_CLOUD_OBJECTS = 16;
export interface CloudWorldItem { id:string; prompt:string; search?:string; x:number; z:number; size:number; height:number }

/** Very limited local segmentation of text, independent of the asset catalog. */
export function textToCloudItems(description:string, maxItems=MAX_CLOUD_OBJECTS+1):CloudWorldItem[] {
  let text=description.trim().slice(0,400);
  // Drop an introductory landscape phrase, but do not lose the subject of
  // descriptions like "a robot with a sword".
  const intro=/^(.*?)(?:\bwith\b|\bcontaining\b|يحتوي على|تحتوي على|فيها|فيه|يوجد بها|تضم|يضم)\s*/iu.exec(text);
  if(intro && /(?:عالم|مشهد|خريط|غاب|مدين|قري|صحراء|وادي|جزير|مزرع|world|scene|landscape|forest|village|city|desert|valley|island|farm)/iu.test(intro[1]!)) text=text.slice(intro[0].length);
  text=text.replace(/^(?:اصنع|أنشئ|انشئ|ابني|اعمل|صمم|create|build|make)\s+(?:لي\s+)?/iu,'');
  const tokens=text.split(/(\s+(?:to the left of|to the right of|in front of|left of|right of|behind|next to|near|بجانب|بجوار|قرب|أمام|امام|خلف|وراء|يمين|يسار)\s+|\s+(?:without|no|بدون|بلا|دون)\s+|\s+(?:and|with|containing|فيه|فيها|يحتوي على|تحتوي على)\s+|\s+و\s*(?=[\u0621-\u064a\u0660-\u06690-9])|[,،;؛\n]+)/iu);
  const items:CloudWorldItem[]=[]; let relation:string|undefined; let prior:CloudWorldItem|undefined; let negateNext=false;
  for(const token of tokens) {
    const part=token.trim();if(!part)continue;
    if(/^(?:without|no|بدون|بلا|دون)$/iu.test(part)) {negateNext=true;relation=undefined;continue;}
    if(/^(?:and|with|containing|فيه|فيها|يحتوي على|تحتوي على|و|[,،;؛]+)$/iu.test(part)) {relation=undefined;continue;}
    if(/^(?:to the left of|to the right of|in front of|left of|right of|behind|next to|near|بجانب|بجوار|قرب|أمام|امام|خلف|وراء|يمين|يسار)$/iu.test(part)) {relation=part;prior=items.at(-1);continue;}
    if(negateNext || /^(?:بدون|دون|بلا|لا|without|no)\s+/iu.test(part)) {negateNext=false;continue;}
    const normalized=normalizeAssetText(part);
    const match=/^(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|واحد|واحدة|اثنين|اثنان|ثلاثة|ثلاث|اربعة|اربع|خمسة|خمس)\s+(.+)$/u.exec(normalized);
    const recognized=parseAssetRequests(part);
    const many=/^(?:الكثير من|العديد من|عدد من|عدة|عده|many|several|lots of|a lot of)\s+(.+)$/u.exec(normalized);
    const bare=normalizeAssetText(part).replace(/^(?:ال)/u,'');
    const pluralUnknown=/^(?:سيارات|تنانين|طيور|سفن|زوارق|طائرات|روبوتات|cars|dragons|robots|airplanes|planes|boats|ships|bicycles|statues)$/u.test(bare);
    const count=match ? parseCountToken(match[1]) ?? 1 : many ? 3 : recognized?.length===1 ? recognized[0]!.count : pluralUnknown ? 3 : 1;
    const objectText=(match ? part.replace(/^\S+\s+/u,'') : many ? part.replace(/^(?:الكثير من|العديد من|عدد من|عدة|عده|many|several|lots of|a lot of)\s+/iu,'') : part).trim();
    const common=normalizeAssetText(objectText).replace(/^(?:ال)/u,'');
    const commonSearch=({سيارات:'car',سيارة:'car',سياره:'car',تنانين:'dragon',تنين:'dragon',روبوتات:'robot',روبوت:'robot',طيور:'bird',طائر:'bird',سفن:'ship',سفينة:'ship',زوارق:'boat',قارب:'boat',طائرات:'airplane',طائرة:'airplane'} as Record<string,string>)[common];
    for(let i=0;i<Math.min(count,MAX_CLOUD_OBJECTS+1) && items.length<Math.min(maxItems,256);i++) {
      const n=items.length;
      const item:CloudWorldItem={id:createId('cloud'),prompt:objectText.slice(0,200),search:recognized?.length===1 ? (({boulder:'rock',tree:'tree',house:'house'} as Record<string,string>)[recognized[0]!.assetId] ?? recognized[0]!.assetId.replace(/-/g,' ')) : commonSearch ?? objectText.replace(/^(?:a|an|the)\s+/i,''),x:(n%4-1.5)*6,z:(Math.floor(n/4)-1.5)*6,size:6,height:0};
      items.push(item);
      if(i===0 && relation && prior){
        if(/left|يسار/iu.test(relation)) {prior.x=item.x-8;prior.z=item.z;}
        else if(/right|يمين/iu.test(relation)) {prior.x=item.x+8;prior.z=item.z;}
        else if(/front|امام|أمام/iu.test(relation)) {prior.x=item.x;prior.z=item.z+8;}
        else if(/behind|خلف|وراء/iu.test(relation)) {prior.x=item.x;prior.z=item.z-8;}
        else {prior.x=item.x-7;prior.z=item.z;}
      }
    }
    relation=undefined;prior=undefined;
  }
  return items;
}

/** Predict approximate screen-plane position and size, not real 3D depth. */
export function regionsToCloudItems(regions:SemanticRegion[], pixels?:{width:number;height:number;rgba:Uint8Array}):CloudWorldItem[] {
  return regions.slice(0,MAX_CLOUD_OBJECTS).map(region=>{
    let r=0,g=0,b=0,n=0;
    if(pixels) for(const p of region.pixels){
      const x=Math.min(pixels.width-1,Math.floor((p%64+.5)*pixels.width/64));
      const y=Math.min(pixels.height-1,Math.floor((Math.floor(p/64)+.5)*pixels.height/64));
      const at=(y*pixels.width+x)*4;
      if(pixels.rgba[at+3]!<128)continue;
      r+=pixels.rgba[at]!;g+=pixels.rgba[at+1]!;b+=pixels.rgba[at+2]!;n++;
    }
    const colors:[string,number,number,number][]=[['red',190,55,50],['orange',210,125,55],['yellow',220,190,60],['green',70,140,70],['blue',60,120,180],['brown',120,85,55],['gray',120,120,120],['white',225,225,225],['black',35,35,35]];
    const color=n?colors.reduce((best,c)=>Math.hypot(r/n-c[1],g/n-c[2],b/n-c[3])<Math.hypot(r/n-best[1],g/n-best[2],b/n-best[3])?c:best)[0]:'';
    const horizontal=((region.x+region.width/2)/64-.5)*28;
    const towardCamera=((region.y+region.height/2)/64-.5)*28;
    return {id:createId('cloud'),prompt:`A single ${color ? `${color} `:''}${region.label}, isolated 3D object`,x:horizontal*.758+towardCamera*.653,z:-horizontal*.653+towardCamera*.758,size:THREE.MathUtils.clamp(region.width/64*24,1.5,10),height:['airplane','chandelier','light'].includes(region.label)?6:0};
  });
}

/** Cluster nearby vertices to keep multiple cloud-generated meshes within the phone budget. */
export function compactCloudMesh(mesh:GeneratedMeshData, maxBytes=Math.floor(MAX_GENERATED_DATA/MAX_CLOUD_OBJECTS)):GeneratedMeshData {
  const source=base64ToBytes(mesh.data), input=new DataView(source.buffer);
  const colorStart=mesh.vertices*12+mesh.indices*4;
  for(const resolution of [32,24,16,12,8]) {
    const groups=new Map<string,number>(); const sums:number[][]=[]; const remap=new Uint32Array(mesh.vertices);
    for(let i=0;i<mesh.vertices;i++) {
      const x=input.getFloat32(i*12,true),y=input.getFloat32(i*12+4,true),z=input.getFloat32(i*12+8,true);
      const key=`${Math.round(x*resolution/8)}:${Math.round(y*resolution/8)}:${Math.round(z*resolution/8)}`;
      let at=groups.get(key);
      if(at===undefined){at=sums.length;groups.set(key,at);sums.push([0,0,0,0,0,0,0]);}
      remap[i]=at;const sum=sums[at]!;
      sum[0]!+=x;sum[1]!+=y;sum[2]!+=z;sum[3]!+=source[colorStart+i*3]!;sum[4]!+=source[colorStart+i*3+1]!;sum[5]!+=source[colorStart+i*3+2]!;sum[6]!++;
    }
    const indexes:number[]=[];
    for(let i=0;i<mesh.indices;i+=3){
      const a=remap[input.getUint32(mesh.vertices*12+i*4,true)]!;
      const b=remap[input.getUint32(mesh.vertices*12+(i+1)*4,true)]!;
      const c=remap[input.getUint32(mesh.vertices*12+(i+2)*4,true)]!;
      if(a!==b&&b!==c&&a!==c) indexes.push(a,b,c);
    }
    if(!indexes.length || sums.length<3) continue;
    const bytes=new Uint8Array(sums.length*15+indexes.length*4);
    if(Math.ceil(bytes.length/3)*4>maxBytes)continue;
    const view=new DataView(bytes.buffer), colors=sums.length*12+indexes.length*4;
    sums.forEach((sum,i)=>{
      for(let k=0;k<3;k++){view.setFloat32(i*12+k*4,sum[k]!/sum[6]!,true);bytes[colors+i*3+k]=Math.round(sum[k+3]!/sum[6]!);}
    });
    indexes.forEach((value,i)=>view.setUint32(sums.length*12+i*4,value,true));
    return {vertices:sums.length,indices:indexes.length,data:bytesToBase64(bytes)};
  }
  throw new Error('تعذّر تصغير المجسم بما يناسب سعة الهاتف؛ لم يُطبّق العالم.');
}

export async function generateCloudObject(item:CloudWorldItem,signal:AbortSignal,maxBytes?:number):Promise<WorldObject> {
  const buffer=await requestGeneratedGlb(`A single 3D object: ${item.prompt}`,signal);
  const single=await generatedGlbToWorld(buffer,item.prompt);
  const object=single.objects[0]!;
  if(!object.meta.generatedMesh) throw new Error('المجسم الناتج غير صالح.');
  return {...object,meta:{...object.meta,generatedMesh:compactCloudMesh(object.meta.generatedMesh,maxBytes)}};
}

/** Only terrain/environment use the old local interpreter; all drawable objects are removed. */
export function cloudWorldShell(base:WorldPlan, mode:'text'|'image'|'append', description:string, options:InterpretOptions={}):WorldPlan {
  if(mode==='append') return base;
  if(mode==='text' || description.trim()) {
    const interpreted=interpretPromptLocally(description,{seed:base.seed,...options});
    const intent=interpreted.intent;
    const farmWater=intent.features?.farm ? !/(?:بدون|بلا|دون|without|no)\s+(?:ال)?(?:ماء|مياه|water)(?![\p{L}])/iu.test(description) && /(?:بحير|بحر|محيط|واحه|واحة|\blake\b|\bsea\b|\bocean\b|\bpond\b|\boasis\b)/iu.test(description.replace(/(?:بدون|بلا|دون|without|no)\s+(?:ال)?(?:بحير\S*|بحر|محيط|lake|sea|ocean|pond|oasis)/giu,'')) : intent.water;
    const report=generateWorldPlanWithReport({...intent,water:farmWater,features:undefined,assets:undefined,settlement:false,landscape:false,villageRiver:false,river:intent.river || intent.features?.river,counts:{trees:0,rocks:0,buildings:0,lanterns:0}});
    let shell={...report.plan,groups:[],objects:report.plan.objects.filter(o=>o.kind==='river').map(o=>({...o,parentId:null})),description:`Scene: ${description}`.slice(0,500)};
    if(shell.terrain.style==='flat' && farmWater){
      // Flat land remains flat outside the shallow depression instead of flooding the whole map.
      const radius=shell.terrain.size*.18;
      shell={...shell,terrain:{...shell.terrain,waterLevel:-.35,lakeBasin:{x:0,z:0,radius,depth:2}}};
    }
    // Rivers are local water geometry and must not disappear with the discarded props.
    if(intent.river || intent.features?.river){
      const river=makeTerrainRiver(shell,'z',0,-shell.terrain.size*.36,shell.terrain.size*.36);
      shell={...shell,objects:[{...river,parentId:null}]};
    }
    return shell;
  }
  const plan=createEmptyWorldPlan({name:'مشهد من صورة',seed:base.seed,description:'مشهد من صورة'});
  return {...plan,terrain:{...plan.terrain,style:'flat',size:64,heightScale:0,waterLevel:null}};
}

/** Assemble only successfully generated objects; caller must require a complete batch. */
export function composeCloudWorld(base:WorldPlan, items:CloudWorldItem[], objects:WorldObject[], mode:'text'|'image'|'append', description:string, shell?:WorldPlan):WorldPlan {
  if(items.length>MAX_CLOUD_OBJECTS || items.length!==objects.length)throw new Error('يجب اكتمال جميع المجسمات قبل تطبيق العالم.');
  const plan=shell ?? cloudWorldShell(base,mode,description);
  const terrain=createTerrainSampler(plan.terrain,plan.seed), half=plan.terrain.size/2;
  const occupied:{x:number;z:number;size:number}[]=[];
  const rivers=plan.objects.filter(o=>o.kind==='river');
  const nearRiver=(x:number,z:number,size:number)=>rivers.some(river=>{
    const pts=river.points;
    for(let j=1;j<pts.length;j++){
      const a=pts[j-1]!,b=pts[j]!,ax=a[0]+river.transform.position[0],az=a[2]+river.transform.position[2],bx=b[0]+river.transform.position[0],bz=b[2]+river.transform.position[2];
      const dx=bx-ax,dz=bz-az,denom=dx*dx+dz*dz,t=denom?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/denom)):0;
      if(Math.hypot(x-(ax+t*dx),z-(az+t*dz))<(river.width+size)/2+.4)return true;
    }
    return false;
  });
  const placed=objects.map((object,i)=>{
    const item=items[i]!;
    if(!item.prompt.trim() || ![item.x,item.z,item.size,item.height].every(Number.isFinite) || Math.abs(item.x)+item.size/2>half-1 || Math.abs(item.z)+item.size/2>half-1 || item.size<.5 || item.size>12 || item.height<0 || item.height>20 || !object.meta.generatedMesh || object.kind!=='primitive' || object.primitive!=='generated-mesh') throw new Error('بيانات العناصر أو المواقع غير صالحة؛ لم يُطبّق العالم.');
    // Prefer the requested position, but move to dry, unoccupied land away from rivers.
    let x=item.x,z=item.z,ground=terrain.heightAt(x,z),found=false;
    const fits=(xx:number,zz:number)=>Math.abs(xx)+item.size/2<=half-1 && Math.abs(zz)+item.size/2<=half-1 &&
      terrain.blockedAt?.(xx,zz)!==true &&
      (plan.terrain.waterLevel===null || terrain.heightAt(xx,zz)>=plan.terrain.waterLevel+.35) &&
      !nearRiver(xx,zz,item.size) && occupied.every(o=>Math.hypot(xx-o.x,zz-o.z)>=(item.size+o.size)/2);
    if(fits(x,z))found=true;
    for(let radius=3;radius<half*2 && !found;radius+=3)for(let a=0;a<16;a++){
      const xx=item.x+Math.cos(a*Math.PI/8)*radius,zz=item.z+Math.sin(a*Math.PI/8)*radius;
      if(fits(xx,zz)){x=xx;z=zz;ground=terrain.heightAt(x,z);found=true;break;}
    }
    if(!found)throw new Error('لم أجد مساحة جافة كافية للعنصر؛ لم يُطبّق العالم.');
    occupied.push({x,z,size:item.size});
    const y=ground+item.height, s=item.size/8;
    return {...object,id:createId('obj'),name:item.prompt.trim().slice(0,80),transform:{...object.transform,position:[x,y,z] as [number,number,number],scale:[s,s,s] as [number,number,number]}};
  });
  const result={...plan,objects:[...plan.objects,...placed]};
  if(!validateWorldPlan(result).success)throw new Error('تتجاوز المجسمات سعة المشروع؛ لم يُطبّق العالم.');
  return result;
}
