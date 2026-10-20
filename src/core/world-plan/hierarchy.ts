import { Matrix4 } from 'three';
import {
  MAX_GROUP_DEPTH,
  MAX_WORLD_GROUPS,
  isGroup,
  type SceneNode,
  type Transform,
  type WorldGroup,
  type WorldObject,
  type WorldPlan,
} from './schema';
import { createId } from '../utils/id';
import {
  composeTransformMatrix,
  decomposeTransformMatrix,
  identityTransform,
  transformRelativeTo,
} from './transformMath';

export type SceneNodeType = 'object' | 'group';

export interface HierarchyEntry {
  node: SceneNode;
  type: SceneNodeType;
  depth: number;
  children: HierarchyEntry[];
}

export function getNode(plan: WorldPlan, id: string | null): SceneNode | null {
  if (!id) return null;
  return (
    plan.groups.find((group) => group.id === id) ??
    plan.objects.find((object) => object.id === id) ??
    null
  );
}

export function getNodeType(plan: WorldPlan, id: string): SceneNodeType | null {
  if (plan.groups.some((group) => group.id === id)) return 'group';
  if (plan.objects.some((object) => object.id === id)) return 'object';
  return null;
}

export function getChildren(plan: WorldPlan, parentId: string | null): SceneNode[] {
  const groups = plan.groups.filter((group) => group.parentId === parentId);
  const objects = plan.objects.filter((object) => object.parentId === parentId);
  return [...groups, ...objects];
}

/** Build the full hierarchy tree, tolerating orphaned parent references. */
export function buildHierarchy(plan: WorldPlan): HierarchyEntry[] {
  const groupIds = new Set(plan.groups.map((group) => group.id));

  const walk = (parentId: string | null, depth: number, seen: Set<string>): HierarchyEntry[] => {
    if (depth > MAX_GROUP_DEPTH + 1) return [];
    const entries: HierarchyEntry[] = [];
    for (const group of plan.groups) {
      if (group.parentId !== parentId || seen.has(group.id)) continue;
      seen.add(group.id);
      entries.push({
        node: group,
        type: 'group',
        depth,
        children: walk(group.id, depth + 1, seen),
      });
    }
    for (const object of plan.objects) {
      if (object.parentId !== parentId) continue;
      entries.push({ node: object, type: 'object', depth, children: [] });
    }
    return entries;
  };

  const roots = walk(null, 0, new Set());

  // Defensive: nodes whose parent vanished still need to stay reachable.
  const placed = new Set<string>();
  const mark = (entries: HierarchyEntry[]) => {
    for (const entry of entries) {
      placed.add(entry.node.id);
      mark(entry.children);
    }
  };
  mark(roots);

  const orphans: HierarchyEntry[] = [];
  for (const group of plan.groups) {
    if (placed.has(group.id)) continue;
    const fixed = { ...group, parentId: null };
    orphans.push({ node: fixed, type: 'group', depth: 0, children: [] });
  }
  for (const object of plan.objects) {
    if (placed.has(object.id) || !groupIds.has(object.parentId ?? '')) continue;
    orphans.push({ node: { ...object, parentId: null }, type: 'object', depth: 0, children: [] });
  }

  return [...roots, ...orphans];
}

export function flattenHierarchy(entries: HierarchyEntry[]): HierarchyEntry[] {
  const flat: HierarchyEntry[] = [];
  const walk = (list: HierarchyEntry[]) => {
    for (const entry of list) {
      flat.push(entry);
      walk(entry.children);
    }
  };
  walk(entries);
  return flat;
}

export function getAncestors(plan: WorldPlan, id: string): SceneNode[] {
  const ancestors: SceneNode[] = [];
  const seen = new Set<string>();
  let cursor = getNode(plan, id);
  while (cursor?.parentId) {
    if (seen.has(cursor.parentId)) break;
    seen.add(cursor.parentId);
    const parent = getNode(plan, cursor.parentId);
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent;
  }
  return ancestors;
}

export function getSubtreeIds(plan: WorldPlan, id: string): string[] {
  const ids = [id];
  const seen = new Set(ids);
  for (let index = 0; index < ids.length; index += 1) {
    const current = ids[index];
    if (!current) continue;
    for (const node of [...plan.groups, ...plan.objects]) {
      if (node.parentId === current && !seen.has(node.id)) {
        seen.add(node.id);
        ids.push(node.id);
      }
    }
  }
  return ids;
}

export function isAncestor(plan: WorldPlan, ancestorId: string, nodeId: string): boolean {
  return getAncestors(plan, nodeId).some((ancestor) => ancestor.id === ancestorId);
}

export function depthOf(plan: WorldPlan, id: string): number {
  return getAncestors(plan, id).length;
}

/** True only when the node and every ancestor are visible. */
export function isEffectivelyVisible(plan: WorldPlan, id: string): boolean {
  const node = getNode(plan, id);
  if (!node || !node.visible) return false;
  return getAncestors(plan, id).every((ancestor) => ancestor.visible);
}

/** True when the node or any ancestor is locked. */
export function isEffectivelyLocked(plan: WorldPlan, id: string): boolean {
  const node = getNode(plan, id);
  if (!node) return true;
  if (node.locked) return true;
  return getAncestors(plan, id).some((ancestor) => ancestor.locked);
}

export function worldMatrixOf(plan: WorldPlan, id: string): Matrix4 {
  const chain: Transform[] = [];
  const seen = new Set<string>();
  let cursor = getNode(plan, id);
  while (cursor) {
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    chain.unshift(cursor.transform);
    cursor = cursor.parentId ? getNode(plan, cursor.parentId) : null;
  }
  const matrix = new Matrix4();
  for (const transform of chain) matrix.multiply(composeTransformMatrix(transform));
  return matrix;
}

export function worldTransformOf(plan: WorldPlan, id: string): Transform | null {
  if (!getNode(plan, id)) return null;
  return decomposeTransformMatrix(worldMatrixOf(plan, id));
}

function parentWorldMatrix(plan: WorldPlan, parentId: string | null): Matrix4 {
  return parentId ? worldMatrixOf(plan, parentId) : new Matrix4();
}

function replaceNode(plan: WorldPlan, id: string, transform: Transform): WorldPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) =>
      group.id === id ? { ...group, transform } : group,
    ),
    objects: plan.objects.map((object) =>
      object.id === id ? { ...object, transform } : object,
    ),
  };
}

/** Set a node's transform as a local transform (relative to its parent). */
export function setNodeTransform(plan: WorldPlan, id: string, transform: Transform): WorldPlan {
  return replaceNode(plan, id, transform);
}

/** Set a node's transform from a world-space transform, converting to local. */
export function setNodeWorldTransform(
  plan: WorldPlan,
  id: string,
  worldTransform: Transform,
): WorldPlan {
  const node = getNode(plan, id);
  if (!node) return plan;
  const local = transformRelativeTo(parentWorldMatrix(plan, node.parentId), worldTransform);
  return replaceNode(plan, id, local);
}

export function renameNode(plan: WorldPlan, id: string, name: string): WorldPlan {
  const clean = name.trim().slice(0, 80);
  if (!clean) return plan;
  return {
    ...plan,
    groups: plan.groups.map((group) => (group.id === id ? { ...group, name: clean } : group)),
    objects: plan.objects.map((object) => (object.id === id ? { ...object, name: clean } : object)),
  };
}

export function setNodeVisible(plan: WorldPlan, id: string, visible: boolean): WorldPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => (group.id === id ? { ...group, visible } : group)),
    objects: plan.objects.map((object) => (object.id === id ? { ...object, visible } : object)),
  };
}

export function setNodeLocked(plan: WorldPlan, id: string, locked: boolean): WorldPlan {
  return {
    ...plan,
    groups: plan.groups.map((group) => (group.id === id ? { ...group, locked } : group)),
    objects: plan.objects.map((object) => (object.id === id ? { ...object, locked } : object)),
  };
}

/** Reparent a node while preserving its visual world position. */
export function reparentNode(
  plan: WorldPlan,
  id: string,
  newParentId: string | null,
): WorldPlan {
  const node = getNode(plan, id);
  if (!node) return plan;
  if (node.parentId === newParentId) return plan;
  if (newParentId !== null) {
    const parentType = getNodeType(plan, newParentId);
    if (parentType !== 'group') return plan;
    if (newParentId === id || isAncestor(plan, id, newParentId)) return plan;
    if (depthOf(plan, id) + 1 + subtreeHeight(plan, id) > MAX_GROUP_DEPTH) return plan;
  }

  const world = decomposeTransformMatrix(worldMatrixOf(plan, id));
  const local = transformRelativeTo(parentWorldMatrix(plan, newParentId), world);
  const moved = replaceNode(plan, id, local);

  return {
    ...moved,
    groups: moved.groups.map((group) =>
      group.id === id ? { ...group, parentId: newParentId } : group,
    ),
    objects: moved.objects.map((object) =>
      object.id === id ? { ...object, parentId: newParentId } : object,
    ),
  };
}

function subtreeHeight(plan: WorldPlan, id: string): number {
  let height = 0;
  for (const descendant of getSubtreeIds(plan, id)) {
    if (descendant === id) continue;
    height = Math.max(height, depthOf(plan, descendant) - depthOf(plan, id));
  }
  return height;
}

/**
 * Group the given nodes under a new container placed at the world origin.
 * Because the new group is identity, children keep their existing local
 * transforms and therefore do not move.
 */
export function createGroupFromSelection(
  plan: WorldPlan,
  ids: string[],
  name = 'Group',
): { plan: WorldPlan; groupId: string | null } {
  if (plan.groups.length >= MAX_WORLD_GROUPS) return { plan, groupId: null };

  const existing = ids.filter((id) => getNode(plan, id));
  if (existing.length === 0) return { plan, groupId: null };

  // Only keep nodes that are not already inside another selected node.
  const roots = existing.filter(
    (id) => !existing.some((other) => other !== id && isAncestor(plan, other, id)),
  );
  if (roots.length === 0) return { plan, groupId: null };

  const deepest = Math.max(...roots.map((id) => depthOf(plan, id)));
  if (deepest + 1 + Math.max(...roots.map((id) => subtreeHeight(plan, id))) > MAX_GROUP_DEPTH) {
    return { plan, groupId: null };
  }

  const group: WorldGroup = {
    nodeType: 'group',
    id: createId('grp'),
    name: name.trim() || 'Group',
    parentId: null,
    transform: identityTransform(),
    visible: true,
    locked: false,
  };

  // The new group is an identity node at the world root. Roots that already lived
  // at the root keep their exact transform (no Euler re-normalisation), while a
  // root under a transformed parent must receive its *world* transform as its new
  // local transform — otherwise grouping it would teleport the node.
  const rootWorld = new Map<string, Transform>();
  for (const id of roots) {
    const node = getNode(plan, id);
    if (!node || node.parentId === null) continue;
    const world = worldTransformOf(plan, id);
    if (world) rootWorld.set(id, world);
  }

  const rootSet = new Set(roots);
  return {
    groupId: group.id,
    plan: {
      ...plan,
      groups: [
        ...plan.groups.map((entry) =>
          rootSet.has(entry.id)
            ? {
                ...entry,
                parentId: group.id,
                transform: rootWorld.get(entry.id) ?? entry.transform,
              }
            : entry,
        ),
        group,
      ],
      objects: plan.objects.map((object) =>
        rootSet.has(object.id)
          ? {
              ...object,
              parentId: group.id,
              transform: rootWorld.get(object.id) ?? object.transform,
            }
          : object,
      ),
    },
  };
}

/** Dissolve a group, keeping its children where they appear on screen. */
export function ungroupNode(plan: WorldPlan, groupId: string): WorldPlan {
  const group = plan.groups.find((entry) => entry.id === groupId);
  if (!group) return plan;

  const parentWorld = group.parentId ? worldMatrixOf(plan, group.parentId) : new Matrix4();
  const groupWorld = worldMatrixOf(plan, groupId);

  const relocalize = <T extends WorldGroup | WorldObject>(node: T): T => {
    if (node.parentId !== groupId) return node;
    const nodeWorld = groupWorld.clone().multiply(composeTransformMatrix(node.transform));
    const local = transformRelativeTo(parentWorld, decomposeTransformMatrix(nodeWorld));
    return { ...node, parentId: group.parentId, transform: local };
  };

  return {
    ...plan,
    groups: plan.groups
      .filter((entry) => entry.id !== groupId)
      .map((entry) => relocalize(entry)),
    objects: plan.objects.map((object) => relocalize(object)),
  };
}

/** Delete nodes and every descendant. */
export function removeNodes(plan: WorldPlan, ids: string[]): WorldPlan {
  const doomed = new Set<string>();
  for (const id of ids) {
    if (!getNode(plan, id)) continue;
    for (const descendant of getSubtreeIds(plan, id)) doomed.add(descendant);
  }
  if (doomed.size === 0) return plan;
  return {
    ...plan,
    groups: plan.groups.filter((group) => !doomed.has(group.id)),
    objects: plan.objects.filter((object) => !doomed.has(object.id)),
  };
}

/**
 * Duplicate nodes (deep) with fresh IDs and a small visual offset.
 * Parent references inside the duplicated subtree are remapped; references
 * outside it are preserved.
 */
export function duplicateNodes(
  plan: WorldPlan,
  ids: string[],
  options: { offset?: [number, number, number] } = {},
): { plan: WorldPlan; newIds: string[] } {
  const [ox, oy, oz] = options.offset ?? [2, 0, 2];
  const existing = ids.filter((id) => getNode(plan, id));
  if (existing.length === 0) return { plan, newIds: [] };

  const roots = existing.filter(
    (id) => !existing.some((other) => other !== id && isAncestor(plan, other, id)),
  );

  const idMap = new Map<string, string>();
  const newGroups: WorldGroup[] = [];
  const newObjects: WorldObject[] = [];

  const cloneSubtree = (id: string, isRoot: boolean) => {
    const node = getNode(plan, id);
    if (!node) return;
    const cloneId = createId(isGroup(node) ? 'grp' : 'obj');
    idMap.set(id, cloneId);
    const name = `${node.name} copy`.slice(0, 80);
    const transform = isRoot
      ? {
          ...node.transform,
          position: [
            node.transform.position[0] + ox,
            node.transform.position[1] + oy,
            node.transform.position[2] + oz,
          ] as [number, number, number],
        }
      : node.transform;

    if (isGroup(node)) {
      newGroups.push({ ...node, id: cloneId, name, transform });
    } else {
      newObjects.push({ ...node, id: cloneId, name, transform });
    }

    for (const child of [...plan.groups, ...plan.objects]) {
      if (child.parentId === id) cloneSubtree(child.id, false);
    }
  };

  for (const root of roots) cloneSubtree(root, true);

  // Remap parents that were duplicated too.
  const remapGroup = (group: WorldGroup): WorldGroup =>
    group.parentId && idMap.has(group.parentId)
      ? { ...group, parentId: idMap.get(group.parentId) ?? null }
      : group;
  const remapObject = (object: WorldObject): WorldObject =>
    object.parentId && idMap.has(object.parentId)
      ? { ...object, parentId: idMap.get(object.parentId) ?? null }
      : object;

  if (plan.objects.length + newObjects.length > 1500) {
    return { plan, newIds: [] };
  }
  if (plan.groups.length + newGroups.length > MAX_WORLD_GROUPS) {
    return { plan, newIds: [] };
  }

  return {
    newIds: [...idMap.values()],
    plan: {
      ...plan,
      groups: [...plan.groups, ...newGroups.map(remapGroup)],
      objects: [...plan.objects, ...newObjects.map(remapObject)],
    },
  };
}

/** Smallest axis-aligned bounds of a subtree, used to frame selections. */
export function subtreeNodeIds(plan: WorldPlan, ids: string[]): string[] {
  const all = new Set<string>();
  for (const id of ids) {
    if (!getNode(plan, id)) continue;
    for (const descendant of getSubtreeIds(plan, id)) all.add(descendant);
  }
  return [...all];
}
