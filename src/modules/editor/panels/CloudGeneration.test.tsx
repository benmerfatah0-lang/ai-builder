// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {EditorProvider,useEditor} from '../store';
import {createEmptyWorldPlan} from '../../../core/world-plan/factory';
import {AiPanel} from './AiPanel';
import {initialMapTraining} from '../../ai/mapTrainer';
import {createTerrainSampler} from '../../../core/generation/terrain';
const mocked=vi.hoisted(()=>({vision:vi.fn()}));
vi.mock('../../ai/localVision',()=>({localSceneVision:mocked.vision}));
const trainer={model:initialMapTraining(),setEnabled:()=>{},reset:()=>{},error:''};
const initial=createEmptyWorldPlan({name:'original',seed:5});
const item={source:'3dassets',id:'123',version:'1',slug:'tree',title:'Tree',triangles:200};
function Observer(){const {state,dispatch}=useEditor();return <><output data-testid="plan">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function setup(){return render(<EditorProvider initialPlan={initial}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}} onOpenStudio={()=>{}}/><Observer/></EditorProvider>);}
function model(){return new Response(readFileSync('src/test/fixtures/trimesh-vertex-colors.glb'),{headers:{'Content-Type':'model/gltf-binary'}});}
function api(calls:{url:string;body:any}[]){return vi.fn(async(url:string,opts:RequestInit)=>{const body=JSON.parse(opts.body as string);calls.push({url,body});return url.endsWith('/search')?Response.json({results:[item],warnings:[]}):model();});}
function labels(){const out=new Uint8Array(4096).fill(2);for(let y=4;y<16;y++)for(let x=1;x<15;x++)out[y*64+x]=16;for(let y=20;y<30;y++)for(let x=0;x<20;x++)out[y*64+x]=60;for(let y=35;y<50;y++)for(let x=2;x<18;x++)out[y*64+x]=4;for(let y=40;y<55;y++)for(let x=40;x<58;x++)out[y*64+x]=20;return out;}
beforeEach(()=>{
 vi.stubGlobal('Image',class {naturalWidth=24;naturalHeight=24;onload:(()=>void)|null=null;onerror:(()=>void)|null=null;set src(_v:string){queueMicrotask(()=>this.onload?.());}});
 vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
 mocked.vision.mockReset().mockResolvedValue(labels());
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('unified world creation',()=>{
 it('builds local island and water plus every counted model automatically and undoes',async()=>{
  const calls:{url:string;body:any}[]=[];vi.stubGlobal('fetch',api(calls));setup();
  fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'جزيرة فيها بحر و٣ أشجار وشجرتين'}});
  expect(calls).toHaveLength(0);fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));
  await screen.findByText(/أُضيفت 5 مجسمات جاهزة/);
  const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.terrain.style).toBe('islands');expect(plan.terrain.waterLevel).not.toBeNull();
  expect(plan.objects).toHaveLength(5);expect(new Set(plan.objects.map((o:any)=>o.id)).size).toBe(5);
  expect(calls.filter(c=>c.url.endsWith('/search')).map(c=>c.body.query)).toEqual(['tree']);
  expect(calls.filter(c=>c.url.endsWith('/model'))).toHaveLength(1);expect(mocked.vision).not.toHaveBeenCalled();
  const terrain=createTerrainSampler(plan.terrain,plan.seed);for(const o of plan.objects)expect(terrain.heightAt(o.transform.position[0],o.transform.position[2])).toBeGreaterThanOrEqual(plan.terrain.waterLevel+.35);
  fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
 },20000);
 it('builds an actual river and valley locally even when there are no model nouns',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);setup();fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'وادي مع نهر'}});fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));
  await screen.findByText(/أُنشئت التضاريس والمياه المطلوبة/);const plan=JSON.parse(screen.getByTestId('plan').textContent!);
  expect(plan.terrain.style).toBe('valley');expect(plan.objects.some((o:any)=>o.kind==='river')).toBe(true);expect(fetcher).not.toHaveBeenCalled();
 });
 it('uses image and text together with one button and never sends image bytes',async()=>{
  const calls:{url:string;body:any}[]=[];vi.stubGlobal('fetch',api(calls));setup();
  fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'3 trees'}});
  fireEvent.change(screen.getByLabelText('صورة العالم الاختيارية'),{target:{files:[new File(['secret-pixels'],'scene.png',{type:'image/png'})]}});
  fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));await screen.findByText(/أُضيفت 4 مجسمات جاهزة/);
  const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.terrain.style).toBe('mountains');expect(plan.objects.filter((o:any)=>o.kind==='river')).toHaveLength(1);
  expect(plan.objects.filter((o:any)=>o.kind==='primitive')).toHaveLength(4);
  expect(calls.filter(c=>c.url.endsWith('/search')).map(c=>c.body.query)).toEqual(['tree','car']);
  expect(JSON.stringify(calls)).not.toContain('secret-pixels');expect(JSON.stringify(calls)).not.toContain('scene.png');expect(mocked.vision).toHaveBeenCalledOnce();
 },20000);
 it('builds from an image alone without a second creation button',async()=>{
  const calls:{url:string;body:any}[]=[];vi.stubGlobal('fetch',api(calls));setup();
  fireEvent.change(screen.getByLabelText('صورة العالم الاختيارية'),{target:{files:[new File(['x'],'scene.png',{type:'image/png'})]}});
  fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));await screen.findByText(/أُضيفت 2 مجسمات جاهزة/);
  const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.terrain.style).toBe('mountains');expect(plan.objects.filter((o:any)=>o.kind==='river')).toHaveLength(1);
  expect(plan.objects.filter((o:any)=>o.kind==='primitive')).toHaveLength(2);
 });
 it('accepts an image alone and reports a missing vision model without changing the world',async()=>{
  mocked.vision.mockRejectedValue(new Error('نموذج الرؤية غير مثبت'));setup();
  fireEvent.change(screen.getByLabelText('صورة العالم الاختيارية'),{target:{files:[new File(['x'],'scene.png',{type:'image/png'})]}});
  fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));expect((await screen.findByRole('alert')).textContent).toContain('غير مثبت');
  expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
 });
 it('does not apply a stale result or an incomplete batch',async()=>{
  let finish!:(response:Response)=>void;vi.stubGlobal('fetch',vi.fn((url:string)=>url.endsWith('/model')?Promise.resolve(model()):new Promise<Response>(resolve=>{finish=resolve;})));setup();
  fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot and a car'}});fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));
  await waitFor(()=>expect(finish).toBeDefined());fireEvent.click(screen.getByRole('button',{name:'change-test'}));finish(Response.json({results:[item],warnings:[]}));
  await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('تغيّر العالم'));
  expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('changed');
 },20000);
 it('rejects oversized counts rather than silently reducing them to one model',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);setup();fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'20 robots'}});fireEvent.click(screen.getByRole('button',{name:'إنشاء العالم'}));
  expect((await screen.findByRole('alert')).textContent).toContain('الحد');expect(fetcher).not.toHaveBeenCalled();
 });
});
