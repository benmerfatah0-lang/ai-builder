import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { PlannerBlockedError, executePlannerResult, planAndBuildWorld, plannerTierLabel, planWorld, type PlannerStage } from './planner';
import { ruleBackend } from './backends';

const BIG = 'قلعة حجرية كبيرة فوق قمة جبل، وتحتها قرية صغيرة تحيط ببحيرة، والبيوت تربطها طرق ترابية. بدون أشجار نخيل.';
const BLOCKED = 'غابة بدون أشجار';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('planWorld: the plan is complete before anything is built', () => {
  it('returns a full specification, an execution plan and no object', async () => {
    const result = await planWorld(BIG, { seed: 5 });
    expect(result.spec.execution.steps).toHaveLength(16);
    expect(result.spec.execution.preflight.ok).toBe(true);
    expect(result.spec.execution.budgets.estimatedObjects).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(result.spec.dimensions.size).toBeGreaterThanOrEqual(32);
    expect(result.blocking).toEqual([]);
    expect(result.tier).toBe('rules');
    expect(result.offline).toBe(true);
  });

  it('runs every stage in order and reports each one as it goes', async () => {
    const seen: PlannerStage[] = [];
    const result = await planWorld(BIG, { seed: 5, onStage: (stage) => seen.push(stage) });
    expect(result.stages).toEqual(['interpret', 'frames', 'solve', 'clarify']);
    expect(seen).toEqual(result.stages);
  });

  it('keeps the existing interpreter as tier zero', async () => {
    const result = await planWorld(BIG, { seed: 5 });
    expect(result.interpretation.providerId).toBe('local-heuristic-v1');
    expect(result.interpretation.offline).toBe(true);
    expect(result.spec.cues.length).toBeGreaterThan(0);
  });

  it('is reproducible for the same description and seed', async () => {
    const first = await planWorld(BIG, { seed: 5 });
    const second = await planWorld(BIG, { seed: 5 });
    expect(second.spec).toEqual(first.spec);
    expect(second.interpretation).toEqual(first.interpretation);
  });

  it('honours the scale the caller picked in the UI', async () => {
    const small = await planWorld(BIG, { seed: 5, scale: 'small' });
    expect(small.spec.dimensions).toMatchObject({ scale: 'small', source: 'explicit' });
    expect((await planWorld(BIG, { seed: 5, scale: 'auto' })).spec.dimensions.source).not.toBe('explicit');
  });

  it('passes style and density through to the interpreter', async () => {
    const result = await planWorld('غابة', { seed: 5, style: 'cartoon', density: 'sparse' });
    expect(result.interpretation.intent).toMatchObject({ style: 'cartoon', density: 'sparse' });
  });

  it('stops before any work when the caller cancels', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(planWorld(BIG, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('planWorld: contradictions become questions', () => {
  it('blocks on a contradiction that has no safe default', async () => {
    const result = await planWorld(BLOCKED, { seed: 5 });
    expect(result.blocking.map((item) => item.id)).toEqual(['forest-without-trees']);
    expect(result.blocking[0]!.options.length).toBeGreaterThan(1);
    expect(result.spec.execution.preflight.ok).toBe(false);
  });

  it('never blocks on a question that has a default answer', async () => {
    const result = await planWorld('غابة وصحراء', { seed: 5 });
    expect(result.spec.clarifications.length).toBeGreaterThan(0);
    expect(result.blocking).toEqual([]);
    expect(result.spec.execution.preflight.ok).toBe(true);
  });

  it('unblocks as soon as the user answers', async () => {
    const answered = await planWorld(BLOCKED, { seed: 5, answers: { 'forest-without-trees': 'no-trees' } });
    expect(answered.blocking).toEqual([]);
    expect(answered.spec.counts.trees).toBe(0);
    expect(answered.spec.execution.preflight.ok).toBe(true);

    const kept = await planWorld(BLOCKED, { seed: 5, answers: { 'forest-without-trees': 'keep-trees' } });
    expect(kept.blocking).toEqual([]);
    expect(kept.spec.counts.trees).toBeGreaterThan(0);
  });

  it('ignores an answer that is not one of the offered options', async () => {
    const result = await planWorld(BLOCKED, { seed: 5, answers: { 'forest-without-trees': 'something-else' } });
    expect(result.blocking.map((item) => item.id)).toEqual(['forest-without-trees']);
  });
});

describe('planWorld: the optional local model', () => {
  it('is off unless the caller turns it on', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await planWorld(BIG, { seed: 5 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stays on the rule tier and says so when no local model answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response));
    const result = await planWorld('عالم فيه شيء ما', { seed: 5, llm: { enabled: true, timeoutMs: 50 } });
    expect(result.stages).toContain('enrich');
    expect(result.tier).toBe('rules');
    expect(result.offline).toBe(false);
    expect(result.spec.notices.join(' ')).toContain('غير متاح');
  });

  it('merges a local model answer and labels the tier', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { probe?: boolean };
      return {
        ok: true,
        json: async () => (body.probe ? { ok: true } : { enrichment: { style: 'cartoon', density: 'dense' } }),
      } as Response;
    }));
    const result = await planWorld(BIG, { seed: 5, llm: { enabled: true, timeoutMs: 500 } });
    expect(result.tier).toBe('rules+local-llm');
    expect(result.spec.environment).toMatchObject({ style: 'cartoon', density: 'dense' });
    expect(result.spec.notices.join(' ')).toContain('النموذج المحلي');
    // Counts, negations and relations stay the rule tier's.
    expect(result.spec.counts.trees).toBeGreaterThan(0);
    expect(result.spec.negations.map((negation) => negation.target)).toEqual(['palm']);
    expect(result.spec.relations.length).toBeGreaterThan(0);
  });

  it('does not consult the model while a blocking question is open', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const result = await planWorld(BLOCKED, { seed: 5, llm: { enabled: true, timeoutMs: 50 } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.stages).not.toContain('enrich');
    expect(result.spec.notices.join(' ')).toContain('أسئلة حاجبة');
  });
});

describe('executePlannerResult', () => {
  it('refuses to generate while a blocking question is open', async () => {
    const result = await planWorld(BLOCKED, { seed: 5 });
    expect(() => executePlannerResult(result)).toThrow(PlannerBlockedError);
    try {
      executePlannerResult(result);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as PlannerBlockedError).clarifications.map((item) => item.id)).toEqual(['forest-without-trees']);
      expect((error as PlannerBlockedError).message).toContain('إجابات');
    }
  });

  it('builds the world through the existing generators only', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    expect(executed.plan.objects.length).toBeGreaterThan(0);
    expect(executed.plan.objects.length).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(executed.plan.seed).toBe(5);
    expect(executed.validation.valid).toBe(true);
    expect(executed.intent.biome).toBe('mountains');
    expect(executed.report.plan.objects.length).toBeGreaterThan(0);
  });

  it('resolves the spatial relations into real coordinates first', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    expect(executed.spec.relations.length).toBeGreaterThan(0);
    expect(Object.keys(executed.spec.positions).length).toBeGreaterThan(0);
    expect(executed.spec.relations.some((relation) => relation.status === 'resolved')).toBe(true);
    const half = executed.plan.terrain.size / 2;
    for (const positions of Object.values(executed.spec.positions)) {
      for (const [x, z] of positions) {
        expect(Math.abs(x)).toBeLessThanOrEqual(half);
        expect(Math.abs(z)).toBeLessThanOrEqual(half);
      }
    }
  });

  it('carries the spec into the terrain it planned', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    expect(executed.plan.terrain.style).toBe('mountains');
    expect(executed.plan.terrain.size).toBe(executed.spec.dimensions.size);
    expect(executed.plan.terrain.lakeBasin).toBeTruthy();
  });

  it('marks every execution step done and records what each one produced', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    expect(executed.execution.steps.every((step) => step.status === 'done')).toBe(true);
    // `order` is the dependency-resolved run order, not the declaration order.
    expect([...executed.execution.order].sort()).toEqual([...executed.execution.steps.map((step) => step.id)].sort());
    const done = new Set<string>();
    for (const id of executed.execution.order) {
      const step = executed.execution.steps.find((entry) => entry.id === id)!;
      expect(step.dependsOn.every((dependency) => done.has(dependency))).toBe(true);
      done.add(id);
    }
    const vegetation = executed.execution.steps.find((step) => step.id === 'place-vegetation')!;
    expect(vegetation.detail).toContain('شجرة');
    expect(executed.execution.steps.every((step) => (step.detail ?? '').length > 0)).toBe(true);
  });

  it('collects the warnings of every stage without repeating one', async () => {
    const executed = executePlannerResult(await planWorld('ثلاث غزلان في غابة', { seed: 5 }));
    expect(executed.warnings.join(' ')).toContain('غزال');
    expect(new Set(executed.warnings).size).toBe(executed.warnings.length);
    expect(executed.warnings.every((warning) => warning.length > 0)).toBe(true);
  });

  it('names the world as the caller asks', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }), { name: 'عالم القلعة' });
    expect(executed.plan.name).toBe('عالم القلعة');
    expect(executePlannerResult(await planWorld(BIG, { seed: 5 })).plan.name.length).toBeLessThanOrEqual(80);
  });

  it('recovers by dropping an object the validator rejects', async () => {
    const executed = executePlannerResult(await planWorld('قرية حول بحيرة ونهر يعبرها', { seed: 5 }));
    expect(executed.validation.valid).toBe(true);
    expect(executed.plan.objects.length).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
  });

  it('keeps working when the description asks for almost nothing', async () => {
    const executed = executePlannerResult(await planWorld('عالم فارغ', { seed: 5 }));
    expect(executed.validation.valid).toBe(true);
    expect(executed.plan.terrain.size).toBeGreaterThanOrEqual(32);
  });
});

describe('planAndBuildWorld', () => {
  it('plans and builds in one call', async () => {
    const built = await planAndBuildWorld(BIG, { seed: 5 }, { name: 'عالم التجربة' });
    expect(built.plan.name).toBe('عالم التجربة');
    expect(built.plan.objects.length).toBeGreaterThan(0);
    expect(built.result.spec.execution.preflight.ok).toBe(true);
    expect(built.validation.valid).toBe(true);
  });

  it('throws before generating anything when the plan is blocked', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(planAndBuildWorld(BLOCKED, { seed: 5, llm: { enabled: true } })).rejects.toBeInstanceOf(PlannerBlockedError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('builds once the answers are supplied', async () => {
    const built = await planAndBuildWorld(BLOCKED, { seed: 5, answers: { 'forest-without-trees': 'no-trees' } });
    expect(built.plan.objects.filter((object) => object.kind === 'tree')).toEqual([]);
    expect(built.validation.valid).toBe(true);
  });

  it('produces the same world for the same description, seed and answers', async () => {
    const first = await planAndBuildWorld(BIG, { seed: 5 });
    const second = await planAndBuildWorld(BIG, { seed: 5 });
    expect(second.plan.objects).toEqual(first.plan.objects);
    expect(second.plan.terrain).toEqual(first.plan.terrain);
  });

  it('stays inside the document budget even for an extreme description', async () => {
    const built = await planAndBuildWorld('مدينة ضخمة فيها مئة بيت وألف شجرة ومئتا صخرة وطرق تربطها كلها', { seed: 5 });
    expect(built.plan.objects.length).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(built.spec.execution.budgets.estimatedObjects).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(built.validation.valid).toBe(true);
  });
});

describe('plannerTierLabel', () => {
  it('names the tier in Arabic, offline by default', () => {
    expect(plannerTierLabel('rules')).toBe(ruleBackend.label);
    expect(plannerTierLabel('rules+local-llm')).toContain('نموذج لغة محلي');
    expect(plannerTierLabel('rules')).not.toContain('سحابة');
  });
});
