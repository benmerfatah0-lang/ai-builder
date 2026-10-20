import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { createBuilding, createTree } from '../../core/assets/catalog';
import { mulberry32 } from '../../core/generation/rng';
import { getNode, worldTransformOf } from '../../core/world-plan/hierarchy';
import {
  applyObjectPatch,
  createInitialEditorState,
  editorReducer,
  nextAvailableName,
  type EditorState,
} from './store';

function withTree(): { state: EditorState; treeId: string } {
  const plan = createEmptyWorldPlan({ name: 'State test', seed: 3 });
  const tree = createTree('pine', [0, 0, 0], mulberry32(11));
  plan.objects.push(tree);
  return { state: createInitialEditorState(plan), treeId: tree.id };
}

describe('editor reducer', () => {
  it('adds, selects, edits and deletes objects', () => {
    const state = createInitialEditorState(createEmptyWorldPlan({ seed: 1 }));
    const tree = createTree('pine', [1, 0, 2], mulberry32(5));

    const added = editorReducer(state, { type: 'addObject', object: tree });
    expect(added.plan.objects).toHaveLength(1);
    expect(added.selection).toEqual([tree.id]);

    const renamed = editorReducer(added, {
      type: 'updateObject',
      id: tree.id,
      patch: { name: 'Old Pine', color: '#112233', material: { roughness: 0.4 } },
    });
    expect(renamed.plan.objects[0]?.name).toBe('Old Pine');
    expect(renamed.plan.objects[0]?.color).toBe('#112233');
    expect(
      renamed.plan.objects[0]?.material?.roughness,
    ).toBeCloseTo(0.4, 3);

    const removed = editorReducer(renamed, { type: 'deleteSelection' });
    expect(removed.plan.objects).toHaveLength(0);
    expect(removed.selection).toEqual([]);
  });

  it('supports replace, add and toggle selection modes', () => {
    const plan = createEmptyWorldPlan({ seed: 2 });
    const a = createTree('pine', [0, 0, 0], mulberry32(1));
    const b = createTree('pine', [3, 0, 0], mulberry32(2));
    plan.objects.push(a, b);
    let state = createInitialEditorState(plan);

    state = editorReducer(state, { type: 'select', ids: [a.id], mode: 'replace' });
    expect(state.selection).toEqual([a.id]);

    state = editorReducer(state, { type: 'select', ids: [b.id], mode: 'add' });
    expect(state.selection).toEqual([a.id, b.id]);

    state = editorReducer(state, { type: 'select', ids: [a.id], mode: 'toggle' });
    expect(state.selection).toEqual([b.id]);

    state = editorReducer(state, { type: 'select', ids: [a.id, b.id], mode: 'toggle' });
    expect(state.selection).toEqual([a.id]);

    state = editorReducer(state, { type: 'select', ids: ['missing'], mode: 'replace' });
    expect(state.selection).toEqual([]);
  });

  it('moves, rotates and scales through setTransform', () => {
    const { state, treeId } = withTree();
    const moved = editorReducer(state, {
      type: 'setTransform',
      id: treeId,
      transform: {
        position: [4, 1, -2],
        rotation: [10, 45, 0],
        scale: [2, 1, 0.5],
      },
    });
    const tree = moved.plan.objects[0];
    expect(tree?.transform.position).toEqual([4, 1, -2]);
    expect(tree?.transform.rotation).toEqual([10, 45, 0]);
    expect(tree?.transform.scale).toEqual([2, 1, 0.5]);
  });

  it('clamps unsafe transforms and colors', () => {
    const { state, treeId } = withTree();
    const tree = state.plan.objects[0];
    if (!tree) throw new Error('expected tree');
    const patched = applyObjectPatch(tree, {
      transform: {
        position: [999999, 0, Number.NaN],
        rotation: [1000, -2000, 0],
        scale: [0, 2, 3],
      },
      color: 'not-a-color',
    });
    expect(patched.transform.position[0]).toBe(5000);
    expect(patched.transform.position[2]).toBe(tree.transform.position[2]);
    expect(patched.transform.rotation[0]).toBe(1000);
    expect(patched.transform.rotation[1]).toBe(-2000);
    expect(patched.transform.scale[0]).toBe(0.05);
    expect(patched.color).toBe(tree.color);

    const clamped = editorReducer(state, {
      type: 'setTransform',
      id: treeId,
      transform: {
        position: [0, 0, 0],
        rotation: [99999, 0, 0],
        scale: [1, 1, 1],
      },
    });
    expect(clamped.plan.objects[0]?.transform.rotation[0]).toBe(3600);
  });

  it('groups a multi-selection and ungroups it', () => {
    const plan = createEmptyWorldPlan({ seed: 4 });
    const tree = createTree('pine', [2, 0, 0], mulberry32(1));
    const house = createBuilding('house', [-2, 0, 1], mulberry32(2));
    plan.objects.push(tree, house);
    let state = createInitialEditorState(plan);
    const before = worldTransformOf(state.plan, tree.id);

    state = editorReducer(state, { type: 'select', ids: [tree.id, house.id], mode: 'replace' });
    state = editorReducer(state, { type: 'groupSelection' });

    expect(state.plan.groups).toHaveLength(1);
    const group = state.plan.groups[0];
    expect(group?.name).toBe('Group');
    expect(state.selection).toEqual([group?.id]);
    expect(state.plan.objects.every((object) => object.parentId === group?.id)).toBe(true);
    expect(worldTransformOf(state.plan, tree.id)?.position).toEqual(before?.position);

    const groupId = group?.id ?? '';
    state = editorReducer(state, { type: 'ungroup', id: groupId });
    expect(state.plan.groups).toHaveLength(0);
    expect(state.plan.objects.every((object) => object.parentId === null)).toBe(true);
  });

  it('renames, hides, locks and reparents nodes', () => {
    const { state, treeId } = withTree();
    const renamed = editorReducer(state, { type: 'renameNode', id: treeId, name: 'Big Pine' });
    expect(renamed.plan.objects[0]?.name).toBe('Big Pine');

    const hidden = editorReducer(renamed, { type: 'setVisible', id: treeId, visible: false });
    expect(hidden.plan.objects[0]?.visible).toBe(false);

    const locked = editorReducer(hidden, { type: 'setLocked', id: treeId, locked: true });
    expect(locked.plan.objects[0]?.locked).toBe(true);

    // Locked nodes reject transform changes and deletion.
    const blocked = editorReducer(locked, {
      type: 'setTransform',
      id: treeId,
      transform: { position: [9, 9, 9], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(blocked).toBe(locked);
    expect(editorReducer(locked, { type: 'deleteNode', id: treeId })).toBe(locked);
  });

  it('duplicates the selection with new ids', () => {
    const { state, treeId } = withTree();
    const selected = editorReducer(state, { type: 'select', ids: [treeId], mode: 'replace' });
    const duplicated = editorReducer(selected, { type: 'duplicateSelection' });
    expect(duplicated.plan.objects).toHaveLength(2);
    const copy = duplicated.plan.objects[1];
    expect(copy?.id).not.toBe(treeId);
    expect(copy?.name).toContain('copy');
    expect(duplicated.selection).toEqual([copy?.id]);
  });

  it('sets transforms in world space, even under a rotated group', () => {
    const plan = createEmptyWorldPlan({ seed: 21 });
    const tree = createTree('pine', [4, 0, 0], mulberry32(7));
    plan.objects.push(tree);
    let state = createInitialEditorState(plan);

    state = editorReducer(state, {
      type: 'setTransform',
      id: tree.id,
      transform: { position: [4, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
    });
    state = editorReducer(state, { type: 'select', ids: [tree.id], mode: 'replace' });
    state = editorReducer(state, { type: 'groupSelection' });
    const groupId = state.plan.groups[0]?.id;
    if (!groupId) throw new Error('expected group');

    // Rotating the parent by 90° means a local +X move becomes a world −Z move.
    state = editorReducer(state, {
      type: 'setTransform',
      id: groupId,
      transform: { position: [0, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1] },
    });

    const before = worldTransformOf(state.plan, tree.id);
    expect(before?.position[0]).toBeCloseTo(0, 4);
    expect(before?.position[2]).toBeCloseTo(-4, 4);

    // Snap-to-ground style world-space write: keep X/Z, set a new world Y.
    state = editorReducer(state, {
      type: 'setWorldTransform',
      id: tree.id,
      transform: {
        ...(before ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }),
        position: [before?.position[0] ?? 0, 2.5, before?.position[2] ?? 0],
      },
    });

    const after = worldTransformOf(state.plan, tree.id);
    expect(after?.position[1]).toBeCloseTo(2.5, 4);
    expect(after?.position[0]).toBeCloseTo(0, 4);
    expect(after?.position[2]).toBeCloseTo(-4, 4);
    // The document still stores a local transform.
    expect(getNode(state.plan, tree.id)?.transform.position[0]).toBeCloseTo(4, 1);
  });

  it('undoes and redoes hierarchy changes', () => {
    const { state, treeId } = withTree();
    const moved = editorReducer(state, {
      type: 'setTransform',
      id: treeId,
      transform: { position: [5, 0, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    });
    expect(moved.plan.objects[0]?.transform.position).toEqual([5, 0, 5]);

    const undone = editorReducer(moved, { type: 'undo' });
    expect(undone.plan.objects[0]?.transform.position).toEqual([0, 0, 0]);
    expect(undone.future).toHaveLength(1);

    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.plan.objects[0]?.transform.position).toEqual([5, 0, 5]);
  });

  it('clamps environment and terrain edits', () => {
    const state = createInitialEditorState(createEmptyWorldPlan({ seed: 1 }));
    const env = editorReducer(state, {
      type: 'updateEnvironment',
      patch: { sunIntensity: 99, sunElevation: -5, skyColor: '#abcdef' },
    });
    expect(env.plan.environment.sunIntensity).toBe(4);
    expect(env.plan.environment.sunElevation).toBe(0);
    expect(env.plan.environment.skyColor).toBe('#abcdef');

    const terrain = editorReducer(env, {
      type: 'updateTerrain',
      patch: { size: 9000, heightScale: -20, palette: { low: '#123456', high: 'bad' } },
    });
    expect(terrain.plan.terrain.size).toBe(512);
    expect(terrain.plan.terrain.heightScale).toBe(0);
    expect(terrain.plan.terrain.waterLevel).toBeNull();
    expect(terrain.plan.terrain.palette.low).toBe('#123456');
    expect(terrain.plan.terrain.palette.high).toBe(state.plan.terrain.palette.high);

    const withWater = editorReducer(terrain, {
      type: 'updateTerrain',
      patch: { waterLevel: 0.5 },
    });
    expect(withWater.plan.terrain.waterLevel).toBe(0.5);
  });

  it('clears selection when a plan is replaced', () => {
    const { state } = withTree();
    const next = createEmptyWorldPlan({ name: 'Other', seed: 2 });
    const replaced = editorReducer(state, { type: 'replacePlan', plan: next });
    expect(replaced.selection).toEqual([]);
    expect(replaced.plan.id).toBe(next.id);
    expect(replaced.past).toHaveLength(1);
  });

  it('keeps node ids stable across unrelated edits', () => {
    const { state, treeId } = withTree();
    const edited = editorReducer(state, { type: 'renameWorld', name: 'Renamed' });
    expect(getNode(edited.plan, treeId)).not.toBeNull();
    expect(edited.plan.objects[0]?.id).toBe(treeId);
  });

  it('generates unique names for new assets', () => {
    const plan = createEmptyWorldPlan({ seed: 1 });
    const tree = createTree('pine', [0, 0, 0], mulberry32(1));
    plan.objects.push({ ...tree, name: 'Pine tree' });
    expect(nextAvailableName(plan, 'Pine tree')).toBe('Pine tree 2');
    expect(nextAvailableName(plan, 'Cube')).toBe('Cube');
  });
});
