// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {EditorProvider,useEditor} from '../store';
import {createEmptyWorldPlan} from '../../../core/world-plan/factory';
import {LibraryWorldComposer} from './LibraryWorldComposer';
import type {CloudWorldItem} from '../../ai/cloudWorld';

const models=[{id:'123',version:'1',slug:'red-tree',title:'Red tree',triangles:200},{id:'124',version:'2',slug:'robot',title:'Robot',triangles:90}];
function model(){return new Response(readFileSync('src/test/fixtures/trimesh-vertex-colors.glb'),{headers:{'Content-Type':'model/gltf-binary'}});}
function Observer(){const {state,dispatch}=useEditor();return <><output data-testid="plan">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function items():CloudWorldItem[]{return [{id:'a',prompt:'tree',x:-5,z:0,size:4,height:0},{id:'b',prompt:'robot',x:5,z:0,size:4,height:0}];}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('CC0 model map composer',()=>{
  it('requires explicit search and selection, downloads selected models then applies atomically with undo',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});const calls:{url:string;body:any}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,opts:RequestInit)=>{const body=JSON.parse(opts.body as string);calls.push({url,body});return url.endsWith('/search')?Response.json({results:[models[body.query==='tree'?0:1]]}):model();}));
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items()} initialPlan={before} description="tree and robot" mode="text" onClose={()=>{}}/><Observer/></EditorProvider>);
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'تحميل المجسمات وبناء الخريطة'}));
    expect(screen.getByRole('alert').textContent).toContain('اختر مجسماً');expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 1'}));
    await screen.findByText(/Red tree · 200 مثلث/);fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 2'}));
    await screen.findByText(/Robot · 90 مثلث/);fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    expect(calls.map(c=>c.url)).toEqual(['/api/asset-library/search','/api/asset-library/search']);
    fireEvent.click(screen.getByRole('button',{name:'تحميل المجسمات وبناء الخريطة'}));
    await screen.findByText(/أُضيفت 2 مجسمات جاهزة/);
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);
    expect(plan.objects).toHaveLength(2);expect(plan.objects.map((o:any)=>o.meta.source)).toEqual(['library','library']);
    expect(plan.objects[0].transform.position).not.toEqual(plan.objects[1].transform.position);
    expect(calls.slice(2).map(c=>c.body)).toEqual([{id:'123',version:'1'},{id:'124',version:'2'}]);
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  },20000);
  it('downloads the same selected asset only once in a batch and places both copies',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});let downloads=0;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.endsWith('/search'))return Response.json({results:[models[0]]});downloads++;return model();}));
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items()} initialPlan={before} description="two trees" mode="text" onClose={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 1'}));await screen.findByText(/Red tree · 200 مثلث/);fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 2'}));await screen.findAllByText(/Red tree · 200 مثلث/);fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    fireEvent.click(screen.getByRole('button',{name:'تحميل المجسمات وبناء الخريطة'}));await screen.findByText(/أُضيفت 2 مجسمات جاهزة/);
    expect(downloads).toBe(1);expect(JSON.parse(screen.getByTestId('plan').textContent!).objects).toHaveLength(2);
  },20000);
  it('invalidates selection on text edit and does not replace a changed map',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/search')?Response.json({results:[models[0]]}):model()));
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items().slice(0,1)} initialPlan={before} description="tree" mode="append" onClose={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 1'}));await screen.findByText(/Red tree · 200 مثلث/);
    fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    fireEvent.change(screen.getByLabelText('بحث العنصر 1'),{target:{value:'rock'}});
    expect(within(screen.getByRole('region',{name:'خطة المجسمات الجاهزة'})).queryByText(/Red tree · 200 مثلث/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'تحميل المجسمات وبناء الخريطة'}));expect(screen.getByRole('alert').textContent).toContain('اختر مجسماً');
    fireEvent.click(screen.getByRole('button',{name:'بحث عن العنصر 1'}));await screen.findByText(/Red tree · 200 مثلث/);fireEvent.click(screen.getByRole('button',{name:'اختيار هذا المجسم'}));
    fireEvent.click(screen.getByRole('button',{name:'change-test'}));fireEvent.click(screen.getByRole('button',{name:'تحميل المجسمات وبناء الخريطة'}));
    expect(screen.getByRole('alert').textContent).toContain('تغيّر العالم');expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('changed');
  });
});
