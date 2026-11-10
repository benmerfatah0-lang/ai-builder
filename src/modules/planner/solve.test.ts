import { describe, expect, it } from 'vitest';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { countRequested } from './executionPlan';
import { extractFrames } from './frames';
import { clampToBudget, intentFromSpec, shade, solveSpec } from './solve';
import type { WorldSpec } from './worldSpec';

const BIG = 'قلعة حجرية كبيرة فوق قمة جبل، وتحتها قرية صغيرة تحيط ببحيرة، والبيوت تربطها طرق ترابية. بدون أشجار نخيل.';
const BIG_EN = 'A medieval castle on top of a tall mountain, with a small village surrounding a lake, and stone houses connected by dirt roads.';

function solve(description: string, answers?: Record<string, string>, seed = 5): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed }), answers ? { answers } : {});
}

describe('solveSpec: dimensions and terrain', () => {
  it('sizes the world from a world-level scale word only', () => {
    expect(solve('عالم صغير فيه قرية').dimensions).toMatchObject({ scale: 'small', source: 'scale-word' });
    expect(solve('a vast desert').dimensions.scale).toBe('large');
    // "a small village" describes the village, so the world keeps the default.
    const objectScale = solve('a small village around a lake').dimensions;
    expect(objectScale.source).toBe('default');
    expect(objectScale.size).toBeGreaterThan(32);
  });

  it('honours an explicit scale over every word in the text', () => {
    const spec = solveSpec(extractFrames('عالم صغير'), interpretPromptLocally('عالم صغير', { seed: 5 }), { scaleOverride: 'large' });
    expect(spec.dimensions).toMatchObject({ scale: 'large', source: 'explicit' });
  });

  it('keeps every dimension inside the schema limits', () => {
    for (const description of [BIG, BIG_EN, 'صحراء واسعة', 'جزيرة صغيرة']) {
      const { dimensions, terrain } = solve(description);
      expect(dimensions.size).toBeGreaterThanOrEqual(32);
      expect(dimensions.size).toBeLessThanOrEqual(512);
      expect(dimensions.resolution).toBeGreaterThanOrEqual(16);
      expect(dimensions.resolution).toBeLessThanOrEqual(256);
      expect(dimensions.areaUnitsSquared).toBe(dimensions.size * dimensions.size);
      expect(terrain.heightScale).toBeGreaterThanOrEqual(0);
      expect(terrain.heightScale).toBeLessThanOrEqual(200);
      if (terrain.lake) expect(terrain.lake.radius).toBeGreaterThan(0);
    }
  });

  it('makes the terrain mountainous when a landmark hangs on a mountain', () => {
    expect(solve(BIG_EN).terrain.style).toBe('mountains');
    expect(solve(BIG).terrain.style).toBe('mountains');
    expect(solve('غابة كثيفة').terrain.style).not.toBe('mountains');
  });

  it('reads an oasis as a small pool, and a lake as a lake', () => {
    const oasis = solve('صحراء فيها واحة نخيل').terrain.lake!;
    const lake = solve('صحراء فيها بحيرة').terrain.lake!;
    expect(oasis.depth).toBeLessThan(lake.depth);
    expect(oasis.radius).toBeLessThan(lake.radius);
    expect(solve('صحراء بدون ماء').terrain.water).toBe(false);
  });
});

describe('solveSpec: what gets placed', () => {
  const spec = solve(BIG);

  it('turns a landmark into a building with a placement strategy', () => {
    const castle = spec.buildings.find((building) => building.kind === 'castle')!;
    expect(castle.count).toBe(1);
    expect(castle.placement).toMatchObject({ strategy: 'highest', anchor: 'terrain-summit' });
    expect(castle.material?.palette).toBe('stone');
    expect(castle.size).toBe('large');
    expect(castle.realized).toBe('procedural');
  });

  it('gives a settlement a region and puts its houses where the relation says', () => {
    const region = spec.regions.find((entry) => entry.id === 'region-village');
    expect(region).toBeTruthy();
    const houses = spec.buildings.find((building) => building.kind === 'house')!;
    expect(houses.region).toBe('region-village');
    expect(houses.count).toBe(3);
    expect(houses.placement).toMatchObject({ strategy: 'ring', anchor: 'terrain-lake' });
  });

  it('keeps the connector as an asset the road builder can use', () => {
    const road = spec.assets.find((asset) => asset.assetId === 'dirt-path')!;
    expect(road.count).toBe(3);
    expect(road.placement?.strategy).toBe('chain');
  });

  it('names houses for a settlement the description never enumerated', () => {
    const village = solve('قرية تحيط ببحيرة');
    const houses = village.buildings.filter((building) => building.kind === 'house');
    expect(houses).toHaveLength(1);
    expect(houses[0]!.count).toBeGreaterThanOrEqual(4);
    expect(houses[0]!.region).toBe('region-village');
  });

  it('records architecture and materials for the whole world', () => {
    const english = solve(BIG_EN);
    expect(english.materials.palette).toBe('stone');
    expect(english.buildings.find((building) => building.kind === 'castle')?.architecture).toBe('medieval');
    expect(/^#[0-9a-f]{6}$/u.test(english.materials.wall ?? '')).toBe(true);
    expect(english.materials.roughness).toBeGreaterThan(0);
  });

  it('places animals in the spec and says plainly that nothing can build them', () => {
    const animals = solve('ثلاث غزلان وذئبان في غابة');
    expect(animals.animals.map((animal) => [animal.id, animal.count])).toEqual([['deer', 3], ['wolf', 2]]);
    expect(animals.animals.every((animal) => animal.realized === 'unrealized')).toBe(true);
    expect(animals.notices.join(' ')).toContain('غزال');
    expect(animals.execution.preflight.ok).toBe(true);
  });

  it('reads weather into fog, sky and light without inventing values', () => {
    const night = solve('غابة في الليل مع ضباب');
    expect(night.lighting.timeOfDay).toBe('night');
    expect(night.environment.weather).toContain('fog');
    expect(night.environment.fogDensity).toBeGreaterThan(0);
    expect(night.environment.fogDensity).toBeLessThanOrEqual(1);
    expect(night.lighting.sunIntensityScale).toBeLessThan(1);
    expect(/^#[0-9a-f]{6}$/u.test(night.environment.skyColor ?? '')).toBe(true);
  });
});

describe('solveSpec: negation', () => {
  it('applies a blanket exclusion to objects and to the scatter', () => {
    const spec = solve('غابة بدون أشجار', { 'forest-without-trees': 'no-trees' });
    expect(spec.counts.trees).toBe(0);
    expect(spec.negations.map((negation) => negation.target)).toContain('tree');
    expect(spec.assets.filter((asset) => asset.category === 'vegetation')).toEqual([]);
  });

  it('scopes a species exclusion to that species and keeps the world green', () => {
    const spec = solve('غابة بدون أشجار نخيل');
    expect(spec.negations.map((negation) => negation.target)).toEqual(['palm']);
    expect(spec.assets.map((asset) => asset.assetId)).not.toContain('palm');
    expect(spec.counts.trees).toBeGreaterThan(10);
    expect(spec.notices.join(' ')).toContain('نخلة');
  });

  it('drops water the description excluded', () => {
    const spec = solve('صحراء بدون ماء');
    expect(spec.terrain.water).toBe(false);
    expect(spec.terrain.lake).toBeUndefined();
    expect(spec.negations.map((negation) => negation.target)).toContain('water');
  });
});

describe('solveSpec: answers to clarifications', () => {
  it('refuses to plan a world with an unanswered blocking question', () => {
    const spec = solve('غابة بدون أشجار');
    expect(spec.clarifications.map((item) => [item.id, item.severity])).toEqual([['forest-without-trees', 'blocking']]);
    expect(spec.execution.preflight.ok).toBe(false);
  });

  it('follows the answer the user gave', () => {
    expect(solve('غابة بدون أشجار', { 'forest-without-trees': 'no-trees' }).counts.trees).toBe(0);
    const kept = solve('غابة بدون أشجار', { 'forest-without-trees': 'keep-trees' });
    expect(kept.counts.trees).toBeGreaterThan(0);
    expect(kept.negations.map((negation) => negation.target)).not.toContain('tree');
    expect(kept.execution.preflight.ok).toBe(true);
  });

  it('answers advisory questions with their default so nothing stalls', () => {
    const spec = solve('غابة وصحراء');
    expect(spec.clarifications.some((item) => item.id === 'multiple-biomes')).toBe(true);
    expect(spec.execution.preflight.ok).toBe(true);
  });
});

describe('solveSpec: the execution plan is complete before generation', () => {
  it('ships an ordered, acyclic, pre-flighted plan with every spec', () => {
    for (const description of [BIG, BIG_EN, 'غابة بدون أشجار', 'صحراء']) {
      const spec = solve(description);
      expect(spec.execution.steps.length).toBe(16);
      expect(spec.execution.order.length).toBe(16);
      expect(spec.execution.order[0]).toBe('validate-input');
      expect(spec.execution.budgets.maxObjects).toBe(MAX_WORLD_OBJECTS);
      expect(spec.execution.budgets.estimatedObjects).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    }
  });

  it('reports the tier, the language and the cues it understood', () => {
    expect(solve(BIG)).toMatchObject({ tier: 'rules', offline: true, language: 'ar', specVersion: 1 });
    expect(solve(BIG_EN).language).toBe('en');
    expect(solve(BIG).cues.length).toBeGreaterThan(5);
    expect(solve(BIG).seed).toBe(5);
  });

  it('is deterministic for the same description, seed and answers', () => {
    const answers = { 'forest-without-trees': 'no-trees' };
    expect(solve('غابة بدون أشجار', answers)).toEqual(solve('غابة بدون أشجار', answers));
  });
});

describe('clampToBudget', () => {
  it('leaves a world that already fits alone', () => {
    const spec = solve(BIG);
    const before = countRequested(spec);
    clampToBudget(spec, MAX_WORLD_OBJECTS);
    expect(countRequested(spec)).toBe(before);
  });

  it('spends the cut on scatter before anything the user named', () => {
    const spec = solve(BIG);
    clampToBudget(spec, 12);
    expect(countRequested(spec)).toBeLessThanOrEqual(12);
    expect(spec.buildings.map((building) => building.kind)).toEqual(expect.arrayContaining(['castle', 'house']));
    expect(spec.counts.trees).toBe(0);
    expect(spec.notices.join(' ')).toContain('سعة');
  });

  it('keeps the last landmark standing even in a tiny budget', () => {
    const spec = solve(BIG);
    clampToBudget(spec, 1);
    expect(countRequested(spec)).toBeLessThanOrEqual(1);
    expect(spec.buildings).toHaveLength(1);
    expect(spec.buildings[0]!.kind).toBe('castle');
  });

  it('can spread the cut evenly instead', () => {
    const spec = solve(BIG);
    clampToBudget(spec, 6, 'even');
    expect(spec.buildings.every((building) => building.count >= 1)).toBe(true);
    expect(spec.assets.every((asset) => asset.count >= 1)).toBe(true);
  });
});

describe('intentFromSpec', () => {
  it('projects the spec onto the intent the existing generators accept', () => {
    const interpretation = interpretPromptLocally(BIG, { seed: 5 });
    const intent = intentFromSpec(solve(BIG), interpretation);
    expect(intent.biome).toBe('mountains');
    expect(intent.water).toBe(true);
    expect(intent.settlement).toBe(true);
    // Explicit assets plus a vegetated background: the generators need both.
    expect(intent.landscape).toBe(true);
    expect(intent.assets?.map((asset) => asset.assetId)).toEqual(expect.arrayContaining(['castle', 'house', 'dirt-path']));
    expect(intent.counts.trees).toBeGreaterThan(0);
    expect(intent.cues.length).toBeGreaterThan(0);
  });

  it('passes resolved positions and regions through to the asset requests', () => {
    const spec = solve('قرية تحيط ببحيرة');
    const houses = spec.buildings.find((building) => building.kind === 'house')!;
    houses.placement = { strategy: 'ring', positions: [[10, -4], [12, 6], [-8, 3]] };
    spec.positions[houses.id] = [[10, -4], [12, 6], [-8, 3]];
    const intent = intentFromSpec(spec, interpretPromptLocally('قرية تحيط ببحيرة', { seed: 5 }));
    const request = intent.assets?.find((asset) => asset.assetId === 'house');
    expect(request?.positions).toEqual([[10, -4], [12, 6], [-8, 3]]);
    expect(request?.region).toBe('region-village');
  });

  it('does not grow a background around one requested object', () => {
    // The existing interpreter reads "شجرة" as a single object and "غابة" as a
    // landscape; the planner must not quietly change that reading.
    const single = interpretPromptLocally('شجرة', { seed: 5 });
    const intent = intentFromSpec(solveSpec(extractFrames('شجرة'), single), single);
    expect(intent.assets).toHaveLength(1);
    expect(intent.landscape).toBeFalsy();
    expect(intent.counts).toEqual(single.intent.counts);

    const forest = interpretPromptLocally('غابة كثيفة', { seed: 5 });
    expect(intentFromSpec(solveSpec(extractFrames('غابة كثيفة'), forest), forest).landscape).toBe(true);
  });

  it('turns the background on only when it understood more greenery than tier zero', () => {
    // "بدون أشجار نخيل" excludes one species, so the world stays green even
    // though the interpreter zeroed every tree.
    const base = interpretPromptLocally(BIG, { seed: 5 });
    const spec = solveSpec(extractFrames(BIG), base);
    expect(spec.counts.trees).toBeGreaterThan(base.intent.counts.trees);
    expect(intentFromSpec(spec, base).landscape).toBe(true);
  });

  it('only names a landform the description actually gave', () => {
    expect(intentFromSpec(solve('غابة كثيفة'), interpretPromptLocally('غابة كثيفة', { seed: 5 })).landform).toBeUndefined();
    expect(intentFromSpec(solve('وادي فيه نهر'), interpretPromptLocally('وادي فيه نهر', { seed: 5 })).landform).toBe('valley');
  });

  it('never asks for an asset that has no local builder', () => {
    const intent = intentFromSpec(solve('ثلاث غزلان في غابة'), interpretPromptLocally('ثلاث غزلان في غابة', { seed: 5 }));
    expect(intent.assets?.map((asset) => asset.assetId) ?? []).not.toContain('deer');
  });
});

describe('shade', () => {
  it('shifts channels and clamps at both ends', () => {
    expect(shade('#808080', 20)).toBe('#949494');
    expect(shade('#808080', -20)).toBe('#6c6c6c');
    expect(shade('#000000', 400)).toBe('#ffffff');
    expect(shade('#ffffff', -400)).toBe('#000000');
  });

  it('accepts short hex and returns unknown input untouched', () => {
    expect(shade('#fff', -40)).toBe('#d7d7d7');
    expect(shade('not-a-colour', 10)).toBe('not-a-colour');
  });
});
