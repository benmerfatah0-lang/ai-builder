import { describe, expect, it } from 'vitest';
import { mulberry32 } from './rng';
import { fbm, createTerrainSampler } from './terrain';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlan } from './generateWorld';
import { createStarterWorld } from './starter';
import { DEFAULT_TERRAIN } from '../world-plan/factory';
import type { Terrain } from '../world-plan/schema';

function intentFor(prompt: string, seed = 777) {
  return interpretPromptLocally(prompt, { seed }).intent;
}

describe('seeded RNG and terrain', () => {
  it('is deterministic for a seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const sequenceA = Array.from({ length: 8 }, () => a());
    const sequenceB = Array.from({ length: 8 }, () => b());
    expect(sequenceA).toEqual(sequenceB);
    expect(sequenceA.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('produces deterministic finite terrain', () => {
    const terrain: Terrain = { ...DEFAULT_TERRAIN, style: 'mountains', heightScale: 20 };
    const sampler = createTerrainSampler(terrain, 99);
    const samples = [
      sampler.heightAt(0, 0),
      sampler.heightAt(20, -35),
      sampler.heightAt(-60, 60),
    ];
    expect(samples).toEqual([
      createTerrainSampler(terrain, 99).heightAt(0, 0),
      createTerrainSampler(terrain, 99).heightAt(20, -35),
      createTerrainSampler(terrain, 99).heightAt(-60, 60),
    ]);
    expect(samples.every((value) => Number.isFinite(value))).toBe(true);
    expect(fbm(1, 0.5, 0.5)).toBe(fbm(1, 0.5, 0.5));
  });

  it('keeps flat terrain flat', () => {
    const sampler = createTerrainSampler(
      { ...DEFAULT_TERRAIN, style: 'flat', heightScale: 10 },
      1,
    );
    expect(sampler.heightAt(10, 10)).toBe(0);
    expect(sampler.normalizedHeightAt(-5, 3)).toBe(0.5);
  });

  it('sinks island edges below the water line', () => {
    const sampler = createTerrainSampler(
      { ...DEFAULT_TERRAIN, style: 'islands', heightScale: 10 },
      7,
    );
    expect(sampler.heightAt(0, 0)).toBeGreaterThan(sampler.heightAt(79, 0));
    expect(sampler.heightAt(79, 0)).toBeLessThan(0.5);
  });
});

describe('local prompt interpreter', () => {
  it('maps biomes, time and counts', () => {
    const intent = intentFor('A misty pine forest at night with 30 trees and 12 rocks');
    expect(intent.biome).toBe('forest');
    expect(intent.timeOfDay).toBe('night');
    expect(intent.counts.trees).toBe(30);
    expect(intent.counts.rocks).toBe(12);
    expect(intent.cues.some((cue) => cue.includes('biome: forest'))).toBe(true);
  });

  it('understands deserts, oases and settlements', () => {
    const intent = intentFor('A desert oasis village at sunset with 20 palm trees');
    expect(intent.biome).toBe('desert');
    expect(intent.settlement).toBe(true);
    expect(intent.water).toBe(true);
    expect(intent.timeOfDay).toBe('sunset');
    expect(intent.counts.buildings).toBeGreaterThan(5);
    expect(intent.counts.trees).toBe(20);
  });

  it('creates water and palms for islands', () => {
    const intent = intentFor('A tropical island with palm trees');
    expect(intent.biome).toBe('island');
    expect(intent.water).toBe(true);
  });

  it('matches whole words, not substrings', () => {
    const intent = intentFor('A pleasant season for a village');
    expect(intent.biome).toBe('meadow');
    expect(intent.water).toBe(false);
    expect(intent.settlement).toBe(true);
  });

  it('honors "no trees" and scale words', () => {
    const intent = intentFor('A small meadow without trees');
    expect(intent.biome).toBe('meadow');
    expect(intent.scale).toBe('small');
    expect(intent.counts.trees).toBe(0);
  });

  it('derives a stable seed from the prompt when none is supplied', () => {
    const first = interpretPromptLocally('A snowy mountain range').intent;
    const second = interpretPromptLocally('a snowy mountain range   ').intent;
    expect(first.seed).toBe(second.seed);
  });
});

describe('procedural world generation', () => {
  it('is content-deterministic for the same intent', () => {
    const intent = intentFor('A misty forest with 25 trees, 8 rocks and lanterns', 4242);
    const first = generateWorldPlan(intent);
    const second = generateWorldPlan(intent);
    expect(first.objects).toEqual(second.objects);
    expect(first.terrain).toEqual(second.terrain);
    expect(first.environment).toEqual(second.environment);
    expect(first.name).toBe(second.name);
  });

  it('honors counts and keeps unique IDs', () => {
    const plan = generateWorldPlan(intentFor('A meadow with 10 trees and 4 rocks', 31337));
    expect(plan.objects.filter((object) => object.kind === 'tree')).toHaveLength(10);
    expect(plan.objects.filter((object) => object.kind === 'rock')).toHaveLength(4);
    const ids = new Set(plan.objects.map((object) => object.id));
    expect(ids.size).toBe(plan.objects.length);
    expect(plan.objects.every((object) => object.id.startsWith('obj_'))).toBe(true);
  });

  it('keeps islands above the water line', () => {
    const plan = generateWorldPlan(intentFor('A tropical island with 20 palm trees and 6 rocks'));
    expect(plan.terrain.waterLevel).not.toBeNull();
    const waterLevel = plan.terrain.waterLevel ?? 0;
    expect(plan.objects.length).toBeGreaterThan(10);
    for (const object of plan.objects) {
      expect(object.transform.position[1]).toBeGreaterThan(waterLevel);
      expect(Number.isFinite(object.transform.position[0])).toBe(true);
      expect(Number.isFinite(object.transform.position[2])).toBe(true);
    }
  });

  it('applies night environments with lanterns', () => {
    const plan = generateWorldPlan(intentFor('A quiet forest at night', 5));
    expect(plan.environment.sunIntensity).toBeLessThan(1);
    expect(plan.objects.some((object) => object.kind === 'lantern')).toBe(true);
  });

  it('creates genuinely visible inland water', () => {
    const cases: { prompt: string; style: string }[] = [
      { prompt: 'A mountain lake at sunset', style: 'mountains' },
      { prompt: 'A desert oasis at sunset', style: 'dunes' },
      { prompt: 'A forest lake', style: 'hills' },
    ];

    for (const testCase of cases) {
      const plan = generateWorldPlan(intentFor(testCase.prompt, 20261020));
      expect(plan.terrain.style).toBe(testCase.style);
      expect(plan.terrain.waterLevel).not.toBeNull();
      const water = plan.terrain.waterLevel ?? 0;
      const sampler = createTerrainSampler(plan.terrain, plan.seed);
      let below = 0;
      let above = 0;
      for (let x = -70; x <= 70; x += 10) {
        for (let z = -70; z <= 70; z += 10) {
          if (sampler.heightAt(x, z) < water) below += 1;
          else above += 1;
        }
      }
      expect(below).toBeGreaterThan(0);
      expect(above).toBeGreaterThan(0);
    }
  });

  it('rebuilds the starter world deterministically', () => {
    const starter = createStarterWorld();
    expect(starter.name).toBe('Welcome Meadow');
    expect(starter.objects.length).toBeGreaterThan(10);
    expect(starter.terrain.waterLevel).not.toBeNull();
    expect(createStarterWorld().objects).toEqual(starter.objects);
  });
});
