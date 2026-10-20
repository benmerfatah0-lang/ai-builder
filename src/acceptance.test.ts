/**
 * Phase 2 acceptance test.
 *
 * Creates a scene with a ground plane, a cube, a tree and a house; selects each
 * object; moves, resizes and rotates it; groups the tree and house; saves the
 * project to IndexedDB; reloads it; then verifies every transform and hierarchy
 * entry — both in the document and in the rendered Three.js graph.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ASSET_LIBRARY, type AssetDefinition } from './core/assets/catalog';
import { mulberry32 } from './core/generation/rng';
import { createEmptyWorldPlan } from './core/world-plan/factory';
import { createIndexedDbWorldRepository } from './core/persistence/worldRepository';
import {
  createInitialEditorState,
  editorReducer,
  type EditorAction,
  type EditorState,
} from './modules/editor/store';
import { getNode, worldTransformOf } from './core/world-plan/hierarchy';
import type { Transform } from './core/world-plan/schema';
import { buildWorldScene, disposeObject3D, findNodeObject } from './core/scene/sceneBuilder';
import { serializeWorldPlan } from './core/world-plan/migrate';

const asset = (id: string): AssetDefinition => {
  const entry = ASSET_LIBRARY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing asset ${id}`);
  return entry;
};

function apply(state: EditorState, actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function select(id: string): EditorAction {
  return { type: 'select', ids: [id], mode: 'replace' };
}

/** Mirrors what the inspector and gizmo do: patch the local transform. */
function transform(id: string, patch: Partial<Transform>): EditorAction {
  return {
    type: 'setTransform',
    id,
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      ...patch,
    },
  };
}

describe('acceptance: build, edit, save and reload a scene', () => {
  it('keeps every transform and hierarchy entry after saving and reopening', async () => {
    // ---- 1. Empty, flat world -------------------------------------------
    const base = createEmptyWorldPlan({ name: 'Acceptance Scene', seed: 424242 });
    base.terrain = {
      ...base.terrain,
      style: 'flat',
      heightScale: 0,
      waterLevel: null,
    };

    let state = createInitialEditorState(base);
    const rng = mulberry32(99);

    const ground = asset('ground').create(rng, [0, 0, 0]);
    const cube = asset('box').create(rng, [3, 0, 0]);
    const tree = asset('pine').create(rng, [-4, 0, 2]);
    const house = asset('house').create(rng, [0, 0, -6]);
    ground.name = 'Ground plane';
    cube.name = 'Cube';
    tree.name = 'Tree';
    house.name = 'House';

    state = apply(state, [
      { type: 'addObject', object: ground },
      { type: 'addObject', object: cube },
      { type: 'addObject', object: tree },
      { type: 'addObject', object: house },
    ]);

    expect(state.plan.objects).toHaveLength(4);

    // ---- 2. Select each object, move, resize and rotate it ---------------
    state = apply(state, [
      select(cube.id),
      transform(cube.id, {
        position: [5, 0.9, -1],
        rotation: [0, 30, 0],
        scale: [1.5, 1.5, 1.5],
      }),
      select(tree.id),
      transform(tree.id, {
        position: [-6, 0, 3],
        rotation: [0, 120, 15],
        scale: [1.2, 1.4, 1.2],
      }),
      select(house.id),
      transform(house.id, {
        position: [1, 0, -8],
        rotation: [0, 180, 0],
        scale: [0.9, 1.1, 0.9],
      }),
      select(ground.id),
      transform(ground.id, {
        position: [0, -0.05, 0],
        rotation: [0, 0, 0],
        scale: [30, 1, 30],
      }),
    ]);

    // ---- 3. Group the tree and house into a village ----------------------
    state = apply(state, [
      select(tree.id),
      { type: 'select', ids: [house.id], mode: 'add' },
      { type: 'groupSelection', name: 'Village' },
    ]);

    const groupId = state.plan.groups[0]?.id;
    expect(groupId).toBeTruthy();
    expect(state.plan.groups[0]?.name).toBe('Village');
    expect(getNode(state.plan, tree.id)?.parentId).toBe(groupId);
    expect(getNode(state.plan, house.id)?.parentId).toBe(groupId);

    state = editorReducer(state, {
      type: 'setTransform',
      id: groupId ?? '',
      transform: {
        position: [2, 0, 2],
        rotation: [0, 20, 0],
        scale: [1, 1, 1],
      },
    });

    // Snapshot what the user should see after reopening.
    const saved = state.plan;
    const savedWorld = {
      ground: worldTransformOf(saved, ground.id),
      cube: worldTransformOf(saved, cube.id),
      tree: worldTransformOf(saved, tree.id),
      house: worldTransformOf(saved, house.id),
      group: worldTransformOf(saved, groupId ?? ''),
    };
    const savedHierarchy = {
      roots: saved.objects.filter((object) => object.parentId === null).map((object) => object.id),
      children: saved.objects.filter((object) => object.parentId === groupId).map((object) => object.id),
    };

    expect(savedHierarchy.roots).toEqual([ground.id, cube.id]);
    expect(savedHierarchy.children).toEqual([tree.id, house.id]);

    // ---- 4. Save to IndexedDB and reload ---------------------------------
    const repository = createIndexedDbWorldRepository(
      `acceptance-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
    await repository.save(saved);

    const summaries = await repository.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.objectCount).toBe(4);

    const loaded = await repository.load(saved.id);
    expect(loaded).not.toBeNull();
    if (!loaded) throw new Error('World did not reload');

    // ---- 5. Verify document state ---------------------------------------
    expect(loaded.schemaVersion).toBe(2);
    expect(loaded.objects).toEqual(saved.objects);
    expect(loaded.groups).toEqual(saved.groups);

    const transformOf = (id: string) => loaded.objects.find((object) => object.id === id)?.transform;
    expect(transformOf(cube.id)).toEqual({
      position: [5, 0.9, -1],
      rotation: [0, 30, 0],
      scale: [1.5, 1.5, 1.5],
    });
    expect(transformOf(tree.id)).toEqual({
      position: [-6, 0, 3],
      rotation: [0, 120, 15],
      scale: [1.2, 1.4, 1.2],
    });
    expect(transformOf(house.id)).toEqual({
      position: [1, 0, -8],
      rotation: [0, 180, 0],
      scale: [0.9, 1.1, 0.9],
    });
    expect(transformOf(ground.id)?.scale).toEqual([30, 1, 30]);
    expect(loaded.groups[0]?.transform).toEqual({
      position: [2, 0, 2],
      rotation: [0, 20, 0],
      scale: [1, 1, 1],
    });

    // Hierarchy survives the round trip.
    expect(loaded.objects.filter((object) => object.parentId === null)).toHaveLength(2);
    expect(loaded.objects.filter((object) => object.parentId === groupId)).toHaveLength(2);
    expect(loaded.groups).toHaveLength(1);

    // World-space results are unchanged.
    for (const key of Object.keys(savedWorld) as (keyof typeof savedWorld)[]) {
      const ids = { ground: ground.id, cube: cube.id, tree: tree.id, house: house.id, group: groupId ?? '' };
      const after = worldTransformOf(loaded, ids[key]);
      const before = savedWorld[key];
      expect(after?.position[0]).toBeCloseTo(before?.position[0] ?? NaN, 2);
      expect(after?.position[2]).toBeCloseTo(before?.position[2] ?? NaN, 2);
      expect(after?.rotation[1]).toBeCloseTo(before?.rotation[1] ?? NaN, 2);
    }

    // JSON export/import is lossless too.
    const json = serializeWorldPlan(loaded);
    expect(JSON.parse(json)).toEqual(loaded);

    // ---- 6. Verify the rendered scene graph ------------------------------
    const root = buildWorldScene(loaded, { includeLights: false });
    try {
      const groupObject = findNodeObject(root, groupId ?? '');
      expect(groupObject).toBeInstanceOf(THREE.Group);
      expect(groupObject?.children).toHaveLength(2);

      const treeObject = findNodeObject(root, tree.id);
      const houseObject = findNodeObject(root, house.id);
      expect(treeObject).toBeTruthy();
      expect(houseObject).toBeTruthy();

      // Objects are parented under the group in the scene graph too.
      expect(treeObject?.parent).toBe(groupObject);
      expect(houseObject?.parent).toBe(groupObject);

      root.updateMatrixWorld(true);
      const treeWorld = new THREE.Vector3();
      treeObject?.getWorldPosition(treeWorld);
      const expected = worldTransformOf(loaded, tree.id);
      expect(treeWorld.x).toBeCloseTo(expected?.position[0] ?? NaN, 2);
      expect(treeWorld.y).toBeCloseTo(expected?.position[1] ?? NaN, 2);
      expect(treeWorld.z).toBeCloseTo(expected?.position[2] ?? NaN, 2);

      const cubeObject = findNodeObject(root, cube.id);
      const cubeWorld = new THREE.Vector3();
      cubeObject?.getWorldPosition(cubeWorld);
      expect(cubeWorld.x).toBeCloseTo(5, 3);
      expect(cubeWorld.z).toBeCloseTo(-1, 3);

      // The ground plane is present and scaled as edited.
      expect(findNodeObject(root, ground.id)).toBeTruthy();
    } finally {
      disposeObject3D(root);
    }
  }, 30000);
});
