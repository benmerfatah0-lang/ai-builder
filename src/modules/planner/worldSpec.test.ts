import { describe, expect, it } from 'vitest';
import { WORLD_SPEC_VERSION, llmEnrichmentSchema, pathStyleFor, worldSpecGuard } from './worldSpec';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { extractFrames } from './frames';
import { solveSpec } from './solve';

const spec = solveSpec(extractFrames('قلعة فوق جبل'), interpretPromptLocally('قلعة فوق جبل', { seed: 3 }));

describe('llmEnrichmentSchema', () => {
  it('accepts the hints a local model is allowed to give', () => {
    const parsed = llmEnrichmentSchema.safeParse({
      language: 'ar',
      name: 'عالم القلعة',
      biome: 'mountains',
      landform: 'mountains',
      timeOfDay: 'sunset',
      density: 'sparse',
      weather: ['fog'],
      architecture: ['medieval'],
      materials: { wall: '#a1a1a1', roof: '#5b2c2c' },
      regions: [{ name: 'القمم', selector: 'summit', biome: 'mountains' }],
      relations: [{ subject: 'castle', predicate: 'on-top-of', object: 'mountain' }],
      animals: [{ id: 'deer', count: 4 }],
      clarifications: ['هل تريد نهراً؟'],
      summary: 'قلعة على قمة جبل عند الغروب.',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects anything that could break a world', () => {
    // Unknown keys are refused, so a model cannot invent counts, positions,
    // negations or budget overrides that the rule tier owns.
    for (const payload of [
      { counts: { trees: 5000 } },
      { positions: { 'b-m0': [[10, 10]] } },
      { negations: ['water'] },
      { dimensions: { size: 4096 } },
      { execution: { order: [] } },
      { maxObjects: 999999 },
    ]) {
      expect(llmEnrichmentSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('rejects out-of-range and malformed values', () => {
    expect(llmEnrichmentSchema.safeParse({ biome: 'jungle' }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ landform: 'floating' }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ timeOfDay: 'midnight' }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ materials: { wall: 'grey' } }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ animals: [{ id: 'deer', count: 0 }] }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ animals: [{ id: 'deer', count: 1, size: 'huge' }] }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ relations: [{ subject: 'a', predicate: 'next-to', object: 'b' }] }).success).toBe(false);
    expect(llmEnrichmentSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('worldSpecGuard', () => {
  it('accepts a spec the solver produced', () => {
    expect(worldSpecGuard.safeParse(spec).success).toBe(true);
  });

  it('rejects impossible geometry', () => {
    expect(worldSpecGuard.safeParse({ ...spec, dimensions: { ...spec.dimensions, size: 4096 } }).success).toBe(false);
    expect(worldSpecGuard.safeParse({ ...spec, seed: -1 }).success).toBe(false);
    expect(worldSpecGuard.safeParse({ ...spec, specVersion: WORLD_SPEC_VERSION + 1 }).success).toBe(false);
    expect(worldSpecGuard.safeParse({ ...spec, positions: { 'b-m0': [[Number.NaN, 0]] } }).success).toBe(false);
  });
});

describe('pathStyleFor', () => {
  it('matches the road surface to the requested materials and terrain', () => {
    expect(pathStyleFor({ palette: 'stone' }, 'hills')).toBe('stone');
    expect(pathStyleFor({}, 'mountains')).toBe('stone');
    expect(pathStyleFor({}, 'canyon')).toBe('stone');
    expect(pathStyleFor({}, 'dunes')).toBe('gravel');
    expect(pathStyleFor({}, 'meadow' as never)).toBe('dirt');
    expect(pathStyleFor({}, 'flat')).toBe('dirt');
  });
});
