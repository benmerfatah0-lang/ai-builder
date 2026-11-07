import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretOnline } from './onlineInterpreter';

afterEach(() => vi.unstubAllGlobals());
describe('lightweight rule-based planning and Wikipedia', () => {
  it('requires internet without asking any LLM for a simple request', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('{"online":true}'));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت على يمين شجرة و 3 صخور', { seed: 12 });
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/online']);
    expect(result.searched).toBe(false);
    expect(result.intent.assets?.map((x) => [x.assetId, x.count])).toEqual([['house', 1], ['tree', 1], ['boulder', 3]]);
    expect(result.notes?.join()).toContain('كلمات محدودة');
  });
  it('searches Wikipedia only on request and uses a limited safe biome hint', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(new Response(JSON.stringify({ results: [
      { title: 'Place', url: 'https://en.wikipedia.org/wiki/Place', content: 'A desert landmark' },
      { title: 'Unsafe', url: 'javascript:alert(1)', content: 'ignored' },
      { title: 'Other site', url: 'https://example.com/', content: 'ignored' },
    ] })));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('ابحث عن مكان', { seed: 2 });
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/search']);
    expect(result.intent.biome).toBe('desert');
    expect(result.intent.prompt).toBe('ابحث عن مكان');
    expect(result.sources).toEqual([{ title: 'Place', url: 'https://en.wikipedia.org/wiki/Place' }]);
    expect(result.searched).toBe(true);
  });
  it('manual search works without keyword; user biome wins over reference hint', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(new Response(JSON.stringify({ results: [
      { title: 'x', url: 'https://ar.wikipedia.org/wiki/X', content: 'صحراء' },
    ] })));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت في غابة', {}, true);
    expect(result.intent.biome).toBe('forest');
    expect(result.searched).toBe(true);
  });
  it('does not silently fall back if internet or requested search fails', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 })); vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockReset().mockResolvedValueOnce(new Response('{"online":true}')).mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(interpretOnline('ابحث عن مدينة')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('explains an old static server and rejects false connectivity response', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 501 })); vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت')).rejects.toThrow('world-builder-server.py');
    mock.mockResolvedValueOnce(new Response('{"online":false}'));
    await expect(interpretOnline('بيت')).rejects.toThrow('التحقق');
  });
});
