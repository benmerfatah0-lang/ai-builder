import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { createLocalLlmBackend, enrichmentGaps, framesOf, mergeEnrichment, ruleBackend, type EnrichRequest } from './backends';
import { extractFrames } from './frames';
import { solveSpec } from './solve';
import type { WorldSpec } from './worldSpec';

const BLANK = 'عالم فيه شيء ما';
const RICH = 'قلعة حجرية كبيرة فوق قمة جبل، وتحتها قرية صغيرة تحيط ببحيرة، والبيوت تربطها طرق ترابية، في الليل مع ضباب';

function specFor(description: string): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed: 3 }));
}

const request: EnrichRequest = { prompt: 'وصف', language: 'ar', knownTerms: ['castle'], gaps: ['biome'] };

interface Call {
  url: string;
  body: Record<string, unknown>;
  signal?: AbortSignal | null;
}

/** Records every request and answers with a canned payload. */
function stubFetch(respond: (body: Record<string, unknown>) => unknown, options: { ok?: boolean; throws?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, signal: init.signal });
    if (options.throws) throw new TypeError('Failed to fetch');
    return { ok: options.ok ?? true, json: async () => respond(calls[calls.length - 1]!.body) } as Response;
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ruleBackend', () => {
  it('is the tier that always answers and never calls out', async () => {
    expect(ruleBackend).toMatchObject({ id: 'rules-v1', offline: true });
    expect(ruleBackend.label).toContain('قواعدي');
    await expect(ruleBackend.available()).resolves.toBe(true);
    await expect(ruleBackend.enrich(request)).resolves.toBeNull();
  });

  it('stays available even when the network itself is broken', async () => {
    stubFetch(() => ({}), { throws: true });
    await expect(ruleBackend.available()).resolves.toBe(true);
  });
});

describe('createLocalLlmBackend: reaching a model the user installed', () => {
  it('posts to the local server endpoint and nothing else', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await createLocalLlmBackend().available();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/local-llm');
    expect(calls[0]!.body).toEqual({ probe: true });
  });

  it('passes the configured endpoint and model through', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    await createLocalLlmBackend({ url: '/api/other', model: 'qwen2.5:1.5b' }).available();
    expect(calls[0]!.url).toBe('/api/other');
    expect(calls[0]!.body).toEqual({ probe: true, model: 'qwen2.5:1.5b' });
  });

  it('is available only when the server says ok', async () => {
    stubFetch(() => ({ ok: true }));
    await expect(createLocalLlmBackend().available()).resolves.toBe(true);
    stubFetch(() => ({ ok: false, error: 'no model' }));
    await expect(createLocalLlmBackend().available()).resolves.toBe(false);
    stubFetch(() => 'not-an-object');
    await expect(createLocalLlmBackend().available()).resolves.toBe(false);
  });

  it('reports unavailable instead of throwing when the server is gone', async () => {
    stubFetch(() => ({}), { throws: true });
    await expect(createLocalLlmBackend().available()).resolves.toBe(false);
    stubFetch(() => ({}), { ok: false });
    await expect(createLocalLlmBackend().available()).resolves.toBe(false);
  });

  it('gives up after the timeout rather than hanging the planner', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    await expect(createLocalLlmBackend({ timeoutMs: 20 }).available()).resolves.toBe(false);
  });

  it('never even dials the server when the caller already cancelled', async () => {
    const calls = stubFetch(() => ({ ok: true }));
    const controller = new AbortController();
    controller.abort();
    await expect(createLocalLlmBackend().available(controller.signal)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('asks only about the gaps, and never sends more than it must', async () => {
    const calls = stubFetch(() => ({ enrichment: { biome: 'ruins' } }));
    const enrichment = await createLocalLlmBackend().enrich({
      prompt: 'p'.repeat(5000),
      language: 'ar',
      knownTerms: Array.from({ length: 400 }, (_, index) => `term-${index}`),
      gaps: Array.from({ length: 40 }, (_, index) => `gap-${index}`),
    });
    expect(enrichment).toEqual({ biome: 'ruins' });
    const body = calls[0]!.body;
    expect(String(body.prompt)).toHaveLength(2000);
    expect((body.knownTerms as string[])).toHaveLength(200);
    expect((body.gaps as string[])).toHaveLength(20);
    expect(body.language).toBe('ar');
  });

  it('accepts a bare payload as well as a wrapped one', async () => {
    stubFetch(() => ({ biome: 'island' }));
    await expect(createLocalLlmBackend().enrich(request)).resolves.toEqual({ biome: 'island' });
    stubFetch(() => ({ ok: true, enrichment: { biome: 'island' } }));
    await expect(createLocalLlmBackend().enrich(request)).resolves.toEqual({ biome: 'island' });
  });

  it('rejects a payload that does not match the schema', async () => {
    stubFetch(() => ({ biome: 'atlantis' }));
    await expect(createLocalLlmBackend().enrich(request)).resolves.toBeNull();
    stubFetch(() => ({ biome: 'island', counts: { trees: 999 } }));
    await expect(createLocalLlmBackend().enrich(request)).resolves.toBeNull();
    stubFetch(() => null);
    await expect(createLocalLlmBackend().enrich(request)).resolves.toBeNull();
  });

  it('never lets a server failure escape as an exception', async () => {
    stubFetch(() => ({}), { throws: true });
    await expect(createLocalLlmBackend().enrich(request)).resolves.toBeNull();
  });
});

describe('mergeEnrichment: the model only fills gaps', () => {
  it('changes nothing when there is no enrichment', () => {
    const spec = specFor(BLANK);
    const merged = mergeEnrichment(spec, framesOf(BLANK), null);
    expect(merged.spec).toEqual(spec);
    expect(merged.applied).toEqual([]);
  });

  it('fills what the rules missed', () => {
    const frames = framesOf(BLANK);
    const merged = mergeEnrichment(specFor(BLANK), frames, {
      biome: 'island',
      landform: 'islands',
      timeOfDay: 'night',
      density: 'dense',
      style: 'cartoon',
    });
    expect(merged.spec.primaryBiome).toBe('island');
    expect(merged.spec.terrain.style).toBe('islands');
    expect(merged.spec.lighting.timeOfDay).toBe('night');
    expect(merged.spec.environment).toMatchObject({ density: 'dense', style: 'cartoon' });
    expect(merged.spec.tier).toBe('rules+local-llm');
    expect(merged.applied.length).toBeGreaterThan(0);
  });

  it('does not overwrite anything the description already said', () => {
    const description = 'غابة كثيفة في الليل';
    const frames = framesOf(description);
    const spec = specFor(description);
    const merged = mergeEnrichment(spec, frames, { biome: 'desert', landform: 'dunes', timeOfDay: 'sunset', density: 'sparse', style: 'cartoon' });
    expect(merged.spec.primaryBiome).toBe(spec.primaryBiome);
    expect(merged.spec.terrain.style).toBe(spec.terrain.style);
    expect(merged.spec.lighting.timeOfDay).toBe('night');
    expect(merged.spec.environment.density).toBe(spec.environment.density);
  });

  it('refuses to resize the world, and says why in Arabic', () => {
    const spec = specFor(BLANK);
    const merged = mergeEnrichment(spec, framesOf(BLANK), { scale: 'large' });
    expect(merged.spec.dimensions).toEqual(spec.dimensions);
    expect(merged.spec.notices.join(' ')).toContain('المقياس');
    expect(merged.spec.notices.join(' ')).toContain('لم يُعتمد');
  });

  it('never touches counts, negations, budgets or positions', () => {
    const description = 'غابة بدون أشجار نخيل، قلعة فوق جبل';
    const spec = specFor(description);
    const merged = mergeEnrichment(spec, framesOf(description), {
      biome: 'desert',
      landform: 'dunes',
      weather: ['مطر'],
      animals: [{ id: 'deer', count: 4 }],
      regions: [{ name: 'منطقة', selector: 'north' }],
      materials: { wall: '#112233', roof: '#445566' },
    });
    expect(merged.spec.counts).toEqual(spec.counts);
    expect(merged.spec.negations).toEqual(spec.negations);
    expect(merged.spec.positions).toEqual(spec.positions);
    expect(merged.spec.execution).toEqual(spec.execution);
    expect(merged.spec.buildings.map((building) => building.placement)).toEqual(spec.buildings.map((building) => building.placement));
    expect(merged.spec).not.toBe(spec);
    expect(spec.counts).toEqual(specFor(description).counts);
  });

  it('keeps weather inside the vocabulary the generators understand', () => {
    const merged = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { weather: ['ثلج', 'banana', ''] });
    expect(merged.spec.environment.weather).toEqual(['snow']);
  });

  it('tags buildings with an architecture style but never invents a material palette', () => {
    const description = 'قلعة فوق جبل';
    const merged = mergeEnrichment(specFor(description), framesOf(description), { architecture: ['قروسطي'] });
    expect(merged.spec.buildings.map((building) => building.architecture)).toEqual(['medieval']);
    expect(merged.spec.materials.palette).toBeUndefined();
  });

  it('leaves an architecture the description named alone', () => {
    const description = 'a medieval castle on a mountain';
    const spec = specFor(description);
    const merged = mergeEnrichment(spec, framesOf(description), { architecture: ['modern'] });
    expect(merged.spec.buildings.map((building) => building.architecture)).toEqual(spec.buildings.map((building) => building.architecture));
  });

  it('takes colours from the model only when no material was described', () => {
    const blank = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { materials: { wall: '#112233', roof: '#445566' } });
    expect(blank.spec.materials).toMatchObject({ wall: '#112233', roof: '#445566' });

    const description = 'بيوت حجرية';
    const spec = specFor(description);
    const stone = mergeEnrichment(spec, framesOf(description), { materials: { wall: '#112233', roof: '#445566' } });
    expect(stone.spec.materials.wall).toBe(spec.materials.wall);
  });

  it('records animals it recognises and drops the ones it does not', () => {
    const merged = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { animals: [{ id: 'deer', count: 2 }, { id: 'dragon', count: 1 }] });
    expect(merged.spec.animals).toHaveLength(1);
    expect(merged.spec.animals[0]).toMatchObject({ id: 'deer', count: 2, realized: 'unrealized' });
    expect(merged.spec.animals[0]!.label).toBe('غزال');
    expect(merged.spec.animals[0]!.notice).toContain('باني');
  });

  it('does not add an animal the description already counted', () => {
    const description = 'ثلاث غزلان في غابة';
    const spec = specFor(description);
    const merged = mergeEnrichment(spec, framesOf(description), { animals: [{ id: 'deer', count: 9 }] });
    expect(merged.spec.animals).toHaveLength(1);
    expect(merged.spec.animals[0]!.count).toBe(3);
  });

  it('adds suggested regions up to the cap, without duplicates', () => {
    const merged = mergeEnrichment(specFor(BLANK), framesOf(BLANK), {
      regions: Array.from({ length: 12 }, (_, index) => ({ name: `منطقة ${index}`, selector: 'north' as const })),
    });
    expect(merged.spec.regions).toHaveLength(8);
    expect(merged.spec.regions[0]).toMatchObject({ id: 'region-llm-0', shape: 'circle', selector: 'north', members: [] });
    expect(merged.spec.regions.every((region) => region.name.length <= 40)).toBe(true);

    const again = mergeEnrichment(merged.spec, framesOf(BLANK), { regions: [{ name: 'منطقة 0', selector: 'north' }] });
    expect(again.spec.regions).toHaveLength(8);
  });

  it('turns model questions into advisory clarifications that cannot block a build', () => {
    const merged = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { clarifications: ['أ', 'ب', 'ج', 'د', 'ه'] });
    expect(merged.spec.clarifications).toHaveLength(4);
    expect(merged.spec.clarifications.every((item) => item.severity === 'advisory')).toBe(true);
    expect(merged.spec.clarifications.every((item) => item.defaultOption === 'accept')).toBe(true);
    expect(merged.spec.clarifications.every((item) => item.options.length >= 2)).toBe(true);
  });

  it('reports a suggested relation instead of acting on an ungrounded one', () => {
    const merged = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { relations: [{ subject: 'شيء', predicate: 'near', object: 'شيء آخر' }] });
    expect(merged.spec.relations).toEqual([]);
    expect(merged.spec.notices.join(' ')).toContain('علاقة مكانية');
    expect(merged.spec.notices.join(' ')).toContain('لم تُعتمد');
  });

  it('renames the world only while it still has no name of its own', () => {
    const spec = specFor(BLANK);
    expect(mergeEnrichment({ ...spec, name: 'Untitled World' }, framesOf(BLANK), { name: 'عالم الجزيرة' }).spec.name).toBe('عالم الجزيرة');
    expect(mergeEnrichment(spec, framesOf(BLANK), { name: 'عالم آخر' }).spec.name).toBe(spec.name);
  });

  it('always tells the user in Arabic what came from the model', () => {
    const useful = mergeEnrichment(specFor(BLANK), framesOf(BLANK), { biome: 'ruins' });
    expect(useful.spec.notices.join(' ')).toContain('أضاف النموذج المحلي');
    expect(useful.spec.notices.join(' ')).toContain('بقيت الأعداد والمواقع والنفي من المحرّك القواعدي');

    const useless = mergeEnrichment(specFor(RICH), framesOf(RICH), { biome: 'desert', scale: 'small' });
    expect(useless.applied.filter((note) => !note.includes('المقياس'))).toEqual([]);
    expect(useless.spec.notices.join(' ')).toContain('المقياس');
  });
});

describe('enrichmentGaps', () => {
  it('asks about everything the rules could not resolve', () => {
    const frames = framesOf(BLANK);
    const gaps = enrichmentGaps(specFor(BLANK), frames);
    expect(gaps).toEqual(expect.arrayContaining(['biome', 'landform', 'timeOfDay', 'scale', 'density', 'weather', 'architecture', 'regions', 'relations', 'animals']));
  });

  it('stops asking once the description answered', () => {
    const frames = framesOf(RICH);
    const gaps = enrichmentGaps(specFor(RICH), frames);
    expect(gaps).not.toContain('biome');
    expect(gaps).not.toContain('landform');
    expect(gaps).not.toContain('timeOfDay');
    expect(gaps).not.toContain('weather');
    expect(gaps).not.toContain('relations');
    // "كبيرة" describes the castle, so the world's scale is still an open question.
    expect(gaps).toContain('scale');
    expect(gaps.length).toBeLessThan(enrichmentGaps(specFor(BLANK), framesOf(BLANK)).length);
  });
});

describe('framesOf', () => {
  it('is the same frame extraction the planner itself uses', () => {
    expect(framesOf(RICH)).toEqual(extractFrames(RICH));
  });
});
