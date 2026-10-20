import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { createLantern, createTree } from '../assets/catalog';
import { mulberry32 } from '../generation/rng';
import {
  applyTransform,
  buildWorldScene,
  createGrid,
  disposeObject3D,
  findNodeObject,
  readTransform,
} from './sceneBuilder';
import { createGroupFromSelection, setNodeTransform } from '../world-plan/hierarchy';

describe('transform bridge (gizmo ↔ document)', () => {
  it('applies degrees and reads them back', () => {
    const object = new THREE.Object3D();
    const transform = {
      position: [1.5, -2, 3] as [number, number, number],
      rotation: [15, 90, -45] as [number, number, number],
      scale: [2, 0.5, 1.25] as [number, number, number],
    };
    applyTransform(object, transform);

    expect(object.position.toArray()).toEqual([1.5, -2, 3]);
    expect(THREE.MathUtils.radToDeg(object.rotation.y)).toBeCloseTo(90, 4);
    expect(object.scale.toArray()).toEqual([2, 0.5, 1.25]);

    expect(readTransform(object)).toEqual(transform);
  });

  it('clamps degenerate scale coming from the gizmo', () => {
    const object = new THREE.Object3D();
    object.scale.set(0, -3, 1e-9);
    const transform = readTransform(object);
    expect(transform.scale.every((value) => value >= 0.05)).toBe(true);
  });

  it('round-trips a full world through the scene graph', () => {
    const plan = createEmptyWorldPlan({ name: 'Bridge', seed: 12 });
    plan.objects.push(createTree('pine', [2, 0, -1], mulberry32(3)));
    plan.objects.push(createLantern([-3, 0, 4]));

    const root = buildWorldScene(plan, { includeLights: false });
    try {
      for (const object of plan.objects) {
        const node = findNodeObject(root, object.id);
        expect(node).not.toBeNull();
        if (!node) continue;
        // Gizmo commits are rounded to a millimetre for stable documents.
        const roundTrip = readTransform(node);
        expect(
          roundTrip.position.every(
            (value, index) => Math.abs(value - object.transform.position[index]!) < 1e-3,
          ),
        ).toBe(true);
        expect(
          roundTrip.rotation.every(
            (value, index) => Math.abs(value - object.transform.rotation[index]!) < 1e-3,
          ),
        ).toBe(true);
        expect(
          roundTrip.scale.every(
            (value, index) => Math.abs(value - object.transform.scale[index]!) < 1e-3,
          ),
        ).toBe(true);
      }
    } finally {
      disposeObject3D(root);
    }
  });
});

describe('scene graph hierarchy', () => {
  it('nests grouped nodes and applies the group transform', () => {
    const plan = createEmptyWorldPlan({ name: 'Groups', seed: 5 });
    const tree = createTree('pine', [2, 0, 0], mulberry32(1));
    const lantern = createLantern([0, 0, 2]);
    plan.objects.push(tree, lantern);

    const { plan: grouped, groupId } = createGroupFromSelection(plan, [tree.id, lantern.id]);
    if (!groupId) throw new Error('expected group');
    const moved = setNodeTransform(grouped, groupId, {
      position: [5, 0, 0],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    });

    const root = buildWorldScene(moved, { includeLights: false });
    try {
      const groupObject = findNodeObject(root, groupId);
      const treeObject = findNodeObject(root, tree.id);
      expect(groupObject).toBeTruthy();
      expect(treeObject?.parent).toBe(groupObject);

      root.updateMatrixWorld(true);
      const worldPosition = new THREE.Vector3();
      treeObject?.getWorldPosition(worldPosition);
      // Local (2,0,0) rotated 90° about Y then translated +5 on X → (5, 0, -2).
      expect(worldPosition.x).toBeCloseTo(5, 3);
      expect(worldPosition.z).toBeCloseTo(-2, 3);
    } finally {
      disposeObject3D(root);
    }
  });

  it('keeps hidden nodes out unless requested and honours parent visibility', () => {
    const plan = createEmptyWorldPlan({ name: 'Visibility', seed: 8 });
    const tree = createTree('pine', [0, 0, 0], mulberry32(1));
    const lantern = createLantern([1, 0, 1]);
    plan.objects.push(tree, lantern);

    const { plan: grouped, groupId } = createGroupFromSelection(plan, [tree.id]);
    if (!groupId) throw new Error('expected group');

    const hiddenGroup = {
      ...grouped,
      groups: grouped.groups.map((group) =>
        group.id === groupId ? { ...group, visible: false } : group,
      ),
    };

    const withoutHidden = buildWorldScene(hiddenGroup, { includeLights: false });
    expect(findNodeObject(withoutHidden, tree.id)).toBeNull();
    expect(findNodeObject(withoutHidden, lantern.id)).not.toBeNull();
    disposeObject3D(withoutHidden);

    const withHidden = buildWorldScene(hiddenGroup, {
      includeLights: false,
      includeHidden: true,
    });
    const treeObject = findNodeObject(withHidden, tree.id);
    expect(treeObject).not.toBeNull();
    const groupObject = findNodeObject(withHidden, groupId);
    expect(groupObject?.visible).toBe(false);

    // Effective visibility walks the scene graph: the child is hidden by its parent.
    const isShown = (object: THREE.Object3D | null): boolean => {
      let cursor: THREE.Object3D | null = object;
      while (cursor) {
        if (!cursor.visible) return false;
        cursor = cursor.parent;
      }
      return true;
    };
    expect(isShown(treeObject)).toBe(false);
    expect(isShown(findNodeObject(withHidden, lantern.id))).toBe(true);
    disposeObject3D(withHidden);
  });
});

describe('viewport helpers', () => {
  it('builds a grid sized to the terrain', () => {
    const plan = createEmptyWorldPlan({ seed: 1 });
    plan.terrain = { ...plan.terrain, size: 120, waterLevel: 2 };
    const grid = createGrid(plan);
    const helper = grid.children[0] as THREE.GridHelper;
    expect(helper).toBeInstanceOf(THREE.GridHelper);
    expect(helper.position.y).toBeCloseTo(2.04, 3);
    disposeObject3D(grid);
  });

  it('creates editable materials for every object kind', () => {
    const plan = createEmptyWorldPlan({ seed: 2 });
    plan.objects.push(createTree('pine', [0, 0, 0], mulberry32(1)));
    plan.objects.push({ ...createLantern([1, 0, 0]), material: { roughness: 0.2 } });
    const root = buildWorldScene(plan, { includeLights: false });
    const lantern = findNodeObject(root, plan.objects[1]?.id ?? '');
    let sawMaterial = false;
    lantern?.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const material = child.material as THREE.MeshStandardMaterial;
        expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
        sawMaterial = true;
      }
    });
    expect(sawMaterial).toBe(true);
    disposeObject3D(root);
  });
});
