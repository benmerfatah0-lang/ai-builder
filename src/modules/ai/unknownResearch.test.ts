import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchUnknown, unknownTopics } from './unknownResearch';

afterEach(() => vi.unstubAllGlobals());
describe('automatic research for unfamiliar terms', () => {
  it('finds an unknown thing even when a known asset is present', () => {
    expect(unknownTopics('بيت صغير وفيل قرب شجرة').terms).toEqual(['فيل']);
    expect(unknownTopics('أضف وردة بجانب البيت').terms).toEqual(['وردة']);
    expect(unknownTopics('اصنع تاج محل').terms).toEqual(['تاج محل']);
    expect(unknownTopics('قلعة وزرافة وطائر')).toEqual({ terms: ['قلعة', 'زرافة'], truncated: true });
    for (const prompt of ['بيت في الغابة', 'بيت وشجرة', 'A desert oasis village at sunset with 18 palm trees', 'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths', 'جزيرة استوائية فيها نخيل وبحر عند الغروب', 'مزرعة صغيرة فيها حظيرة وحقول قمح وجسر', 'مدينة صحراوية قديمة فيها منجم عميق للذهب بعربات ومعاول وحفارات وصناديق']) expect(unknownTopics(prompt).terms).toEqual([]);
  });
  it('looks up at most two separate unknown topics even alongside known objects', async () => {
    const mock = vi.fn(async () => new Response('{"results":[]}'));
    vi.stubGlobal('fetch', mock);
    const result = await researchUnknown('بيت وفيل وزرافة وطائر');
    expect(result.topics.map((topic) => topic.term)).toEqual(['فيل', 'زرافة']);
    expect(result.truncated).toBe(true);
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('automatically searches both sources per term and reports independent failures', async () => {
    const mock = vi.fn(async (url: string, options: RequestInit) => {
      expect(JSON.parse(options.body as string).query).toBe('فيل');
      if (url === '/api/image-search') return new Response('', { status: 502 });
      return new Response(JSON.stringify({ results: [{ title: 'فيل', url: 'https://ar.wikipedia.org/wiki/فيل', content: 'حيوان' }] }));
    });
    vi.stubGlobal('fetch', mock);
    const report = await researchUnknown('بيت وفيل');
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/search', '/api/image-search']);
    expect(report.topics[0]?.articles[0]?.title).toBe('فيل');
    expect(report.topics[0]?.wikiError).toBeNull();
    expect(report.topics[0]?.imageError).toContain('تعذّر البحث');
    expect((await researchUnknown('بيت وشجرة')).topics).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
