import {useEffect,useRef,useState} from 'react';
import {MAX_GENERATED_DATA} from '../../../core/world-plan/generatedMesh';
import {validateWorldPlan} from '../../../core/world-plan/schema';
import {findAndLoadOnline} from '../../ai/onlineModels';
import {useEditor} from '../store';

/** Replace exactly one named object, preserving its identity and transform. */
export function ReplaceOnlineModel() {
  const {state,dispatch}=useEditor();const latest=useRef(state.plan);latest.current=state.plan;
  const [name,setName]=useState(''),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const ctrl=useRef<AbortController|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;ctrl.current?.abort();};},[]);
  const replace=async()=>{
    if(busy)return;
    const before=state.plan,matches=before.objects.filter(o=>o.name.trim().toLocaleLowerCase()===name.trim().toLocaleLowerCase());
    if(matches.length!==1){setError(matches.length?'يوجد أكثر من مجسم بهذا الاسم؛ أعد تسمية المطلوب من المحرر أولاً.':'لم أجد مجسماً بهذا الاسم في العالم.');return;}
    const target=matches[0]!;
    if(target.locked){setError('المجسم مقفل؛ أزل القفل أولاً.');return;}
    if(!query.trim()||query.length>200){setError('اكتب اسم المجسم البديل.');return;}
    const other=before.objects.reduce((sum,o)=>sum+(o.id===target.id?0:o.meta.generatedMesh?.data.length??0),0);
    const budget=Math.min(Math.floor(MAX_GENERATED_DATA/16),MAX_GENERATED_DATA-other);
    if(budget<1000){setError('لا توجد سعة كافية للمجسم البديل.');return;}
    const abort=new AbortController();ctrl.current=abort;const timer=window.setTimeout(()=>abort.abort(),600000);setBusy(true);setError('');setMessage('أبحث عن البديل في المصادر المجانية…');
    try {
      const {object,model,warnings}=await findAndLoadOnline(query.trim(),abort.signal,budget);
      if(abort.signal.aborted)throw new DOMException('Cancelled','AbortError');
      if(latest.current!==before)throw new Error('تغيّر العالم أثناء البحث؛ لم يُطبّق الاستبدال.');
      const replacement={...object,id:target.id,name:target.name,parentId:target.parentId,transform:target.transform,visible:target.visible,locked:target.locked};
      const plan={...before,objects:before.objects.map(o=>o.id===target.id?replacement:o)};
      if(!validateWorldPlan(plan).success)throw new Error('المجسم البديل يتجاوز سعة المشروع؛ لم يتغير العالم.');
      dispatch({type:'replacePlan',plan});
      setMessage(`استُبدل «${target.name}» بـ ${model.title} من ${model.source==='gobkit'?'Gobkit':'3DAssets.dev'} (CC0). يمكن التراجع بـ Undo.${warnings.length?` تعذرت مصادر: ${warnings.join('، ')}.`:''}`);
    }catch(e){if(alive.current){setMessage('');setError(abort.signal.aborted?'أُلغي البحث؛ لم يتغير العالم.':e instanceof Error?e.message:'تعذّر الاستبدال؛ لم يتغير العالم.');}}
    finally{window.clearTimeout(timer);if(ctrl.current===abort)ctrl.current=null;if(alive.current)setBusy(false);}
  };
  return <div className="callout"><div>
    <strong>استبدال مجسم بالاسم تلقائياً</strong>
    <p>اكتب الاسم كما يظهر في قائمة العالم واسم البديل؛ سيبحث الخادم في 3DAssets.dev وGobkit ويختار مجسماً ثابتاً متوافقاً. لا ترسل بيانات خاصة. البحث بالإنجليزية أدق.</p>
    <label className="field"><span>اسم المجسم الحالي</span><input aria-label="اسم المجسم الحالي" disabled={busy} value={name} maxLength={80} onChange={e=>setName(e.target.value)} list="world-object-names"/></label>
    <datalist id="world-object-names">{state.plan.objects.map(o=><option key={o.id} value={o.name}/>)}</datalist>
    <label className="field"><span>اسم المجسم البديل</span><input aria-label="اسم المجسم البديل" disabled={busy} value={query} maxLength={200} onChange={e=>setQuery(e.target.value)}/></label>
    <button type="button" className="btn btn-small" disabled={busy||!name.trim()||!query.trim()} onClick={()=>void replace()}>ابحث واستبدل المجسم</button>
    {busy && <button type="button" className="btn btn-small" onClick={()=>ctrl.current?.abort()}>إلغاء الاستبدال</button>}
    {message && <p role="status">{message}</p>}{error && <p role="alert" className="online-error">{error}</p>}
  </div></div>;
}
