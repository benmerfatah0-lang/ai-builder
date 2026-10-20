import { inferMetaForObject } from './objectMeta';
import {
  WORLD_PLAN_SCHEMA_VERSION,
  checkHierarchyIntegrity,
  validateWorldPlan,
  worldPlanSchema,
  worldObjectSchema,
  groupSchema,
  type ValidationIssue,
  type WorldObject,
  type WorldPlan,
  type WorldGroup,
} from './schema';

export class WorldPlanValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[] = []) {
    super(message);
    this.name = 'WorldPlanValidationError';
    this.issues = issues;
  }
}

type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/** v1 → v2: `rotationY` becomes a full XYZ rotation; groups and parentId appear. */
const migrateV1ToV2: Migration = (input) => {
  const rawObjects = Array.isArray(input.objects) ? input.objects : [];
  const objects = rawObjects.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const object = entry as Record<string, unknown>;
    const rawTransform =
      typeof object.transform === 'object' && object.transform !== null
        ? (object.transform as Record<string, unknown>)
        : {};
    const rotationY =
      typeof rawTransform.rotationY === 'number' && Number.isFinite(rawTransform.rotationY)
        ? rawTransform.rotationY
        : 0;

    return {
      ...object,
      parentId: null,
      transform: {
        position: rawTransform.position,
        rotation: [0, rotationY, 0],
        scale: rawTransform.scale,
      },
    };
  });

  return {
    ...input,
    schemaVersion: 2,
    groups: Array.isArray(input.groups) ? input.groups : [],
    objects,
  };
};

/**
 * v2 → v3: every drawable object gains generation metadata. Legacy objects are
 * considered library assets with `status: 'edited'`, so regeneration never
 * silently replaces hand-edited content.
 */
const migrateV2ToV3: Migration = (input) => {
  const rawObjects = Array.isArray(input.objects) ? input.objects : [];
  const objects = rawObjects.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const object = entry as Record<string, unknown>;
    const meta = object.meta ?? inferMetaForObject(object as never);
    return { ...object, meta };
  });

  return { ...input, schemaVersion: 3, objects };
};

/** Registered upgrades keyed by the version they migrate FROM. */
const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};

function readVersion(input: unknown): number | null {
  if (typeof input !== 'object' || input === null) return null;
  const version = (input as Record<string, unknown>).schemaVersion;
  return typeof version === 'number' && Number.isInteger(version) ? version : null;
}

/** Upgrade an untrusted document to the current schema version, or throw. */
export function migrateWorldPlan(input: unknown): unknown {
  let document: unknown = input;
  let version = readVersion(document);

  if (version === null) {
    throw new WorldPlanValidationError(
      'This file is missing a schemaVersion field, so it is not a WorldPlan document.',
    );
  }

  if (version > WORLD_PLAN_SCHEMA_VERSION) {
    throw new WorldPlanValidationError(
      `This world was saved with a newer format (v${version}). This app supports up to v${WORLD_PLAN_SCHEMA_VERSION}.`,
    );
  }

  while (version < WORLD_PLAN_SCHEMA_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new WorldPlanValidationError(
        `No migration is available from schema v${version} to v${WORLD_PLAN_SCHEMA_VERSION}.`,
      );
    }
    document = migration(document as Record<string, unknown>);
    const nextVersion = readVersion(document);
    if (nextVersion === null || nextVersion <= version) {
      throw new WorldPlanValidationError(`Migration from v${version} produced an invalid version.`);
    }
    version = nextVersion;
  }

  return document;
}

/** Validate any object as a current-version WorldPlan, throwing on failure. */
export function parseWorldPlan(input: unknown): WorldPlan {
  const result = validateWorldPlan(migrateWorldPlan(input));
  if (!result.success || !result.data) {
    const details = result.issues
      .slice(0, 4)
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new WorldPlanValidationError(
      `The world file is not valid${details ? ` (${details})` : ''}.`,
      result.issues,
    );
  }
  return result.data;
}

export interface RepairResult {
  plan: WorldPlan;
  warnings: string[];
  droppedObjects: number;
  droppedGroups: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Load a document as gracefully as possible.
 *
 * Valid documents load unchanged. Invalid ones lose only the broken nodes
 * (and any parent references that became dangling) instead of failing whole,
 * so one corrupt object cannot make an entire project unopenable.
 */
export function parseWorldPlanLenient(input: unknown): RepairResult {
  try {
    return { plan: parseWorldPlan(input), warnings: [], droppedObjects: 0, droppedGroups: 0 };
  } catch (error) {
    if (error instanceof WorldPlanValidationError && /missing a schemaVersion/.test(error.message)) {
      throw error;
    }
    if (!isRecord(input)) throw error;

    const migrated = migrateWorldPlan(input);
    if (!isRecord(migrated)) throw error;

    const warnings: string[] = [];
    const rawObjects = Array.isArray(migrated.objects) ? migrated.objects : [];
    const rawGroups = Array.isArray(migrated.groups) ? migrated.groups : [];

    const parsedGroups: WorldGroup[] = [];
    let droppedGroups = 0;
    for (const raw of rawGroups) {
      const result = groupSchema.safeParse(raw);
      if (result.success) parsedGroups.push(result.data);
      else droppedGroups += 1;
    }

    const parsedObjects: WorldObject[] = [];
    let droppedObjects = 0;
    for (const raw of rawObjects) {
      const result = worldObjectSchema.safeParse(raw);
      if (result.success) parsedObjects.push(result.data);
      else droppedObjects += 1;
    }

    if (droppedGroups > 0) {
      warnings.push(`${droppedGroups} group${droppedGroups === 1 ? '' : 's'} could not be read and ${droppedGroups === 1 ? 'was' : 'were'} skipped.`);
    }
    if (droppedObjects > 0) {
      warnings.push(`${droppedObjects} object${droppedObjects === 1 ? '' : 's'} could not be read and ${droppedObjects === 1 ? 'was' : 'were'} skipped.`);
    }

    const groupIds = new Set(parsedGroups.map((group) => group.id));

    // Dangling parents (missing or not a group) fall back to the root.
    let detached = 0;
    const normalizeParent = <T extends { parentId: string | null; name: string }>(node: T): T => {
      if (node.parentId === null) return node;
      if (groupIds.has(node.parentId)) return node;
      detached += 1;
      return { ...node, parentId: null };
    };

    let groups = parsedGroups.map(normalizeParent);
    let objects = parsedObjects.map(normalizeParent);

    // Break cycles by detaching the offending nodes before validation.
    for (let pass = 0; pass < 12; pass += 1) {
      const parentOf = new Map<string, string | null>();
      for (const group of groups) parentOf.set(group.id, group.parentId);
      for (const object of objects) parentOf.set(object.id, object.parentId);

      const cyclic = new Set<string>();
      for (const id of parentOf.keys()) {
        const seen = new Set<string>();
        let cursor: string | null | undefined = id;
        while (cursor !== null && cursor !== undefined) {
          if (seen.has(cursor)) {
            cyclic.add(id);
            break;
          }
          seen.add(cursor);
          cursor = parentOf.get(cursor) ?? null;
        }
      }
      if (cyclic.size === 0) break;

      groups = groups.map((group) =>
        cyclic.has(group.id) ? { ...group, parentId: null } : group,
      );
      objects = objects.map((object) =>
        cyclic.has(object.id) ? { ...object, parentId: null } : object,
      );
    }

    if (detached > 0) {
      warnings.push(
        `${detached} node${detached === 1 ? '' : 's'} had a missing parent and ${detached === 1 ? 'was' : 'were'} moved to the scene root.`,
      );
    }

    const candidate = { ...migrated, groups, objects };
    const result = validateWorldPlan(candidate);
    if (!result.success || !result.data) {
      const details = result.issues
        .slice(0, 3)
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ');
      throw new WorldPlanValidationError(
        `The world file could not be repaired${details ? ` (${details})` : ''}.`,
        result.issues,
      );
    }

    // Surface any remaining structural oddities instead of hiding them.
    const integrity = checkHierarchyIntegrity(result.data);
    for (const issue of integrity.slice(0, 3)) {
      warnings.push(`${issue.path}: ${issue.message}`);
    }

    return { plan: result.data, warnings, droppedObjects, droppedGroups };
  }
}

/** Stable, human-readable project JSON. Unknown fields are stripped. */
export function serializeWorldPlan(plan: WorldPlan): string {
  const validated = worldPlanSchema.parse(plan);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

export function deserializeWorldPlan(json: string): WorldPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorldPlanValidationError('The file is not valid JSON.');
  }
  return parseWorldPlan(parsed);
}

/** Import path: parses and repairs, reporting what was skipped. */
export function deserializeWorldPlanLenient(json: string): RepairResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WorldPlanValidationError('The file is not valid JSON.');
  }
  return parseWorldPlanLenient(parsed);
}
