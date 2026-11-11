import {textToCloudItems,regionsToCloudItems,MAX_CLOUD_OBJECTS,type CloudWorldItem} from './cloudWorld';
import {parseAssetRequests,normalizeAssetText} from './assetRequests';
import {createId} from '../../core/utils/id';
import {semanticRegions} from './semanticScene';

// Terrain and water are made by the application, not searched as isolated GLBs.
const scenery=/^(?:(?:a|an|the|a large|a small|large|small|big|beautiful|منظر|عالم|خريطة|خريطه|مشهد|في|وسط|من|على|مع|ال|و)\s+)*(?:ال)?(?:جبال|جبل|غابه|غابة|غابات|صحراء|وادي|واد|هضبه|هضبة|اخدود|بركان|فوهه|فوهة|جزيره|جزيرة|مزرعه|مزرعة|قريه|قرية|مدينه|مدينة|بحر|محيط|نهر|انهار|جدول|بحيره|بحيرة|ماء|مياه|واحه|واحة|ارض|مسطح|مستوي|تضاريس|سماء|forest|woodland|mountains?|hills?|desert|valley|plateau|canyon|volcano|crater|islands?|farms?|villages?|cities|city|rivers?|streams?|lakes?|sea|ocean|water|pond|oasis|terrain|flat|sky|landscape|world|scene|map)(?:\s|$)/iu;
const sceneryClasses=new Set([6,16,21,26,29,52,60,68,93,94,109,128]);

/** Explicit text objects plus conservative defaults for a forest. */
export function textWorldItems(description:string):CloudWorldItem[] {
  if(!description.trim())return [];
  const items:CloudWorldItem[]=[];
  for(const item of textToCloudItems(description,256)) {
    const requests=parseAssetRequests(item.prompt);
    if(scenery.test(normalizeAssetText(item.prompt)) && !requests?.length)continue;
    if(requests && requests.length>1) {
      // Known nouns can appear without conjunctions ("بيت شجرة صخرة").
      for(const request of requests)for(let n=0;n<request.count && items.length<=MAX_CLOUD_OBJECTS;n++) {
        const i=items.length,search=({boulder:'rock'} as Record<string,string>)[request.assetId] ?? request.assetId.replace(/-/g,' ');
        items.push({...item,id:createId('cloud'),prompt:search,search,x:(i%4-1.5)*6,z:(Math.floor(i/4)-1.5)*6});
      }
    } else items.push(item);
  }
  // A bare landscape is not a single model. A forest implies a few repeated trees.
  const norm=normalizeAssetText(description);
  const negativeTrees=/(?:بدون|دون|بلا|لا|without|no)\s+(?:ال)?(?:شجر|اشجار|trees?)/u.test(norm);
  if(!negativeTrees && /غاب|\b(?:forest|woodland)\b/u.test(norm) && !items.some(i=>/tree|pine|palm/.test(i.search??''))){
    for(let n=0;n<3;n++){const i=items.length;items.push({id:`forest-${i}`,prompt:'tree',search:'tree',x:(i%4-1.5)*6,z:(Math.floor(i/4)-1.5)*6,size:6,height:0});}
  }
  // Removing scenery must not consume the object limit or leave a final row outside the map.
  if(items.length<=MAX_CLOUD_OBJECTS && items.some(i=>Math.abs(i.x)>25||Math.abs(i.z)>25))items.forEach((item,i)=>{item.x=(i%4-1.5)*6;item.z=(Math.floor(i/4)-1.5)*6;});
  return items;
}

/** Image is only a rough segmentation, not recovery of hidden geometry. */
export function imageWorldParts(labels:Uint8Array):{items:CloudWorldItem[];terrainHints:string[];ignored:string[];truncated:number} {
  const detected=semanticRegions(labels,30,true);
  const terrainHints:string[]=[];
  if(detected.regions.some(r=>[16,68].includes(r.classId)))terrainHints.push('mountain');
  if(detected.regions.some(r=>r.classId===60))terrainHints.push('river');
  if(detected.regions.some(r=>[21,26,109,128].includes(r.classId)))terrainHints.push('lake');
  const regions=detected.regions.filter(r=>!sceneryClasses.has(r.classId));
  const items=regionsToCloudItems(regions).map((item,i)=>({...item,prompt:regions[i]!.label,search:regions[i]!.label}));
  return {items,terrainHints,ignored:detected.ignored,truncated:detected.truncated+Math.max(0,regions.length-MAX_CLOUD_OBJECTS)};
}
function key(item:CloudWorldItem):string {
  const word=(item.search??item.prompt).toLowerCase().replace(/^(?:a|an|the)\s+/,'');
  if(/tree|pine|palm|شجر|نخل/.test(word))return 'tree';
  if(/house|building|بيت|منزل/.test(word))return 'house';
  if(/rock|boulder|stone|صخر/.test(word))return 'rock';
  return word.replace(/s$/,'').trim();
}
/** Text count wins when the same category is also detected in the image. */
export function mergeWorldItems(text:CloudWorldItem[], image:CloudWorldItem[]):CloudWorldItem[] {
  const textKeys=new Set(text.map(key));
  return [...text,...image.filter(item=>!textKeys.has(key(item)))];
}
export function terrainDescription(text:string,hints:string[]):string {
  const normal=normalizeAssetText(text);
  const hasTerrain=/جبل|جبال|هضب|وادي|صحراء|غاب|جزير|اخدود|بركان|فوه|مسطح|مستوي|\bflat\b|mountain|hill|valley|desert|forest|island|plateau|canyon|volcano|crater/iu.test(normal);
  const hasWater=/نهر|بحر|بحير|مياه|ماء|واحه|river|water|lake|sea|ocean|pond|oasis/iu.test(normal);
  const extra=hints.filter(h=>h==='mountain'?!hasTerrain:!hasWater);
  return [text,...extra].filter(Boolean).join(' and ');
}
