// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorProvider, useEditor } from '../store';
import { createEmptyWorldPlan } from '../../../core/world-plan/factory';
import { AiPanel } from './AiPanel';
import { initialMapTraining } from '../../ai/mapTrainer';

const trainer={model:initialMapTraining(),setEnabled:()=>{},reset:()=>{},error:''};
const initial=createEmptyWorldPlan({name:'original',seed:5});
function Observer(){const {state,dispatch}=useEditor();return <><output data-testid="plan">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function setup(){return render(<EditorProvider initialPlan={initial}><AiPanel variant="forge" mapTrainer={trainer} notify={()=>{}} onOpenStudio={()=>{}}/><Observer/></EditorProvider>);}
function modelResponse(){return new Response(readFileSync('src/test/fixtures/trimesh-vertex-colors.glb'),{headers:{'Content-Type':'model/gltf-binary'}});}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('cloud generation',()=>{
  it('sends only on explicit request, makes an editable new mesh and supports undo',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(modelResponse());vi.stubGlobal('fetch',fetchMock);setup();
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a copper robot'}});
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'توليد مجسّم جديد من الوصف'}));
    await screen.findByText(/اكتمل المجسم/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/text-to-3d');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({query:'a copper robot'});
    const plan=JSON.parse(screen.getByTestId('plan').textContent!);expect(plan.objects[0].primitive).toBe('generated-mesh');
    fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
  },20000);
  it('keeps the current world on failure instead of falling back to the library',async()=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('{"error":"service unavailable"}',{status:502})));setup();
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot'}});fireEvent.click(screen.getByRole('button',{name:'توليد مجسّم جديد من الوصف'}));
    expect((await screen.findByRole('alert')).textContent).toContain('الخدمة المجانية غير متاحة');
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
  });
  it('stops waiting without changing the world',async()=>{
    vi.stubGlobal('fetch',vi.fn((_url:string, init:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      init.signal!.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));
    })));
    setup();fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot'}});
    fireEvent.click(screen.getByRole('button',{name:'توليد مجسّم جديد من الوصف'}));
    fireEvent.click(screen.getByRole('button',{name:'إيقاف الانتظار'}));
    expect((await screen.findByRole('alert')).textContent).toContain('قد يستمر الطلب');
    expect(JSON.parse(screen.getByTestId('plan').textContent!).id).toBe(initial.id);
  });
  it('discards a late response if the world or prompt changes',async()=>{
    let finish!:(response:Response)=>void;
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));setup();
    fireEvent.change(screen.getByLabelText('وصف العالم'),{target:{value:'a robot'}});fireEvent.click(screen.getByRole('button',{name:'توليد مجسّم جديد من الوصف'}));
    fireEvent.click(screen.getByRole('button',{name:'change-test'}));finish(modelResponse());
    await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('تغيّر العالم أو الوصف'));
    expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('changed');
  });
});
