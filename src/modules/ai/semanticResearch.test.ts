import { beforeEach, describe, expect, it, vi } from 'vitest';
import { researchDetectedClasses } from './semanticResearch';
const mocks=vi.hoisted(()=>({wiki:vi.fn(),images:vi.fn(),read:vi.fn()}));
vi.mock('./onlineInterpreter',()=>({searchWikiArticlePage:mocks.wiki,searchImageReferencePage:mocks.images,readWikiArticle:mocks.read}));
const article={title:'tree',url:'https://en.wikipedia.org/wiki/Tree',content:'a tree'};
beforeEach(()=>{vi.clearAllMocks();mocks.wiki.mockResolvedValue({results:[article],next:null});mocks.images.mockResolvedValue({results:[],next:null});mocks.read.mockResolvedValue(article);});
describe('automatic research',()=>{
  it('searches both sources for every unique class and reads only an exact article',async()=>{
    const progress=vi.fn(),result=await researchDetectedClasses(['tree','tree','rock'],new AbortController().signal,progress);
    expect(result.map(r=>r.label)).toEqual(['tree','rock']);expect(mocks.wiki).toHaveBeenCalledTimes(2);expect(mocks.images).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(1);expect(result[1]?.article).toBeNull();expect(progress).toHaveBeenLastCalledWith(2,2);
  });
  it('reports failed sources and refuses to substitute a mismatched article',async()=>{
    mocks.images.mockRejectedValue(new Error('offline'));mocks.read.mockResolvedValue({...article,title:'other'});
    const result=await researchDetectedClasses(['tree'],new AbortController().signal);
    expect(result[0]?.article).toEqual(article);expect(result[0]?.errors).toHaveLength(2);
  });
  it('stops after cancellation without requesting more classes',async()=>{
    const c=new AbortController();mocks.wiki.mockImplementation(async()=>{c.abort();return {results:[]};});
    await expect(researchDetectedClasses(['tree','rock','house'],c.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(mocks.wiki.mock.calls.length).toBeLessThan(3);
  });
});
