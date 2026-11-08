// @vitest-environment happy-dom
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
});
