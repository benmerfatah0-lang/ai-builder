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
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] },
    groundingMetadata: { webSearchQueries: ['test'], groundingChunks: [
      { web: { uri: 'https://example.com/place', title: 'Place' } },
      { web: { uri: 'javascript:alert(1)', title: 'Unsafe' } },
    ] },
  }] };
}
afterEach(() => vi.unstubAllGlobals());
describe('Gemini online interpreter', () => {
  it('requests Google Search and validates the response before building', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await interpretOnline('برج أثري في الصحراء', 'test-key', { seed: 12, scale: 'large' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('test-key');
    const request = JSON.parse(init.body as string);
    expect(request.tools).toEqual([{ google_search: {} }]);
    expect(request.generationConfig.responseMimeType).toBeUndefined(); // 2.5 cannot combine schema enforcement with tools
    expect(request.contents[0].parts[0].text).toBe('برج أثري في الصحراء');
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
  it('requires a key and reports rejected keys and quota without offline fallback', async () => {
    const mock = vi.fn().mockResolvedValue(new Response('', { status: 403 }));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('بيت', '')).rejects.toThrow('مفتاح');
    expect(mock).not.toHaveBeenCalled();
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('مفتاح');
    mock.mockResolvedValue(new Response('', { status: 429 }));
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('حد الاستخدام');
    mock.mockResolvedValue(new Response('', { status: 404 }));
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('النموذج غير متاح');
  });
  it('rejects unsupported, oversized and incomplete plans', async () => {
    const mock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiResponse({
      ...plan, assets: [{ assetId: 'untrusted-code', count: 1, direction: null, target: null }],
    }))));
    vi.stubGlobal('fetch', mock);
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('غير مدعوم');
    mock.mockResolvedValue(new Response(JSON.stringify(apiResponse({ ...plan, assets: [
      { assetId: 'tree', count: 100, direction: null, target: null },
      { assetId: 'palm', count: 100, direction: null, target: null },
      { assetId: 'bush', count: 100, direction: null, target: null },
      { assetId: 'house', count: 1, direction: null, target: null },
    ] }))));
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('كثيرة');
    mock.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] })));
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('لم يكتمل');
  });
  it('does not expose the key on network failure, and accepts fenced JSON without search', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('test-key must not be echoed'));
    vi.stubGlobal('fetch', mock);
    try { await interpretOnline('بيت', 'test-key'); } catch (error) { expect(String(error)).not.toContain('test-key'); }
    mock.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` }] } }] })));
    const result = await interpretOnline('بيت', 'test-key', {}, 'gemini-2.5-flash-lite');
    expect(result.searched).toBe(false);
    expect(result.sources).toEqual([]);
    expect(mock.mock.calls[1]![0]).toContain('gemini-2.5-flash-lite');
  });
});
