import { z } from 'zod';
import { generatedMeshValid, MAX_GENERATED_DATA, MAX_GENERATED_INDICES, MAX_GENERATED_VERTICES } from './generatedMesh';
import { EXPANDED_ASSET_IDS } from '../assets/expandedDefinitions';

/**
 * Version of the WorldPlan document format.
 *
 * v1 → v2 (Phase 2): full XYZ rotation replaces `rotationY`; objects gained a
 * `parentId`; groups and optional per-object material settings were added.
 * v2 → v3 (Phase 3): every object carries generation metadata (category,
 * geometry type, dimensions, source, status, placement and collision settings),
 * and the generator produces paths, rivers, fences, fields and bridges.
 * `src/core/world-plan/migrate.ts` upgrades older documents transparently.
 */
export const WORLD_PLAN_SCHEMA_VERSION = 3 as const;

/** Hard ceilings so a single project cannot freeze a mobile GPU. */
export const MAX_WORLD_OBJECTS = 1500;
export const MAX_WORLD_GROUPS = 200;
/** Bound photo geometry across a project for mobile devices. */
export const MAX_PHOTO_CELLS = 4608;
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
  'valley', 'plateau', 'canyon', 'volcano', 'crater',
]);

/** A polyline in world XZ coordinates, used for ridges, valleys and rivers. */
const spineSchema = z.array(z.tuple([finiteNumber, finiteNumber])).min(2).max(24);

/**
 * Procedural landscape descriptors (v1).
 *
 * Every field is optional: a document without `landscape` keeps the classic
 * analytic terrain exactly as before, and a document with one is baked by the
 * chunked landscape engine. Descriptors are data, not geometry — the engine is
 * deterministic, so (terrain, seed) always reproduces the same surface, which is
 * what keeps saved worlds, exports and regional regeneration stable.
 */
export const landscapeSchema = z.object({
  /** Engine version; a bump means older bakes may be re-generated differently. */
  version: z.literal(1).optional(),
  /** Internal bake resolution, independent of the rendered mesh resolution. */
  cells: z.number().int().min(16).max(512).optional(),
  /** Long mountain ranges built along a spine with ridged multifractal relief. */
  ranges: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    spine: spineSchema,
    width: z.number().finite().min(4).max(512),
    height: z.number().finite().min(0).max(200),
    roughness: z.number().finite().min(0).max(1).optional(),
    /** 0 = smooth dome, 1 = sharp crest; controls how the ridge mask falls off. */
    sharpness: z.number().finite().min(0).max(2).optional(),
    snowLine: z.number().finite().min(-200).max(200).optional(),
  }).strict()).max(12).optional(),
  /** Rounded hill fields. */
  hills: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(2).max(512),
    height: z.number().finite().min(0).max(200),
    roughness: z.number().finite().min(0).max(1).optional(),
  }).strict()).max(16).optional(),
  /** Valleys: lowered corridors with a V or U cross-section. */
  valleys: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    spine: spineSchema,
    width: z.number().finite().min(2).max(512),
    depth: z.number().finite().min(0).max(200),
    /** 0 = sharp V, 1 = wide flat U floor. */
    floor: z.number().finite().min(0).max(1).optional(),
  }).strict()).max(12).optional(),
  /** Terraced high ground with steep edges. */
  plateaus: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(2).max(512),
    height: z.number().finite().min(0).max(200),
    terraces: z.number().int().min(1).max(12).optional(),
    /** Horizontal extent of the cliff at the plateau edge, in world units. */
    edge: z.number().finite().min(0.5).max(120).optional(),
  }).strict()).max(12).optional(),
  /** Canyons: deep, narrow, steep-walled channels. */
  canyons: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    spine: spineSchema,
    width: z.number().finite().min(1).max(256),
    depth: z.number().finite().min(0).max(200),
    meander: z.number().finite().min(0).max(1).optional(),
  }).strict()).max(12).optional(),
  /** Volcanoes: cone, crater or caldera, with radial drainage gullies. */
  volcanoes: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(4).max(512),
    height: z.number().finite().min(0).max(200),
    /** Crater radius as a fraction of `radius`. */
    crater: z.number().finite().min(0).max(0.8).optional(),
    /** Collapse the summit into a caldera instead of a small crater. */
    caldera: z.boolean().optional(),
    gullies: z.number().int().min(0).max(24).optional(),
  }).strict()).max(8).optional(),
  /** Impact craters: rim, ejecta blanket and optional central peak. */
  craters: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(2).max(256),
    depth: z.number().finite().min(0).max(200),
    rim: z.number().finite().min(0).max(100).optional(),
    centralPeak: z.number().finite().min(0).max(1).optional(),
  }).strict()).max(12).optional(),
  /** Archipelagos: several islands with noise-broken coastlines. */
  islands: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(2).max(256),
    height: z.number().finite().min(0).max(200),
    /** 0 = round, 1 = heavily broken coastline. */
    irregularity: z.number().finite().min(0).max(1).optional(),
    /** Smaller satellite islands scattered around the main one. */
    satellites: z.number().int().min(0).max(24).optional(),
  }).strict()).max(16).optional(),
  /** Ocean: drops the map border below the water line. */
  ocean: z.object({
    /** Fraction of the half-size where the falloff starts, 0..1. */
    start: z.number().finite().min(0).max(1).optional(),
    depth: z.number().finite().min(0).max(200).optional(),
  }).strict().optional(),
  /** Lakes beyond the single legacy `lakeBasin`. */
  lakes: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    center: z.tuple([finiteNumber, finiteNumber]),
    radius: z.number().finite().min(1).max(256),
    depth: z.number().finite().min(0.1).max(80),
    /** Fill the basin up to this absolute Y instead of carving only. */
    level: finiteNumber.nullable().optional(),
  }).strict()).max(12).optional(),
  /** Rivers with real downhill paths, carved into their own bed. */
  rivers: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    /** Optional fixed source; otherwise the engine picks high ground. */
    source: z.tuple([finiteNumber, finiteNumber]).optional(),
    /** Optional fixed mouth; otherwise the river runs to the lowest sink. */
    mouth: z.tuple([finiteNumber, finiteNumber]).optional(),
    width: z.number().finite().min(0.5).max(40).optional(),
    depth: z.number().finite().min(0).max(20).optional(),
    meander: z.number().finite().min(0).max(2).optional(),
    /** Carve the bed so the water ribbon never floats above the ground. */
    carve: z.boolean().optional(),
    /** Keep buildings out of the corridor by this many world units. */
    corridor: z.number().finite().min(0).max(80).optional(),
  }).strict()).max(8).optional(),
  /** Natural caves: galleries carved into rock, with a recorded entrance. */
  caves: z.array(z.object({
    id: z.string().min(1).max(40).optional(),
    entrance: z.tuple([finiteNumber, finiteNumber]).optional(),
    radius: z.number().finite().min(1).max(60).optional(),
    depth: z.number().finite().min(1).max(80).optional(),
    chambers: z.number().int().min(1).max(8).optional(),
    /** Heading in degrees; 0 = +Z. Chosen automatically when omitted. */
    heading: z.number().finite().min(0).max(360).optional(),
  }).strict()).max(12).optional(),
  /** Cliff and rock formation treatment for steep ground. */
  cliffs: z.object({
    /** Slope (rise/run) above which ground is treated as a cliff face. */
    minSlope: z.number().finite().min(0.1).max(4).optional(),
    /** Extra steepening applied to cliff faces, 0..1. */
    sharpen: z.number().finite().min(0).max(1).optional(),
    /** Fraction of eligible cells that become exposed rock, 0..1. */
    coverage: z.number().finite().min(0).max(1).optional(),
  }).strict().optional(),
  /** Beaches and coastline flattening. */
  beaches: z.object({
    /** Horizontal width of the beach band, in world units. */
    width: z.number().finite().min(0).max(60).optional(),
    /** Only flatten ground gentler than this slope. */
    maxSlope: z.number().finite().min(0.01).max(3).optional(),
    /** Beach crest height above the water line. */
    elevation: z.number().finite().min(0).max(10).optional(),
  }).strict().optional(),
  /** Interconnected biomes with blended borders. */
  biomes: z.array(z.object({
    id: z.string().min(1).max(40),
    biome: z.string().min(1).max(40),
    center: z.tuple([finiteNumber, finiteNumber]).optional(),
    radius: z.number().finite().min(1).max(512).optional(),
    weight: z.number().finite().min(0).max(1).optional(),
    /** Border softness in world units; 0 would be a hard line. */
    transition: z.number().finite().min(0).max(256).optional(),
    palette: z.object({ low: hexColorSchema, high: hexColorSchema }).optional(),
  }).strict()).max(12).optional(),
  /** Erosion-inspired detail. All work is bounded and seeded. */
  erosion: z.object({
    /** Number of simulated rain droplets; 0 disables hydraulic erosion. */
    droplets: z.number().int().min(0).max(200000).optional(),
    /** Path length of each droplet. */
    iterations: z.number().int().min(1).max(200).optional(),
    inertia: z.number().finite().min(0).max(1).optional(),
    sedimentCapacity: z.number().finite().min(0).max(40).optional(),
    erosionRate: z.number().finite().min(0).max(1).optional(),
    depositionRate: z.number().finite().min(0).max(1).optional(),
    evaporation: z.number().finite().min(0).max(1).optional(),
    /** Talus smoothing passes; 0 disables thermal erosion. */
    thermalPasses: z.number().int().min(0).max(12).optional(),
    /** Maximum stable slope (rise/run) used by the thermal pass. */
    talus: z.number().finite().min(0.01).max(4).optional(),
  }).strict().optional(),
  /** High-frequency surface detail added on top of the baked grid. */
  detail: z.object({
    amplitude: z.number().finite().min(0).max(40).optional(),
    scale: z.number().finite().min(1).max(400).optional(),
    octaves: z.number().int().min(1).max(6).optional(),
  }).strict().optional(),
  /** Chunked generation and level-of-detail settings. */
  chunks: z.object({
    /** Chunk edge length in world units. */
    size: z.number().finite().min(8).max(512).optional(),
    /** Distance bands, nearest first: beyond `distance` a chunk uses `cells`. */
    lod: z.array(z.object({
      distance: z.number().finite().min(0).max(4096),
      cells: z.number().int().min(2).max(256),
    }).strict()).max(8).optional(),
    /** Overlap in world units so neighbouring chunks share edge vertices. */
    skirt: z.number().finite().min(0).max(16).optional(),
  }).strict().optional(),
}).strict();

export type LandscapeSpec = z.infer<typeof landscapeSchema>;

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
  /** Optional depression in an otherwise flat terrain, for a local water body. */
  lakeBasin: z.object({ x:z.number().finite().min(-256).max(256), z:z.number().finite().min(-256).max(256), radius:z.number().finite().min(1).max(256), depth:z.number().finite().min(0.1).max(50) }).strict().optional(),
  /** Vertex-color ramp used by the renderer and future exporters. */
  palette: z.object({
    low: hexColorSchema,
    high: hexColorSchema,
  }),
  /**
   * Optional procedural landscape recipe. Absent means the classic analytic
   * terrain; present means the surface is baked by the landscape engine.
   */
  landscape: landscapeSchema.optional(),
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

/** Broad scene role, used by the planner, inspector and regeneration. */
export const objectCategorySchema = z.enum([
  'structure',
  'vegetation',
  'rock',
  'prop',
  'field',
  'path',
  'water',
  'fence',
  'terrain',
]);

/**
 * Generation metadata. It makes every generated object reproducible and
 * re-rollable: `geometry` selects the procedural builder, `seed` drives its
 * variation, and `dimensions`/`collision` feed placement and spatial checks.
 */
const referenceUrl = z.string().max(1200).refine((url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'commons.wikimedia.org' && u.pathname.startsWith('/wiki/File:') && !u.username && !u.password && !u.port && !u.search && !u.hash; } catch { return false; }
});
const commonsPhotoSourceSchema = z.object({ title: z.string().min(1).max(120), url: referenceUrl, author: z.string().min(1).max(200), license_name: z.string().min(1).max(200), license_url: z.string().regex(/^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/[1-4]\.0\/|publicdomain\/zero\/1\.0\/)$/) }).strict();
const localPhotoSourceSchema = z.object({ kind: z.literal('local'), title: z.string().min(1).max(120), author: z.string().min(1).max(200), license_name: z.string().min(1).max(200) }).strict();
export type LocalPhotoSource = z.infer<typeof localPhotoSourceSchema>;
export const photoModelSchema = z.object({
  mode: z.enum(['silhouette', 'manual-silhouette', 'full-image-slab']).optional(),
  /** Older projects omit this field and keep their original blocky geometry. */
  meshStyle: z.enum(['smooth', 'blocky']).optional(),
  width: z.number().int().min(1).max(24), height: z.number().int().min(1).max(24),
  cells: z.array(z.object({ x: z.number().int().min(0).max(23), y: z.number().int().min(0).max(23), depth: z.number().int().min(1).max(12), color: hexColorSchema }).strict()).min(1).max(576),
  source: z.union([commonsPhotoSourceSchema, localPhotoSourceSchema]),
}).strict().refine((value) => value.cells.every((cell) => cell.x < value.width && cell.y < value.height) && new Set(value.cells.map((c) => `${c.x}:${c.y}`)).size === value.cells.length);
export type PhotoModel = z.infer<typeof photoModelSchema>;

export const objectMetaSchema = z.object({
  category: objectCategorySchema,
  /** Procedural geometry identifier, e.g. `building.barn` or `field.wheat`. */
  geometry: z.string().min(1).max(60),
  /** Base size before the object transform is applied. */
  dimensions: positiveVec3Schema,
  /** Where the object came from. */
  source: z.enum(['procedural', 'library', 'manual']),
  /** `edited` once the user changed it after generation. */
  status: z.enum(['generated', 'edited']),
  /** Semantic role inside the generated scene, e.g. `barn` or `orchard-row`. */
  role: z.string().min(1).max(40).optional(),
  /** Seed for this object's own variation, independent of the world seed. */
  seed: z.number().int().min(0).max(4294967295).optional(),
  /** Low-resolution photo-based silhouette with a guessed symmetrical depth. */
  photoModel: photoModelSchema.optional(),
  generatedMesh: z.object({ vertices: z.number().int().min(3).max(MAX_GENERATED_VERTICES), indices: z.number().int().min(3).max(MAX_GENERATED_INDICES), data: z.string().max(MAX_GENERATED_DATA) }).strict().refine(generatedMeshValid, 'Invalid generated triangle geometry').optional(),
  /** A flat-roof desert house variation used by the mining town. */
  desertHouse: z.boolean().optional(),
  /** Parameters of an app-generated trainable procedural design. */
  learnedShape: z.object({ detail: z.number().finite().min(0.7).max(1.3), seed: z.number().int().min(0).max(4294967295) }).optional(),
  /** Logical region used for regional regeneration, e.g. `west-field`. */
  region: z.string().min(1).max(40).optional(),
  placement: z
    .object({
      anchor: z.enum(['ground', 'terrain', 'water']),
      avoidOverlap: z.boolean(),
    })
    .optional(),
  collision: z
    .object({
      shape: z.enum(['box', 'none']),
      blocking: z.boolean(),
    })
    .optional(),
});

export const primitiveKindSchema = z.enum([
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'plane',
  'photo-model', 'generated-mesh',
  'mine-entrance', 'mine-cart', 'pickaxe', 'excavator', 'chest',
  ...EXPANDED_ASSET_IDS,
]);

export const treeVariantSchema = z.enum(['pine', 'broadleaf', 'palm', 'cactus', 'bush']);
export const rockVariantSchema = z.enum(['boulder', 'crag']);
export const buildingVariantSchema = z.enum(['house', 'tower', 'ruin', 'barn', 'coop']);
export const pathStyleSchema = z.enum(['dirt', 'stone', 'gravel']);
export const fenceStyleSchema = z.enum(['wood', 'stone', 'rail']);

const objectBaseShape = {
  ...nodeBaseShape,
  material: materialSchema.optional(),
  /** Generation metadata (v3). */
  meta: objectMetaSchema,
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

/** Dirt/stone ribbon that follows the terrain. Points are local to the object. */
export const pathObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('path'),
  points: z.array(vec3Schema).min(2).max(64),
  width: z.number().finite().min(0.2).max(20),
  color: hexColorSchema,
  style: pathStyleSchema,
});

/** Water ribbon for streams and rivers (terrain water level stays separate). */
export const riverObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('river'),
  points: z.array(vec3Schema).min(2).max(64),
  width: z.number().finite().min(0.5).max(40),
  color: hexColorSchema,
});

/** Posts and rails (or a low stone wall) along a polyline. */
export const fenceObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('fence'),
  points: z.array(vec3Schema).min(2).max(64),
  height: z.number().finite().min(0.4).max(6),
  style: fenceStyleSchema,
  postColor: hexColorSchema,
  railColor: hexColorSchema,
});

/** A planted field rendered with instanced crops. */
export const fieldObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('field'),
  width: z.number().finite().min(1).max(120),
  depth: z.number().finite().min(1).max(120),
  rows: z.number().int().min(2).max(64),
  density: z.number().finite().min(0.05).max(1),
  cropColor: hexColorSchema,
  soilColor: hexColorSchema,
  seed: z.number().int().min(0).max(4294967295),
});

/** Deck, supports and railings across a river or ditch. */
export const bridgeObjectSchema = z.object({
  ...objectBaseShape,
  kind: z.literal('bridge'),
  length: z.number().finite().min(2).max(60),
  width: z.number().finite().min(1).max(12),
  deckColor: hexColorSchema,
  railColor: hexColorSchema,
});

export const worldObjectSchema = z.discriminatedUnion('kind', [
  primitiveObjectSchema,
  treeObjectSchema,
  rockObjectSchema,
  buildingObjectSchema,
  lanternObjectSchema,
  pathObjectSchema,
  riverObjectSchema,
  fenceObjectSchema,
  fieldObjectSchema,
  bridgeObjectSchema,
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
}).superRefine((plan, ctx) => {
  let cells = 0;
  let generatedSize = 0;
  for (const object of plan.objects) {
    const photo = object.meta.photoModel;
    const isPhoto = object.kind === 'primitive' && object.primitive === 'photo-model';
    if (isPhoto !== Boolean(photo)) ctx.addIssue({ code: 'custom', path: ['objects'], message: 'Photo models must have matching photo geometry and metadata.' });
    if (photo) cells += photo.cells.length;
    const generated = object.meta.generatedMesh;
    const isGenerated = object.kind === 'primitive' && object.primitive === 'generated-mesh';
    if (isGenerated !== Boolean(generated)) ctx.addIssue({ code: 'custom', path: ['objects'], message: 'Generated meshes must have matching geometry data.' });
    if (generated) generatedSize += generated.data.length;
  }
  if (generatedSize > MAX_GENERATED_DATA) ctx.addIssue({ code: 'custom', path: ['objects'], message: 'Generated mesh data exceeds the mobile project limit.' });
  if (cells > MAX_PHOTO_CELLS) ctx.addIssue({ code: 'custom', path: ['objects'], message: 'Too many photo model cells for a mobile project.' });
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
export type ObjectCategory = z.infer<typeof objectCategorySchema>;
export type ObjectMeta = z.infer<typeof objectMetaSchema>;
export type PathStyle = z.infer<typeof pathStyleSchema>;
export type FenceStyle = z.infer<typeof fenceStyleSchema>;

export type PrimitiveObject = z.infer<typeof primitiveObjectSchema>;
export type TreeObject = z.infer<typeof treeObjectSchema>;
export type RockObject = z.infer<typeof rockObjectSchema>;
export type BuildingObject = z.infer<typeof buildingObjectSchema>;
export type LanternObject = z.infer<typeof lanternObjectSchema>;
export type PathObject = z.infer<typeof pathObjectSchema>;
export type RiverObject = z.infer<typeof riverObjectSchema>;
export type FenceObject = z.infer<typeof fenceObjectSchema>;
export type FieldObject = z.infer<typeof fieldObjectSchema>;
export type BridgeObject = z.infer<typeof bridgeObjectSchema>;
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
