import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from './generateWorld';
import { buildWorldScene, disposeObject3D, findNodeObject } from '../scene/sceneBuilder';
import { exportWorldToGlb } from '../export/gltf';
import { worldPlanSchema } from '../world-plan/schema';

const prompt = 'مدينة صحراوية قديمة فيها منجم عميق للذهب ب عربات و معاول وحفارات و صنديق';
describe('desert mining example', () => {
  it('parses and places the original Arabic brief with houses and each requested mining object', () => {
    const intent = interpretPromptLocally(prompt, { seed: 42 }).intent;
    expect(intent.biome).toBe('desert');
    expect(intent.assets?.map(({ assetId, count }) => [assetId, count])).toEqual([
      ['mine-entrance', 1], ['mine-cart', 3], ['pickaxe', 3], ['excavator', 3], ['chest', 1], ['house', 5],
    ]);
    const report = generateWorldPlanWithReport(intent);
    expect(report.plan.objects.filter((object) => object.kind === 'building').every((object) => object.meta.desertHouse)).toBe(true);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects.filter((object) => object.kind === 'primitive' || object.kind === 'building')).toHaveLength(16);
    expect(report.plan.objects.some((object) => object.kind === 'rock')).toBe(true);
    const mine = report.plan.objects.find((o) => o.kind === 'primitive' && o.primitive === 'mine-entrance')!;
    for (const object of report.plan.objects.filter((o) => o.kind === 'primitive' && o.id !== mine.id)) {
      expect(Math.hypot(object.transform.position[0] - mine.transform.position[0], object.transform.position[2] - mine.transform.position[2])).toBeLessThan(30);
    }
    expect(generateWorldPlanWithReport(intent).plan.objects).toEqual(report.plan.objects);
  });
  it('understands attached prepositions, explicit quantities and negation', () => {
    const intent = interpretPromptLocally('منجم مع 4 عربات و2 معاول بدون حفارات وصناديق', { seed: 1 }).intent;
    expect(intent.assets?.find((x) => x.assetId === 'mine-cart')?.count).toBe(4);
    // The existing grammar requires whitespace after a number; ensure the attached form is supported too.
    expect(intent.assets?.find((x) => x.assetId === 'pickaxe')?.count).toBe(2);
    expect(intent.assets?.some((x) => x.assetId === 'excavator')).toBe(false);
    const noHouses = interpretPromptLocally('مدينة صحراوية فيها منجم بدون بيوت', { seed: 1 }).intent;
    expect(noHouses.assets?.some((x) => x.assetId === 'house')).toBe(false);
    const prefixed = interpretPromptLocally('منجم بعربات ومعاول وحفارات وصناديق', { seed: 1 }).intent;
    expect(prefixed.assets?.map((x) => x.assetId)).toEqual(['mine-entrance', 'mine-cart', 'pickaxe', 'excavator', 'chest']);
  });
  it('renders real meshes, serializes and exports them to binary GLB', async () => {
    const intent = interpretPromptLocally(prompt, { seed: 42 }).intent;
    const plan = worldPlanSchema.parse(JSON.parse(JSON.stringify(generateWorldPlanWithReport(intent).plan)));
    const scene = buildWorldScene(plan, { includeLights: false });
    for (const object of plan.objects) {
      const group = findNodeObject(scene, object.id);
      let meshes = 0;
      group?.traverse((part) => { if (part.type === 'Mesh') meshes++; });
      expect(meshes, object.name).toBeGreaterThan(0);
    }
    const glb = await exportWorldToGlb(plan);
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
    expect(glb.objectCount).toBe(plan.objects.length);
    disposeObject3D(scene);
  }, 20000);
});
