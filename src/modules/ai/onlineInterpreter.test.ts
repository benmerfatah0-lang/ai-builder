import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretOnline } from './onlineInterpreter';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';

const keys = { groq: 'secret-groq-key', tavily: 'secret-tavily-key' };
const plan = {
  biome: 'desert', timeOfDay: 'sunset', water: false, scale: 'small', style: 'stylized', density: 'normal',
  assets: [
    { assetId: 'tower', count: 1, direction: 'right', target: 1 },
    { assetId: 'palm', count: 2, direction: null, target: null },
  ], summary: 'برج ونخيل عند الغروب', limitations: ['البرج تقريبي'],
};
function groqResponse(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
}
function searchResponse() {
  return new Response(JSON.stringify({ results: [
    { title: 'Place', url: 'https://example.com/place', content: 'A desert landmark' },
    { title: 'Unsafe', url: 'javascript:alert(1)', content: 'ignored' },
  ] }));
}
afterEach(() => vi.unstubAllGlobals());
describe('Groq and Tavily online interpreter', () => {
  it('decides to search, sends one basic Tavily request and validates the result', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(groqResponse({ query: 'desert landmark' }))
      .mockResolvedValueOnce(searchResponse()).mockResolvedValueOnce(groqResponse(plan));
    vi.stubGlobal('fetch', fetchMock);
    const result = await interpretOnline('برج أثري في الصحراء', keys, { seed: 12, scale: 'large' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [groqUrl, groqInit] = fetchMock.mock.calls[0]!;
    expect(groqUrl).toBe('/api/groq');
    expect(groqInit.headers.Authorization).toBe('Bearer secret-groq-key');
    const request = JSON.parse(groqInit.body as string);
    expect(request.model).toBe('qwen/qwen3.8-27b');
    expect(request.response_format.type).toBe('json_schema');
    expect(request.messages[1].content).toBe('برج أثري في الصحراء');
    const [searchUrl, searchInit] = fetchMock.mock.calls[1]!;
    expect(searchUrl).toBe('/api/tavily');
    expect(searchInit.headers.Authorization).toBe('Bearer secret-tavily-key');
    const search = JSON.parse(searchInit.body as string);
    expect(search.query).toBe('desert landmark');
    expect(search.search_depth).toBe('basic');
    expect(search.auto_parameters).toBe(false);
    expect(groqInit.body).not.toContain(keys.tavily);
    expect(searchInit.body).not.toContain(keys.groq);
    const finalBody = JSON.parse(fetchMock.mock.calls[2]![1].body as string);
    expect(finalBody.messages[1].content).toContain('A desert landmark');
    expect(finalBody.messages[1].content).not.toContain(keys.tavily);
    expect(result.searched).toBe(true);
    expect(result.sources).toEqual([{ title: 'Place', url: 'https://example.com/place' }]);
    expect(result.notes).toContain('البرج تقريبي');
    expect(result.intent.scale).toBe('large');
    const report = generateWorldPlanWithReport(result.intent);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects.filter((o) => o.kind === 'tree' && o.variant === 'palm')).toHaveLength(2);
    expect(report.plan.objects.filter((o) => o.kind === 'building' && o.variant === 'tower')).toHaveLength(1);
    expect(report.plan.description).not.toContain(keys.groq);
  });
  it('does not search for a general scene and still uses the online model', async () => {
    const mock = vi.fn().mockResolvedValueOnce(groqResponse({ query: null })).mockResolvedValueOnce(groqResponse(plan));
    vi.stubGlobal('fetch', mock);
    const result = await interpretOnline('بيت خيالي', keys);
    expect(result.searched).toBe(false);
    expect(result.sources).toEqual([]);
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls.every(([url]) => url === '/api/groq')).toBe(true);
  });
  it('requires both keys and never falls back if search fails', async () => {
    const mock = vi.fn().mockResolvedValueOnce(groqResponse({ query: 'place' })).mockResolvedValueOnce(new Response('', { status: 429 }));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت', { groq: '', tavily: '' })).rejects.toThrow('مفتاح');
    expect(mock).not.toHaveBeenCalled();
    await expect(interpretOnline('مدينة', keys)).rejects.toThrow('Tavily');
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('explains when the old static server cannot forward API calls', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 501 })));
    await expect(interpretOnline('بيت', keys)).rejects.toThrow('world-builder-server.py');
  });
  it('reports Groq errors without exposing keys', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت', keys)).rejects.toThrow('Groq');
    mock.mockRejectedValue(new TypeError('secret-groq-key must not be echoed'));
    try { await interpretOnline('بيت', keys); } catch (error) { expect(String(error)).not.toContain(keys.groq); }
  });
  it('rejects malformed, unsupported, oversized and incomplete plans', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    mock.mockResolvedValueOnce(groqResponse({ query: null })).mockResolvedValueOnce(groqResponse({
      ...plan, assets: [{ assetId: 'untrusted-code', count: 1, direction: null, target: null }],
    }));
    await expect(interpretOnline('مدينة', keys)).rejects.toThrow('غير مدعوم');
    mock.mockResolvedValueOnce(groqResponse({ query: null })).mockResolvedValueOnce(groqResponse({ ...plan, assets: [
      { assetId: 'tree', count: 100, direction: null, target: null },
      { assetId: 'palm', count: 100, direction: null, target: null },
      { assetId: 'bush', count: 100, direction: null, target: null },
      { assetId: 'house', count: 1, direction: null, target: null },
    ] }));
    await expect(interpretOnline('مدينة', keys)).rejects.toThrow('كثيرة');
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })));
    await expect(interpretOnline('مدينة', keys)).rejects.toThrow('لم يكتمل');
    mock.mockResolvedValueOnce(groqResponse({ query: 123 }));
    await expect(interpretOnline('مدينة', keys)).rejects.toThrow('تعذّر تحديد');
  });
});
