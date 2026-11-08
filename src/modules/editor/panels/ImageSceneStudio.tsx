import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import { useEditor } from '../store';
import { createId } from '../../../core/utils/id';
import { findAssetMentions, normalizeAssetText } from '../../ai/assetRequests';
import { unknownTopics } from '../../ai/unknownResearch';
import { appendImageScene, colorRegions, createImageScene, SCENE_TYPES, type SceneMark, type SceneType } from '../../ai/imageScene';
import { photoToModel, type TinyImage } from '../../ai/photoModel';
import { photoStyleForTopic, type PhotoMeshStyle } from '../../ai/photoStyle';
import { scenePhotoCrop } from '../../ai/scenePhotoCrop';
import { localSceneVision } from '../../ai/localVision';
import { semanticRegions, regionsToSceneMarks } from '../../ai/semanticScene';
import { researchDetectedClasses, type SemanticResearchResult } from '../../ai/semanticResearch';
import type { PhotoModel, WorldPlan } from '../../../core/world-plan/schema';
import type { ImageReference } from '../../ai/imageReferences';
import { PhotoOutline } from './PhotoOutline';
import { PhotoModelPreview } from './PhotoStudio';

interface LocalImage { url:string; title:string; pixels:TinyImage; source:HTMLImageElement; reference?:ImageReference }

/** On-device guided scene assembly. Image colours are not object recognition. */
export function ImageSceneStudio({ onOpenStudio, embedded=false, initialDescription='', articleText='', initialFile, reference, mode='create', basePlan, canApply, onApplied, onAutoBuilt }: { onOpenStudio?: () => void; embedded?:boolean; initialDescription?:string; articleText?:string; initialFile?:File; reference?:ImageReference; mode?:'create'|'edit'; basePlan?:WorldPlan; canApply?:()=>boolean; onApplied?:()=>void; onAutoBuilt?:()=>void }) {
  const { state, dispatch }=useEditor();
  const [picture,setPicture]=useState<LocalImage|null>(null), [description,setDescription]=useState(initialDescription);
  const [marks,setMarks]=useState<SceneMark[]>([]), [type,setType]=useState<SceneType>('broadleaf');
  const [name,setName]=useState('شجرة'), [depth,setDepth]=useState(.5), [size,setSize]=useState(1), [height,setHeight]=useState(0), [thickness,setThickness]=useState(1);
  const [point,setPoint]=useState<{x:number;y:number}|null>(null), [model,setModel]=useState<PhotoModel|null>(null);
  const [message,setMessage]=useState(''), [error,setError]=useState(''), [loading,setLoading]=useState(false);
  const [meshStyle,setMeshStyle]=useState<PhotoMeshStyle>('smooth');
  const [showPreview,setShowPreview]=useState(false);
  const [autoBusy,setAutoBusy]=useState(false), [autoStatus,setAutoStatus]=useState('');
  const [autoReport,setAutoReport]=useState<{count:number;ignored:string[];truncated:number;failed:string[];research:SemanticResearchResult[]}|null>(null);
  const autoController=useRef<AbortController|null>(null), planRef=useRef(state.plan), descriptionRef=useRef(description);planRef.current=state.plan;descriptionRef.current=description;
  const pending=useRef(new Set<string>()), currentUrl=useRef(''), generation=useRef(0);
  const release=(url:string) => { if(pending.current.delete(url)) URL.revokeObjectURL(url); };
  useEffect(()=>()=>{ const pendingAuto=autoController.current;autoController.current=null;pendingAuto?.abort();generation.current++; for(const url of pending.current) URL.revokeObjectURL(url); pending.current.clear(); },[]);
  const loadFile = (file:File, imageReference?:ImageReference) => {
    autoController.current?.abort();setAutoBusy(false);setAutoStatus('');setAutoReport(null);
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
        setPicture({url,title:(file.name||'صورة محلية').slice(0,120),pixels:{width,height,rgba},source:image,...(imageReference?{reference:imageReference}:{})});
        setMarks([]);setPoint(null);setModel(null);setShowPreview(false);setMessage('');
      } catch(reason) { release(url);setError(reason instanceof Error ? reason.message : 'تعذّر قراءة الصورة.'); }
      setLoading(false);
    };
    image.onerror=()=>{ release(url); if(id===generation.current){setLoading(false);setError('تعذّر فتح الصورة.');} };
    image.src=url;
  };
  useEffect(()=>{if(initialFile) loadFile(initialFile,reference);},[initialFile,reference]);
  const load = (event:ChangeEvent<HTMLInputElement>) => { const file=event.target.files?.[0]; event.target.value=''; if(file) loadFile(file); };
  const selectType=(id:SceneType,label?:string)=>{setType(id);setName(label??SCENE_TYPES.find((entry)=>entry.id===id)!.label);setPoint(null);setModel(null);setShowPreview(false);setError(''); if(id==='photo') { const style=photoStyleForTopic(description,label??'',unknownTopics(description).terms.length || 1); setMeshStyle(style==='conflict'?'smooth':style); }};
  const tap = (event:MouseEvent<SVGSVGElement>) => {
    const rect=event.currentTarget.getBoundingClientRect(); if(!rect.width||!rect.height) return;
    setPoint({x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))}); setError('');
  };
  const add=()=>{
    if(!point || !name.trim() || (type==='photo'&&!model)) {setError('حدد العنصر وموقعه أولاً، وارسم حدوده إذا اخترت شكلاً من الصورة.');return;}
    if(marks.length>=30){setError('الحد الأقصى 30 عنصراً في المشهد.');return;}
    setMarks((old)=>[...old,{id:createId('mark'),name:name.trim().slice(0,80),type,x:point.x,y:point.y,depth,size,height,thickness,...(model?{model}: {})}]);
    setPoint(null);setModel(null);setShowPreview(false);setError('');setMessage('أُضيف إلى قائمة المراجعة فقط؛ لم يتغير العالم بعد.');
  };
  const build=()=>{
    try {
      if ((basePlan && state.plan!==basePlan) || (canApply && !canApply())) throw new Error('تغيّر العالم أو الوصف أثناء العمل؛ ألغِ وأعد المحاولة.');
      const plan=mode==='edit' ? appendImageScene(state.plan,marks) : createImageScene(description || 'مشهد مستوحى من الصورة', marks, (state.plan.seed^0x51ca7e)>>>0);
      dispatch({type:'replacePlan',plan});setMessage('طُبّقت العناصر المحددة فقط. استخدم التجول ويمكن التراجع من Undo.');setError('');onApplied?.();onOpenStudio?.();
    } catch(reason) {setError(reason instanceof Error ? reason.message : 'تعذّر إنشاء المشهد.');}
  };
  const buildAutomatically=async()=>{
    if(!picture || autoBusy || loading)return;
    const controller=new AbortController();autoController.current=controller;
    const initialPlan=planRef.current;
    setAutoBusy(true);setAutoStatus('أحلّل الصورة محلياً على الهاتف…');setAutoReport(null);setError('');setMessage('');
    try {
      if((basePlan && initialPlan!==basePlan) || (canApply && !canApply())) throw new Error('تغيّر العالم أو الوصف أثناء العمل؛ ألغِ وأعد المحاولة.');
      const labels=await localSceneVision(picture.source,controller.signal);
      if(controller.signal.aborted)return;
      const detected=semanticRegions(labels);
      if(!detected.regions.length)throw new Error('لم يجد النموذج مناطق يمكن بناؤها. جرّب صورة أخرى أو التحديد اليدوي.');
      setAutoStatus('أبحث عن الفئات المكتشفة في ويكيبيديا وCommons…');
      const research=await researchDetectedClasses(detected.regions.map(region=>region.label),controller.signal,(done,total)=>setAutoStatus(`البحث عن الفئات: ${done} من ${total}…`));
      if(controller.signal.aborted)return;
      const result=regionsToSceneMarks(detected.regions,picture.source,picture.reference ?? {kind:'local',title:picture.title,author:'صورة من الجهاز',license_name:'غير محدد'},description);
      if(!result.marks.length)throw new Error('تعذّر بناء المناطق المكتشفة من هذه الصورة.');
      if(planRef.current!==initialPlan || descriptionRef.current!==description || (canApply && !canApply()))throw new Error('تغيّر العالم أو الوصف أثناء التحليل؛ لم يُطبّق شيء.');
      const plan=mode==='edit'?appendImageScene(initialPlan,result.marks):createImageScene(description || 'مشهد مستوحى من الصورة',result.marks,(initialPlan.seed^0x51ca7e)>>>0);
      dispatch({type:'replacePlan',plan});onAutoBuilt?.();setMarks(result.marks);setPoint(null);setModel(null);
      setAutoReport({count:result.marks.length,ignored:detected.ignored,truncated:detected.truncated,failed:result.failed,research});
      setAutoStatus('');setMessage('بُنيت المناطق الممكنة تلقائياً. يمكن التراجع عن العملية بالكامل باستخدام Undo.');
    } catch(reason) {if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'تعذّر التحليل التلقائي.');}
    finally {if(autoController.current===controller){autoController.current=null;setAutoBusy(false);setAutoStatus('');}}
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
  const normalizedArticle=normalizeAssetText(articleText);
  const articleNegated=(index:number)=>/(?:^|\s)(?:بدون|دون|بلا|لا|ليس|ليست|without|no|not)\s+(?:ال)?$/iu.test(normalizedArticle.slice(0,index));
  const articleSuggestions=[...new Set([
    ...findAssetMentions(normalizedArticle).filter((item)=>!articleNegated(item.start)).map((item)=>({tree:'broadleaf',broadleaf:'broadleaf',boulder:'boulder',house:'house',tower:'tower',bridge:'bridge','wood-fence':'wood-fence',sphere:'sphere',box:'box'} as Record<string,SceneType>)[item.id]).filter((item):item is SceneType=>!!item),
    ...(Array.from(normalizedArticle.matchAll(/بحير|نهر|ماء|مياه|بحر|water|river|lake|sea/giu)).some((match)=>!articleNegated(match.index))?['water' as const]:[]),
  ])];
  const regions=picture ? colorRegions(picture.pixels) : [];
  const Wrapper=embedded?'div':'details';
  return <Wrapper className="wiki-library" dir="rtl">
    {!embedded && <summary>إنشاء مشهد تقريبي من صورة ووصف</summary>}
    <p>الصورة تبقى على الجهاز. قسّمها إلى عناصر تختارها وتحدد قربها أو بعدها؛ سيتم إنشاء أجسام منفصلة، وليس تحويل الصورة كلها إلى لوح. التعرف على الكائنات والعمق غير تلقائيين في النسخة الخفيفة.</p>
    {!embedded && <label className="field"><span>اختر صورة من الجهاز (JPEG أو PNG أو WebP)</span><input aria-label="صورة المشهد" type="file" accept="image/jpeg,image/png,image/webp" onChange={load}/></label>}
    {loading && <p role="status">أقرأ الصورة محلياً…</p>}
    {!embedded && <label className="field"><span>صف العناصر الموجودة في الصورة (اختياري)</span><textarea aria-label="وصف عناصر الصورة" maxLength={400} value={description} onChange={(event)=>setDescription(event.target.value)} rows={2}/></label>}
    {!!articleSuggestions.length && <div><p>كلمات مدعومة وردت في المقالة؛ لا يعني ذلك أنها موجودة في الصورة. اختر ما تراه فقط:</p>{articleSuggestions.map((id)=><button type="button" key={id} className="btn btn-small" onClick={()=>selectType(id)}>{SCENE_TYPES.find((entry)=>entry.id===id)!.label}</button>)}</div>}
    {!!unique.length && <div><p>عناصر تعرّف عليها الوصف؛ اختر نوعاً ثم حدّد مكانه:</p>{unique.map((id)=><button type="button" key={id} className="btn btn-small" onClick={()=>selectType(id)}>{SCENE_TYPES.find((entry)=>entry.id===id)!.label}</button>)}</div>}
    {!!unknown.length && <div><p>كلمات غير مفهومة تلقائياً؛ يمكنك تحديد شكلها من الصورة إذا كانت ظاهرة:</p>{unknown.slice(0,10).map((term)=><button type="button" key={term} className="btn btn-small" onClick={()=>selectType('photo',term)}>{term}</button>)}</div>}
    {picture && <>
      <div className="wiki-library">
        <strong>تحليل وبناء تلقائي محلي</strong>
        <p>يقسم النموذج الصورة إلى فئات ومناطق ثم يبحث عن اسم كل فئة مكتشفة ويضع أشكالاً تقريبية قابلة للتعديل. قد يخطئ أو يدمج عناصر متلاصقة ويفوّت الصغيرة، ولا يعرف كل الأنواع أو العمق الحقيقي. الحد الأقصى 30 منطقة؛ الخلفية والأرض لا تتحول إلى عناصر مستقلة.</p>
        <p>التحليل محلي ولا تُرسل الصورة؛ أسماء الفئات ترسل للبحث في ويكيبيديا وCommons. يتطلب تثبيت نموذج الرؤية مرة واحدة.</p>
        <button type="button" className="btn btn-primary" disabled={autoBusy || loading || !!autoReport} onClick={()=>void buildAutomatically()}>حلّل وابحث وابنِ تلقائياً</button>
        {autoBusy && <><p role="status">{autoStatus}</p><button type="button" className="btn btn-small" onClick={()=>{autoController.current?.abort();setMessage('أُلغي التحليل؛ لم يتغيّر العالم.');}}>إلغاء التحليل</button></>}
        {autoReport && <div><p>أُنشئت {autoReport.count} منطقة مستقلة. {autoReport.truncated>0?`تُركت ${autoReport.truncated} منطقة بسبب الحد الأقصى. `:''}{autoReport.failed.length?`تعذّر بناء: ${autoReport.failed.join('، ')}. `:''}{autoReport.ignored.length?`فئات عوملت كخلفية أو أرض: ${autoReport.ignored.join('، ')}.`:''}</p>
          <p>نتائج البحث معلومات عامة وليست إثباتاً أن المنطقة تطابق المقالة أو الصورة؛ البناء يستخدم الأشكال الجاهزة أو قصاصة من الصورة المختارة، وليس أشكالاً ثلاثية الأبعاد من الويب.</p>
          {autoReport.research.map(item=><div key={item.label}><strong>{item.label}</strong> · {item.article?<a href={item.article.url} target="_blank" rel="noopener noreferrer">{item.article.title} ↗</a>:'لم تُعثر مقالة مطابقة'} · {item.images[0]?<><a href={item.images[0].url} target="_blank" rel="noopener noreferrer">صورة مرجعية ↗</a> ({item.images[0].author}، <a href={item.images[0].license_url} target="_blank" rel="noopener noreferrer">{item.images[0].license_name}</a>)</>:'لم تُعثر صور مرخصة'}{item.errors.length?` · ${item.errors.join('، ')}`:''}{item.article?.content && <p>{item.article.content}</p>}</div>)}
          <button type="button" className="btn btn-small" onClick={()=>{onApplied?.();onOpenStudio?.();}}>عرض العالم في المحرر</button>
        </div>}
      </div>
      <p>للتحديد اليدوي فقط — الصورة: {picture.title}. اضغط موقع العنصر على الصورة. اليمين واليسار من الصورة، والعمق والارتفاع تختارهما أنت، لا يُستنتج الارتفاع من موضع الضغط؛ لا يمكن التحقق من المواضع المخفية.</p>
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
      {type==='photo' && <><label className="field"><span>سمك تقريبي للشكل: {thickness.toFixed(2)}</span><input aria-label="سمك مجسم الصورة" type="range" min="0.25" max="4" step="0.25" value={thickness} onChange={(event)=>setThickness(Number(event.target.value))}/></label><label className="field"><span>أسلوب مجسم الصورة (يمكن تغييره قبل رسم الحدود)</span><select aria-label="أسلوب مجسم الصورة" value={meshStyle} onChange={(event)=>{setMeshStyle(event.target.value as PhotoMeshStyle);setModel(null);setShowPreview(false);}}><option value="smooth">ناعم تقريبي</option><option value="blocky">بكسلي</option></select></label><p>حدد حدود عنصر واحد فقط. تُقص الواجهة من الصورة الأصلية محلياً قبل تصغيرها لإظهار تفاصيل أكثر. ينتج مجسم بعمق وخلف مفترضين؛ ليس استعادة حقيقية لشكله الكامل.</p><PhotoOutline key={`${picture.url}:${marks.length}`} image={picture.pixels} imageUrl={picture.url} cropFirst onChange={()=>{setModel(null);setPoint(null);setShowPreview(false);setError('');}} onApply={(_mask,points)=>{
        try {
          const crop=scenePhotoCrop(points,picture.pixels.width,picture.pixels.height,picture.source.naturalWidth,picture.source.naturalHeight);
          const canvas=document.createElement('canvas');canvas.width=crop.pixelWidth;canvas.height=crop.pixelHeight;
          const context=canvas.getContext('2d',{willReadFrequently:true});
          if(!context) throw new Error('تعذّر قراءة القصاصة على هذا المتصفح.');
          context.drawImage(picture.source,crop.x,crop.y,crop.width,crop.height,0,0,crop.pixelWidth,crop.pixelHeight);
          const pixels={width:crop.pixelWidth,height:crop.pixelHeight,rgba:new Uint8Array(context.getImageData(0,0,crop.pixelWidth,crop.pixelHeight).data)};
          const built=photoToModel(pixels,picture.reference ?? {kind:'local',title:picture.title,author:'صورة من الجهاز',license_name:'غير محدد'},false,crop.mask,meshStyle);
          const indexes=Array.from(crop.mask, (v,i)=>v && pixels.rgba[i*4+3]!>=128?i:-1).filter((i)=>i>=0);
          const cx=indexes.reduce((sum,i)=>sum+(i%crop.pixelWidth)+.5,0)/indexes.length/crop.pixelWidth;
          const cy=indexes.reduce((sum,i)=>sum+Math.floor(i/crop.pixelWidth)+.5,0)/indexes.length/crop.pixelHeight;
          setPoint({x:(crop.x+cx*crop.width)/picture.source.naturalWidth,y:(crop.y+cy*crop.height)/picture.source.naturalHeight});
          setModel(built);setError('');
        } catch(reason) {setError(reason instanceof Error?reason.message:'تعذّر تحديد العنصر.');}
      }}/>{model && <><p>تم تحديد الشكل؛ راجع العمق والحجم ثم أضفه للقائمة.</p><button type="button" className="btn btn-small" onClick={()=>setShowPreview((old)=>!old)}>{showPreview?'إغلاق معاينة الشكل':'معاينة الشكل ثلاثي الأبعاد'}</button>{showPreview && <PhotoModelPreview model={model} rows={model.height} depthScale={thickness}/>}</>}</>}
      <button type="button" className="btn btn-small" onClick={add} disabled={autoBusy || !!autoReport || !point || (type==='photo'&&!model)}>أضف العنصر إلى المراجعة</button>
      <div><strong>العناصر التي ستُنشأ: {marks.length}</strong>{marks.map((item,i)=><p key={item.id}>{i+1}. {item.name} · {SCENE_TYPES.find((entry)=>entry.id===item.type)?.label} · عمق {item.depth.toFixed(2)} · ارتفاع {item.height?.toFixed(1) ?? "0.0"} <button type="button" className="btn btn-small" disabled={autoBusy || !!autoReport} onClick={()=>{setMarks((old)=>old.filter((entry)=>entry.id!==item.id));setPoint(null);setModel(null);setShowPreview(false);}}>إزالة {item.name}</button></p>)}</div>
      <p>{mode==='create'?'ينشئ أرضاً مستوية':'يحافظ على الأرض الحالية ويضع العناصر قرب مركزها'} وماءً زخرفياً إن اخترته؛ لا يحفر وادياً ولا يستنتج الجدران والأجزاء المخفية. قد تتداخل العناصر أو تظهر تحت الماء. راجعها في المحرر بعد التطبيق.</p>
      <button type="button" className="btn btn-primary" disabled={!marks.length || autoBusy || !!autoReport} onClick={build}>{mode==='edit'?'إضافة العناصر المحددة إلى العالم':'إنشاء عالم جديد من العناصر المحددة'}</button>
      <p>{mode==='edit'?'تُضاف العناصر إلى العالم الحالي':'هذا يستبدل العالم المعروض'} ويمكن التراجع عنه بـ Undo. الألوان والشكل المشتقان من القصاصة واسم الملف يحفظان في المشروع، ومع صورة Commons تحفظ بيانات مصدرها وترخيصها للمجسم المشتق؛ لا تحفظ الصورة الأصلية. تحقق من حقك في استخدام الصورة قبل مشاركة الناتج.</p>
    </>}
    {error && <p className="online-error" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </Wrapper>;
}
