import { ASSET_LIBRARY } from '../../core/assets/catalog';
import { createEmptyWorldPlan, createTransform } from '../../core/world-plan/factory';
import { createMeta } from '../../core/world-plan/objectMeta';
import { MAX_PHOTO_CELLS, photoModelSchema, validateWorldPlan, type PhotoModel, type WorldObject, type WorldPlan } from '../../core/world-plan/schema';
import { photoModelDimensions } from '../../core/scene/photoModel';
import { createId } from '../../core/utils/id';
import { mulberry32 } from '../../core/generation/rng';
import type { TinyImage } from './photoModel';

export const SCENE_TYPES = [
  { id:'broadleaf', label:'شجرة' }, { id:'boulder', label:'صخرة' }, { id:'house', label:'بيت' },
  { id:'tower', label:'برج' }, { id:'bridge', label:'جسر' }, { id:'wood-fence', label:'سياج' },
  { id:'sphere', label:'كرة' }, { id:'box', label:'صندوق' }, { id:'water', label:'ماء زخرفي مسطح' },
  { id:'photo', label:'عنصر محدد من الصورة' },
] as const;
export type SceneType = typeof SCENE_TYPES[number]['id'];
export interface SceneMark { id:string; name:string; type:SceneType; x:number; y:number; depth:number; size:number; height?:number; thickness?:number; model?:PhotoModel }
export interface ColorRegion { x:number; y:number; area:number; color:string }
/** Local connected colour regions, NOT semantic object detection. */
export function colorRegions(image:TinyImage): ColorRegion[] {
  const {width:w,height:h,rgba}=image;
  if (w<2 || h<2 || w>24 || h>24 || rgba.length!==w*h*4) throw new Error('بيانات الصورة غير صالحة.');
  const visited=new Uint8Array(w*h), regions:ColorRegion[]=[];
  for(let start=0;start<w*h;start++) {
    if(visited[start] || rgba[start*4+3]!<128) continue;
    const seed=[rgba[start*4]!,rgba[start*4+1]!,rgba[start*4+2]!], queue=[start]; visited[start]=1;
    let sx=0,sy=0,r=0,g=0,b=0;
    for(let k=0;k<queue.length;k++) {
      const i=queue[k]!,x=i%w,y=Math.floor(i/w); sx+=x+.5; sy+=y+.5;
      r+=rgba[i*4]!;g+=rgba[i*4+1]!;b+=rgba[i*4+2]!;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const xx=x+dx,yy=y+dy; if(xx<0||yy<0||xx>=w||yy>=h) continue;
        const j=yy*w+xx; if(visited[j] || rgba[j*4+3]!<128) continue;
        if(Math.hypot(rgba[j*4]!-seed[0]!,rgba[j*4+1]!-seed[1]!,rgba[j*4+2]!-seed[2]!)>70) continue;
        visited[j]=1; queue.push(j);
      }
    }
    if(queue.length>=6) regions.push({x:sx/queue.length/w,y:sy/queue.length/h,area:queue.length,color:'#'+[r,g,b].map(v=>Math.round(v/queue.length).toString(16).padStart(2,'0')).join('')});
  }
  return regions.sort((a,b)=>b.area-a.area).slice(0,12);
}
/** Turn only the user's confirmed annotations into independent, editable 3D nodes. */
export function createImageScene(name:string, marks:SceneMark[], seed:number):WorldPlan {
  if (!marks.length || marks.length>30) throw new Error('حدد من عنصر واحد إلى 30 عنصراً قبل الإنشاء.');
  let cells=0;
  const plan=createEmptyWorldPlan({ name:name.trim().slice(0,80) || 'مشهد مستوحى من الصورة', seed });
  plan.terrain={...plan.terrain,style:'flat',heightScale:0,size:64,waterLevel:null};
  const objects:WorldObject[]=[];
  for(let i=0;i<marks.length;i++) {
    const mark=marks[i]!;
    if (!SCENE_TYPES.some((entry)=>entry.id===mark.type) || !mark.name.trim() || ![mark.x,mark.y,mark.depth,mark.size,mark.height ?? 0,mark.thickness ?? 1].every(Number.isFinite) || (mark.thickness ?? 1)<.25 || (mark.thickness ?? 1)>4 || (mark.height ?? 0)<0 || (mark.height ?? 0)>20 || mark.x<0||mark.x>1||mark.y<0||mark.y>1||mark.depth<0||mark.depth>1||mark.size<.25||mark.size>3) throw new Error('بيانات عنصر غير صالحة؛ لم يُنشأ المشهد.');
    const position:[number,number,number]=[(mark.x-.5)*28,mark.height ?? 0,14-mark.depth*28];
    let object:WorldObject;
    if(mark.type==='photo') {
      const model=photoModelSchema.parse(mark.model);
      if (model.mode === 'full-image-slab') throw new Error('حدد عنصراً واحداً بدلاً من الصورة كاملة.');
      cells+=model.cells.length;
      if(cells>MAX_PHOTO_CELLS) throw new Error('مجسمات الصورة تتجاوز سعة المشروع على الهاتف.');
      object={id:createId('obj'),name:mark.name.trim().slice(0,80),parentId:null,transform:createTransform(position),visible:true,locked:false,kind:'primitive',primitive:'photo-model',color:'#ffffff',meta:{...createMeta({category:'prop',geometry:'primitive.photo-model',dimensions:photoModelDimensions(model),status:'edited'}),photoModel:model}};
    } else {
      const asset=ASSET_LIBRARY.find((entry)=>entry.id===(mark.type==='water'?'plane':mark.type));
      if(!asset) throw new Error('هذا النوع غير متوفر في المكتبة.');
      object=asset.create(mulberry32((seed+i+1)>>>0),position);
      if(mark.type==='water' && object.kind==='primitive') object={...object,color:'#439dab',name:'ماء زخرفي مسطح'};
      object={...object,name:mark.name.trim().slice(0,80),meta:{...object.meta,status:'edited'}};
    }
    // Water is an explicitly labelled decorative slab, not a simulated lake.
    const spread=mark.type==='water'?3:1;
    object={...object,transform:{...object.transform,scale:[mark.size*spread,mark.type==='water'?1:mark.size,mark.size*spread*(mark.type==='photo'?(mark.thickness ?? 1):1)]}};
    objects.push(object);
  }
  const result={...plan,objects};
  if(!validateWorldPlan(result).success) throw new Error('تعذّر التحقق من المشهد؛ لم يُطبّق.');
  return result;
}
