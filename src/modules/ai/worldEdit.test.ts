import { describe, expect, it } from 'vitest';
import { createBuilding, createTree } from '../../core/assets/catalog';
import { mulberry32 } from '../../core/generation/rng';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { createInitialEditorState, editorReducer } from '../editor/store';
import { editWorldByText } from './worldEdit';
import { validateWorldPlan, type WorldPlan } from '../../core/world-plan/schema';
import { exportWorldToGlb } from '../../core/export/gltf';

function base(): WorldPlan {
  const plan = createEmptyWorldPlan({ name: 'Original', seed: 41 });
  plan.terrain = { ...plan.terrain, style: 'flat', heightScale: 0 };
  const rng = mulberry32(12);
  plan.objects = [createBuilding('house', [0, 0, 0], rng), createTree('broadleaf', [-20, 0, 0], rng)];
  return plan;
}

describe('atomic editing with a small, explicit vocabulary', () => {
  it('adds a specified number on the requested side without changing existing objects', () => {
    const plan = base();
    const original = structuredClone(plan);
    const { plan: result, message } = editWorldByText(plan, [], 'أضف شجرتين على يمين البيت');
    expect(plan).toEqual(original);
    expect(result.id).toBe(plan.id);
    expect(result.objects.slice(0, 2)).toEqual(plan.objects);
    expect(result.objects).toHaveLength(4);
    expect(result.objects.slice(2).every((object) => object.transform.position[0] > 0)).toBe(true);
    expect(result.objects.slice(2).every((object) => object.meta.status === 'edited')).toBe(true);
    expect(message).toContain('2');
    expect(editWorldByText(plan, [], 'اصنع لي شجرتين على يمين البيت').plan.objects).toHaveLength(4);
    expect(validateWorldPlan(result).success).toBe(true);
  });
  it('uses a validated thumbnail-derived color only on the newly added house', () => {
    const plan = base();
    const result = editWorldByText(plan, [], 'أضف بيت', undefined, '#a04020').plan;
    expect(result.objects.slice(0, 2)).toEqual(plan.objects);
    const object = result.objects.at(-1)!;
    expect(object.kind === 'building' && object.color).toBe('#a04020');
    expect(validateWorldPlan(result).success).toBe(true);
    const invalid = editWorldByText(plan, [], 'أضف بيت', undefined, 'javascript:bad').plan;
    const invalidObject = invalid.objects.at(-1)!;
    expect(invalidObject.kind === 'building' && invalidObject.color).not.toBe('javascript:bad');
  });
  it('colors, resizes, moves and deletes exactly one matched object', () => {
    const plan = base();
    const house = plan.objects[0]!;
    const color = editWorldByText(plan, [], 'لوّن البيت أحمر').plan;
    expect(color.objects[0]!.kind === 'building' && color.objects[0]!.color).toBe('#c94b48');
    const grown = editWorldByText(color, [], 'كبّر البيت').plan;
    expect(grown.objects[0]!.transform.scale[0]).toBeCloseTo(house.transform.scale[0] * 1.25);
    const moved = editWorldByText(grown, [], 'حرك البيت إلى يسار الشجرة').plan;
    expect(moved.objects[0]!.transform.position[0]).toBeLessThan(moved.objects[1]!.transform.position[0]);
    const deleted = editWorldByText(moved, [], 'احذف البيت').plan;
    expect(deleted.objects).toHaveLength(1);
    expect(deleted.objects[0]!.id).toBe(plan.objects[1]!.id);
  });
  it('refuses ambiguity, locked items, compound and unsupported requests without changing the plan', () => {
    const plan = base();
    plan.objects.push(createBuilding('house', [20, 0, 0], mulberry32(6)));
    const before = structuredClone(plan);
    expect(() => editWorldByText(plan, [], 'احذف البيت')).toThrow('أكثر من');
    expect(() => editWorldByText(plan, [], 'احذف كل البيوت')).toThrow();
    expect(() => editWorldByText(plan, [], 'أضف شجرة وبيت')).toThrow();
    expect(() => editWorldByText(plan, [], 'أضف شجرة على يمين البيت واحذفه')).toThrow();
    expect(() => editWorldByText(plan, [], 'لون سقف البيت أحمر')).toThrow();
    expect(() => editWorldByText(plan, [], 'احذف البيت الأحمر')).toThrow();
    expect(() => editWorldByText(plan, [], 'أضف بيت أحمر')).toThrow();
    expect(() => editWorldByText(plan, [], 'احذف البيت العملاق')).toThrow('لم أفهم');
    expect(() => editWorldByText(plan, [], 'حرّك البيت 2 يمين الشجرة')).toThrow();
    expect(() => editWorldByText(plan, [], 'أضف شجرة 5 على يمين البيت')).toThrow();
    expect(() => editWorldByText(plan, [], 'احذف العنصر المحدد')).toThrow();
    expect(() => editWorldByText(plan, [plan.objects[1]!.id], 'احذف البيت المحدد')).toThrow('لا يطابق');
    expect(() => editWorldByText(plan, [plan.objects[1]!.id], 'أضف شجرة يمين البيت المحدد')).toThrow('لا يطابق');
    expect(() => editWorldByText(plan, [], 'اصنع قلعة')).toThrow();
    const locked = { ...plan, objects: plan.objects.map((object, index) => index ? object : { ...object, locked: true }) };
    expect(() => editWorldByText(locked, [plan.objects[0]!.id], 'احذف البيت')).toThrow('مقفل');
    expect(plan).toEqual(before);
    const deleted = editWorldByText(plan, [plan.objects[0]!.id], 'احذف البيت').plan;
    expect(deleted.objects.some((item) => item.id === plan.objects[0]!.id)).toBe(false);
    expect(deleted.objects.some((item) => item.id === plan.objects[2]!.id)).toBe(true);
    const selected = editWorldByText(plan, [plan.objects[0]!.id], 'كبر العنصر المحدد').plan;
    expect(selected.objects[0]!.transform.scale[0]).toBeGreaterThan(plan.objects[0]!.transform.scale[0]);
  });
  it('respects locked ancestors and does not move grouped objects as if they were at root', () => {
    const plan = base();
    const group = { nodeType: 'group' as const, id: 'group_test', name: 'Group', parentId: null, transform: { position: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] }, visible: true, locked: true };
    plan.groups = [group];
    plan.objects[0] = { ...plan.objects[0]!, parentId: group.id };
    expect(() => editWorldByText(plan, [], 'احذف البيت')).toThrow('مقفل');
    plan.groups[0] = { ...group, locked: false };
    expect(() => editWorldByText(plan, [], 'كبر البيت')).toThrow('المجموعات');
    const recolored = editWorldByText(plan, [], 'لون البيت ازرق').plan;
    expect(recolored.objects[0]!.kind === 'building' && recolored.objects[0]!.color).toBe('#4c85cb');
  });
  it('rejects unsupported counts and no-room placement atomically', () => {
    const plan = base();
    expect(() => editWorldByText(plan, [], 'أضف 999 شجرة')).toThrow('20');
    expect(() => editWorldByText(plan, [], 'احذف شجرتين')).toThrow('عنصر واحد');
    const water = { ...plan, terrain: { ...plan.terrain, waterLevel: 100 } };
    expect(() => editWorldByText(water, [], 'أضف شجرة')).toThrow('مساحة');
    expect(water.objects).toHaveLength(2);
  });
  it('is one undoable action and still exports a GLB', async () => {
    const plan = base();
    const edited = editWorldByText(plan, [], 'أضف 2 صخور').plan;
    let state = createInitialEditorState(plan);
    state = editorReducer(state, { type: 'replacePlan', plan: edited });
    const glb = await exportWorldToGlb(state.plan);
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
    expect(glb.objectCount).toBe(4);
    state = editorReducer(state, { type: 'undo' });
    expect(state.plan.objects).toEqual(plan.objects);
    expect(state.plan.id).toEqual(plan.id);
    state = editorReducer(state, { type: 'redo' });
    expect(state.plan.objects).toEqual(edited.objects);
    expect(state.plan.id).toEqual(edited.id);
  }, 20000);
});
