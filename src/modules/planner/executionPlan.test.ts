import { describe, expect, it } from 'vitest';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import {
  advance,
  buildExecutionPlan,
  buildSteps,
  countRequested,
  preflight,
  topologicalOrder,
} from './executionPlan';
import { extractFrames } from './frames';
import { solveSpec } from './solve';
import type { GenerationStep, WorldSpec } from './worldSpec';

const DESCRIPTION = 'قلعة حجرية فوق جبل وقرية تحيط ببحيرة والبيوت تربطها طرق';

function specFor(description = DESCRIPTION): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed: 5 }));
}

const STEP_IDS = [
  'validate-input', 'resolve-terrain', 'resolve-biomes', 'resolve-regions', 'resolve-positions',
  'place-landmarks', 'place-buildings', 'place-assets', 'place-vegetation', 'connect-paths',
  'add-water', 'apply-materials', 'apply-lighting', 'apply-environment', 'validate-scene', 'report',
];

describe('buildSteps', () => {
  const steps = buildSteps(specFor());

  it('produces the complete plan before anything is generated', () => {
    expect(steps.map((step) => step.id)).toEqual(STEP_IDS);
    expect(steps.every((step) => step.title.length > 3)).toBe(true);
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
  });

  it('only depends on steps that exist, and never on itself', () => {
    const ids = new Set(steps.map((step) => step.id));
    for (const step of steps) {
      expect(step.dependsOn.every((id) => ids.has(id))).toBe(true);
      expect(step.dependsOn).not.toContain(step.id);
    }
  });

  it('puts validation first, the report last, and keeps a reserve for connectors', () => {
    expect(steps[0]!.dependsOn).toEqual([]);
    expect(steps[steps.length - 1]!.id).toBe('report');
    const paths = steps.find((step) => step.id === 'connect-paths')!;
    expect(paths.budget.objects).toBeGreaterThan(0);
    expect(paths.dependsOn).toEqual(expect.arrayContaining(['place-buildings', 'resolve-positions']));
    const sum = steps.reduce((total, step) => total + step.budget.objects, 0);
    expect(sum).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
  });
});

describe('topologicalOrder', () => {
  it('orders every step after its dependencies', () => {
    const steps = buildSteps(specFor());
    const { order, cycle } = topologicalOrder(steps);
    expect(cycle).toEqual([]);
    expect(order).toHaveLength(steps.length);
    const indexOf = new Map(order.map((id, index) => [id, index]));
    for (const step of steps) {
      for (const dependency of step.dependsOn) {
        expect(indexOf.get(dependency)!).toBeLessThan(indexOf.get(step.id)!);
      }
    }
  });

  it('reports a cycle instead of returning a partial order', () => {
    const steps: GenerationStep[] = [
      { id: 'a', title: 'a', producer: 'validate', dependsOn: ['b'], budget: { objects: 0 } },
      { id: 'b', title: 'b', producer: 'terrain', dependsOn: ['a'], budget: { objects: 0 } },
    ];
    const { order, cycle } = topologicalOrder(steps);
    expect(order).toEqual([]);
    expect(cycle.sort()).toEqual(['a', 'b']);
  });
});

describe('countRequested', () => {
  it('adds explicit objects to the scatter the generators will actually place', () => {
    const spec = specFor();
    const explicit = spec.assets.reduce((sum, asset) => sum + asset.count, 0) +
      spec.buildings.reduce((sum, building) => sum + building.count, 0);
    expect(countRequested(spec)).toBeGreaterThan(explicit);
    // Houses exist, so the settlement scatter is not counted twice.
    expect(spec.buildings.some((building) => building.kind === 'house')).toBe(true);
    expect(countRequested(spec)).toBe(explicit + spec.counts.trees + spec.counts.rocks + spec.counts.lanterns);
  });

  it('ignores a scatter counter that explicit assets already cover', () => {
    const spec = specFor('عشر شجيرات وصخرة');
    const covered = spec.assets.filter((asset) => ['bush', 'boulder'].includes(asset.assetId));
    expect(covered.length).toBeGreaterThan(0);
    // The generators skip a category once explicit assets cover it, so counting
    // both would over-estimate and clamp a world that comfortably fits.
    expect(spec.counts.trees).toBeGreaterThan(0);
    expect(countRequested(spec)).toBe(
      spec.assets.reduce((sum, asset) => sum + asset.count, 0) +
        spec.buildings.reduce((sum, building) => sum + building.count, 0) +
        spec.counts.lanterns,
    );
  });
});

describe('preflight', () => {
  it('passes a well-formed spec', () => {
    const spec = specFor();
    const result = preflight({ spec, unanswered: [] });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('blocks on an unanswered blocking question', () => {
    const spec = specFor('غابة بدون أشجار');
    const result = preflight({ spec, unanswered: ['forest-without-trees'] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('أسئلة حاجبة');
  });

  it('blocks on geometry the schema would reject', () => {
    const spec = specFor();
    expect(preflight({ spec: { ...spec, dimensions: { ...spec.dimensions, size: 4096 } }, unanswered: [] }).ok).toBe(false);
    expect(preflight({ spec: { ...spec, dimensions: { ...spec.dimensions, resolution: 4 } }, unanswered: [] }).ok).toBe(false);
  });

  it('blocks on a dependency cycle and warns about what it cannot build', () => {
    const spec = specFor('ثلاث غزلان وقلعة فوق جبل');
    const cyclic: WorldSpec = {
      ...spec,
      execution: {
        ...spec.execution,
        steps: [
          { id: 'a', title: 'a', producer: 'validate', dependsOn: ['b'], budget: { objects: 0 } },
          { id: 'b', title: 'b', producer: 'terrain', dependsOn: ['a'], budget: { objects: 0 } },
        ],
      },
    };
    const result = preflight({ spec: cyclic, unanswered: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('دورة اعتماد');

    const warnings = preflight({ spec, unanswered: [] }).warnings.join(' ');
    expect(warnings).toContain('غزال');
  });

  it('warns when an over-budget description will be clamped', () => {
    const spec = specFor();
    const warnings = preflight({
      spec: { ...spec, counts: { ...spec.counts, trees: MAX_WORLD_OBJECTS + 500 } },
      unanswered: [],
    }).warnings.join(' ');
    expect(warnings).toContain('سعة المستند');
  });
});

describe('buildExecutionPlan', () => {
  it('carries the order, the budgets and the preflight result', () => {
    const spec = specFor();
    const plan = buildExecutionPlan(spec, []);
    expect(plan.order).toHaveLength(STEP_IDS.length);
    expect(plan.budgets.maxObjects).toBe(MAX_WORLD_OBJECTS);
    expect(plan.budgets.reservedForRelations).toBeGreaterThan(0);
    expect(plan.budgets.estimatedObjects).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(plan.preflight.ok).toBe(true);
  });

  it('refuses to start while a blocking question is open', () => {
    const plan = buildExecutionPlan(specFor('غابة بدون أشجار'), ['forest-without-trees']);
    expect(plan.preflight.ok).toBe(false);
    expect(plan.preflight.errors.length).toBeGreaterThan(0);
  });
});

describe('advance', () => {
  it('marks a step without mutating the plan', () => {
    const spec = specFor();
    const plan = buildExecutionPlan(spec, []);
    const next = advance(plan, 'validate-input', 'done', 'تم التحقق');
    expect(next.steps.find((step) => step.id === 'validate-input')).toMatchObject({ status: 'done', detail: 'تم التحقق' });
    expect(plan.steps.find((step) => step.id === 'validate-input')!.status).toBe('pending');
    expect(advance(next, 'resolve-terrain', 'skipped').steps.find((step) => step.id === 'resolve-terrain')!.status).toBe('skipped');
    expect(() => advance(plan, 'not-a-step', 'done')).not.toThrow();
  });
});
