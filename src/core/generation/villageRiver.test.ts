import { describe, expect, it } from 'vitest';
import { createBuilding, createTree } from '../assets/catalog';
import { mulberry32 } from './rng';
import { footprintFromObject, footprintsOverlap } from './placement';
import { worldTransformOf } from '../world-plan/hierarchy';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { deserializeWorldPlan, serializeWorldPlan } from '../world-plan/migrate';
import { validateWorldPlan } from '../world-plan/schema';
import { editWorldByText } from '../../modules/ai/worldEdit';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from './generateWorld';
import { createInitialEditorState, editorReducer } from '../../modules/editor/store';
import { exportWorldToGlb } from '../export/gltf';
import { buildWorldScene, disposeObject3D } from '../scene/sceneBuilder';

function village() {
  const plan = createEmptyWorldPlan({ seed: 81 });
  plan.terrain = { ...plan.terrain, style: 'flat', heightScale: 0 };
  const rng = mulberry32(5);
  plan.objects = [[-16,-10], [-16,10], [16,-10], [16,10]].map(([x,z]) => createBuilding('house', [x!,0,z!], rng));
  plan.objects.push(createTree('broadleaf', [25,0,30], rng));
  return plan;
}

describe('village river construction', () => {
  it('adds real river geometry between existing houses, preserves all objects, supports undo and GLB', async () => {
    const plan = village();
    const initial = structuredClone(plan);
    const { plan: result, message } = editWorldByText(plan, [], 'اصنع لي نهرا يمر وسط القرية');
    expect(plan).toEqual(initial);
    expect(result.objects.slice(0, -1)).toEqual(plan.objects);
    const river = result.objects.at(-1)!;
    expect(river.kind).toBe('river');
    if (river.kind !== 'river') throw new Error('missing river');
    expect(river.points.length).toBeGreaterThan(2);
    expect(river.transform.position[0]).toBeCloseTo(0);
    expect(river.points[0]![2]).toBe(0);
    expect(river.points.at(-1)![2]).toBeGreaterThan(20);
    expect(message).toContain('لا يحفر الأرض');
    expect(validateWorldPlan(result).success).toBe(true);
    expect(deserializeWorldPlan(serializeWorldPlan(result)).objects.at(-1)).toEqual(river);
    const scene = buildWorldScene(result, { includeLights: false });
    let mesh = false; scene.traverse((child) => { if (child.name === 'river-water') mesh = true; });
    expect(mesh).toBe(true); disposeObject3D(scene);
    const glb = await exportWorldToGlb(result);
    expect(glb.objectCount).toBe(result.objects.length);
    let state = createInitialEditorState(plan);
    state = editorReducer(state, { type: 'replacePlan', plan: result });
    state = editorReducer(state, { type: 'undo' });
    expect(state.plan.objects).toEqual(plan.objects);
    expect(state.plan.id).toBe(plan.id);
    state = editorReducer(state, { type: 'redo' });
    expect(state.plan.objects.at(-1)?.kind).toBe('river');
  }, 20000);
  it('safely rejects no village, no corridor, existing river, and multiple villages', () => {
    const plan = village();
    const before = structuredClone(plan);
    expect(() => editWorldByText({ ...plan, objects: [] }, [], 'أضف نهر وسط القرية')).toThrow('بيتين');
    const blocked = village();
    for (let x = -12; x <= 12; x += 3) blocked.objects.push(createTree('broadleaf', [x, 0, 0], mulberry32(x + 40)));
    expect(() => editWorldByText(blocked, [], 'أضف نهر وسط القرية')).toThrow('ممراً');
    const once = editWorldByText(plan, [], 'أضف نهر وسط القرية').plan;
    expect(() => editWorldByText(once, [], 'أضف نهر وسط القرية')).toThrow('يوجد نهر');
    expect(() => editWorldByText(plan, [], 'أضف نهر وسط القرية واحذف البيت')).toThrow();
    expect(plan).toEqual(before);
    const two = village();
    two.terrain = { ...two.terrain, size: 300 };
    const rng = mulberry32(7);
    two.objects.push(createBuilding('house', [110, 0, -10], rng), createBuilding('house', [110, 0, 10], rng));
    expect(() => editWorldByText(two, [], 'أضف نهر وسط القرية')).toThrow('اختر بيتاً');
    expect(editWorldByText(two, [two.objects[0]!.id], 'أضف نهر وسط القرية').plan.objects.at(-1)?.kind).toBe('river');
  });
  it('routes around existing objects for generated villages without crossing their footprints', () => {
    let detours = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const plan = generateWorldPlanWithReport(interpretPromptLocally('قرية', { seed }).intent).plan;
      const result = editWorldByText(plan, [], 'أضف نهر وسط القرية');
      if (result.message.includes('متعرج')) detours++;
      const river = result.plan.objects.at(-1)!;
      if (river.kind !== 'river') throw new Error('missing river');
      const points = river.points.map((p) => [p[0] + river.transform.position[0], p[2] + river.transform.position[2]]);
      for (const object of plan.objects) {
        const transform = worldTransformOf(plan, object.id)!;
        const box = footprintFromObject({ ...object, transform, meta: { ...object.meta, collision: { shape: 'box', blocking: true } } })!;
        for (let i = 1; i < points.length; i++) {
          const [x1,z1] = points[i - 1]!, [x2,z2] = points[i]!;
          const radius = (river.width + 1.1) / 2;
          const segment = { minX: Math.min(x1!,x2!) - radius, maxX: Math.max(x1!,x2!) + radius, minZ: Math.min(z1!,z2!) - radius, maxZ: Math.max(z1!,z2!) + radius };
          expect(footprintsOverlap(box, segment)).toBe(false);
        }
      }
    }
    expect(detours).toBeGreaterThan(0);
  });
  it('generates a village with a central reserved river corridor, not a flat water plane', () => {
    for (const seed of [1, 2, 3, 9, 81, 123]) {
      const intent = interpretPromptLocally('قرية فيها نهر يمر وسط القرية', { seed }).intent;
      expect(intent.villageRiver).toBe(true);
      const result = generateWorldPlanWithReport(intent);
      expect(result.validation.valid).toBe(true);
      expect(result.plan.terrain.waterLevel).toBeNull();
      const river = result.plan.objects.find((object) => object.kind === 'river');
      expect(river).toBeTruthy();
      const buildings = result.plan.objects.filter((object) => object.kind === 'building');
      expect(buildings.some((o) => o.transform.position[0] < -7)).toBe(true);
      expect(buildings.some((o) => o.transform.position[0] > 7)).toBe(true);
      expect(result.plan.objects.filter((o) => o.kind !== 'river').every((o) => Math.abs(o.transform.position[0]) >= 7)).toBe(true);
    }
    expect(interpretPromptLocally('قرية وسط الغابة وفيها نهر').intent.villageRiver).toBeFalsy();
    expect(interpretPromptLocally('قرية بدون نهر يمر وسط القرية').intent.villageRiver).toBeFalsy();
  });
});
