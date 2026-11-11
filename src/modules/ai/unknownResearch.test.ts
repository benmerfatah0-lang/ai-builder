import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchUnknown, unknownTopics } from './unknownResearch';

afterEach(() => vi.unstubAllGlobals());
describe('automatic research for unfamiliar terms', () => {
  it('finds an unknown thing even when a known asset is present', () => {
    expect(unknownTopics('بيت صغير وفيل قرب شجرة').terms).toEqual(['فيل']);
    expect(unknownTopics('أضف وردة بجانب البيت').terms).toEqual([]);
    expect(unknownTopics('أضف فيل بجانب البيت').terms).toEqual(['فيل']);
    expect(unknownTopics('crée une cabane').terms).toEqual(['cabane']);
    expect(unknownTopics('اصنع تاج محل').terms).toEqual(['تاج محل']);
    expect(unknownTopics('قلعة وزرافة وطائر')).toEqual({ terms: ['زرافة', 'طائر'], truncated: false });
    for (const prompt of ['بيت في الغابة', 'بيت وشجرة', 'A desert oasis village at sunset with 18 palm trees', 'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths', 'جزيرة استوائية فيها نخيل وبحر عند الغروب', 'مزرعة صغيرة فيها حظيرة وحقول قمح وجسر', 'مدينة صحراوية قديمة فيها منجم عميق للذهب بعربات ومعاول وحفارات وصناديق']) expect(unknownTopics(prompt).terms).toEqual([]);
  });
  it('looks up every detected topic even alongside known objects', async () => {
    const mock = vi.fn(async (url: string) => new Response(url === '/api/dictionary' ? '{"entries":[],"complete":true}' : '{"results":[]}'));
    vi.stubGlobal('fetch', mock);
    const result = await researchUnknown('بيت وفيل وزرافة وطائر');
    expect(result.topics.map((topic) => topic.term)).toEqual(['فيل', 'زرافة', 'طائر']);
    expect(result.truncated).toBe(false);
    expect(mock).toHaveBeenCalledTimes(9);
  });
  it('automatically searches both sources per term and reports independent failures', async () => {
    const mock = vi.fn(async (url: string, options: RequestInit) => {
      expect(JSON.parse(options.body as string).query).toBe('فيل');
      if (url === '/api/image-search') return new Response('', { status: 502 });
      if (url === '/api/dictionary') return new Response(JSON.stringify({ entries: [{ language: 'ar', partOfSpeech: 'Noun', definition: 'An elephant.' }], complete: true }));
      return new Response(JSON.stringify({ results: [{ title: 'فيل', url: 'https://ar.wikipedia.org/wiki/فيل', content: 'حيوان' }] }));
    });
    vi.stubGlobal('fetch', mock);
    const report = await researchUnknown('بيت وفيل');
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/search', '/api/image-search', '/api/dictionary', '/api/wiki-article']);
    expect(report.topics[0]?.articles[0]?.title).toBe('فيل');
    expect(report.topics[0]?.wikiError).toBeNull();
    expect(report.topics[0]?.dictionary?.entries[0]?.definition).toBe('An elephant.');
    expect(report.topics[0]?.imageError).toContain('تعذّر البحث');
    expect((await researchUnknown('بيت وشجرة')).topics).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('skips dictionary requests for phrases while other sources can still respond', async () => {
    const mock = vi.fn(async () => new Response('{"results":[]}'));
    vi.stubGlobal('fetch', mock);
    const report = await researchUnknown('اصنع تاج محل');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(report.topics[0]?.dictionaryError).toContain('كلمة واحدة');
    expect(report.topics[0]?.wikiError).toBeNull();
  });

  it('falls back to the exact article’s linked English title for an empty Arabic Commons search', async () => {
    const image = { title: 'File:Elephant.png', url: 'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    const queries: [string, string][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      const q = JSON.parse(options.body as string).query; queries.push([url, q]);
      if (url === '/api/search') return new Response(JSON.stringify({ results: [{ title: 'فيل', url: 'https://ar.wikipedia.org/wiki/فيل', content: 'حيوان' }] }));
      if (url === '/api/translate-en') return new Response('{"title":"Elephant"}');
      if (url === '/api/image-search') return new Response(JSON.stringify(q === 'Elephant' ? { results: [image], next: 15 } : {results: [], next: null}));
      return new Response('{"entries":[],"complete":true}');
    }));
    const result = await researchUnknown('أضف فيل');
    expect(queries).toContainEqual(['/api/translate-en', 'فيل']);
    expect(queries).toContainEqual(['/api/image-search', 'Elephant']);
    expect(result.topics[0]?.imageQuery).toBe('Elephant');
    expect(result.topics[0]?.imageNext).toBe(15);
    expect(result.topics[0]?.images[0]?.query).toBe('Elephant');
  });
  it('searches in a bounded worker pool, reports progress and aborts without launching the remainder', async () => {
    const controller = new AbortController();
    let active=0, max=0, calls=0;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls++; active++; max = Math.max(max, active);
      const timer=setTimeout(() => { active--; resolve(new Response('{"results":[]}')); }, 30);
      options.signal?.addEventListener('abort', () => { clearTimeout(timer); active--; reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
    })));
    const progress: number[] = [];
    const pending = researchUnknown('قلعة وزرافة وطائر وفيل وقرد', { signal: controller.signal, onProgress: (_r, done) => { progress.push(done); controller.abort(); } });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toEqual([1]);
    expect(max).toBeLessThanOrEqual(6);
    expect(calls).toBeLessThan(15);
  });

  it('reads an exact article introduction and falls back to its snippet on error', async () => {
    const result = { title:'فيل', url:'https://ar.wikipedia.org/wiki/فيل', content:'مقدمة المقال الفعلية' };
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/search') return new Response(JSON.stringify({results:[{...result,content:'مقتطف بحث'}]}));
      if (url === '/api/wiki-article') return new Response(JSON.stringify({article:result}));
      if (url === '/api/image-search') return new Response('{"results":[]}');
      if (url === '/api/translate-en') return new Response('{"title":null}');
      return new Response('{"entries":[],"complete":true}');
    });
    vi.stubGlobal('fetch', mock);
    const report = await researchUnknown('فيل');
    expect(report.topics[0]?.articles[0]?.content).toBe('مقدمة المقال الفعلية');
    expect(report.topics[0]?.articleNotice).toContain('مقدمة المقالة');
    mock.mockImplementation(async (url: string) => {
      if (url === '/api/search') return new Response(JSON.stringify({results:[{...result,content:'مقتطف بحث'}]}));
      if (url === '/api/wiki-article') return new Response('{}');
      if (url === '/api/image-search') return new Response('{"results":[]}');
      if (url === '/api/translate-en') return new Response('{"title":null}');
      return new Response('{"entries":[],"complete":true}');
    });
    const fallback = await researchUnknown('فيل');
    expect(fallback.topics[0]?.articles[0]?.content).toBe('مقتطف بحث');
    expect(fallback.topics[0]?.articleNotice).toContain('تعذّر قراءة مقدمة');
  });

  it('tries the linked English title when the first Arabic page has no usable images but has a continuation', async () => {
    const image = { title:'File:Elephant.png', url:'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author:'Alice', license_url:'https://creativecommons.org/licenses/by/4.0/', license_name:'CC BY 4.0' };
    let englishHasResults = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit) => {
      const query = JSON.parse(opts.body as string).query;
      if (url === '/api/search') return new Response(JSON.stringify({results:[{title:'فيل', url:'https://ar.wikipedia.org/wiki/فيل', content:'حيوان'}]}));
      if (url === '/api/translate-en') return new Response('{"title":"Elephant"}');
      if (url === '/api/image-search') return new Response(JSON.stringify(query === 'Elephant' ? {results:englishHasResults ? [image] : [], next:30} : {results:[], next:15}));
      return new Response('{"entries":[],"complete":true}');
    }));
    const found = await researchUnknown('فيل');
    expect(found.topics[0]?.imageQuery).toBe('Elephant');
    expect(found.topics[0]?.images).toHaveLength(1);
    englishHasResults = false;
    const empty = await researchUnknown('فيل');
    expect(empty.topics[0]?.imageQuery).toBe('فيل');
    expect(empty.topics[0]?.imageNext).toBe(15);
    expect(empty.topics[0]?.imageNotice).toContain('لم تظهر صور');
  });

});
