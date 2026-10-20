import { z } from 'zod';

/**
 * Version of the WorldPlan document format.
 *
 * v1 → v2 (Phase 2): full XYZ rotation replaces `rotationY`; objects gained a
 * `parentId`; groups and optional per-object material settings were added.
 * `src/core/world-plan/migrate.ts` upgrades v1 documents transparently.
 */
export const WORLD_PLAN_SCHEMA_VERSION = 2 as const;

/** Hard ceilings so a single project cannot freeze a mobile GPU. */
export const MAX_WORLD_OBJECTS = 1500;
export const MAX_WORLD_GROUPS = 200;
export const MAX_GROUP_DEPTH = 8;

const idSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, 'IDs may only contain letters, numbers, hyphen and underscore');

const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colors must use the #rrggbb format');

const finiteNumber = z.number().finite();

const vec3Schema = z.tuple([finiteNumber, finiteNumber, finiteNumber]);

const positiveVec3Schema = z.tuple([
  z.number().finite().positive(),
  z.number().finite().positive(),
  z.number().finite().positive(),
]);

const degrees = z.number().finite().min(-3600).max(3600);

export const transformSchema = z.object({
  /** Local position, relative to the parent group (or the world when unparented). */
  position: vec3Schema,
  /** Local Euler rotation in degrees, applied in XYZ order. */
  rotation: z.tuple([degrees, degrees, degrees]),
  /** Local scale. */
  scale: positiveVec3Schema,
});

export const materialSchema = z.object({
  roughness: z.number().finite().min(0).max(1).optional(),
  metalness: z.number().finite().min(0).max(1).optional(),
  emissiveIntensity: z.number().finite().min(0).max(5).optional(),
});

export const environmentSchema = z.object({
  skyColor: hexColorSchema,
  fogColor: hexColorSchema,
  /** Exponential-squared fog density. 0 disables fog. */
  fogDensity: z.number().finite().min(0).max(1),
  sunColor: hexColorSchema,
  /** Compass angle in degrees. */
  sunAzimuth: z.number().finite().min(0).max(360),
  /** Height above the horizon in degrees. */
  sunElevation: z.number().finite().min(0).max(90),
  sunIntensity: z.number().finite().min(0).max(4),
  ambientIntensity: z.number().finite().min(0).max(3),
});

export const terrainStyleSchema = z.enum([
  'flat',
  'hills',
  'mountains',
  'dunes',
  'islands',
]);

export const terrainSchema = z.object({
  style: terrainStyleSchema,
  /** Width and depth of the terrain in world units. */
  size: z.number().finite().min(32).max(512),
  /** Number of grid subdivisions per axis. */
  resolution: z.number().int().min(16).max(256),
  /** Maximum vertical amplitude in world units. */
  heightScale: z.number().finite().min(0).max(200),
  /** Absolute Y of the water surface, or null for no water. */
  waterLevel: z.number().finite().min(-200).max(200).nullable(),
  /** Vertex-color ramp used by the renderer and future exporters. */
  palette: z.object({
    low: hexColorSchema,
    high: hexColorSchema,
  }),
});

const nodeBaseShape = {
  id: idSchema,
  name: z.string().min(1).max(80),
  /** Parent group id, or null for a root node. Objects can only parent to groups. */
  parentId: idSchema.nullable(),
  transform: transformSchema,
  visible: z.boolean(),
  locked: z.boolean(),
};

/** A transform-only container used to organise and move several nodes at once. */
export const groupSchema = z.object({
  /** Discriminant that keeps groups distinct from drawable objects at the type level. */
  nodeType: z.literal('group'),
  id: idSchema,
  name: z.string().min(1).max(80),
  parentId: idSchema.nullable(),
  transform: transformSchema,
  visible: z.boolean(),
  locked: z.boolean(),
});

export const primitiveKindSchema = z.enum([
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
]);

export const treeVariantSchema = z.enum(['pine', 'broadleaf', 'palm', 'cactus']);
export const rockVariantSchema = z.enum(['boulder', 'crag']);
export const buildingVariantSchema = z.enum(['house', 'tower', 'ruin']);

const objectBaseShape = {
  ...nodeBaseShape,
  material: materialSchema.optional(),
};

export const primitiveObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('primitive'),
  primitive: primitiveKindSchema,
  color: hexColorSchema,
});

export const treeObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('tree'),
  variant: treeVariantSchema,
  color: hexColorSchema,
  trunkColor: hexColorSchema,
});

export const rockObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('rock'),
  variant: rockVariantSchema,
  color: hexColorSchema,
});

export const buildingObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('building'),
  variant: buildingVariantSchema,
  color: hexColorSchema,
  roofColor: hexColorSchema,
});

export const lanternObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('lantern'),
  color: hexColorSchema,
});

export const worldObjectSchema = z.discriminatedUnion('kind', [
  primitiveObjectSchema,
  treeObjectSchema,
  rockObjectSchema,
  buildingObjectSchema,
  lanternObjectSchema,
]);

export const worldPlanSchema = z.object({
  schemaVersion: z.literal(WORLD_PLAN_SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  /** Deterministic generation seed (unsigned 32-bit). */
  seed: z.number().int().min(0).max(4294967295),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  environment: environmentSchema,
  terrain: terrainSchema,
  /** Optional transform-only groups; objects may be parented to them. */
  groups: z.array(groupSchema).max(MAX_WORLD_GROUPS),
  objects: z.array(worldObjectSchema).max(MAX_WORLD_OBJECTS),
});

export type WorldPlan = z.infer<typeof worldPlanSchema>;
export type WorldEnvironment = z.infer<typeof environmentSchema>;
export type Terrain = z.infer<typeof terrainSchema>;
export type TerrainStyle = z.infer<typeof terrainStyleSchema>;
export type Transform = z.infer<typeof transformSchema>;
export type MaterialSettings = z.infer<typeof materialSchema>;
export type WorldGroup = z.infer<typeof groupSchema>;
export type PrimitiveKind = z.infer<typeof primitiveKindSchema>;
export type TreeVariant = z.infer<typeof treeVariantSchema>;
export type RockVariant = z.infer<typeof rockVariantSchema>;
export type BuildingVariant = z.infer<typeof buildingVariantSchema>;

export type PrimitiveObject = z.infer<typeof primitiveObjectSchema>;
export type TreeObject = z.infer<typeof treeObjectSchema>;
export type RockObject = z.infer<typeof rockObjectSchema>;
export type BuildingObject = z.infer<typeof buildingObjectSchema>;
export type LanternObject = z.infer<typeof lanternObjectSchema>;
export type WorldObject = z.infer<typeof worldObjectSchema>;

export type WorldObjectKind = WorldObject['kind'];
/** Either a drawable object or a transform-only group. */
export type SceneNode = WorldObject | WorldGroup;
export type SceneNodeKind = 'object' | 'group';

export function isGroup(node: SceneNode): node is WorldGroup {
  return 'nodeType' in node && node.nodeType === 'group';
}

/** Field-level errors shaped for form display, keyed by dot-path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  success: boolean;
  data?: WorldPlan;
  issues: ValidationIssue[];
}

/**
 * Structural checks the field schema cannot express: unique IDs, parents that
 * exist and are groups, and a cycle-free hierarchy.
 */
export function checkHierarchyIntegrity(plan: {
  groups: WorldGroup[];
  objects: WorldObject[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const groupIds = new Set<string>();

  for (const group of plan.groups) {
    if (seen.has(group.id)) {
      issues.push({ path: 'groups', message: `Duplicate id "${group.id}".` });
    }
    seen.add(group.id);
    groupIds.add(group.id);
  }

  for (const object of plan.objects) {
    if (seen.has(object.id)) {
      issues.push({ path: 'objects', message: `Duplicate id "${object.id}".` });
    }
    seen.add(object.id);
  }

  const parentOf = new Map<string, string | null>();
  for (const group of plan.groups) parentOf.set(group.id, group.parentId);
  for (const object of plan.objects) parentOf.set(object.id, object.parentId);

  for (const group of plan.groups) {
    if (group.parentId !== null && !groupIds.has(group.parentId)) {
      issues.push({
        path: `groups.${group.id}.parentId`,
        message: `Parent "${group.parentId}" is not an existing group.`,
      });
    }
  }

  for (const object of plan.objects) {
    if (object.parentId !== null && !groupIds.has(object.parentId)) {
      issues.push({
        path: `objects.${object.id}.parentId`,
        message: `Parent "${object.parentId}" is not an existing group.`,
      });
    }
  }

  // Cycle detection: walk up from every node with a bounded step count.
  for (const [id] of parentOf) {
    const visited = new Set<string>();
    let cursor: string | null | undefined = id;
    let depth = 0;
    while (cursor !== null && cursor !== undefined) {
      if (visited.has(cursor)) {
        issues.push({ path: 'groups', message: `Hierarchy cycle detected at "${id}".` });
        break;
      }
      visited.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
      depth += 1;
      if (depth > MAX_GROUP_DEPTH + 2) {
        issues.push({ path: 'groups', message: `Hierarchy is nested too deeply at "${id}".` });
        break;
      }
    }
  }

  return issues;
}

/** Validate untrusted data (save files, IndexedDB rows, future imports). */
export function validateWorldPlan(input: unknown): ValidationResult {
  const result = worldPlanSchema.safeParse(input);
  if (!result.success) {
    return {
      success: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }

  const hierarchyIssues = checkHierarchyIntegrity(result.data);
  if (hierarchyIssues.length > 0) {
    return { success: false, issues: hierarchyIssues };
  }

  return { success: true, data: result.data, issues: [] };
}
