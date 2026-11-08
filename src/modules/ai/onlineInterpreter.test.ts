import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretOnline, searchImageReferences, searchWikiArticles } from './onlineInterpreter';
const emptyKnowledge = { version: 1, cursor: 0, status: 'starting', classes: {
  desert: { docs: 0, tokens: {} }, forest: { docs: 0, tokens: {} }, mountains: { docs: 0, tokens: {} }, island: { docs: 0, tokens: {} },
}, sources: [] };
const emptyHouse = { version: 1, cursor: 0, status: 'starting', samples: 0, last_loss: null, sources: [], profiles: Object.fromEntries(['default', 'small', 'tall', 'wide'].map(key => [key, {count: 0, mean: [1, 1, 1, 1]}])) };
const house = () => new Response(JSON.stringify(emptyHouse));
const knowledge = () => new Response(JSON.stringify(emptyKnowledge));
afterEach(() => vi.unstubAllGlobals());
describe('lightweight local planning and Wikipedia', () => {
  it('only returns bounded snippets from actual Wikipedia links when searching the notebook', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [
      { title: 'Oasis', url: 'https://en.wikipedia.org/wiki/Oasis', content: 'x'.repeat(2000) },
      { title: 'Unsafe', url: 'https://en.wikipedia.org.evil.example/wiki/a', content: 'x' },
      { title: 'Credentials', url: 'https://u@en.wikipedia.org/wiki/a', content: 'x' },
    ] }))));
    const articles = await searchWikiArticles('oasis');
    expect(articles).toHaveLength(1);
    expect(articles[0]!.content).toHaveLength(1200);
    await expect(searchWikiArticles('')).rejects.toThrow();
  });
  it('validates image search responses and reports an old phone server', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ results: [{
      title: 'File:X.jpg', url: 'https://commons.wikimedia.org/wiki/File:X.jpg',
      thumbnail: 'https://evil.example/x.jpg', author: 'a', license_name: 'CC BY 4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    }] }))).mockResolvedValueOnce(new Response('', { status: 404, headers: { 'X-World-Builder-Proxy': '1' } }));
    vi.stubGlobal('fetch', mock);
    await expect(searchImageReferences('x')).rejects.toThrow('بيانات غير صالحة');
    await expect(searchImageReferences('x')).rejects.toThrow('خادم الهاتف الجديد');
  });
  it('requires internet, reads the learning state, and uses no LLM', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(knowledge()).mockResolvedValueOnce(house());
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت على يمين شجرة و 3 صخور', { seed: 12 });
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/knowledge', '/api/house-learning']);
    expect(result.searched).toBe(false);
    expect(result.intent.assets?.map((x) => [x.assetId, x.count])).toEqual([['house', 1], ['tree', 1], ['boulder', 3]]);
    expect(result.wikiLearning?.status).toBe('starting');
  });
  it('searches Wikipedia on request and uses a limited safe biome hint', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(knowledge()).mockResolvedValueOnce(house()).mockResolvedValueOnce(new Response(JSON.stringify({ results: [
      { title: 'Place', url: 'https://en.wikipedia.org/wiki/Place', content: 'A desert landmark' },
      { title: 'Unsafe', url: 'javascript:alert(1)', content: 'ignored' },
      { title: 'Other site', url: 'https://example.com/', content: 'ignored' },
    ] })));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('ابحث عن مكان', { seed: 2 });
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/knowledge', '/api/house-learning', '/api/search']);
    expect(result.intent.biome).toBe('desert');
    expect(result.sources).toEqual([{ title: 'Place', url: 'https://en.wikipedia.org/wiki/Place' }]);
    expect(result.searched).toBe(true);
  });
  it('uses persisted word associations from the background learner', async () => {
    const learned = { ...emptyKnowledge, status: 'learning', classes: { ...emptyKnowledge.classes,
      desert: { docs: 1, tokens: { 'واحات': 1 } } }, sources: [{ label: 'desert', title: 'واحة', url: 'https://ar.wikipedia.org/wiki/واحة' }] };
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(new Response(JSON.stringify(learned))).mockResolvedValueOnce(house());
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت في الواحات', { seed: 5 });
    expect(result.intent.biome).toBe('desert');
    expect(result.wikiLearning?.used).toBe(true);
    expect(result.wikiLearning?.documents).toBe(1);
    expect(result.wikiLearning?.sources[0]?.url).toContain('wikipedia.org/wiki/');
  });
  it('manual search preserves the user biome', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(knowledge()).mockResolvedValueOnce(house()).mockResolvedValueOnce(new Response(JSON.stringify({ results: [
      { title: 'x', url: 'https://ar.wikipedia.org/wiki/X', content: 'صحراء' },
    ] })));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت في غابة', {}, true);
    expect(result.intent.biome).toBe('forest');
    expect(result.searched).toBe(true);
  });
  it('never silently falls back on internet or requested search errors', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 })); vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockReset().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(knowledge()).mockResolvedValueOnce(house()).mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(interpretOnline('ابحث عن مدينة')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('warns when saved learning state is unavailable and rejects false connectivity', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(house()); vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت');
    expect(result.notes?.join()).toContain('تعذّر قراءة حالة');
    mock.mockResolvedValueOnce(new Response('{"online":false}'));
    await expect(interpretOnline('بيت')).rejects.toThrow('التحقق');
  });
});
