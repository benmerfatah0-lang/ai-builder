import { describe, expect, it } from 'vitest';
import {
  deserializeWorldPlan,
  migrateWorldPlan,
  parseWorldPlan,
  parseWorldPlanLenient,
  serializeWorldPlan,
  WorldPlanValidationError,
} from './migrate';
import { createEmptyWorldPlan } from './factory';
import { validateWorldPlan, WORLD_PLAN_SCHEMA_VERSION } from './schema';
import { createLantern, createTree } from '../assets/catalog';
import { mulberry32 } from '../generation/rng';
import { createGroupFromSelection } from './hierarchy';

function legacyV1Document() {
  const plan = createEmptyWorldPlan({ name: 'Legacy v1', seed: 7 });
  return {
    ...plan,
    schemaVersion: 1,
    groups: undefined,
    objects: [
      {
        id: 'obj_legacy',
        name: 'Old Pine',
        transform: { position: [1, 2, 3], rotationY: 90, scale: [1, 1, 1] },
        visible: true,
        locked: false,
        kind: 'tree',
        variant: 'pine',
        color: '#355f3d',
        trunkColor: '#4b3521',
      },
    ],
  };
}

describe('WorldPlan schema v3', () => {
  it('creates a valid empty plan with groups', () => {
    const plan = createEmptyWorldPlan({ name: 'Test World', seed: 42 });
    const result = validateWorldPlan(plan);
    expect(result.success).toBe(true);
    expect(result.data?.schemaVersion).toBe(WORLD_PLAN_SCHEMA_VERSION);
    expect(plan.groups).toEqual([]);
    expect(plan.objects).toHaveLength(0);
  });

  it('requires a full XYZ rotation', () => {
    const plan = createEmptyWorldPlan();
    const tree = createTree('pine', [0, 0, 0], mulberry32(1));
    const result = validateWorldPlan({
      ...plan,
      objects: [{ ...tree, transform: { ...tree.transform, rotation: [0, 0] } }],
    });
    expect(result.success).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes('rotation'))).toBe(true);
  });

  it('rejects invalid colors and non-positive scale', () => {
    const plan = createEmptyWorldPlan();
    const invalid = {
      ...plan,
      environment: { ...plan.environment, skyColor: 'blue' },
    };
    const result = validateWorldPlan(invalid);
    expect(result.success).toBe(false);
    expect(result.issues.some((issue) => issue.path.includes('skyColor'))).toBe(true);

    const badScale = {
      ...plan,
      objects: [
        {
          ...createTree('pine', [0, 0, 0], mulberry32(1)),
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [0, 1, 1] },
        },
      ],
    };
    expect(validateWorldPlan(badScale).success).toBe(false);
  });

  it('rejects duplicate ids, invalid parents and cycles', () => {
    const plan = createEmptyWorldPlan();
    const tree = createTree('pine', [0, 0, 0], mulberry32(2));

    expect(validateWorldPlan({ ...plan, objects: [tree, tree] }).success).toBe(false);

    const danglingParent = validateWorldPlan({
      ...plan,
      objects: [{ ...tree, parentId: 'missing_group' }],
    });
    expect(danglingParent.success).toBe(false);
    expect(danglingParent.issues[0]?.message).toMatch(/not an existing group/);

    const objectParent = validateWorldPlan({
      ...plan,
      objects: [{ ...tree, parentId: tree.id }],
    });
    expect(objectParent.success).toBe(false);

    const cycled = {
      ...plan,
      groups: [
        { nodeType: 'group', id: 'grp_a', name: 'A', parentId: 'grp_b', transform: tree.transform, visible: true, locked: false },
        { nodeType: 'group', id: 'grp_b', name: 'B', parentId: 'grp_a', transform: tree.transform, visible: true, locked: false },
      ],
    };
    const cycleResult = validateWorldPlan(cycled);
    expect(cycleResult.success).toBe(false);
    expect(cycleResult.issues.some((issue) => /cycle/i.test(issue.message))).toBe(true);
  });

  it('round-trips a grouped document through JSON', () => {
    const plan = createEmptyWorldPlan({ name: 'Round trip' });
    plan.objects.push(createTree('pine', [1, 2, 3], mulberry32(9)));
    plan.objects.push(createLantern([2, 0, 1]));
    const grouped = createGroupFromSelection(
      plan,
      plan.objects.map((object) => object.id),
    ).plan;

    const json = serializeWorldPlan(grouped);
    const restored = deserializeWorldPlan(json);
    expect(restored).toEqual(grouped);
    expect(restored.groups).toHaveLength(1);
  });

  it('rejects unknown object kinds', () => {
    const plan = createEmptyWorldPlan();
    const result = validateWorldPlan({
      ...plan,
      objects: [{ ...createLantern([0, 0, 0]), kind: 'dragon' }],
    });
    expect(result.success).toBe(false);
  });

  it('reports unsupported versions clearly', () => {
    expect(() => migrateWorldPlan({ schemaVersion: 99 })).toThrow(/newer format/);
    expect(() => migrateWorldPlan({ hello: 'world' })).toThrow(/missing a schemaVersion/);
    expect(() => parseWorldPlan({ schemaVersion: WORLD_PLAN_SCHEMA_VERSION })).toThrow(
      WorldPlanValidationError,
    );
  });
});

describe('v1 → v3 migration', () => {
  it('converts rotationY into an XYZ rotation and adds groups/parents', () => {
    const migrated = parseWorldPlan(legacyV1Document());
    expect(migrated.schemaVersion).toBe(WORLD_PLAN_SCHEMA_VERSION);
    expect(migrated.groups).toEqual([]);
    expect(migrated.objects).toHaveLength(1);
    expect(migrated.objects[0]?.transform.rotation).toEqual([0, 90, 0]);
    expect(migrated.objects[0]?.transform.position).toEqual([1, 2, 3]);
    expect(migrated.objects[0]?.parentId).toBeNull();
  });

  it('keeps migrated documents serializable and re-importable', () => {
    const migrated = parseWorldPlan(legacyV1Document());
    const restored = deserializeWorldPlan(serializeWorldPlan(migrated));
    expect(restored).toEqual(migrated);
  });
});

describe('v2 → v3 migration', () => {
  it('adds generation metadata to every legacy object', () => {
    const plan = createEmptyWorldPlan({ name: 'Legacy farm' });
    const tree = createTree('broadleaf', [2, 0, -1], mulberry32(11));
    const { meta: _meta, ...treeWithoutMeta } = tree;
    const legacy = {
      ...plan,
      schemaVersion: 2,
      objects: [treeWithoutMeta],
    };

    const migrated = parseWorldPlan(legacy);
    expect(migrated.schemaVersion).toBe(3);
    const object = migrated.objects[0];
    expect(object?.meta).toBeDefined();
    expect(object?.meta.category).toBe('vegetation');
    expect(object?.meta.geometry).toBe('tree.broadleaf');
    expect(object?.meta.source).toBe('library');
    expect(object?.meta.status).toBe('edited');
    expect(object?.meta.dimensions.every((value) => value > 0)).toBe(true);
  });

  it('keeps v1 documents on the same path', () => {
    const migrated = parseWorldPlan(legacyV1Document());
    expect(migrated.objects[0]?.meta.geometry).toBe('tree.pine');
  });
});

describe('graceful repair of damaged documents', () => {
  it('loads valid documents untouched', () => {
    const plan = createEmptyWorldPlan({ name: 'Clean' });
    const result = parseWorldPlanLenient(plan);
    expect(result.warnings).toEqual([]);
    expect(result.plan).toEqual(plan);
  });

  it('drops unreadable objects instead of failing the whole world', () => {
    const plan = createEmptyWorldPlan({ name: 'Damaged' });
    const valid = createTree('pine', [0, 0, 0], mulberry32(3));
    const result = parseWorldPlanLenient({
      ...plan,
      objects: [valid, { id: 'obj_broken', kind: 'dragon', color: 'nope' }],
    });

    expect(result.plan.objects.map((object) => object.id)).toEqual([valid.id]);
    expect(result.droppedObjects).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/1 object could not be read/);
  });

  it('re-roots nodes whose parent is missing', () => {
    const plan = createEmptyWorldPlan({ name: 'Orphans' });
    const tree = createTree('pine', [0, 0, 0], mulberry32(4));
    const result = parseWorldPlanLenient({
      ...plan,
      objects: [{ ...tree, parentId: 'grp_gone' }],
    });
    expect(result.plan.objects[0]?.parentId).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/missing parent/);
  });

  it('still rejects files that are not world documents', () => {
    expect(() => parseWorldPlanLenient({ hello: 'world' })).toThrow(/missing a schemaVersion/);
  });
});
