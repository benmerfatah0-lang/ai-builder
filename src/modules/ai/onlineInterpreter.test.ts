import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretOnline } from './onlineInterpreter';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';

const plan = {
  biome: 'desert', timeOfDay: 'sunset', water: false, scale: 'small', style: 'stylized', density: 'normal',
  assets: [
    { assetId: 'tower', count: 1, direction: 'right', target: 1 },
    { assetId: 'palm', count: 2, direction: null, target: null },
  ], summary: 'برج ونخيل عند الغروب', limitations: ['البرج تقريبي'],
};
function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
}
function searchResponse() {
  return new Response(JSON.stringify({ results: [
    { title: 'Place', url: 'https://en.wikipedia.org/wiki/Place', content: 'A desert landmark' },
    { title: 'Unsafe', url: 'javascript:alert(1)', content: 'ignored' },
    { title: 'Other site', url: 'https://example.com/', content: 'ignored' },
  ] }));
}
afterEach(() => vi.unstubAllGlobals());
describe('local model and Wikipedia interpreter', () => {
  it('requires internet, decides to search Wikipedia and validates the result', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}'))
      .mockResolvedValueOnce(modelResponse({ query: 'desert landmark' }))
      .mockResolvedValueOnce(searchResponse()).mockResolvedValueOnce(modelResponse(plan));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('برج أثري في الصحراء', { seed: 12, scale: 'large' });
    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock.mock.calls[0]![0]).toBe('/api/online');
    expect(mock.mock.calls[1]![0]).toBe('/api/model');
    const request = JSON.parse(mock.mock.calls[1]![1].body as string);
    expect(request.model).toBe('world-builder');
    expect(request.response_format.type).toBe('json_schema');
    expect(request.response_format.json_schema.name).toBe('search_decision');
    expect(request.response_format.json_schema.schema.properties.query).toBeDefined();
    expect(request.messages[1].content).toBe('برج أثري في الصحراء');
    expect(mock.mock.calls[2]![0]).toBe('/api/search');
    expect(JSON.parse(mock.mock.calls[2]![1].body as string).query).toBe('desert landmark');
    expect(JSON.parse(mock.mock.calls[3]![1].body as string).messages[1].content).toContain('A desert landmark');
    expect(result.searched).toBe(true);
    expect(result.sources).toEqual([{ title: 'Place', url: 'https://en.wikipedia.org/wiki/Place' }]);
    expect(result.notes).toContain('البرج تقريبي');
    expect(result.intent.scale).toBe('large');
    const report = generateWorldPlanWithReport(result.intent);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects.filter((o) => o.kind === 'tree' && o.variant === 'palm')).toHaveLength(2);
    expect(report.plan.objects.filter((o) => o.kind === 'building' && o.variant === 'tower')).toHaveLength(1);
  });
  it('does not search for a general scene, but checks internet before using the model', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}'))
      .mockResolvedValueOnce(modelResponse({ query: null })).mockResolvedValueOnce(modelResponse(plan));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت خيالي');
    expect(result.searched).toBe(false);
    expect(result.sources).toEqual([]);
    expect(mock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/model', '/api/model']);
  });
  it('never falls back when internet or Wikipedia search fails', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 }));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockReset().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(modelResponse({ query: 'place' }))
      .mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(interpretOnline('مدينة')).rejects.toThrow('ويكيبيديا');
    expect(mock).toHaveBeenCalledTimes(3);
  });
  it('explains an old static server or a model that has not loaded', async () => {
    const mock = vi.fn().mockResolvedValueOnce(new Response('', { status: 501 }));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت')).rejects.toThrow('world-builder-server.py');
    mock.mockReset().mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(interpretOnline('بيت')).rejects.toThrow('النموذج المحلي');
  });
  it('rejects malformed, unsupported, oversized and incomplete plans', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    mock.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(modelResponse({ query: null })).mockResolvedValueOnce(modelResponse({
      ...plan, assets: [{ assetId: 'untrusted-code', count: 1, direction: null, target: null }],
    }));
    await expect(interpretOnline('مدينة')).rejects.toThrow('غير مدعوم');
    mock.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(modelResponse({ query: null })).mockResolvedValueOnce(modelResponse({ ...plan, assets: [
      { assetId: 'tree', count: 100, direction: null, target: null },
      { assetId: 'palm', count: 100, direction: null, target: null },
      { assetId: 'bush', count: 100, direction: null, target: null },
      { assetId: 'house', count: 1, direction: null, target: null },
    ] }));
    await expect(interpretOnline('مدينة')).rejects.toThrow('كثيرة');
    mock.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })));
    await expect(interpretOnline('مدينة')).rejects.toThrow('لم يكتمل');
    mock.mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(modelResponse({ query: 123 }));
    await expect(interpretOnline('مدينة')).rejects.toThrow('تعذّر تحديد');
  });
});
