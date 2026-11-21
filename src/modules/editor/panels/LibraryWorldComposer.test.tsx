// @vitest-environment happy-dom
import {readFileSync} from 'node:fs';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {StrictMode} from 'react';
import {EditorProvider,useEditor} from '../store';
import {createEmptyWorldPlan} from '../../../core/world-plan/factory';
import {LibraryWorldComposer} from './LibraryWorldComposer';
import {ReplaceOnlineModel} from './ReplaceOnlineModel';
import type {CloudWorldItem} from '../../ai/cloudWorld';

const model1={source:'3dassets',id:'123',version:'1',slug:'red-tree',title:'Red tree',triangles:200};
const model2={source:'gobkit',id:'TreeLow004',version:'1',slug:'nature-kit',title:'TreeLow 004',triangles:null};
function glb(){return new Response(readFileSync('src/test/fixtures/trimesh-vertex-colors.glb'),{headers:{'Content-Type':'model/gltf-binary'}});}
function Observer(){const {state,dispatch}=useEditor();return <><output data-testid="plan">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function items():CloudWorldItem[]{return [{id:'a',prompt:'tree',x:-5,z:0,size:4,height:0},{id:'b',prompt:'tree',x:5,z:0,size:4,height:0}];}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('automatic online model composition',()=>{
  it('automatically searches and uses fallback, caches downloads and supports undo under StrictMode',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});const calls:{url:string;body:any}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,opts:RequestInit)=>{const body=JSON.parse(opts.body as string);calls.push({url,body});if(url.endsWith('/search'))return Response.json({results:[model1,model2],warnings:['3DAssets.dev']});return body.source==='3dassets'?new Response('',{status:500}):glb();}));
    render(<StrictMode><EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items()} initialPlan={before} description="two trees" mode="text" onClose={()=>{}}/><Observer/></EditorProvider></StrictMode>);
    await screen.findByText(/أُضيفت 2 مجسمات جاهزة/);
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);
    expect(plan.objects).toHaveLength(2);expect(plan.objects.map((o:any)=>o.name)).toEqual(['tree','tree 2']);expect(plan.objects[0].transform.position).not.toEqual(plan.objects[1].transform.position);
    expect(calls.filter(c=>c.url.endsWith('/search'))).toHaveLength(1);
    expect(calls.filter(c=>c.url.endsWith('/model')&&c.body.source==='gobkit')).toHaveLength(1);
    expect(screen.getByText(/تعذّر الاتصال بهذه المصادر/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  },20000);
  it('never applies a partial scene when a model is unavailable',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});
    vi.stubGlobal('fetch',vi.fn(async(url:string,opts:RequestInit)=>url.endsWith('/search')?Response.json({results:JSON.parse(opts.body as string).query==='tree'?[model1]:[],warnings:[]}):glb()));
    const list=items();list[1]!.prompt='robot';
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={list} initialPlan={before} description="tree and robot" mode="text" onClose={()=>{}}/><Observer/></EditorProvider>);
    expect((await screen.findByRole('alert')).textContent).toContain('لم أجد');
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(before.id);
  });
  it('replaces an exactly named object, preserves transform and supports undo',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/search')?Response.json({results:[model1],warnings:[]}):glb()));
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items().slice(0,1)} initialPlan={before} description="tree" mode="text" onClose={()=>{}}/><ReplaceOnlineModel/><Observer/></EditorProvider>);
    await screen.findByText(/أُضيفت 1 مجسمات جاهزة/);
    const original=JSON.parse(screen.getByTestId('plan').textContent!).objects[0];
    fireEvent.change(screen.getByLabelText('اسم المجسم الحالي'),{target:{value:'tree'}});
    fireEvent.change(screen.getByLabelText('اسم المجسم البديل'),{target:{value:'rock'}});
    fireEvent.click(screen.getByRole('button',{name:'ابحث واستبدل المجسم'}));
    await screen.findByText(/استُبدل «tree»/);
    const next=JSON.parse(screen.getByTestId('plan').textContent!).objects[0];
    expect(next.id).toBe(original.id);expect(next.transform).toEqual(original.transform);
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).objects[0]).toEqual(original);
  },20000);
  it('does not apply a replacement if the world changes while loading',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});let release!:(value:Response)=>void;let delaying=false;
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.endsWith('/search'))return Response.json({results:[model1],warnings:[]});if(delaying)return new Promise<Response>(resolve=>{release=resolve;});return glb();}));
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items().slice(0,1)} initialPlan={before} description="tree" mode="text" onClose={()=>{}}/><ReplaceOnlineModel/><Observer/></EditorProvider>);
    await screen.findByText(/أُضيفت 1 مجسمات جاهزة/);delaying=true;
    fireEvent.change(screen.getByLabelText('اسم المجسم الحالي'),{target:{value:'tree'}});fireEvent.change(screen.getByLabelText('اسم المجسم البديل'),{target:{value:'rock'}});fireEvent.click(screen.getByRole('button',{name:'ابحث واستبدل المجسم'}));
    await waitFor(()=>expect(release).toBeDefined());fireEvent.click(screen.getByRole('button',{name:'change-test'}));release(glb());
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('تغيّر العالم'));
    expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('changed');
  });
  it('does not replace an ambiguous name',async()=>{
    const before=createEmptyWorldPlan({name:'original',seed:4});
    const fetcher=vi.fn(async(url:string)=>url.endsWith('/search')?Response.json({results:[model1],warnings:[]}):glb());vi.stubGlobal('fetch',fetcher);
    // Duplicate names can still exist in older/imported projects.
    render(<EditorProvider initialPlan={before}><LibraryWorldComposer initialItems={items()} initialPlan={before} description="trees" mode="text" onClose={()=>{}}/><MakeDuplicate/><ReplaceOnlineModel/></EditorProvider>);
    await screen.findByText(/أُضيفت 2 مجسمات جاهزة/);fireEvent.click(screen.getByRole('button',{name:'duplicate-name-test'}));
    fireEvent.change(screen.getByLabelText('اسم المجسم الحالي'),{target:{value:'tree'}});fireEvent.change(screen.getByLabelText('اسم المجسم البديل'),{target:{value:'rock'}});
    fireEvent.click(screen.getByRole('button',{name:'ابحث واستبدل المجسم'}));expect(screen.getByRole('alert').textContent).toContain('أكثر من مجسم');
  });
});
function MakeDuplicate(){const {state,dispatch}=useEditor();return <button onClick={()=>{const obj=state.plan.objects[1];if(obj)dispatch({type:'renameNode',id:obj.id,name:'tree'});}}>duplicate-name-test</button>;}
