import { createId } from '../../core/utils/id';
import { photoModelSchema, type LocalPhotoSource } from '../../core/world-plan/schema';
import type { ImageReference } from './imageReferences';
import { photoToModel } from './photoModel';
import { photoStyleForTopic } from './photoStyle';
import type { SceneMark, SceneType } from './imageScene';

/** ADE20K class order, matching the PP-MobileSeg-Base checkpoint. */
export const ADE_CLASSES = `wall|building|sky|floor|tree|ceiling|road|bed|windowpane|grass|cabinet|sidewalk|person|earth|door|table|mountain|plant|curtain|chair|car|water|painting|sofa|shelf|house|sea|mirror|rug|field|armchair|seat|fence|desk|rock|wardrobe|lamp|bathtub|railing|cushion|base|box|column|signboard|chest of drawers|counter|sand|sink|skyscraper|fireplace|refrigerator|grandstand|path|stairs|runway|case|pool table|pillow|screen door|stairway|river|bridge|bookcase|blind|coffee table|toilet|flower|book|hill|bench|countertop|stove|palm|kitchen island|computer|swivel chair|boat|bar|arcade machine|hovel|bus|towel|light|truck|tower|chandelier|awning|streetlight|booth|television receiver|airplane|dirt track|apparel|pole|land|bannister|escalator|ottoman|bottle|buffet|poster|stage|van|ship|fountain|conveyer belt|canopy|washer|plaything|swimming pool|stool|barrel|basket|waterfall|tent|bag|minibike|cradle|oven|ball|food|step|tank|trade name|microwave|pot|animal|bicycle|lake|dishwasher|screen|blanket|sculpture|hood|sconce|vase|traffic light|tray|ashcan|fan|pier|crt screen|plate|monitor|bulletin board|shower|radiator|glass|clock|flag`.split('|');
const BACKGROUND=new Set([2,3,5,6,9,11,13,16,29,46,52,53,68,93,94,121]);
const ASSETS:Record<number,SceneType>={15:'table',19:'chair',42:'column',43:'signpost',66:'flower',69:'bench',104:'fountain',111:'barrel',114:'tent',149:'flag',4:'broadleaf',25:'house',32:'wood-fence',34:'boulder',41:'box',61:'bridge',84:'tower',119:'sphere',21:'water',26:'water',60:'water',109:'water',128:'water'};
export interface SemanticRegion { classId:number; label:string; x:number; y:number; width:number; height:number; pixels:number[] }
/** Connected semantic areas are not individual instances: touching trees may merge. */
export function semanticRegions(labels:Uint8Array, maxRegions=30): {regions:SemanticRegion[]; ignored:string[]; truncated:number} {
  if(labels.length!==4096 || labels.some((value)=>value>=ADE_CLASSES.length)) throw new Error('نتيجة نموذج الرؤية غير صالحة.');
  const visited=new Uint8Array(4096), found:SemanticRegion[]=[], ignored=new Set<string>();
  for(let start=0;start<labels.length;start++){
    if(visited[start])continue; const id=labels[start]!;visited[start]=1;
    const queue=[start];let minX=63,minY=63,maxX=0,maxY=0;
    for(let i=0;i<queue.length;i++){
      const p=queue[i]!,x=p%64,y=Math.floor(p/64);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const){const xx=x+dx,yy=y+dy;if(xx<0||xx>=64||yy<0||yy>=64)continue;const n=yy*64+xx;if(!visited[n]&&labels[n]===id){visited[n]=1;queue.push(n);}}
    }
    if(queue.length<6)continue;
    if(BACKGROUND.has(id)){ignored.add(ADE_CLASSES[id]!);continue;}
    found.push({classId:id,label:ADE_CLASSES[id]!,x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1,pixels:queue});
  }
  found.sort((a,b)=>b.pixels.length-a.pixels.length);
  const limit=Math.max(1,Math.min(30,Math.floor(maxRegions)));
  return {regions:found.slice(0,limit),ignored:[...ignored],truncated:Math.max(0,found.length-limit)};
}
/** Create bounded coloured shapes from predicted class masks; no recovered hidden geometry. */
export function regionsToSceneMarks(regions:SemanticRegion[], source:HTMLImageElement, attribution:ImageReference|LocalPhotoSource, description=''):{marks:SceneMark[];failed:string[]} {
  const photoCount=regions.filter((r)=>!ASSETS[r.classId]).length;
  const maxSide=Math.max(6,Math.min(24,Math.floor(Math.sqrt(4608/Math.max(photoCount,1)))));
  const marks:SceneMark[]=[],failed:string[]=[];
  for(const region of regions){
    const type=ASSETS[region.classId]??'photo';
    const x=(region.x+region.width/2)/64,y=(region.y+region.height/2)/64;
    const size=Math.max(.25,Math.min(3,region.width/64*3+.25));
    const depth=Math.max(.05,Math.min(.95,1-y));
    try {
      let model;
      if(type==='photo'){
        const scale=maxSide/Math.max(region.width,region.height), width=Math.max(2,Math.round(region.width*scale)),height=Math.max(2,Math.round(region.height*scale));
        const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d',{willReadFrequently:true});
        if(!ctx)throw new Error('تعذّر قراءة الصورة.');
        ctx.drawImage(source,region.x*source.naturalWidth/64,region.y*source.naturalHeight/64,region.width*source.naturalWidth/64,region.height*source.naturalHeight/64,0,0,width,height);
        const rgba=new Uint8Array(ctx.getImageData(0,0,width,height).data), bitmap=new Uint8Array(4096),mask=new Uint8Array(width*height);
        for(const pixel of region.pixels)bitmap[pixel]=1;
        for(let py=0;py<height;py++)for(let px=0;px<width;px++){
          const xx=Math.min(63,region.x+Math.floor((px+.5)*region.width/width));
          const yy=Math.min(63,region.y+Math.floor((py+.5)*region.height/height));
          mask[py*width+px]=bitmap[yy*64+xx]!;
        }
        const style=photoStyleForTopic(description,region.label,1);
        const approximation=photoToModel({width,height,rgba},attribution,false,mask,style==='conflict'?'smooth':style);
        model=photoModelSchema.parse({...approximation,mode:'silhouette'});
      }
      marks.push({id:createId('mark'),name:region.label,type,x,y,depth,size,...(model?{model}:{})});
    } catch {failed.push(region.label);}
  }
  return {marks,failed};
}
