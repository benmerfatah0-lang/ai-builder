import {useEffect,useRef,useState} from 'react';
import {createId} from '../../../core/utils/id';
import {MAX_GENERATED_DATA} from '../../../core/world-plan/generatedMesh';
import type {WorldObject,WorldPlan} from '../../../core/world-plan/schema';
import {cloudWorldShell,composeCloudWorld,MAX_CLOUD_OBJECTS,type CloudWorldItem} from '../../ai/cloudWorld';
import {loadOnlineModel,searchOnlineModels,type OnlineModel} from '../../ai/onlineModels';
import {useEditor} from '../store';

/** Select CC0 assets explicitly; build atomically only when every item has a match. */
export function LibraryWorldComposer({initialItems,initialPlan,description,mode,canApply,onClose,onOpenStudio,onBusyChange,onBuilt}:{
  initialItems:CloudWorldItem[];initialPlan:WorldPlan;description:string;mode:'text'|'image'|'append';
  canApply?:()=>boolean;onClose:()=>void;onOpenStudio?:()=>void;onBusyChange?:(busy:boolean)=>void;onBuilt?:()=>void;
}) {
  const {state,dispatch}=useEditor();const latest=useRef(state.plan);latest.current=state.plan;
  const [items,setItems]=useState(initialItems),[results,setResults]=useState<Record<string,OnlineModel[]>>({}),[selected,setSelected]=useState<Record<string,OnlineModel>>({});
  const [busy,setBusy]=useState(false),[status,setStatus]=useState(''),[error,setError]=useState(''),[finished,setFinished]=useState(false);
  const [done,setDone]=useState<Record<string,WorldObject>>({});
  const ctrl=useRef<AbortController|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;ctrl.current?.abort();onBusyChange?.(false);};},[]);
  const changed=()=>latest.current!==initialPlan || (canApply && !canApply());
  const change=(id:string,patch:Partial<CloudWorldItem>)=>{
    setItems(old=>old.map(item=>item.id===id?{...item,...patch}:item));
    if(patch.prompt!==undefined){setResults(old=>{const n={...old};delete n[id];return n;});setSelected(old=>{const n={...old};delete n[id];return n;});setDone(old=>{const n={...old};delete n[id];return n;});}
    setError('');
  };
  const remove=(id:string)=>{setItems(old=>old.filter(item=>item.id!==id));setSelected(old=>{const n={...old};delete n[id];return n;});setDone(old=>{const n={...old};delete n[id];return n;});};
  const search=async(item:CloudWorldItem)=>{
    if(busy||!item.prompt.trim()||item.prompt.length>200)return;
    const abort=new AbortController();ctrl.current=abort;setBusy(true);onBusyChange?.(true);setError('');setStatus(`أبحث عن ${item.prompt}…`);
    try {const found=await searchOnlineModels(item.prompt.trim(),abort.signal);if(!alive.current||abort.signal.aborted)return;setResults(old=>({...old,[item.id]:found}));if(!found.length)setError('لم أجد نتيجة متوافقة؛ جرّب كلمة إنجليزية أخرى.');}
    catch(e){if(alive.current)setError(abort.signal.aborted?'توقف البحث.':e instanceof Error?e.message:'تعذر البحث.');}
    finally{if(ctrl.current===abort)ctrl.current=null;if(alive.current){setBusy(false);setStatus('');onBusyChange?.(false);}}
  };
  const choose=(id:string,model:OnlineModel)=>{setSelected(old=>({...old,[id]:model}));setDone(old=>{const n={...old};delete n[id];return n;});setError('');};
  const run=async()=>{
    if(busy||finished)return;
    if(!items.length||items.length>MAX_CLOUD_OBJECTS||items.some(i=>!i.prompt.trim()||!selected[i.id]||![i.x,i.z,i.size,i.height].every(Number.isFinite)||Math.abs(i.x)>25||Math.abs(i.z)>25||i.size<.5||i.size>12||i.height<0||i.height>20)){setError('اختر مجسماً لكل عنصر، وراجع المواقع والأحجام. الحد 16 عنصراً.');return;}
    if(changed()){setError('تغيّر العالم أو الوصف؛ أغلق الخطة وأنشئ أخرى.');return;}
    const half=cloudWorldShell(initialPlan,mode,description).terrain.size/2;
    if(items.some(i=>Math.abs(i.x)+i.size/2>half-1||Math.abs(i.z)+i.size/2>half-1)){setError('الموقع أو الحجم يتجاوز حدود الأرض.');return;}
    const existing=mode==='append'?initialPlan.objects.reduce((sum,o)=>sum+(o.meta.generatedMesh?.data.length??0),0):0;
    const completed=items.reduce((sum,i)=>sum+(done[i.id]?.meta.generatedMesh?.data.length??0),0);
    const missing=items.filter(i=>!done[i.id]).length;
    const budget=Math.min(Math.floor(MAX_GENERATED_DATA/MAX_CLOUD_OBJECTS),Math.floor((MAX_GENERATED_DATA-existing-completed)/Math.max(1,missing)));
    if(budget<1000 && missing){setError('لا توجد سعة كافية للمجسمات في العالم.');return;}
    const abort=new AbortController();ctrl.current=abort;const timer=window.setTimeout(()=>abort.abort(),600000);
    setBusy(true);onBusyChange?.(true);setError('');const completedModels={...done};
    const cache=new Map<string,WorldObject>();
    for(const item of items){const object=completedModels[item.id], model=selected[item.id];if(object && model && (object.meta.generatedMesh?.data.length??Infinity)<=budget)cache.set(`${model.id}:${model.version}`,object);}
    try {
      for(let index=0;index<items.length;index++){
        const item=items[index]!;if(completedModels[item.id])continue;
        if(changed())throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
        setStatus(`أحمّل العنصر ${index+1} من ${items.length}…`);
        const model=selected[item.id]!, key=`${model.id}:${model.version}`;
        const object=cache.get(key) ?? await loadOnlineModel(model,abort.signal,budget);
        cache.set(key,object);
        if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
        completedModels[item.id]=object;if(alive.current)setDone({...completedModels});
      }
      if(changed())throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
      const plan=composeCloudWorld(initialPlan,items,items.map(i=>completedModels[i.id]!),mode,description);
      plan.description=`مجسمات جاهزة من 3DAssets.dev (CC0): ${description}`.slice(0,500);
      if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
      dispatch({type:'replacePlan',plan});setFinished(true);onBuilt?.();
    }catch(e){if(alive.current)setError(abort.signal.aborted?'توقف الانتظار؛ احتُفظ بالمجسمات المكتملة في هذه الصفحة.':`${e instanceof Error?e.message:'تعذر التحميل.'} احتُفظ بالمكتمل في الصفحة؛ يمكنك المحاولة مجدداً.`);}
    finally{window.clearTimeout(timer);if(ctrl.current===abort)ctrl.current=null;if(alive.current){setBusy(false);setStatus('');onBusyChange?.(false);}}
  };
  return <section className="wiki-library" aria-label="خطة المجسمات الجاهزة" dir="rtl">
    <strong>مجسمات جاهزة مجانية من 3DAssets.dev</strong>
    <p>ابحث واختر لكل عنصر مجسماً، ثم أضفها للخريطة دفعة واحدة. البحث يرسل كلمة البحث للموقع؛ لا ترسل معلومات خاصة. الإنجليزية تعطي نتائج أفضل. المصدر يصف الملفات برخصة CC0؛ قد تنفد الخدمة أو تتغير حدودها.</p>
    <p>لتناسب الهاتف، تظهر نتائج دون خامات صور أو رسوم متحركة، وحتى 10 آلاف مثلث. قد نضغط الشكل والألوان بعد التنزيل. المواضع تقديرية، والنتائج ليست مجسمات مولّدة من وصفك.</p>
    {items.map((item,index)=><div className="callout" key={item.id}><div>
      <strong>العنصر {index+1}{selected[item.id]?` · ${selected[item.id]!.title}`:''}{done[item.id]?' · حُمّل':''}</strong>
      <label className="field"><span>كلمة البحث</span><input aria-label={`بحث العنصر ${index+1}`} disabled={busy||finished} maxLength={200} value={item.prompt} onChange={e=>change(item.id,{prompt:e.target.value})}/></label>
      <div className="field-grid">{(['x','z','size','height'] as const).map(key=><label className="field" key={key}><span>{key==='size'?'الحجم':key==='height'?'الارتفاع':key.toUpperCase()}</span><input aria-label={`${key==='size'?'حجم':key==='height'?'ارتفاع':key.toUpperCase()} العنصر ${index+1}`} type="number" step="0.5" disabled={busy||finished} value={item[key]} onChange={e=>change(item.id,{[key]:e.target.value===''?NaN:Number(e.target.value)})}/></label>)}</div>
      {!finished && <><button type="button" className="btn btn-small" disabled={busy||!item.prompt.trim()} onClick={()=>void search(item)}>بحث عن العنصر {index+1}</button> <button type="button" className="btn btn-small" disabled={busy} onClick={()=>remove(item.id)}>حذف العنصر {index+1}</button></>}
      {results[item.id]?.map(model=><div key={`${model.id}-${model.version}`} className="callout"><div>
        <img loading="lazy" alt={`معاينة ${model.title}`} src={`https://cdn.3dassets.dev/assets/${model.id}/v${model.version}/thumb.webp`} style={{width:96,height:96,objectFit:'contain'}} />
        <p>{model.title} · {model.triangles} مثلث · CC0</p>
        <a href={`https://3dassets.dev/assets/${model.slug}`} target="_blank" rel="noopener noreferrer">المصدر والرخصة ↗</a>{' '}
        <button type="button" className="btn btn-small" disabled={busy||finished} onClick={()=>choose(item.id,model)}>{selected[item.id]?.id===model.id&&selected[item.id]?.version===model.version?'تم الاختيار':'اختيار هذا المجسم'}</button>
      </div></div>)}
    </div></div>)}
    {!finished && <button type="button" className="btn btn-small" disabled={busy||items.length>=MAX_CLOUD_OBJECTS} onClick={()=>setItems(old=>[...old,{id:createId('model'),prompt:'',x:0,z:0,size:5,height:0}])}>إضافة عنصر جاهز</button>}
    {!finished && <button type="button" className="btn btn-primary" disabled={busy||!items.length||items.length>MAX_CLOUD_OBJECTS} onClick={()=>void run()}>{Object.keys(done).length?'متابعة تحميل المجسمات':'تحميل المجسمات وبناء الخريطة'}</button>}
    {busy && <button type="button" className="btn btn-small" onClick={()=>ctrl.current?.abort()}>إيقاف الانتظار</button>}
    {status && <p role="status">{status}</p>}{error && <p className="online-error" role="alert">{error}</p>}
    {finished && <><p role="status">أُضيفت {items.length} مجسمات جاهزة. يمكنك التراجع بـ Undo.</p>{onOpenStudio && <button type="button" className="btn btn-primary" onClick={onOpenStudio}>فتح العالم في المحرر ←</button>}</>}
    <button type="button" className="btn btn-small" disabled={busy} onClick={onClose}>إغلاق خطة المجسمات</button>
  </section>;
}
