import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { createTree } from '../../core/assets/catalog';
import { mulberry32 } from '../../core/generation/rng';
import {
  applyObjectPatch,
  createInitialEditorState,
  editorReducer,
  type EditorState,
} from './store';

function stateWithTree(): EditorState {
  const plan = createEmptyWorldPlan({ name: 'State test', seed: 3 });
  plan.objects.push(createTree('pine', [0, 0, 0], mulberry32(11)));
  return createInitialEditorState(plan);
}

describe('editor reducer', () => {
  it('adds, selects, edits and deletes objects', () => {
    const state = createInitialEditorState(createEmptyWorldPlan({ seed: 1 }));
    const tree = createTree('pine', [1, 0, 2], mulberry32(5));

    const added = editorReducer(state, { type: 'addObject', object: tree });
    expect(added.plan.objects).toHaveLength(1);
    expect(added.selectedId).toBe(tree.id);
    expect(added.revision).toBe(1);

    const renamed = editorReducer(added, {
      type: 'updateObject',
      id: tree.id,
      patch: { name: 'Old Pine', color: '#112233' },
    });
    expect(renamed.plan.objects[0]?.name).toBe('Old Pine');
    expect(renamed.plan.objects[0]?.color).toBe('#112233');

    const removed = editorReducer(renamed, { type: 'removeObject', id: tree.id });
    expect(removed.plan.objects).toHaveLength(0);
    expect(removed.selectedId).toBeNull();
  });

  it('undoes and redoes changes', () => {
    const state = stateWithTree();
    const treeId = state.plan.objects[0]?.id ?? '';
    const edited = editorReducer(state, {
      type: 'updateObject',
      id: treeId,
      patch: { name: 'Renamed' },
    });
    expect(edited.plan.objects[0]?.name).toBe('Renamed');

    const undone = editorReducer(edited, { type: 'undo' });
    expect(undone.plan.objects[0]?.name).toBe('Pine');
    expect(undone.future).toHaveLength(1);

    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.plan.objects[0]?.name).toBe('Renamed');
  });

  it('clamps unsafe transforms and colors', () => {
    const state = stateWithTree();
    const tree = state.plan.objects[0];
    if (!tree) throw new Error('expected tree');
    const patched = applyObjectPatch(tree, {
      transform: {
        position: [999999, 0, Number.NaN],
        rotationY: 1000,
        scale: [0, 2, 3],
      },
      color: 'not-a-color',
    });
    expect(patched.transform.position[0]).toBe(2000);
    expect(patched.transform.position[2]).toBe(tree.transform.position[2]);
    expect(patched.transform.rotationY).toBe(360);
    expect(patched.transform.scale[0]).toBe(0.05);
    expect(patched.color).toBe(tree.color);
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

    const withoutWater = editorReducer(withWater, {
      type: 'updateTerrain',
      patch: { waterLevel: null },
    });
    expect(withoutWater.plan.terrain.waterLevel).toBeNull();
  });

  it('duplicates objects with a new identity and offset', () => {
    const state = stateWithTree();
    const original = state.plan.objects[0];
    if (!original) throw new Error('expected tree');
    const duplicated = editorReducer(state, { type: 'duplicateObject', id: original.id });
    expect(duplicated.plan.objects).toHaveLength(2);
    const copy = duplicated.plan.objects[1];
    expect(copy?.id).not.toBe(original.id);
    expect(copy?.name).toContain('copy');
    expect(copy?.transform.position[0]).toBe(original.transform.position[0] + 2);
    expect(duplicated.selectedId).toBe(copy?.id);
  });

  it('renames worlds with a safe fallback', () => {
    const state = createInitialEditorState(createEmptyWorldPlan({ seed: 1 }));
    expect(editorReducer(state, { type: 'renameWorld', name: '   ' }).plan.name).toBe(
      'Untitled World',
    );
    expect(editorReducer(state, { type: 'renameWorld', name: '  New Name  ' }).plan.name).toBe(
      'New Name',
    );
  });

  it('does not add duplicate objects', () => {
    const state = stateWithTree();
    const tree = state.plan.objects[0];
    if (!tree) throw new Error('expected tree');
    expect(editorReducer(state, { type: 'addObject', object: tree })).toBe(state);
  });

  it('clears selection when a plan is replaced', () => {
    const state = stateWithTree();
    const next = createEmptyWorldPlan({ name: 'Other', seed: 2 });
    const replaced = editorReducer(state, { type: 'replacePlan', plan: next });
    expect(replaced.selectedId).toBeNull();
    expect(replaced.plan.id).toBe(next.id);
    expect(replaced.past).toHaveLength(1);
  });
});
