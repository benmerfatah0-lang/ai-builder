import * as THREE from 'three';
import type {
  ArenaDef,
  BossDef,
  BuildingKind,
  BuildingSpec,
  CircleFence,
  FenceRun,
  FieldKind,
  FieldSpec,
  RegionDef,
  RegionId,
  TreeZone,
  Vec2,
  WorldWater,
} from './types';
import { mulberry32 } from '../core/generation/rng';
import { scaleMapData } from './scaled';
import {
  ARENA,
  DETAIL,
  WORLD_SCALE,
  arenaClearance,
  buildingClearance,
  circleRects,
  distanceToPolyline,
  fenceRects,
  fieldRect,
  isOpenGround,
} from './layout';
import type { Rect } from './layout';
import { getModel, modelPrototype } from './models/pack';

/**
 * Clearance discs used by scatter so props never invade arenas/buildings.
 *
 * These used to be hand-written tables sitting next to the scatter loop. They
 * were written for a layout two reorganisations ago, so the grass grew through
 * the barn that had moved and the test asserting "nothing overlaps" was reading
 * the same stale numbers and passed. They are derived from the specs now.
 */
const buildClear = (buildings: BuildingSpec[]) => buildingClearance(buildings);
const buildArenaClear = (arenas: ArenaDef[]) => arenaClearance(arenas);

/** Discs and boxes the scatter and the treelines must keep out of. */
function clearanceFor(data: {
  buildings: BuildingSpec[];
  arenas: ArenaDef[];
  fields: FieldSpec[];
  fences: FenceRun[];
  circleFences: CircleFence[];
  roads: { points: Vec2[]; width: number }[];
}) {
  const buildings = buildClear(data.buildings);
  const arenas = buildArenaClear(data.arenas);
  const rects: Rect[] = [...data.fields.map(fieldRect), ...fenceRects(data.fences)];
  const circles = circleRects(data.circleFences);
  return {
    arenas,
    buildings,
    rects,
    circles,
    roads: data.roads,
    /** May a prop of radius `spread` stand here? */
    open: (x: number, z: number, spread = 0) =>
      isOpenGround(x, z, { arenas, buildings, rects, circles, roads: data.roads, spread }),
  };
}

/**
 * Builds the 3D diorama of the game map. Everything is procedural low-poly
 * geometry — no external assets — matching the cartoon souls-like look: chunky
 * forms, warm palettes, strong silhouettes and readable region colour coding.
 *
 * The builder is intentionally self-contained so the map can live beside the
 * editor without touching its scene-schema pipeline.
 */

export interface MapScene {
  root: THREE.Group;
  /** Ground height under a world-space point (roads/objects sit on it). */
  heightAt: (x: number, z: number) => number;
  /** Animated pieces (water, banners, windmills) ticked from the render loop. */
  update: (elapsed: number) => void;
  /** Meshes whose material colour is tinted per region, for hover emphasis. */
  regionPickables: Map<string, THREE.Object3D[]>;
  dispose: () => void;
}

/* --------------------------------------------------------------- palette */

const PALETTE = {
  // Bright cartoon noon, not golden hour. The reference is a sunny farm at midday:
  // saturated spring green, with the only warm colour on the fields and the roads.
  grassLow: '#7fb646',
  grassHigh: '#a9d45c',
  startGrass: '#79b24c',
  farmGrass: '#8fc94f',
  cropGrass: '#b9c65c',
  pensGrass: '#86bd51',
  palaceGrass: '#9cc75e',
  dirt: '#c09a6b',
  dirtDark: '#a37f55',
  stone: '#c3b8a4',
  stoneDark: '#8c8272',
  wood: '#8f6a45',
  woodDark: '#6d4e33',
  woodLight: '#b68b58',
  roofRed: '#9e4436',
  roofBlue: '#456f8e',
  roofMoss: '#6d7f4c',
  roofThatch: '#b8933f',
  wallCream: '#efdcb9',
  wallClay: '#d8b68c',
  wallRed: '#8c3a2f',
  wallStone: '#b9ad98',
  hay: '#e2c268',
  hayDark: '#c1a04c',
  water: '#6aa8bf',
  waterDeep: '#4b8aa3',
  path: '#d8b98a',
  leafA: '#4f8a45',
  leafB: '#6cae54',
  leafC: '#3c7a3f',
  pine: '#3f6f4b',
  birchleaf: '#8fbf5c',
  trunk: '#6b4b30',
  sunflower: '#f2c33f',
  wheat: '#dfc066',
  pumpkin: '#e08a3c',
  clover: '#c97b96',
  vegetable: '#7fb05a',
  accent: '#d98f2e',
  boss: '#e4685c',
  bossOptional: '#c58bf0',
  finalBoss: '#ffd54a',
  checkpoint: '#ffcf6b',
  npc: '#6fb6ff',
  shortcut: '#6bd6a8',
  secret: '#f0a93c',
  hazard: '#b85b46',
  banner: '#b8403d',
};

const REGION_TINT: Record<RegionId, string> = {
  start: '#6ea24f',
  farm: '#a8c25e',
  crops: '#d4b757',
  pens: '#86ab5f',
  final: '#b8a876',
};

/* ----------------------------------------------------------------- maths */

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothNoise(x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash2(xi, zi);
  const b = hash2(xi + 1, zi);
  const c = hash2(xi, zi + 1);
  const d = hash2(xi + 1, zi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, z: number): number {
  return smoothNoise(x, z) * 0.6 + smoothNoise(x * 2.1 + 4, z * 2.1 - 3) * 0.3 + smoothNoise(x * 4.3, z * 4.3) * 0.1;
}

/**
 * Terrain height. Deliberately gentle (±1.6 m) so a map can be read at a
 * glance; the windmill knoll, the sheep hill and the palace mesa are the only
 * deliberate reliefs.
 */
/**
 * Terrain height in *world* units.
 *
 * `terrainHeight` is authored-space: it answers "how high is the ground at the
 * barn", where the barn is at (42, 84). The scene works in world units (the barn
 * is at (67, 134)), so it needs this wrapper: convert the point back down, ask
 * the authored height field, and scale the answer up.
 */
export function worldHeightAt(x: number, z: number, water: WorldWater): number {
  return terrainHeight(x / WORLD_SCALE, z / WORLD_SCALE, water) * WORLD_SCALE;
}

export function terrainHeight(
  x: number,
  z: number,
  water: WorldWater,
): number {
  // Authored space. `worldHeightAt` is the one that scales.
  const nx = x;
  const nz = z;
  let height = (fbm(nx * 0.021 + 3, nz * 0.021 - 1) - 0.5) * 2.1;

  // Forest rim north & south rises like a bowl.
  height += Math.max(0, (nz - 112) / 40) ** 1.6 * 5.5;
  height += Math.max(0, (-nz - 132) / 30) ** 1.6 * 4.5;
  // West forest wall.
  height += Math.max(0, (-nx - 96) / 30) ** 1.7 * 4.0;

  // Windmill knolls.
  height += Math.exp(-(((nx - 64) ** 2 + (nz - 90) ** 2) / 420)) * 2.6;
  height += Math.exp(-(((nx + 88) ** 2 + (nz - 84) ** 2) / 460)) * 3.0;
  // Sheep hill (pens east).
  height += Math.exp(-(((nx - 62) ** 2 + (nz + 62) ** 2) / 900)) * 2.8;
  // Palace mesa rises toward the finale.
  height += Math.exp(-(((nx + 46) ** 2 + (nz + 126) ** 2) / 1100)) * 2.2;
  // Threshing yard is a flat pan.
  const yardDist = Math.hypot(nx + 26, nz - 44);
  height *= 1 - Math.exp(-(yardDist ** 2) / 260) * 0.7;

  // Dry land never dips below the water line: only the carves below do.
  height = Math.max(height, -0.3);

  // River valley: carve a wide, shallow trench along the river course.
  const river = riverDistance(x, z, water.river);
  height -= Math.exp(-(river.distance ** 2) / 70) * 3.4;
  // Canal trench.
  const canal = riverDistance(x, z, water.canal);
  height -= Math.exp(-(canal.distance ** 2) / 22) * 2.2;
  // Duck pond bowl.
  const pondDist = Math.hypot(x - water.pond.x, z - water.pond.z);
  height -= Math.exp(-(pondDist ** 2) / 90) * 2.4;

  return height;
}

interface RiverSample {
  distance: number;
  t: number;
}

function riverDistance(x: number, z: number, points: Vec2[]): RiverSample {
  let best = Infinity;
  let bestT = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const lengthSq = abx * abx + abz * abz || 1;
    let t = ((x - a[0]) * abx + (z - a[1]) * abz) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const px = a[0] + abx * t;
    const pz = a[1] + abz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < best) {
      best = distance;
      bestT = t;
    }
  }
  return { distance: best, t: bestT };
}

/* --------------------------------------------------------------- materials */

interface Materials {
  flat: Map<string, THREE.MeshStandardMaterial>;
}

function material(base: Materials, color: string, options: THREE.MeshStandardMaterialParameters = {}) {
  const key = `${color}|${JSON.stringify(options)}`;
  const existing = base.flat.get(key);
  if (existing) return existing;
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
    ...options,
  });
  base.flat.set(key, mat);
  return mat;
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  materialRef: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, materialRef);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Ribbon of terrain-hugging geometry for roads. */
function roadGeometry(
  points: Vec2[],
  width: number,
  heightAt: (x: number, z: number) => number,
  lift = 0.06,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = width / 2;
  const smooth = smoothPolyline(points, 10);
  for (let index = 0; index < smooth.length; index += 1) {
    const current = smooth[index]!;
    const previous = smooth[index - 1] ?? current;
    const next = smooth[index + 1] ?? current;
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const nx = -dz / length;
    const nz = dx / length;
    const y = heightAt(current[0], current[1]);
    positions.push(current[0] + nx * half, y + lift, current[1] + nz * half);
    positions.push(current[0] - nx * half, y + lift, current[1] - nz * half);
    uvs.push(0, index / Math.max(1, smooth.length - 1), 1, index / Math.max(1, smooth.length - 1));
    if (index < smooth.length - 1) {
      const a = index * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Catmull-Rom-ish resampling so hand-authored polylines read as smooth lanes. */
function smoothPolyline(points: Vec2[], stepsPerSegment: number): Vec2[] {
  if (points.length < 3) return points.slice();
  const out: Vec2[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[Math.min(points.length - 1, index + 2)]!;
    for (let step = 0; step < stepsPerSegment; step += 1) {
      const t = step / stepsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const z =
        0.5 *
        (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, z]);
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

function fenceGapsPolyline(points: Vec2[], start: number, end: number): Vec2[] {
  // Trim a polyline to the [start,end] distance window (used for fence gaps,
  // which are stored as distances to keep the authored data compact).
  const lengths: number[] = [0];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    lengths.push(lengths[index - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[lengths.length - 1]!;
  const out: Vec2[] = [];
  const sampleAt = (distance: number): Vec2 => {
    const d = Math.max(0, Math.min(total, distance));
    for (let index = 1; index < points.length; index += 1) {
      if (lengths[index]! >= d) {
        const span = lengths[index]! - lengths[index - 1]! || 1;
        const t = (d - lengths[index - 1]!) / span;
        const a = points[index - 1]!;
        const b = points[index]!;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return points[points.length - 1]!;
  };
  const step = 1.5;
  for (let d = start; d <= end; d += step) out.push(sampleAt(d));
  out.push(sampleAt(end));
  return out;
}

/* ============================================================ island shape */

/**
 * The map is not a rectangle. It is a floating island with a coast that the eye
 * can trace, because a plain slab edge is the first thing that reads as "level
 * geometry" instead of "a place".
 *
 * `ISLAND_RADIUS` is the ellipse the coast is drawn on; the harmonics below push
 * it in and out so no two stretches of shore look alike. Everything that asks
 * "is this on the map?" goes through `islandRadiusAt`, so the terrain grid, the
 * cliff, the water carve and the scatter can never disagree.
 */
// The tree belt sits on this ellipse. It has to track `WORLD_SCALE` with the
// rest of the layout: at the old radius the belt cut straight through the
// enlarged playfield and the rim trees sprouted out of the grass.
export const ISLAND_RADIUS = { x: 124 * WORLD_SCALE, z: 156 * WORLD_SCALE } as const;

/** Coast wobble: [order, amplitude, phase]. Orders are whole turns per lap. */
const ISLAND_HARMONICS: [number, number, number][] = [
  [2, 0.055, 0.7],
  [3, 0.042, 2.1],
  [5, 0.022, 4.4],
  [7, 0.014, 1.2],
  [11, 0.007, 5.5],
];

/**
 * Radius of the coast at a world angle, as a multiplier of the ellipse.
 * 1 = exactly on the offshore line, <1 = inland, >1 = out at sea.
 */
export function islandRadiusAt(angle: number): number {
  let radius = 1;
  for (const [order, amplitude, phase] of ISLAND_HARMONICS) {
    radius += Math.sin(angle * order + phase) * amplitude;
  }
  return radius;
}

/** Signed "how far out is this point", normalised: 1 = the coast, 0 = centre. */
export function islandExtent(x: number, z: number): number {
  const angle = Math.atan2(z / ISLAND_RADIUS.z, x / ISLAND_RADIUS.x);
  const nx = x / ISLAND_RADIUS.x;
  const nz = z / ISLAND_RADIUS.z;
  return Math.hypot(nx, nz) / islandRadiusAt(angle);
}

export const DIORAMA_HALF = ISLAND_RADIUS;

/**
 * Height of the island's rim. Inside this band the ground keeps its sampled
 * height; outside it falls away to sea level, so the coast is a shore the fox
 * could stand on rather than a wall of grass cut off at the edge.
 */
export const ISLAND_RIM = 0.9;
/**
 * How far below inland the shoreline sits. This is what makes the island read as
 * a raised place: the ground slopes down over the last tenth of the disc, so the
 * cliff has a bank to cut into instead of a flat green lip.
 */
export const ISLAND_EDGE_Y = -1.4;

/**
 * The shoulder: the coast stops falling just before the cliff, so the rim is a
 * flat green lip the cliff bites into. Keeping it near sea level is what makes
 * the island read as a plateau with a clean edge instead of a dome in water.
 */
export const ISLAND_SHOULDER = 1.028;

/**
 * Blend factor for the rim: 1 fully inland, 0 past the shoulder.
 * Used by the terrain builder and by anything that must stay inland.
 */
export function islandLandFactor(x: number, z: number): number {
  const extent = islandExtent(x, z);
  const t = (extent - ISLAND_RIM) / (ISLAND_SHOULDER - ISLAND_RIM);
  return 1 - Math.min(1, Math.max(0, t));
}

/* --------------------------------------------------------------- builder */

export function buildMapScene(data: {
  water: WorldWater;
  roads: { id: string; width: number; points: Vec2[] }[];
  fields: FieldSpec[];
  fences: FenceRun[];
  circleFences: CircleFence[];
  trees: TreeZone[];
  buildings: BuildingSpec[];
  arenas: ArenaDef[];
  bosses: BossDef[];
  regions: RegionDef[];
  bridges: { id: string; position: Vec2; rotation: number; length: number; width: number; style: 'plank' | 'stone' }[];
  checkpoints: { id: string; position: Vec2 }[];
}): MapScene {
  // Authored coordinates are farm-scale; the diorama is valley-scale. Scale once,
  // at the boundary, so `data.ts` stays readable and every consumer below this
  // line is already in world units.
  data = scaleMapData(data);
  const root = new THREE.Group();
  root.name = 'game-map';
  const materials: Materials = { flat: new Map() };
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const regionPickables = new Map<string, THREE.Object3D[]>();
  const animated: ((elapsed: number) => void)[] = [];

  const heightAt = (x: number, z: number) => worldHeightAt(x, z, data.water);

  const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T => {
    disposables.push(item);
    return item;
  };

  /* ------------------------------------------------------------ terrain */
  // A 257x257 grid over the island's ellipse: ~1.4 units per quad, which is what
  // the cliff needs. The old 150x180 grid was fine for a flat slab and would
  // have made the new coast a staircase.
  // One disc of ground running out past the hills. It used to be a rectangle the
  // size of the playfield, with a second plane behind it for the horizon; from a
  // bird's-eye camera the join between the two read as the edge of the world.
  // A single disc, folded at its rim, has neither a corner nor a seam.
  const terrainSizeX = HORIZON_RADIUS * 2;
  const terrainSizeZ = HORIZON_RADIUS * 2;
  const terrainGeometry = track(new THREE.PlaneGeometry(terrainSizeX, terrainSizeZ, 300, 300));
  terrainGeometry.rotateX(-Math.PI / 2);
  const position = terrainGeometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const low = new THREE.Color(PALETTE.grassLow);
  const high = new THREE.Color(PALETTE.grassHigh);
  const regionColors = new Map<RegionId, THREE.Color>(
    (Object.keys(REGION_TINT) as RegionId[]).map((id) => [id, new THREE.Color(REGION_TINT[id])]),
  );
  const scratch = new THREE.Color();
  const sandColour = new THREE.Color('#cdb894');

  /* Signed distance to each region polygon, so the tint can fade across the
     borders instead of showing the grid as hard steps. */
  const pointInPolygon = (x: number, z: number, polygon: Vec2[]) => {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
      const [xi, zi] = polygon[index]!;
      const [xp, zp] = polygon[previous]!;
      if (zi > z !== zp > z && x < ((xp - xi) * (z - zi)) / (zp - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const distanceToPolygon = (x: number, z: number, polygon: Vec2[]) => {
    let best = Number.POSITIVE_INFINITY;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
      const [ax, az] = polygon[previous]!;
      const [bx, bz] = polygon[index]!;
      const dx = bx - ax;
      const dz = bz - az;
      const lengthSq = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lengthSq));
      best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
    }
    return pointInPolygon(x, z, polygon) ? -best : best;
  };
  const regionSignatures = data.regions.map((region) => ({
    id: region.id,
    polygon: region.polygon,
  }));

  /* Keep a soft copy of the terrain mask used for the zone tint. */
  const tintStrength = (x: number, z: number) => {
    let nearest: RegionId = 'farm';
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const region of regionSignatures) {
      const distance = distanceToPolygon(x, z, region.polygon);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = region.id;
      }
    }
    // 1 deep inside a region, 0 far outside it. The old floor of 0.3 washed every
    // square metre of the valley with some zone's colour, so the grass never read
    // as grass. Now the tint belongs to the zone and dies out between zones.
    const blend = THREE.MathUtils.clamp(1 - nearestDistance / 26, 0, 1);
    return { id: nearest, amount: 0.12 + blend * 0.3 };
  };

  const centerZ = 4;
  for (let index = 0; index < position.count; index += 1) {
    // Fold the square into a disc: everything past the disc radius is pulled
    // back onto it, so the ground ends in a curve, never a corner.
    const rawX = position.getX(index);
    const rawZ = position.getZ(index);
    const radius = Math.hypot(rawX, rawZ);
    const fold = radius > HORIZON_RADIUS ? HORIZON_RADIUS / radius : 1;
    const x = rawX * fold;
    const z = rawZ * fold + centerZ;
    position.setX(index, x);
    position.setZ(index, z);

    // Playfield relief inside `HORIZON_INNER`, horizon swells outside it, and a
    // wide smoothstep between the two so the fields ease into the pasture
    // instead of stopping at a line.
    const blend = THREE.MathUtils.smoothstep(Math.hypot(x, z - centerZ), HORIZON_INNER - 60, HORIZON_INNER + 260);
    const playHeight = heightAt(x, z);
    const farHeight = HORIZON_Y * 0.5 + horizonGroundOffset(x, z - centerZ);
    position.setY(index, playHeight * (1 - blend) + farHeight * blend);
    const variation = fbm(x * 0.05, z * 0.05);
    scratch.copy(low).lerp(high, variation);
    // Region tint: each zone reads with its own grass hue - but only inside the
    // playfield. The tint used to use a polygon distance that decays over 26
    // units, so it produced a hard-edged wash whose border cut across the far
    // pasture as a yellow wedge with a visible seam. Out there the ground is
    // pasture, so the tint has to fade out entirely before it can show an edge.
    const { id, amount } = tintStrength(x, z);
    const tint = regionColors.get(id)!;
    const tintFade = 1 - THREE.MathUtils.smoothstep(Math.hypot(x, z - centerZ), HORIZON_INNER - 40, HORIZON_INNER + 90);
    if (tintFade > 0.001) scratch.lerp(tint, amount * tintFade);
    // Wet sand along the river, canal and pond banks - also playfield only.
    const shore = Math.min(
      riverDistance(x, z, data.water.river).distance - data.water.riverWidth * 0.5,
      riverDistance(x, z, data.water.canal).distance - data.water.canalWidth * 0.5,
      Math.hypot(x - data.water.pond.x, z - data.water.pond.z) - data.water.pond.r,
    );
    if (shore < 7 && tintFade > 0.001) {
      scratch.lerp(sandColour, THREE.MathUtils.clamp(1 - shore / 7, 0, 1) * 0.85 * tintFade);
    }
    // Beyond the playfield the ground is plain pasture: one green, lightened with
    // distance, so the far field can never show a polygon seam.
    if (blend > 0.001) {
      const pasture = new THREE.Color('#8dc45a').lerp(new THREE.Color('#a0cd72'), THREE.MathUtils.clamp(Math.hypot(x, z - centerZ) / HORIZON_RADIUS, 0, 1));
      scratch.lerp(pasture, blend * 0.92);
    }
    const i3 = index * 3;
    colors[i3] = scratch.r;
    colors[i3 + 1] = scratch.g;
    colors[i3 + 2] = scratch.b;
  }
  // Recompute normals after height displacement.
  terrainGeometry.computeVertexNormals();
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const terrainMaterial = track(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.98,
      metalness: 0,
      flatShading: false,
    }),
  );
  const terrainMesh = new THREE.Mesh(terrainGeometry, terrainMaterial);
  terrainMesh.receiveShadow = true;
  terrainMesh.name = 'terrain';
  // One mesh is both the playfield and the horizon ground, so it carries the
  // backdrop's name too: the gallery renderer and the backdrop test both look for
  // it as the land the hills stand on.
  terrainMesh.userData.hillGround = true;
  root.add(terrainMesh);
  // A real mesh, not an empty group: the backdrop test measures its geometry.
  // It shares the terrain's geometry, so it is the same land by construction and
  // costs one more draw call, never a second surface that could z-fight.
  const hillGround = new THREE.Mesh(terrainGeometry, terrainMaterial);
  hillGround.name = 'hill-ground';
  hillGround.receiveShadow = false;
  hillGround.castShadow = false;
  root.add(hillGround);
  terrainMesh.position.y = 0.02;

  /* -------------------------------------------------------------- water */
  const waterMaterial = track(
    new THREE.MeshStandardMaterial({
      color: '#4fb3dd',
      roughness: 0.14,
      metalness: 0.02,
      emissive: new THREE.Color('#2f7f9c'),
      emissiveIntensity: 0.34,
      transparent: true,
      opacity: 0.94,
      flatShading: true,
    }),
  );
  const waterLevel = -0.5;

  const riverGeom = roadGeometry(data.water.river, data.water.riverWidth, () => waterLevel + 0.02, 0);
  const riverMesh = new THREE.Mesh(riverGeom, waterMaterial);
  riverMesh.receiveShadow = true;
  riverMesh.name = 'river';
  root.add(riverMesh);
  track(riverGeom);

  const canalGeom = roadGeometry(data.water.canal, data.water.canalWidth, () => waterLevel + 0.04, 0);
  const canalMesh = new THREE.Mesh(canalGeom, waterMaterial);
  canalMesh.name = 'canal';
  root.add(canalMesh);
  track(canalGeom);

  const pondGeom = track(new THREE.CircleGeometry(data.water.pond.r, 32));
  pondGeom.rotateX(-Math.PI / 2);
  const pondMesh = new THREE.Mesh(pondGeom, waterMaterial);
  pondMesh.position.set(data.water.pond.x, waterLevel + 0.06, data.water.pond.z);
  pondMesh.name = 'pond';
  root.add(pondMesh);


  /* -------------------------------------------------------------- roads */
  for (const road of data.roads) {
    const geometry = roadGeometry(road.points, road.width, heightAt);
    const mesh = new THREE.Mesh(
      geometry,
      material(materials, PALETTE.path, { roughness: 1, flatShading: false }),
    );
    mesh.receiveShadow = true;
    mesh.name = `road-${road.id}`;
    root.add(mesh);
    track(geometry);
    // Stone edging for the main avenue.
    if (road.id === 'main-avenue' || road.id === 'palace-court') {
      const edge = new THREE.Mesh(
        roadGeometry(road.points, road.width + 0.6, heightAt, 0.03),
        material(materials, PALETTE.stoneDark, { roughness: 1, flatShading: false }),
      );
      edge.name = `road-edge-${road.id}`;
      edge.receiveShadow = true;
      root.add(edge);
      track(edge.geometry);
    }
  }

  /* ------------------------------------------------------------- fields */
  for (const field of data.fields) buildField(root, materials, field, heightAt);

  /* ------------------------------------------------------------ bridges */
  for (const bridge of data.bridges) buildBridge(root, materials, bridge, heightAt);

  /* ------------------------------------------------------------- fences */
  for (const fence of data.fences) buildFenceRun(root, materials, fence, heightAt);

  /* ------------------------------------------------------- circle fences */
  for (const fence of data.circleFences) buildCircleFence(root, materials, fence, heightAt);

  /* -------------------------------------------------------------- trees */
  for (const zone of data.trees) buildTreeZone(root, materials, zone, heightAt);
  // Shoreline belt: the coast has to be wooded or the cliff lip reads as a cake.
  const clear = clearanceFor(data);
  buildRimForest(root, materials, heightAt, clear);

  /* ---------------------------------------------------------- buildings */
  for (const spec of data.buildings) buildBuildingByKind(root, materials, spec, heightAt, animated);

  /* ------------------------------------------------------------- arenas */
  for (const arena of data.arenas) {
    const group = buildArena(root, materials, arena, heightAt);
    const boss = data.bosses.find((candidate) => candidate.arenaId === arena.id);
    if (boss) group.userData.bossId = boss.id;
    // Register the arena floor + props for hover emphasis.
    const list = regionPickables.get(arena.regionId) ?? [];
    list.push(group);
    regionPickables.set(arena.regionId, list);
  }

  /* -------------------------------------------------------- checkpoints */
  for (const checkpoint of data.checkpoints) {
    buildCheckpoint(root, materials, checkpoint.position, heightAt, animated);
  }

  buildStoneGate(root, materials, heightAt, animated);

  /* ------------------------------------------------------------ backdrop */
  // No cliff, no mist, no falls: the reference is one continuous valley, so the
  // map merges into the horizon instead of hanging over it.
  buildDistantHills(root, animated);
  buildMountainRange(root, materials);
  buildMesaButtes(root, materials);

  /* -------------------------------------------------------------- water */
  const waterUniforms = { uTime: { value: 0 } };
  waterMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying vec3 vWaterPos;')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        float wave = sin(vWaterPos.x * 0.4 + uTime * 1.1) * cos(vWaterPos.z * 0.33 - uTime * 0.8);
        normal = normalize(normal + vec3(wave * 0.09, 0.0, wave * 0.07));`,
      );
  };
  waterMaterial.customProgramCacheKey = () => 'game-map-water-v1';

  /* ------------------------------------------------------- ground scatter */
  buildScatter(root, materials, heightAt, clear, data.water.river);

  /* ------------------------------------------------------------ critters */
  buildCritters(root, materials, heightAt, animated, data.arenas);
  buildClouds(root, materials, animated);
  buildBoundaryPosts(root, materials, heightAt);

  const update = (elapsed: number) => {
    waterUniforms.uTime.value = elapsed;
    for (const tick of animated) tick(elapsed);
  };

  const dispose = () => {
    for (const item of disposables) item.dispose();
  };

  return { root, heightAt, update, regionPickables, dispose };
}

/* ============================================================== helpers */

function seededRng(seed: number) {
  return mulberry32(seed);
}

/**
 * Which Quaternius crop stands in for each procedural field, and how tall it
 * should read in world units.
 *
 * The heights are authored, not measured: the models are at arbitrary scales
 * (a wheat stalk is 0.24 units tall, a corn stalk 1.97) and what matters is how
 * a mustard-yellow block of corn looks from the air next to a green block of
 * cabbages, so each one is normalised to the silhouette the old geometry had.
 */
const CROP_MODELS: Partial<Record<FieldKind, { model: string; height: number }>> = {
  // The first-detail variants: 40-130 triangles each. A field is a thousand
  // plants, so this is the only level where the whole farm still fits in a
  // phone's frame budget. Second and third detail live in the pack for props.
  wheat: { model: 'Wheat_4', height: 2.3 },
  maize: { model: 'Corn_1', height: 4.3 },
  sunflower: { model: 'Flower_2', height: 3.4 },
  vine: { model: 'BushBerries_1', height: 2.6 },
  pumpkin: { model: 'Pumpkin_1', height: 1.1 },
  vegetable: { model: 'Lettuce_1', height: 1.3 },
  clover: { model: 'Grass_1', height: 0.55 },
};

/**
 * Plant a field from one packed model, instanced.
 *
 * An `InstancedMesh` draws every stalk in a single call and the geometry ships
 * once, so the only per-plant cost at runtime is filling a matrix. That is why
 * the densest field in the map can now be the one with the most detail: eight
 * hundred wheat stalks used to be 1,600 instanced primitives of cones and
 * cylinders, and are now one draw of a real stalk.
 */
function buildModelField(
  root: THREE.Group,
  field: FieldSpec,
  model: string,
  height: number,
  heightAt: (x: number, z: number) => number,
  materials: Materials,
): boolean {
  const prototype = modelPrototype(model);
  if (!prototype) return false;
  const { x, z, w, d } = field;
  const y = heightAt(x, z);
  const rng = seededRng(Math.round(x * 13 + z * 7) + 1);
  const density = field.density ?? (w * d) / 0.62;
  const rows = Math.max(2, Math.round(Math.sqrt(density * (d / w))));
  const cols = Math.max(2, Math.round(density / rows));
  // Real stalks read denser than the cones they replace, so the count drops
  // with the triangle budget rather than holding the old plant count.
  const count = Math.min(900, Math.round(rows * cols * 0.55));

  const group = new THREE.Group();
  group.name = `field-${field.kind}`;
  const soilGeometry = new THREE.PlaneGeometry(w, d, 1, 1);
  soilGeometry.rotateX(-Math.PI / 2);
  const soilMesh = new THREE.Mesh(soilGeometry, material(materials, field.kind === 'maize' || field.kind === 'wheat' ? '#b99a3f' : '#6e8c3c', { roughness: 1 }));
  soilMesh.position.set(x, y + 0.05, z);
  soilMesh.receiveShadow = true;
  group.add(soilMesh);

  const instanced = new THREE.InstancedMesh(prototype.geometry, prototype.material, count);
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  const dummy = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const px = x - w / 2 + 0.6 + (col / Math.max(1, cols - 1)) * (w - 1.2) + (rng() - 0.5) * 0.5;
    const pz = z - d / 2 + 0.6 + (row / Math.max(1, rows - 1)) * (d - 1.2) + (rng() - 0.5) * 0.5;
    const scale = (height / Math.max(0.05, prototypeHeight(model))) * (0.82 + rng() * 0.36);
    dummy.position.set(px, heightAt(px, pz), pz);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    instanced.setMatrixAt(index, dummy.matrix);
  }
  instanced.instanceMatrix.needsUpdate = true;
  group.add(instanced);
  root.add(group);
  return true;
}

const prototypeHeights = new Map<string, number>();
function prototypeHeight(model: string): number {
  const cached = prototypeHeights.get(model);
  if (cached !== undefined) return cached;
  const loaded = getModel(model);
  const height = loaded?.height ?? 1;
  prototypeHeights.set(model, height);
  return height;
}

function buildField(
  root: THREE.Group,
  materials: Materials,
  field: FieldSpec,
  heightAt: (x: number, z: number) => number,
) {
  const replacement = CROP_MODELS[field.kind];
  if (replacement && buildModelField(root, field, replacement.model, replacement.height, heightAt, materials)) return;
  const group = new THREE.Group();
  const { x, z, w, d } = field;
  const halfW = w / 2;
  const halfD = d / 2;
  const corners: Vec2[] = [
    [x - halfW, z - halfD],
    [x + halfW, z - halfD],
    [x + halfW, z + halfD],
    [x - halfW, z + halfD],
  ];
  const y = heightAt(x, z);
  // Soil takes the crop's own yellow-green rather than dark brown: at this camera
  // height a dark plate under small plants reads as an empty field with weeds.
  const soil = field.kind === 'maize' || field.kind === 'wheat' ? '#b99a3f' : '#6e8c3c';
  const soilGeometry = new THREE.PlaneGeometry(w, d, 1, 1);
  soilGeometry.rotateX(-Math.PI / 2);
  const soilMesh = new THREE.Mesh(soilGeometry, material(materials, soil, { roughness: 1 }));
  soilMesh.position.set(x, y + 0.05, z);
  soilMesh.receiveShadow = true;
  group.add(soilMesh);
  // Slight corner stakes so fields read as parcels.
  for (const corner of corners) {
    const stake = addMesh(
      group,
      new THREE.BoxGeometry(0.16, 0.7, 0.16),
      material(materials, PALETTE.woodDark),
      [corner[0], heightAt(corner[0], corner[1]) + 0.35, corner[1]],
    );
    stake.castShadow = false;
  }

  const rng = seededRng(Math.round(x * 13 + z * 7));
  // A field has to look *planted* from the camera's real height, which is 200
  // units up: the old density left bare soil showing between short crops.
  const density = field.density ?? (w * d) / 0.62;
  const rows = Math.max(2, Math.round(Math.sqrt(density * (d / w))));
  const cols = Math.max(2, Math.round(density / rows));
  const color =
    field.kind === 'maize'
      ? '#e8b83f'
      : field.kind === 'vine'
        ? '#4d7a35'
        : field.kind === 'wheat'
      ? PALETTE.wheat
      : field.kind === 'sunflower'
        ? PALETTE.sunflower
        : field.kind === 'pumpkin'
          ? PALETTE.pumpkin
          : field.kind === 'clover'
            ? PALETTE.clover
            : PALETTE.vegetable;
  const cropMaterial = material(materials, color, { roughness: 0.95 });
  const stemMaterial = material(materials, '#6f8b3f', { roughness: 1 });

  if (field.kind === 'maize' || field.kind === 'vine' || field.kind === 'sunflower' || field.kind === 'wheat') {
    const headGeometry = field.kind === 'sunflower'
      ? new THREE.CylinderGeometry(0.72, 0.72, 0.14, 8)
      : field.kind === 'maize'
        ? // A corn cob: a fat stub rather than a spike, so the field reads as
          // yellow grain from above instead of a bed of needles.
          new THREE.CylinderGeometry(0.16, 0.1, 0.7, 5)
        : field.kind === 'vine'
          ? // Grape clusters hanging under the trellis.
            new THREE.SphereGeometry(0.55, 6, 5)
          : new THREE.ConeGeometry(0.34, 1.25, 5);
    const stemGeometry = new THREE.CylinderGeometry(
      0.085,
      0.11,
      field.kind === 'maize' ? 4.6 : field.kind === 'vine' ? 3.4 : field.kind === 'sunflower' ? 3.8 : 3.0,
      4,
    );
    const count = Math.min(900, rows * cols);
    const headInstanced = new THREE.InstancedMesh(headGeometry, cropMaterial, count);
    const stemInstanced = new THREE.InstancedMesh(stemGeometry, stemMaterial, count);
    headInstanced.castShadow = stemInstanced.castShadow = true;
    const matrix = new THREE.Matrix4();
    const dummy = new THREE.Object3D();
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const px = x - halfW + 0.6 + (col / Math.max(1, cols - 1)) * (w - 1.2) + (rng() - 0.5) * 0.4;
      const pz = z - halfD + 0.6 + (row / Math.max(1, rows - 1)) * (d - 1.2) + (rng() - 0.5) * 0.4;
      const py = heightAt(px, pz);
      const height =
        field.kind === 'maize'
          ? 4.4 + rng() * 0.9
          : field.kind === 'vine'
            ? 3.2 + rng() * 0.5
            : field.kind === 'sunflower'
              ? 3.7 + rng() * 0.8
              : 2.9 + rng() * 0.6;
      dummy.position.set(px, py + height / 2, pz);
      dummy.rotation.set(0, rng() * Math.PI, field.kind === 'sunflower' ? (rng() - 0.5) * 0.4 : (rng() - 0.5) * 0.15);
      dummy.scale.setScalar(0.85 + rng() * 0.3);
      dummy.updateMatrix();
      matrix.copy(dummy.matrix);
      stemInstanced.setMatrixAt(index, matrix);
      dummy.position.y = py + (field.kind === 'vine' ? height * 0.72 : height);
      dummy.rotation.set(field.kind === 'sunflower' ? Math.PI / 2 : 0, 0, 0);
      dummy.updateMatrix();
      headInstanced.setMatrixAt(index, dummy.matrix);
    }
    headInstanced.instanceMatrix.needsUpdate = true;
    stemInstanced.instanceMatrix.needsUpdate = true;
    group.add(headInstanced, stemInstanced);
  } else {
    // Leafy crops: low bushes in rows (cabbages, pumpkins, clover).
    const geometry = new THREE.IcosahedronGeometry(field.kind === 'pumpkin' ? 1.05 : 0.85, 0);
    const count = Math.min(700, rows * cols);
    const instanced = new THREE.InstancedMesh(geometry, cropMaterial, count);
    instanced.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const px = x - halfW + 0.6 + (col / Math.max(1, cols - 1)) * (w - 1.2) + (rng() - 0.5) * 0.35;
      const pz = z - halfD + 0.6 + (row / Math.max(1, rows - 1)) * (d - 1.2) + (rng() - 0.5) * 0.35;
      const py = heightAt(px, pz);
      dummy.position.set(px, py + 0.6, pz);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(1 + rng() * 0.4, 0.7 + rng() * 0.35, 1 + rng() * 0.4);
      dummy.updateMatrix();
      instanced.setMatrixAt(index, dummy.matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  }

  root.add(group);
}

function buildBridge(
  root: THREE.Group,
  materials: Materials,
  bridge: { position: Vec2; rotation: number; length: number; width: number; style: 'plank' | 'stone' },
  heightAt: (x: number, z: number) => number,
) {
  const group = new THREE.Group();
  const [x, z] = bridge.position;
  const y = Math.max(heightAt(x, z), 0.35) + 0.3;
  group.position.set(x, y, z);
  group.rotation.y = bridge.rotation;
  const woodMaterial =
    bridge.style === 'stone' ? material(materials, PALETTE.stone) : material(materials, PALETTE.woodLight);

  const deck = addMesh(
    group,
    new THREE.BoxGeometry(bridge.width, 0.18, bridge.length),
    woodMaterial,
    [0, 0, 0],
  );
  deck.receiveShadow = true;

  // Plank seams.
  const seamMaterial = material(materials, PALETTE.woodDark);
  const seamCount = Math.floor(bridge.length / 0.85);
  for (let index = 0; index < seamCount; index += 1) {
    if (index % 2 === 0) continue;
    addMesh(
      group,
      new THREE.BoxGeometry(bridge.width + 0.06, 0.06, 0.07),
      seamMaterial,
      [0, 0.1, -bridge.length / 2 + (index + 0.5) * (bridge.length / seamCount)],
    );
  }

  // Railings for the plank bridge.
  if (bridge.style === 'plank') {
    const railMaterial = material(materials, PALETTE.wood);
    for (const side of [-1, 1]) {
      const railX = (bridge.width / 2 - 0.12) * side;
      addMesh(group, new THREE.BoxGeometry(0.1, 0.34, bridge.length), railMaterial, [railX, 1.05, 0]);
      const postCount = Math.max(2, Math.floor(bridge.length / 3));
      for (let index = 0; index <= postCount; index += 1) {
        addMesh(
          group,
          new THREE.BoxGeometry(0.16, 1.1, 0.16),
          railMaterial,
          [railX, 0.55, -bridge.length / 2 + (index / postCount) * bridge.length],
        );
      }
    }
  } else {
    // Stone rails.
    const stoneRail = material(materials, PALETTE.stoneDark);
    for (const side of [-1, 1]) {
      addMesh(
        group,
        new THREE.BoxGeometry(0.24, 0.55, bridge.length),
        stoneRail,
        [side * (bridge.width / 2 - 0.15), 0.35, 0],
      );
    }
  }

  // Support columns down to the water.
  const supportMaterial = material(materials, PALETTE.woodDark);
  for (const side of [-1, 1]) {
    for (const along of [-0.36, 0, 0.36]) {
      addMesh(
        group,
        new THREE.CylinderGeometry(0.16, 0.2, 2.4, 6),
        supportMaterial,
        [side * (bridge.width / 2 - 0.3), -1.25, along * bridge.length],
      );
    }
  }

  root.add(group);
}

function buildFenceRun(
  root: THREE.Group,
  materials: Materials,
  fence: FenceRun,
  heightAt: (x: number, z: number) => number,
) {
  const gaps = fence.gaps ?? [];
  const segments: Vec2[][] = [];
  const lengths: number[] = [0];
  for (let index = 1; index < fence.points.length; index += 1) {
    const a = fence.points[index - 1]!;
    const b = fence.points[index]!;
    lengths.push(lengths[index - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = lengths[lengths.length - 1]!;
  const ranges: [number, number][] = [];
  let cursor = 0;
  for (const gap of gaps.slice().sort((a, b) => a.start - b.start)) {
    if (gap.start > cursor) ranges.push([cursor, gap.start]);
    cursor = Math.max(cursor, gap.end);
  }
  if (cursor < total) ranges.push([cursor, total]);
  for (const [start, end] of ranges) {
    const points = fenceGapsPolyline(fence.points, start, end);
    if (points.length >= 2) segments.push(points);
  }

  const group = new THREE.Group();
  const postMaterial = material(materials, PALETTE.woodDark);
  const railMaterial = material(materials, PALETTE.wood);
  const brambleMaterial = material(materials, '#5f7d43');
  const stoneMaterial = material(materials, PALETTE.stone);

  for (const segment of segments) {
    let placed = 0;
    for (let index = 1; index < segment.length; index += 1) {
      const a = segment[index - 1]!;
      const b = segment[index]!;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      const midX = (a[0] + b[0]) / 2;
      const midZ = (a[1] + b[1]) / 2;
      const y = heightAt(midX, midZ);
      const angle = Math.atan2(dx, dz);
      if (fence.style === 'rail') {
        const rail = addMesh(group, new THREE.BoxGeometry(0.08, 0.1, length + 0.1), railMaterial, [midX, y + 0.72, midZ]);
        rail.rotation.y = angle;
        const rail2 = addMesh(group, new THREE.BoxGeometry(0.07, 0.09, length + 0.1), railMaterial, [midX, y + 0.4, midZ]);
        rail2.rotation.y = angle;
        if (placed % 2 === 0) {
          addMesh(group, new THREE.BoxGeometry(0.14, 0.95, 0.14), postMaterial, [a[0], y + 0.48, a[1]]);
        }
      } else if (fence.style === 'stone') {
        const wall = addMesh(group, new THREE.BoxGeometry(0.42, 0.85, length + 0.12), stoneMaterial, [midX, y + 0.42, midZ]);
        wall.rotation.y = angle;
      } else {
        // Bramble: knobbly hedge of spheres.
        for (let step = 0; step < 2; step += 1) {
          const t = step / 2 + 0.25;
          const px = a[0] + dx * t;
          const pz = a[1] + dz * t;
          const bump = addMesh(
            group,
            new THREE.IcosahedronGeometry(0.5 + (hash2(px, pz) * 0.25), 0),
            brambleMaterial,
            [px, heightAt(px, pz) + 0.45, pz],
          );
          bump.scale.set(1, 0.8, 1);
          bump.rotation.y = hash2(pz, px) * Math.PI;
          bump.castShadow = false;
        }
      }
      placed += 1;
    }
    // End posts.
    if (fence.style === 'rail') {
      const last = segment[segment.length - 1]!;
      addMesh(group, new THREE.BoxGeometry(0.14, 0.95, 0.14), postMaterial, [last[0], heightAt(last[0], last[1]) + 0.48, last[1]]);
    }
  }
  root.add(group);
}

function buildCircleFence(
  root: THREE.Group,
  materials: Materials,
  fence: CircleFence,
  heightAt: (x: number, z: number) => number,
) {
  const group = new THREE.Group();
  const step = 2.3;
  const circumference = Math.PI * 2 * fence.radius;
  const count = Math.max(8, Math.floor(circumference / step));
  const postMaterial = material(materials, fence.style === 'stone' ? PALETTE.stoneDark : PALETTE.woodDark);
  const railMaterial = material(materials, fence.style === 'stone' ? PALETTE.stone : PALETTE.woodLight);
  for (let index = 0; index < count; index += 1) {
    const t = index / count;
    if (t >= fence.gapStart && t <= fence.gapEnd) continue;
    const angle = t * Math.PI * 2;
    const px = fence.center[0] + Math.cos(angle) * fence.radius;
    const pz = fence.center[1] + Math.sin(angle) * fence.radius;
    const y = heightAt(px, pz);
    addMesh(group, new THREE.BoxGeometry(0.2, fence.style === 'stone' ? 1.0 : 1.1, 0.2), postMaterial, [px, y + 0.5, pz]);
    // Rail to the next post.
    const nextT = ((index + 1) / count) % 1;
    if (!(nextT >= fence.gapStart && nextT <= fence.gapEnd)) {
      const nextAngle = ((index + 1) / count) * Math.PI * 2;
      const nx = fence.center[0] + Math.cos(nextAngle) * fence.radius;
      const nz = fence.center[1] + Math.sin(nextAngle) * fence.radius;
      const mx = (px + nx) / 2;
      const mz = (pz + nz) / 2;
      const length = Math.hypot(nx - px, nz - pz) + 0.15;
      const rail = addMesh(
        group,
        new THREE.BoxGeometry(0.08, fence.style === 'stone' ? 0.7 : 0.12, length),
        railMaterial,
        [mx, heightAt(mx, mz) + (fence.style === 'stone' ? 0.4 : 0.75), mz],
      );
      rail.rotation.y = Math.atan2(nx - px, nz - pz);
    }
  }
  root.add(group);
}

/**
 * Forests drawn from the packed models instead of cones and icosahedra.
 *
 * Each species is one `InstancedMesh`, so a five-thousand-tree wood is three
 * draw calls. The old version stacked five meshes per zone (trunk, two leaf
 * blobs, pine cone, cone again) and needed a per-species material set; the pack
 * already carries the colours on the vertices.
 */
const TREE_SPECIES = ['Tree1', 'Tree2', 'Tree3'] as const;

function buildModelTreeZone(
  root: THREE.Group,
  zone: TreeZone,
  heightAt: (x: number, z: number) => number,
): boolean {
  const prototypes = TREE_SPECIES.map((name) => ({ name, ...(modelPrototype(name) ?? {}) }));
  if (prototypes.some((prototype) => !prototype.geometry)) return false;
  const heights = TREE_SPECIES.map((name) => getModel(name)?.height ?? 1);
  const rng = seededRng(zone.seed * 977 + 13);
  const buckets: THREE.Matrix4[][] = TREE_SPECIES.map(() => []);
  const dummy = new THREE.Object3D();
  const pines = zone.mix === 'pine';
  const birches = zone.mix === 'birch';
  for (let index = 0; index < zone.count; index += 1) {
    const px = zone.x + (rng() - 0.5) * zone.w;
    const pz = zone.z + (rng() - 0.5) * zone.d;
    const py = heightAt(px, pz);
    // Pines use the conifer of the three, broadleaf and birch pick between the
    // rounder two; the choice is deterministic from the zone's own seed.
    const species = pines ? 2 : birches ? (rng() < 0.5 ? 0 : 1) : rng() < 0.45 ? 2 : rng() < 0.6 ? 0 : 1;
    const target = (pines ? 11 : 9) * (0.82 + rng() * 0.5);
    const scale = target / heights[species]!;
    dummy.position.set(px, py, pz);
    dummy.rotation.set(0, rng() * Math.PI * 2, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    buckets[species]!.push(dummy.matrix.clone());
  }
  const group = new THREE.Group();
  group.name = `trees-${zone.id ?? 'zone'}`;
  TREE_SPECIES.forEach((name, species) => {
    const matrices = buckets[species]!;
    if (!matrices.length) return;
    const prototype = modelPrototype(name);
    if (!prototype) return;
    const instanced = new THREE.InstancedMesh(prototype.geometry, prototype.material, matrices.length);
    matrices.forEach((matrix, index) => instanced.setMatrixAt(index, matrix));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    group.add(instanced);
  });
  root.add(group);
  return true;
}

function buildTreeZone(
  root: THREE.Group,
  materials: Materials,
  zone: TreeZone,
  heightAt: (x: number, z: number) => number,
) {
  if (buildModelTreeZone(root, zone, heightAt)) return;
  const rng = seededRng(zone.seed * 977 + 13);
  const group = new THREE.Group();
  // `zone.x/z/w/d` arrive already scaled; the geometry below is authored at the
  // old size, so every tree is grown by the same factor.
  const GROW = WORLD_SCALE;
  const leafMaterials = {
    oak: [material(materials, PALETTE.leafA), material(materials, PALETTE.leafB), material(materials, PALETTE.leafC)],
    pine: [material(materials, PALETTE.pine), material(materials, '#4d7f55')],
    birch: [material(materials, PALETTE.birchleaf), material(materials, PALETTE.leafB)],
  };
  const trunkMaterial = material(materials, PALETTE.trunk);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.34, 2.2, 6), trunkMaterial, zone.count);
  const broad = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.35, 0), leafMaterials.oak[0]!, zone.count);
  const broadB = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.98, 0), leafMaterials.oak[1]!, zone.count);
  const pines = new THREE.InstancedMesh(new THREE.ConeGeometry(1.3, 2.6, 7), leafMaterials.pine[0]!, zone.count);
  const pinesB = new THREE.InstancedMesh(new THREE.ConeGeometry(0.9, 2.0, 7), leafMaterials.pine[1]!, zone.count);
  const birches = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.1, 0), leafMaterials.birch[0]!, zone.count);
  let broadCount = 0;
  let pineCount = 0;
  let birchCount = 0;
  let trunkCount = 0;
  const dummy = new THREE.Object3D();
  const mix = zone.mix;
  for (let index = 0; index < zone.count; index += 1) {
    const px = zone.x + (rng() - 0.5) * zone.w;
    const pz = zone.z + (rng() - 0.5) * zone.d;
    const py = heightAt(px, pz);
    const scale = (0.8 + rng() * 0.7) * GROW;
    const roll = rng();
    const type = mix === 'mixed' ? (roll < 0.45 ? 'oak' : roll < 0.8 ? 'pine' : 'birch') : mix;
    dummy.position.set(px, py + 1.1 * scale, pz);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(trunkCount++, dummy.matrix);
    if (type === 'pine') {
      dummy.position.set(px, py + 2.6 * scale, pz);
      dummy.updateMatrix();
      pines.setMatrixAt(pineCount++, dummy.matrix);
      dummy.position.set(px, py + 3.7 * scale, pz);
      dummy.scale.setScalar(scale * 0.85);
      dummy.updateMatrix();
      pinesB.setMatrixAt(pineCount - 1, dummy.matrix);
    } else if (type === 'birch') {
      dummy.position.set(px, py + 2.9 * scale, pz);
      dummy.updateMatrix();
      birches.setMatrixAt(birchCount++, dummy.matrix);
    } else {
      dummy.position.set(px, py + 3.0 * scale, pz);
      dummy.updateMatrix();
      broad.setMatrixAt(broadCount, dummy.matrix);
      dummy.position.set(px + 0.7 * scale, py + 2.4 * scale, pz - 0.4 * scale);
      dummy.scale.setScalar(scale * 0.8);
      dummy.updateMatrix();
      broadB.setMatrixAt(broadCount++, dummy.matrix);
    }
  }
  trunks.count = trunkCount;
  broad.count = broadCount;
  broadB.count = broadCount;
  pines.count = pineCount;
  pinesB.count = pineCount;
  birches.count = birchCount;
  for (const mesh of [trunks, broad, broadB, pines, pinesB, birches]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(trunks, broad, broadB, pines, pinesB, birches);
  root.add(group);
}

function buildArena(
  root: THREE.Group,
  materials: Materials,
  arena: ArenaDef,
  heightAt: (x: number, z: number) => number,
): THREE.Group {
  const group = new THREE.Group();
  const [x, z] = arena.position;
  const y = heightAt(x, z);
  group.position.set(x, y, z);
  group.rotation.y = arena.rotation ?? 0;
  group.name = `arena-${arena.id}`;

  /*
   * No universal earth plateau any more.
   *
   * The old builder stacked every boss on the same raised disc of packed earth
   * with the same accent ring, so five different animals shared one arena and
   * the map read as "here are five circles". Each style now gets the ground its
   * animal actually lives on — a threshing floor, a farmhouse yard, a pond
   * bank, a stone ring — and a home to fight out of.
   */

  const floorTone =
    arena.floor === 'boards'
      ? '#b98f5f'
      : arena.floor === 'straw'
        ? '#d8b96a'
        : arena.floor === 'grass'
          ? '#8fb268'
          : arena.floor === 'water-edge'
            ? '#9c8a63'
            : '#c4a06c';

  /** A subtle, low platform so an arena never floats on a slope. */
  const apron = new THREE.Mesh(
    new THREE.CylinderGeometry(arena.radius + 1.2, arena.radius + 2.2, 1.4, 40),
    material(materials, floorTone, { roughness: 1, flatShading: true }),
  );
  apron.position.y = -0.72;
  apron.receiveShadow = true;
  group.add(apron);

  // A pond arena is dug, not paved: the bank shows as a ring of mud around the
  // water, and there is no dry disc for the duck to stand on.
  const isWaterArena = arena.home?.kind === 'pond';
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(arena.radius, 56),
    material(materials, floorTone, { roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.06;
  floor.receiveShadow = true;
  if (!isWaterArena) group.add(floor);

  // A faint painted mark instead of the boss ring: this is a *place*, not a UI
  // shape, so it gets a swept path rather than a coloured hoop.
  const painted = new THREE.Mesh(
    new THREE.RingGeometry(arena.radius * 0.52, arena.radius * 0.58, 48),
    material(materials, '#ede0c0', { roughness: 1 }),
  );
  painted.rotation.x = -Math.PI / 2;
  painted.position.y = 0.09;
  group.add(painted);

  /* ------------------------------------------------------- the home ground */
  const homeOffset = arena.home?.offset ?? [0, 0];
  const homeX = homeOffset[0];
  const homeZ = homeOffset[1];
  const homeGroundY = heightAt(x + homeX, z + homeZ) - y;
  if (arena.home?.kind === 'house') {
    // A farmhouse the rooster actually lives in: open door, porch, and the
    // fight spilling down the step.
    buildBuildingByKind(
      group,
      materials,
      {
        id: `${arena.id}-house`,
        kind: 'farmhouse',
        position: [homeX, homeZ],
        rotation: arena.home.rotation ?? 0,
        scale: 1.0,
      },
      (hx, hz) => homeGroundY + (hx === homeX && hz === homeZ ? 0 : 0),
      [],
    );
    // The open door: a black recess, so the boss reads as coming out of it.
    addMesh(group, new THREE.BoxGeometry(1.5, 2.4, 0.5), material(materials, '#241a14'), [homeX, homeGroundY + 1.3, homeZ + 3.55]);
  } else if (arena.home?.kind === 'pond') {
    // The duck's own water. An ellipse, not a circle, so it reads as a pond in a
    // meadow rather than a fountain.
    const pond = new THREE.Mesh(
      new THREE.CircleGeometry(arena.radius * 0.78, 44),
      material(materials, '#4fb3dd', {
        roughness: 0.14,
        emissive: new THREE.Color('#2f7f9c'),
        emissiveIntensity: 0.3,
      }),
    );
    pond.rotation.x = -Math.PI / 2;
    pond.scale.set(1, 0.72, 1);
    // Above the bank ring, not buried in it: at 0.16 the water read as wet earth.
    pond.position.set(homeX, 0.34, homeZ);
    pond.name = 'arena-pond-water';
    group.add(pond);
    // Muddy rim.
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(arena.radius * 0.78, arena.radius * 0.86, 44),
      material(materials, '#8a7548', { roughness: 1 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.scale.set(1.06, 0.77, 1);
    rim.position.set(homeX, 0.2, homeZ);
    group.add(rim);
    // Reeds and a nesting raft.
    for (let index = 0; index < 26; index += 1) {
      const angle = (index / 26) * Math.PI * 2;
      const reedX = Math.cos(angle) * arena.radius * 0.84;
      const reedZ = Math.sin(angle) * arena.radius * 0.62;
      addMesh(
        group,
        new THREE.ConeGeometry(0.1, 1.6 + hash2(index, 4) * 0.8, 4),
        material(materials, '#6f9440'),
        [reedX, 0.8, reedZ],
      );
    }
    addMesh(group, new THREE.CylinderGeometry(1.1, 1.1, 0.16, 9), material(materials, PALETTE.woodLight), [arena.radius * 0.3, 0.24, arena.radius * 0.2]);
  } else if (arena.home?.kind === 'threshing') {
    // The granary the turkey has claimed, with its open bay facing the yard.
    buildBuildingByKind(
      group,
      materials,
      {
        id: `${arena.id}-granary`,
        kind: 'threshingGranary',
        position: [homeX, homeZ],
        // The bay must face the floor, so the home's yaw is explicit rather than
        // inherited from the arena.
        rotation: arena.home.rotation ?? 0,
        scale: 0.8,
      },
      () => homeGroundY,
      [],
    );
  } else if (arena.home?.kind === 'palace') {
    // No extra building: the hen palace already stands behind this arena.
  }

  /* ------------------------------------------------------------ furniture */
  if (arena.style === 'threshing') {
    // Threshing machine arms around the rim + straw.
    for (let index = 0; index < 4; index += 1) {
      const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(angle) * (arena.radius - 1.2);
      const pz = Math.sin(angle) * (arena.radius - 1.2);
      const arm = new THREE.Group();
      arm.position.set(px, 0.1, pz);
      arm.rotation.y = -angle;
      addMesh(arm, new THREE.BoxGeometry(0.6, 1.9, 0.6), material(materials, PALETTE.woodDark), [0, 0.95, 0]);
      addMesh(arm, new THREE.BoxGeometry(4.6, 0.16, 0.5), material(materials, PALETTE.woodLight), [0, 1.9, 0]);
      group.add(arm);
    }
    for (let index = 0; index < 7; index += 1) {
      const angle = (index / 7) * Math.PI * 2 + 0.4;
      const radius = arena.radius + 2.2;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;
      const bale = addMesh(
        group,
        new THREE.CylinderGeometry(0.75, 0.75, 1.1, 10),
        material(materials, PALETTE.hay),
        [px, heightAt(x + px, z + pz) - y + 0.55, pz],
      );
      bale.rotation.z = Math.PI / 2;
      bale.rotation.y = angle;
    }
  } else if (arena.style === 'farmhouse') {
    // Yard fence, water trough, and the coop posts the rooster perches on.
    const postMaterial = material(materials, PALETTE.woodDark);
    for (let index = 0; index < 16; index += 1) {
      const angle = (index / 16) * Math.PI * 2;
      const px = Math.cos(angle) * (arena.radius + 1.6);
      const pz = Math.sin(angle) * (arena.radius + 1.6);
      addMesh(group, new THREE.BoxGeometry(0.18, 1.2, 0.18), postMaterial, [px, 0.6, pz]);
      if (index % 2 === 0) {
        const rail = addMesh(
          group,
          new THREE.BoxGeometry(0.1, 0.12, 3.2),
          postMaterial,
          [Math.cos(angle + 0.2) * (arena.radius + 1.6), 0.85, Math.sin(angle + 0.2) * (arena.radius + 1.6)],
        );
        rail.rotation.y = -angle;
      }
    }
    const trough = addMesh(group, new THREE.BoxGeometry(2.2, 0.55, 0.8), material(materials, PALETTE.woodLight), [-arena.radius * 0.6, 0.3, arena.radius * 0.5]);
    trough.rotation.y = 0.4;
    addMesh(group, new THREE.BoxGeometry(2.0, 0.08, 0.62), material(materials, '#4fb3dd'), [-arena.radius * 0.6, 0.56, arena.radius * 0.5]).rotation.y = 0.4;
    // Centre post: the perch he commands the yard from.
    addMesh(group, new THREE.CylinderGeometry(0.3, 0.4, 3.8, 8), postMaterial, [0, 1.9, 0]);
    addMesh(group, new THREE.BoxGeometry(2.2, 0.26, 0.32), material(materials, PALETTE.woodLight), [0, 3.75, 0]);
  } else if (arena.style === 'pond') {
    // Duck boards over the bank, plus a lantern post.
    for (let index = 0; index < 5; index += 1) {
      const board = addMesh(
        group,
        new THREE.BoxGeometry(3.2, 0.14, 0.9),
        material(materials, PALETTE.woodLight),
        [-arena.radius * 0.55 + index * 0.2, 0.2, -arena.radius * 0.55 - index * 1.1],
      );
      board.rotation.y = 0.1;
    }
    const lantern = new THREE.Group();
    lantern.position.set(arena.radius * 0.55, 0, arena.radius * 0.45);
    addMesh(lantern, new THREE.CylinderGeometry(0.09, 0.11, 2.4, 6), material(materials, PALETTE.woodDark), [0, 1.2, 0]);
    addMesh(
      lantern,
      new THREE.BoxGeometry(0.4, 0.48, 0.4),
      material(materials, '#ffcf6b', { emissive: new THREE.Color('#ff9f3c'), emissiveIntensity: 1.2 }),
      [0, 2.5, 0],
    );
    group.add(lantern);
  } else if (arena.style === 'ramring') {
    for (let index = 0; index < 10; index += 1) {
      const angle = (index / 10) * Math.PI * 2;
      addMesh(
        group,
        new THREE.CylinderGeometry(0.5, 0.6, 2.4, 7),
        material(materials, PALETTE.stone),
        [Math.cos(angle) * (arena.radius + 1), 1.2, Math.sin(angle) * (arena.radius + 1)],
      );
    }
    const wall = new THREE.Mesh(
      new THREE.TorusGeometry(arena.radius + 1, 0.38, 6, 40),
      material(materials, PALETTE.stoneDark),
    );
    wall.rotation.x = -Math.PI / 2;
    wall.position.y = 0.35;
    group.add(wall);
  } else if (arena.style === 'bridge') {
    for (const side of [-1, 1]) {
      const lantern = new THREE.Group();
      lantern.position.set(side * (arena.radius + 0.4), heightAt(x + side * (arena.radius + 0.4), z) - y, 8);
      addMesh(lantern, new THREE.CylinderGeometry(0.08, 0.1, 2.6, 6), material(materials, PALETTE.woodDark), [0, 1.3, 0]);
      addMesh(
        lantern,
        new THREE.BoxGeometry(0.42, 0.5, 0.42),
        material(materials, '#ffcf6b', { emissive: new THREE.Color('#ff9f3c'), emissiveIntensity: 1.2 }),
        [0, 2.7, 0],
      );
      group.add(lantern);
    }
    for (let index = 0; index < 22; index += 1) {
      const px = (index / 22 - 0.5) * arena.radius * 2.6;
      const pz = Math.sin(index * 2.1) * arena.radius * 0.9;
      addMesh(
        group,
        new THREE.ConeGeometry(0.12, 1.2, 4),
        material(materials, '#7fa35a'),
        [px, heightAt(x + px, z + pz) - y + 0.6, pz],
      );
    }
  } else {
    // Palace ring: braziers, carpet strip and throne steps.
    for (const side of [-1, 1]) {
      for (let index = 0; index < 3; index += 1) {
        const px = side * (arena.radius - 1.5);
        const pz = -6 + index * 6;
        const brazier = new THREE.Group();
        brazier.position.set(px, 0, pz);
        addMesh(brazier, new THREE.CylinderGeometry(0.28, 0.34, 1.3, 7), material(materials, PALETTE.stoneDark), [0, 0.65, 0]);
        addMesh(
          brazier,
          new THREE.IcosahedronGeometry(0.38, 0),
          material(materials, '#ffb347', { emissive: new THREE.Color('#ff7a2f'), emissiveIntensity: 1.5 }),
          [0, 1.5, 0],
        );
        group.add(brazier);
      }
    }
    // A runner from the throne to the ring edge: long enough to read as a path,
    // short enough that its corners never break the circle.
    const carpetLength = arena.radius * 1.32;
    const carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, carpetLength),
      material(materials, '#9c2f3f'),
    );
    carpet.rotation.x = -Math.PI / 2;
    // -Z is the palace side, so the runner starts near the throne and runs out.
    carpet.position.set(0, 0.1, -arena.radius * 0.5 + carpetLength / 2 - 1);
    carpet.name = 'palace-carpet';
    group.add(carpet);
    for (const side of [-1, 1]) {
      const border = new THREE.Mesh(
        new THREE.PlaneGeometry(0.3, carpetLength),
        material(materials, PALETTE.hay),
      );
      border.rotation.x = -Math.PI / 2;
      border.position.set(side * 1.95, 0.11, carpet.position.z);
      group.add(border);
    }
  }
  root.add(group);
  return group;
}

function buildCheckpoint(
  root: THREE.Group,
  materials: Materials,
  position: Vec2,
  heightAt: (x: number, z: number) => number,
  animated: ((elapsed: number) => void)[],
) {
  const group = new THREE.Group();
  const [x, z] = position;
  const y = heightAt(x, z);
  group.position.set(x, y, z);
  // Glowing calabash-style lantern on a post — the classic souls checkpoint.
  addMesh(group, new THREE.CylinderGeometry(0.16, 0.24, 2.0, 6), material(materials, PALETTE.woodDark), [0, 1, 0]);
  const halo = addMesh(
    group,
    new THREE.TorusGeometry(0.62, 0.06, 6, 18),
    material(materials, PALETTE.checkpoint, { emissive: new THREE.Color('#ffb443'), emissiveIntensity: 1.4 }),
    [0, 2.5, 0],
  );
  halo.rotation.x = Math.PI / 2;
  const bulb = addMesh(
    group,
    new THREE.IcosahedronGeometry(0.34, 0),
    material(materials, '#fff2c2', { emissive: new THREE.Color('#ffd166'), emissiveIntensity: 2.2 }),
    [0, 2.5, 0],
  );
  bulb.castShadow = false;
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.7, 5.5, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: '#ffd88a',
      transparent: true,
      opacity: 0.09,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  beam.position.y = 5.2;
  group.add(beam);
  const base = new THREE.Mesh(
    new THREE.CircleGeometry(1.5, 24),
    new THREE.MeshBasicMaterial({ color: '#ffcf6b', transparent: true, opacity: 0.28, depthWrite: false }),
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.06;
  group.add(base);
  animated.push((elapsed) => {
    halo.rotation.z = elapsed * 0.7;
    bulb.position.y = 2.5 + Math.sin(elapsed * 1.6 + x) * 0.08;
    base.scale.setScalar(1 + Math.sin(elapsed * 2 + z) * 0.04);
  });
  root.add(group);
}


/* ------------------------------------------------------------ buildings */

interface BuildingKit {
  wall: string;
  roof: string;
  trim: string;
  accent: string;
  width: number;
  depth: number;
  wallHeight: number;
  roofHeight: number;
  roofStyle: 'gable' | 'hip' | 'cone' | 'flat' | 'dome';
}

const BUILDING_KITS: Record<BuildingKind, BuildingKit> = {
  farmhouse: { wall: PALETTE.wallCream, roof: PALETTE.roofRed, trim: PALETTE.woodDark, accent: '#7d9b6a', width: 9, depth: 7, wallHeight: 3.4, roofHeight: 3.0, roofStyle: 'gable' },
  barn: { wall: PALETTE.wallRed, roof: '#5d4736', trim: PALETTE.wallCream, accent: PALETTE.hay, width: 11, depth: 8, wallHeight: 4.2, roofHeight: 3.6, roofStyle: 'gable' },
  silo: { wall: '#cfc6ad', roof: '#8b8f92', trim: PALETTE.stoneDark, accent: '#a8b0b5', width: 3.4, depth: 3.4, wallHeight: 7.5, roofHeight: 2.2, roofStyle: 'dome' },
  shed: { wall: PALETTE.wallClay, roof: PALETTE.roofMoss, trim: PALETTE.woodDark, accent: PALETTE.woodLight, width: 5, depth: 4, wallHeight: 2.4, roofHeight: 1.4, roofStyle: 'gable' },
  stable: { wall: PALETTE.wallClay, roof: PALETTE.roofBlue, trim: PALETTE.woodDark, accent: PALETTE.hay, width: 9.5, depth: 6, wallHeight: 3.2, roofHeight: 2.4, roofStyle: 'gable' },
  market: { wall: '#f0d8a8', roof: '#c95a4b', trim: PALETTE.woodDark, accent: '#f2e2b0', width: 3.6, depth: 2.6, wallHeight: 2.1, roofHeight: 0.9, roofStyle: 'hip' },
  well: { wall: PALETTE.stone, roof: PALETTE.roofRed, trim: PALETTE.woodDark, accent: '#6aa8bf', width: 2.4, depth: 2.4, wallHeight: 0.9, roofHeight: 1.6, roofStyle: 'cone' },
  tower: { wall: PALETTE.wallStone, roof: PALETTE.roofBlue, trim: PALETTE.stoneDark, accent: PALETTE.accent, width: 3.6, depth: 3.6, wallHeight: 6.4, roofHeight: 2.6, roofStyle: 'cone' },
  windmill: { wall: '#e6d9bd', roof: PALETTE.roofRed, trim: PALETTE.woodDark, accent: PALETTE.woodLight, width: 4.4, depth: 4.4, wallHeight: 7.2, roofHeight: 3.2, roofStyle: 'cone' },
  sheepShelter: { wall: PALETTE.wallClay, roof: PALETTE.roofThatch, trim: PALETTE.woodDark, accent: PALETTE.hay, width: 7, depth: 5, wallHeight: 2.3, roofHeight: 1.6, roofStyle: 'gable' },
  duckHouse: { wall: PALETTE.woodLight, roof: '#7a6a4a', trim: PALETTE.woodDark, accent: PALETTE.water, width: 3.2, depth: 2.8, wallHeight: 1.6, roofHeight: 1.3, roofStyle: 'gable' },
  nursery: { wall: '#efd9a8', roof: '#b8613f', trim: PALETTE.woodDark, accent: PALETTE.hay, width: 3.4, depth: 2.6, wallHeight: 1.7, roofHeight: 1.1, roofStyle: 'gable' },
  henPalace: { wall: '#9d3b45', roof: '#3e2430', trim: '#f0cf8a', accent: '#e9c46a', width: 11, depth: 8, wallHeight: 4.6, roofHeight: 3.6, roofStyle: 'gable' },
  gatehouse: { wall: '#e3cfa8', roof: PALETTE.roofRed, trim: PALETTE.woodDark, accent: '#8c8272', width: 6.4, depth: 2.8, wallHeight: 2.8, roofHeight: 2.0, roofStyle: 'gable' },
  dogHouse: { wall: '#c98a5c', roof: '#7c4a2c', trim: PALETTE.woodDark, accent: PALETTE.hay, width: 3.6, depth: 3.0, wallHeight: 1.9, roofHeight: 1.5, roofStyle: 'gable' },
  threshingGranary: { wall: PALETTE.wallClay, roof: PALETTE.roofThatch, trim: PALETTE.woodDark, accent: PALETTE.hay, width: 8.5, depth: 6.5, wallHeight: 4.4, roofHeight: 3.2, roofStyle: 'gable' },
  scarecrowShed: { wall: PALETTE.wallClay, roof: PALETTE.roofThatch, trim: PALETTE.woodDark, accent: PALETTE.hay, width: 3, depth: 2.4, wallHeight: 1.8, roofHeight: 1.2, roofStyle: 'gable' },
};

/**
 * Which Quaternius building stands in for each procedural kind.
 *
 * Kinds with no replacement keep their hand-built geometry: a silo, a windmill
 * and a hen palace are bespoke silhouettes that no pack here has, and swapping
 * them for a cottage would lose the thing that makes the homestead read as a
 * working farm. `height` is the authored world height the model is normalised
 * to, chosen so a barn still overhangs its neighbours the way it did before.
 */
const BUILDING_MODELS: Partial<Record<BuildingKind, { model: string; height: number }>> = {
  // Heights are authored world units, picked against two references: the fox the
  // player drives (about 2.7 tall) and a real farmhouse. The first pass normalised
  // the models to the *procedural* kits' heights, which were themselves authored
  // for a much smaller map, and the whole homestead came out doll-sized.
  farmhouse: { model: 'House_1', height: 11.5 },
  barn: { model: 'House_2', height: 14.0 },
  stable: { model: 'Stable', height: 9.5 },
  shed: { model: 'House_3', height: 6.5 },
  market: { model: 'MarketStand_1', height: 6.2 },
  well: { model: 'Well', height: 5.6 },
  sheepShelter: { model: 'Stable', height: 6.0 },
  dogHouse: { model: 'House_3', height: 5.4 },
  duckHouse: { model: 'House_3', height: 4.2 },
  nursery: { model: 'House_3', height: 5.2 },
  threshingGranary: { model: 'Stable', height: 10.5 },
  scarecrowShed: { model: 'House_3', height: 5.0 },
  gatehouse: { model: 'House_2', height: 10.0 },
  silo: { model: 'Mill', height: 15.0 },
  windmill: { model: 'Mill', height: 16.0 },
  tower: { model: 'House_1', height: 13.0 },
  henPalace: { model: 'House_2', height: 12.5 },
};

/**
 * Places a packed model where a procedural building would have stood.
 *
 * The model is normalised by height rather than by its own units, so the
 * authored `scale` on a building still means what it meant: a barn at 1.95 is
 * nearly twice the height of the same barn at 1.0.
 */
function placeBuildingModel(
  root: THREE.Group,
  spec: BuildingSpec,
  heightAt: (x: number, z: number) => number,
  choice: { model: string; height: number },
): boolean {
  const loaded = getModel(choice.model);
  if (!loaded) return false;
  const [x, z] = spec.position;
  const group = loaded.group.clone(true);
  const scale = (spec.scale ?? 1) * (choice.height / loaded.height);
  group.scale.setScalar(scale);
  group.position.set(x, heightAt(x, z), z);
  group.rotation.y = spec.rotation;
  group.name = `building-${spec.id}`;
  group.userData.buildingKind = spec.kind;
  root.add(group);
  return true;
}

function buildBuildingByKind(
  root: THREE.Group,
  materials: Materials,
  spec: BuildingSpec,
  heightAt: (x: number, z: number) => number,
  animated: ((elapsed: number) => void)[],
) {
  const replacement = BUILDING_MODELS[spec.kind];
  if (replacement && placeBuildingModel(root, spec, heightAt, replacement)) return;

  const kit = BUILDING_KITS[spec.kind];
  const scale = spec.scale ?? 1;
  const [x, z] = spec.position;
  const y = heightAt(x, z);
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = spec.rotation;
  group.scale.setScalar(scale);
  group.name = `building-${spec.id}`;
  group.userData.buildingKind = spec.kind;

  const wallMaterial = material(materials, kit.wall, { roughness: 0.93 });
  const roofMaterial = material(materials, kit.roof, { roughness: 0.88 });
  const trimMaterial = material(materials, kit.trim, { roughness: 0.95 });
  const accentMaterial = material(materials, kit.accent);
  const glowMaterial = material(materials, '#ffe3a6', {
    emissive: new THREE.Color('#ffb347'),
    emissiveIntensity: 1.1,
  });
  const darkMaterial = material(materials, '#3b2a1f');
  const w = kit.width;
  const d = kit.depth;

  if (spec.kind === 'well') {
    addMesh(group, new THREE.CylinderGeometry(1.15, 1.25, 1.0, 10), material(materials, PALETTE.stone), [0, 0.5, 0]);
    addMesh(group, new THREE.CylinderGeometry(0.9, 0.9, 0.08, 10), material(materials, '#3f7d9c'), [0, 0.95, 0]);
    for (const side of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.16, 2.1, 0.16), trimMaterial, [side * 0.95, 1.55, 0]);
    }
    addMesh(group, new THREE.BoxGeometry(2.4, 0.16, 0.16), trimMaterial, [0, 2.5, 0]);
    const roof = addMesh(group, new THREE.ConeGeometry(1.6, 1.1, 4), roofMaterial, [0, 3.1, 0]);
    roof.rotation.y = Math.PI / 4;
    addMesh(group, new THREE.CylinderGeometry(0.06, 0.06, 0.9, 4), trimMaterial, [0, 2.0, 0]);
    root.add(group);
    return;
  }

  // Base + walls (open-sided for shelters).
  const openSided =
    spec.kind === 'sheepShelter' || spec.kind === 'gatehouse' || spec.kind === 'threshingGranary';
  addMesh(group, new THREE.BoxGeometry(w + 0.4, 0.24, d + 0.4), material(materials, PALETTE.stoneDark), [0, 0.12, 0]);
  if (spec.kind === 'gatehouse') {
    // Arch gate: two piers and a lintel, walk-through in the middle.
    const openingWidth = 3.0;
    const blockWidth = (w - openingWidth) / 2;
    for (const side of [-1, 1]) {
      addMesh(
        group,
        new THREE.BoxGeometry(blockWidth, kit.wallHeight + 0.9, d),
        wallMaterial,
        [side * (openingWidth / 2 + blockWidth / 2), (kit.wallHeight + 0.9) / 2 + 0.2, 0],
      );
    }
    addMesh(group, new THREE.BoxGeometry(w, 1.1, d), wallMaterial, [0, kit.wallHeight + 0.75, 0]);
  } else if (spec.kind === 'threshingGranary') {
    // A working granary: three solid walls, a wide open bay facing the yard, and
    // a tie beam over the opening. Without this it was just a house with a sign.
    addMesh(group, new THREE.BoxGeometry(w, kit.wallHeight, 0.4), wallMaterial, [0, kit.wallHeight / 2 + 0.2, -d / 2 + 0.2]);
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.4, kit.wallHeight, d), wallMaterial, [sx * (w / 2 - 0.2), kit.wallHeight / 2 + 0.2, 0]);
      // The corner posts that carry the front of the roof.
      const post = addMesh(
        group,
        new THREE.CylinderGeometry(0.24, 0.28, kit.wallHeight, 7),
        trimMaterial,
        [sx * (w / 2 - 0.34), kit.wallHeight / 2, d / 2],
      );
      post.castShadow = true;
    }
    addMesh(group, new THREE.BoxGeometry(w, 0.5, 0.4), trimMaterial, [0, kit.wallHeight - 0.1, d / 2]);
  } else if (spec.kind === 'sheepShelter') {
    // Three-sided fold: back wall + corner posts, open to the pasture.
    addMesh(group, new THREE.BoxGeometry(w, kit.wallHeight, 0.35), wallMaterial, [0, kit.wallHeight / 2 + 0.2, -d / 2 + 0.18]);
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.35, kit.wallHeight, d), wallMaterial, [sx * (w / 2 - 0.18), kit.wallHeight / 2 + 0.2, 0]);
      addMesh(group, new THREE.BoxGeometry(0.3, kit.wallHeight, 0.3), trimMaterial, [sx * (w / 2 - 0.3), kit.wallHeight / 2, d / 2 - 0.2]);
    }
  } else {
    addMesh(group, new THREE.BoxGeometry(w, kit.wallHeight, d), wallMaterial, [0, kit.wallHeight / 2 + 0.2, 0]);
  }

  // Roof.
  if (kit.roofStyle === 'gable') {
    const overhang = 0.55;
    const halfSpan = w / 2 + overhang;
    const slopeLength = Math.hypot(halfSpan, kit.roofHeight);
    const angle = Math.atan2(kit.roofHeight, halfSpan);
    for (const side of [-1, 1]) {
      const panel = addMesh(
        group,
        new THREE.BoxGeometry(slopeLength, 0.22, d + overhang * 2),
        roofMaterial,
        [side * (halfSpan / 2), kit.wallHeight + 0.2 + kit.roofHeight / 2, 0],
      );
      panel.rotation.z = side * -angle;
    }
    // Gable trim triangles.
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    shape.lineTo(0, kit.roofHeight);
    shape.closePath();
    const gableGeometry = new THREE.ShapeGeometry(shape);
    for (const side of [-1, 1]) {
      const gable = addMesh(group, gableGeometry.clone(), wallMaterial, [0, kit.wallHeight + 0.2, side * (d / 2 + 0.01)]);
      gable.rotation.y = side === 1 ? 0 : Math.PI;
      (gable.material as THREE.Material).side = THREE.DoubleSide;
    }
  } else if (kit.roofStyle === 'cone' || kit.roofStyle === 'dome') {
    if (spec.kind === 'windmill') {
      const roof = addMesh(group, new THREE.ConeGeometry(w * 0.78, kit.roofHeight, 8), roofMaterial, [0, kit.wallHeight + kit.roofHeight / 2 + 0.2, 0]);
      roof.rotation.y = Math.PI / 8;
    } else if (spec.kind === 'silo') {
      const dome = addMesh(
        group,
        new THREE.SphereGeometry(w / 2 + 0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        roofMaterial,
        [0, kit.wallHeight + 0.2, 0],
      );
      dome.castShadow = true;
      for (let ring = 0; ring < 3; ring += 1) {
        const band = addMesh(
          group,
          new THREE.TorusGeometry(w / 2 + 0.06, 0.07, 4, 16),
          trimMaterial,
          [0, 1.6 + ring * 1.9, 0],
        );
        band.rotation.x = Math.PI / 2;
      }
    } else {
      const roof = addMesh(group, new THREE.ConeGeometry(w * 0.8, kit.roofHeight, 8), roofMaterial, [0, kit.wallHeight + kit.roofHeight / 2 + 0.2, 0]);
      roof.rotation.y = Math.PI / 8;
    }
  } else if (kit.roofStyle === 'hip') {
    const roof = addMesh(group, new THREE.ConeGeometry(w * 0.75, kit.roofHeight, 4), roofMaterial, [0, kit.wallHeight + kit.roofHeight / 2 + 0.2, 0]);
    roof.rotation.y = Math.PI / 4;
  } else {
    addMesh(group, new THREE.BoxGeometry(w + 0.5, 0.24, d + 0.5), roofMaterial, [0, kit.wallHeight + 0.3, 0]);
  }

  // Door + windows.
  if (!openSided) {
    addMesh(group, new THREE.BoxGeometry(1.2, 1.9, 0.12), darkMaterial, [0, 1.15, d / 2 + 0.02]);
    const windowCount = Math.max(1, Math.floor(w / 3));
    for (let index = 0; index < windowCount; index += 1) {
      const offset = (index - (windowCount - 1) / 2) * 2.2;
      addMesh(group, new THREE.BoxGeometry(0.8, 0.8, 0.1), glowMaterial, [offset, kit.wallHeight * 0.68, d / 2 + 0.04]);
    }
  }

  // Accent details per kind.
  if (spec.kind === 'farmhouse') {
    // Porch + chimney + flower boxes.
    addMesh(group, new THREE.BoxGeometry(w * 0.8, 0.22, 1.8), trimMaterial, [0, 0.3, d / 2 + 1.0]);
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.16, 2.2, 0.16), trimMaterial, [sx * w * 0.34, 1.4, d / 2 + 1.75]);
    }
    addMesh(group, new THREE.BoxGeometry(w * 0.72, 0.18, 2.0), roofMaterial, [0, 2.55, d / 2 + 1.0]);
    const chimney = addMesh(group, new THREE.BoxGeometry(0.8, 2.0, 0.8), material(materials, '#b06a4a'), [-w * 0.28, kit.wallHeight + kit.roofHeight + 0.4, -d * 0.2]);
    chimney.rotation.y = 0.2;
    for (let index = 0; index < 3; index += 1) {
      addMesh(group, new THREE.BoxGeometry(1.3, 0.24, 0.34), trimMaterial, [w * 0.1 + index * 1.4, 0.72, d / 2 + 0.5]);
      addMesh(group, new THREE.IcosahedronGeometry(0.2, 0), material(materials, '#d0665a'), [w * 0.1 + index * 1.4, 0.9, d / 2 + 0.5]);
    }
    // hanging sign
    addMesh(group, new THREE.BoxGeometry(1.2, 0.5, 0.08), accentMaterial, [w * 0.3, 2.0, d / 2 + 0.1]);
  } else if (spec.kind === 'barn') {
    // Big painted doors + cross brace + hay loft.
    const doorMaterial = material(materials, '#7c2f27');
    addMesh(group, new THREE.BoxGeometry(3.4, 3.0, 0.16), doorMaterial, [0, 1.7, d / 2 + 0.04]);
    for (const sx of [-1, 1]) {
      const brace = addMesh(group, new THREE.BoxGeometry(0.16, 3.4, 0.1), material(materials, '#efe7d6'), [sx * 1.4, 1.7, d / 2 + 0.14]);
      brace.rotation.z = sx * 0.45;
    }
    addMesh(group, new THREE.BoxGeometry(1.4, 1.1, 0.1), darkMaterial, [0, kit.wallHeight * 0.82, d / 2 + 0.06]);
    const hayLoft = addMesh(group, new THREE.BoxGeometry(1.6, 0.8, 0.4), material(materials, PALETTE.hay), [0, kit.wallHeight * 0.82 + 0.9, d / 2 + 0.2]);
    hayLoft.castShadow = false;
  } else if (spec.kind === 'windmill') {
    // Sails — animated.
    const hub = new THREE.Group();
    hub.position.set(0, kit.wallHeight + 0.2, d / 2 + 0.7);
    const sailGroup = new THREE.Group();
    for (let index = 0; index < 4; index += 1) {
      const sail = new THREE.Group();
      sail.rotation.z = (index / 4) * Math.PI * 2;
      addMesh(sail, new THREE.BoxGeometry(0.28, 6.6, 0.2), trimMaterial, [0, 3.3, 0]);
      addMesh(sail, new THREE.BoxGeometry(1.1, 5.6, 0.08), material(materials, '#f3e6c8'), [0.6, 3.4, 0.06]);
      sailGroup.add(sail);
    }
    addMesh(sailGroup, new THREE.CylinderGeometry(0.4, 0.4, 0.5, 8), trimMaterial, [0, 0, 0.1]).rotation.x = Math.PI / 2;
    hub.add(sailGroup);
    group.add(hub);
    animated.push((elapsed) => {
      sailGroup.rotation.z = elapsed * 0.55;
    });
    // balcony
    addMesh(group, new THREE.BoxGeometry(w + 1.0, 0.16, w + 1.0), trimMaterial, [0, kit.wallHeight * 0.55, 0]);
  } else if (spec.kind === 'market') {
    for (let index = 0; index < 3; index += 1) {
      const stripe = addMesh(
        group,
        new THREE.BoxGeometry(w * 0.34, 0.1, d * 0.9),
        material(materials, index % 2 === 0 ? '#f4e7c3' : spec.id.endsWith('b') ? '#4f7da0' : '#c95a4b'),
        [(index - 1) * w * 0.33, kit.wallHeight + 0.42, 0],
      );
      stripe.rotation.z = 0.24;
    }
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.1, 2.1, 0.1), trimMaterial, [sx * (w / 2 - 0.2), 1.05, d / 2 - 0.2]);
      addMesh(group, new THREE.BoxGeometry(0.1, 2.1, 0.1), trimMaterial, [sx * (w / 2 - 0.2), 1.05, -d / 2 + 0.2]);
    }
  } else if (spec.kind === 'henPalace') {
    // Battlements + crown + banners.
    for (let index = 0; index < 6; index += 1) {
      addMesh(group, new THREE.BoxGeometry(0.8, 1.1, 0.8), wallMaterial, [-w / 2 + 0.7 + index * (w - 1.4) / 5, kit.wallHeight + 0.8, d / 2 - 0.2]);
    }
    const crown = new THREE.Group();
    crown.position.set(0, kit.wallHeight + kit.roofHeight + 0.9, 0);
    for (let index = 0; index < 5; index += 1) {
      const angle = (index / 5) * Math.PI * 2;
      addMesh(crown, new THREE.ConeGeometry(0.18, 0.7, 4), material(materials, '#ffd166'), [Math.cos(angle) * 0.5, 0.25, Math.sin(angle) * 0.5]);
    }
    addMesh(crown, new THREE.TorusGeometry(0.52, 0.11, 5, 16), material(materials, '#ffd166'), [0, 0, 0]).rotation.x = Math.PI / 2;
    group.add(crown);
    for (const side of [-1, 1]) {
      const banner = addMesh(group, new THREE.BoxGeometry(1.2, 2.6, 0.06), material(materials, '#8d2f3f'), [side * (w / 2 - 0.4), kit.wallHeight - 1.2, -d / 2 - 0.12]);
      banner.castShadow = false;
      addMesh(group, new THREE.ConeGeometry(0.14, 0.4, 4), material(materials, '#ffd166'), [side * (w / 2 - 0.4), kit.wallHeight + 0.3, -d / 2 - 0.12]);
    }
    // Columns at the entrance.
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.CylinderGeometry(0.4, 0.5, 4.2, 8), material(materials, PALETTE.stone), [sx * 3.0, 2.1, d / 2 + 0.9]);
      addMesh(group, new THREE.BoxGeometry(1.1, 0.3, 1.1), material(materials, PALETTE.stoneDark), [sx * 3.0, 4.3, d / 2 + 0.9]);
    }
    // throne of hay visible through the entrance.
    addMesh(group, new THREE.BoxGeometry(3.0, 0.9, 1.6), material(materials, PALETTE.hay), [0, 0.65, -1.6]);
    addMesh(group, new THREE.BoxGeometry(3.0, 3.2, 0.6), material(materials, PALETTE.hayDark), [0, 2.0, -2.4]);
  } else if (spec.kind === 'stable') {
    // Half-doors + barrel.
    addMesh(group, new THREE.BoxGeometry(1.8, 1.4, 0.12), darkMaterial, [0, 0.9, d / 2 + 0.03]);
    addMesh(group, new THREE.BoxGeometry(1.8, 0.12, 0.14), trimMaterial, [0, 1.6, d / 2 + 0.05]);
    const barrel = addMesh(group, new THREE.CylinderGeometry(0.42, 0.48, 1.0, 8), material(materials, PALETTE.woodLight), [-w / 2 - 0.9, 0.5, d / 2 - 0.8]);
    barrel.rotation.y = 0.4;
    for (let index = 0; index < 3; index += 1) {
      addMesh(group, new THREE.BoxGeometry(0.5, 0.35, 0.5), material(materials, PALETTE.hay), [w / 2 + 0.7 + index * 0.55, 0.18, -d / 2 + 0.6]);
    }
  } else if (spec.kind === 'nursery') {
    // Little chicken ramp + perch.
    const ramp = addMesh(group, new THREE.BoxGeometry(0.9, 0.08, 2.0), trimMaterial, [0, 0.45, d / 2 + 0.9]);
    ramp.rotation.x = 0.2;
    addMesh(group, new THREE.BoxGeometry(w + 0.6, 0.1, 0.12), trimMaterial, [0, 1.4, d / 2 + 0.3]);
  } else if (spec.kind === 'duckHouse') {
    // Landing dock + ramp.
    addMesh(group, new THREE.BoxGeometry(2.4, 0.14, 2.4), material(materials, PALETTE.woodLight), [0, 0.3, d / 2 + 1.5]);
    for (const sx of [-1, 1]) {
      addMesh(group, new THREE.BoxGeometry(0.12, 0.9, 2.4), trimMaterial, [sx * 1.1, 0.4, d / 2 + 1.5]);
    }
  } else if (spec.kind === 'tower') {
    // Watch platform + flag.
    addMesh(group, new THREE.BoxGeometry(w + 1.2, 0.2, w + 1.2), trimMaterial, [0, kit.wallHeight + 0.4, 0]);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addMesh(group, new THREE.BoxGeometry(0.12, 1.3, 0.12), trimMaterial, [sx * (w / 2 + 0.4), kit.wallHeight + 1.1, sz * (w / 2 + 0.4)]);
      }
    }
    addMesh(group, new THREE.CylinderGeometry(0.06, 0.06, 2.4, 4), trimMaterial, [0, kit.wallHeight + 2.6, 0]);
    const flag = addMesh(group, new THREE.PlaneGeometry(1.4, 0.7), material(materials, '#c95a4b', { side: THREE.DoubleSide }), [0.72, kit.wallHeight + 3.2, 0]);
    flag.castShadow = false;
  } else if (spec.kind === 'shed' || spec.kind === 'scarecrowShed') {
    for (let index = 0; index < 3; index += 1) {
      addMesh(
        group,
        new THREE.CylinderGeometry(0.08, 0.08, 1.4, 4),
        trimMaterial,
        [w / 2 + 0.3 + index * 0.2, 0.7, -d / 2 + 0.4 + index * 0.3],
      );
    }
  } else if (spec.kind === 'dogHouse') {
    // A kennel: arched door, water bowl, and a bone on the roof ridge.
    const arch = addMesh(group, new THREE.CylinderGeometry(0.62, 0.62, 0.14, 12, 1, false, 0, Math.PI), darkMaterial, [0, 1.0, d / 2 + 0.04]);
    arch.rotation.z = Math.PI;
    addMesh(group, new THREE.CylinderGeometry(0.5, 0.5, 0.12, 5), material(materials, '#c9d3d8'), [w * 0.72, 0.2, d / 2 + 0.7]);
    const bone = addMesh(group, new THREE.CylinderGeometry(0.07, 0.07, 0.7, 5), material(materials, '#f2ecdd'), [0, kit.wallHeight + kit.roofHeight + 0.42, 0]);
    bone.rotation.z = Math.PI / 2;
    addMesh(group, new THREE.SphereGeometry(0.1, 6, 5), material(materials, '#f2ecdd'), [-0.38, kit.wallHeight + kit.roofHeight + 0.42, 0]);
    addMesh(group, new THREE.SphereGeometry(0.1, 6, 5), material(materials, '#f2ecdd'), [0.38, kit.wallHeight + kit.roofHeight + 0.42, 0]);
    // Name plate, because a boss lives here.
    addMesh(group, new THREE.BoxGeometry(1.1, 0.42, 0.07), material(materials, PALETTE.accent), [0, 1.75, d / 2 + 0.1]);
  } else if (spec.kind === 'threshingGranary') {
    // Grain sacks and a millstone on the open bay floor.
    for (let index = 0; index < 4; index += 1) {
      const sack = addMesh(
        group,
        new THREE.SphereGeometry(0.5, 7, 6),
        material(materials, PALETTE.hay),
        [-1.2 + index * 0.85, 0.55, d / 2 - 1.6 + (index % 2) * 0.5],
      );
      sack.scale.set(0.85, 1.05, 0.8);
    }
    const stone = addMesh(group, new THREE.CylinderGeometry(1.05, 1.05, 0.28, 14), material(materials, PALETTE.stone), [w / 2 - 1.6, 0.16, -d / 2 + 1.4]);
    stone.rotation.x = Math.PI / 2;
  }

  // A tiny lantern by the door of most buildings.
  if (spec.kind !== 'silo') {
    addMesh(
      group,
      new THREE.BoxGeometry(0.26, 0.34, 0.26),
      glowMaterial,
      [w / 2 - 0.5, 2.3, d / 2 + 0.16],
    );
  }

  root.add(group);
}

/* ============================================================= critters */

/** Hand-placed cartoon farm animals: chickens, sheep, ducks, goat, fox. */
function buildCritters(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
  animated: ((elapsed: number) => void)[],
  arenas: ArenaDef[],
) {
  const cream = material(materials, '#f4ead4', { roughness: 0.95 });
  const white = material(materials, '#f7f3ea', { roughness: 0.95 });
  const red = material(materials, '#c1503d', { roughness: 0.9 });
  const orange = material(materials, '#e6a23c', { roughness: 0.9 });
  const black = material(materials, '#2f2a26', { roughness: 1 });
  const wool = material(materials, '#efe9dc', { roughness: 1 });
  const duckGreen = material(materials, '#4e7d5a', { roughness: 0.95 });
  const brown = material(materials, '#8a6a4a', { roughness: 0.95 });
  const foxFur = material(materials, '#e07a3c', { roughness: 0.92 });
  const foxLight = material(materials, '#f7e3c4', { roughness: 0.95 });

  const makeChicken = (scale = 1, body = cream) => {
    const chicken = new THREE.Group();
    const bodyMesh = addMesh(chicken, new THREE.SphereGeometry(0.34, 8, 6), body, [0, 0.34, 0]);
    bodyMesh.scale.set(1, 0.92, 1.18);
    addMesh(chicken, new THREE.SphereGeometry(0.19, 8, 6), body, [0, 0.66, 0.18]);
    addMesh(chicken, new THREE.ConeGeometry(0.07, 0.16, 4), orange, [0, 0.63, 0.38]).rotation.x = Math.PI / 2;
    addMesh(chicken, new THREE.SphereGeometry(0.055, 6, 5), red, [0, 0.83, 0.16]);
    addMesh(chicken, new THREE.ConeGeometry(0.05, 0.14, 4), red, [0, 0.84, 0.05]);
    addMesh(chicken, new THREE.ConeGeometry(0.05, 0.14, 4), red, [0, 0.84, 0.18]);
    const tail = addMesh(chicken, new THREE.ConeGeometry(0.16, 0.4, 5), body, [0, 0.5, -0.3]);
    tail.rotation.x = -0.9;
    for (const side of [-1, 1]) {
      addMesh(chicken, new THREE.CylinderGeometry(0.02, 0.02, 0.2, 4), orange, [side * 0.1, 0.1, 0.05]);
    }
    chicken.scale.setScalar(scale);
    return chicken;
  };

  const makeSheep = (scale = 1) => {
    const sheep = new THREE.Group();
    addMesh(sheep, new THREE.IcosahedronGeometry(0.52, 1), wool, [0, 0.62, 0]).scale.set(1.25, 0.9, 1.0);
    addMesh(sheep, new THREE.SphereGeometry(0.25, 7, 6), black, [0, 0.62, 0.52]);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addMesh(sheep, new THREE.CylinderGeometry(0.055, 0.05, 0.42, 4), black, [sx * 0.24, 0.2, sz * 0.3]);
      }
    }
    sheep.scale.setScalar(scale);
    return sheep;
  };

  const makeDuck = (scale = 1) => {
    const duck = new THREE.Group();
    addMesh(duck, new THREE.SphereGeometry(0.24, 8, 6), duckGreen, [0, 0.18, 0]).scale.set(1, 0.8, 1.3);
    addMesh(duck, new THREE.SphereGeometry(0.15, 7, 6), duckGreen, [0, 0.42, 0.18]);
    addMesh(duck, new THREE.BoxGeometry(0.12, 0.05, 0.16), orange, [0, 0.41, 0.36]);
    duck.scale.setScalar(scale);
    return duck;
  };

  const makeFox = () => {
    const foxGroup = new THREE.Group();
    const body = addMesh(foxGroup, new THREE.SphereGeometry(0.42, 9, 7), foxFur, [0, 0.46, 0]);
    body.scale.set(1, 0.86, 1.5);
    addMesh(foxGroup, new THREE.SphereGeometry(0.12, 7, 6), foxLight, [0, 0.4, 0.52]);
    const head = new THREE.Group();
    head.position.set(0, 0.72, 0.46);
    addMesh(head, new THREE.SphereGeometry(0.26, 9, 7), foxFur, [0, 0, 0]);
    const snout = addMesh(head, new THREE.ConeGeometry(0.16, 0.36, 6), foxLight, [0, -0.03, 0.28]);
    snout.rotation.x = Math.PI / 2;
    addMesh(head, new THREE.SphereGeometry(0.05, 6, 5), black, [0, 0, 0.46]);
    for (const side of [-1, 1]) {
      const ear = addMesh(head, new THREE.ConeGeometry(0.11, 0.26, 4), foxFur, [side * 0.14, 0.24, -0.02]);
      ear.rotation.z = side * 0.2;
      addMesh(head, new THREE.SphereGeometry(0.03, 5, 4), black, [side * 0.1, 0.04, 0.22]);
    }
    foxGroup.add(head);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addMesh(foxGroup, new THREE.CylinderGeometry(0.06, 0.05, 0.4, 5), brown, [sx * 0.2, 0.2, sz * 0.34]);
      }
    }
    const tail = addMesh(foxGroup, new THREE.SphereGeometry(0.2, 7, 6), foxFur, [0, 0.52, -0.66]);
    tail.scale.set(0.8, 0.8, 2.0);
    const tip = addMesh(foxGroup, new THREE.SphereGeometry(0.13, 6, 5), foxLight, [0, 0.55, -0.98]);
    tip.scale.set(0.9, 0.9, 1.3);
    foxGroup.scale.setScalar(1.5);
    return { group: foxGroup, head };
  };

  /**
   * Drops a packed animal on the terrain at a given world height.
   *
   * Heads-up that the pack is authored in animal units and the old animals were
   * authored in world units, so every call names the height it wants. A cow at
   * 2.6 stands shoulder-high to a 6.6 farmhouse, which is the ratio the old
   * procedural herd had; guessing from the model's own scale gives mice.
   */
  const placeAnimal = (model: string, x: number, z: number, rotation: number, height: number) => {
    const loaded = getModel(model);
    if (!loaded) return null;
    const group = loaded.group.clone(true);
    group.scale.setScalar(height / loaded.height);
    // Authored coordinates: `buildMapScene` has already scaled the data, so
    // passing data-space numbers here put the herd in the middle of the farm.
    group.position.set(x * WORLD_SCALE, heightAt(x * WORLD_SCALE, z * WORLD_SCALE), z * WORLD_SCALE);
    group.rotation.y = rotation;
    root.add(group);
    critters.push({ group, phase: x * 0.7 + z * 0.3, spin: 0.05 + ((x + z) % 7) * 0.01 });
    return group;
  };

  const critters: { group: THREE.Group; phase: number; spin: number }[] = [];
  const place = (group: THREE.Group, x: number, z: number, rotation: number) => {
    group.position.set(x, heightAt(x, z), z);
    group.rotation.y = rotation;
    root.add(group);
    critters.push({ group, phase: x * 0.7 + z * 0.3, spin: 0.05 + ((x + z) % 7) * 0.01 });
    return group;
  };

  // Chickens in and around the farm.
  const chickenSpots: [number, number, number][] = [
    [8, 40, 0.4], [12, 42, 2.1], [-6, 34, 1.2], [16, 30, 3.0], [-16, 62, 0.8],
    [22, 66, 1.7], [-30, 24, 2.6], [34, 22, 0.2], [2, 12, 1.4], [-24, 18, 2.9],
  ];
  for (const [x, z, r] of chickenSpots) place(makeChicken(0.9 + hash2(x, z) * 0.3), x, z, r);

  // Hens in the runs.
  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 2;
    place(makeChicken(0.8), -34 + Math.cos(angle) * 5, -52 + Math.sin(angle) * 4.4, angle * 2);
  }
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2 + 0.6;
    place(makeChicken(0.8), 26 + Math.cos(angle) * 4.4, -54 + Math.sin(angle) * 3.8, angle);
  }
  // Around the palace.
  for (let index = 0; index < 6; index += 1) {
    place(makeChicken(0.95), -66 + index * 4.4, -118 + (index % 2) * 5, index * 0.7);
  }

  // Sheep on the pasture and around the ram ring.
  const sheepSpots: [number, number][] = [
    [52, -70], [58, -76], [46, -72], [66, -72], [70, -78], [54, -64], [30, -80], [24, -72],
  ];
  for (const [x, z] of sheepSpots) place(makeSheep(0.95 + hash2(x, z) * 0.2), x, z, hash2(z, x) * 6);

  // Ducks on the pond and the river.
  const duckSpots: [number, number][] = [
    [-58, -60], [-54, -56], [-62, -64], [-50, -62], [-60, -68],
  ];
  for (const [x, z] of duckSpots) {
    const duck = makeDuck(1);
    duck.position.set(x, -0.4, z);
    duck.rotation.y = hash2(x, z) * 6;
    root.add(duck);
    critters.push({ group: duck, phase: x + z, spin: 0.12 });
  }
  for (const [x, z] of [[-20, -78], [28, -84], [62, -74]] as [number, number][]) {
    const duck = makeDuck(0.9);
    duck.position.set(x, -0.45, z);
    root.add(duck);
    critters.push({ group: duck, phase: x, spin: 0.1 });
  }

  /**
   * The herd.
   *
   * The old pasture had eight procedural sheep and two goats. The packs here have
   * no sheep (that is Quaternius's separate Farm Animals set), so the pasture is
   * stocked with what the animal pack actually has: cattle, horses, a donkey, a
   * bull. Silhouettes are what matter from the air, and a mixed herd reads as a
   * working farm far better than eight identical white blobs did.
   */
  // Kept clear of the roads that cut across the pasture: a cow standing in a
  // cart track reads as a bug, not as livestock.
  const herd: { model: string; x: number; z: number; rotation: number; height: number }[] = [
    { model: 'Cow', x: 47, z: -75, rotation: 0.4, height: 2.6 },
    { model: 'Cow', x: 60, z: -73, rotation: 2.6, height: 2.5 },
    { model: 'Bull', x: 66, z: -79, rotation: 1.1, height: 2.9 },
    { model: 'Cow', x: 57, z: -82, rotation: -0.8, height: 2.4 },
    { model: 'Donkey', x: 72, z: -86, rotation: 2.2, height: 2.5 },
    { model: 'Horse', x: 43, z: -88, rotation: 3.4, height: 3.1 },
    { model: 'Horse', x: 70, z: -69, rotation: 0.9, height: 3.0 },
    { model: 'Alpaca', x: 51, z: -89, rotation: 5.1, height: 2.4 },
    { model: 'Alpaca', x: 37, z: -76, rotation: 3.9, height: 2.2 },
  ];
  for (const animal of herd) {
    placeAnimal(animal.model, animal.x, animal.z, animal.rotation, animal.height);
  }

  // Two farm dogs by the kennel, and a deer at the edge of the wood.
  placeAnimal('Husky', 44, 70, 2.4, 1.8);
  placeAnimal('ShibaInu', 36, 64, 0.7, 1.6);
  placeAnimal('Deer', 77, -95, 2.4, 2.6);

  // A goat by the stable and a second in the paddock.
  const makeGoat = () => {
    const goat = new THREE.Group();
    addMesh(goat, new THREE.SphereGeometry(0.4, 8, 6), white, [0, 0.55, 0]).scale.set(1, 0.8, 1.4);
    const head = new THREE.Group();
    head.position.set(0, 0.78, 0.5);
    addMesh(head, new THREE.SphereGeometry(0.2, 7, 6), white, [0, 0, 0]);
    addMesh(head, new THREE.BoxGeometry(0.14, 0.14, 0.2), white, [0, -0.04, 0.2]);
    for (const side of [-1, 1]) {
      const horn = addMesh(head, new THREE.ConeGeometry(0.05, 0.3, 4), brown, [side * 0.08, 0.18, -0.02]);
      horn.rotation.z = side * 0.6;
    }
    goat.add(head);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addMesh(goat, new THREE.CylinderGeometry(0.045, 0.04, 0.44, 4), brown, [sx * 0.18, 0.22, sz * 0.3]);
      }
    }
    goat.scale.setScalar(1.1);
    return goat;
  };
  place(makeGoat(), 58, -52, 2.4);
  place(makeGoat(), 52, -62, 0.6);

  // The fox — the player — at the trailhead, with an idle bob and look-around.
  const { group: foxGroup, head: foxHead } = makeFox();
  const fox = place(foxGroup, 0, 143, Math.PI);
  animated.push((elapsed) => {
    fox.position.y = heightAt(0, 143) + Math.max(0, Math.sin(elapsed * 1.6)) * 0.05;
    foxHead.rotation.y = Math.sin(elapsed * 0.5) * 0.5;
  });

  // Bosses: an oversized version of each animal standing in its arena ring.
  const bossAnimals: { id: string; make: () => THREE.Group }[] = [
    { id: 'squawk', make: () => makeChicken(2.7, material(materials, '#d7784c')) },
    { id: 'quackmire', make: () => makeDuck(3.2) },
    { id: 'bristleback', make: () => makeSheep(2.4) },
  ];
  // Bosses stand *in* their home ground: the rooster on his yard post step, the
  // duck floating on her pond, the ram in his stone ring.
  const bossPositions: Record<string, [number, number]> = {
    squawk: [2, -10],
    quackmire: [12, -96],
    bristleback: [44, -98],
  };
  for (const boss of bossAnimals) {
    const position = bossPositions[boss.id]!;
    const group = boss.make();
    // The duck floats: her base sits on the water plane, not on the bank.
    const y = boss.id === 'quackmire' ? -0.1 : heightAt(position[0], position[1]);
    group.position.set(position[0], y + 0.2, position[1]);
    group.rotation.y = Math.PI * 0.9;
    group.name = `boss-${boss.id}`;
    root.add(group);
    animated.push((elapsed) => {
      group.position.y = y + 0.2 + Math.sin(elapsed * 1.2 + position[0]) * 0.06;
    });
  }

  // Turkey (Grobak) — the only bespoke boss silhouette.
  const turkey = new THREE.Group();
  addMesh(turkey, new THREE.SphereGeometry(0.62, 9, 7), brown, [0, 0.95, 0]).scale.set(1, 1.05, 1.15);
  addMesh(turkey, new THREE.SphereGeometry(0.3, 8, 6), material(materials, '#d9b48a'), [0, 1.65, 0.2]);
  addMesh(turkey, new THREE.ConeGeometry(0.11, 0.34, 5), orange, [0, 1.6, 0.5]).rotation.x = Math.PI / 2;
  addMesh(turkey, new THREE.SphereGeometry(0.12, 6, 5), red, [0, 1.52, 0.42]);
  for (let index = 0; index < 7; index += 1) {
    const angle = (index / 7) * Math.PI * 1.4 + Math.PI * 0.8;
    const feather = addMesh(
      turkey,
      new THREE.ConeGeometry(0.14, 0.9, 4),
      index % 2 === 0 ? brown : material(materials, '#b0875c'),
      [Math.cos(angle) * 0.5, 1.05 + Math.sin(angle) * 0.1, Math.sin(angle) * 0.5 - 0.3],
    );
    feather.rotation.z = angle * 0.4;
    feather.rotation.x = -0.5;
  }
  for (const sx of [-1, 1]) {
    addMesh(turkey, new THREE.CylinderGeometry(0.08, 0.07, 0.7, 4), orange, [sx * 0.28, 0.35, 0.1]);
  }
  // Straw hat, because he is a farmhand.
  const hat = addMesh(turkey, new THREE.CylinderGeometry(0.42, 0.46, 0.12, 10), material(materials, PALETTE.hay), [0, 1.95, 0.14]);
  hat.rotation.x = 0.12;
  addMesh(turkey, new THREE.CylinderGeometry(0.22, 0.26, 0.24, 10), material(materials, PALETTE.hayDark), [0, 2.08, 0.14]);
  // Pitchfork.
  const fork = addMesh(turkey, new THREE.CylinderGeometry(0.045, 0.045, 3.2, 5), material(materials, PALETTE.woodDark), [0.78, 1.6, 0.1]);
  fork.rotation.z = 0.12;
  for (let index = 0; index < 3; index += 1) {
    addMesh(turkey, new THREE.ConeGeometry(0.05, 0.34, 4), material(materials, '#aab0b4'), [0.62 + index * 0.16, 3.28, 0.1]);
  }
  turkey.position.set(-26, heightAt(-26, 44) + 0.2, 44);
  turkey.rotation.y = Math.PI * 0.45;
  turkey.name = 'boss-grobak';
  root.add(turkey);
  animated.push((elapsed) => {
    turkey.position.y = heightAt(-26, 44) + 0.2 + Math.sin(elapsed * 1.1) * 0.07;
  });

  // The final boss: Cluckzilla on her hay throne.
  //
  // She sat at 0.2 above the yard with a 4.2-tall throne back right behind her, so
  // from the approach the back wall swallowed the head and wings and she read as a
  // white boulder. Scaled down, lifted onto the throne dais, and turned to face
  // the yard she rules.
  const queenScale = 0.72;
  const queen = new THREE.Group();
  const queenBody = addMesh(queen, new THREE.SphereGeometry(1.7, 12, 9), white, [0, 2.1, 0]);
  queenBody.scale.set(1.1, 1.15, 1.25);
  addMesh(queen, new THREE.SphereGeometry(1.0, 10, 8), white, [0, 3.9, 0.5]);
  addMesh(queen, new THREE.ConeGeometry(0.34, 0.8, 5), orange, [0, 3.8, 1.5]).rotation.x = Math.PI / 2;
  // Wattle and the comb she was missing: a hen without a red comb is a snowman.
  addMesh(queen, new THREE.SphereGeometry(0.26, 7, 6), red, [0, 3.5, 1.32]);
  for (let index = 0; index < 3; index += 1) {
    addMesh(
      queen,
      new THREE.SphereGeometry(0.3 - index * 0.05, 7, 6),
      red,
      [0, 4.72 + index * 0.16, 0.62 - index * 0.2],
    ).scale.set(0.55, 1, 1.1);
  }
  for (const side of [-1, 1]) {
    const wing = addMesh(queen, new THREE.SphereGeometry(0.75, 8, 6), cream, [side * 1.7, 2.2, 0]);
    wing.scale.set(0.5, 1.1, 1.4);
    wing.rotation.z = side * 0.3;
    addMesh(queen, new THREE.SphereGeometry(0.09, 6, 5), black, [side * 0.32, 4.15, 1.15]);
  }
  // Tail feathers, fanned behind the throne.
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 4 - 0.5) * 0.9;
    addMesh(
      queen,
      new THREE.ConeGeometry(0.16, 1.5, 4),
      cream,
      [Math.sin(angle) * 0.9, 2.6 + Math.cos(angle) * 0.4, -1.75],
    ).rotation.set(-0.55, 0, -angle * 0.8);
  }
  // Crown.
  const queenCrown = new THREE.Group();
  queenCrown.position.set(0, 4.95, 0.6);
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    addMesh(queenCrown, new THREE.ConeGeometry(0.14, 0.58, 4), material(materials, '#ffd166'), [Math.cos(angle) * 0.4, 0.3, Math.sin(angle) * 0.4]);
  }
  addMesh(queenCrown, new THREE.TorusGeometry(0.42, 0.09, 5, 14), material(materials, '#ffd166'), [0, 0, 0]).rotation.x = Math.PI / 2;
  queen.add(queenCrown);
  queen.scale.setScalar(queenScale);

  // The throne is her stage, so it is its own group: sized in world units, she
  // sits on it, and the dais keeps her above the carpet.
  const throne = new THREE.Group();
  addMesh(throne, new THREE.BoxGeometry(5.4, 0.5, 4.2), material(materials, PALETTE.hayDark), [0, 0.25, -0.6]);
  addMesh(throne, new THREE.BoxGeometry(4.6, 1.5, 3.0), material(materials, PALETTE.hay), [0, 1.15, -1.0]);
  addMesh(throne, new THREE.BoxGeometry(4.6, 5.0, 0.7), material(materials, PALETTE.hayDark), [0, 3.0, -2.7]);
  for (const side of [-1, 1]) {
    addMesh(throne, new THREE.BoxGeometry(0.5, 4.4, 0.6), material(materials, PALETTE.woodDark), [side * 2.0, 3.0, -2.65]);
  }
  // Anchored to the palace arena, not to a literal copied from the old layout.
  const palaceArena = arenas.find((arena) => arena.style === 'palace');
  const queenX = palaceArena?.position[0] ?? -46;
  const queenZ = palaceArena?.position[1] ?? -124;
  const queenY = heightAt(queenX, queenZ) + 0.2;
  throne.position.set(queenX, queenY, queenZ + 1.5);
  throne.name = 'throne-cluckzilla';
  root.add(throne);
  // Seat centre is one unit behind the throne origin, so she stands exactly on it.
  queen.position.set(queenX, queenY + 1.42, queenZ + 1.5);
  // Facing the yard: the approach comes from +Z, and she should be looking at it.
  queen.rotation.y = 0;
  queen.name = 'boss-cluckzilla';
  root.add(queen);
  animated.push((elapsed) => {
    queenCrown.rotation.y = elapsed * 0.5;
    queen.position.y = queenY + 1.42 + Math.sin(elapsed * 0.9 + 2) * 0.05;
  });

  // Idle wander for critters: tiny bobbing, no pathfinding needed at map scale.
  animated.push((elapsed) => {
    for (const critter of critters) {
      critter.group.position.y += Math.sin(elapsed * 2.2 + critter.phase) * 0.0006;
      critter.group.rotation.y += Math.sin(elapsed * 0.4 + critter.phase) * 0.0012;
    }
  });
}

/* =========================================================== mountain range */

/**
 * The violet peak on the skyline.
 *
 * The reference has one dominant snow-capped mountain closing the view to the
 * north, with a lower blue range either side of it and a second, warmer ridge to
 * the east. That silhouette is most of what makes the valley look like a place
 * with a horizon, so it is authored as a fixed composition rather than scattered
 * at random: a random range always ends up with two peaks of equal height
 * fighting for the same focal point.
 *
 * These are painted, never picked: they are outside the playfield by a factor of
 * ten, and `decorative` keeps the pointer picker off them.
 */
interface MountainSpec {
  /** World position of the peak's footprint centre. */
  x: number;
  z: number;
  /** Radius at the base and peak height above the horizon plane. */
  radius: number;
  height: number;
  /** How far the base is pulled in on X: a ridge is never a circle. */
  stretchX: number;
  stretchZ: number;
  /** Number of facets around the cone: low counts read as cut stone. */
  facets: number;
  rotation: number;
  colour: string;
  /** Height (0-1 of the peak) above which snow starts, 0 = no snow. */
  snowLine: number;
}

const MOUNTAINS: MountainSpec[] = [
  // The hero peak: straight north, snow-capped, and deliberately the tallest
  // thing in the frame. Everything else is scaled against it.
  { x: 60, z: -1500, radius: 320, height: 700, stretchX: 1.5, stretchZ: 1.0, facets: 11, rotation: 0.4, colour: '#8b7cb5', snowLine: 0.58 },
  // Its shoulders: lower, colder, and set back so they never compete with it.
  { x: -420, z: -1420, radius: 225, height: 380, stretchX: 1.6, stretchZ: 0.95, facets: 9, rotation: 1.1, colour: '#8f88b8', snowLine: 0.7 },
  { x: 560, z: -1400, radius: 245, height: 430, stretchX: 1.55, stretchZ: 1.0, facets: 10, rotation: 2.3, colour: '#8d80b8', snowLine: 0.66 },
  // West and east walls: steep wooded slopes right behind the treeline, which is
  // what closes the valley on both sides in the reference.
  { x: -1320, z: -820, radius: 340, height: 260, stretchX: 1.5, stretchZ: 1.0, facets: 9, rotation: 0.2, colour: '#7d9a60', snowLine: 0 },
  { x: 1330, z: -790, radius: 360, height: 280, stretchX: 1.5, stretchZ: 1.0, facets: 9, rotation: 1.7, colour: '#81a064', snowLine: 0 },
  // Low warm ridges east and west of the fields: no snow, just rock catching sun.
  { x: 1420, z: 180, radius: 260, height: 150, stretchX: 1.0, stretchZ: 1.7, facets: 9, rotation: 0.15, colour: '#a68a92', snowLine: 0 },
  { x: -1420, z: 60, radius: 250, height: 140, stretchX: 1.0, stretchZ: 1.6, facets: 9, rotation: 0.0, colour: '#a68f96', snowLine: 0 },
];

/**
 * A mountain, built as one vertex-coloured mesh.
 *
 * The first version was a cone with a second, smaller cone pasted on top as its
 * snow cap. That produced a triangular purple pyramid with a flat cream band
 * across it: obviously not a mountain. Two changes fix it:
 *
 *  * the cone's rim and flanks are displaced per vertex, so the silhouette is a
 *    jagged ridge instead of a straight edge;
 *  * snow is a vertex colour blended by height with noise on the threshold, so
 *    the snow line is ragged and follows the flanks - it can never be a level
 *    band, because there is no separate cap geometry to be level.
 */
function mountainGeometry(spec: MountainSpec): THREE.BufferGeometry {
  const cone = new THREE.ConeGeometry(spec.radius, spec.height, spec.facets, 9);
  cone.rotateY(spec.rotation);
  const pos = cone.attributes.position as THREE.BufferAttribute;
  const colours = new Float32Array(pos.count * 3);
  const rock = new THREE.Color(spec.colour);
  const snow = new THREE.Color('#eef4fb');
  const scratch = new THREE.Color();

  for (let index = 0; index < pos.count; index += 1) {
    const x = pos.getX(index);
    const y = pos.getY(index);
    const z = pos.getZ(index);
    // Height above the base, 0 at the foot and 1 at the apex.
    const up = THREE.MathUtils.clamp(y / spec.height + 0.5, 0, 1);
    const angle = Math.atan2(z, x);

    // Spurs and gullies: the further up, the more the ridge wanders, so the
    // flanks are concave in places and bulge in others. A single sine would give
    // a smooth barrel; three incommensurate ones give rock.
    const ridge =
      Math.sin(angle * 5 + spec.rotation * 3) * 0.16 +
      Math.sin(angle * 11 + spec.rotation * 7) * 0.09 +
      Math.sin(angle * 23 + spec.rotation) * 0.045;
    const spread = 1 + ridge * (0.35 + up * 0.9);
    // Pull the apex in a little off-centre so the peak is not a perfect cone tip.
    const lean = up * up * 0.05;
    pos.setX(index, x * spec.stretchX * spread + lean * spec.radius);
    pos.setZ(index, z * spec.stretchZ * spread);

    // Ragged snow line: noise on the threshold, so the boundary never reads as a
    // horizontal cut across the mountain.
    if (spec.snowLine > 0) {
      const wobble = Math.sin(angle * 7 + 1.3) * 0.035 + Math.sin(angle * 17 + 4.1) * 0.02;
      const snowAmount = THREE.MathUtils.smoothstep(up, spec.snowLine + wobble - 0.05, spec.snowLine + wobble + 0.07);
      scratch.copy(rock).lerp(snow, snowAmount);
    } else {
      scratch.copy(rock);
    }
    // Shade the flanks a little by height: the foot is in the valley's shadow and
    // the summit catches the light.
    const lift = 0.82 + up * 0.3;
    const i3 = index * 3;
    colours[i3] = scratch.r * lift;
    colours[i3 + 1] = scratch.g * lift;
    colours[i3 + 2] = scratch.b * lift;
  }
  cone.computeVertexNormals();
  cone.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return cone;
}

function buildMountainRange(root: THREE.Group, materials: Materials) {
  const group = new THREE.Group();
  group.name = 'mountain-range';
  group.userData.decorative = true;

  const rangeMaterial = material(materials, '#ffffff', {
    roughness: 1,
    flatShading: true,
    vertexColors: true,
    fog: true,
  });

  for (const [index, spec] of MOUNTAINS.entries()) {
    const mountain = new THREE.Mesh(mountainGeometry(spec), rangeMaterial);
    mountain.name = `mountain-${index}`;
    // Sink the base well below the horizon ground: the foot has to disappear into
    // the pasture, or the peak stands on a visible rim.
    mountain.position.set(spec.x, HORIZON_Y + spec.height / 2 - spec.height * 0.3, spec.z);
    mountain.castShadow = false;
    mountain.receiveShadow = false;
    group.add(mountain);
  }
  root.add(group);
}

/* ============================================================= mesa buttes */

/**
 * The pink rock buttes on the left and right of the reference.
 *
 * Flat-topped columns with a talus skirt: the silhouette is a mesa, not a hill.
 * They sit outside the playfield, where the far treeline has already thinned, so
 * they read as the same countryside continuing rather than as scenery.
 */
const MESA_BUTTES: { x: number; z: number; radius: number; height: number; colour: string }[] = [
  { x: -980, z: -560, radius: 200, height: 120, colour: '#c08a86' },
  { x: -1140, z: -230, radius: 140, height: 88, colour: '#c9928c' },
  { x: 1040, z: -620, radius: 215, height: 130, colour: '#bd8884' },
  { x: 1210, z: -300, radius: 150, height: 95, colour: '#c79287' },
  { x: 950, z: 430, radius: 170, height: 100, colour: '#c59489' },
];

function buildMesaButtes(root: THREE.Group, materials: Materials) {
  const group = new THREE.Group();
  group.name = 'mesa-buttes';
  group.userData.decorative = true;

  const capMaterial = material(materials, '#cf9b92', { roughness: 1, flatShading: true });
  for (const [index, spec] of MESA_BUTTES.entries()) {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius * 0.72, spec.radius, spec.height, 9, 1),
      material(materials, spec.colour, { roughness: 1, flatShading: true }),
    );
    body.position.set(spec.x, HORIZON_Y + spec.height / 2 - 30, spec.z);
    body.name = `mesa-${index}`;
    group.add(body);

    // A slightly wider slab on top: the flat cap is what makes it a mesa.
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius * 0.78, spec.radius * 0.74, spec.height * 0.09, 9, 1),
      capMaterial,
    );
    cap.position.set(spec.x, HORIZON_Y + spec.height - 30 + spec.height * 0.04, spec.z);
    group.add(cap);

    // Talus: a low cone of scree at the foot, so the column does not look cut off.
    const skirt = new THREE.Mesh(
      new THREE.ConeGeometry(spec.radius * 1.35, spec.height * 0.16, 9, 1),
      material(materials, '#b98079', { roughness: 1, flatShading: true }),
    );
    skirt.position.set(spec.x, HORIZON_Y - 30 + spec.height * 0.08, spec.z);
    group.add(skirt);
  }
  root.add(group);
}

/* =============================================================== clouds */

function buildClouds(
  root: THREE.Group,
  materials: Materials,
  animated: ((elapsed: number) => void)[],
) {
  const cloudMaterial = material(materials, '#ffffff', {
    roughness: 1,
    transparent: true,
    opacity: 0.8,
    emissive: new THREE.Color('#ffe9c9'),
    emissiveIntensity: 0.18,
  });
  const clouds: THREE.Group[] = [];
  for (let index = 0; index < 7; index += 1) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(hash2(index, 3) * 3);
    for (let puff = 0; puff < puffs; puff += 1) {
      const size = 1.8 + hash2(index, puff) * 2.0;
      const mesh = addMesh(
        cloud,
        new THREE.IcosahedronGeometry(size, 1),
        cloudMaterial,
        [(puff - puffs / 2) * size * 1.15, hash2(puff, index) * 1.2, hash2(index, puff + 7) * 2.4],
      );
      mesh.scale.set(1, 0.62, 0.9);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    }
    cloud.position.set(-130 + hash2(index, 9) * 260, 62 + hash2(index, 4) * 18, -150 + hash2(index, 11) * 300);
    clouds.push(cloud);
    root.add(cloud);
  }
  animated.push((elapsed) => {
    clouds.forEach((cloud, index) => {
      cloud.position.x += Math.sin(elapsed * 0.05 + index) * 0.004;
    });
  });
}

/** Small carved posts around the diorama rim: a friendly map border. */
function buildBoundaryPosts(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
) {
  const postMaterial = material(materials, PALETTE.woodDark);
  // Only the crown of the map gets carved posts: the southern rim is forest.
  // The radius rides on the island ellipse - when it was a hard-coded 120 the
  // posts ended up *inside* the enlarged valley and hung over the meadows as a
  // drifting cloud of brown specks.
  const steps = 30;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const angle = Math.PI + t * Math.PI;
    const radius = ISLAND_RADIUS.x * 0.97 + Math.sin(angle * 3) * 3;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 1.28 + 3;
    const y = heightAt(x, z);
    addMesh(root, new THREE.BoxGeometry(0.4, 1.6, 0.4), postMaterial, [x, y + 0.8, z]);
  }
}


/* ==================================================== distant green hills */

/**
 * How far the land keeps rolling past the diorama edge, before the saucer's
 * outer falloff takes over. Exported because the height field and the ground
 * mesh must agree exactly - the original bug was hills floating in the sky
 * because the plane under them curved away faster than their base heights
 * assumed.
 */
export const HORIZON_ROLL = 210;

/**
 * Height of the horizon land at a point, *relative* to `HORIZON_Y`.
 *
 * This is the single source of truth the backdrop is built from: the hills, the
 * ground plane they stand on and the treeline all sample this function, so no
 * piece can drift away from the others. That is what makes the backdrop read as
 * one continuous landscape instead of separate green pebbles on a green disc -
 * the pebbles were the old design, and this replaces it.
 *
 * Shape: overlapping swells from `RIDGE_SWELLS`, plus a gentle outward lean
 * before the fog-facing falloff. Completely flat over the playable slab.
 */
export function horizonGroundOffset(x: number, z: number): number {
  const distance = Math.hypot(x, z);
  // Absolute world units, not a fraction of the disc: the disc's radius is
  // derived from the hills and moving them must not silently flatten the land
  // under them. That normalised threshold is exactly what erased the swells once
  // the backdrop was pushed outward.
  if (distance < HORIZON_INNER) return 0;
  const ramp = Math.min(1, (distance - HORIZON_INNER) / 130);
  let swell = 0;
  for (const ridge of RIDGE_SWELLS) {
    const dx = (x - ridge.x) / ridge.rx;
    const dz = (z - ridge.z) / ridge.rz;
    const d2 = dx * dx + dz * dz;
    if (d2 > 1) continue;
    swell += ridge.height * Math.pow(1 - d2, 1.5);
  }
  const lean = Math.pow(Math.min(1, distance / HORIZON_RADIUS), 2.2) * 6;
  const falloff = Math.max(0, distance / HORIZON_RADIUS - 0.88);
  return ramp * (swell + lean) - falloff * falloff * HORIZON_RADIUS * 0.9;
}

/**
 * Where the rolling land starts, in world units from the map centre.
 *
 * Just beyond the diorama's own half-diagonal (≈198): the playfield must stay
 * perfectly flat, and the swell has to have begun by the time the eye reaches the
 * first ridge.
 */
export const HORIZON_INNER = 330;

/**
 * Rest height of the horizon land mesh.
 *
 * Slightly *below* the playfield's own zero plane, not far below it: the island
 * used to float here, and with the island gone the backdrop is the same
 * continuous ground, so it has to meet the playfield instead of ducking under it.
 */
export const HORIZON_Y = -0.6;

/**
 * Aerial-perspective range for the backdrop, in world units from the eye.
 *
 * Co-located with the hills on purpose: the fog used to be tuned to a backdrop
 * that sat 300 units out, so widening the horizon without touching it simply
 * erased the hills into the haze. Anything mentioning `THREE.Fog` for this scene
 * reads these numbers.
 */
export const HORIZON_FOG = { near: 1700, far: 6400, colour: '#cfe4f2' } as const;

/** Far plane the orbit camera needs to reach the outermost ridge. */
export const HORIZON_FAR_PLANE = 9000;

/** Flat green of the horizon saucer the hills stand on. */
export const HORIZON_GROUND_COLOR = '#9ed06f';

/**
 * Hill tint per band, near to far. Exported so the aerial-perspective test can
 * assert the real values instead of restating them, and so the backdrop cannot
 * drift back to hill-green-on-ground-green (which erased the hills).
 */
export const HILL_COLORS = {
  near: '#5c9a3c',
  mid: '#6ba847',
  far: '#7bb556',
  horizon: '#8cc168',
} as const;

/**
 * Bands of ridges ringing the diorama, inner to outer.
 *
 * `minWidth`/`maxWidth` are HALF-extents. `stretch` is how much longer a ridge is
 * along its own long axis: real rolling hills are *long*, and a circular
 * footprint is exactly what made the old backdrop read as dropped pebbles.
 *
 * All four bands sit outside `CAMERA_ORBIT_LIMIT`, so the eye never gets closer
 * to them than the map itself.
 */
export const HILL_RINGS = [
  // Low pasture swells, not domes. The old rings had 60-176 unit radii on hills
  // only 20 units tall, so each one was a wide flat pancake with a hard crease -
  // from above that reads as a torn green sheet, which is exactly what the first
  // daylight renders showed. Radius and height are now kept in proportion.
  { radiusX: 470, radiusZ: 517, count: 54, minHeight: 13, maxHeight: 19, minWidth: 16, maxWidth: 24, stretch: [1.7, 2.1], materialKey: 'near' as const, seed: 12 },
  { radiusX: 610, radiusZ: 671, count: 50, minHeight: 20, maxHeight: 30, minWidth: 24, maxWidth: 36, stretch: [1.6, 2.0], materialKey: 'near' as const, seed: 3 },
  { radiusX: 800, radiusZ: 880, count: 44, minHeight: 26, maxHeight: 40, minWidth: 28, maxWidth: 42, stretch: [1.7, 2.1], materialKey: 'mid' as const, seed: 21 },
  { radiusX: 1050, radiusZ: 1155, count: 36, minHeight: 34, maxHeight: 52, minWidth: 31, maxWidth: 47, stretch: [1.8, 2.2], materialKey: 'far' as const, seed: 47 },
  { radiusX: 1350, radiusZ: 1485, count: 30, minHeight: 42, maxHeight: 66, minWidth: 35, maxWidth: 54, stretch: [1.9, 2.3], materialKey: 'horizon' as const, seed: 68 },
] as const;

/**
 * Radius of the horizon land, derived from the farthest ridge's reach.
 *
 * Computed rather than hand-picked: a hard-coded number silently drifts out of
 * sync when a band moves, and a ridge beyond the disc renders against bare sky -
 * the "floating green pancake" bug.
 */
export const HORIZON_RADIUS = (() => {
  let reach = 0;
  for (const ring of HILL_RINGS) {
    reach = Math.max(reach, Math.hypot(ring.radiusX, ring.radiusZ) + ring.maxWidth * ring.stretch[1]);
  }
  return Math.ceil(reach + 220);
})();

/**
 * The swells the horizon land is built from.
 *
 * Deliberately a list of overlapping humps rather than one smooth wave: the
 * backdrop has to read as *rolling countryside*, and a single sine field gave
 * the old version a billiard-table smoothness that made the hills look like
 * separate domes dropped on a plate. Both the ground mesh and the hill domes
 * sample this list, so a hill literally sits inside the swell it belongs to.
 *
 * Everything here lives *outside* the camera's orbit radius (see
 * `CAMERA_ORBIT_LIMIT`). That is not cosmetic: a hill closer to the eye than the
 * map fills a third of the frame and swallows the diorama, which is exactly what
 * happened when the ring sat at 168-470 while the default camera stood at 490.
 */
export const RIDGE_SWELLS = [
  // Gentle pasture rolling, a few metres high: enough that the land is not a
  // billiard table, low enough that the mountain range owns the skyline.
  { x: -520, z: -160, rx: 280, rz: 230, height: 7 },
  { x: -270, z: 470, rx: 270, rz: 220, height: 6 },
  { x: 110, z: 650, rx: 295, rz: 210, height: 8 },
  { x: 490, z: 390, rx: 285, rz: 230, height: 7 },
  { x: 650, z: -155, rx: 285, rz: 240, height: 9 },
  { x: 355, z: -600, rx: 280, rz: 220, height: 7 },
  { x: -250, z: -660, rx: 285, rz: 220, height: 8 },
  { x: -640, z: -470, rx: 265, rz: 220, height: 7 },
  { x: -27, z: -840, rx: 320, rz: 200, height: 8 },
  { x: -860, z: 50, rx: 265, rz: 285, height: 7 },
  { x: 860, z: 50, rx: 265, rz: 285, height: 8 },
  { x: -690, z: 540, rx: 250, rz: 220, height: 6 },
  { x: 720, z: 620, rx: 255, rz: 220, height: 7 },
] as const;

/**
 * Radius beyond which the camera can never go.
 *
 * The backdrop is authored against this number: anything inside it would end up
 * between the eye and the map at some orbit angle.
 */
export const CAMERA_ORBIT_LIMIT = 466;


/**
 * Big rolling green hills ringing the diorama.
 *
 * The map is a table-top model, so without a horizon the slab floats in empty
 * sky. The backdrop is now deliberately *big*: 9-25 m swells with 30-64 m
 * half-widths, overlapping so the silhouettes merge into ridges rather than
 * sitting as separate beads. They lean paler with distance, so the eye still
 * reads depth instead of mistaking them for more playable map.
 *
 * Decorative only: never picked, never collidable.
 */
function buildDistantHills(
  root: THREE.Group,
  animated: ((elapsed: number) => void)[],
) {
  const group = new THREE.Group();
  group.name = 'distant-hills';
  // Backdrop only: the pointer picker skips anything under this flag, otherwise
  // clicking a far hill would select whichever region happened to be nearest.
  group.userData.decorative = true;

  const materialsFor = {
    near: new THREE.MeshStandardMaterial({ color: HILL_COLORS.near, roughness: 1, flatShading: true }),
    mid: new THREE.MeshStandardMaterial({ color: HILL_COLORS.mid, roughness: 1, flatShading: true }),
    far: new THREE.MeshStandardMaterial({ color: HILL_COLORS.far, roughness: 1, flatShading: true }),
    horizon: new THREE.MeshStandardMaterial({ color: HILL_COLORS.horizon, roughness: 1, flatShading: true }),
  } as const;

  /*
   * A ridge is a squashed hemisphere with its rim pushed *down past the ground*
   * rather than sliced flat at the base.
   *
   * The old version ended the dome exactly at y=0, so every hill met the plane
   * at a sharp circle: twenty green discs with visible edges. Dropping the rim
   * below the surface (and letting the ground flow over it) hides the join, and
   * neighbouring domes then overlap into a shared ridgeline.
   */
  const ridgeGeometry = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  {
    const position = ridgeGeometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      const y = position.getY(index);
      const rim = 1 - Math.min(1, Math.max(0, y / 0.25));
      // `rim` is 1 at the equator and 0 by a quarter of the way up, so only the
      // skirt sinks; the visible dome keeps its silhouette.
      position.setY(index, y - rim * 0.55);
    }
    ridgeGeometry.computeVertexNormals();
  }

  const ridges: THREE.Mesh[] = [];
  const dummy = new THREE.Object3D();

  /*
   * Each peak is planted *inside* one of the ground swells, not on an ellipse
   * of its own. The swell already lifts the land there, so the dome only has to
   * add the crest: the two silhouettes merge into one hill, and because the
   * swells overlap, the hills run into each other as a ridge line instead of
   * sitting apart like beads on a string.
   */
  let peakIndex = 0;
  for (const ring of HILL_RINGS) {
    const ridgeMaterial = materialsFor[ring.materialKey];
    for (let index = 0; index < ring.count; index += 1) {
      const swell = RIDGE_SWELLS[peakIndex % RIDGE_SWELLS.length]!;
      peakIndex += 1;
      // Scatter the peak within the swell's inner half, so it never overhangs.
      const swirl = hash2(index, ring.seed + 7) * Math.PI * 2;
      const reach = 0.15 + hash2(index, ring.seed + 5) * 0.45;
      const x = swell.x + Math.cos(swirl) * swell.rx * reach;
      const z = swell.z + Math.sin(swirl) * swell.rz * reach;

      const height = ring.minHeight + hash2(index, ring.seed + 1) * (ring.maxHeight - ring.minHeight);
      const width = ring.minWidth + hash2(index, ring.seed + 2) * (ring.maxWidth - ring.minWidth);
      // Long, low and asymmetric: a ridge, not a pebble. The long axis is
      // rotated per hill, so neighbouring ridges cross instead of stacking.
      const stretch = ring.stretch[0] + hash2(index, ring.seed + 11) * (ring.stretch[1] - ring.stretch[0]);

      const ridge = new THREE.Mesh(ridgeGeometry, ridgeMaterial);
      ridge.scale.set(width, height, width * stretch);
      // Sit the dome's centre just under the swell's local surface: the skirt
      // is buried, so there is no join to read as a seam.
      const groundY = HORIZON_Y + horizonGroundOffset(x, z);
      ridge.position.set(x, groundY - height * 0.3, z);
      ridge.rotation.y = hash2(index, ring.seed + 4) * Math.PI;
      ridge.name = `hill-${ring.seed}-${index}`;
      group.add(ridge);
      ridges.push(ridge);
    }
  }

  /*
   * The land the hills stand on.
   *
   * It uses the *same* `horizonGroundOffset` as the hills, so the swells and the
   * ground undulate together instead of hills hovering over a flat plate.
   *
   * A grid, not a CircleGeometry fan: a fan's 96 long triangles all touch the
   * centre, and any renderer that culls whole triangles against the near plane
   * (the offline painter) discards every one of them - the ground vanishes and
   * the hills appear to float. Small tiles also let the falloff be smooth.
   */
  // NO second ground plate here any more. The playfield terrain is already one
  // disc that runs out to `HORIZON_RADIUS` and follows these same swells, so a
  // plate under it would only z-fight with it and re-introduce the edge.

  /*
   * Scattered trees on the near swells, in three instanced draws.
   *
   * This is the main trick that makes the backdrop read as *land* and not as
   * painted geometry: the treeline gives the eye a familiar scale reference, so
   * a 20 m hill behind a 5 m pine is obviously a hill, and the rows recede.
   */
  const treeRng = mulberry32(20261117);
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#6b4b30', roughness: 1, flatShading: true });
  const leafMaterial = new THREE.MeshStandardMaterial({ color: '#3f7043', roughness: 1, flatShading: true });
  const pineMaterial = new THREE.MeshStandardMaterial({ color: '#39634a', roughness: 1, flatShading: true });
  // Five times as many, and they start right behind the playfield's treeline: the
  // middle distance was a bare green ring, which is what made the valley look
  // like a clearing in a lawn rather than a farm in a forested valley.
  const MAX_TREES = 3000;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.42, 3.0, 5), trunkMaterial, MAX_TREES);
  const canopies = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.2, 0), leafMaterial, MAX_TREES);
  const pines = new THREE.InstancedMesh(new THREE.ConeGeometry(2.0, 5.2, 6), pineMaterial, MAX_TREES);
  let trunkCount = 0;
  let canopyCount = 0;
  let pineCount = 0;
  for (let attempt = 0; attempt < 26000 && trunkCount < MAX_TREES; attempt += 1) {
    const angle = treeRng() * Math.PI * 2;
    // Square-root radial sampling from just outside the playfield to the hills.
    const radius = 0.22 + Math.sqrt(treeRng()) * 0.78;
    const x = Math.cos(angle) * radius * HORIZON_RADIUS;
    const z = Math.sin(angle) * radius * HORIZON_RADIUS;
    // Keep the immediate playfield clear so nothing pokes into the diorama's own
    // silhouette; beyond that the belt thickens.
    if (Math.abs(x) < DIORAMA_HALF.x + 70 && Math.abs(z) < DIORAMA_HALF.z + 70) continue;
    const distance = radius;
    // Thin only the very far field: the near and middle belts are the ones the
    // eye reads as forest.
    if (treeRng() > 1.5 - distance * 0.45) continue;
    const y = HORIZON_Y + horizonGroundOffset(x, z);
    // The near swells sit further out now, so these trees grow with the
    // diorama: at the old size they read as dark specks in the sky.
    const scale = (0.85 + treeRng() * 0.75) * WORLD_SCALE;
    dummy.position.set(x, y + 1.5 * scale, z);
    dummy.rotation.set(0, treeRng() * Math.PI, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(trunkCount++, dummy.matrix);
    const isPine = treeRng() < 0.52;
    // One tree grows one crown. Writing both a pine and a broadleaf crown for
    // the same trunk ran `canopyCount`/`pineCount` past MAX_TREES, and the
    // overflow instances landed at the origin matrix - the drifting spray of
    // dark specks that hung in the sky over the farm.
    if (isPine) {
      dummy.position.set(x, y + 4.0 * scale, z);
      dummy.updateMatrix();
      pines.setMatrixAt(pineCount++, dummy.matrix);
    } else if (canopyCount < MAX_TREES) {
      dummy.position.set(x, y + 4.4 * scale, z);
      dummy.updateMatrix();
      canopies.setMatrixAt(canopyCount++, dummy.matrix);
    }
  }
  trunks.count = trunkCount;
  canopies.count = canopyCount;
  pines.count = pineCount;
  for (const mesh of [trunks, canopies, pines]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.decorative = true;
    group.add(mesh);
  }

  root.add(group);

  animated.push((elapsed) => {
    // Nothing moves: distant terrain that breathes looks like a rendering bug.
    // The handler stays so the animation array shape stays uniform.
    void elapsed;
    void ridges;
  });
}

/* ============================================================= stone gate */

/**
 * The toll gate at the head of the main avenue.
 *
 * In the reference the eye is pulled in by a solid stone arch with lanterns and
 * banners; it is the one bit of architecture that says "this is an entrance". The
 * avenue starts at z = 150, so the gate sits astride it at z = 138.
 */
function buildStoneGate(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
  animated: ((elapsed: number) => void)[],
) {
  const group = new THREE.Group();
  group.name = 'stone-gate';
  const gateZ = 138;
  const ground = heightAt(0, gateZ);
  group.position.set(0, ground, gateZ);
  const stone = material(materials, '#b3a58c', { roughness: 1, flatShading: true });
  const stoneDark = material(materials, '#8d8168', { roughness: 1, flatShading: true });
  const trim = material(materials, '#d8c9a4', { roughness: 0.9 });

  // Two square pylons with battered (tapered) bases, which is what makes stonework
  // read as masonry instead of two blocks.
  for (const side of [-1, 1]) {
    const pylon = addMesh(group, new THREE.CylinderGeometry(1.5, 1.95, 9.5, 4), stone, [
      side * 7.2,
      4.75,
      0,
    ]);
    pylon.rotation.y = Math.PI / 4;
    addMesh(group, new THREE.CylinderGeometry(1.85, 2.05, 0.9, 4), stoneDark, [side * 7.2, 0.45, 0]).rotation.y = Math.PI / 4;
    addMesh(group, new THREE.CylinderGeometry(1.75, 1.72, 0.7, 4), trim, [side * 7.2, 9.7, 0]).rotation.y = Math.PI / 4;
    // Lantern on a bracket, the classic souls bonfire at a threshold.
    const lantern = addMesh(
      group,
      new THREE.BoxGeometry(1.0, 1.4, 1.0),
      material(materials, '#ffd98a', { emissive: new THREE.Color('#ffb347'), emissiveIntensity: 1.7 }),
      [side * 5.6, 6.2, 1.1],
    );
    lantern.castShadow = false;
    animated.push((elapsed) => {
      const materialRef = lantern.material as THREE.MeshStandardMaterial;
      materialRef.emissiveIntensity = 1.4 + Math.sin(elapsed * 3 + side) * 0.5;
    });
    // Banner hanging from the arch spring.
    addMesh(group, new THREE.PlaneGeometry(1.5, 3.4), material(materials, '#9c3b3f', { side: THREE.DoubleSide }), [
      side * 3.4,
      8.2,
      0.24,
    ]);
    addMesh(group, new THREE.CylinderGeometry(0.09, 0.09, 1.7, 4), trim, [side * 3.4, 10.0, 0.24]).rotation.z = Math.PI / 2;
  }
  // The arch: three beams stepping inward, so it reads as a real span.
  addMesh(group, new THREE.BoxGeometry(15.6, 1.5, 2.2), trim, [0, 10.4, 0]);
  addMesh(group, new THREE.BoxGeometry(13.4, 1.1, 2.0), stone, [0, 11.5, 0]);
  addMesh(group, new THREE.BoxGeometry(10.6, 0.9, 1.8), stoneDark, [0, 12.4, 0]);
  // Cobbled threshold under the arch.
  const threshold = new THREE.Mesh(new THREE.PlaneGeometry(17, 7), material(materials, '#a89a80', { roughness: 1 }));
  threshold.rotation.x = -Math.PI / 2;
  threshold.position.y = 0.07;
  threshold.receiveShadow = true;
  group.add(threshold);
  // Rubble at the foot of each pylon.
  const rubble = material(materials, '#948871', { flatShading: true, roughness: 1 });
  for (let index = 0; index < 14; index += 1) {
    const side = index % 2 === 0 ? -1 : 1;
    const stoneMesh = addMesh(
      group,
      new THREE.DodecahedronGeometry(0.5 + hash2(index, 4) * 0.6, 0),
      rubble,
      [side * (8.8 + hash2(index, 2) * 1.6), 0.3, (hash2(index, 6) - 0.5) * 5],
    );
    stoneMesh.rotation.set(hash2(index, 3) * 2, hash2(index, 5) * 2, hash2(index, 7) * 2);
  }
  root.add(group);
}

/* ============================================================== rim forest */

/**
 * A belt of trees around the coast.
 *
 * The reference's silhouette is forest all the way to the edge; a bare grass lip
 * falling into rock reads as a slice of cake. Trees are placed by walking the
 * coast itself, so the belt follows the same wobble the ground does.
 */
function buildRimForest(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
  clear: ReturnType<typeof clearanceFor>,
) {
  const rng = mulberry32(20260419);
  const group = new THREE.Group();
  group.name = 'rim-forest';
  const count = 760;
  const trunkMaterial = material(materials, PALETTE.trunk);
  const leafA = material(materials, PALETTE.leafA);
  const leafB = material(materials, PALETTE.leafB);
  const leafC = material(materials, PALETTE.leafC);
  const pineMaterial = material(materials, PALETTE.pine);
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.4, 2.4, 6), trunkMaterial, count);
  const crownsA = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 0), leafA, count);
  const crownsB = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.5, 1), leafB, count);
  const crownsC = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.4, 0), leafC, count);
  const pines = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 3.2, 7), pineMaterial, count);
  const pinesB = new THREE.InstancedMesh(new THREE.ConeGeometry(1.15, 2.5, 7), pineMaterial, count);
  let trunkCount = 0;
  let broadCount = 0;
  let pineCount = 0;
  const dummy = new THREE.Object3D();

  for (let attempt = 0; attempt < count * 6 && trunkCount < count; attempt += 1) {
    const angle = rng() * Math.PI * 2;
    // A belt just outside the playfield: the valley has to be wrapped in trees on
    // all four sides, which is what gives the reference its sense of enclosure.
    const spread = 1.02 + rng() * 0.34;
    const x = Math.cos(angle) * ISLAND_RADIUS.x * spread;
    const z = Math.sin(angle) * ISLAND_RADIUS.z * spread;
    if (Math.abs(x) < 9 && z > -150) continue;
    if (!clear.open(x, z, 4)) continue;
    const y = heightAt(x, z);
    const scale = (0.85 + rng() * 0.9) * WORLD_SCALE;
    const isPine = rng() < 0.42;
    dummy.position.set(x, y + 1.2 * scale, z);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.scale.setScalar(scale);
    dummy.updateMatrix();
    trunks.setMatrixAt(trunkCount++, dummy.matrix);

    if (isPine) {
      dummy.position.set(x, y + 2.8 * scale, z);
      dummy.updateMatrix();
      pines.setMatrixAt(pineCount, dummy.matrix);
      dummy.position.set(x, y + 4.1 * scale, z);
      dummy.scale.setScalar(scale * 0.82);
      dummy.updateMatrix();
      pinesB.setMatrixAt(pineCount, dummy.matrix);
      pineCount += 1;
    } else {
      dummy.position.set(x, y + 3.1 * scale, z);
      dummy.updateMatrix();
      crownsA.setMatrixAt(broadCount, dummy.matrix);
      dummy.position.set(x + 1.1 * scale, y + 2.4 * scale, z - 0.6 * scale);
      dummy.scale.setScalar(scale * 0.78);
      dummy.updateMatrix();
      crownsB.setMatrixAt(broadCount, dummy.matrix);
      dummy.position.set(x - 0.9 * scale, y + 2.2 * scale, z + 0.8 * scale);
      dummy.updateMatrix();
      crownsC.setMatrixAt(broadCount, dummy.matrix);
      broadCount += 1;
    }
  }
  trunks.count = trunkCount;
  crownsA.count = broadCount;
  crownsB.count = broadCount;
  crownsC.count = broadCount;
  pines.count = pineCount;
  pinesB.count = pineCount;
  for (const mesh of [trunks, crownsA, crownsB, crownsC, pines, pinesB]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  group.add(trunks, crownsA, crownsB, crownsC, pines, pinesB);
  root.add(group);
}

/* ================================================================ scatter */

/** Grass tufts, stones, bushes, hay bales and sunflowers across the map. */
function buildScatter(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
  clear: ReturnType<typeof clearanceFor>,
  river: Vec2[],
) {
  /* The scatter is what stops the valley reading as an empty green table. It is
   * deliberately several systems rather than one "random props" loop: grass wants
   * to be everywhere, flowers want to cluster, boulders want to hug the rim, and
   * clutter wants to hug the buildings. Every one of them asks `clear.open`
   * first, so no tuft grows through a barn door. */

  const rng = mulberry32(20261116);
  const dummy = new THREE.Object3D();
  const scatterRect = {
    minX: ARENA.minX - 26,
    maxX: ARENA.maxX + 26,
    minZ: ARENA.minZ - 26,
    maxZ: ARENA.maxZ + 26,
  };
  const inScatter = (x: number, z: number) =>
    x > scatterRect.minX && x < scatterRect.maxX && z > scatterRect.minZ && z < scatterRect.maxZ;

  /** Rejection-sample `count` points that pass `accept`. */
  const sample = (
    count: number,
    attempts: number,
    accept: (x: number, z: number) => boolean,
    minX = scatterRect.minX,
    maxX = scatterRect.maxX,
    minZ = scatterRect.minZ,
    maxZ = scatterRect.maxZ,
  ): [number, number][] => {
    const points: [number, number][] = [];
    const centreX = (scatterRect.minX + scatterRect.maxX) / 2;
    const centreZ = (scatterRect.minZ + scatterRect.maxZ) / 2;
    const halfX = (scatterRect.maxX - scatterRect.minX) / 2;
    const halfZ = (scatterRect.maxZ - scatterRect.minZ) / 2;
    for (let attempt = 0; attempt < attempts && points.length < count; attempt += 1) {
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
      if (!inScatter(x, z)) continue;
      // Thin out toward the rim instead of stopping dead on the rectangle. A hard
      // edge showed up from the air as a straight line of grass with the meadow
      // beyond it bare.
      const radial = Math.hypot((x - centreX) / halfX, (z - centreZ) / halfZ);
      if (rng() < THREE.MathUtils.smoothstep(radial, 0.72, 1)) continue;
      if (accept(x, z)) points.push([x, z]);
    }
    return points;
  };

  const place = (
    geometry: THREE.BufferGeometry,
    mat: THREE.Material,
    points: [number, number][],
    options: {
      lift?: number;
      scale?: [number, number];
      squash?: number;
      tilt?: number;
      castShadow?: boolean;
      spin?: number;
    } = {},
  ) => {
    if (points.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, mat, points.length);
    const lift = options.lift ?? 0;
    const [minScale, maxScale] = options.scale ?? [0.85, 1.15];
    const squash = options.squash ?? 1;
    const tilt = options.tilt ?? 0;
    points.forEach(([x, z], index) => {
      const y = heightAt(x, z);
      const scale = minScale + rng() * (maxScale - minScale);
      dummy.position.set(x, y + lift * scale, z);
      dummy.rotation.set(
        (rng() - 0.5) * tilt,
        options.spin ?? rng() * Math.PI * 2,
        (rng() - 0.5) * tilt,
      );
      dummy.scale.set(scale, scale * squash, scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = options.castShadow ?? false;
    mesh.receiveShadow = true;
    root.add(mesh);
  };

  /* --------------------------------------------------------------- grass */
  // Two tuft sizes so the ground reads as a lawn with long grass in it rather
  // than a field of identical spikes.
  const shortGrass = sample(
    Math.round(2400 * DETAIL),
    26000,
    (x, z) => clear.open(x, z, 0.35),
  );
  place(
    new THREE.ConeGeometry(0.15, 0.5, 3),
    material(materials, '#7fb152', { flatShading: true, roughness: 1 }),
    shortGrass,
    { lift: 0.2, scale: [0.7, 1.5], tilt: 0.25 },
  );

  const tallGrass = sample(
    Math.round(750 * DETAIL),
    14000,
    (x, z) => clear.open(x, z, 0.6),
  );
  place(
    new THREE.ConeGeometry(0.13, 1.0, 3),
    material(materials, '#8dbf57', { flatShading: true, roughness: 1 }),
    tallGrass,
    { lift: 0.42, scale: [0.75, 1.45], tilt: 0.35 },
  );

  /* -------------------------------------------------------------- flowers */
  // Six little meadow patches: colour where the reference has colour, none in
  // the middle of the crop rows.
  const flowerSpots: [number, number, number][] = [
    [-118, 96, 22], [104, 128, 20], [-96, 166, 24], [96, -40, 22],
    [-120, -78, 20], [118, -160, 22], [-40, 172, 18], [60, 156, 18],
  ];
  const flowerColours = ['#f2d14b', '#f0f0f0', '#d96ea5', '#b98ff0'];
  flowerColours.forEach((colour, index) => {
    const spots = sample(
      160,
      4000,
      (x, z) => clear.open(x, z, 0.2) && Math.hypot(x - flowerSpots[index]![0], z - flowerSpots[index]![1]) < flowerSpots[index]![2],
      flowerSpots[index]![0] - flowerSpots[index]![2],
      flowerSpots[index]![0] + flowerSpots[index]![2],
      flowerSpots[index]![1] - flowerSpots[index]![2],
      flowerSpots[index]![1] + flowerSpots[index]![2],
    );
    place(
      new THREE.SphereGeometry(0.13, 6, 4),
      material(materials, colour, { roughness: 0.9 }),
      spots,
      { lift: 0.36, scale: [0.7, 1.3], spin: 0 },
    );
  });

  /* --------------------------------------------------------- rocks, bushes */
  // Both use the packed models: a scattered stone that is a real faceted rock,
  // and a bush with a silhouette instead of a green ball. `placeModel` below
  // falls back to the old primitives if a model is missing from the pack.
  const placeModel = (
    model: string,
    spots: [number, number][],
    targetHeight: number,
    options: { spin?: number; squash?: number } = {},
  ) => {
    const prototype = modelPrototype(model);
    const loaded = getModel(model);
    if (!prototype || !loaded) return false;
    const instanced = new THREE.InstancedMesh(prototype.geometry, prototype.material, spots.length);
    const dummy = new THREE.Object3D();
    const base = targetHeight / loaded.height;
    spots.forEach(([x, z], index) => {
      const scale = base * (0.7 + rng() * 0.6);
      dummy.position.set(x, heightAt(x, z), z);
      dummy.rotation.set(0, options.spin === undefined ? rng() * Math.PI * 2 : options.spin, 0);
      dummy.scale.set(scale, scale * (options.squash ?? 1), scale);
      dummy.updateMatrix();
      instanced.setMatrixAt(index, dummy.matrix);
    });
    instanced.instanceMatrix.needsUpdate = true;
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    root.add(instanced);
    return true;
  };

  const rocks = sample(
    Math.round(170 * DETAIL),
    9000,
    (x, z) => clear.open(x, z, 1.6),
  );
  if (!placeModel('Rock2', rocks, 1.1, { squash: 0.75 })) {
    place(
      new THREE.DodecahedronGeometry(0.45, 0),
      material(materials, '#a49a88', { flatShading: true, roughness: 1 }),
      rocks,
      { lift: 0.16, scale: [0.6, 1.7], squash: 0.7, tilt: 0.9, castShadow: true },
    );
  }

  const bushes = sample(
    Math.round(300 * DETAIL),
    9000,
    (x, z) => clear.open(x, z, 1.3),
  );
  if (!placeModel('Bush2', bushes, 1.5, { squash: 1.05 })) {
    place(
      new THREE.IcosahedronGeometry(0.8, 0),
      material(materials, '#4e8642', { flatShading: true }),
      bushes,
      { lift: 0.42, scale: [0.6, 1.4], squash: 0.75, spin: rng() * 6, castShadow: true },
    );
  }

  /* -------------------------------------------------------------- stumps */
  const stumps = sample(26, 2600, (x, z) => clear.open(x, z, 1.4));
  for (const [x, z] of stumps) {
    const y = heightAt(x, z);
    const scale = 0.7 + rng() * 0.6;
    addMesh(
      root,
      new THREE.CylinderGeometry(0.42 * scale, 0.5 * scale, 0.55 * scale, 7),
      material(materials, '#7d5a3c', { roughness: 1 }),
      [x, y + 0.26 * scale, z],
    );
  }

  /* --------------------------------------------------- hay bales and reeds */
  const hayMaterial = material(materials, PALETTE.hay, { roughness: 1 });
  const hayBand = material(materials, PALETTE.hayDark);
  // Bales cluster where a farmer would stack them: by the barn, the threshing
  // floor, the paddock edges and the field corners.
  const hayStacks: [number, number][] = [
    [-70, 74], [-66, 78], [-74, 70], [-62, 82],
    [-34, -50], [-30, -54], [-38, -46],
    [62, -110], [66, -114], [58, -114],
    [-110, 44], [-106, 40], [104, 40], [100, 44],
    [40, 54], [44, 58],
  ];
  for (const [x, z] of hayStacks) {
    const y = heightAt(x, z) + 0.8;
    const bale = addMesh(
      root,
      new THREE.CylinderGeometry(0.85, 0.85, 1.5, 10),
      hayMaterial,
      [x, y, z],
    );
    bale.rotation.z = Math.PI / 2;
    bale.rotation.y = rng() * Math.PI;
    bale.castShadow = true;
    addMesh(root, new THREE.TorusGeometry(0.86, 0.05, 4, 12), hayBand, [x, y, z]).rotation.y = Math.PI / 2;
  }

  // Reeds wherever the water meets its bank.
  const reeds = sample(
    520,
    16000,
    (x, z) => clear.open(x, z, 0.2) && riverProximity(x, z, river) > 0.4 && riverProximity(x, z, river) < 1,
  );
  place(
    new THREE.ConeGeometry(0.07, 1.15, 3),
    material(materials, '#6f9a4a', { flatShading: true }),
    reeds,
    { lift: 0.5, scale: [0.7, 1.4], tilt: 0.3 },
  );

  /* ------------------------------------------------------- road-side posts */
  // Little white-topped markers every few metres along the avenue, the way a
  // farm lane is marked. They are the cheapest possible detail and they tie the
  // four bands together.
  const avenue = clear.roads.find((road) => Math.abs(road.width - 4.6) < 0.01);
  if (avenue) {
    const posts = roadSidePosts(avenue.points, 7);
    for (const [x, z] of posts) {
      if (!clear.open(x, z, 0.1)) continue;
      const y = heightAt(x, z);
      addMesh(root, new THREE.CylinderGeometry(0.1, 0.12, 0.9, 4), material(materials, '#9a8a6e'), [x, y + 0.45, z]);
      addMesh(root, new THREE.CylinderGeometry(0.11, 0.11, 0.12, 4), material(materials, '#f2e9d6'), [x, y + 0.93, z]);
    }
  }

  /* --------------------------------------------------- yard dressing */
  // Every farmyard is a little cluttered: a gravel apron in front of each door,
  // a few crates and barrels stacked against a wall, a woodpile, a cart. This is
  // what makes the buildings read as *lived in* rather than as models placed on
  // a lawn, and it is the detail the bird's-eye view was missing.
  // Yard props are read from the flying camera, so they are drawn deliberately
  // oversized: a 0.6 m crate is a speck from 380 units up, a 2 m crate is a crate.
  const YARD = WORLD_SCALE * 1.9;
  const yardMaterial = material(materials, '#b09a74', { roughness: 1 });
  const crateMaterial = material(materials, '#a87a4a', { roughness: 0.95 });
  const barrelMaterial = material(materials, '#8a5f38', { roughness: 0.9 });
  const logMaterial = material(materials, '#7d5a3c', { roughness: 1 });
  const cartMaterial = material(materials, '#9c6b3f', { roughness: 0.95 });
  const wheelMaterial = material(materials, '#5f4028', { roughness: 1 });

  for (const spot of clear.buildings) {
    const [bx, bz, br] = spot;
    // Gravel apron: a flat disc of packed earth where people walk.
    // The clearance disc is the diagonal of the footprint plus a scatter skirt;
    // a courtyard should hug the walls, so it is a fraction of it.
    const apronRadius = br * 0.42 + 1.4;
    const apron = addMesh(
      root,
      new THREE.CircleGeometry(apronRadius, 18),
      yardMaterial,
      [bx, heightAt(bx, bz) + 0.03, bz],
    );
    apron.rotation.x = -Math.PI / 2;
    apron.receiveShadow = true;

    // Crates and barrels against the wall, on a ring just outside the footprint.
    const props = 3 + Math.floor(rng() * 3);
    for (let index = 0; index < props; index += 1) {
      const angle = rng() * Math.PI * 2;
      const distance = br * 0.9 + rng() * 1.6;
      const px = bx + Math.cos(angle) * distance;
      const pz = bz + Math.sin(angle) * distance;
      if (!clear.open(px, pz, 0.1)) continue;
      const py = heightAt(px, pz);
      if (rng() < 0.5) {
        const size = (0.55 + rng() * 0.5) * YARD;
        const crate = addMesh(
          root,
          new THREE.BoxGeometry(size, size, size),
          crateMaterial,
          [px, py + size / 2, pz],
        );
        crate.rotation.y = rng() * Math.PI;
        crate.castShadow = true;
      } else {
        const barrel = addMesh(
          root,
          new THREE.CylinderGeometry(0.34 * YARD, 0.4 * YARD, 0.9 * YARD, 8),
          barrelMaterial,
          [px, py + 0.45 * YARD, pz],
        );
        barrel.castShadow = true;
        addMesh(root, new THREE.TorusGeometry(0.38, 0.04, 4, 10), wheelMaterial, [px, py + 0.62, pz]).rotation.x = Math.PI / 2;
      }
    }

    // A woodpile on one side of the barns and the big sheds only.
    if (br > 6 && rng() < 0.55) {
      const angle = rng() * Math.PI * 2;
      const distance = br + 1.4;
      const px = bx + Math.cos(angle) * distance;
      const pz = bz + Math.sin(angle) * distance;
      if (clear.open(px, pz, 0.4)) {
        for (let row = 0; row < 2; row += 1) {
          for (let column = 0; column < 4; column += 1) {
            const lx = px + (column - 1.5) * 0.42 * WORLD_SCALE;
            const lz = pz + row * 0.42 * WORLD_SCALE;
            const log = addMesh(
              root,
              new THREE.CylinderGeometry(0.18 * WORLD_SCALE, 0.18 * WORLD_SCALE, 1.1 * WORLD_SCALE, 6),
              logMaterial,
              [lx, heightAt(lx, lz) + (0.18 + row * 0.34) * WORLD_SCALE, lz],
            );
            log.rotation.z = Math.PI / 2;
            log.rotation.y = angle;
            log.castShadow = true;
          }
        }
      }
    }
  }

  /* --------------------------------------------------- landmarks in the yard */
  // Big readable props that survive the bird's-eye camera. Each is a group, not
  // a scatter: from 380 units up a farm needs silhouettes, not pebbles.
  const strawStack = material(materials, PALETTE.hay, { roughness: 1 });
  const stoneBlock = material(materials, '#9a9183', { roughness: 1 });

  // Hay ricks: the big conical stacks a real farm keeps through winter.
  //
  // Drawn from the pack's straw bale where it is available: same silhouette, but
  // rounded and faceted like the rest of the world instead of a lathe cone. The
  // procedural stack stays as the fallback so a pack without `Hay` still builds.
  const hayModel = getModel('Hay');
  // The pack's `Hay` is a standing sheaf — an hourglass of straw with a belt, not
  // a bale — so the honest way to use it is the honest farm way: sheaves stood up
  // in small shocks to dry. Five per cluster, staggered and tilted, reads as one
  // landmark from the air and as individual sheaves up close.
  const SHEAF_HEIGHTS = [1.75, 1.5, 1.62, 1.35, 1.2];
  const SHEAF_SPOTS: [number, number][] = [
    [-1.9, -1.0], [0.3, -2.0], [2.1, 0.2], [-0.7, 1.4], [1.4, 2.3],
  ];
  const ricks: [number, number][] = [
    [-96, 66], [-88, 72], [-108, -44], [100, -70], [140, -60], [85, -120],
  ];
  for (const [rx, rz] of ricks) {
    const x = rx * WORLD_SCALE;
    const z = rz * WORLD_SCALE;
    if (!clear.open(x, z, 2.5)) continue;
    const y = heightAt(x, z);
    if (hayModel) {
      SHEAF_SPOTS.forEach(([ox, oz], index) => {
        const height = SHEAF_HEIGHTS[index]!;
        const sheaf = hayModel.group.clone(true);
        sheaf.scale.setScalar(height / hayModel.height);
        sheaf.rotation.set(
          (hash2(rx + index * 13, rz) - 0.5) * 0.12,
          hash2(rx, rz + index * 17) * Math.PI,
          (hash2(rx - index * 11, rz - index) - 0.5) * 0.12,
        );
        sheaf.position.set(x + ox, y, z + oz);
        sheaf.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
        root.add(sheaf);
      });
      continue;
    }
    const rick = addMesh(
      root,
      new THREE.CylinderGeometry(1.1, 2.4, 4.4, 9),
      strawStack,
      [x, y + 2.2, z],
    );
    rick.castShadow = true;
    const cap = addMesh(
      root,
      new THREE.ConeGeometry(1.35, 1.5, 9),
      material(materials, PALETTE.hayDark),
      [x, y + 5.05, z],
    );
    cap.castShadow = true;
    // A pole up the middle, the way ricks are thatched.
    addMesh(root, new THREE.CylinderGeometry(0.09, 0.09, 6.4, 4), logMaterial, [x, y + 3.2, z]);
  }

  // Stone wells in the two outer bands.
  const fieldWells: [number, number][] = [[-120, 120], [122, -40]];
  for (const [wx, wz] of fieldWells) {
    const x = wx * WORLD_SCALE;
    const z = wz * WORLD_SCALE;
    if (!clear.open(x, z, 2)) continue;
    const y = heightAt(x, z);
    addMesh(root, new THREE.CylinderGeometry(1.5, 1.6, 0.9, 10), stoneBlock, [x, y + 0.45, z]).castShadow = true;
    for (const side of [-1, 1]) {
      addMesh(root, new THREE.CylinderGeometry(0.12, 0.12, 2.4, 5), logMaterial, [x + side * 1.1, y + 1.7, z]);
    }
    const roof = addMesh(root, new THREE.ConeGeometry(2.0, 1.1, 4), material(materials, PALETTE.roofRed), [x, y + 3.2, z]);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
  }

  // Orchard rows: five trees on a grid, north-west of the house.
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const x = (-132 + column * 7) * WORLD_SCALE * 0.62;
      const z = (112 + row * 8) * WORLD_SCALE * 0.55;
      if (!clear.open(x, z, 2)) continue;
      const y = heightAt(x, z);
      const trunk = addMesh(root, new THREE.CylinderGeometry(0.3, 0.42, 3.2, 6), logMaterial, [x, y + 1.6, z]);
      trunk.castShadow = true;
      const crown = addMesh(
        root,
        new THREE.IcosahedronGeometry(2.2, 0),
        material(materials, PALETTE.leafB),
        [x, y + 4.2, z],
      );
      crown.scale.set(1.1, 0.85, 1.1);
      crown.castShadow = true;
    }
  }

  /* ----------------------------------------------------------- hay cart */
  // One cart on the avenue, where the four bands meet: a silhouette the eye can
  // navigate by, and a bit of story.
  for (const [cx, cz] of [[-10, 92], [20, -34]] as [number, number][]) {
    const x = cx * WORLD_SCALE;
    const z = cz * WORLD_SCALE;
    if (!clear.open(x, z, 2.5)) continue;
    const y = heightAt(x, z);
    const bed = addMesh(root, new THREE.BoxGeometry(3.2, 0.3, 1.6), cartMaterial, [x, y + 0.75, z]);
    bed.rotation.y = 0.5;
    bed.castShadow = true;
    for (const side of [-1, 1]) {
      const wheel = addMesh(
        root,
        new THREE.CylinderGeometry(0.62, 0.62, 0.16, 12),
        wheelMaterial,
        [x + Math.cos(0.5) * 1.1, y + 0.62, z + Math.sin(0.5) * 1.1 * side],
      );
      wheel.rotation.z = Math.PI / 2;
      wheel.rotation.y = 0.5;
      wheel.castShadow = true;
    }
    // A load of hay on top.
    addMesh(root, new THREE.BoxGeometry(2.6, 0.9, 1.3), hayMaterial, [x, y + 1.3, z]).rotation.y = 0.5;
  }

  /* ---------------------------------------------------- sunflower clusters */
  // Along the crop lanes, where the reference puts its sunflowers.
  const sunflowers = sample(
    70,
    4000,
    (x, z) => clear.open(x, z, 1.1) && Math.abs(z - 20) < 7 && Math.abs(x) > 16 && Math.abs(x) < 130,
  );
  for (const [x, z] of sunflowers) {
    const y = heightAt(x, z);
    const scale = 0.8 + rng() * 0.5;
    const stem = addMesh(
      root,
      new THREE.CylinderGeometry(0.05, 0.06, 1.7 * scale, 4),
      material(materials, '#6f8b3f'),
      [x, y + 0.85 * scale, z],
    );
    stem.castShadow = false;
    const head = addMesh(
      root,
      new THREE.CylinderGeometry(0.34 * scale, 0.34 * scale, 0.08, 8),
      material(materials, PALETTE.sunflower),
      [x, y + 1.7 * scale, z],
    );
    head.rotation.x = Math.PI / 2;
    head.rotation.z = rng() * 0.4;
  }
}

/** How close a point is to the river, 0 (away) .. 1 (mid-channel). */
function riverProximity(x: number, z: number, river: Vec2[]): number {
  const distance = distanceToPolyline(x, z, river);
  return distance < 14 ? 1 - distance / 14 : 0;
}

/** Points marching down both sides of a polyline, `spacing` apart. */
function roadSidePosts(points: Vec2[], spacing: number): [number, number][] {
  const posts: [number, number][] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.001) continue;
    const nx = -(b[1] - a[1]) / length;
    const nz = (b[0] - a[0]) / length;
    const steps = Math.max(1, Math.round(length / spacing));
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      for (const side of [-1, 1]) {
        posts.push([x + nx * 3.4 * side, z + nz * 3.4 * side]);
      }
    }
  }
  return posts;
}
