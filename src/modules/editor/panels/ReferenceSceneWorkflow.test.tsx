// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReferenceSceneWorkflow, referenceSearchQuery } from './ReferenceSceneWorkflow';
import { EditorProvider, useEditor } from '../store';
import { createEmptyWorldPlan } from '../../../core/world-plan/factory';
import { createBuilding } from '../../../core/assets/catalog';
import { createTerrainSampler } from '../../../core/generation/terrain';
import { TextEditPanel } from './TextEditPanel';
import { AiPanel } from './AiPanel';
import { initialMapTraining } from '../../ai/mapTrainer';
import { initialShapeModel } from '../../ai/shapeLearner';

const image={title:'File:Amazon.jpg',url:'https://commons.wikimedia.org/wiki/File:Amazon.jpg',thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Amazon.jpg/250px-Amazon.jpg',author:'Alice',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0'};
const article={title:'غابات الأمازون',url:'https://ar.wikipedia.org/wiki/غابات_الأمازون',content:'غابات الأمازون تضم شجرة وأنهاراً.'};
const requests:string[]=[];
function Observer(){const {state,dispatch}=useEditor();return <><pre data-testid="plan">{JSON.stringify(state.plan)}</pre><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function plan(){const world=createEmptyWorldPlan({name:'original',seed:5});return {...world,objects:[createBuilding('house',[0,0,0],()=>.5)]};}
function setup(mode:'create'|'edit'='create',canApply=()=>true){const initial=plan();return {initial,...render(<EditorProvider initialPlan={initial}><ReferenceSceneWorkflow prompt="ابني غابات الأمازون" basePlan={initial} mode={mode} canApply={canApply} onCancel={()=>{}} onApplied={()=>{}}/><Observer/></EditorProvider>)};}
function markAt(imageEl:Element,x=60,y=120){vi.spyOn(imageEl,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:240,bottom:240,width:240,height:240,toJSON:()=>({})});fireEvent.click(imageEl,{clientX:x,clientY:y});fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));}
beforeEach(()=>{
  requests.length=0;
  vi.stubGlobal('Image',class {naturalWidth=24;naturalHeight=24;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:reference');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  const data=new Uint8ClampedArray(576*4).fill(255);vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),getImageData:()=>({data})} as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{requests.push(url);
    if(url==='/api/image-search')return new Response(JSON.stringify({results:[image],next:null}));
    if(url.startsWith('/api/image-thumbnail?'))return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}});
    if(url==='/api/search')return new Response(JSON.stringify({results:[article],next:null}));
    if(url==='/api/wiki-article')return new Response(JSON.stringify({article}));
    throw new Error('unexpected '+url);
  }));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function findArticle(){
  const choice=await screen.findByRole('button',{name:/اختر File:Amazon.jpg/});
  expect(requests).toEqual(['/api/image-search']);fireEvent.click(choice);
  expect(await screen.findByText('المقالة المختارة:',{exact:false})).toBeTruthy();
  expect(requests[1]).toMatch(/^\/api\/image-thumbnail\?/);expect(requests[2]).toBe('/api/search');expect(requests[3]).toBe('/api/wiki-article');
  fireEvent.click(screen.getByRole('button',{name:'٢. متابعة لتحليل الصورة'}));
  await screen.findByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'});
  fireEvent.click(screen.getByText('تحديد العناصر يدوياً (اختياري)'));
  return screen.findByLabelText('صورة المشهد لتحديد مواقع العناصر');
}
describe('integrated reference workflow',()=>{
  it('searches for images before Wikipedia and creates only manually confirmed elements',async()=>{
    const {initial}=setup();const img=await findArticle();
    expect(screen.queryByLabelText('وصف عناصر الصورة')).toBeNull();
    expect(screen.getByText(/لا يعني ذلك أنها موجودة في الصورة/)).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
    markAt(img);fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    const result=JSON.parse(screen.getByTestId('plan').textContent!);expect(result.objects).toHaveLength(1);expect(result.objects[0].kind).toBe('tree');
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
  });
  it('adds to existing terrain atomically and keeps existing world; Undo restores it',async()=>{
    const {initial}=setup('edit');const img=await findArticle();markAt(img);
    fireEvent.click(screen.getByRole('button',{name:'إضافة العناصر المحددة إلى العالم'}));
    const result=JSON.parse(screen.getByTestId('plan').textContent!);
    expect(result.id).toBe(initial.id);expect(result.terrain).toEqual(initial.terrain);expect(result.objects).toHaveLength(2);expect(result.objects[0]).toEqual(initial.objects[0]);
    const [x,y,z]=result.objects[1].transform.position;expect(y).toBeCloseTo(createTerrainSampler(initial.terrain,initial.seed).heightAt(x,z));
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));const restored=JSON.parse(screen.getByTestId('plan').textContent!);expect({...restored,updatedAt:initial.updatedAt}).toEqual(initial);
  });
  it('keeps Commons attribution on the derived outlined model',async()=>{
    setup();await findArticle();fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'photo'}});
    const outline=screen.getByLabelText('صورة لتحديد حدود الجسم');vi.spyOn(outline,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:240,bottom:240,width:240,height:240,toJSON:()=>({})});
    for(const [x,y] of [[30,30],[180,30],[180,180],[30,180]])fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    expect(JSON.parse(screen.getByTestId('plan').textContent!).objects[0].meta.photoModel.source).toEqual({title:image.title,url:image.url,author:image.author,license_name:image.license_name,license_url:image.license_url});
  });
  it('refuses to apply if the original world or prompt changed',async()=>{
    setup('create',()=>false);const img=await findArticle();markAt(img);
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    expect(screen.getByRole('alert').textContent).toMatch(/تغيّر العالم أو الوصف/);expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('original');
  });
  it('rejects a draft when the world changes during research',async()=>{
    setup('edit');const img=await findArticle();markAt(img);fireEvent.click(screen.getByRole('button',{name:'change-test'}));
    fireEvent.click(screen.getByRole('button',{name:'إضافة العناصر المحددة إلى العالم'}));
    expect(screen.getByRole('alert').textContent).toMatch(/تغيّر العالم أو الوصف/);
    const result=JSON.parse(screen.getByTestId('plan').textContent!);expect(result.name).toBe('changed');expect(result.objects).toHaveLength(1);
  });
  it('supports a local image and explicitly continues without Wikipedia if search fails',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{requests.push(url);if(url==='/api/image-search')return new Response('{"results":[]}');if(url==='/api/search')return new Response('',{status:500});throw new Error('unexpected');}));
    setup();await screen.findByText(/لم تظهر صور مقبولة/);
    fireEvent.change(screen.getByLabelText('صورة مرجعية من الجهاز'),{target:{files:[new File(['x'],'local.png',{type:'image/png'})]}});
    expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.getByRole('button',{name:'٢. متابعة لتحليل الصورة'})).toBeTruthy();
    expect(requests).toEqual(['/api/image-search','/api/search']);fireEvent.click(screen.getByRole('button',{name:'٢. متابعة لتحليل الصورة'}));
    expect(await screen.findByLabelText('صورة المشهد لتحديد مواقع العناصر')).toBeTruthy();
  });
  it('does not use a picture to reinterpret a destructive text-edit command',()=>{
    const initial=plan();render(<EditorProvider initialPlan={initial}><TextEditPanel shapeModel={initialShapeModel()}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'),{target:{value:'احذف البيت'}});
    fireEvent.click(screen.getByRole('button',{name:'إضافة من صورة'}));expect(screen.getByRole('alert').textContent).toMatch(/أمر إضافة فقط/);
    expect(JSON.parse(screen.getByTestId('plan').textContent!).objects).toHaveLength(1);expect(requests).toEqual([]);
  });
  it('starts the image-first path from the existing generation prompt and primary button',async()=>{
    const initial=plan();const trainer={model:initialMapTraining(),setEnabled:()=>{},reset:()=>{},error:''};
    render(<EditorProvider initialPlan={initial}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'ابني غابات الأمازون'}});
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم من صورة'}));
    expect(await screen.findByRole('button',{name:/اختر File:Amazon.jpg/})).toBeTruthy();
    expect((screen.getByLabelText('موضوع البحث عن صور المشهد') as HTMLInputElement).value).toBe('غابات الأمازون');
    expect(requests).toEqual(['/api/image-search']);expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
  });
  it('starts the same path from the existing edit command without applying a preliminary edit',async()=>{
    const initial=plan();render(<EditorProvider initialPlan={initial}><TextEditPanel shapeModel={initialShapeModel()}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'),{target:{value:'أضف غابات الأمازون'}});
    fireEvent.click(screen.getByRole('button',{name:'إضافة من صورة'}));
    expect(await screen.findByRole('button',{name:/اختر File:Amazon.jpg/})).toBeTruthy();
    expect((screen.getByLabelText('موضوع البحث عن صور المشهد') as HTMLInputElement).value).toBe('غابات الأمازون');
    expect(JSON.parse(screen.getByTestId('plan').textContent!).objects).toHaveLength(1);expect(requests).toEqual(['/api/image-search']);
  });
  it('shows the next action immediately while Wikipedia is slow and ignores a late response',async()=>{
    let finish!:(value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{requests.push(url);if(url==='/api/image-search')return new Response('{"results":[]}');if(url==='/api/search')return new Promise<Response>(resolve=>{finish=resolve;});throw new Error('unexpected');}));
    setup();await screen.findByText(/لم تظهر صور مقبولة/);
    fireEvent.change(screen.getByLabelText('صورة مرجعية من الجهاز'),{target:{files:[new File(['x'],'local.png',{type:'image/png'})]}});
    const next=await screen.findByRole('button',{name:'٢. متابعة لتحليل الصورة'});expect((next as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/يمكنك المتابعة دون انتظار/)).toBeTruthy();
    fireEvent.click(next);expect(await screen.findByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'})).toBeTruthy();
    const manual=screen.getByText('تحديد العناصر يدوياً (اختياري)').parentElement as HTMLDetailsElement;
    expect(manual.open).toBe(false);
    finish(new Response(JSON.stringify({results:[article],next:null})));
    await waitFor(()=>expect(screen.queryByText('المقالة المختارة:',{exact:false})).toBeNull());
    expect(requests).toEqual(['/api/image-search','/api/search']);
  });
  it('shows two direct creation actions before choosing a picture',()=>{
    const trainer={model:initialMapTraining(),setEnabled:()=>{},reset:()=>{},error:''};
    render(<EditorProvider initialPlan={plan()}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}}/></EditorProvider>);
    expect(screen.getByRole('button',{name:'إنشاء عالم من صورة'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'إنشاء بالوصف فقط'}).textContent).toContain('إنشاء بالوصف فقط');
    expect(screen.queryByRole('checkbox',{name:/صورة مرجعية/})).toBeNull();
  });
  it('makes a small editable query from the command',()=>{expect(referenceSearchQuery('ابني غابات الأمازون')).toBe('غابات الأمازون');expect(referenceSearchQuery('أضف بيت')).toBe('بيت');});
});
