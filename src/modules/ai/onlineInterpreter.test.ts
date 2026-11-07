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
function apiResponse(value: unknown = plan, searched = true) {
  return { status: 'completed', output: [
    ...(searched ? [{ type: 'web_search_call', status: 'completed' }] : []),
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [
      { type: 'url_citation', url: 'https://example.com/place', title: 'Place' },
      { type: 'url_citation', url: 'javascript:alert(1)', title: 'Unsafe' },
    ] }] },
  ] };
}
afterEach(() => vi.unstubAllGlobals());
describe('OpenAI online interpreter', () => {
  it('requests optional web search and validates the result before building', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(apiResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await interpretOnline('برج أثري في الصحراء', 'test-key', { seed: 12, scale: 'large' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    const request = JSON.parse(init.body as string);
    expect(request.model).toBe('gpt-5.4-nano');
    expect(request.tools).toEqual([{ type: 'web_search' }]);
    expect(request.tool_choice).toBe('auto');
    expect(request.store).toBe(false);
    expect(request.text.format.type).toBe('json_schema');
    expect(request.input).toBe('برج أثري في الصحراء');
    expect(JSON.stringify(request)).not.toContain('test-key');
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
    await expect(interpretOnline('بيت', 'test-key')).rejects.toThrow('حد الطلبات');
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
    mock.mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete', output: [] })));
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('لم يكتمل');
    mock.mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] })));
    await expect(interpretOnline('مدينة', 'test-key')).rejects.toThrow('مخططاً صالحاً');
  });
  it('does not expose the key on network failure and reports when no search was used', async () => {
    const mock = vi.fn().mockRejectedValue(new Error('test-key must not be echoed'));
    vi.stubGlobal('fetch', mock);
    try { await interpretOnline('بيت', 'test-key'); } catch (error) { expect(String(error)).not.toContain('test-key'); }
    mock.mockResolvedValue(new Response(JSON.stringify(apiResponse(plan, false))));
    const result = await interpretOnline('بيت', 'test-key');
    expect(result.searched).toBe(false);
  });
});
