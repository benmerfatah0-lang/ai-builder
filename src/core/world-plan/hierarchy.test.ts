import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from './factory';
import { createBuilding, createLantern, createTree } from '../assets/catalog';
import { mulberry32 } from '../generation/rng';
import type { WorldPlan } from './schema';
import {
  buildHierarchy,
  createGroupFromSelection,
  duplicateNodes,
  flattenHierarchy,
  getAncestors,
  getChildren,
  getNode,
  getSubtreeIds,
  isEffectivelyLocked,
  isEffectivelyVisible,
  removeNodes,
  renameNode,
  reparentNode,
  setNodeLocked,
  setNodeTransform,
  setNodeVisible,
  ungroupNode,
  worldMatrixOf,
  worldTransformOf,
} from './hierarchy';
import {
  approxEqualTransform,
  composeTransformMatrix,
  decomposeTransformMatrix,
  identityTransform,
  transformRelativeTo,
} from './transformMath';
import { Matrix4 } from 'three';

function sceneWithObjects(): WorldPlan {
  const plan = createEmptyWorldPlan({ name: 'Hierarchy', seed: 21 });
  plan.objects = [
    createTree('pine', [2, 0, 0], mulberry32(1)),
    createBuilding('house', [-3, 0, 1], mulberry32(2)),
    createLantern([0, 0, 4]),
  ];
  return plan;
}

function positionOf(plan: WorldPlan, id: string): [number, number, number] {
  const transform = worldTransformOf(plan, id);
  if (!transform) throw new Error(`missing node ${id}`);
  return transform.position;
}

describe('world-preserving grouping', () => {
  it('keeps a nested object in place when it is grouped again', () => {
    const plan = createEmptyWorldPlan({ name: 'Nested grouping', seed: 77 });
    const tree = createTree('pine', [1, 0, 0], mulberry32(3));
    plan.objects.push(tree);

    // First group: tree now lives under a group that is itself transformed.
    const first = createGroupFromSelection(plan, [tree.id], 'Inner');
    const innerId = first.groupId;
    if (!innerId) throw new Error('expected first group');
    const movedInner = setNodeTransform(first.plan, innerId, {
      position: [10, 2, 0],
      rotation: [0, 45, 0],
      scale: [2, 2, 2],
    });

    const before = worldTransformOf(movedInner, tree.id);
    if (!before) throw new Error('expected world transform');

    // Group the *nested* object a second time; it must not move.
    const second = createGroupFromSelection(movedInner, [tree.id], 'Outer');
    expect(second.groupId).toBeTruthy();
    const after = worldTransformOf(second.plan, tree.id);

    expect(after?.position[0]).toBeCloseTo(before.position[0], 4);
    expect(after?.position[1]).toBeCloseTo(before.position[1], 4);
    expect(after?.position[2]).toBeCloseTo(before.position[2], 4);
    expect(after?.scale[0]).toBeCloseTo(before.scale[0], 4);

    // ...and ungrouping the outer group preserves it as well.
    const ungrouped = ungroupNode(second.plan, second.groupId ?? '');
    const restored = worldTransformOf(ungrouped, tree.id);
    expect(restored?.position[0]).toBeCloseTo(before.position[0], 4);
    expect(restored?.position[2]).toBeCloseTo(before.position[2], 4);
  });
});

describe('transform math', () => {
  it('round-trips compose/decompose including rotation', () => {
    const transform = {
      position: [3, 4.5, -2] as [number, number, number],
      rotation: [15, 90, -22] as [number, number, number],
      scale: [1.5, 0.75, 2] as [number, number, number],
    };
    const restored = decomposeTransformMatrix(composeTransformMatrix(transform));

    expect(restored.position.every((value, index) => Math.abs(value - transform.position[index]!) < 1e-3)).toBe(true);
    expect(restored.scale.every((value, index) => Math.abs(value - transform.scale[index]!) < 1e-3)).toBe(true);

    // Euler angles can be represented in equivalent ways, so compare matrices.
    const original = composeTransformMatrix(transform);
    const roundTripped = composeTransformMatrix(restored);
    expect(
      original.elements.every((value, index) => Math.abs(value - roundTripped.elements[index]!) < 1e-3),
    ).toBe(true);
  });

  it('converts a world transform into a parent space', () => {
    const parentWorld = composeTransformMatrix({
      position: [10, 0, 10],
      rotation: [0, 90, 0],
      scale: [1, 1, 1],
    });
    const world = {
      position: [12, 2, 10] as [number, number, number],
      rotation: [0, 90, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    };
    const local = transformRelativeTo(parentWorld, world);
    const recomposed = decomposeTransformMatrix(
      parentWorld.clone().multiply(composeTransformMatrix(local)),
    );
    expect(approxEqualTransform(world, recomposed, 1e-2)).toBe(true);
    expect(local.position[0]).toBeCloseTo(0, 2);
    expect(local.position[2]).toBeCloseTo(2, 2);
  });

  it('keeps identity neutral', () => {
    const matrix = composeTransformMatrix(identityTransform());
    expect(matrix.equals(new Matrix4())).toBe(true);
  });
});

describe('hierarchy tree', () => {
  it('lists roots and children', () => {
    const plan = sceneWithObjects();
    const roots = buildHierarchy(plan);
    expect(roots).toHaveLength(3);
    expect(flattenHierarchy(roots)).toHaveLength(3);
    expect(getChildren(plan, null)).toHaveLength(3);
  });

  it('nests nodes inside groups', () => {
    const plan = sceneWithObjects();
    const ids = plan.objects.slice(0, 2).map((object) => object.id);
    const { plan: grouped, groupId } = createGroupFromSelection(plan, ids, 'Village');
    expect(groupId).toBeTruthy();

    const group = grouped.groups.find((entry) => entry.id === groupId);
    expect(group?.name).toBe('Village');
    expect(getChildren(grouped, groupId ?? null)).toHaveLength(2);
    expect(getChildren(grouped, null)).toHaveLength(2); // group + lantern
    expect(buildHierarchy(grouped)[0]?.children).toHaveLength(2);
  });

  it('keeps world positions when grouping', () => {
    const plan = sceneWithObjects();
    const ids = plan.objects.slice(0, 2).map((object) => object.id);
    const before = ids.map((id) => positionOf(plan, id));
    const { plan: grouped } = createGroupFromSelection(plan, ids);

    ids.forEach((id, index) => {
      expect(positionOf(grouped, id)).toEqual(before[index]);
      expect(getAncestors(grouped, id)).toHaveLength(1);
    });
  });

  it('moves children with their group transform', () => {
    const plan = sceneWithObjects();
    const ids = plan.objects.slice(0, 2).map((object) => object.id);
    const { plan: grouped, groupId } = createGroupFromSelection(plan, ids);
    if (!groupId) throw new Error('expected group');
    const before = positionOf(grouped, ids[0] ?? '');
    const moved = setNodeTransform(grouped, groupId, {
      position: [10, 0, -5],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const after = positionOf(moved, ids[0] ?? '');
    expect(after[0]).toBeCloseTo(before[0] + 10, 3);
    expect(after[2]).toBeCloseTo(before[2] - 5, 3);
  });
});

describe('grouping operations', () => {
  it('ungroups while preserving world transforms', () => {
    const plan = sceneWithObjects();
    const ids = plan.objects.slice(0, 2).map((object) => object.id);
    const { plan: grouped, groupId } = createGroupFromSelection(plan, ids);
    if (!groupId) throw new Error('expected group');

    const rotated = setNodeTransform(grouped, groupId, {
      position: [4, 1, 7],
      rotation: [0, 65, 0],
      scale: [1.2, 1.2, 1.2],
    });
    const before = ids.map((id) => worldTransformOf(rotated, id));
    const dissolved = ungroupNode(rotated, groupId);

    expect(dissolved.groups).toHaveLength(0);
    expect(getChildren(dissolved, null)).toHaveLength(3);
    ids.forEach((id, index) => {
      expect(getNode(dissolved, id)?.parentId).toBeNull();
      expect(approxEqualTransform(before[index]!, worldTransformOf(dissolved, id)!, 1e-2)).toBe(
        true,
      );
    });
  });

  it('reparents while preserving world transforms', () => {
    const plan = sceneWithObjects();
    const [first, second] = plan.objects;
    if (!first || !second) throw new Error('expected objects');

    const { plan: grouped, groupId } = createGroupFromSelection(plan, [first.id]);
    if (!groupId) throw new Error('expected group');
    const rotated = setNodeTransform(grouped, groupId, {
      position: [6, 0, 3],
      rotation: [0, 40, 0],
      scale: [0.8, 0.8, 0.8],
    });
    const before = worldTransformOf(rotated, second.id);

    const reparented = reparentNode(rotated, second.id, groupId);
    expect(getNode(reparented, second.id)?.parentId).toBe(groupId);
    expect(approxEqualTransform(before!, worldTransformOf(reparented, second.id)!, 1e-2)).toBe(true);

    // Back to the root, still in the same world position.
    const detached = reparentNode(reparented, second.id, null);
    expect(detached.objects.find((object) => object.id === second.id)?.parentId).toBeNull();
    expect(approxEqualTransform(before!, worldTransformOf(detached, second.id)!, 1e-2)).toBe(true);
  });

  it('refuses cycles and invalid parents', () => {
    const plan = sceneWithObjects();
    const first = plan.objects[0];
    if (!first) throw new Error('expected object');
    const { plan: outer, groupId: outerId } = createGroupFromSelection(plan, [first.id]);
    if (!outerId) throw new Error('expected group');
    const { plan: nested, groupId: innerId } = createGroupFromSelection(outer, [outerId]);
    if (!innerId) throw new Error('expected nested group');

    expect(reparentNode(nested, innerId, outerId)).toBe(nested);
    expect(reparentNode(nested, outerId, innerId)).toBe(nested);
    expect(reparentNode(nested, outerId, first.id)).toBe(nested);
  });

  it('deletes whole subtrees and duplicates them with new ids', () => {
    const plan = sceneWithObjects();
    const ids = plan.objects.slice(0, 2).map((object) => object.id);
    const { plan: grouped, groupId } = createGroupFromSelection(plan, ids);
    if (!groupId) throw new Error('expected group');

    expect(getSubtreeIds(grouped, groupId)).toHaveLength(3);
    const pruned = removeNodes(grouped, [groupId]);
    expect(pruned.groups).toHaveLength(0);
    expect(pruned.objects).toHaveLength(1);
    expect(pruned.objects[0]?.id).toBe(grouped.objects[2]?.id);

    const { plan: duplicated, newIds } = duplicateNodes(grouped, [groupId]);
    expect(newIds).toHaveLength(3);
    expect(duplicated.groups).toHaveLength(2);
    expect(duplicated.objects).toHaveLength(5);

    const newGroup = duplicated.groups.find((group) => group.id === newIds[0]);
    expect(newGroup?.name).toContain('copy');
    const newChildren = duplicated.objects.filter((object) => object.parentId === newIds[0]);
    expect(newChildren).toHaveLength(2);
  });
});

describe('visibility, locking and naming', () => {
  it('inherits hidden and locked state from ancestors', () => {
    const plan = sceneWithObjects();
    const first = plan.objects[0];
    if (!first) throw new Error('expected object');
    const { plan: grouped, groupId } = createGroupFromSelection(plan, [first.id]);
    if (!groupId) throw new Error('expected group');

    expect(isEffectivelyVisible(grouped, first.id)).toBe(true);
    const hidden = setNodeVisible(grouped, groupId, false);
    expect(isEffectivelyVisible(hidden, first.id)).toBe(false);
    expect(hidden.objects[0]?.visible).toBe(true);

    const locked = setNodeLocked(grouped, groupId, true);
    expect(isEffectivelyLocked(locked, first.id)).toBe(true);
    expect(isEffectivelyLocked(locked, groupId)).toBe(true);
  });

  it('renames objects and groups', () => {
    const plan = sceneWithObjects();
    const id = plan.objects[0]?.id ?? '';
    expect(renameNode(plan, id, '  Old Pine  ').objects[0]?.name).toBe('Old Pine');
    expect(renameNode(plan, id, '   ').objects[0]?.name).toBe(plan.objects[0]?.name);
  });

  it('builds a world matrix from the ancestor chain', () => {
    const plan = sceneWithObjects();
    const first = plan.objects[0];
    if (!first) throw new Error('expected object');
    const { plan: grouped, groupId } = createGroupFromSelection(plan, [first.id]);
    if (!groupId) throw new Error('expected group');
    const moved = setNodeTransform(grouped, groupId, {
      position: [1, 2, 3],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    const matrix = worldMatrixOf(moved, first.id);
    const expected = composeTransformMatrix({
      ...first.transform,
      position: [
        first.transform.position[0] + 1,
        first.transform.position[1] + 2,
        first.transform.position[2] + 3,
      ],
    });
    expect(matrix.elements.every((value, index) => Math.abs(value - expected.elements[index]!) < 1e-3)).toBe(true);
  });
});
