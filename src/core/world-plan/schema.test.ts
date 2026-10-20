import { describe, expect, it } from 'vitest';
import {
  deserializeWorldPlan,
  migrateWorldPlan,
  parseWorldPlan,
  serializeWorldPlan,
  WorldPlanValidationError,
} from './migrate';
import { createEmptyWorldPlan } from './factory';
import { validateWorldPlan, WORLD_PLAN_SCHEMA_VERSION } from './schema';
import { createLantern, createTree } from '../assets/catalog';
import { mulberry32 } from '../generation/rng';

describe('WorldPlan schema', () => {
  it('creates a valid empty plan', () => {
    const plan = createEmptyWorldPlan({ name: 'Test World', seed: 42 });
    const result = validateWorldPlan(plan);
    expect(result.success).toBe(true);
    expect(result.data?.schemaVersion).toBe(WORLD_PLAN_SCHEMA_VERSION);
    expect(plan.objects).toHaveLength(0);
  });

  it('rejects invalid colors and transforms', () => {
    const plan = createEmptyWorldPlan();
    const invalid = {
      ...plan,
      environment: { ...plan.environment, skyColor: 'blue' },
    };
    const result = validateWorldPlan(invalid);
    expect(result.success).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes('skyColor'))).toBe(true);

    const badScale = {
      ...plan,
      objects: [
        {
          ...createTree('pine', [0, 0, 0], mulberry32(1)),
          transform: { position: [0, 0, 0], rotationY: 0, scale: [0, 1, 1] },
        },
      ],
    };
    expect(validateWorldPlan(badScale).success).toBe(false);
  });

  it('round-trips through stable JSON', () => {
    const plan = createEmptyWorldPlan({ name: 'Round trip' });
    plan.objects.push(createTree('pine', [1, 2, 3], mulberry32(9)));
    plan.objects.push(createLantern([2, 0, 1]));
    const json = serializeWorldPlan(plan);
    const restored = deserializeWorldPlan(json);
    expect(restored).toEqual(plan);
  });

  it('rejects unknown object kinds', () => {
    const plan = createEmptyWorldPlan();
    const result = validateWorldPlan({
      ...plan,
      objects: [{ ...createLantern([0, 0, 0]), kind: 'dragon' }],
    });
    expect(result.success).toBe(false);
  });

  it('reports unsupported versions clearly', () => {
    expect(() => migrateWorldPlan({ schemaVersion: 99 })).toThrow(/newer format/);
    expect(() => migrateWorldPlan({ hello: 'world' })).toThrow(/missing a schemaVersion/);
    expect(() => parseWorldPlan({ schemaVersion: 1 })).toThrow(WorldPlanValidationError);
  });
});
