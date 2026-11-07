import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from './generateWorld';

function generate(prompt: string) {
  const intent = interpretPromptLocally(prompt, { seed: 12345 }).intent;
  return { intent, ...generateWorldPlanWithReport(intent) };
}

describe('prompt-driven library layouts', () => {
  it('places Arabic asset names and quantities using catalog variants', () => {
    const { intent, plan, validation } = generate('بيت و ٣ أشجار و 2 صخور ومكعب');
    expect(intent.assets?.map((entry) => [entry.assetId, entry.count])).toEqual([
      ['house', 1], ['tree', 3], ['boulder', 2], ['box', 1],
    ]);
    expect(plan.objects.filter((o) => o.kind === 'building' && o.variant === 'house')).toHaveLength(1);
    expect(plan.objects.filter((o) => o.kind === 'tree')).toHaveLength(3);
    expect(plan.objects.filter((o) => o.kind === 'rock')).toHaveLength(2);
    expect(plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'box')).toHaveLength(1);
    expect(plan.objects.every((o) => o.meta.source === 'library')).toBe(true);
    expect(validation.valid).toBe(true);
  });

  it('honors directional and nearby relationships', () => {
    const { plan } = generate('بيت على يمين شجرة');
    const house = plan.objects.find((o) => o.kind === 'building');
    const tree = plan.objects.find((o) => o.kind === 'tree');
    expect(house && tree).toBeTruthy();
    expect(house!.transform.position[0]).toBeGreaterThan(tree!.transform.position[0]);
    const near = generate('منزل بجانب برج').plan.objects.filter((o) => o.kind === 'building');
    expect(near).toHaveLength(2);
    expect(Math.hypot(near[0]!.transform.position[0] - near[1]!.transform.position[0], near[0]!.transform.position[2] - near[1]!.transform.position[2])).toBeLessThan(20);
  });

  it('supports English relations, negative requests and reproducible layouts', () => {
    const prompt = 'a house to the left of 2 palm trees';
    const first = generate(prompt);
    const second = generate(prompt);
    expect(first.plan.objects).toEqual(second.plan.objects);
    const house = first.plan.objects.find((o) => o.kind === 'building')!;
    const palm = first.plan.objects.find((o) => o.kind === 'tree' && o.variant === 'palm')!;
    expect(house.transform.position[0]).toBeLessThan(palm.transform.position[0]);
    expect(first.plan.objects.filter((o) => o.kind === 'tree')).toHaveLength(2);
    expect(generate('بيت بدون أشجار').plan.objects.some((o) => o.kind === 'tree')).toBe(false);
  });

  it('handles Arabic dual nouns and warns when requests exceed the placement limit', () => {
    const dual = generate('بيت بجانب شجرتين');
    expect(dual.plan.objects.filter((o) => o.kind === 'tree')).toHaveLength(2);
    const many = generate('999 مكعب');
    expect(many.plan.objects.length).toBeLessThanOrEqual(300);
    expect(many.warnings.join(' ')).toContain('999');
  });

  it('keeps unrelated biomes on the existing landscape generator', () => {
    const { intent, plan } = generate('A misty forest at night');
    expect(intent.assets).toBeUndefined();
    expect(plan.objects.filter((o) => o.kind === 'tree').length).toBeGreaterThan(10);
  });
});
