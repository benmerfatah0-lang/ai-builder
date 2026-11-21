import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from './generateWorld';
import { footprintFromObject, footprintsOverlap } from './placement';
import { validateWorldPlan } from '../world-plan/schema';

const generate = (prompt: string, seed = 31) => {
  const intent = interpretPromptLocally(prompt, { seed }).intent;
  return { intent, ...generateWorldPlanWithReport(intent) };
};

describe('local descriptive landscape composition', () => {
  it('retains a named forest around explicit assets without adding extra trees', () => {
    const { plan, validation } = generate('غابة فيها بيت و3 أشجار');
    expect(validation.valid).toBe(true);
    expect(plan.objects.filter((o) => o.kind === 'building')).toHaveLength(1);
    expect(plan.objects.filter((o) => o.kind === 'tree')).toHaveLength(3);
    expect(plan.objects.filter((o) => o.kind === 'rock').length).toBeGreaterThan(0);
    expect(generate('بيت و3 أشجار').plan.objects).toHaveLength(4);
    expect(generate('ثلاث بيوت').plan.objects).toHaveLength(3);
  });
  it('places forest trees around explicitly requested shrubs and respects negative counts', () => {
    const { plan } = generate('غابة كثيفة فيها شجيرات ونهر');
    expect(plan.objects.filter((o) => o.kind === 'tree' && o.variant === 'bush')).toHaveLength(3);
    expect(plan.objects.filter((o) => o.kind === 'tree' && o.variant !== 'bush').length).toBeGreaterThan(50);
    expect(plan.objects.some((o) => o.kind === 'river')).toBe(true);
    const without = generate('غابة فيها بيت بدون أشجار وبدون صخور').plan;
    expect(without.objects.some((o) => o.kind === 'tree' || o.kind === 'rock')).toBe(false);
    expect(generate('غابة بدون نهر').plan.objects.some((o) => o.kind === 'river')).toBe(false);
    expect(generate('غابة بدون بحيرة').plan.terrain.waterLevel).toBeNull();
  });
  it('interprets density and preserves explicit quantities in Arabic and English', () => {
    expect(generate('غابة كثيفة').intent.counts.trees).toBeGreaterThan(generate('غابة').intent.counts.trees);
    expect(generate('غابة متناثرة').intent.counts.trees).toBeLessThan(generate('غابة').intent.counts.trees);
    expect(generate('forest with no trees and a house').plan.objects.some((o) => o.kind === 'tree')).toBe(false);
    expect(generate('forest with no trees and a house').plan.objects.filter((o) => o.kind === 'building')).toHaveLength(1);
    expect(generate('a dense forest with 3 trees').plan.objects.filter((o) => o.kind === 'tree')).toHaveLength(3);
  });
  it('combines forest palette with mountain terrain and an explicitly requested river', () => {
    const { intent, plan, warnings, validation } = generate('قرية وسط غابة كثيفة مع نهر وجبال');
    expect(intent.biome).toBe('forest');
    expect(plan.terrain.style).toBe('mountains');
    expect(plan.terrain.waterLevel).toBeNull();
    expect(plan.objects.some((o) => o.kind === 'river')).toBe(true);
    expect(plan.objects.some((o) => o.kind === 'building')).toBe(true);
    expect(warnings.join(' ')).toContain('زخرفي');
    expect(validation.valid && validateWorldPlan(plan).success).toBe(true);
    expect(generate('غابة بدون جبال').plan.terrain.style).not.toBe('mountains');
  });
  it('reserves the river corridor, aligns a bridge, and checks collisions in explicit backgrounds', () => {
    for (const seed of [1, 2, 3, 9, 31]) {
      const { plan, validation } = generate('غابة فيها بيت وشجيرات ونهر وجسر', seed);
      expect(validation.valid).toBe(true);
      const bridge = plan.objects.find((o) => o.kind === 'bridge')!;
      expect(bridge.transform.position[0]).toBe(0);
      expect(bridge.transform.rotation[1]).toBe(90);
      const solids = plan.objects.filter((o) => o.kind !== 'river' && o.kind !== 'path');
      for (let i = 0; i < solids.length; i++) {
        const a = footprintFromObject(solids[i]!);
        if (solids[i]!.kind !== 'bridge') expect(Math.abs(solids[i]!.transform.position[0])).toBeGreaterThan(4);
        for (let j = i + 1; j < solids.length; j++) {
          const b = footprintFromObject(solids[j]!);
          if (a && b) expect(footprintsOverlap(a, b)).toBe(false);
        }
      }
    }
  });
  it('reproduces the same placement with the same description and seed', () => {
    const prompt = 'غابة فيها بيت وشجيرات ونهر';
    expect(generate(prompt).plan.objects).toEqual(generate(prompt).plan.objects);
  });
});
