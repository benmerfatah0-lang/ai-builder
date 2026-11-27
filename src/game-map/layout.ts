import type { ArenaDef, BuildingSpec, CircleFence, FieldSpec, FenceRun, Vec2, WorldWater } from './types';

/**
 * The one description of where things physically stand.
 *
 * Two very different consumers need it: the scatter pass (so a grass tuft never
 * sprouts through a barn door) and the content test (so a landmark never lands
 * inside an arena). They used to keep separate hand-written coordinate tables,
 * which drifted the moment the map was re-laid out: a scatter that still
 * remembered the old barn position would grow tufts inside the new one, and the
 * test happily passed because it was reading the old numbers too.
 *
 * Everything here is derived from the specs themselves, so moving a building in
 * `data.ts` moves its clearance with it.
 */

/**
 * Every authored coordinate is multiplied by this before it reaches the scene.
 *
 * The valley is a 660-unit disc of ground. The farm used to occupy a 240x300
 * rectangle in the middle of it, which from the bird's-eye camera read as a
 * small patch on a very large lawn - "empty" was the right word for it. The
 * farm is the subject; the valley is the backdrop. Scaling the whole scene by
 * 1.6 doubles the ground the same content covers, which both spreads the bands
 * out and pushes the treeline out of the middle distance.
 */
export const WORLD_SCALE = 1.6;

/** The walkable rectangle, after scaling. */
export const ARENA = {
  minX: -148 * WORLD_SCALE,
  maxX: 148 * WORLD_SCALE,
  minZ: -186 * WORLD_SCALE,
  maxZ: 184 * WORLD_SCALE,
};

/** How far outside the authored rectangle the scatter is allowed to wander. */
export const SCATTER_MARGIN = 30;

/** Scatter density multiplier. One constant so the density can be tuned in one place. */
export const DETAIL = 15;

/**
 * Point-in-polygon, the same convention the renderer's region tint uses.
 */
export function insidePolygon(x: number, z: number, polygon: Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, zi] = polygon[index]!;
    const [xp, zp] = polygon[previous]!;
    if (zi > z !== zp > z && x < ((xp - xi) * (z - zi)) / (zp - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface Rect {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  rotation: number;
}

/** Footprint of each building kind at scale 1, in the kind's local XZ frame. */
const BUILDING_FOOTPRINT: Record<string, [number, number]> = {
  farmhouse: [9, 7],
  barn: [8.5, 6.5],
  silo: [3.4, 3.4],
  shed: [4.2, 3.6],
  stable: [7.5, 5],
  market: [3.6, 3.6],
  well: [2.8, 2.8],
  tower: [3.2, 3.2],
  windmill: [4.4, 4.4],
  sheepShelter: [6.5, 4.6],
  duckHouse: [4.6, 4.2],
  nursery: [3.8, 3.4],
  henPalace: [9, 7.5],
  dogHouse: [2, 1.8],
  threshingGranary: [7, 5.5],
  gatehouse: [6, 4],
  scarecrowShed: [3.6, 3.2],
};

/** A generous disc around each building, for scatter rejection. */
export function buildingClearance(buildings: BuildingSpec[]): [number, number, number][] {
  return buildings.map((building) => {
    const [w, d] = BUILDING_FOOTPRINT[building.kind] ?? [5, 5];
    const scale = (building.scale ?? 1) * WORLD_SCALE;
    const radius = (Math.hypot(w, d) / 2) * scale + 3.2;
    return [building.position[0] * WORLD_SCALE, building.position[1] * WORLD_SCALE, radius] as [
      number,
      number,
      number,
    ];
  });
}

/** The floor disc of each arena, padded so scatter keeps off the fighting ground. */
export function arenaClearance(arenas: ArenaDef[]): [number, number, number][] {
  return arenas.map(
    (arena) =>
      [arena.position[0] * WORLD_SCALE, arena.position[1] * WORLD_SCALE, (arena.radius + 4) * WORLD_SCALE] as [
        number,
        number,
        number,
      ],
  );
}

/** Axis-aligned bounding box of a field, in world units. */
export function fieldRect(field: FieldSpec): Rect {
  return {
    id: `${field.kind}-${field.x}-${field.z}`,
    x: field.x * WORLD_SCALE,
    z: field.z * WORLD_SCALE,
    w: field.w * WORLD_SCALE,
    d: field.d * WORLD_SCALE,
    rotation: field.rotation ?? 0,
  };
}

/**
 * The fenced paddocks, as boxes.
 *
 * A fence run is a polyline; the paddocks in this map are drawn as closed
 * rectangles, so the box they enclose is just the bounds of their points. That
 * is what the critters roam inside and what the scatter must not cross.
 */
export function fenceRects(fences: FenceRun[]): Rect[] {
  const rects: Rect[] = [];
  for (const fence of fences) {
    if (fence.points.length < 4) continue;
    const xs = fence.points.map((point) => point[0]);
    const zs = fence.points.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const w = (maxX - minX) * WORLD_SCALE;
    const d = (maxZ - minZ) * WORLD_SCALE;
    // Only real enclosures become rects; the long band rails and boundary runs
    // are lines, not pens, and their "bounds" would cover half the valley.
    if (w < 12 || d < 12) continue;
    rects.push({
      id: fence.id,
      x: ((minX + maxX) / 2) * WORLD_SCALE,
      z: ((minZ + maxZ) / 2) * WORLD_SCALE,
      w,
      d,
      rotation: 0,
    });
  }
  return rects;
}

/** Disc enclosures (hen runs, the ram ring). */
export function circleRects(fences: CircleFence[]): { x: number; z: number; r: number }[] {
  return fences.map((fence) => ({
    x: fence.center[0] * WORLD_SCALE,
    z: fence.center[1] * WORLD_SCALE,
    r: fence.radius * WORLD_SCALE,
  }));
}

/** True when a world-space point is inside a rotated rectangle, with a margin. */
export function insideRect(x: number, z: number, rect: Rect, margin = 0): boolean {
  const cos = Math.cos(-rect.rotation);
  const sin = Math.sin(-rect.rotation);
  const dx = x - rect.x;
  const dz = z - rect.z;
  const localX = dx * cos - dz * sin;
  const localZ = dx * sin + dz * cos;
  return Math.abs(localX) <= rect.w / 2 + margin && Math.abs(localZ) <= rect.d / 2 + margin;
}

/** True when a point is inside any of the rectangles. */
export function insideAnyRect(x: number, z: number, rects: Rect[], margin = 0): boolean {
  return rects.some((rect) => insideRect(x, z, rect, margin));
}

/**
 * Whether a scatter prop may stand at (x, z).
 *
 * `spread` exists because different props need different room: a grass tuft can
 * sit a little closer to a wall than a boulder can. Callers pass the radius they
 * want kept clear on top of the authored footprints.
 */
export function isOpenGround(
  x: number,
  z: number,
  options: {
    arenas: [number, number, number][];
    buildings: [number, number, number][];
    rects: Rect[];
    circles: { x: number; z: number; r: number }[];
    roads: { points: Vec2[]; width: number }[];
    spread?: number;
  },
): boolean {
  const spread = options.spread ?? 0;
  if (options.arenas.some(([ax, az, ar]) => Math.hypot(x - ax, z - az) < ar + spread)) return false;
  if (options.buildings.some(([bx, bz, br]) => Math.hypot(x - bx, z - bz) < br + spread)) return false;
  if (insideAnyRect(x, z, options.rects, spread)) return false;
  if (options.circles.some((circle) => Math.hypot(x - circle.x, z - circle.z) < circle.r + spread)) return false;
  if (nearAnyRoad(x, z, options.roads, spread)) return false;
  return true;
}

/** Distance from a point to a polyline. */
export function distanceToPolyline(x: number, z: number, points: Vec2[]): number {
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const lengthSq = abx * abx + abz * abz || 1;
    let t = ((x - a[0]) * abx + (z - a[1]) * abz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - (a[0] + abx * t), z - (a[1] + abz * t)));
  }
  return best;
}

function nearAnyRoad(x: number, z: number, roads: { points: Vec2[]; width: number }[], spread: number): boolean {
  return roads.some((road) => distanceToPolyline(x, z, scaleRoad(road).points) < (road.width * WORLD_SCALE) / 2 + 1.6 + spread);
}

/** Scale a road polyline into world space. */
export function scaleRoad(road: { points: Vec2[]; width: number }): { points: Vec2[]; width: number } {
  return {
    width: road.width * WORLD_SCALE,
    points: road.points.map((point) => [point[0] * WORLD_SCALE, point[1] * WORLD_SCALE] as Vec2),
  };
}

/** Scale the whole hydrology into world space. */
export function scaleWater(water: WorldWater): WorldWater {
  return {
    river: water.river.map((point) => [point[0] * WORLD_SCALE, point[1] * WORLD_SCALE] as Vec2),
    riverWidth: water.riverWidth * WORLD_SCALE,
    canal: water.canal.map((point) => [point[0] * WORLD_SCALE, point[1] * WORLD_SCALE] as Vec2),
    canalWidth: water.canalWidth * WORLD_SCALE,
    pond: { x: water.pond.x * WORLD_SCALE, z: water.pond.z * WORLD_SCALE, r: water.pond.r * WORLD_SCALE },
  };
}
