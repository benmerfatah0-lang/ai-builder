import * as THREE from 'three';
import type {
  BuildingObject,
  LanternObject,
  PrimitiveObject,
  RockObject,
  TreeObject,
  WorldEnvironment,
  WorldObject,
  WorldPlan,
} from '../../core/world-plan/schema';
import { createTerrainSampler } from '../../core/generation/terrain';

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

function material(
  color: string,
  options: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.86,
    metalness: 0,
    flatShading: false,
    ...options,
  });
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  meshMaterial: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function tagObject(group: THREE.Object3D, object: WorldObject): void {
  group.name = object.name;
  group.userData.worldObjectId = object.id;
  group.traverse((child) => {
    child.userData.worldObjectId = object.id;
  });
}

export function createTerrainMesh(plan: WorldPlan, resolutionCap = 192): THREE.Mesh {
  const segments = Math.max(
    8,
    Math.min(plan.terrain.resolution, resolutionCap),
  );
  const geometry = new THREE.PlaneGeometry(
    plan.terrain.size,
    plan.terrain.size,
    segments,
    segments,
  );
  geometry.rotateX(-Math.PI / 2);

  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    position.setY(index, sampler.heightAt(x, z));
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();

  const normal = geometry.attributes.normal as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);
  const low = new THREE.Color(plan.terrain.palette.low);
  const high = new THREE.Color(plan.terrain.palette.high);
  const scratch = new THREE.Color();

  for (let index = 0; index < position.count; index += 1) {
    const ratio = sampler.normalizedHeightAt(position.getX(index), position.getZ(index));
    scratch.copy(low).lerp(high, ratio);
    // Steep slopes read darker, which gives the low-poly terrain more depth.
    const slope = 0.82 + Math.max(0, normal.getY(index)) * 0.18;
    colors[index * 3] = scratch.r * slope;
    colors[index * 3 + 1] = scratch.g * slope;
    colors[index * 3 + 2] = scratch.b * slope;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 }),
  );
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
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

function buildTree(object: TreeObject): THREE.Group {
  const group = new THREE.Group();
  const foliage = material(object.color, { roughness: 0.94, flatShading: true });
  const trunk = material(object.trunkColor, { roughness: 1, flatShading: true });

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
  const group = new THREE.Group();
  const mat = material(object.color, { roughness: 0.96, flatShading: true });

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

function buildBuilding(object: BuildingObject): THREE.Group {
  const group = new THREE.Group();
  const wall = material(object.color, { roughness: 0.93 });
  const roof = material(object.roofColor, { roughness: 0.85, flatShading: true });
  const dark = material('#3a2a20', { roughness: 1 });
  const glow = material('#ffcf8a', {
    emissive: new THREE.Color('#ffb75e'),
    emissiveIntensity: 0.75,
    roughness: 0.4,
  });

  if (object.variant === 'house') {
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
  }

  group.position.set(...object.transform.position);
  group.rotation.y = THREE.MathUtils.degToRad(object.transform.rotationY);
  group.scale.set(...object.transform.scale);
  tagObject(group, object);
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
 * exported file matches what the editor shows. Generated content only — no
 * textures, no network assets.
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

  const terrain = createTerrainMesh(plan, terrainResolutionCap);
  root.add(terrain);

  const water = createWaterMesh(plan);
  if (water) root.add(water);

  if (includeLights) {
    addEnvironmentLights(root, plan.environment, plan.terrain.size);
    const sun = root.getObjectByName('sun-light');
    if (sun instanceof THREE.DirectionalLight) {
      sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    }
  }

  let pointLights = 0;
  for (const object of plan.objects) {
    if (!includeHidden && !object.visible) continue;
    const withLight = pointLights < maxPointLights;
    if (object.kind === 'lantern' && withLight) pointLights += 1;
    root.add(createWorldObjectGroup(object, withLight));
  }

  return root;
}

/** Release GPU resources for a scene graph (geometries, materials, textures). */
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
