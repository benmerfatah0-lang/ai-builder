// @vitest-environment happy-dom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {EditorProvider,useEditor} from '../store';
import {createEmptyWorldPlan} from '../../../core/world-plan/factory';
import {ImageSceneStudio} from './ImageSceneStudio';
const mocked=vi.hoisted(()=>({vision:vi.fn(),research:vi.fn()}));
vi.mock('../../ai/localVision',()=>({localSceneVision:mocked.vision}));
vi.mock('../../ai/semanticResearch',()=>({researchDetectedClasses:mocked.research}));
function Observer(){const {state,dispatch}=useEditor();return <><pre data-testid="plan">{JSON.stringify(state.plan)}</pre><button onClick={()=>dispatch({type:'undo'})}>undo-test</button><button onClick={()=>dispatch({type:'renameWorld',name:'changed'})}>change-test</button></>;}
function labels(){const values=new Uint8Array(4096).fill(2);for(let y=10;y<30;y++)for(let x=2;x<20;x++)values[y*64+x]=4;for(let y=40;y<60;y++)for(let x=20;x<50;x++)values[y*64+x]=21;return values;}
async function setup(mode:'create'|'edit'='create'){
 const initial=createEmptyWorldPlan({name:'original',seed:5});const file=new File(['test'],'scene.png',{type:'image/png'});
 render(<EditorProvider initialPlan={initial}><ImageSceneStudio embedded initialDescription="غابة بكسلية" initialFile={file} mode={mode} basePlan={initial} canApply={()=>true}/><Observer/></EditorProvider>);
 await screen.findByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'});return initial;
}
beforeEach(()=>{
  vi.stubGlobal('Image',class {naturalWidth=24;naturalHeight=24;onload:()=>void=()=>{};onerror:()=>void=()=>{};set src(_v:string){queueMicrotask(()=>this.onload());}});
  vi.spyOn(URL,'createObjectURL').mockReturnValue('blob:local');vi.spyOn(URL,'revokeObjectURL').mockImplementation(()=>{});
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn(),getImageData:()=>({data:new Uint8ClampedArray(24*24*4).fill(255)})} as unknown as CanvasRenderingContext2D);
  mocked.vision.mockReset().mockResolvedValue(labels());mocked.research.mockReset().mockImplementation(async (names:string[])=>names.map(label=>({label,article:null,images:[],errors:[]})));
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('automatic scene assembly',()=>{
 it.each(['create','edit'] as const)('classifies and researches detected types, applies atomically in %s and undoes',async(mode)=>{
  const original=await setup(mode);fireEvent.click(screen.getByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'}));
  expect(await screen.findByText(/بُنيت المناطق الممكنة تلقائياً/)).toBeTruthy();
  expect(mocked.research.mock.calls[0]?.[0]).toEqual(['water','tree']);
  const next=JSON.parse(screen.getByTestId('plan').textContent!);expect(next.objects).toHaveLength(2);expect(next.objects.some((o:{kind:string})=>o.kind==='tree')).toBe(true);
  if(mode==='edit')expect(next.terrain).toEqual(original.terrain);
  fireEvent.click(screen.getByRole('button',{name:'undo-test'}));expect(JSON.parse(screen.getByTestId('plan').textContent!).name).toBe('original');
 });
 it('rejects results if world changes during asynchronous research',async()=>{
  let resolve!:(v:unknown[])=>void;mocked.research.mockReturnValue(new Promise(r=>{resolve=r;}));await setup();
  fireEvent.click(screen.getByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'}));await waitFor(()=>expect(mocked.research).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'change-test'}));resolve([]);
  expect((await screen.findByRole('alert')).textContent).toContain('تغيّر العالم أو الوصف');
  expect(JSON.parse(screen.getByTestId('plan').textContent!).objects).toHaveLength(0);
 });
 it('cancel prevents an in-flight result from mutating the world',async()=>{
  let resolve!:(value:Uint8Array)=>void;mocked.vision.mockReturnValue(new Promise(r=>{resolve=r;}));await setup();
  fireEvent.click(screen.getByRole('button',{name:'حلّل وابحث وابنِ تلقائياً'}));fireEvent.click(screen.getByRole('button',{name:'إلغاء التحليل'}));resolve(labels());
  await waitFor(()=>expect(screen.getByText(/أُلغي التحليل/)).toBeTruthy());expect(JSON.parse(screen.getByTestId('plan').textContent!).objects).toHaveLength(0);
 });
});
