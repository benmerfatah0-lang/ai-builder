import { z } from 'zod';

/**
 * Version of the WorldPlan document format.
 *
 * Bump this whenever a breaking change is made. Non-breaking additions (new
 * optional fields, new object kinds) can stay within a version as long as the
 * loader tolerates missing data.
 */
export const WORLD_PLAN_SCHEMA_VERSION = 1 as const;

/** Hard ceiling so a single project cannot freeze a mobile GPU. */
export const MAX_WORLD_OBJECTS = 1500;

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

export const transformSchema = z.object({
  /** World-space position of the object's base/origin. */
  position: vec3Schema,
  /** Rotation around the up axis, in degrees. */
  rotationY: z.number().finite().min(-360).max(360),
  scale: positiveVec3Schema,
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

const baseObjectShape = {
  id: idSchema,
  name: z.string().min(1).max(80),
  transform: transformSchema,
  visible: z.boolean(),
  locked: z.boolean(),
};

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

export const primitiveObjectSchema = z.object({
  ...baseObjectShape,
  kind: z.literal('primitive'),
  primitive: primitiveKindSchema,
  color: hexColorSchema,
});

export const treeObjectSchema = z.object({
  ...baseObjectShape,
  kind: z.literal('tree'),
  variant: treeVariantSchema,
  color: hexColorSchema,
  trunkColor: hexColorSchema,
});

export const rockObjectSchema = z.object({
  ...baseObjectShape,
  kind: z.literal('rock'),
  variant: rockVariantSchema,
  color: hexColorSchema,
});

export const buildingObjectSchema = z.object({
  ...baseObjectShape,
  kind: z.literal('building'),
  variant: buildingVariantSchema,
  color: hexColorSchema,
  roofColor: hexColorSchema,
});

export const lanternObjectSchema = z.object({
  ...baseObjectShape,
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
  objects: z.array(worldObjectSchema).max(MAX_WORLD_OBJECTS),
});

export type WorldPlan = z.infer<typeof worldPlanSchema>;
export type WorldEnvironment = z.infer<typeof environmentSchema>;
export type Terrain = z.infer<typeof terrainSchema>;
export type TerrainStyle = z.infer<typeof terrainStyleSchema>;
export type Transform = z.infer<typeof transformSchema>;
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

/** Validate untrusted data (save files, IndexedDB rows, future imports). */
export function validateWorldPlan(input: unknown): ValidationResult {
  const result = worldPlanSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data, issues: [] };
  }
  return {
    success: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}
