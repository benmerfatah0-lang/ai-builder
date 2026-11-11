import { useEffect, useRef, useState } from 'react';
import { createId } from '../../../core/utils/id';
import { MAX_GENERATED_DATA } from '../../../core/world-plan/generatedMesh';
import type { WorldObject, WorldPlan } from '../../../core/world-plan/schema';
import { cloudWorldShell, composeCloudWorld, generateCloudObject, MAX_CLOUD_OBJECTS, type CloudWorldItem } from '../../ai/cloudWorld';
import { useEditor } from '../store';

/** Review, generate sequentially, retain completed objects on failure and commit atomically. */
export function CloudWorldComposer({initialItems,initialPlan,description,mode,canApply,onBuilt,onOpenStudio,onClose,onBusyChange}:{
  initialItems:CloudWorldItem[]; initialPlan:WorldPlan; description:string; mode:'text'|'image'|'append';
  canApply?:()=>boolean; onBuilt?:()=>void; onOpenStudio?:()=>void; onClose:()=>void; onBusyChange?:(busy:boolean)=>void;
}) {
  const {state,dispatch}=useEditor(); const latest=useRef(state.plan);latest.current=state.plan;
  const [items,setItems]=useState(initialItems), [done,setDone]=useState<Map<string,WorldObject>>(new Map());
  const [busy,setBusy]=useState(false), [status,setStatus]=useState(''), [error,setError]=useState(''), [finished,setFinished]=useState(false);
  const controller=useRef<AbortController|null>(null), alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();onBusyChange?.(false);};},[]);
  const change=(id:string,patch:Partial<CloudWorldItem>)=>{
    setItems(old=>old.map(item=>item.id===id?{...item,...patch}:item));
    if(patch.prompt!==undefined) setDone(old=>{const next=new Map(old);next.delete(id);return next;});
    setError('');
  };
  const remove=(id:string)=>{setItems(old=>old.filter(item=>item.id!==id));setDone(old=>{const next=new Map(old);next.delete(id);return next;});};
  const run=async()=>{
    if(busy||finished)return;
    if(!items.length || items.length>MAX_CLOUD_OBJECTS || items.some(item=>!item.prompt.trim() || item.prompt.length>200 || ![item.x,item.z,item.size,item.height].every(Number.isFinite) || Math.abs(item.x)>25 || Math.abs(item.z)>25 || item.size<.5 || item.size>12 || item.height<0 || item.height>20)) {setError(`راجع العناصر؛ الحد ${MAX_CLOUD_OBJECTS} عناصر، والموقع بين -25 و25 والحجم بين 0.5 و12 والارتفاع بين 0 و20.`);return;}
    if(latest.current!==initialPlan || (canApply && !canApply())){setError('تغيّر العالم أو الوصف؛ أغلق الخطة وأنشئ أخرى.');return;}
    const half=cloudWorldShell(initialPlan,mode,description).terrain.size/2;
    if(items.some(item=>Math.abs(item.x)+item.size/2>half-1 || Math.abs(item.z)+item.size/2>half-1)){setError('الموقع أو حجم العنصر يتجاوز حدود الأرض؛ صغّره أو انقله إلى الداخل.');return;}
    const existing=mode==='append' ? initialPlan.objects.reduce((sum,obj)=>sum+(obj.meta.generatedMesh?.data.length??0),0) : 0;
    const completed=items.reduce((sum,item)=>sum+(done.get(item.id)?.meta.generatedMesh?.data.length??0),0);
    const missing=items.filter(item=>!done.has(item.id)).length;
    const budget=Math.floor((MAX_GENERATED_DATA-existing-completed)/Math.max(1,missing));
    if(budget<1000 && missing){setError('لا توجد سعة كافية للمجسمات الجديدة؛ احذف مجسمات من العالم أولاً.');return;}
    const abort=new AbortController();controller.current=abort;const timer=window.setTimeout(()=>abort.abort(),3_600_000);
    const generated=new Map(done);setBusy(true);onBusyChange?.(true);setError('');
    try {
      for(let i=0;i<items.length;i++){
        if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
        const item=items[i]!;if(generated.has(item.id))continue;
        if(latest.current!==initialPlan || (canApply && !canApply()))throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
        setStatus(`أولّد العنصر ${i+1} من ${items.length}: ${item.prompt}`);
        const object=await generateCloudObject(item,abort.signal,Math.min(budget,Math.floor(MAX_GENERATED_DATA/MAX_CLOUD_OBJECTS)));
        if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
        generated.set(item.id,object);if(alive.current)setDone(new Map(generated));
      }
      if(latest.current!==initialPlan || (canApply && !canApply()))throw new Error('تغيّر العالم أو الوصف؛ لم يُطبّق شيء.');
      const plan=composeCloudWorld(initialPlan,items,items.map(item=>generated.get(item.id)!),mode,description);
      if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
      dispatch({type:'replacePlan',plan});setFinished(true);setStatus('اكتملت العناصر وطُبّق العالم دفعة واحدة. يمكن التراجع عنه.');onBuilt?.();
    } catch(reason) {
      if(alive.current)setError(abort.signal.aborted?'توقف الانتظار؛ احتُفظ بما اكتمل داخل هذه الصفحة فقط، وقد يستمر طلب الخدمة الجاري.':`${reason instanceof Error?reason.message:'تعذّر التوليد.'} احتُفظ بالعناصر المكتملة هنا؛ يمكنك إعادة المحاولة لاحقاً.`);
    } finally {window.clearTimeout(timer);if(controller.current===abort)controller.current=null;if(alive.current){setBusy(false);onBusyChange?.(false);setStatus('');}}
  };
  return <section className="wiki-library" dir="rtl" aria-label="خطة العالم السحابي">
    <strong>راجع العناصر والمواقع قبل التوليد</strong>
    <p>يرسل وصف كل عنصر إلى Shap-E بالتتابع، لا الصورة نفسها. الخدمة مجانية بحصة صغيرة وقد تتوقف؛ يحتفظ بالمكتمل أثناء بقاء هذه الصفحة مفتوحة. لا تستخدم بيانات خاصة.</p>
    <p>الأشكال مختصرة لتناسب الهاتف، والمواضع والأحجام تقديرية. المحور X وZ يحددان الموضع والارتفاع عن الأرض اختياري؛ قد تتداخل العناصر، ويمكن تعديلها بعد الإنشاء.</p>
    {items.map((item,i)=><div key={item.id} className="callout"><div>
      <strong>العنصر {i+1} {done.has(item.id)?'· جاهز':'· لم يُولّد'}</strong>
      <label className="field"><span>الوصف</span><input aria-label={`وصف العنصر ${i+1}`} disabled={busy||finished} maxLength={200} value={item.prompt} onChange={event=>change(item.id,{prompt:event.target.value})}/></label>
      <div className="field-grid">{(['x','z','size','height'] as const).map(key=><label className="field" key={key}><span>{key==='size'?'الحجم':key==='height'?'الارتفاع':key.toUpperCase()}</span><input aria-label={`${key==='size'?'حجم':key==='height'?'ارتفاع':key.toUpperCase()} العنصر ${i+1}`} type="number" min={key==='size'?0.5:key==='height'?0:-25} max={key==='size'?12:key==='height'?20:25} step="0.5" disabled={busy||finished} value={item[key]} onChange={event=>change(item.id,{[key]:event.target.value===''?NaN:Number(event.target.value)})}/></label>)}</div>
      <button type="button" className="btn btn-small" disabled={busy||finished} onClick={()=>remove(item.id)}>حذف العنصر {i+1}</button>
    </div></div>)}
    {items.length>MAX_CLOUD_OBJECTS && <p role="alert">تجاوزت الخطة {MAX_CLOUD_OBJECTS} عنصراً؛ احذف بعض العناصر قبل التوليد.</p>}
    {!finished && <button type="button" className="btn btn-small" disabled={busy || items.length>=MAX_CLOUD_OBJECTS} onClick={()=>setItems(old=>[...old,{id:createId('cloud'),prompt:'',x:0,z:0,size:5,height:0}])}>إضافة وصف عنصر</button>}
    {!finished && <button type="button" className="btn btn-primary" disabled={busy||!items.length||items.length>MAX_CLOUD_OBJECTS} onClick={()=>void run()}>{done.size?'متابعة توليد العالم':'توليد العناصر وبناء العالم'}</button>}
    {busy && <button type="button" className="btn btn-small" onClick={()=>controller.current?.abort()}>إيقاف الانتظار للعالم</button>}
    {status && <p role="status">{status}</p>}{error && <p className="online-error" role="alert">{error}</p>}
    {finished && <><p role="status">بُنيت {items.length} مجسمات منفصلة. استخدم Undo للعودة إلى العالم السابق.</p>{onOpenStudio && <button type="button" className="btn btn-primary" onClick={onOpenStudio}>فتح العالم في المحرر ←</button>}</>}
    <button type="button" className="btn btn-small" disabled={busy} onClick={onClose}>إغلاق خطة العالم</button>
  </section>;
}
