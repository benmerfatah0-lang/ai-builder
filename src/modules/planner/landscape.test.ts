import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { extractFrames } from './frames';
import { solveSpec } from './solve';
import { buildLandscapeRecipe, describeLandscape, landscapeWanted, type LandscapeRecipeInput } from './landscape';
import { landscapeSchema, type LandscapeSpec, type TerrainStyle } from '../../core/world-plan/schema';
import { bakeLandscape } from '../../core/terrain/landscape';
import type { WorldSpec } from './worldSpec';

/**
 * The translation layer between language and geometry.
 *
 * Two properties matter more than any other here: a recipe must always be valid
 * (an out-of-range number would make the whole plan fail validation), and a
 * recipe must only appear when the description really asks for landforms (so
 * simple worlds keep the classic terrain untouched).
 */

function specFor(description: string, seed = 11): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed }));
}

function inputFor(overrides: Partial<LandscapeRecipeInput> = {}): LandscapeRecipeInput {
  return {
    size: 160,
    resolution: 128,
    heightScale: 24,
    roughness: 0.6,
    style: 'mountains',
    water: false,
    waterLevel: null,
    biomes: [{ id: 'zone-primary', biome: 'mountains', weight: 1 }],
    primaryBiome: 'mountains',
    mentions: ['mountains'],
    negated: [],
    seed: 11,
    ...overrides,
  };
}

const STYLES: TerrainStyle[] = ['flat', 'hills', 'mountains', 'dunes', 'islands', 'valley', 'plateau', 'canyon', 'volcano', 'crater'];
const SIZES = [96, 160, 260, 512];

describe('landscape recipe gate', () => {
  it('asks for a bake only when the description implies landforms', () => {
    expect(landscapeWanted(inputFor({ style: 'mountains' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'canyon' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'volcano' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'islands' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'plateau' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'crater' }))).toBe(true);
    expect(landscapeWanted(inputFor({ style: 'valley' }))).toBe(true);
    // A river needs a real bed, so it earns a bake on any style but flat.
    expect(landscapeWanted(inputFor({ style: 'hills', river: { axis: 'z', width: 4, excavates: false } }))).toBe(true);
    // Two biomes have to blend into each other on the surface.
    expect(landscapeWanted(inputFor({
      style: 'hills',
      biomes: [
        { id: 'a', biome: 'forest', weight: 0.6 },
        { id: 'b', biome: 'meadow', weight: 0.4 },
      ],
    }))).toBe(true);
  });

  it('leaves simple and flat worlds on the classic terrain', () => {
    expect(landscapeWanted(inputFor({ style: 'flat' }))).toBe(false);
    expect(landscapeWanted(inputFor({ style: 'hills', mentions: ['hills'], biomes: [{ id: 'a', biome: 'meadow', weight: 1 }] }))).toBe(false);
    expect(buildLandscapeRecipe(inputFor({ style: 'flat' }))).toBeUndefined();
    expect(specFor('شجرة').terrain.landscape).toBeUndefined();
    expect(specFor('ارض مسطحة').terrain.landscape).toBeUndefined();
    expect(specFor('بيت صغير').terrain.landscape).toBeUndefined();
  });

  it('derives a recipe from real Arabic descriptions', () => {
    expect(specFor('قلعة فوق قمة جبل').terrain.landscape?.ranges?.length).toBeGreaterThan(0);
    expect(specFor('بركان').terrain.landscape?.volcanoes?.length).toBeGreaterThan(0);
    expect(specFor('اخدود').terrain.landscape?.canyons?.length).toBeGreaterThan(0);
    expect(specFor('هضبة').terrain.landscape?.plateaus?.length).toBeGreaterThan(0);
    expect(specFor('فوهة بركانية').terrain.landscape?.craters?.length).toBeGreaterThan(0);
    expect(specFor('جزر متناثرة').terrain.landscape?.ocean).toBeDefined();
    expect(specFor('جزر متناثرة').terrain.landscape?.islands?.length).toBeGreaterThan(0);
    expect(specFor('نهر بين التلال').terrain.landscape?.rivers?.length).toBeGreaterThan(0);
    expect(specFor('غابة ومرج').terrain.landscape?.biomes?.length).toBeGreaterThanOrEqual(2);
  });

  it('drops what the description ruled out', () => {
    const withRiver = specFor('جبال ونهر');
    expect(withRiver.terrain.landscape?.rivers?.length ?? 0).toBeGreaterThan(0);
    const without = specFor('جبال بدون نهر');
    expect(without.terrain.landscape?.rivers ?? []).toEqual([]);
    // The gate itself respects a negated landform.
    expect(buildLandscapeRecipe(inputFor({ negated: ['mountains'] }))?.ranges ?? []).toEqual([]);
  });
});

describe('landscape recipe contents', () => {
  it('is valid against the schema for every style and size', () => {
    for (const style of STYLES) {
      for (const size of SIZES) {
        const recipe = buildLandscapeRecipe(inputFor({
          style,
          size,
          resolution: Math.min(256, size),
          heightScale: style === 'flat' ? 0 : Math.round(size / 6),
          water: true,
          waterLevel: 1,
          lake: { x: 0, z: 0, radius: Math.max(5, size * 0.12), depth: 3 },
          river: { axis: 'z', width: 4, excavates: false },
          mentions: ['mountains', 'hills', 'valley', 'plateau', 'canyon', 'volcano', 'crater', 'island', 'islands-terrain', 'sea', 'lake', 'river', 'marsh', 'mine-entrance', 'rock'],
          biomes: [
            { id: 'zone-primary', biome: 'mountains', weight: 0.5, selector: 'north' },
            { id: 'zone-2', biome: 'forest', weight: 0.3, selector: 'center' },
            { id: 'zone-3', biome: 'desert', weight: 0.2, selector: 'south' },
          ],
        }));
        if (!recipe) continue;
        const parsed = landscapeSchema.safeParse(recipe);
        expect(parsed.success, `${style} @ ${size}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
      }
    }
  });

  it('keeps every coordinate inside the map it was derived for', () => {
    for (const size of SIZES) {
      const recipe = buildLandscapeRecipe(inputFor({
        size,
        heightScale: Math.round(size / 6),
        water: true,
        waterLevel: 0,
        lake: { x: size * 0.2, z: -size * 0.15, radius: size * 0.1, depth: 4 },
        river: { axis: 'x', width: 5, excavates: false },
        mentions: ['mountains', 'volcano', 'plateau', 'canyon', 'island', 'sea', 'lake', 'river'],
        biomes: [
          { id: 'a', biome: 'mountains', weight: 0.5, selector: 'north' },
          { id: 'b', biome: 'forest', weight: 0.5, selector: 'south' },
        ],
      }))!;
      const half = size / 2;
      const points: Array<[number, number]> = [
        ...(recipe.ranges ?? []).flatMap((range) => range.spine),
        ...(recipe.valleys ?? []).flatMap((valley) => valley.spine),
        ...(recipe.canyons ?? []).flatMap((canyon) => canyon.spine),
        ...(recipe.hills ?? []).map((hills) => hills.center),
        ...(recipe.plateaus ?? []).map((plateau) => plateau.center),
        ...(recipe.volcanoes ?? []).map((volcano) => volcano.center),
        ...(recipe.craters ?? []).map((crater) => crater.center),
        ...(recipe.islands ?? []).map((island) => island.center),
        ...(recipe.lakes ?? []).map((lake) => lake.center),
        ...(recipe.biomes ?? []).flatMap((biome) => (biome.center ? [biome.center] : [])),
      ];
      expect(points.length).toBeGreaterThan(0);
      for (const [x, z] of points) {
        expect(Math.abs(x)).toBeLessThanOrEqual(half);
        expect(Math.abs(z)).toBeLessThanOrEqual(half);
      }
    }
  });

  it('is deterministic for a seed and changes with it', () => {
    const a = JSON.stringify(buildLandscapeRecipe(inputFor({ seed: 5 })));
    const b = JSON.stringify(buildLandscapeRecipe(inputFor({ seed: 5 })));
    const c = JSON.stringify(buildLandscapeRecipe(inputFor({ seed: 6 })));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('gives a river a source in the high ground and a clear corridor', () => {
    const recipe = buildLandscapeRecipe(inputFor({
      river: { axis: 'z', width: 4, excavates: false },
      mentions: ['mountains', 'river'],
    }))!;
    expect(recipe.rivers?.[0]?.carve).toBe(true);
    expect(recipe.rivers?.[0]?.source).toBeDefined();
    expect(recipe.rivers?.[0]?.corridor ?? 0).toBeGreaterThan(4);
    // The source is the head of the main range, so the river runs downhill.
    expect(recipe.rivers?.[0]?.source).toEqual(recipe.ranges?.[0]?.spine[0]);
  });

  it('maps regional biomes onto the regions the layout resolver uses', () => {
    const recipe = buildLandscapeRecipe(inputFor({
      style: 'hills',
      mentions: ['hills'],
      biomes: [
        { id: 'north-woods', biome: 'forest', weight: 0.6, selector: 'north' },
        { id: 'south-sand', biome: 'desert', weight: 0.4, selector: 'south' },
      ],
    }))!;
    const north = recipe.biomes?.find((biome) => biome.id === 'north-woods');
    const south = recipe.biomes?.find((biome) => biome.id === 'south-sand');
    expect(north?.center?.[1] ?? 0).toBeLessThan(0);
    expect(south?.center?.[1] ?? 0).toBeGreaterThan(0);
    expect(north?.radius ?? 0).toBeGreaterThan(0);
    expect(north?.transition ?? 0).toBeGreaterThan(0);
  });

  it('asks for caves where rock is expected and nowhere else', () => {
    expect(buildLandscapeRecipe(inputFor({ style: 'volcano' }))!.caves?.length).toBeGreaterThan(0);
    expect(buildLandscapeRecipe(inputFor({ style: 'canyon' }))!.caves?.length).toBeGreaterThan(0);
    expect(buildLandscapeRecipe(inputFor({ style: 'mountains', mentions: ['mountains', 'mine-entrance'] }))!.caves?.length).toBeGreaterThan(0);
    expect(buildLandscapeRecipe(inputFor({ style: 'mountains', mentions: ['mountains'], biomes: [{ id: 'a', biome: 'mountains', weight: 1 }, { id: 'b', biome: 'forest', weight: 1 }] }))!.caves ?? []).toEqual([]);
  });

  it('scales erosion, detail and chunking with the world', () => {
    const small = buildLandscapeRecipe(inputFor({ size: 96, heightScale: 12 }))!;
    const large = buildLandscapeRecipe(inputFor({ size: 512, heightScale: 60 }))!;
    expect(large.erosion!.droplets!).toBeGreaterThan(small.erosion!.droplets!);
    expect(large.detail!.scale!).toBeGreaterThan(small.detail!.scale!);
    expect(small.chunks).toBeUndefined();
    expect(large.chunks?.lod?.length ?? 0).toBeGreaterThan(1);
    expect(large.ranges?.length ?? 0).toBeGreaterThan(small.ranges?.length ?? 0);
  });

  it('describes itself in Arabic for the report', () => {
    expect(describeLandscape(undefined)).toBe('تضاريس تحليلية كلاسيكية');
    const recipe = buildLandscapeRecipe(inputFor({ size: 260, mentions: ['mountains', 'river', 'lake'], water: true, waterLevel: 1, lake: { x: 0, z: 0, radius: 20, depth: 3 }, river: { axis: 'z', width: 4, excavates: false } }))!;
    const text = describeLandscape(recipe);
    expect(text).toContain('محرك تضاريس إجرائي');
    expect(text).toContain('سلسلة جبلية');
    expect(text).toContain('نهر محفور');
    expect(describeLandscape({} as LandscapeSpec)).toBe('محرك تضاريس إجرائي');
  });
});

describe('a derived recipe bakes into real terrain', () => {
  it('produces relief, drainage and biomes for a described mountain world', () => {
    const spec = specFor('قلعة حجرية فوق قمة جبل، وتحتها قرية تحيط ببحيرة، ونهر ينحدر منها');
    const recipe = spec.terrain.landscape;
    expect(recipe).toBeDefined();
    const result = bakeLandscape({
      style: spec.terrain.style,
      size: spec.dimensions.size,
      resolution: spec.dimensions.resolution,
      heightScale: spec.terrain.heightScale,
      waterLevel: 2,
      palette: spec.terrain.palette,
      landscape: recipe,
    }, spec.seed);
    expect(result.field.data.every((value) => Number.isFinite(value))).toBe(true);
    expect(result.stats.max - result.stats.min).toBeGreaterThan(8);
    expect(result.biomes.entries.length).toBeGreaterThan(0);
    expect(result.chunks.count).toBeGreaterThan(0);
    // A described mountain world has high ground to stand a castle on.
    expect(result.stats.max).toBeGreaterThan(6);
  });

  it('bakes the same world from the same description twice', () => {
    const first = specFor('جبال ووديان ونهر');
    const second = specFor('جبال ووديان ونهر');
    expect(JSON.stringify(first.terrain.landscape)).toBe(JSON.stringify(second.terrain.landscape));
  });
});
