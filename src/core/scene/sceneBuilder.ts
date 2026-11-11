import * as THREE from 'three';
import type {
  BuildingObject,
  LanternObject,
  MaterialSettings,
  PrimitiveObject,
  RockObject,
  SceneNode,
  Transform,
  TreeObject,
  WorldEnvironment,
  WorldGroup,
  WorldObject,
  WorldPlan,
} from '../../core/world-plan/schema';
import { createTerrainSampler, type TerrainSampler } from '../../core/generation/terrain';
import { lodCells, type ChunkLayout, type ChunkSpec } from '../../core/terrain/chunks';
import { isEffectivelyVisible } from '../../core/world-plan/hierarchy';
import { addMesh, material, mergeStaticMeshes } from './kit';
import { getSurfaceTexture } from './textures';
import { buildGeneratedGeometry } from './generatedMesh';
import { buildPhotoModelGeometry } from './photoModel';
import { buildExpandedAsset } from './expandedAssets';
import { buildMiningObject } from './miningObjects';
import { buildBarn, buildBush, buildBridge, buildCoop, buildFence, buildField, buildPath, buildRiver } from './proceduralObjects';

export interface BuildSceneOptions {
  /** Adds sky/sun/hemisphere lights (the viewport needs them; exporters do not). */
  includeLights?: boolean;
  /** Hard cap on lantern point lights for mobile GPUs. */
  maxPointLights?: number;
  /** Lower than the plan resolution for cheap shadow passes. */
  terrainResolutionCap?: number;
  /** Shadow map resolution for the directional light. */
  shadowMapSize?: number;
  includeHidden?: boolean;
}

const MAX_DEFAULT_POINT_LIGHTS = 12;

function tagObject(group: THREE.Object3D, object: WorldObject): void {
  group.name = object.name;
  group.userData.worldObjectId = object.id;
  if (object.meta.photoModel) { group.userData.imageSource = object.meta.photoModel.source; group.userData.imageApproximation = object.meta.photoModel.mode ?? 'silhouette'; group.userData.imageMeshStyle = object.meta.photoModel.meshStyle ?? 'blocky'; }
  group.traverse((child) => {
    child.userData.worldObjectId = object.id;
  });
}

function tagGroup(group: THREE.Object3D, node: WorldGroup): void {
  group.name = node.name;
  group.userData.worldGroupId = node.id;
  group.traverse((child) => {
    child.userData.worldGroupId = node.id;
  });
}

/** Apply a node's local TRS to a Three.js object (degrees → radians). */
export function applyTransform(target: THREE.Object3D, transform: Transform): void {
  target.position.set(...transform.position);
  target.rotation.set(
    THREE.MathUtils.degToRad(transform.rotation[0]),
    THREE.MathUtils.degToRad(transform.rotation[1]),
    THREE.MathUtils.degToRad(transform.rotation[2]),
    'XYZ',
  );
  target.scale.set(...transform.scale);
}

/** Read a Three.js object's local TRS back into a WorldPlan transform. */
export function readTransform(source: THREE.Object3D): Transform {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    position: [round(source.position.x), round(source.position.y), round(source.position.z)],
    rotation: [
      round(THREE.MathUtils.radToDeg(source.rotation.x)),
      round(THREE.MathUtils.radToDeg(source.rotation.y)),
      round(THREE.MathUtils.radToDeg(source.rotation.z)),
    ],
    scale: [
      Math.max(0.05, round(source.scale.x)),
      Math.max(0.05, round(source.scale.y)),
      Math.max(0.05, round(source.scale.z)),
    ],
  };
}

/** Override PBR values for every material in an object (shared materials untouched). */
function applyMaterialSettings(object: THREE.Object3D, settings?: MaterialSettings): void {
  if (!settings) return;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const entry of materials) {
      if (!(entry instanceof THREE.MeshStandardMaterial)) continue;
      if (settings.roughness !== undefined) entry.roughness = settings.roughness;
      if (settings.metalness !== undefined) entry.metalness = settings.metalness;
      if (
        settings.emissiveIntensity !== undefined &&
        entry.emissive !== undefined &&
        entry.emissive.getHex() !== 0x000000
      ) {
        entry.emissiveIntensity = settings.emissiveIntensity;
      }
    }
  });
}

const TERRAIN_ROCK = new THREE.Color('#7d7b73');
const TERRAIN_SAND = new THREE.Color('#d9c9a1');
const TERRAIN_SNOW = new THREE.Color('#f2f6f8');
const TERRAIN_BED = new THREE.Color('#48564e');

function terrainSurfaceTexture(plan: WorldPlan): THREE.Texture {
  const style = plan.terrain.style;
  if (style === 'dunes' || style === 'islands') return getSurfaceTexture('sand');
  if (['mountains', 'canyon', 'plateau', 'volcano', 'crater'].includes(style)) return getSurfaceTexture('stone');
  return getSurfaceTexture('grass');
}

function terrainMaterial(plan: WorldPlan): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.97,
    metalness: 0,
    map: terrainSurfaceTexture(plan),
  });
}

/**
 * Vertex colours for a terrain surface.
 *
 * Without a baked landscape this is exactly the classic two-colour ramp. With
 * one, the colour at a vertex is the biome blend at that point, pushed towards
 * rock on cliff faces, sand on shores and dunes, snow above the snow line, and a
 * silty bed colour below the water line. Every one of those weights comes from
 * the same bake that produced the heights, so colour and shape always agree.
 */
function paintTerrainColors(
  plan: WorldPlan,
  sampler: TerrainSampler,
  position: THREE.BufferAttribute,
  normal: THREE.BufferAttribute,
  colors: Float32Array,
  center: { x: number; z: number },
): void {
  const low = new THREE.Color(plan.terrain.palette.low);
  const high = new THREE.Color(plan.terrain.palette.high);
  const scratch = new THREE.Color();
  const landscape = sampler.landscape;
  const biomeColors = landscape
    ? landscape.biomes.entries.map((entry) => ({ low: new THREE.Color(entry.palette.low), high: new THREE.Color(entry.palette.high) }))
    : [];
  const waterLevel = plan.terrain.waterLevel;

  for (let index = 0; index < position.count; index += 1) {
    // Vertex positions are local to the piece being painted; colours are sampled
    // in world space so neighbouring chunks agree at their shared edge.
    const x = position.getX(index) + center.x;
    const z = position.getZ(index) + center.z;
    const ratio = sampler.normalizedHeightAt(x, z);

    if (!landscape || biomeColors.length === 0) {
      scratch.copy(low).lerp(high, ratio);
    } else {
      const weights = landscape.biomes.weightsAt(x, z);
      let total = 0;
      let lowR = 0;
      let lowG = 0;
      let lowB = 0;
      let highR = 0;
      let highG = 0;
      let highB = 0;
      for (const entry of weights) {
        const palette = biomeColors[entry.index];
        if (!palette) continue;
        total += entry.weight;
        lowR += palette.low.r * entry.weight;
        lowG += palette.low.g * entry.weight;
        lowB += palette.low.b * entry.weight;
        highR += palette.high.r * entry.weight;
        highG += palette.high.g * entry.weight;
        highB += palette.high.b * entry.weight;
      }
      if (total > 0) {
        // Blending happens in the renderer's working colour space, matching the
        // way three.js mixes any two `Color` values.
        scratch.setRGB(
          (lowR + (highR - lowR) * ratio) / total,
          (lowG + (highG - lowG) * ratio) / total,
          (lowB + (highB - lowB) * ratio) / total,
        );
      } else {
        scratch.copy(low).lerp(high, ratio);
      }

      const { field, masks } = landscape;
      const rock = masks.rock.sample(field, x, z);
      if (rock > 0.01) scratch.lerp(TERRAIN_ROCK, Math.min(0.85, rock));
      const sand = masks.sand.sample(field, x, z);
      if (sand > 0.01) scratch.lerp(TERRAIN_SAND, Math.min(0.9, sand));
      const snow = masks.snow.sample(field, x, z);
      if (snow > 0.01) scratch.lerp(TERRAIN_SNOW, Math.min(0.92, snow));
      if (waterLevel !== null) {
        const depth = waterLevel - sampler.heightAt(x, z);
        if (depth > 0) {
          const bed = Math.min(0.6, (depth / Math.max(1, plan.terrain.heightScale * 0.6)) * 0.6);
          scratch.lerp(TERRAIN_BED, bed);
        }
      }
    }

    // Steep slopes read darker, which gives the low-poly terrain more depth.
    const slope = 0.82 + Math.max(0, normal.getY(index)) * 0.18;
    colors[index * 3] = scratch.r * slope;
    colors[index * 3 + 1] = scratch.g * slope;
    colors[index * 3 + 2] = scratch.b * slope;
  }
}

/** Displaces a plane onto the terrain surface and paints it. */
function buildTerrainGeometry(
  plan: WorldPlan,
  sampler: TerrainSampler,
  width: number,
  depth: number,
  cells: number,
  center: { x: number; z: number },
  skirt = 0,
): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth, cells, cells);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const halfWidth = width / 2 - 1e-4;
  const halfDepth = depth / 2 - 1e-4;
  for (let index = 0; index < position.count; index += 1) {
    const localX = position.getX(index);
    const localZ = position.getZ(index);
    let height = sampler.heightAt(center.x + localX, center.z + localZ);
    // Drop the border ring so seams between levels of detail stay hidden.
    if (skirt > 0 && (Math.abs(localX) >= halfWidth || Math.abs(localZ) >= halfDepth)) height -= skirt;
    position.setY(index, height);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const colors = new Float32Array(position.count * 3);
  paintTerrainColors(plan, sampler, position, geometry.attributes.normal as THREE.BufferAttribute, colors, center);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function createTerrainMesh(plan: WorldPlan, resolutionCap = 192): THREE.Mesh {
  const segments = Math.max(
    8,
    Math.min(plan.terrain.resolution, resolutionCap),
  );
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const geometry = buildTerrainGeometry(plan, sampler, plan.terrain.size, plan.terrain.size, segments, { x: 0, z: 0 });

  const mesh = new THREE.Mesh(geometry, terrainMaterial(plan));
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

export interface TerrainChunkEntry {
  chunk: ChunkSpec;
  mesh: THREE.Mesh;
  cells: number;
}

export interface TerrainLodState {
  plan: WorldPlan;
  sampler: TerrainSampler;
  layout: ChunkLayout;
  entries: TerrainChunkEntry[];
  material: THREE.MeshStandardMaterial;
  resolutionCap: number;
}

/**
 * Builds the terrain as a grid of chunks with per-chunk level of detail.
 *
 * Returns `null` when the world has no baked landscape or is too small to gain
 * anything from chunking, so callers keep the single classic mesh. Chunks are
 * separate objects, which means three.js culls the ones behind the camera for
 * free, and only the chunks near the camera pay for fine geometry.
 */
export function createTerrainChunks(
  plan: WorldPlan,
  resolutionCap = 192,
  camera: { x: number; z: number } = { x: 0, z: 0 },
): { group: THREE.Group; state: TerrainLodState } | null {
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const landscape = sampler.landscape;
  if (!landscape || !landscape.chunked) return null;

  const layout = landscape.chunks;
  const material = terrainMaterial(plan);
  const group = new THREE.Group();
  group.name = 'terrain';
  const entries: TerrainChunkEntry[] = [];
  for (const chunk of layout.chunks) {
    const cells = Math.max(2, Math.min(resolutionCap, lodCells(Math.hypot(chunk.x - camera.x, chunk.z - camera.z), layout.lod)));
    const geometry = buildTerrainGeometry(plan, sampler, chunk.size, chunk.size, cells, { x: chunk.x, z: chunk.z }, chunk.skirt);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = chunk.id;
    mesh.position.set(chunk.x, 0, chunk.z);
    mesh.receiveShadow = true;
    entries.push({ chunk, mesh, cells });
    group.add(mesh);
  }
  return { group, state: { plan, sampler, layout, entries, material, resolutionCap } };
}

/**
 * Rebuilds only the chunks whose level of detail changed.
 *
 * Called from the render loop; the common case costs one distance test per
 * chunk and returns 0. `maxRebuilds` spreads the work over several frames so a
 * fast camera move cannot stall a frame on a large map.
 */
export function updateTerrainLod(state: TerrainLodState, cameraX: number, cameraZ: number, maxRebuilds = Infinity): number {
  let rebuilt = 0;
  for (const entry of state.entries) {
    if (rebuilt >= maxRebuilds) break;
    const cells = Math.max(2, Math.min(state.resolutionCap, lodCells(Math.hypot(entry.chunk.x - cameraX, entry.chunk.z - cameraZ), state.layout.lod)));
    if (cells === entry.cells) continue;
    const geometry = buildTerrainGeometry(
      state.plan,
      state.sampler,
      entry.chunk.size,
      entry.chunk.size,
      cells,
      { x: entry.chunk.x, z: entry.chunk.z },
      entry.chunk.skirt,
    );
    entry.mesh.geometry.dispose();
    entry.mesh.geometry = geometry;
    entry.cells = cells;
    rebuilt += 1;
  }
  return rebuilt;
}

/** Releases every chunk geometry and the shared material. */
export function disposeTerrainLod(state: TerrainLodState): void {
  for (const entry of state.entries) {
    entry.mesh.geometry.dispose();
    entry.mesh.removeFromParent();
  }
  state.material.dispose();
  state.entries.length = 0;
}

export function createWaterMesh(plan: WorldPlan): THREE.Mesh | null {
  if (plan.terrain.waterLevel === null) return null;
  const geometry = new THREE.PlaneGeometry(plan.terrain.size * 1.5, plan.terrain.size * 1.5, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: '#3f7d9c',
      roughness: 0.22,
      metalness: 0.12,
      transparent: true,
      opacity: 0.74,
    }),
  );
  mesh.name = 'water';
  mesh.position.y = plan.terrain.waterLevel;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  return mesh;
}

function buildPrimitive(object: PrimitiveObject): THREE.Group {
  const expanded = buildExpandedAsset(object);
  if (expanded) return expanded;
  if (object.primitive === 'generated-mesh' && object.meta.generatedMesh) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(buildGeneratedGeometry(object.meta.generatedMesh), new THREE.MeshStandardMaterial({ color: object.color, vertexColors: true, roughness: .85 }));
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }
  if (object.primitive === 'photo-model' && object.meta.photoModel) {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(buildPhotoModelGeometry(object.meta.photoModel), new THREE.MeshStandardMaterial({ color: object.color, vertexColors: true, roughness: .85 }));
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'photo-model-mesh';
    group.add(mesh);
    return group;
  }
  if (['mine-entrance', 'mine-cart', 'pickaxe', 'excavator', 'chest'].includes(object.primitive)) {
    const mining = buildMiningObject(object);
    if (mining) return mining;
  }
  const group = new THREE.Group();
  const mat = material(object.color, { roughness: 0.78, flatShading: object.primitive !== 'torus' });
  let geometry: THREE.BufferGeometry;
  let lift = 1;

  switch (object.primitive) {
    case 'box':
      geometry = new THREE.BoxGeometry(2, 2, 2);
      break;
    case 'sphere':
      geometry = new THREE.SphereGeometry(1, 20, 14);
      break;
    case 'cylinder':
      geometry = new THREE.CylinderGeometry(1, 1, 2, 20);
      break;
    case 'cone':
      geometry = new THREE.ConeGeometry(1, 2, 20);
      break;
    case 'torus':
      geometry = new THREE.TorusGeometry(0.78, 0.26, 12, 28);
      break;
    case 'plane':
      geometry = new THREE.BoxGeometry(2.4, 0.18, 2.4);
      lift = 0.09;
      break;
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }

  addMesh(group, geometry, mat, [0, lift, 0]);
  return group;
}

/** Shapes assembled from the learned dimensions and a reproducible variation seed. */
function buildLearnedTree(object: TreeObject): THREE.Group {
  const group = new THREE.Group();
  const shape = object.meta.learnedShape!;
  const foliage = material(object.color, { roughness: 0.94, flatShading: true, map: getSurfaceTexture('foliage') });
  const trunk = material(object.trunkColor, { roughness: 1, flatShading: true, map: getSurfaceTexture('bark') });
  addMesh(group, new THREE.CylinderGeometry(0.17, 0.31, 2.1, 7), trunk, [0, 1.05, 0]);
  addMesh(group, new THREE.IcosahedronGeometry(1.05 * shape.detail, 1), foliage, [0, 2.8, 0]);
  const count = 3 + shape.seed % 3;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (shape.seed % 63) / 10;
    addMesh(group, new THREE.IcosahedronGeometry(0.55 * shape.detail, 1), foliage,
      [Math.cos(angle) * 0.68, 2.35 + ((shape.seed >>> (i * 3)) % 3) * 0.14, Math.sin(angle) * 0.68]);
  }
  return group;
}

function buildLearnedRock(object: RockObject): THREE.Group {
  const group = new THREE.Group();
  const shape = object.meta.learnedShape!;
  const geometry = new THREE.IcosahedronGeometry(0.9, 1);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  // Equal vertex coordinates receive equal displacement, even when unindexed.
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    const noise = Math.sin(x * 13.31 + y * 17.71 + z * 29.91 + (shape.seed % 10000)) * 0.14;
    const factor = 1 + noise * shape.detail;
    positions.setXYZ(i, x * factor, y * factor, z * factor);
  }
  geometry.computeVertexNormals();
  const mat = material(object.color, { roughness: 0.96, flatShading: true, map: getSurfaceTexture('stone') });
  addMesh(group, geometry, mat, [0, 1.05, 0]);
  return group;
}

function buildLearnedHouse(object: BuildingObject): THREE.Group {
  const group = new THREE.Group();
  const shape = object.meta.learnedShape!;
  const wall = material(object.color, { roughness: 0.93, map: getSurfaceTexture('plaster') });
  const roof = material(object.roofColor, { roughness: 0.85, flatShading: true, map: getSurfaceTexture('roof') });
  const dark = material('#3a2a20', { roughness: 1 });
  const windowMat = material('#a9c9d6', { roughness: 0.4 });
  addMesh(group, new THREE.BoxGeometry(3.55, 0.3, 3.15), material('#8d8579'), [0, 0.15, 0]);
  addMesh(group, new THREE.BoxGeometry(3.4, 2.6, 3), wall, [0, 1.6, 0]);
  const roofHeight = 1.4 * shape.detail;
  const roofMesh = addMesh(group, new THREE.ConeGeometry(2.55, roofHeight, 4), roof, [0, 2.9 + roofHeight / 2, 0]);
  roofMesh.rotation.y = Math.PI / 4;
  addMesh(group, new THREE.BoxGeometry(0.72, 1.3, 0.1), dark, [0, 0.95, 1.55]);
  const windows = shape.seed % 2 ? [-1, 1] : [1];
  for (const x of windows) addMesh(group, new THREE.BoxGeometry(0.5, 0.55, 0.08), windowMat, [x, 1.9, 1.56]);
  return group;
}

function buildTree(object: TreeObject): THREE.Group {
  if (object.variant === 'broadleaf' && object.meta.learnedShape) return buildLearnedTree(object);
  const group = new THREE.Group();
  const foliage = material(object.color, { roughness: 0.94, flatShading: true, map: getSurfaceTexture('foliage') });
  const trunk = material(object.trunkColor, { roughness: 1, flatShading: true, map: getSurfaceTexture('bark') });

  if (object.variant === 'bush') return buildBush(object);

  if (object.variant === 'pine') {
    addMesh(group, new THREE.CylinderGeometry(0.16, 0.27, 1.7, 7), trunk, [0, 0.85, 0]);
    addMesh(group, new THREE.ConeGeometry(1.18, 1.8, 8), foliage, [0, 1.95, 0]);
    addMesh(group, new THREE.ConeGeometry(0.9, 1.55, 8), foliage, [0, 2.75, 0]);
    addMesh(group, new THREE.ConeGeometry(0.6, 1.3, 8), foliage, [0, 3.5, 0]);
    return group;
  }

  if (object.variant === 'broadleaf') {
    addMesh(group, new THREE.CylinderGeometry(0.18, 0.32, 2.1, 7), trunk, [0, 1.05, 0]);
    addMesh(group, new THREE.IcosahedronGeometry(1.2, 1), foliage, [0, 2.85, 0]);
    addMesh(group, new THREE.IcosahedronGeometry(0.78, 1), foliage, [0.62, 2.3, 0.24]);
    addMesh(group, new THREE.IcosahedronGeometry(0.7, 1), foliage, [-0.58, 2.45, -0.2]);
    return group;
  }

  if (object.variant === 'palm') {
    const trunkMesh = addMesh(
      group,
      new THREE.CylinderGeometry(0.14, 0.3, 3.4, 7),
      trunk,
      [0, 1.7, 0],
    );
    trunkMesh.rotation.z = 0.07;
    for (let index = 0; index < 7; index += 1) {
      const frond = new THREE.Group();
      frond.rotation.y = (index / 7) * Math.PI * 2;
      frond.rotation.x = 0.36;
      frond.position.set(0, 3.35, 0);
      addMesh(frond, new THREE.ConeGeometry(0.34, 2.1, 4), foliage, [0, 0, 1.0]).rotation.x =
        Math.PI / 2;
      group.add(frond);
    }
    addMesh(
      group,
      new THREE.SphereGeometry(0.18, 8, 6),
      material('#6b4a2d', { flatShading: true }),
      [0.2, 3.2, 0.1],
    );
    return group;
  }

  // cactus
  addMesh(group, new THREE.CylinderGeometry(0.42, 0.52, 2.4, 10), foliage, [0, 1.2, 0]);
  addMesh(group, new THREE.SphereGeometry(0.42, 10, 8), foliage, [0, 2.4, 0]);
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.5, 1.35, 0);
  addMesh(leftArm, new THREE.CylinderGeometry(0.2, 0.2, 0.72, 8), foliage, [0, 0, 0]).rotation.z =
    Math.PI / 2;
  addMesh(leftArm, new THREE.CylinderGeometry(0.2, 0.22, 0.9, 8), foliage, [-0.34, 0.42, 0]);
  group.add(leftArm);
  const rightArm = new THREE.Group();
  rightArm.position.set(0.48, 1.72, 0);
  addMesh(rightArm, new THREE.CylinderGeometry(0.18, 0.18, 0.6, 8), foliage, [0, 0, 0]).rotation.z =
    Math.PI / 2;
  addMesh(rightArm, new THREE.CylinderGeometry(0.18, 0.2, 0.7, 8), foliage, [0.28, 0.32, 0]);
  group.add(rightArm);
  return group;
}

function buildRock(object: RockObject): THREE.Group {
  if (object.variant === 'boulder' && object.meta.learnedShape) return buildLearnedRock(object);
  const group = new THREE.Group();
  const mat = material(object.color, { roughness: 0.96, flatShading: true, map: getSurfaceTexture('stone') });

  if (object.variant === 'boulder') {
    const mesh = addMesh(group, new THREE.IcosahedronGeometry(1.05, 1), mat, [0, 0.62, 0]);
    mesh.scale.set(1.18, 0.82, 1.0);
    mesh.rotation.y = 0.6;
    return group;
  }

  const main = addMesh(group, new THREE.DodecahedronGeometry(1.1, 0), mat, [0, 0.9, 0]);
  main.scale.set(0.92, 1.4, 0.86);
  const shardA = addMesh(group, new THREE.DodecahedronGeometry(0.55, 0), mat, [0.95, 0.34, 0.25]);
  shardA.rotation.set(0.4, 0.8, 0.2);
  const shardB = addMesh(group, new THREE.DodecahedronGeometry(0.48, 0), mat, [-0.75, 0.28, -0.45]);
  shardB.rotation.set(0.2, 0.3, 0.5);
  return group;
}

function buildDesertHouse(object: BuildingObject): THREE.Group {
  const group = new THREE.Group();
  const walls = material(object.color, { roughness: 0.95, map: getSurfaceTexture('plaster') });
  const dark = material('#493224', { roughness: 1 });
  addMesh(group, new THREE.BoxGeometry(3.4, 2.7, 3), walls, [0, 1.35, 0]);
  addMesh(group, new THREE.BoxGeometry(3.65, 0.24, 3.25), walls, [0, 2.8, 0]);
  addMesh(group, new THREE.BoxGeometry(0.8, 1.5, 0.1), dark, [0, 0.75, 1.55]);
  for (const x of [-1, 1]) addMesh(group, new THREE.BoxGeometry(0.46, 0.55, 0.1), dark, [x, 1.75, 1.55]);
  return group;
}

function buildBuilding(object: BuildingObject): THREE.Group {
  if (object.variant === 'house' && object.meta.desertHouse) return buildDesertHouse(object);
  if (object.variant === 'house' && object.meta.learnedShape) return buildLearnedHouse(object);
  const group = new THREE.Group();
  const wall = material(object.color, { roughness: 0.93, map: getSurfaceTexture(object.variant === 'house' ? 'plaster' : 'masonry') });
  const roof = material(object.roofColor, { roughness: 0.85, flatShading: true, map: getSurfaceTexture('roof') });
  const dark = material('#3a2a20', { roughness: 1 });
  const glow = material('#ffcf8a', {
    emissive: new THREE.Color('#ffb75e'),
    emissiveIntensity: 0.75,
    roughness: 0.4,
  });

  if (object.variant === 'house') {
    // Stone sill under the walls; the door front stays proud of it.
    addMesh(group, new THREE.BoxGeometry(3.55, 0.34, 3.15), material('#8d8579', { roughness: 1 }), [0, 0.1, 0]);
    addMesh(group, new THREE.BoxGeometry(3.4, 2.6, 3.0), wall, [0, 1.3, 0]);
    const roofMesh = addMesh(group, new THREE.ConeGeometry(2.55, 1.7, 4), roof, [0, 3.45, 0]);
    roofMesh.rotation.y = Math.PI / 4;
    addMesh(group, new THREE.BoxGeometry(0.8, 1.35, 0.12), dark, [0, 0.67, 1.52]);
    addMesh(group, new THREE.BoxGeometry(0.56, 0.56, 0.1), glow, [1.0, 1.65, 1.53]);
    addMesh(group, new THREE.BoxGeometry(0.5, 1.2, 0.5), material('#8d8579'), [1.0, 3.1, -0.65]);
    return group;
  }

  if (object.variant === 'tower') {
    addMesh(group, new THREE.CylinderGeometry(1.45, 1.7, 5.2, 10), wall, [0, 2.6, 0]);
    addMesh(group, new THREE.CylinderGeometry(1.85, 1.6, 0.4, 10), wall, [0, 5.3, 0]);
    addMesh(group, new THREE.ConeGeometry(1.95, 2.2, 10), roof, [0, 6.6, 0]);
    addMesh(group, new THREE.BoxGeometry(0.7, 1.4, 0.14), dark, [0, 0.7, 1.62]);
    addMesh(group, new THREE.BoxGeometry(0.4, 0.7, 0.12), glow, [0, 3.6, 1.48]);
    return group;
  }

  if (object.variant === 'barn') return buildBarn(object.color, object.roofColor);
  if (object.variant === 'coop') return buildCoop(object.color, object.roofColor);

  // ruin: broken walls and a fallen column
  addMesh(group, new THREE.BoxGeometry(3.6, 2.5, 0.32), wall, [0, 1.25, -1.7]);
  addMesh(group, new THREE.BoxGeometry(0.32, 2.0, 3.4), wall, [-1.7, 1.0, 0]);
  const partial = addMesh(group, new THREE.BoxGeometry(1.7, 1.15, 0.3), wall, [-0.9, 0.58, 1.7]);
  partial.rotation.z = 0.03;
  const column = addMesh(group, new THREE.CylinderGeometry(0.28, 0.34, 1.85, 8), wall, [1.25, 0.92, 1.15]);
  column.rotation.z = 0.14;
  const fallen = addMesh(group, new THREE.BoxGeometry(0.55, 0.55, 1.7), wall, [0.85, 0.28, -1.0]);
  fallen.rotation.y = 0.7;
  return group;
}

function buildLantern(object: LanternObject, withLight: boolean): THREE.Group {
  const group = new THREE.Group();
  const stand = material('#4a4038', { roughness: 0.9 });
  const glass = material(object.color, {
    emissive: new THREE.Color(object.color),
    emissiveIntensity: 1.4,
    roughness: 0.3,
  });
  addMesh(group, new THREE.CylinderGeometry(0.06, 0.09, 2.1, 6), stand, [0, 1.05, 0]);
  addMesh(group, new THREE.BoxGeometry(0.52, 0.06, 0.06), stand, [0.2, 2.06, 0]);
  const lamp = addMesh(group, new THREE.SphereGeometry(0.2, 12, 10), glass, [0.44, 1.9, 0]);
  lamp.castShadow = false;
  addMesh(group, new THREE.ConeGeometry(0.24, 0.16, 8), stand, [0.44, 2.13, 0]);

  if (withLight) {
    const light = new THREE.PointLight(new THREE.Color(object.color), 14, 14, 2);
    light.position.set(0.44, 1.9, 0);
    group.add(light);
  }
  return group;
}

export function createWorldObjectGroup(object: WorldObject, withLight: boolean): THREE.Group {
  let group: THREE.Group;
  switch (object.kind) {
    case 'primitive':
      group = buildPrimitive(object);
      break;
    case 'tree':
      group = buildTree(object);
      break;
    case 'rock':
      group = buildRock(object);
      break;
    case 'building':
      group = buildBuilding(object);
      break;
    case 'lantern':
      group = buildLantern(object, withLight);
      break;
    case 'path':
      group = buildPath(object);
      break;
    case 'river':
      group = buildRiver(object);
      break;
    case 'fence':
      group = buildFence(object);
      break;
    case 'field':
      group = buildField(object);
      break;
    case 'bridge':
      group = buildBridge(object);
      break;
  }

  // Collapse each object's static boxes into one mesh per material before the
  // node transform is applied. Instanced crops/pebbles are left intact.
  mergeStaticMeshes(group);

  applyTransform(group, object.transform);
  group.visible = object.visible;
  applyMaterialSettings(group, object.material);
  tagObject(group, object);
  return group;
}

/** Build a transform-only container node for a group. */
export function createWorldGroupObject(node: WorldGroup): THREE.Group {
  const group = new THREE.Group();
  applyTransform(group, node.transform);
  group.visible = node.visible;
  tagGroup(group, node);
  return group;
}

export function addEnvironmentLights(
  root: THREE.Object3D,
  environment: WorldEnvironment,
  size: number,
): void {
  const sky = new THREE.Color(environment.skyColor);
  const ground = new THREE.Color(environment.fogColor).multiplyScalar(0.4);
  const hemisphere = new THREE.HemisphereLight(sky, ground, environment.ambientIntensity * 1.5);
  hemisphere.name = 'hemisphere-light';
  root.add(hemisphere);

  const ambient = new THREE.AmbientLight(0xffffff, environment.ambientIntensity * 0.16);
  ambient.name = 'ambient-light';
  root.add(ambient);

  const sun = new THREE.DirectionalLight(
    new THREE.Color(environment.sunColor),
    environment.sunIntensity,
  );
  sun.name = 'sun-light';
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.06;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = size * 3.2;
  sun.shadow.camera.left = -size * 0.65;
  sun.shadow.camera.right = size * 0.65;
  sun.shadow.camera.top = size * 0.65;
  sun.shadow.camera.bottom = -size * 0.65;
  sun.shadow.camera.updateProjectionMatrix();

  const azimuth = THREE.MathUtils.degToRad(environment.sunAzimuth);
  const elevation = THREE.MathUtils.degToRad(environment.sunElevation);
  const direction = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
  sun.position.copy(direction.multiplyScalar(size * 0.9));
  sun.target.position.set(0, 0, 0);
  root.add(sun);
  root.add(sun.target);
}

/**
 * Builds the complete editable world as a Three.js graph.
 *
 * The viewport and the glTF exporter share this function, which guarantees the
 * exported file matches what the editor shows. Surface textures are generated
 * locally and shared across objects; no network assets are required.
 */
/**
 * Blender-style reference grid aligned to the terrain. It is a viewport aid and
 * is never exported.
 */
export function createGrid(plan: WorldPlan): THREE.Group {
  const size = Math.min(plan.terrain.size, 400);
  const divisions = Math.max(8, Math.min(120, Math.round(size / 4)));
  const grid = new THREE.GridHelper(size, divisions, 0x6d7787, 0x3a4048);
  const gridMaterial = grid.material as THREE.LineBasicMaterial;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.32;
  gridMaterial.depthWrite = false;
  grid.position.y = (plan.terrain.waterLevel ?? 0) + 0.04;
  grid.renderOrder = 2;
  grid.name = 'world-grid';

  const container = new THREE.Group();
  container.name = 'world-grid-container';
  container.add(grid);
  return container;
}

interface BuildContext {
  includeHidden: boolean;
  maxPointLights: number;
  pointLights: number;
  nodeObjects: Map<string, THREE.Object3D>;
  root: THREE.Group;
}

function buildNode(
  plan: WorldPlan,
  node: SceneNode,
  parent: THREE.Object3D,
  context: BuildContext,
): void {
  const effectivelyVisible = isEffectivelyVisible(plan, node.id);
  if (!context.includeHidden && !effectivelyVisible) return;

  if ('kind' in node) {
    const withLight = node.kind === 'lantern' && context.pointLights < context.maxPointLights;
    if (node.kind === 'lantern' && withLight) context.pointLights += 1;
    const object = createWorldObjectGroup(node, withLight);
    if (context.includeHidden) object.visible = effectivelyVisible;
    parent.add(object);
    context.nodeObjects.set(node.id, object);
    return;
  }

  const group = createWorldGroupObject(node);
  if (context.includeHidden) group.visible = effectivelyVisible;
  parent.add(group);
  context.nodeObjects.set(node.id, group);

  for (const child of [...plan.groups, ...plan.objects]) {
    if (child.parentId === node.id) buildNode(plan, child, group, context);
  }
}

/**
 * Builds the complete editable world as a Three.js graph.
 *
 * The viewport and the glTF exporter share this function, which guarantees the
 * exported file matches what the editor shows. Surface textures are generated
 * locally and shared across objects; no network assets are required.
 */
export function buildWorldScene(plan: WorldPlan, options: BuildSceneOptions = {}): THREE.Group {
  const {
    includeLights = true,
    maxPointLights = MAX_DEFAULT_POINT_LIGHTS,
    terrainResolutionCap = 192,
    shadowMapSize = 2048,
    includeHidden = false,
  } = options;

  const root = new THREE.Group();
  root.name = 'world-root';
  root.userData.worldId = plan.id;

  root.add(createTerrainMesh(plan, terrainResolutionCap));

  const water = createWaterMesh(plan);
  if (water) root.add(water);

  if (includeLights) {
    addEnvironmentLights(root, plan.environment, plan.terrain.size);
    const sun = root.getObjectByName('sun-light');
    if (sun instanceof THREE.DirectionalLight) {
      sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    }
  }

  const nodes = new THREE.Group();
  nodes.name = 'world-nodes';
  root.add(nodes);

  const context: BuildContext = {
    includeHidden,
    maxPointLights,
    pointLights: 0,
    nodeObjects: new Map(),
    root,
  };

  for (const node of [...plan.groups, ...plan.objects]) {
    if (node.parentId === null) buildNode(plan, node, nodes, context);
  }

  root.userData.nodeObjects = context.nodeObjects;
  return root;
}

/** Locate the Object3D that represents a plan node inside a built scene. */
export function findNodeObject(root: THREE.Object3D, id: string): THREE.Object3D | null {
  const map = root.userData.nodeObjects as Map<string, THREE.Object3D> | undefined;
  const mapped = map?.get(id);
  if (mapped) return mapped;
  let found: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (found) return;
    if (child.userData.worldObjectId === id || child.userData.worldGroupId === id) found = child;
  });
  return found;
}

/** Release per-scene geometry and materials. Procedural maps are shared and cached. */
export function disposeObject3D(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Points) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        for (const entry of child.material) materials.add(entry);
      } else {
        materials.add(child.material);
      }
    }
    if (child instanceof THREE.DirectionalLight || child instanceof THREE.PointLight) {
      (child as unknown as { dispose?: () => void }).dispose?.();
    }
  });
  for (const entry of materials) entry.dispose();
}

/** Remove and dispose every child of a group (used when rebuilding viewport parts). */
export function clearObject3DGroup(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject3D(child);
  }
}
