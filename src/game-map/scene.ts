import * as THREE from 'three';
import type {
  ArenaDef,
  BossDef,
  BuildingKind,
  BuildingSpec,
  CircleFence,
  FenceRun,
  FieldSpec,
  RegionDef,
  RegionId,
  TreeZone,
  Vec2,
  WorldWater,
} from './types';
import { mulberry32 } from '../core/generation/rng';

/** Clearance discs used by scatter so props never invade arenas/buildings. */
const ARENA_CLEAR: [number, number, number][] = [
  [-26, 44, 17],
  [2, -10, 16],
  [10, -80, 14],
  [44, -98, 20],
  [-46, -124, 19],
];

const BUILDING_CLEAR: [number, number, number][] = [
  [0, 124, 9], [40, 80, 13], [-52, 74, 12], [52, 44, 8], [-14, 64, 6], [68, 22, 8],
  [14, 58, 6], [-10, 58, 6], [0, 20, 5], [64, 90, 9], [-88, 84, 9], [6, -32, 9],
  [-64, -50, 7], [-34, -52, 8], [26, -54, 8], [66, -52, 9], [64, -112, 9],
  [-46, -143, 14], [78, -118, 7],
];

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
  grassLow: '#6f9b4e',
  grassHigh: '#a2c465',
  startGrass: '#6f9c57',
  farmGrass: '#94b866',
  cropGrass: '#b6b45e',
  pensGrass: '#86a564',
  palaceGrass: '#9a9a62',
  dirt: '#c09a6b',
  dirtDark: '#a37f55',
  stone: '#c3b8a4',
  stoneDark: '#8c8272',
  wood: '#8f6a45',
  woodDark: '#6d4e33',
  woodLight: '#b68b58',
  roofRed: '#c0573e',
  roofBlue: '#4f7da0',
  roofMoss: '#6d7f4c',
  roofThatch: '#c2a15a',
  wallCream: '#efdcb9',
  wallClay: '#d8b68c',
  wallRed: '#a4483a',
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
  accent: '#f0a13c',
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
  start: '#4e8d54',
  farm: '#c3d76b',
  crops: '#eccb4e',
  pens: '#74ad78',
  final: '#c4a068',
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
export function terrainHeight(x: number, z: number, water: WorldWater): number {
  let height = (fbm(x * 0.021 + 3, z * 0.021 - 1) - 0.5) * 2.1;

  // Forest rim north & south rises like a bowl.
  height += Math.max(0, (z - 112) / 40) ** 1.6 * 5.5;
  height += Math.max(0, (-z - 132) / 30) ** 1.6 * 4.5;
  // West forest wall.
  height += Math.max(0, (-x - 96) / 30) ** 1.7 * 4.0;

  // Windmill knolls.
  height += Math.exp(-(((x - 64) ** 2 + (z - 90) ** 2) / 420)) * 2.6;
  height += Math.exp(-(((x + 88) ** 2 + (z - 84) ** 2) / 460)) * 3.0;
  // Sheep hill (pens east).
  height += Math.exp(-(((x - 62) ** 2 + (z + 62) ** 2) / 900)) * 2.8;
  // Palace mesa rises toward the finale.
  height += Math.exp(-(((x + 46) ** 2 + (z + 126) ** 2) / 1100)) * 2.2;
  // Threshing yard is a flat pan.
  const yardDist = Math.hypot(x + 26, z - 44);
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
  const root = new THREE.Group();
  root.name = 'game-map';
  const materials: Materials = { flat: new Map() };
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  const regionPickables = new Map<string, THREE.Object3D[]>();
  const animated: ((elapsed: number) => void)[] = [];

  const heightAt = (x: number, z: number) => terrainHeight(x, z, data.water);

  const track = <T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(item: T): T => {
    disposables.push(item);
    return item;
  };

  /* ------------------------------------------------------------ terrain */
  const terrainSizeX = 246;
  const terrainSizeZ = 314;
  const terrainGeometry = track(new THREE.PlaneGeometry(terrainSizeX, terrainSizeZ, 150, 180));
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
    // 1 deep inside a region, 0.35 far outside it: a gentle wash everywhere.
    const blend = THREE.MathUtils.clamp(1 - nearestDistance / 26, 0, 1);
    return { id: nearest, amount: 0.3 + blend * 0.42 };
  };

  const centerZ = 4;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index) + centerZ;
    position.setZ(index, z);
    position.setY(index, heightAt(x, z));
    const variation = fbm(x * 0.05, z * 0.05);
    scratch.copy(low).lerp(high, variation);
    // Region tint: each zone reads with its own grass hue.
    const { id, amount } = tintStrength(x, z);
    const tint = regionColors.get(id)!;
    scratch.lerp(tint, amount);
    // Wet sand along the river, canal and pond banks.
    const shore = Math.min(
      riverDistance(x, z, data.water.river).distance - data.water.riverWidth * 0.5,
      riverDistance(x, z, data.water.canal).distance - data.water.canalWidth * 0.5,
      Math.hypot(x - data.water.pond.x, z - data.water.pond.z) - data.water.pond.r,
    );
    if (shore < 7) scratch.lerp(sandColour, THREE.MathUtils.clamp(1 - shore / 7, 0, 1) * 0.85);
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
  root.add(terrainMesh);

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

  /* ------------------------------------------------------- diorama base */
  buildDioramaBase(root, materials, heightAt);
  // Horizon: small green hills ringing the slab, drawn behind everything.
  buildDistantHills(root, animated);

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
  buildScatter(root, materials, heightAt);

  /* ------------------------------------------------------------ critters */
  buildCritters(root, materials, heightAt, animated);
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

function buildField(
  root: THREE.Group,
  materials: Materials,
  field: FieldSpec,
  heightAt: (x: number, z: number) => number,
) {
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
  const soil = PALETTE.dirtDark;
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
  const density = field.density ?? (w * d) / 1.7;
  const rows = Math.max(2, Math.round(Math.sqrt(density * (d / w))));
  const cols = Math.max(2, Math.round(density / rows));
  const color =
    field.kind === 'wheat'
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

  if (field.kind === 'sunflower' || field.kind === 'wheat') {
    const headGeometry = field.kind === 'sunflower'
      ? new THREE.CylinderGeometry(0.24, 0.24, 0.06, 8)
      : new THREE.ConeGeometry(0.12, 0.44, 5);
    const stemGeometry = new THREE.CylinderGeometry(0.025, 0.035, field.kind === 'sunflower' ? 1.3 : 0.7, 4);
    const count = Math.min(320, rows * cols);
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
      const height = field.kind === 'sunflower' ? 1.25 + rng() * 0.35 : 0.6 + rng() * 0.2;
      dummy.position.set(px, py + height / 2, pz);
      dummy.rotation.set(0, rng() * Math.PI, field.kind === 'sunflower' ? (rng() - 0.5) * 0.4 : (rng() - 0.5) * 0.15);
      dummy.scale.setScalar(0.85 + rng() * 0.3);
      dummy.updateMatrix();
      matrix.copy(dummy.matrix);
      stemInstanced.setMatrixAt(index, matrix);
      dummy.position.y = py + height;
      dummy.rotation.set(field.kind === 'sunflower' ? Math.PI / 2 : 0, 0, 0);
      dummy.updateMatrix();
      headInstanced.setMatrixAt(index, dummy.matrix);
    }
    headInstanced.instanceMatrix.needsUpdate = true;
    stemInstanced.instanceMatrix.needsUpdate = true;
    group.add(headInstanced, stemInstanced);
  } else {
    // Leafy crops: low bushes in rows (cabbages, pumpkins, clover).
    const geometry = new THREE.IcosahedronGeometry(field.kind === 'pumpkin' ? 0.38 : 0.3, 0);
    const count = Math.min(260, rows * cols);
    const instanced = new THREE.InstancedMesh(geometry, cropMaterial, count);
    instanced.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let index = 0; index < count; index += 1) {
      const row = Math.floor(index / cols);
      const col = index % cols;
      const px = x - halfW + 0.6 + (col / Math.max(1, cols - 1)) * (w - 1.2) + (rng() - 0.5) * 0.35;
      const pz = z - halfD + 0.6 + (row / Math.max(1, rows - 1)) * (d - 1.2) + (rng() - 0.5) * 0.35;
      const py = heightAt(px, pz);
      dummy.position.set(px, py + 0.24, pz);
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

function buildTreeZone(
  root: THREE.Group,
  materials: Materials,
  zone: TreeZone,
  heightAt: (x: number, z: number) => number,
) {
  const rng = seededRng(zone.seed * 977 + 13);
  const group = new THREE.Group();
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
    const scale = 0.8 + rng() * 0.7;
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
  group.name = `arena-${arena.id}`;
  // A shallow earth plateau lifts each arena off the sloping ground.
  const plateau = new THREE.Mesh(
    new THREE.CylinderGeometry(arena.radius + 1.6, arena.radius + 2.6, 2.6, 40),
    material(materials, '#9c7a50', { roughness: 1, flatShading: true }),
  );
  plateau.position.y = -1.28;
  plateau.receiveShadow = true;
  group.add(plateau);

  const floorMaterial = material(materials, arena.style === 'palace' ? '#d9c48f' : '#c4a06c', { roughness: 1 });
  const ringMaterial = material(materials, arena.style === 'palace' ? '#8d2f3f' : PALETTE.stoneDark);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(arena.radius, 48), floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.08;
  floor.receiveShadow = true;
  group.add(floor);

  const ring = new THREE.Mesh(new THREE.RingGeometry(arena.radius - 0.7, arena.radius, 48), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.12;
  group.add(ring);

  // A soft marker ring in the arena's own accent colour.
  const accent = new THREE.Mesh(
    new THREE.RingGeometry(arena.radius + 0.15, arena.radius + 0.45, 48),
    material(materials, PALETTE.accent, { roughness: 0.8 }),
  );
  accent.rotation.x = -Math.PI / 2;
  accent.position.y = 0.14;
  group.add(accent);

  if (arena.style === 'threshing') {
    // Threshing machine arms around the rim.
    for (let index = 0; index < 4; index += 1) {
      const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
      const px = Math.cos(angle) * (arena.radius - 1.2);
      const pz = Math.sin(angle) * (arena.radius - 1.2);
      const arm = new THREE.Group();
      arm.position.set(px, 0.1, pz);
      arm.rotation.y = -angle;
      addMesh(arm, new THREE.BoxGeometry(0.6, 1.9, 0.6), material(materials, PALETTE.woodDark), [0, 0.95, 0]);
      const blade = addMesh(
        arm,
        new THREE.BoxGeometry(4.6, 0.16, 0.5),
        material(materials, PALETTE.woodLight),
        [0, 1.9, 0],
      );
      blade.userData.spin = index;
      group.add(arm);
    }
    // Hay bales as arena furniture.
    for (let index = 0; index < 6; index += 1) {
      const angle = (index / 6) * Math.PI * 2 + 0.4;
      const radius = arena.radius + 2.4;
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
  } else if (arena.style === 'yard') {
    // Centre post + hay-bale fence ring.
    addMesh(group, new THREE.CylinderGeometry(0.35, 0.45, 4.2, 8), material(materials, PALETTE.woodDark), [0, 2.1, 0]);
    addMesh(group, new THREE.BoxGeometry(2.4, 0.3, 0.3), material(materials, PALETTE.woodLight), [0, 4.1, 0]);
    for (let index = 0; index < 18; index += 1) {
      const angle = (index / 18) * Math.PI * 2;
      const px = Math.cos(angle) * (arena.radius + 1.6);
      const pz = Math.sin(angle) * (arena.radius + 1.6);
      const bale = addMesh(
        group,
        new THREE.CylinderGeometry(0.85, 0.85, 1.4, 9),
        material(materials, PALETTE.hay),
        [px, heightAt(x + px, z + pz) - y + 0.7, pz],
      );
      bale.rotation.z = Math.PI / 2;
      bale.rotation.y = angle + Math.PI / 2;
    }
  } else if (arena.style === 'ramring') {
    // Stone ring with pillars.
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
    // Bridge arena is visualised by the bridge geometry; add lanterns + reeds.
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
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(4.4, arena.radius * 1.7), material(materials, '#9c2f3f'));
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, 0.1, 2);
    group.add(carpet);
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
  scarecrowShed: { wall: PALETTE.wallClay, roof: PALETTE.roofThatch, trim: PALETTE.woodDark, accent: PALETTE.hay, width: 3, depth: 2.4, wallHeight: 1.8, roofHeight: 1.2, roofStyle: 'gable' },
};

function buildBuildingByKind(
  root: THREE.Group,
  materials: Materials,
  spec: BuildingSpec,
  heightAt: (x: number, z: number) => number,
  animated: ((elapsed: number) => void)[],
) {
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
  const openSided = spec.kind === 'sheepShelter' || spec.kind === 'gatehouse';
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

  if (openSided) {
    if (spec.kind === 'gatehouse') {
    }
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
  const bossPositions: Record<string, [number, number]> = {
    squawk: [2, -10],
    quackmire: [10, -80],
    bristleback: [44, -98],
  };
  for (const boss of bossAnimals) {
    const position = bossPositions[boss.id]!;
    const group = boss.make();
    group.position.set(position[0], heightAt(position[0], position[1]) + 0.2, position[1]);
    group.rotation.y = Math.PI * 0.9;
    group.name = `boss-${boss.id}`;
    root.add(group);
    animated.push((elapsed) => {
      group.position.y = heightAt(position[0], position[1]) + 0.2 + Math.sin(elapsed * 1.2 + position[0]) * 0.06;
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
  const queen = new THREE.Group();
  const queenBody = addMesh(queen, new THREE.SphereGeometry(1.7, 12, 9), white, [0, 2.1, 0]);
  queenBody.scale.set(1.1, 1.15, 1.25);
  addMesh(queen, new THREE.SphereGeometry(1.0, 10, 8), white, [0, 3.9, 0.5]);
  addMesh(queen, new THREE.ConeGeometry(0.34, 0.8, 5), orange, [0, 3.8, 1.5]).rotation.x = Math.PI / 2;
  addMesh(queen, new THREE.SphereGeometry(0.26, 7, 6), red, [0, 4.5, 0.35]);
  for (const side of [-1, 1]) {
    const wing = addMesh(queen, new THREE.SphereGeometry(0.75, 8, 6), cream, [side * 1.7, 2.2, 0]);
    wing.scale.set(0.5, 1.1, 1.4);
    wing.rotation.z = side * 0.3;
    addMesh(queen, new THREE.SphereGeometry(0.09, 6, 5), black, [side * 0.32, 4.15, 1.15]);
  }
  // Crown.
  const queenCrown = new THREE.Group();
  queenCrown.position.set(0, 4.75, 0.45);
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    addMesh(queenCrown, new THREE.ConeGeometry(0.12, 0.5, 4), material(materials, '#ffd166'), [Math.cos(angle) * 0.34, 0.24, Math.sin(angle) * 0.34]);
  }
  addMesh(queenCrown, new THREE.TorusGeometry(0.36, 0.08, 5, 14), material(materials, '#ffd166'), [0, 0, 0]).rotation.x = Math.PI / 2;
  queen.add(queenCrown);
  // Hay throne.
  addMesh(queen, new THREE.BoxGeometry(4.2, 1.2, 2.4), material(materials, PALETTE.hay), [0, 0.6, -1.2]);
  addMesh(queen, new THREE.BoxGeometry(4.2, 4.2, 0.8), material(materials, PALETTE.hayDark), [0, 2.6, -2.4]);
  queen.position.set(-46, heightAt(-46, -132) + 0.2, -131);
  queen.name = 'boss-cluckzilla';
  root.add(queen);
  animated.push((elapsed) => {
    queenCrown.rotation.y = elapsed * 0.5;
    queen.position.y = heightAt(-46, -131) + 0.2 + Math.sin(elapsed * 0.9 + 2) * 0.05;
  });

  // Idle wander for critters: tiny bobbing, no pathfinding needed at map scale.
  animated.push((elapsed) => {
    for (const critter of critters) {
      critter.group.position.y += Math.sin(elapsed * 2.2 + critter.phase) * 0.0006;
      critter.group.rotation.y += Math.sin(elapsed * 0.4 + critter.phase) * 0.0012;
    }
  });
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
  const steps = 30;
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const angle = Math.PI + t * Math.PI;
    const radius = 120 + Math.sin(angle * 3) * 3;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius * 1.28 + 3;
    const y = heightAt(x, z);
    addMesh(root, new THREE.BoxGeometry(0.4, 1.6, 0.4), postMaterial, [x, y + 0.8, z]);
  }
}


/* ==================================================== distant green hills */

/**
 * Height of the horizon saucer under a point, relative to its own rest Y.
 *
 * The ground and the hills both read from this single function: the bug it
 * prevents was hills floating in the sky because the ground curved away faster
 * than their fixed base heights assumed.
 */
export function horizonGroundOffset(x: number, z: number): number {
  const radius = Math.min(1, Math.hypot(x, z) / HORIZON_RADIUS);
  // Flat for the whole area the hills occupy; the falloff only starts past 80%
  // of the radius. Curving under the hills was what made them look airborne.
  const falloff = Math.max(0, radius - 0.8);
  return -(falloff * falloff) * 22;
}

/** Rest height of the horizon saucer mesh. */
export const HORIZON_Y = -3.2;

/**
 * Hill colour per ring, near to far. Exported so the aerial-perspective test
 * can assert the real values instead of restating them, and so the backdrop
 * cannot drift back to hill-green-on-ground-green (which erased the hills).
 */
/** Flat green of the horizon saucer the hills stand on. */
export const HORIZON_GROUND_COLOR = '#a9c489';

export const HILL_COLORS = {
  near: '#4f8238',
  mid: '#669447',
  far: '#83a862',
} as const;

export const HILL_RINGS = [
  // `minWidth`/`maxWidth` are HALF-extents: a hill is drawn `2 * width` across.
  // Treating them as full widths made every hill twice as wide as intended,
  // which is what turned the backdrop into flat green lily pads.
  { radiusX: 186, radiusZ: 214, count: 30, minHeight: 5.0, maxHeight: 7.4, minWidth: 9, maxWidth: 13, materialKey: 'near' as const, seed: 3 },
  { radiusX: 252, radiusZ: 290, count: 34, minHeight: 6.4, maxHeight: 8.6, minWidth: 12, maxWidth: 17, materialKey: 'mid' as const, seed: 21 },
  { radiusX: 330, radiusZ: 378, count: 38, minHeight: 7.6, maxHeight: 9.6, minWidth: 16, maxWidth: 22, materialKey: 'far' as const, seed: 47 },
] as const;

/**
 * Radius of the horizon saucer, derived from the farthest hill's reach.
 *
 * Computed rather than hand-picked: a hard-coded number silently drifts out of
 * sync when a ring moves, and a hill beyond the disc renders against bare sky —
 * the "floating green pancake" bug.
 */
export const HORIZON_RADIUS = (() => {
  let reach = 0;
  for (const ring of HILL_RINGS) {
    // Jitter peaks at 1.1x; `maxWidth` is a half-extent, so one hill reaches
    // exactly that far past its centre.
    reach = Math.max(reach, Math.hypot(ring.radiusX, ring.radiusZ) * 1.1 + ring.maxWidth);
  }
  return Math.ceil(reach + 60);
})();

/**
 * Ring layout for the horizon hills. Exported so tests can assert the actual
 * numbers instead of restating them: the backdrop must stay outside the slab
 * and must stay low and wide.
 */


/** World bounds of the diorama slab, mirrored for the hill spacing test. */
export const DIORAMA_HALF = { x: 122, z: 156 } as const;


/**
 * Small rolling green hills ringing the diorama.
 *
 * The map is a table-top model, so without a horizon the slab floats in empty
 * sky. These are low, wide and squashed — the silhouette of farmland beyond the
 * farm, not mountains — and they get paler with distance so the eye reads depth
 * instead of mistaking them for more playable map.
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

  // Own materials (not the shared cache): these are tinted for atmosphere and
  // must never bleed into a pickable surface's colour.
  const nearMaterial = new THREE.MeshStandardMaterial({ color: HILL_COLORS.near, roughness: 1, flatShading: true });
  const midMaterial = new THREE.MeshStandardMaterial({ color: HILL_COLORS.mid, roughness: 1, flatShading: true });
  const farMaterial = new THREE.MeshStandardMaterial({ color: HILL_COLORS.far, roughness: 1, flatShading: true });

  /* A ridge is a squashed hemisphere sliced at the base so it never shows a
     floating underside: flat bottom, soft dome on top. */
  const makeRidge = (
    material: THREE.Material,
    width: number,
    height: number,
    depth: number,
  ) => {
    const geometry = new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    // Squash and pull the rim down slightly so it beds into the ground plane.
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      position.setY(index, position.getY(index) * 0.92 - 0.04);
    }
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(width, height, depth);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  };

  const ridges: THREE.Mesh[] = [];

  const rings = HILL_RINGS.map((ring) => ({
    ...ring,
    material:
      ring.materialKey === 'near' ? nearMaterial : ring.materialKey === 'mid' ? midMaterial : farMaterial,
  }));

  for (const ring of rings) {
    for (let index = 0; index < ring.count; index += 1) {
      const t = index / ring.count;
      // Offset each ring so hills do not line up radially into visible spokes.
      // The histogram-ish jitter here is what breaks the "beads on a wire" look:
      // evenly spaced hills on a perfect ellipse read as a drawn arc, not a
      // landscape. Clumping them irregularly is the whole difference.
      const angleJitter = (hash2(index, ring.seed + 7) - 0.5) * 0.9;
      const angle = t * Math.PI * 2 + hash2(ring.seed, index) * 0.3 + angleJitter / ring.count;
      // Wide radial spread, biased outward, so hills form clusters and gaps.
      const spread = hash2(index, ring.seed + 5) + hash2(index * 3, ring.seed + 8);
      const jitter = 0.94 + (spread * 0.5) * 0.34;
      const x = Math.cos(angle) * ring.radiusX * jitter;
      const z = Math.sin(angle) * ring.radiusZ * jitter;

      const height = ring.minHeight + hash2(index, ring.seed + 1) * (ring.maxHeight - ring.minHeight);
      const width = ring.minWidth + hash2(index, ring.seed + 2) * (ring.maxWidth - ring.minWidth);

      const ridge = makeRidge(ring.material, width, height, width * (0.7 + hash2(index, 9) * 0.5));
      // Bed each hill into the saucer: follow its curve, then sink a little so
      // no rim shows. Clamping to `ring.y` here was the bug that floated them.
      const groundY = HORIZON_Y + horizonGroundOffset(x, z);
      ridge.position.set(x, groundY - height * 0.18, z);
      ridge.rotation.y = hash2(index, ring.seed + 4) * Math.PI;
      ridge.name = `hill-${ring.seed}-${index}`;
      group.add(ridge);
      ridges.push(ridge);
    }
  }

  /* A soft, wide ground plane under the hills, close to the sky/fog colour so
     the model sits on a horizon rather than on a hard disc. Deliberately thin
     and low: it must never read as a second map. */
  // A grid, not a CircleGeometry fan.
  //
  // CircleGeometry makes 96 long triangles that all touch the centre. Any
  // renderer that culls whole triangles against the near plane (the offline
  // painter does) discards *all* of them, so the ground vanishes and the hills
  // appear to float. Subdividing into small tiles fixes that and also lets the
  // falloff be smooth.
  const TILES = 40;
  const groundGeometry = new THREE.PlaneGeometry(
    HORIZON_RADIUS * 2,
    HORIZON_RADIUS * 2,
    TILES,
    TILES,
  );
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPosition = groundGeometry.attributes.position as THREE.BufferAttribute;
  for (let index = 0; index < groundPosition.count; index += 1) {
    const x = groundPosition.getX(index);
    const z = groundPosition.getZ(index);
    const radius = Math.hypot(x, z);
    if (radius > HORIZON_RADIUS) {
      // Clip the square grid back to a disc by collapsing the outside ring down
      // to a point; the far hills hide the seam.
      groundPosition.setX(index, (x / radius) * HORIZON_RADIUS);
      groundPosition.setZ(index, (z / radius) * HORIZON_RADIUS);
    }
    groundPosition.setY(index, horizonGroundOffset(x, z));
  }
  groundGeometry.computeVertexNormals();
  const groundMaterial = new THREE.MeshStandardMaterial({ color: HORIZON_GROUND_COLOR, roughness: 1 });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.position.set(0, HORIZON_Y, 0);
  ground.castShadow = false;
  ground.receiveShadow = false;
  ground.name = 'hill-ground';
  group.add(ground);

  root.add(group);

  animated.push((elapsed) => {
    // Nothing moves: distant terrain that breathes looks like a rendering bug.
    // The handler stays so the animation array shape stays uniform.
    void elapsed;
    void ridges;
  });
}

/* ============================================================ diorama base */

/** The map as a table-top diorama: a cliff skirt around the terrain edge. */
function buildDioramaBase(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
) {
  const halfX = DIORAMA_HALF.x;
  const halfZ = DIORAMA_HALF.z;
  const bottom = -16;
  const radius = 20;
  const perimeter: [number, number][] = [];
  const corner = (cx: number, cz: number, startAngle: number) => {
    for (let step = 0; step <= 10; step += 1) {
      const angle = startAngle + (step / 10) * (Math.PI / 2);
      perimeter.push([cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius]);
    }
  };
  corner(halfX - radius, halfZ - radius, 0);
  corner(-halfX + radius, halfZ - radius, Math.PI / 2);
  corner(-halfX + radius, -halfZ + radius, Math.PI);
  corner(halfX - radius, -halfZ + radius, Math.PI * 1.5);

  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  const earthDark = new THREE.Color('#6f5036');
  const earthLight = new THREE.Color('#b08a62');

  for (let index = 0; index < perimeter.length; index += 1) {
    const point = perimeter[index]!;
    const next = perimeter[(index + 1) % perimeter.length]!;
    const [x, z] = point;
    const [nx, nz] = next;
    const topY = heightAt(x, z) - 0.15;
    const topNextY = heightAt(nx, nz) - 0.15;
    const base = positions.length / 3;
    positions.push(x, topY, z, x, bottom, z, nx, topNextY, nz, nx, bottom, nz);
    // Vertical colour bands: grass lip, roots, deep earth.
    colors.push(
      earthLight.r, earthLight.g, earthLight.b,
      earthDark.r, earthDark.g, earthDark.b,
      earthLight.r, earthLight.g, earthLight.b,
      earthDark.r, earthDark.g, earthDark.b,
    );
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  // Bottom cap.
  const centerIndex = positions.length / 3;
  positions.push(0, bottom, 0);
  colors.push(earthDark.r, earthDark.g, earthDark.b);
  for (let index = 0; index < perimeter.length; index += 1) {
    const nextIndex = (index + 1) % perimeter.length;
    const aIndex = index * 4 + 1;
    const bIndex = nextIndex * 4 + 1;
    indices.push(centerIndex, bIndex, aIndex);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const skirt = new THREE.Mesh(
    geometry,
    material(materials, '#ffffff', { vertexColors: true, roughness: 1, flatShading: true, side: THREE.DoubleSide, emissive: new THREE.Color('#2b1d12'), emissiveIntensity: 0.35 }),
  );
  skirt.receiveShadow = true;
  skirt.name = 'diorama-skirt';
  root.add(skirt);

  // Horizontal strata band around the middle of the cliff.
  const band: number[] = [];
  const bandIndices: number[] = [];
  for (let index = 0; index < perimeter.length; index += 1) {
    const [x, z] = perimeter[index]!;
    band.push(x, -5.6, z, x, -6.8, z);
  }
  for (let index = 0; index < perimeter.length; index += 1) {
    const nextIndex = (index + 1) % perimeter.length;
    const a = index * 2;
    const b = nextIndex * 2;
    bandIndices.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const bandGeometry = new THREE.BufferGeometry();
  bandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(band, 3));
  bandGeometry.setIndex(bandIndices);
  bandGeometry.computeVertexNormals();
  const bandMesh = new THREE.Mesh(bandGeometry, material(materials, '#b0906b', { roughness: 1, side: THREE.DoubleSide }));
  root.add(bandMesh);

  // Rock chunks poking out of the cut.
  const rockMaterial = material(materials, '#75604a', { flatShading: true });
  for (let index = 0; index < 26; index += 1) {
    const t = index / 26;
    const angle = t * Math.PI * 2;
    const px = Math.cos(angle) * (halfX - 2.2);
    const pz = Math.sin(angle) * (halfZ - 2.2);
    const rock = addMesh(
      root,
      new THREE.DodecahedronGeometry(1.0 + hash2(index, 2) * 0.8, 0),
      rockMaterial,
      [px, -4 - hash2(index, 5) * 8, pz],
    );
    rock.scale.set(1.25, 0.75, 1.25);
  }
}

/* ================================================================ scatter */

/** Grass tufts, stones, bushes, hay bales and sunflowers across the map. */
function buildScatter(
  root: THREE.Group,
  materials: Materials,
  heightAt: (x: number, z: number) => number,
) {
  const tuftMaterial = material(materials, '#7fb152', { flatShading: true, roughness: 1 });
  const tuftGeometry = new THREE.ConeGeometry(0.16, 0.55, 3);
  const tufts = new THREE.InstancedMesh(tuftGeometry, tuftMaterial, 700);
  const rockMaterial = material(materials, '#a49a88', { flatShading: true, roughness: 1 });
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.42, 0), rockMaterial, 90);
  const bushMaterial = material(materials, '#4e8642', { flatShading: true });
  const bushes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.75, 0), bushMaterial, 120);
  const hayMaterial = material(materials, PALETTE.hay, { roughness: 1 });
  const dummy = new THREE.Object3D();
  const rng = mulberry32(20261116);

  const nearArena = (x: number, z: number) =>
    ARENA_CLEAR.some((arena) => Math.hypot(x - arena[0], z - arena[1]) < arena[2]);
  const nearBuilding = (x: number, z: number) =>
    BUILDING_CLEAR.some((spot) => Math.hypot(x - spot[0], z - spot[1]) < spot[2]);

  let bushCount = 0;
  let rockCount = 0;
  let tuftCount = 0;
  for (let attempt = 0; attempt < 2600; attempt += 1) {
    const x = (rng() - 0.5) * 224;
    const z = (rng() - 0.5) * 268 + 3;
    if (nearArena(x, z) || nearBuilding(x, z)) continue;
    // Keep the main avenue readable.
    if (Math.abs(x) < 5 && z > -150 && z < 150) continue;
    const y = heightAt(x, z);
    const roll = rng();
    if (roll < 0.72 && tuftCount < 700) {
      dummy.position.set(x, y + 0.22, z);
      dummy.rotation.set((rng() - 0.5) * 0.2, rng() * Math.PI, (rng() - 0.5) * 0.2);
      dummy.scale.setScalar(0.7 + rng() * 0.8);
      dummy.updateMatrix();
      tufts.setMatrixAt(tuftCount++, dummy.matrix);
    } else if (roll < 0.86 && rockCount < 90) {
      dummy.position.set(x, y + 0.14, z);
      dummy.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      dummy.scale.set(0.6 + rng() * 0.9, 0.5 + rng() * 0.5, 0.6 + rng() * 0.9);
      dummy.updateMatrix();
      rocks.setMatrixAt(rockCount++, dummy.matrix);
    } else if (bushCount < 120) {
      dummy.position.set(x, y + 0.4, z);
      dummy.rotation.y = rng() * Math.PI;
      dummy.scale.set(0.7 + rng() * 0.9, 0.6 + rng() * 0.6, 0.7 + rng() * 0.9);
      dummy.updateMatrix();
      bushes.setMatrixAt(bushCount++, dummy.matrix);
    }
  }
  tufts.count = tuftCount;
  rocks.count = rockCount;
  bushes.count = bushCount;
  for (const mesh of [tufts, rocks, bushes]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = mesh !== tufts;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Hay bales at barns and threshing yards (landmarks, not scatter).
  const haySpots: [number, number][] = [
    [-44, 62], [-40, 66], [-36, 62], [52, 38], [56, 42], [70, -108], [74, -104],
    [-92, 78], [-88, 74], [24, -44], [30, -48],
  ];
  for (const [x, z] of haySpots) {
    const bale = addMesh(
      root,
      new THREE.CylinderGeometry(0.85, 0.85, 1.5, 10),
      hayMaterial,
      [x, heightAt(x, z) + 0.8, z],
    );
    bale.rotation.z = Math.PI / 2;
    bale.rotation.y = hash2(x, z) * Math.PI;
    addMesh(root, new THREE.TorusGeometry(0.86, 0.05, 4, 12), material(materials, PALETTE.hayDark), [x, heightAt(x, z) + 0.8, z]).rotation.y = Math.PI / 2;
  }

  // Sunflower clusters along the crops roads, for colour.
  const sunflowers: [number, number][] = [
    [-34, 36], [-36, 38], [-32, 40], [-88, 30], [-84, 28], [-92, 32], [-60, 20], [-56, 22],
  ];
  for (const [x, z] of sunflowers) {
    const stem = addMesh(
      root,
      new THREE.CylinderGeometry(0.05, 0.06, 1.6, 4),
      material(materials, '#6f8b3f'),
      [x, heightAt(x, z) + 0.8, z],
    );
    stem.castShadow = false;
    const head = addMesh(
      root,
      new THREE.CylinderGeometry(0.34, 0.34, 0.08, 8),
      material(materials, PALETTE.sunflower),
      [x, heightAt(x, z) + 1.6, z],
    );
    head.rotation.x = Math.PI / 2;
  }
}
