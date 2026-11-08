import {useEffect,useRef,useState} from 'react';
import {MAX_GENERATED_DATA} from '../../../core/world-plan/generatedMesh';
import type {WorldObject,WorldPlan} from '../../../core/world-plan/schema';
import {cloudWorldShell,composeCloudWorld,MAX_CLOUD_OBJECTS,type CloudWorldItem} from '../../ai/cloudWorld';
import {findAndLoadOnline,type OnlineModel} from '../../ai/onlineModels';
import {useEditor} from '../store';

/** Search and apply a whole scene automatically; never apply an incomplete or stale batch. */
export function LibraryWorldComposer({initialItems,initialPlan,description,mode,canApply,onClose,onOpenStudio,onBusyChange,onBuilt}:{
  initialItems:CloudWorldItem[];initialPlan:WorldPlan;description:string;mode:'text'|'image'|'append';
  canApply?:()=>boolean;onClose:()=>void;onOpenStudio?:()=>void;onBusyChange?:(busy:boolean)=>void;onBuilt?:()=>void;
}) {
  const {state,dispatch}=useEditor();const latest=useRef(state.plan);latest.current=state.plan;
  const [items,setItems]=useState(initialItems),[busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[finished,setFinished]=useState(false);
  const [done,setDone]=useState<Record<string,{object:WorldObject;model:OnlineModel}>>({});
  const [warnings,setWarnings]=useState<string[]>([]);
  const ctrl=useRef<AbortController|null>(null),alive=useRef(true);
  const started=useRef(false);
  useEffect(()=>{
    alive.current=true;
    // Defer to avoid issuing duplicate requests during React StrictMode's test mount.
    const timer=window.setTimeout(()=>{if(!started.current && initialItems.every(i=>i.prompt.trim())){started.current=true;void run();}},0);
    return()=>{window.clearTimeout(timer);alive.current=false;ctrl.current?.abort();onBusyChange?.(false);};
  },[]);
  const changed=()=>latest.current!==initialPlan || (canApply && !canApply());
  const run=async()=>{
    if(busy||finished)return;
    if(!items.length||items.length>MAX_CLOUD_OBJECTS||items.some(i=>!i.prompt.trim()||i.prompt.length>200||![i.x,i.z,i.size,i.height].every(Number.isFinite)||Math.abs(i.x)>25||Math.abs(i.z)>25||i.size<.5||i.size>12||i.height<0||i.height>20)){setError('راجع أسماء العناصر ومواقعها. الحد 16 عنصراً.');return;}
    if(changed()){setError('تغيّر العالم أو الوصف؛ أغلق الخطة وأنشئ أخرى.');return;}
    const half=cloudWorldShell(initialPlan,mode,description).terrain.size/2;
    if(items.some(i=>Math.abs(i.x)+i.size/2>half-1||Math.abs(i.z)+i.size/2>half-1)){setError('الموقع أو الحجم يتجاوز حدود الأرض.');return;}
    const existing=mode==='append'?initialPlan.objects.reduce((sum,o)=>sum+(o.meta.generatedMesh?.data.length??0),0):0;
    const completed=items.reduce((sum,i)=>sum+(done[i.id]?.object.meta.generatedMesh?.data.length??0),0),missing=items.filter(i=>!done[i.id]).length;
    const budget=Math.min(Math.floor(MAX_GENERATED_DATA/MAX_CLOUD_OBJECTS),Math.floor((MAX_GENERATED_DATA-existing-completed)/Math.max(1,missing)));
    if(budget<1000 && missing){setError('لا توجد سعة كافية للمجسمات في العالم.');return;}
    const abort=new AbortController();ctrl.current=abort;const timer=window.setTimeout(()=>abort.abort(),600000);
    setBusy(true);onBusyChange?.(true);setError('');const complete={...done},cache=new Map<string,WorldObject>();
    for(const {model,object} of Object.values(complete))if((object.meta.generatedMesh?.data.length??Infinity)<=budget)cache.set(`${model.source}:${model.id}:${model.version}`,object);
    try {
      for(let index=0;index<items.length;index++){
        const item=items[index]!;if(complete[item.id])continue;
        if(changed())throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
        setStatus(`أبحث وأحمّل ${item.prompt} (${index+1}/${items.length})…`);
        const found=await findAndLoadOnline(item.prompt.trim(),abort.signal,budget,cache);
        if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
        complete[item.id]={object:found.object,model:found.model};
        if(alive.current){setDone({...complete});setWarnings(old=>[...new Set([...old,...found.warnings])]);}
      }
      if(changed())throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
      const plan=composeCloudWorld(initialPlan,items,items.map(i=>complete[i.id]!.object),mode,description);
      // Give repeated objects distinct names so they can be targeted later by name.
      const offset=mode==='append'?initialPlan.objects.length:0;
      const used=new Set([...plan.groups.map(g=>g.name.toLocaleLowerCase()),...plan.objects.slice(0,offset).map(o=>o.name.toLocaleLowerCase())]);
      for(const object of plan.objects.slice(offset)) {
        const base=object.name.slice(0,74); let name=object.name, n=2;
        while(used.has(name.toLocaleLowerCase())) name=`${base} ${n++}`;
        object.name=name;used.add(name.toLocaleLowerCase());
      }
      plan.description=`مجسمات جاهزة CC0 من 3DAssets.dev وGobkit: ${description}`.slice(0,500);
      if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
      dispatch({type:'replacePlan',plan});setFinished(true);onBuilt?.();
    }catch(e){if(alive.current)setError(abort.signal.aborted?'توقف الانتظار؛ لم تُطبّق الخريطة.':`${e instanceof Error?e.message:'تعذر التحميل.'} لم تُطبّق الخريطة؛ يمكنك تعديل الاسم والمحاولة ثانية.`);}
    finally{window.clearTimeout(timer);if(ctrl.current===abort)ctrl.current=null;if(alive.current){setBusy(false);setStatus('');onBusyChange?.(false);}}
  };
  return <section className="wiki-library" aria-label="خطة المجسمات الجاهزة" dir="rtl">
    <strong>بحث تلقائي عن مجسمات مجانية</strong>
    <p>يبحث الخادم في 3DAssets.dev وGobkit (أصول طبيعة ثابتة)، ويجرّب النتائج المتوافقة تلقائياً. CC0؛ المجسمات جاهزة وليست مولّدة. تُرسل أسماء العناصر للمصادر وقد يُطلب عنوان إنجليزي من ويكيبيديا، فلا تكتب بيانات خاصة.</p>
    <p>الموضع والتقسيم تقريبيان. لا تدعم الخامات المصوّرة أو الحركة؛ قد تُبسّط الأشكال، والنتائج قد لا تطابق الوصف. الحد 2 ميغابايت و10 آلاف مثلث لكل مجسم.</p>
    {items.map((item,index)=><div className="callout" key={item.id}><div>
      <label className="field"><span>اسم العنصر {index+1}</span><input aria-label={`اسم العنصر ${index+1}`} disabled={busy||finished} maxLength={200} value={item.prompt} onChange={e=>{const value=e.target.value;setItems(old=>old.map(i=>i.id===item.id?{...i,prompt:value}:i));setDone(old=>{const n={...old};delete n[item.id];return n;});setError('');}}/></label>
      {done[item.id] && <p>{done[item.id]!.model.title} · {done[item.id]!.model.source==='gobkit'?<a href="https://gobkit.com/api/free" target="_blank" rel="noreferrer">Gobkit</a>:<a href={`https://3dassets.dev/assets/${done[item.id]!.model.slug}`} target="_blank" rel="noreferrer">3DAssets.dev</a>} · CC0</p>}
    </div></div>)}
    {!finished && <button type="button" className="btn btn-primary" disabled={busy||!items.length} onClick={()=>void run()}>{Object.keys(done).length?'متابعة البحث والبناء':'بحث وبناء تلقائي'}</button>}
    {busy && <button type="button" className="btn btn-small" onClick={()=>ctrl.current?.abort()}>إيقاف الانتظار</button>}
    {status && <p role="status">{status}</p>}{warnings.length>0 && <p>تعذّر الاتصال بهذه المصادر: {warnings.join('، ')}. استُخدمت المصادر الأخرى المتاحة.</p>}{error && <p className="online-error" role="alert">{error}</p>}
    {finished && <><p role="status">أُضيفت {items.length} مجسمات جاهزة. يمكنك التراجع بـ Undo أو استبدال مجسم بالاسم من التعديل.</p>{onOpenStudio && <button type="button" className="btn btn-primary" onClick={onOpenStudio}>فتح العالم في المحرر ←</button>}</>}
    <button type="button" className="btn btn-small" disabled={busy} onClick={onClose}>إغلاق خطة المجسمات</button>
  </section>;
}
