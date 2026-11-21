import * as THREE from 'three';
import type { PrimitiveObject } from '../world-plan/schema';
import { addMesh, material } from './kit';
import { getSurfaceTexture } from './textures';

/** Decorative, static low-poly props. A mine is a facade, not a terrain tunnel. */
export function buildMiningObject(object: PrimitiveObject): THREE.Group | null {
  const group = new THREE.Group();
  const stone = material(object.color, { roughness: 1, flatShading: true, map: getSurfaceTexture('stone') });
  const wood = material('#765238', { roughness: 0.95, map: getSurfaceTexture('wood') });
  const iron = material('#555451', { roughness: 0.7, metalness: 0.55 });
  const gold = material('#dbb451', { roughness: 0.55, metalness: 0.35, flatShading: true });
  const dark = material('#211b17', { roughness: 1 });
  switch (object.primitive) {
    case 'mine-entrance': {
      // Solid decorative cliff, with a dark recessed panel suggesting depth.
      addMesh(group, new THREE.BoxGeometry(3.6, 4.1, 5.5), stone, [-3.3, 2.05, -0.5]);
      addMesh(group, new THREE.BoxGeometry(3.6, 4.1, 5.5), stone, [3.3, 2.05, -0.5]);
      addMesh(group, new THREE.BoxGeometry(3.2, 1.3, 5.5), stone, [0, 3.45, -0.5]);
      addMesh(group, new THREE.BoxGeometry(3.2, 2.8, 0.3), dark, [0, 1.4, -2.3]);
      addMesh(group, new THREE.ConeGeometry(5.8, 1.8, 5), stone, [0, 4.8, -0.6]).rotation.y = 0.32;
      for (const x of [-1.65, 1.65]) addMesh(group, new THREE.BoxGeometry(0.28, 3.2, 0.34), wood, [x, 1.6, 2.3]);
      addMesh(group, new THREE.BoxGeometry(3.65, 0.34, 0.4), wood, [0, 3.2, 2.3]);
      for (const x of [-0.65, 0.65]) addMesh(group, new THREE.BoxGeometry(0.09, 0.1, 5), iron, [x, 0.08, 2]);
      for (let z = 0; z < 5; z++) addMesh(group, new THREE.BoxGeometry(1.7, 0.1, 0.2), wood, [0, 0.06, z - 0.2]);
      for (const [x, y] of [[-3.1, 2], [3.4, 2.7], [-2.8, 3.2]] as const) {
        addMesh(group, new THREE.IcosahedronGeometry(0.18, 0), gold, [x, y, 2.3]);
      }
      return group;
    }
    case 'mine-cart': {
      addMesh(group, new THREE.BoxGeometry(2.1, 0.9, 1.3), wood, [0, 1.05, 0]);
      addMesh(group, new THREE.BoxGeometry(1.8, 0.22, 1.1), dark, [0, 1.55, 0]);
      for (const x of [-0.62, 0.62]) for (const z of [-0.68, 0.68]) {
        const wheel = addMesh(group, new THREE.CylinderGeometry(0.33, 0.33, 0.18, 12), iron, [x, 0.36, z]);
        wheel.rotation.x = Math.PI / 2;
      }
      for (const [x, z] of [[-0.45, -0.15], [0.05, 0.25], [0.5, -0.2]] as const) {
        addMesh(group, new THREE.DodecahedronGeometry(0.3, 0), gold, [x, 1.67, z]);
      }
      return group;
    }
    case 'pickaxe': {
      const handle = addMesh(group, new THREE.CylinderGeometry(0.08, 0.1, 2, 7), wood, [0, 1, 0]);
      handle.rotation.z = -0.24;
      const head = addMesh(group, new THREE.BoxGeometry(1.35, 0.18, 0.18), iron, [0.24, 1.95, 0]);
      head.rotation.z = 0.1;
      return group;
    }
    case 'excavator': {
      const paint = material(object.color, { roughness: 0.8 });
      for (const z of [-1, 1]) addMesh(group, new THREE.BoxGeometry(3.1, 0.55, 0.65), dark, [0, 0.32, z]);
      addMesh(group, new THREE.BoxGeometry(2.6, 0.6, 1.7), iron, [0, 0.9, 0]);
      addMesh(group, new THREE.BoxGeometry(1.7, 1.2, 1.45), paint, [-0.3, 1.7, 0]);
      addMesh(group, new THREE.BoxGeometry(0.75, 0.75, 1.5), material('#8faeb6', { roughness: 0.4 }), [0.15, 2.55, 0]);
      const boom = addMesh(group, new THREE.BoxGeometry(2.6, 0.32, 0.38), paint, [1.5, 2.55, 0]);
      boom.rotation.z = 0.4;
      const arm = addMesh(group, new THREE.BoxGeometry(0.3, 1.35, 0.34), paint, [2.58, 2.4, 0]);
      arm.rotation.z = 0.2;
      addMesh(group, new THREE.BoxGeometry(0.8, 0.45, 0.85), iron, [2.65, 1.65, 0]);
      return group;
    }
    case 'chest': {
      addMesh(group, new THREE.BoxGeometry(1.55, 0.9, 1), wood, [0, 0.45, 0]);
      addMesh(group, new THREE.BoxGeometry(1.6, 0.35, 1.05), wood, [0, 1.07, 0]);
      for (const x of [-0.5, 0.5]) addMesh(group, new THREE.BoxGeometry(0.12, 1.28, 1.08), iron, [x, 0.64, 0]);
      addMesh(group, new THREE.BoxGeometry(0.22, 0.25, 0.1), gold, [0, 0.82, 0.56]);
      return group;
    }
    default: return null;
  }
}
