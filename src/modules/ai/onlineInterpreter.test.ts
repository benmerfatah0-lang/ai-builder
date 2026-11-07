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
function apiResponse(value: unknown = plan) {
  return { status: 'completed', output: [
    { type: 'web_search_call', status: 'completed' },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [
      { type: 'url_citation', url: 'https://example.com/place', title: 'Place' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
    ] }] },
  ] };
}
afterEach(() => vi.unstubAllGlobals());

describe('online interpreter', () => {
  it('requests web search and uses the validated response in the real generator', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await interpretOnline('برج أثري في الصحراء', 'test-key', { seed: 12, scale: 'large' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(init.body as string);
    expect(request.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(request.input).toBe('برج أثري في الصحراء');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(result.searched).toBe(true);
    expect(result.sources).toEqual([{ title: 'Place', url: 'https://example.com/place' }]);
    expect(result.notes).toContain('البرج تقريبي');
    expect(result.intent.scale).toBe('large');
    const report = generateWorldPlanWithReport(result.intent);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects.filter((o) => o.kind === 'tree' && o.variant === 'palm')).toHaveLength(2);
    expect(report.plan.objects.filter((o) => o.kind === 'building' && o.variant === 'tower')).toHaveLength(1);
    expect(report.plan.description).not.toContain('test-key');
  });

  it('requires a key, does not silently fall back offline and reports service errors', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(interpretOnline('بيت', '')).rejects.toThrow('مفتاح');
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('مفتاح');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects untrusted malformed or unsupported asset plans', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiResponse({
      ...plan, assets: [{ assetId: 'untrusted-code', count: 1, direction: null, target: null }],
    })), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('غير مدعوم');
    fetchMock.mockResolvedValue(new Response(JSON.stringify(apiResponse({ ...plan, assets: [
      { assetId: 'tree', count: 100, direction: null, target: null },
      { assetId: 'palm', count: 100, direction: null, target: null },
      { assetId: 'bush', count: 100, direction: null, target: null },
      { assetId: 'house', count: 1, direction: null, target: null },
    ] })), { status: 200 }));
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('كثيرة');
  });

  it('reports network failures without exposing the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-key should not be echoed')));
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('تعذّر الاتصال');
    try { await interpretOnline('بيت', 'test-key'); } catch (error) {
      expect(String(error)).not.toContain('test-key');
    }
  });

  it('reports whether the provider actually searched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }],
    }))));
    const result = await interpretOnline('بيت', 'test-key');
    expect(result.searched).toBe(false);
    expect(result.sources).toEqual([]);
  });
});
