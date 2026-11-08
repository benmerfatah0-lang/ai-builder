// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {EditorProvider,useEditor} from '../store';
import {createEmptyWorldPlan} from '../../../core/world-plan/factory';
import {AiPanel} from './AiPanel';
import {ImageSceneStudio} from './ImageSceneStudio';
import {initialMapTraining} from '../../ai/mapTrainer';
const mock=vi.hoisted(()=>({vision:vi.fn()}));
vi.mock('../../ai/localVision',()=>({localSceneVision:mock.vision}));
const trainer={model:initialMapTraining(),setEnabled:()=>{},reset:()=>{},error:''};
function model(){return new Response(readFileSync('src/test/fixtures/trimesh-vertex-colors.glb'),{headers:{'Content-Type':'model/gltf-binary'}});}
function Observer(){const {state,dispatch}=useEditor();return <><output data-testid="plan">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function initial(){return createEmptyWorldPlan({name:'original',seed:4});}
function labels(){const out=new Uint8Array(4096).fill(2);for(let y=10;y<30;y++)for(let x=2;x<20;x++)out[y*64+x]=4;for(let y=40;y<60;y++)for(let x=20;x<50;x++)out[y*64+x]=20;return out;}
beforeEach(()=>{
  vi.stubGlobal('Image',class {naturalWidth=24;naturalHeight=24;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray(24*24*4).fill(255)})} as unknown as CanvasRenderingContext2D);
  mock.vision.mockReset().mockResolvedValue(labels());
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('multi-object cloud workflows',()=>{
  it('sends each text object sequentially, retains success on failure, retries and undoes',async()=>{
    const before=initial();const calls:string[]=[];let attempt=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{expect(url).toBe('/api/text-to-3d');calls.push(JSON.parse(options.body as string).query);attempt++;return attempt===2?new Response('{"error":"quota"}',{status:502}):model();}));
    render(<EditorProvider initialPlan={before}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a dragon and a robot'}});
    fireEvent.click(screen.getByRole('button',{name:'تخطيط عالم من الوصف'}));
    expect(calls).toHaveLength(0);expect((screen.getByLabelText('وصف العنصر 1') as HTMLInputElement).value).toBe('a dragon');
    fireEvent.click(screen.getByRole('button',{name:'توليد العناصر وبناء العالم'}));
    expect((await screen.findByRole('alert')).textContent).toContain('احتُفظ بالعناصر المكتملة');
    expect(calls).toEqual(['A single 3D object: a dragon','A single 3D object: a robot']);
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
    fireEvent.click(screen.getByRole('button',{name:'متابعة توليد العالم'}));
    await screen.findByText(/بُنيت 2 مجسمات منفصلة/);
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.objects.map((o:{primitive:string})=>o.primitive)).toEqual(['generated-mesh','generated-mesh']);
    expect(calls).toHaveLength(3);expect(calls[2]).toBe('A single 3D object: a robot');
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  },20000);
  it('analyzes the image locally, sends labels individually, places generated meshes, and does not use library shapes',async()=>{
    const before=initial();const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{expect(url).toBe('/api/text-to-3d');calls.push(JSON.parse(options.body as string).query);return model();}));
    render(<EditorProvider initialPlan={before}><ImageSceneStudio embedded initialDescription="مشهد" initialFile={new File(['x'],'scene.png',{type:'image/png'})} mode="create" basePlan={before} canApply={()=>true}/><Observer/></EditorProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'حلّل الصورة لتوليد عناصر سحابية'}));
    const region=await screen.findByRole('region',{name:'خطة العالم السحابي'});
    expect(within(region).getAllByText(/لم يُولّد/)).toHaveLength(2);expect(calls).toHaveLength(0);expect(mock.vision).toHaveBeenCalled();
    fireEvent.click(within(region).getByRole('button',{name:'توليد العناصر وبناء العالم'}));
    await screen.findByText(/بُنيت 2 مجسمات منفصلة/);
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);
    expect(plan.objects.map((o:{primitive:string})=>o.primitive)).toEqual(['generated-mesh','generated-mesh']);
    expect(calls).toHaveLength(2);expect(calls.some(s=>s.includes('tree'))).toBe(true);expect(calls.some(s=>s.includes('car'))).toBe(true);
    expect(plan.objects[0].transform.position).not.toEqual(plan.objects[1].transform.position);
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  },20000);
  it('offers ready models based on local image analysis, and sends search text rather than image',async()=>{
    const before=initial();const calls:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{calls.push(url);expect(JSON.parse(options.body as string)).toEqual({query:'car'});return Response.json({results:[{id:'12',version:'1',slug:'tree',title:'Tree',triangles:12}]});}));
    render(<EditorProvider initialPlan={before}><ImageSceneStudio embedded initialDescription="scene" initialFile={new File(['x'],'scene.png',{type:'image/png'})} mode="create" basePlan={before} canApply={()=>true}/><Observer/></EditorProvider>);
    fireEvent.click(await screen.findByRole('button',{name:'حلّل الصورة واختر مجسمات جاهزة'}));
    const region=await screen.findByRole('region',{name:'خطة المجسمات الجاهزة'});
    expect((within(region).getByLabelText('بحث العنصر 1') as HTMLInputElement).value).toBe('car');
    expect(calls).toHaveLength(0);fireEvent.click(within(region).getByRole('button',{name:'بحث عن العنصر 1'}));
    await within(region).findByText(/Tree · 12 مثلث/);expect(calls).toEqual(['/api/asset-library/search']);
  },20000);
  it('cancels a pending batch without modifying the world',async()=>{
    const before=initial();
    vi.stubGlobal('fetch',vi.fn((_url:string, init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init.signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
    })));
    render(<EditorProvider initialPlan={before}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot and a dragon'}});
    fireEvent.click(screen.getByRole('button',{name:'تخطيط عالم من الوصف'}));
    fireEvent.click(screen.getByRole('button',{name:'توليد العناصر وبناء العالم'}));
    fireEvent.click(screen.getByRole('button',{name:'إيقاف الانتظار للعالم'}));
    expect((await screen.findByRole('alert')).textContent).toContain('توقف الانتظار');
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  });
  it('never applies late results if the world is edited while waiting',async()=>{
    const before=initial();let resolve!:(value:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(r=>{resolve=r;})));
    render(<EditorProvider initialPlan={before}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot'}});fireEvent.click(screen.getByRole('button',{name:'تخطيط عالم من الوصف'}));
    fireEvent.click(screen.getByRole('button',{name:'توليد العناصر وبناء العالم'}));fireEvent.click(screen.getByRole('button',{name:'change-test'}));resolve(model());
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('تغيّر العالم أو الوصف'));
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.name).toBe('changed');expect(plan.objects).toHaveLength(0);
  },20000);
});
