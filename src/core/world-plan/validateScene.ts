import type { WorldObject, WorldPlan } from './schema';
import { MAX_WORLD_OBJECTS, validateWorldPlan } from './schema';
import { isGroup } from './schema';
import { createTerrainSampler } from '../generation/terrain';
import { footprintFromObject, footprintsOverlap } from '../generation/placement';
import { geometryIdForObject, isSupportedGeometry } from './geometry';

/**
 * Semantic validation on top of the structural schema.
 *
 * `validateWorldPlan` answers "is this a WorldPlan?"; this module answers "can
 * this world actually be built and does it make sense?". Errors block execution,
 * warnings are shown to the user while the scene still builds.
 */

export type SceneIssueCode =
  | 'schema'
  | 'transform'
  | 'unsupported-geometry'
  | 'out-of-bounds'
  | 'overlap'
  | 'floating'
  | 'underwater'
  | 'missing-dependency'
  | 'orphan-group'
  | 'performance';

export interface SceneIssue {
  code: SceneIssueCode;
  severity: 'error' | 'warning';
  message: string;
  objectId?: string;
  groupId?: string;
}

export interface SceneValidation {
  valid: boolean;
  errors: SceneIssue[];
  warnings: SceneIssue[];
  /** Objects the pipeline can safely drop to recover. */
  recoverable: string[];
}

const EPSILON = 0.35;

function nonFiniteObject(object: WorldObject): boolean {
  const { position, rotation, scale } = object.transform;
  return (
    !position.every((value) => Number.isFinite(value)) ||
    !rotation.every((value) => Number.isFinite(value)) ||
    !scale.every((value) => Number.isFinite(value) && value > 0)
  );
}

/** Short label for messages that stays readable in the warnings list. */
function label(object: WorldObject): string {
  return object.name.length > 28 ? `${object.name.slice(0, 27)}…` : object.name;
}

export function validateScenePlan(input: unknown): SceneValidation {
  const structural = validateWorldPlan(input);
  if (!structural.success || !structural.data) {
    const errors: SceneIssue[] = structural.issues.map((issue) => ({
      code: 'schema',
      severity: 'error',
      message: `${issue.path}: ${issue.message}`,
    }));
    return { valid: false, errors, warnings: [], recoverable: [] };
  }

  const plan = structural.data;
  const errors: SceneIssue[] = [];
  const warnings: SceneIssue[] = [];
  const recoverable = new Set<string>();
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const half = plan.terrain.size / 2;

  const groupIds = new Set(plan.groups.map((group) => group.id));
  for (const object of plan.objects) {
    if (object.parentId !== null && !groupIds.has(object.parentId)) {
      errors.push({
        code: 'orphan-group',
        severity: 'error',
        message: `${label(object)} is parented to a missing group.`,
        objectId: object.id,
      });
      recoverable.add(object.id);
    }
  }

  const buildings: WorldObject[] = [];
  const fields: WorldObject[] = [];
  const rivers: WorldObject[] = [];
  const bridges: WorldObject[] = [];

  for (const object of plan.objects) {
    const name = label(object);

    if (nonFiniteObject(object)) {
      errors.push({
        code: 'transform',
        severity: 'error',
        message: `${name} has an invalid transform.`,
        objectId: object.id,
      });
      recoverable.add(object.id);
      continue;
    }

    const declared = object.meta.geometry;
    const geometry = geometryIdForObject(object);
    if (!isSupportedGeometry(declared) || !isSupportedGeometry(geometry)) {
      errors.push({
        code: 'unsupported-geometry',
        severity: 'error',
        message: `${name} uses unsupported geometry “${!isSupportedGeometry(declared) ? declared : geometry}”.`,
        objectId: object.id,
      });
      recoverable.add(object.id);
      continue;
    }

    const [x, y, z] = object.transform.position;
    if (Math.abs(x) > half + 2 || Math.abs(z) > half + 2) {
      warnings.push({
        code: 'out-of-bounds',
        severity: 'warning',
        message: `${name} sits outside the terrain and may hover over nothing.`,
        objectId: object.id,
      });
    }

    if (object.kind !== 'path' && object.kind !== 'river') {
      const ground = sampler.heightAt(x, z);
      if (y - ground > 1.5) {
        warnings.push({
          code: 'floating',
          severity: 'warning',
          message: `${name} floats ${(y - ground).toFixed(1)} m above the ground.`,
          objectId: object.id,
        });
      }
      if (y - ground < -1.2) {
        warnings.push({
          code: 'underwater',
          severity: 'warning',
          message: `${name} is buried ${(ground - y).toFixed(1)} m below the ground.`,
          objectId: object.id,
        });
      }
      if (
        plan.terrain.waterLevel !== null &&
        object.kind !== 'bridge' &&
        object.kind !== 'field' &&
        y < plan.terrain.waterLevel - EPSILON
      ) {
        warnings.push({
          code: 'underwater',
          severity: 'warning',
          message: `${name} is below the water line.`,
          objectId: object.id,
        });
      }
    }

    if (object.kind === 'building' || object.kind === 'rock') buildings.push(object);
    if (object.kind === 'field') fields.push(object);
    if (object.kind === 'river') rivers.push(object);
    if (object.kind === 'bridge') bridges.push(object);
  }

  // Impossible placements: solid buildings should not intersect each other.
  const solid = buildings.filter((object) => object.kind === 'building');
  for (let a = 0; a < solid.length; a += 1) {
    const boxA = footprintFromObject(solid[a]!, 0.2);
    if (!boxA) continue;
    for (let b = a + 1; b < solid.length; b += 1) {
      const boxB = footprintFromObject(solid[b]!, 0.2);
      if (!boxB) continue;
      if (footprintsOverlap(boxA, boxB)) {
        warnings.push({
          code: 'overlap',
          severity: 'warning',
          message: `${label(solid[a]!)} overlaps ${label(solid[b]!)}.`,
          objectId: solid[b]!.id,
        });
      }
    }
  }

  for (let a = 0; a < fields.length; a += 1) {
    const boxA = footprintFromObject(fields[a]!);
    if (!boxA) continue;
    for (let b = a + 1; b < fields.length; b += 1) {
      const boxB = footprintFromObject(fields[b]!);
      if (!boxB) continue;
      if (footprintsOverlap(boxA, boxB, 0.5)) {
        warnings.push({
          code: 'overlap',
          severity: 'warning',
          message: `${label(fields[a]!)} overlaps ${label(fields[b]!)}.`,
          objectId: fields[b]!.id,
        });
      }
    }
  }

  if (bridges.length > 0 && rivers.length === 0) {
    for (const bridge of bridges) {
      errors.push({
        code: 'missing-dependency',
        severity: 'error',
        message: `${label(bridge)} needs a river to cross.`,
        objectId: bridge.id,
      });
      recoverable.add(bridge.id);
    }
  }

  if (plan.objects.length > MAX_WORLD_OBJECTS * 0.85) {
    warnings.push({
      code: 'performance',
      severity: 'warning',
      message: `${plan.objects.length} objects is close to the ${MAX_WORLD_OBJECTS} limit; mobile GPUs may struggle.`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    recoverable: [...recoverable],
  };
}

export interface RepairResult {
  plan: WorldPlan;
  removed: string[];
  moved: string[];
  notes: string[];
}

/**
 * Safe recovery for generated plans: drop objects that cannot be built (unknown
 * geometry, orphaned parents) and reseat objects that float far above or sink
 * far below the terrain. Returns a new plan and a human-readable log.
 */
export function repairScenePlan(plan: WorldPlan): RepairResult {
  const removed: string[] = [];
  const moved: string[] = [];
  const notes: string[] = [];
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const groupIds = new Set(plan.groups.map((group) => group.id));
  const half = plan.terrain.size / 2 - 2;

  const objects: WorldObject[] = [];
  for (const object of plan.objects) {
    if (
      !isSupportedGeometry(object.meta.geometry) ||
      !isSupportedGeometry(geometryIdForObject(object))
    ) {
      removed.push(object.name);
      continue;
    }
    if (object.parentId !== null && !groupIds.has(object.parentId)) {
      objects.push({ ...object, parentId: null });
      notes.push(`“${object.name}” was detached from a missing group.`);
      continue;
    }
    if (!Number.isFinite(object.transform.position[0])) {
      removed.push(object.name);
      continue;
    }
    const [x, y, z] = object.transform.position;
    const clampedX = Math.max(-half, Math.min(half, x));
    const clampedZ = Math.max(-half, Math.min(half, z));
    let nextY = y;
    // Ribbons already follow the terrain; only solids are reseated.
    if (object.kind !== 'path' && object.kind !== 'river' && object.kind !== 'fence') {
      const ground = sampler.heightAt(clampedX, clampedZ);
      if (Math.abs(y - ground) > 1.5) nextY = ground;
    }
    if (clampedX !== x || clampedZ !== z || nextY !== y) {
      moved.push(object.name);
      objects.push({
        ...object,
        transform: {
          ...object.transform,
          position: [clampedX, nextY, clampedZ],
        },
      });
    } else {
      objects.push(object);
    }
  }

  if (removed.length > 0) {
    notes.push(`Removed ${removed.length} unbuildable object(s): ${removed.slice(0, 4).join(', ')}${removed.length > 4 ? '…' : ''}.`);
  }
  if (moved.length > 0) {
    notes.push(`Repositioned ${moved.length} object(s) that were off the terrain or floating.`);
  }

  return {
    plan: { ...plan, objects, groups: plan.groups.filter((group) => isGroup(group)) },
    removed,
    moved,
    notes,
  };
}
