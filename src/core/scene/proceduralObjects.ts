import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type {
  BridgeObject,
  FenceObject,
  FieldObject,
  PathObject,
  RiverObject,
  TreeObject,
} from '../world-plan/schema';
import { mulberry32 } from '../generation/rng';
import {
  addMesh,
  material,
  polylineLength,
  ribbonGeometry,
  samplePolyline,
} from './kit';

/**
 * Three.js geometry for the Phase 3 scene pieces. Each builder returns a group
 * whose local origin sits on the ground, so the shared transform application in
 * `sceneBuilder.ts` grounds every object consistently.
 */

type Vec3 = [number, number, number];

function boxBetween(
  parent: THREE.Object3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
  width: number,
  height: number,
  meshMaterial: THREE.Material,
): THREE.Mesh {
  const length = from.distanceTo(to);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), meshMaterial);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.lookAt(to);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

export function buildBush(object: TreeObject): THREE.Group {
  const group = new THREE.Group();
  const foliage = material(object.color, { roughness: 0.95, flatShading: true });
  const trunk = material(object.trunkColor, { roughness: 1, flatShading: true });
  addMesh(group, new THREE.CylinderGeometry(0.09, 0.15, 0.45, 6), trunk, [0, 0.22, 0]);
  const blobs: [number, number, number, number][] = [
    [0, 0.78, 0, 0.78],
    [0.42, 0.62, 0.16, 0.5],
    [-0.36, 0.68, -0.2, 0.54],
    [0.1, 0.58, -0.42, 0.44],
  ];
  for (const [x, y, z, radius] of blobs) {
    const blob = addMesh(group, new THREE.IcosahedronGeometry(radius, 1), foliage, [x, y, z]);
    blob.rotation.set(x, y, z);
  }
  return group;
}

/** Timber-framed barn: gable roof, big X-braced door, loft opening, lean-to. */
export function buildBarn(wallColor: string, roofColor: string): THREE.Group {
  const group = new THREE.Group();
  const wall = material(wallColor, { roughness: 0.92 });
  const roof = material(roofColor, { roughness: 0.9, flatShading: true });
  const trim = material('#e8e2d4', { roughness: 0.85 });
  const dark = material('#2f2119', { roughness: 1 });
  const hay = material('#d9b45b', { roughness: 1, flatShading: true });

  const width = 6.2;
  const depth = 7.4;
  const wallHeight = 3.4;

  // Stone footing: hides small terrain slopes under the sill.
  addMesh(group, new THREE.BoxGeometry(width + 0.3, 0.5, depth + 0.3), material('#8c8478', { roughness: 1 }), [
    0,
    0.05,
    0,
  ]);
  addMesh(group, new THREE.BoxGeometry(width, wallHeight, depth), wall, [0, wallHeight / 2, 0]);

  // Gable roof: two slanted slabs meeting on the ridge.
  const slope = 2.1;
  const halfSpan = width / 2 + 0.55;
  const roofLength = Math.hypot(halfSpan, slope);
  const leftRoof = addMesh(
    group,
    new THREE.BoxGeometry(roofLength, 0.18, depth + 0.8),
    roof,
    [-halfSpan / 2, wallHeight + slope / 2, 0],
  );
  leftRoof.rotation.z = Math.atan2(slope, halfSpan);
  const rightRoof = addMesh(
    group,
    new THREE.BoxGeometry(roofLength, 0.18, depth + 0.8),
    roof,
    [halfSpan / 2, wallHeight + slope / 2, 0],
  );
  rightRoof.rotation.z = -Math.atan2(slope, halfSpan);

  // Gable end triangles (thin boxes stepped to suggest the cladding).
  for (const side of [-1, 1]) {
    addMesh(group, new THREE.BoxGeometry(width, 0.2, 0.16), trim, [0, wallHeight, side * (depth / 2)]);
    addMesh(group, new THREE.BoxGeometry(width * 0.62, 0.2, 0.16), trim, [
      0,
      wallHeight + slope * 0.45,
      side * (depth / 2),
    ]);
  }

  // Big front door with cross bracing.
  const doorZ = depth / 2 + 0.03;
  addMesh(group, new THREE.BoxGeometry(2.5, 2.7, 0.14), dark, [0, 1.36, doorZ]);
  const braceA = addMesh(group, new THREE.BoxGeometry(0.16, 3.0, 0.08), trim, [0, 1.36, doorZ + 0.09]);
  braceA.rotation.z = Math.PI / 4;
  const braceB = addMesh(group, new THREE.BoxGeometry(0.16, 3.0, 0.08), trim, [0, 1.36, doorZ + 0.1]);
  braceB.rotation.z = -Math.PI / 4;

  // Loft door + pulley beam + windows.
  addMesh(group, new THREE.BoxGeometry(1.1, 1.1, 0.12), dark, [0, wallHeight + 0.85, doorZ]);
  addMesh(group, new THREE.BoxGeometry(0.16, 0.16, 1.1), dark, [0, wallHeight + 1.55, doorZ - 0.4]);
  for (const x of [-2.1, 2.1]) {
    for (const z of [-depth / 2 - 0.03, depth / 2 + 0.03]) {
      const window = addMesh(group, new THREE.BoxGeometry(0.6, 0.6, 0.08), material('#9fc0c8', {
        roughness: 0.35,
        metalness: 0.1,
      }), [x, 2.1, z]);
      window.castShadow = false;
    }
  }

  // Open lean-to on -X with hay bales underneath.
  addMesh(group, new THREE.BoxGeometry(1.7, 0.14, depth * 0.8), roof, [-width / 2 - 0.85, 2.5, 0]).rotation.z =
    0.28;
  for (const z of [-depth * 0.34, depth * 0.34]) {
    addMesh(group, new THREE.CylinderGeometry(0.09, 0.11, 2.4, 6), trim, [
      -width / 2 - 1.5,
      1.2,
      z,
    ]);
  }
  for (let index = 0; index < 3; index += 1) {
    const bale = addMesh(group, new THREE.CylinderGeometry(0.42, 0.42, 0.7, 10), hay, [
      -width / 2 - 0.7,
      0.42,
      -1.2 + index * 1.0,
    ]);
    bale.rotation.z = Math.PI / 2;
  }

  // Barn owl cupola for a stronger silhouette.
  addMesh(group, new THREE.BoxGeometry(0.7, 0.7, 0.7), trim, [0, wallHeight + slope + 0.2, 0]);
  addMesh(group, new THREE.ConeGeometry(0.65, 0.6, 4), roof, [0, wallHeight + slope + 0.85, 0]).rotation.y =
    Math.PI / 4;

  return group;
}

/** Coop with pitched roof, ramp, nesting boxes and a small fenced run. */
export function buildCoop(wallColor: string, roofColor: string): THREE.Group {
  const group = new THREE.Group();
  const wall = material(wallColor, { roughness: 0.93 });
  const roof = material(roofColor, { roughness: 0.9, flatShading: true });
  const trim = material('#efe7d6', { roughness: 0.88 });
  const dark = material('#33251c', { roughness: 1 });
  const chicken = material('#f2ede2', { roughness: 0.9, flatShading: true });
  const comb = material('#c1503d', { roughness: 0.9, flatShading: true });

  const width = 2.6;
  const depth = 2.6;
  const wallHeight = 1.55;
  addMesh(group, new THREE.BoxGeometry(width + 0.2, 0.32, depth + 0.2), material('#8c8478', { roughness: 1 }), [
    0,
    0.04,
    0,
  ]);
  addMesh(group, new THREE.BoxGeometry(width, wallHeight, depth), wall, [0, wallHeight / 2, 0]);

  // Gable roof.
  const slope = 0.9;
  const halfSpan = width / 2 + 0.3;
  const roofLength = Math.hypot(halfSpan, slope);
  const leftRoof = addMesh(
    group,
    new THREE.BoxGeometry(roofLength, 0.12, depth + 0.5),
    roof,
    [-halfSpan / 2, wallHeight + slope / 2, 0],
  );
  leftRoof.rotation.z = Math.atan2(slope, halfSpan);
  const rightRoof = addMesh(
    group,
    new THREE.BoxGeometry(roofLength, 0.12, depth + 0.5),
    roof,
    [halfSpan / 2, wallHeight + slope / 2, 0],
  );
  rightRoof.rotation.z = -Math.atan2(slope, halfSpan);

  // Door, window, nesting box.
  addMesh(group, new THREE.BoxGeometry(0.75, 0.95, 0.1), dark, [0, 0.48, depth / 2 + 0.02]);
  addMesh(group, new THREE.BoxGeometry(0.5, 0.4, 0.08), material('#bcd2d6', { roughness: 0.4 }), [
    0.85,
    1.05,
    depth / 2 + 0.02,
  ]);
  addMesh(group, new THREE.BoxGeometry(0.8, 0.55, 0.6), trim, [-width / 2 - 0.28, 0.85, 0.4]);
  addMesh(group, new THREE.BoxGeometry(0.9, 0.1, 0.7), roof, [-width / 2 - 0.3, 1.18, 0.4]);

  // Ramp into the door.
  const ramp = addMesh(group, new THREE.BoxGeometry(0.8, 0.08, 1.25), trim, [0, 0.16, depth / 2 + 0.62]);
  ramp.rotation.x = 0.12;
  for (let index = 0; index < 5; index += 1) {
    addMesh(group, new THREE.BoxGeometry(0.72, 0.04, 0.06), dark, [0, 0.14 + index * 0.03, depth / 2 + 0.2 + index * 0.22]);
  }

  // Fenced run with three chickens pecking about.
  const runWidth = 3.4;
  const runDepth = 3.2;
  const runZ = depth / 2 + 1.9;
  const post = material('#8a6a45', { roughness: 1 });
  for (const x of [-runWidth / 2, runWidth / 2]) {
    for (const z of [runZ - runDepth / 2, runZ + runDepth / 2]) {
      addMesh(group, new THREE.BoxGeometry(0.1, 0.9, 0.1), post, [x, 0.45, z]);
    }
  }
  for (const z of [runZ - runDepth / 2, runZ + runDepth / 2]) {
    addMesh(group, new THREE.BoxGeometry(runWidth, 0.06, 0.06), post, [0, 0.78, z]);
    addMesh(group, new THREE.BoxGeometry(runWidth, 0.06, 0.06), post, [0, 0.42, z]);
  }
  for (const x of [-runWidth / 2, runWidth / 2]) {
    addMesh(group, new THREE.BoxGeometry(0.06, 0.06, runDepth), post, [x, 0.78, runZ]);
    addMesh(group, new THREE.BoxGeometry(0.06, 0.06, runDepth), post, [x, 0.42, runZ]);
  }

  const spots: [number, number, number][] = [
    [-0.8, 0, 0.4],
    [0.7, 0, -0.2],
    [0.2, 0, 0.9],
  ];
  for (const [x, y, z] of spots) {
    const bird = new THREE.Group();
    bird.position.set(x, y, z);
    addMesh(bird, new THREE.SphereGeometry(0.2, 10, 8), chicken, [0, 0.24, 0]).scale.set(1, 0.9, 1.25);
    addMesh(bird, new THREE.SphereGeometry(0.11, 8, 6), chicken, [0, 0.46, 0.16]);
    addMesh(bird, new THREE.ConeGeometry(0.04, 0.1, 4), comb, [0, 0.5, 0.24]).rotation.x = Math.PI / 2;
    addMesh(bird, new THREE.ConeGeometry(0.05, 0.1, 4), comb, [0, 0.56, 0.16]);
    bird.rotation.y = (x + z) * 1.7;
    group.add(bird);
  }

  return group;
}

export function buildPath(object: PathObject): THREE.Group {
  const group = new THREE.Group();
  const mat = material(object.color, { roughness: 0.99, flatShading: true });
  const geometry = ribbonGeometrySafe(object.points, object.width, 0.04);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  group.add(mesh);

  // Scattered stones/rocks give the dirt some texture without many draw calls.
  if (object.style !== 'stone') {
    const scatter = material('#7f6a52', { roughness: 1, flatShading: true });
    const rng = mulberry32(object.points.length * 7919);
    const length = polylineLength(object.points);
    const count = Math.min(28, Math.max(4, Math.round(length / 2.2)));
    const pebbleGeometry = new THREE.IcosahedronGeometry(0.11, 0);
    const instanced = new THREE.InstancedMesh(pebbleGeometry, scatter, count);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    for (let index = 0; index < count; index += 1) {
      const sample = samplePolyline(object.points, (index / count) * length);
      const base = sample?.position ?? [0, 0, 0];
      const offset = (rng() - 0.5) * object.width * 0.8;
      position.set(base[0] + offset, base[1] + 0.06, base[2] + (rng() - 0.5) * object.width * 0.8);
      quaternion.setFromEuler(new THREE.Euler(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI));
      const size = 0.6 + rng() * 1.4;
      scale.set(size, size * 0.7, size);
      matrix.compose(position, quaternion, scale);
      instanced.setMatrixAt(index, matrix);
    }
    instanced.instanceMatrix.needsUpdate = true;
    instanced.receiveShadow = true;
    instanced.castShadow = false;
    instanced.name = 'path-pebbles';
    group.add(instanced);
  }

  return group;
}

export function buildRiver(object: RiverObject): THREE.Group {
  const group = new THREE.Group();
  const bank = material('#6d6152', { roughness: 0.98, flatShading: true });
  const water = material(object.color, {
    roughness: 0.18,
    metalness: 0.12,
    transparent: true,
    opacity: 0.86,
  });
  // Slightly wider dark bank beneath the water reads as a carved channel.
  const bankMesh = new THREE.Mesh(ribbonGeometrySafe(object.points, object.width + 1.1, 0.02), bank);
  bankMesh.receiveShadow = true;
  const waterMesh = new THREE.Mesh(ribbonGeometrySafe(object.points, object.width, 0.1), water);
  waterMesh.receiveShadow = true;
  waterMesh.name = 'river-water';
  group.add(bankMesh, waterMesh);
  return group;
}

export function buildFence(object: FenceObject): THREE.Group {
  const group = new THREE.Group();
  const postMaterial = material(object.postColor, { roughness: 1, flatShading: true });
  const railMaterial = material(object.railColor, { roughness: 1, flatShading: true });
  const spacing = object.style === 'stone' ? 1.6 : 2.2;
  const length = polylineLength(object.points);
  const postCount = Math.max(2, Math.round(length / spacing));
  const height = object.height;

  const posts: THREE.Vector3[] = [];
  for (let index = 0; index <= postCount; index += 1) {
    const sample = samplePolyline(object.points, (index / postCount) * length);
    if (!sample) continue;
    posts.push(new THREE.Vector3(sample.position[0], sample.position[1], sample.position[2]));
  }

  if (object.style === 'stone') {
    for (let index = 1; index < posts.length; index += 1) {
      const from = posts[index - 1]!;
      const to = posts[index]!;
      const wall = boxBetween(group, from, to, 0.45, height, postMaterial);
      wall.position.y += height * 0.35;
      addMesh(group, new THREE.BoxGeometry(0.34, height * 0.35, 0.34), postMaterial, [
        to.x,
        to.y + height * 0.35,
        to.z,
      ]);
    }
    return group;
  }

  for (const point of posts) {
    addMesh(group, new THREE.BoxGeometry(0.14, height + 0.16, 0.14), postMaterial, [
      point.x,
      point.y + (height + 0.16) / 2,
      point.z,
    ]);
  }

  for (let index = 1; index < posts.length; index += 1) {
    const from = posts[index - 1]!;
    const to = posts[index]!;
    for (const ratio of object.style === 'rail' ? [0.35] : [0.32, 0.72]) {
      const rail = boxBetween(group, from, to, 0.09, 0.1, railMaterial);
      rail.position.y += height * ratio;
    }
  }

  return group;
}

export function buildField(object: FieldObject): THREE.Group {
  const group = new THREE.Group();
  const soil = material(object.soilColor, { roughness: 1, flatShading: true });
  const crop = material(object.cropColor, { roughness: 0.95, flatShading: true });
  const rng = mulberry32(object.seed >>> 0);

  // A thicker bed keeps the field planted on gently rolling terrain.
  addMesh(group, new THREE.BoxGeometry(object.width, 0.6, object.depth), soil, [0, 0.18, 0]);

  const rowGap = object.depth / object.rows;
  const spacing = 0.5;
  const perRow = Math.max(2, Math.floor((object.width - 0.6) / spacing));
  const maxInstances = 1400;
  const planned = Math.max(1, object.rows * perRow);
  const count = Math.min(maxInstances, Math.round(planned * object.density));
  const stride = planned / count;

  // A single stalk: stem plus a bent head, merged so it can be instanced.
  const stem = new THREE.CylinderGeometry(0.022, 0.03, 0.72, 4);
  stem.translate(0, 0.36, 0);
  const head = new THREE.ConeGeometry(0.09, 0.3, 5);
  head.translate(0, 0.85, 0);
  const merged = mergeGeometries([stem, head], false);
  if (merged) {
    stem.dispose();
    head.dispose();
  }

  const instanced = new THREE.InstancedMesh(merged ?? stem, crop, count);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  let placed = 0;
  for (let index = 0; index < planned && placed < count; index += stride) {
    const row = Math.floor(index / perRow) % object.rows;
    const column = index % perRow;
    const x = -object.width / 2 + 0.4 + column * spacing + (rng() - 0.5) * 0.12;
    const z = -object.depth / 2 + rowGap * 0.5 + row * rowGap + (rng() - 0.5) * 0.14;
    position.set(x, 0.42, z);
    quaternion.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.1, rng() * Math.PI, (rng() - 0.5) * 0.12));
    const size = 0.85 + rng() * 0.35;
    scale.set(size, size, size);
    matrix.compose(position, quaternion, scale);
    instanced.setMatrixAt(placed, matrix);
    placed += 1;
  }
  instanced.count = placed;
  instanced.instanceMatrix.needsUpdate = true;
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  instanced.name = 'field-crops';
  group.add(instanced);

  // Low border of soil ridges so the field edge is legible.
  const ridge = material('#6d5236', { roughness: 1, flatShading: true });
  for (const x of [-object.width / 2, object.width / 2]) {
    addMesh(group, new THREE.BoxGeometry(0.24, 0.55, object.depth), ridge, [x, 0.22, 0]);
  }
  for (const z of [-object.depth / 2, object.depth / 2]) {
    addMesh(group, new THREE.BoxGeometry(object.width, 0.55, 0.24), ridge, [0, 0.22, z]);
  }

  return group;
}

export function buildBridge(object: BridgeObject): THREE.Group {
  const group = new THREE.Group();
  const deck = material(object.deckColor, { roughness: 0.95, flatShading: true });
  const rail = material(object.railColor, { roughness: 0.95, flatShading: true });
  const halfLength = object.length / 2;

  // Slight camber so the deck reads as an arch.
  const planks = Math.max(6, Math.round(object.length / 0.55));
  for (let index = 0; index < planks; index += 1) {
    const z = -halfLength + (index + 0.5) * (object.length / planks);
    const lift = Math.cos((z / halfLength) * Math.PI * 0.5) * 0.22;
    addMesh(group, new THREE.BoxGeometry(object.width, 0.12, object.length / planks - 0.03), deck, [
      0,
      0.42 + lift,
      z,
    ]);
  }

  // Longitudinal beams and trestle supports.
  for (const x of [-object.width / 2 + 0.2, object.width / 2 - 0.2]) {
    addMesh(group, new THREE.BoxGeometry(0.16, 0.2, object.length), rail, [x, 0.3, 0]);
  }
  for (const z of [-halfLength * 0.62, 0, halfLength * 0.62]) {
    for (const x of [-object.width / 2 + 0.3, object.width / 2 - 0.3]) {
      const pile = addMesh(group, new THREE.CylinderGeometry(0.1, 0.13, 1.5, 6), rail, [x, -0.55, z]);
      pile.castShadow = true;
    }
  }

  // Rails and posts.
  for (const x of [-object.width / 2 + 0.08, object.width / 2 - 0.08]) {
    for (let index = 0; index <= planks; index += Math.max(2, Math.round(planks / 4))) {
      const z = -halfLength + index * (object.length / planks);
      const lift = Math.cos((z / halfLength) * Math.PI * 0.5) * 0.22;
      addMesh(group, new THREE.BoxGeometry(0.12, 0.95, 0.12), rail, [x, 0.95 + lift, z]);
    }
    const beam = addMesh(
      group,
      new THREE.BoxGeometry(0.09, 0.09, object.length),
      rail,
      [x, 1.38, 0],
    );
    beam.castShadow = true;
  }

  return group;
}

/** Ribbon with a tiny fallback when a polyline collapses to a single point. */
function ribbonGeometrySafe(points: readonly Vec3[], width: number, yOffset: number) {
  const safe = points.length >= 2 ? points : ([points[0] ?? [0, 0, 0], [0.1, 0, 0]] as Vec3[]);
  return ribbonGeometry(safe, width, yOffset);
}
