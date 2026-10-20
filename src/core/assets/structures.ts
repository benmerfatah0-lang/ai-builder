import type {
  BridgeObject,
  BuildingObject,
  FenceObject,
  FieldObject,
  FenceStyle,
  PathObject,
  PathStyle,
  RiverObject,
} from '../world-plan/schema';
import { createMeta } from '../world-plan/objectMeta';
import { createTransform } from '../world-plan/factory';
import { createId } from '../utils/id';
import type { Rng } from '../generation/rng';

/**
 * Factories for the Phase 3 scene pieces (fields, fences, paths, rivers,
 * bridges). They live next to the asset catalog so the editor library and the
 * procedural planner build identical objects from the same code path.
 *
 * Every factory returns a schema-valid `WorldObject` whose `transform.position`
 * locates the object's local origin on the terrain. Polyline objects
 * (`path`, `river`, `fence`) keep their points in local space.
 */

type Vec3 = [number, number, number];

/** Axis-aligned extent of a polyline, used as the object's base dimensions. */
function spanDimensions(
  points: readonly Vec3[],
  width: number,
  height: number,
): [number, number, number] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minZ = Math.min(minZ, point[2]);
    maxZ = Math.max(maxZ, point[2]);
  }
  const spanX = Number.isFinite(minX) ? Math.max(1, maxX - minX + width) : width;
  const spanZ = Number.isFinite(minZ) ? Math.max(1, maxZ - minZ + width) : width;
  return [spanX, Math.max(0.05, height), spanZ];
}

function baseObject(name: string, position: Vec3) {
  return {
    id: createId('obj'),
    name,
    parentId: null,
    transform: createTransform(position),
    visible: true,
    locked: false,
  };
}

export interface PathOptions {
  name?: string;
  style?: PathStyle;
  width?: number;
  color?: string;
  region?: string;
}

/** Ribbon of dirt/stone that hugs the terrain under it. */
export function createPath(
  points: Vec3[],
  position: Vec3,
  options: PathOptions = {},
): PathObject {
  const style = options.style ?? 'dirt';
  const width = options.width ?? 2.4;
  return {
    ...baseObject(options.name ?? 'Dirt path', position),
    kind: 'path',
    points: points.map((point) => [...point] as Vec3),
    width,
    color:
      options.color ??
      (style === 'stone' ? '#9d9689' : style === 'gravel' ? '#b3aa96' : '#a68a63'),
    style,
    meta: createMeta({
      category: 'path',
      geometry: `path.${style}`,
      dimensions: spanDimensions(points, width, 0.08),
      role: 'route',
      region: options.region,
      avoidOverlap: false,
      collision: false,
    }),
  };
}

export interface RiverOptions {
  name?: string;
  width?: number;
  color?: string;
  region?: string;
}

export function createRiver(
  points: Vec3[],
  position: Vec3,
  options: RiverOptions = {},
): RiverObject {
  const width = options.width ?? 4.2;
  return {
    ...baseObject(options.name ?? 'River', position),
    kind: 'river',
    points: points.map((point) => [...point] as Vec3),
    width,
    color: options.color ?? '#4f7f96',
    meta: createMeta({
      category: 'water',
      geometry: 'water.river',
      dimensions: spanDimensions(points, width, 0.1),
      role: 'watercourse',
      region: options.region,
      avoidOverlap: false,
      collision: false,
    }),
  };
}

export interface FenceOptions {
  name?: string;
  style?: FenceStyle;
  height?: number;
  postColor?: string;
  railColor?: string;
  region?: string;
}

export function createFence(
  points: Vec3[],
  position: Vec3,
  options: FenceOptions = {},
): FenceObject {
  const style = options.style ?? 'wood';
  return {
    ...baseObject(options.name ?? 'Fence', position),
    kind: 'fence',
    points: points.map((point) => [...point] as Vec3),
    height: options.height ?? 1.15,
    style,
    postColor: options.postColor ?? (style === 'stone' ? '#9a9287' : '#8a6a45'),
    railColor: options.railColor ?? (style === 'stone' ? '#a8a094' : '#a8845c'),
    meta: createMeta({
      category: 'fence',
      geometry: `fence.${style}`,
      dimensions: spanDimensions(points, 0.24, options.height ?? 1.15),
      role: 'boundary',
      region: options.region,
      avoidOverlap: false,
    }),
  };
}

export interface FieldOptions {
  name?: string;
  rows?: number;
  density?: number;
  cropColor?: string;
  soilColor?: string;
  region?: string;
  rotationY?: number;
}

/** Rectangular crop field; the scene builder fills it with instanced stalks. */
export function createField(
  width: number,
  depth: number,
  position: Vec3,
  rng: Rng,
  options: FieldOptions = {},
): FieldObject {
  const seed = Math.floor(rng() * 0xffffffff);
  return {
    ...baseObject(options.name ?? 'Wheat field', position),
    kind: 'field',
    width,
    depth,
    rows: options.rows ?? Math.max(4, Math.round(depth / 1.6)),
    density: options.density ?? 0.9,
    cropColor: options.cropColor ?? '#d9b45b',
    soilColor: options.soilColor ?? '#7b5f42',
    seed,
    transform: {
      ...createTransform(position),
      rotation: [0, options.rotationY ?? 0, 0] as Vec3,
    },
    meta: createMeta({
      category: 'field',
      geometry: 'field.wheat',
      dimensions: [width, 1.1, depth],
      role: 'crop',
      region: options.region,
      seed,
      avoidOverlap: false,
      collision: false,
    }),
  };
}

export interface BridgeOptions {
  name?: string;
  width?: number;
  deckColor?: string;
  railColor?: string;
  region?: string;
  rotationY?: number;
}

export function createBridge(
  length: number,
  position: Vec3,
  options: BridgeOptions = {},
): BridgeObject {
  return {
    ...baseObject(options.name ?? 'Bridge', position),
    kind: 'bridge',
    length,
    width: options.width ?? 3,
    deckColor: options.deckColor ?? '#9a7649',
    railColor: options.railColor ?? '#7c5c38',
    transform: {
      ...createTransform(position),
      rotation: [0, options.rotationY ?? 0, 0] as Vec3,
    },
    meta: createMeta({
      category: 'structure',
      geometry: 'structure.bridge',
      dimensions: [options.width ?? 3, 1.5, length],
      role: 'crossing',
      region: options.region,
      anchor: 'water',
    }),
  };
}

/** Barn: tall gabled volume with a loft door, lean-to and hay bales. */
export function createBarn(
  position: Vec3,
  rng: Rng,
  color = '#a4503f',
  roofColor = '#5b4436',
): BuildingObject {
  return {
    ...baseObject('Barn', position),
    kind: 'building' as const,
    variant: 'barn' as const,
    color,
    roofColor,
    transform: {
      ...createTransform(position),
      rotation: [0, Math.floor(rng() * 4) * (Math.PI / 2), 0] as Vec3,
      scale: [1, 1, 1] as Vec3,
    },
    meta: createMeta({
      category: 'structure',
      geometry: 'building.barn',
      dimensions: [6.2, 5.4, 7.4],
      role: 'barn',
    }),
  };
}

/** Chicken coop: small shed, pitched roof, ramp and fenced run. */
export function createCoop(
  position: Vec3,
  rng: Rng,
  color = '#c9b18b',
  roofColor = '#7a4d3c',
): BuildingObject {
  return {
    ...baseObject('Chicken coop', position),
    kind: 'building' as const,
    variant: 'coop' as const,
    color,
    roofColor,
    transform: {
      ...createTransform(position),
      rotation: [0, Math.floor(rng() * 4) * (Math.PI / 2), 0] as Vec3,
      scale: [1, 1, 1] as Vec3,
    },
    meta: createMeta({
      category: 'structure',
      geometry: 'building.coop',
      dimensions: [2.6, 2.4, 2.8],
      role: 'coop',
    }),
  };
}

/** Low silo cylinder beside a barn. */
export function createSilo(
  position: Vec3,
  rng: Rng,
  color = '#b9b3a4',
  roofColor = '#7d6a58',
): BuildingObject {
  return {
    ...baseObject('Silo', position),
    kind: 'building' as const,
    variant: 'tower' as const,
    color,
    roofColor,
    transform: {
      ...createTransform(position),
      scale: [0.55, 0.62, 0.55] as Vec3,
      rotation: [0, Math.floor(rng() * 4) * (Math.PI / 2), 0] as Vec3,
    },
    meta: createMeta({
      category: 'structure',
      geometry: 'structure.silo',
      dimensions: [2.1, 4.8, 2.1],
      role: 'silo',
    }),
  };
}
