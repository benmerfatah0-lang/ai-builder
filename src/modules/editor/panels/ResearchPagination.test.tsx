// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ResearchResults } from './ResearchResults';
import { PhotoStudio } from './PhotoStudio';
import type { TopicResearch } from '../../ai/unknownResearch';

const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
const topic: TopicResearch = { term: 'فيل', articles: [{ title:'فيل', url:'https://ar.wikipedia.org/wiki/فيل', content:'حيوان' }], images: [{ ...image('One'), query:'Elephant' }], imageQuery:'Elephant', articleNext:20, imageNext:15, wikiError:null, imageError:null };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('paged search UI', () => {
  it('loads additional article and image pages and uses the translated query', async () => {
    const mock=vi.fn(async (url: string, opts: RequestInit) => {
      const req = JSON.parse(opts.body as string);
      if (url === '/api/search') { expect(req.offset).toBe(20); return new Response(JSON.stringify({results:[{title:'فيل آخر',url:'https://ar.wikipedia.org/wiki/فيل_آخر',content:'آخر'}],next:40})); }
      expect(req.query).toBe('Elephant'); expect(req.offset).toBe(15);
      return new Response(JSON.stringify({results:[image('Two')],next:null}));
    });
    vi.stubGlobal('fetch', mock);
    render(<ResearchResults report={{topics:[topic],truncated:false}} busy={false}/>);
    fireEvent.click(screen.getByRole('button',{name:'المزيد من المقالات'}));
    expect(await screen.findByRole('link',{name:'فيل آخر ↗'})).toBeTruthy();
    expect(screen.getByRole('button',{name:'المزيد من المقالات'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'المزيد من الصور'}));
    expect(await screen.findByRole('link',{name:'File:Two.png ↗'})).toBeTruthy();
    expect(screen.queryByRole('button',{name:'المزيد من الصور'})).toBeNull();
    expect(screen.getByRole('link',{name:'File:One.png ↗'})).toBeTruthy();
  });
  it('does not automatically pick a lone first-page image when more pages exist', async () => {
    const bytes=new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255],(y*12+x)*4);
    const mock=vi.fn(async (url: string, opts: RequestInit) => {
      if (url === '/api/image-search') { expect(JSON.parse(opts.body as string)).toEqual({query:'Elephant',offset:15}); return new Response(JSON.stringify({results:[image('Two')],next:null})); }
      return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
    });
    vi.stubGlobal('fetch', mock);
    const complete=vi.fn();
    render(<PhotoStudio topic={topic} onComplete={complete} onCancel={() => {}} />);
    expect(mock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'المزيد من الصور'}));
    const studio = screen.getByRole('region',{name:'استوديو تقريب الصورة'});
    const candidate = await within(studio).findByRole('button',{name:/File:Two.png/});
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(0);
    fireEvent.click(candidate);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce(),{timeout:4000});
    expect(complete.mock.calls[0]![0].source.title).toBe('File:Two.png');
  });
  it('loads each image through the local proxy, falls back visibly, and allows retry and selection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"width":12,"height":12,"rgba":""}')));
    render(<PhotoStudio topic={topic} onComplete={() => {}} onCancel={() => {}} />);
    const studio = screen.getByRole('region', {name:'استوديو تقريب الصورة'});
    const img = within(studio).getByRole('img', {name:'File:One.png'}) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/image-thumbnail?url=' + encodeURIComponent(topic.images[0]!.thumbnail));
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe(topic.images[0]!.thumbnail);
    fireEvent.error(img);
    expect(within(studio).getByText(/تعذّر عرض الصورة/)).toBeTruthy();
    expect(within(studio).getByRole('link', {name:'افتح صفحة الصورة في Wikimedia ↗'}).getAttribute('href')).toBe(topic.images[0]!.url);
    fireEvent.click(within(studio).getByRole('button', {name:'إعادة تحميل الصور'}));
    expect((within(studio).getByRole('img', {name:'File:One.png'}) as HTMLImageElement).getAttribute('src')).toContain('/api/image-thumbnail?url=');
    expect(within(studio).getByRole('button', {name:/File:One.png/})).toBeTruthy();
  });
  it('tries a second page automatically when the first has no usable images', async () => {
    const mock = vi.fn(async (_url: string, opts: RequestInit) => {
      expect(JSON.parse(opts.body as string)).toEqual({query:'Elephant',offset:15});
      return new Response(JSON.stringify({results:[image('Two')],next:null}));
    });
    vi.stubGlobal('fetch', mock);
    render(<PhotoStudio topic={{...topic,images:[]}} onComplete={() => {}} onCancel={() => {}} />);
    expect(await screen.findByRole('button', {name:/File:Two.png/})).toBeTruthy();
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('offers a retry when a follow-up image page fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', {status:502})));
    render(<PhotoStudio topic={{...topic,images:[]}} onComplete={() => {}} onCancel={() => {}} />);
    expect(await screen.findByText(/يمكنك إعادة المحاولة/)).toBeTruthy();
    expect(screen.getByRole('button', {name:'المزيد من الصور'})).toBeTruthy();
  });

  it('still loads the empty first page follow-up under React StrictMode', async () => {
    const mock = vi.fn((_url: string, opts: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({results:[image('Two')],next:null}))), 20);
      opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); }, {once:true});
    }));
    vi.stubGlobal('fetch', mock);
    render(<StrictMode><PhotoStudio topic={{...topic,images:[]}} onComplete={() => {}} onCancel={() => {}} /></StrictMode>);
    expect(await screen.findByRole('button', {name:/File:Two.png/})).toBeTruthy();
    expect(screen.queryByText(/يمكنك إعادة المحاولة/)).toBeNull();
  });

  it('lets the user outline a complex background and builds only after confirmation', async () => {
    const bytes=new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [(x+y)%2?0:255,255,0,255],(y*12+x)*4);
    vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}))));
    const complete=vi.fn();
    render(<PhotoStudio topic={{...topic,imageNext:null}} onComplete={complete} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button',{name:/File:One.png/}));
    expect(await screen.findByText(/خلفية الصورة معقدة/)).toBeTruthy();
    const picture=screen.getByRole('img',{name:'صورة لتحديد حدود الجسم'});
    vi.spyOn(picture,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:120,height:120,right:120,bottom:120,x:0,y:0,toJSON:()=>({})});
    for (const [x,y] of [[30,20],[90,20],[90,100],[30,100]]) fireEvent.click(picture,{clientX:x,clientY:y});
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'بناء المحدد'}));
    await waitFor(()=>expect(complete).toHaveBeenCalledOnce(),{timeout:4000});
    expect(complete.mock.calls[0]![0].mode).toBe('manual-silhouette');
    expect(complete.mock.calls[0]![0].cells).toHaveLength(48);
  },10000);

  it('lets the user select manual mode even if automatic extraction might succeed', async () => {
    const bytes=new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255],(y*12+x)*4);
    vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}))));
    const complete=vi.fn(); render(<PhotoStudio topic={{...topic,imageNext:null}} onComplete={complete} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox',{name:/أريد تحديد حدود الجسم يدوياً/}));
    fireEvent.click(screen.getByRole('button',{name:/File:One.png/}));
    expect(await screen.findByText('تحديد الجسم يدوياً')).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
    expect((screen.getByRole('button',{name:'بناء المحدد'}) as HTMLButtonElement).disabled).toBe(true);
  });

});
