// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImageSceneStudio } from './ImageSceneStudio';
import { EditorProvider, useEditor } from '../store';
import { createEmptyWorldPlan } from '../../../core/world-plan/factory';

const revoke=vi.fn();
function Observer(){ const {state,dispatch}=useEditor(); return <><pre data-testid="plan">{JSON.stringify(state.plan)}</pre><button onClick={()=>dispatch({type:'undo'})}>UNDO-TEST</button></>; }
function setup(){ return render(<EditorProvider initialPlan={createEmptyWorldPlan({name:'original',seed:5})}><ImageSceneStudio/><Observer/></EditorProvider>); }
function bounds(element:Element){ vi.spyOn(element,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:240,bottom:240,width:240,height:240,toJSON:()=>({})}); }
async function upload(name='scene.png'){
  fireEvent.change(screen.getByLabelText('صورة المشهد'),{target:{files:[new File(['x'],name,{type:'image/png'})]}});
  const image=await screen.findByLabelText('صورة المشهد لتحديد مواقع العناصر'); bounds(image); return image;
}
beforeEach(()=>{
  vi.stubGlobal('Image',class {naturalWidth=24;naturalHeight=24;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local-image'); vi.spyOn(URL,'revokeObjectURL').mockImplementation(revoke);
  const data=new Uint8ClampedArray(24*24*4);for(let i=0;i<576;i++)data.set([i%24<12?20:190,80,60,255],i*4);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),getImageData:()=>({data})} as unknown as CanvasRenderingContext2D);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();revoke.mockClear();});
describe('guided local image scene',()=>{
  it('marks independent elements explicitly, picks depth and undoes replacement without sending the image',async()=>{
    const fetch=vi.fn();vi.stubGlobal('fetch',fetch); setup();
    fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف'));
    fireEvent.change(screen.getByLabelText('وصف عناصر الصورة'),{target:{value:'شجرة وصخرة'}});
    const image=await upload();
    fireEvent.click(image,{clientX:60,clientY:120});
    fireEvent.change(screen.getByLabelText('عمق العنصر'),{target:{value:'0.2'}});
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('original');
    fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'boulder'}});
    fireEvent.click(image,{clientX:180,clientY:120});
    fireEvent.change(screen.getByLabelText('عمق العنصر'),{target:{value:'0.8'}});
    fireEvent.change(screen.getByLabelText('ارتفاع العنصر'),{target:{value:'3'}});
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);
    expect(plan.objects).toHaveLength(2); expect(plan.objects[0].kind).toBe('tree'); expect(plan.objects[1].kind).toBe('rock');
    expect(plan.objects[0].transform.position[2]).toBeGreaterThan(plan.objects[1].transform.position[2]);expect(plan.objects[1].transform.position[1]).toBe(3);
    fireEvent.click(screen.getByRole('button',{name:'UNDO-TEST'}));
    expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('original'); expect(fetch).not.toHaveBeenCalled();
  });
  it('makes a local, user-outlined object with an explicit pixel style and resets marks for a new image',async()=>{
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف')); await upload('first.png');
    fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'photo'}});
    fireEvent.change(screen.getByLabelText('أسلوب مجسم الصورة'),{target:{value:'blocky'}});
    fireEvent.change(screen.getByLabelText('اسم عنصر المشهد'),{target:{value:'فيل'}});
    const outline=screen.getByLabelText('صورة لتحديد حدود الجسم');bounds(outline);
    for(const [x,y] of [[30,30],[180,30],[180,180],[30,180]]) fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    const model=JSON.parse(screen.getByTestId('plan').textContent!).objects[0].meta.photoModel;
    expect(model.source).toMatchObject({kind:'local',title:'first.png'});expect(model.mode).toBe('manual-silhouette');expect(model.meshStyle).toBe('blocky');
    await upload('second.png'); await waitFor(()=>expect(screen.getByText('العناصر التي ستُنشأ: 0')).toBeTruthy());
    expect((screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('crops a tiny scene element from the original before reducing it and supports preview, thickness and undo',async()=>{
    vi.stubGlobal('Image',class {naturalWidth=960;naturalHeight=960;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());}});
    const draw=vi.fn(), data=new Uint8ClampedArray(24*24*4);
    for(let i=0;i<576;i++)data.set([i%24*10,80,60,255],i*4);
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:draw,getImageData:()=>({data})} as unknown as CanvasRenderingContext2D);
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف'));await upload('large.png');
    fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'photo'}});
    const outline=screen.getByLabelText('صورة لتحديد حدود الجسم');bounds(outline);
    expect(outline.querySelector('image')?.getAttribute('href')).toBe('blob:local-image');
    for(const [x,y] of [[96,96],[120,96],[120,120],[96,120]]) fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    expect(draw).toHaveBeenCalledTimes(2); const args=draw.mock.calls[1]!;
    [384,384,96,96,0,0,24,24].forEach((expected,i)=>expect(args[i+1]).toBeCloseTo(expected));
    fireEvent.change(screen.getByLabelText('سمك مجسم الصورة'),{target:{value:'2'}});
    fireEvent.click(screen.getByRole('button',{name:'معاينة الشكل ثلاثي الأبعاد'}));
    expect(screen.getByText(/معاينة WebGL غير متاحة/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'إغلاق معاينة الشكل'}));
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    const obj=JSON.parse(screen.getByTestId('plan').textContent!).objects[0];
    expect([obj.meta.photoModel.width,obj.meta.photoModel.height,obj.meta.photoModel.cells.length]).toEqual([24,24,576]);
    expect(obj.transform.scale).toEqual([1,1,2]); expect(obj.transform.position[0]).toBeCloseTo(-1.4);
    fireEvent.click(screen.getByRole('button',{name:'UNDO-TEST'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('original');
  });
  it('makes multiple outlined objects from different parts of one photo as independent scene nodes',async()=>{
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف'));await upload();
    fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'photo'}});
    let outline=screen.getByLabelText('صورة لتحديد حدود الجسم');bounds(outline);
    for(const [x,y] of [[24,24],[72,24],[72,72],[24,72]]) fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    fireEvent.change(screen.getByLabelText('عمق العنصر'),{target:{value:'0.2'}});
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    outline=screen.getByLabelText('صورة لتحديد حدود الجسم');bounds(outline);
    for(const [x,y] of [[168,168],[216,168],[216,216],[168,216]]) fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    fireEvent.change(screen.getByLabelText('عمق العنصر'),{target:{value:'0.8'}});
    fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    fireEvent.click(screen.getByRole('button',{name:'إنشاء عالم جديد من العناصر المحددة'}));
    const objects=JSON.parse(screen.getByTestId('plan').textContent!).objects;
    expect(objects).toHaveLength(2);expect(objects[0].id).not.toBe(objects[1].id);
    expect(objects[0].transform.position[0]).toBeCloseTo(-8.4); expect(objects[1].transform.position[0]).toBeCloseTo(8.4);
    expect(objects[0].transform.position[2]).toBeGreaterThan(objects[1].transform.position[2]);
  });
  it('invalidates an old shape when its outline changes',async()=>{
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف'));await upload();
    fireEvent.change(screen.getByLabelText('نوع عنصر المشهد'),{target:{value:'photo'}});
    const outline=screen.getByLabelText('صورة لتحديد حدود الجسم');bounds(outline);
    for(const [x,y] of [[30,30],[180,30],[180,180],[30,180]]) fireEvent.click(outline,{clientX:x,clientY:y});
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    expect((screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button',{name:'تراجع عن آخر نقطة'}));
    expect((screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}) as HTMLButtonElement).disabled).toBe(true);
  });
  it('rejects invalid files without disturbing the current image or marks',async()=>{
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف')); const image=await upload();
    fireEvent.click(image,{clientX:60,clientY:120});fireEvent.click(screen.getByRole('button',{name:'أضف العنصر إلى المراجعة'}));
    fireEvent.change(screen.getByLabelText('صورة المشهد'),{target:{files:[new File(['x'],'bad.svg',{type:'image/svg+xml'})]}});
    expect(screen.getByRole('alert').textContent).toMatch(/JPEG/);expect(screen.getByText('العناصر التي ستُنشأ: 1')).toBeTruthy();
  });
  it('does not propose an explicitly negated tree',()=>{
    setup();fireEvent.click(screen.getByText('إنشاء مشهد تقريبي من صورة ووصف'));
    fireEvent.change(screen.getByLabelText('وصف عناصر الصورة'),{target:{value:'بدون شجرة'}});
    expect(screen.queryByText('عناصر تعرّف عليها الوصف؛ اختر نوعاً ثم حدّد مكانه:')).toBeNull();
  });
});
