import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { deserializeWorldPlan, serializeWorldPlan, WorldPlanValidationError } from '../world-plan/migrate';
import { WORLD_PLAN_SCHEMA_VERSION } from '../world-plan/schema';
import {
  createIndexedDbWorldRepository,
  createMemoryWorldRepository,
} from './worldRepository';
import { suggestWorldFileName } from './projectFile';
import type { WorldPlan } from '../world-plan/schema';

function planWithId(id: string, name: string, updatedAt: string): WorldPlan {
  return { ...createEmptyWorldPlan({ name, seed: 1 }), id, updatedAt };
}

describe('memory repository', () => {
  it('saves, lists, loads and deletes', async () => {
    const repo = createMemoryWorldRepository();
    const plan = createEmptyWorldPlan({ name: 'Memory world' });
    await repo.save(plan);
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Memory world');
    expect(await repo.load(plan.id)).toEqual(plan);
    await repo.delete(plan.id);
    expect(await repo.load(plan.id)).toBeNull();
    expect(await repo.list()).toHaveLength(0);
  });
});

describe('IndexedDB repository', () => {
  it('persists worlds locally with CRUD and sort order', async () => {
    const repo = createIndexedDbWorldRepository(`test-worlds-${Date.now()}-${Math.random()}`);
    const older = planWithId('world_older', 'Older', '2026-01-01T00:00:00.000Z');
    const newer = planWithId('world_newer', 'Newer', '2026-05-01T00:00:00.000Z');

    await repo.save(older);
    await repo.save(newer);

    const list = await repo.list();
    expect(list.map((entry) => entry.id)).toEqual(['world_newer', 'world_older']);
    expect(list[0]?.objectCount).toBe(0);
    expect(list[0]?.schemaVersion).toBe(WORLD_PLAN_SCHEMA_VERSION);

    expect(await repo.load('world_newer')).toEqual(newer);

    await repo.delete('world_newer');
    expect(await repo.load('world_newer')).toBeNull();
    expect((await repo.list()).map((entry) => entry.id)).toEqual(['world_older']);
  });

  it('refuses to store an invalid plan', async () => {
    const repo = createIndexedDbWorldRepository(`test-invalid-${Date.now()}-${Math.random()}`);
    const plan = createEmptyWorldPlan();
    const invalid = { ...plan, terrain: { ...plan.terrain, size: 9999 } } as WorldPlan;
    await expect(repo.save(invalid)).rejects.toThrow();
  });
});

describe('project file format', () => {
  it('serializes and re-imports losslessly', () => {
    const plan = createEmptyWorldPlan({ name: 'My World!' });
    const json = serializeWorldPlan(plan);
    expect(json.endsWith('\n')).toBe(true);
    expect(deserializeWorldPlan(json)).toEqual(plan);
  });

  it('produces safe file names', () => {
    const plan = createEmptyWorldPlan({ name: 'Mountains: Dawn / Dusk' });
    expect(suggestWorldFileName(plan)).toBe('mountains-dawn-dusk.world.json');
    expect(suggestWorldFileName(createEmptyWorldPlan({ name: '???' }))).toBe('world.world.json');
  });

  it('rejects malformed files with a helpful error', () => {
    expect(() => deserializeWorldPlan('{not json')).toThrow(WorldPlanValidationError);
    expect(() => deserializeWorldPlan('{not json')).toThrow(/not valid JSON/);
    expect(() => deserializeWorldPlan('{"schemaVersion": 1}')).toThrow(/not valid/);
  });
});
