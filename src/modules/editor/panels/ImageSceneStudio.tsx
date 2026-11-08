import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { useEditor } from '../store';
import { createId } from '../../../core/utils/id';
import { findAssetMentions, normalizeAssetText } from '../../ai/assetRequests';
import { unknownTopics } from '../../ai/unknownResearch';
import { colorRegions, createImageScene, SCENE_TYPES, type SceneMark, type SceneType } from '../../ai/imageScene';
import { photoToModel, type TinyImage } from '../../ai/photoModel';
import { photoStyleForTopic, type PhotoMeshStyle } from '../../ai/photoStyle';
import type { PhotoModel } from '../../../core/world-plan/schema';
import { PhotoOutline } from './PhotoOutline';

interface LocalImage { url:string; title:string; pixels:TinyImage }

/** On-device guided scene assembly. Image colours are not object recognition. */
export function ImageSceneStudio({ onOpenStudio }: { onOpenStudio?: () => void }) {
  const { state, dispatch }=useEditor();
  const [picture,setPicture]=useState<LocalImage|null>(null), [description,setDescription]=useState('');
  const [marks,setMarks]=useState<SceneMark[]>([]), [type,setType]=useState<SceneType>('broadleaf');
  const [name,setName]=useState('شجرة'), [depth,setDepth]=useState(.5), [size,setSize]=useState(1), [height,setHeight]=useState(0);
  const [point,setPoint]=useState<{x:number;y:number}|null>(null), [model,setModel]=useState<PhotoModel|null>(null);
  const [message,setMessage]=useState(''), [error,setError]=useState(''), [loading,setLoading]=useState(false);
  const [meshStyle,setMeshStyle]=useState<PhotoMeshStyle>('smooth');
  const pending=useRef(new Set<string>()), currentUrl=useRef(''), generation=useRef(0);
  const release=(url:string) => { if(pending.current.delete(url)) URL.revokeObjectURL(url); };
  useEffect(()=>()=>{ generation.current++; for(const url of pending.current) URL.revokeObjectURL(url); pending.current.clear(); },[]);
  const load = (event:ChangeEvent<HTMLInputElement>) => {
    const file=event.target.files?.[0]; event.target.value=''; if(!file) return;
    const id=++generation.current;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size>12*1024*1024 || !file.size) { setLoading(false); setError('اختر JPEG أو PNG أو WebP بحجم لا يتجاوز 12 ميغابايت.'); return; } const url=URL.createObjectURL(file); pending.current.add(url); setLoading(true);setError('');
    const image=new Image();
    image.onload=()=>{
      if(id!==generation.current) { release(url); return; }
      try {
        const w=image.naturalWidth,h=image.naturalHeight;
        if(!w||!h||w*h>16_000_000||Math.max(w/h,h/w)>12) throw new Error('أبعاد الصورة كبيرة جداً أو غير مدعومة.');
        const scale=Math.min(24/w,24/h), width=Math.max(2,Math.round(w*scale)), height=Math.max(2,Math.round(h*scale));
        const canvas=document.createElement('canvas'); canvas.width=width;canvas.height=height;
        const context=canvas.getContext('2d',{willReadFrequently:true});
        if(!context) throw new Error('تعذّر قراءة الصورة على هذا المتصفح.');
        context.drawImage(image,0,0,width,height);
        const rgba=new Uint8Array(context.getImageData(0,0,width,height).data);
        if(currentUrl.current) release(currentUrl.current); currentUrl.current=url;
        setPicture({url,title:(file.name||'صورة محلية').slice(0,120),pixels:{width,height,rgba}});
        setMarks([]);setPoint(null);setModel(null);setMessage('');
      } catch(reason) { release(url);setError(reason instanceof Error ? reason.message : 'تعذّر قراءة الصورة.'); }
      setLoading(false);
    };
    image.onerror=()=>{ release(url); if(id===generation.current){setLoading(false);setError('تعذّر فتح الصورة.');} };
    image.src=url;
  };
  const selectType=(id:SceneType,label?:string)=>{setType(id);setName(label??SCENE_TYPES.find((entry)=>entry.id===id)!.label);setPoint(null);setModel(null);setError(''); if(id==='photo') { const style=photoStyleForTopic(description,label??'',unknownTopics(description).terms.length || 1); setMeshStyle(style==='conflict'?'smooth':style); }};
  const tap = (event:MouseEvent<SVGSVGElement>) => {
    const rect=event.currentTarget.getBoundingClientRect(); if(!rect.width||!rect.height) return;
    setPoint({x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}); setError('');
  };
  const add=()=>{
    if(!point || !name.trim() || (type==='photo'&&!model)) {setError('حدد العنصر وموقعه أولاً، وارسم حدوده إذا اخترت شكلاً من الصورة.');return;}
    if(marks.length>=30){setError('الحد الأقصى 30 عنصراً في المشهد.');return;}
    setMarks((old)=>[...old,{id:createId('mark'),name:name.trim().slice(0,80),type,x:point.x,y:point.y,depth,size,height,...(model?{model}: {})}]);
    setPoint(null);setModel(null);setError('');setMessage('أُضيف إلى قائمة المراجعة فقط؛ لم يتغير العالم بعد.');
  };
  const build=()=>{
    try {
      const plan=createImageScene(description || 'مشهد مستوحى من الصورة', marks, (state.plan.seed^0x51ca7e)>>>0);
      dispatch({type:'replacePlan',plan});setMessage('أُنشئ مشهد تقريبي من العناصر المحددة فقط. استخدم التجول ويمكن التراجع من Undo.');setError('');onOpenStudio?.();
    } catch(reason) {setError(reason instanceof Error ? reason.message : 'تعذّر إنشاء المشهد.');}
  };
  const normalizedDescription=normalizeAssetText(description);
  const negatedAt=(index:number)=>/(?:^|\s)(?:بدون|دون|بلا|لا|without|no|not)\s+(?:ال)?$/iu.test(normalizedDescription.slice(0,index));
  const suggestions=findAssetMentions(normalizedDescription).filter((item)=>!negatedAt(item.start)).map((item)=>({tree:'broadleaf',broadleaf:'broadleaf',boulder:'boulder',house:'house',tower:'tower',bridge:'bridge','wood-fence':'wood-fence',sphere:'sphere',box:'box'} as Record<string,SceneType>)[item.id]).filter((item):item is SceneType=>!!item);
  const water=Array.from(normalizedDescription.matchAll(/بحير|نهر|ماء|مياه|بحر|water|river|lake|sea/giu)).some((match)=>!negatedAt(match.index));
  const unique=[...new Set([...suggestions,...(water?['water' as const]:[])])];
  const unknown=description.trim()?unknownTopics(description).terms.filter((term)=>{
    const normalizedTerm=normalizeAssetText(term); const index=normalizedDescription.indexOf(normalizedTerm);
    return index<0 || !negatedAt(index);
  }):[];
  const regions=picture ? colorRegions(picture.pixels) : [];
  return <details className="wiki-library" dir="rtl">
    <summary>إنشاء مشهد تقريبي من صورة ووصف</summary>
    <p>الصورة تبقى على الجهاز. قسّمها إلى عناصر تختارها وتحدد قربها أو بعدها؛ سيتم إنشاء أجسام منفصلة في عالم جديد، وليس تحويل الصورة كلها إلى لوح. التعرف على الكائنات والعمق غير تلقائيين في النسخة الخفيفة.</p>
    <label className="field"><span>اختر صورة من الجهاز (JPEG أو PNG أو WebP)</span><input aria-label="صورة المشهد" type="file" accept="image/jpeg,image/png,image/webp" onChange={load}/></label>
    {loading && <p role="status">أقرأ الصورة محلياً…</p>}
    <label className="field"><span>صف العناصر الموجودة في الصورة (اختياري)</span><textarea aria-label="وصف عناصر الصورة" maxLength={400} value={description} onChange={(event)=>setDescription(event.target.value)} rows={2}/></label>
    {!!unique.length && <div><p>عناصر تعرّف عليها الوصف؛ اختر نوعاً ثم حدّد مكانه:</p>{unique.map((id)=><button type="button" key={id} className="btn btn-small" onClick={()=>selectType(id)}>{SCENE_TYPES.find((entry)=>entry.id===id)!.label}</button>)}</div>}
    {!!unknown.length && <div><p>كلمات غير مفهومة تلقائياً؛ يمكنك تحديد شكلها من الصورة إذا كانت ظاهرة:</p>{unknown.slice(0,10).map((term)=><button type="button" key={term} className="btn btn-small" onClick={()=>selectType('photo',term)}>{term}</button>)}</div>}
    {picture && <>
      <p>الصورة: {picture.title}. اضغط موقع العنصر على الصورة. اليمين واليسار من الصورة، والعمق والارتفاع تختارهما أنت، لا يُستنتج الارتفاع من موضع الضغط؛ لا يمكن التحقق من المواضع المخفية.</p>
      <svg role="img" aria-label="صورة المشهد لتحديد مواقع العناصر" viewBox={`0 0 ${picture.pixels.width} ${picture.pixels.height}`} onClick={tap} style={{width:'100%',maxWidth:420,height:'auto',display:'block',margin:'auto',touchAction:'manipulation',cursor:'crosshair'}}>
        <image href={picture.url} x="0" y="0" width={picture.pixels.width} height={picture.pixels.height} preserveAspectRatio="none" />
        {marks.map((item,i)=><g key={item.id}><circle cx={item.x*picture.pixels.width} cy={item.y*picture.pixels.height} r={Math.max(picture.pixels.width,picture.pixels.height)/22} fill="#e95054" stroke="white" strokeWidth=".1"/><text x={item.x*picture.pixels.width} y={item.y*picture.pixels.height} textAnchor="middle" dominantBaseline="central" fontSize={Math.max(picture.pixels.width,picture.pixels.height)/15} fill="white">{i+1}</text></g>)}
        {point && <circle cx={point.x*picture.pixels.width} cy={point.y*picture.pixels.height} r={Math.max(picture.pixels.width,picture.pixels.height)/30} fill="#00e7ff" stroke="white" strokeWidth=".1"/>}
      </svg>
      {!!regions.length && <details><summary>مناطق لونية مقترحة ({regions.length})</summary><p>هذه تجمعات ألوان فقط، وليست تعرّفاً على الأشياء؛ قد تقسم شيئاً أو تجمع عدة أشياء.</p>{regions.map((region,i)=><button type="button" className="btn btn-small" key={i} onClick={()=>setPoint({x:region.x,y:region.y})}><span style={{display:'inline-block',width:12,height:12,background:region.color}}/> منطقة {i+1}</button>)}</details>}
      <label className="field"><span>نوع العنصر</span><select aria-label="نوع عنصر المشهد" value={type} onChange={(event)=>selectType(event.target.value as SceneType)}>{SCENE_TYPES.map((entry)=><option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
      <label className="field"><span>اسم العنصر</span><input aria-label="اسم عنصر المشهد" maxLength={80} value={name} onChange={(event)=>setName(event.target.value)}/></label>
      <label className="field"><span>العمق: {depth<.34?'قريب':depth>.66?'بعيد':'وسط'}</span><input aria-label="عمق العنصر" type="range" min="0" max="1" step="0.05" value={depth} onChange={(event)=>setDepth(Number(event.target.value))}/></label>
      <label className="field"><span>الارتفاع عن الأرض: {height.toFixed(1)}</span><input aria-label="ارتفاع العنصر" type="range" min="0" max="20" step="0.5" value={height} onChange={(event)=>setHeight(Number(event.target.value))}/></label>
      <label className="field"><span>الحجم التقريبي: {size.toFixed(2)}</span><input aria-label="حجم العنصر" type="range" min="0.25" max="3" step="0.25" value={size} onChange={(event)=>setSize(Number(event.target.value))}/></label>
      {type==='photo' && <><label className="field"><span>أسلوب مجسم الصورة (يمكن تغييره قبل رسم الحدود)</span><select aria-label="أسلوب مجسم الصورة" value={meshStyle} onChange={(event)=>{setMeshStyle(event.target.value as PhotoMeshStyle);setModel(null);}}><option value="smooth">ناعم تقريبي</option><option value="blocky">بكسلي</option></select></label><p>حدد حدود عنصر واحد فقط. سينتج مجسم من واجهته، بعمق وخلف مفترضين؛ ليس استعادة حقيقية لشكله الكامل.</p><PhotoOutline key={`${picture.url}:${marks.length}`} image={picture.pixels} onApply={(mask)=>{
        try {
          const built=photoToModel(picture.pixels,{kind:'local',title:picture.title,author:'صورة من الجهاز',license_name:'غير محدد'},false,mask,meshStyle);
          const indexes=Array.from(mask, (v,i)=>v?i:-1).filter((i)=>i>=0);
          setPoint({x:indexes.reduce((sum,i)=>sum+(i%picture.pixels.width)+.5,0)/indexes.length/picture.pixels.width,y:indexes.reduce((sum,i)=>sum+Math.floor(i/picture.pixels.width)+.5,0)/indexes.length/picture.pixels.height});
          setModel(built);setError('');
        } catch(reason) {setError(reason instanceof Error?reason.message:'تعذّر تحديد العنصر.');}
      }}/>{model && <p>تم تحديد الشكل؛ راجع العمق والحجم ثم أضفه للقائمة.</p>}</>}
      <button type="button" className="btn btn-small" onClick={add} disabled={!point || (type==='photo'&&!model)}>أضف العنصر إلى المراجعة</button>
      <div><strong>العناصر التي ستُنشأ: {marks.length}</strong>{marks.map((item,i)=><p key={item.id}>{i+1}. {item.name} · {SCENE_TYPES.find((entry)=>entry.id===item.type)?.label} · عمق {item.depth.toFixed(2)} · ارتفاع {item.height?.toFixed(1) ?? "0.0"} <button type="button" className="btn btn-small" onClick={()=>setMarks((old)=>old.filter((entry)=>entry.id!==item.id))}>إزالة {item.name}</button></p>)}</div>
      <p>ينشئ أرضاً مستوية وماءً زخرفياً إن اخترته؛ لا يحفر وادياً ولا يستنتج الجدران والأجزاء المخفية. قد تتداخل العناصر. راجعها في المحرر بعد الإنشاء.</p>
      <button type="button" className="btn btn-primary" disabled={!marks.length} onClick={build}>إنشاء عالم جديد من العناصر المحددة</button>
      <p>هذا يستبدل العالم المعروض ويمكن التراجع عنه بـ Undo. الألوان والشكل المشتقان من القصاصة واسم الملف يحفظان في المشروع؛ لا تحفظ الصورة الأصلية. تحقق من حقك في استخدام الصورة قبل مشاركة الناتج.</p>
    </>}
    {error && <p className="online-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </details>;
}
