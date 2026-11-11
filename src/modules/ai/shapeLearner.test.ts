import { describe, expect, it } from 'vitest';
import { createBuilding, createRock, createTree } from '../../core/assets/catalog';
import { mulberry32 } from '../../core/generation/rng';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';
import { interpretPromptLocally } from './promptInterpreter';
import { initialShapeModel, readShapeModel, resetShapeModel, saveShapeModel, trainShapeModel } from './shapeLearner';
import { buildWorldScene, disposeObject3D, findNodeObject } from '../../core/scene/sceneBuilder';
import { worldPlanSchema } from '../../core/world-plan/schema';
import { exportWorldToGlb } from '../../core/export/gltf';

function storage() {
  const items = new Map<string, string>();
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v); }, removeItem: (k: string) => { items.delete(k); } };
}
describe('small trainable procedural shape model', () => {
  it('learns from an explicitly supplied house, persists, reloads and resets', () => {
    const store = storage();
    const before = initialShapeModel();
    const base = createBuilding('house', [0, 0, 0], mulberry32(1));
    const example = { ...base, transform: { ...base.transform, scale: [1.8, 0.7, 1.4] as [number, number, number] } };
    const trained = trainShapeModel(before, example);
    expect(trained.house.count).toBe(4);
    expect(trained.house.mean[0]).toBeGreaterThan(before.house.mean[0]);
    expect(trained.tree).toEqual(before.tree);
    const originalIntent = interpretPromptLocally('بيت', { seed: 44 }).intent;
    const first = generateWorldPlanWithReport({ ...originalIntent, shapeModel: before }).plan.objects[0]!;
    const second = generateWorldPlanWithReport({ ...originalIntent, shapeModel: trained }).plan.objects[0]!;
    expect(second.transform.scale[0]).toBeGreaterThan(first.transform.scale[0]);
    expect(second.meta.learnedShape?.seed).toBe(first.meta.learnedShape?.seed);
    saveShapeModel(store, trained);
    expect(readShapeModel(store)).toEqual(trained);
    expect(resetShapeModel(store)).toEqual(before);
    expect(readShapeModel(store)).toEqual(before);
  });
  it('does not train unsupported objects and handles invalid or corrupted storage', () => {
    const tower = createBuilding('tower', [0, 0, 0], mulberry32(1));
    expect(() => trainShapeModel(initialShapeModel(), tower)).toThrow('اختر بيتاً');
    const store = storage(); store.setItem('world-builder-shape-model-v1', '{"version":1,"house":{}}');
    expect(readShapeModel(store)).toEqual(initialShapeModel());
    expect(() => saveShapeModel({ setItem() { throw new Error('storage full'); } }, initialShapeModel())).toThrow('storage full');
  });
  it('training each category changes its parameters and survives JSON serialization', () => {
    let model = initialShapeModel();
    for (const object of [createBuilding('house', [0, 0, 0], mulberry32(1)), createTree('broadleaf', [0, 0, 0], mulberry32(2)), createRock('boulder', [0, 0, 0], mulberry32(3))]) model = trainShapeModel(model, object);
    expect([model.house.count, model.tree.count, model.rock.count]).toEqual([4, 4, 4]);
    const store = storage(); saveShapeModel(store, model);
    expect(readShapeModel(store)).toEqual(model);
  });
  it('changes real geometry, keeps generated parameters in the world and exports a GLB', async () => {
    const intent = interpretPromptLocally('بيت وشجرة وصخرة', { seed: 4321 }).intent;
    const normal = generateWorldPlanWithReport(intent).plan;
    intent.shapeModel = initialShapeModel();
    const report = generateWorldPlanWithReport(intent);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects).toHaveLength(3);
    expect(report.plan.objects.every((object) => object.meta.learnedShape !== undefined)).toBe(true);
    const parsed = worldPlanSchema.parse(JSON.parse(JSON.stringify(report.plan)));
    expect(parsed.objects.map((x) => x.meta.learnedShape)).toEqual(report.plan.objects.map((x) => x.meta.learnedShape));
    const scene = buildWorldScene(parsed, { includeLights: false });
    const oldScene = buildWorldScene(normal, { includeLights: false });
    for (const object of parsed.objects) expect(findNodeObject(scene, object.id)?.children.length).toBeGreaterThan(0);
    const house = parsed.objects.find((object) => object.kind === 'building')!;
    const oldHouse = normal.objects.find((object) => object.kind === 'building')!;
    expect(findNodeObject(scene, house.id)?.children.length).not.toBe(findNodeObject(oldScene, oldHouse.id)?.children.length);
    const glb = await exportWorldToGlb(parsed);
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
    expect(glb.objectCount).toBe(3);
    disposeObject3D(scene); disposeObject3D(oldScene);
  }, 20000);
});
