import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Small shared kit for the procedural scene builders: material helpers, mesh
 * creation and polyline ribbons. Keeping it separate from `sceneBuilder.ts`
 * lets the Phase 3 object builders stay readable and testable.
 */

export function material(
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

export function addMesh(
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

/**
 * Build a flat ribbon (2 vertices per polyline point) at the supplied heights.
 * Points are local to the object; widths run perpendicular to each segment in
 * the XZ plane. Used for paths and rivers so they hug the ground instead of
 * floating on the planar water sheet.
 */
export function ribbonGeometry(
  points: readonly [number, number, number][],
  width: number,
  yOffset = 0.03,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const half = Math.max(0.05, width) / 2;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const previous = points[index - 1] ?? current;
    const next = points[index + 1] ?? current;
    const dx = next[0] - previous[0];
    const dz = next[2] - previous[2];
    const length = Math.hypot(dx, dz) || 1;
    // Perpendicular in the XZ plane.
    const nx = -dz / length;
    const nz = dx / length;
    positions.push(current[0] + nx * half, current[1] + yOffset, current[2] + nz * half);
    positions.push(current[0] - nx * half, current[1] + yOffset, current[2] - nz * half);
    uvs.push(0, index / Math.max(1, points.length - 1));
    uvs.push(1, index / Math.max(1, points.length - 1));
    if (index < points.length - 1) {
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

/** Polyline length in the XZ plane. */
export function polylineLength(points: readonly [number, number, number][]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    total += Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  return total;
}

/** Interpolate along a polyline by distance, returning position + heading. */
export function samplePolyline(
  points: readonly [number, number, number][],
  distance: number,
): { position: [number, number, number]; heading: number } | null {
  if (points.length === 0) return null;
  let remaining = Math.max(0, distance);
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (length <= 1e-6) continue;
    if (remaining <= length) {
      const t = remaining / length;
      return {
        position: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
        heading: Math.atan2(b[0] - a[0], b[2] - a[2]),
      };
    }
    remaining -= length;
  }
  const last = points[points.length - 1]!;
  const before = points[points.length - 2] ?? last;
  return {
    position: [last[0], last[1], last[2]],
    heading: Math.atan2(last[0] - before[0], last[2] - before[2]),
  };
}

/**
 * Merge the static meshes of one object by material.
 *
 * A barn is authored as ~25 small boxes; merging them by material turns it into
 * ~6 draw calls without changing its silhouette, normals or shadows. Instanced
 * meshes (crop fields, pebbles) are left untouched because instancing already
 * collapses those draws. Merging happens before the object transform is applied,
 * so local matrices can be baked directly.
 */
export function mergeStaticMeshes(root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const buckets = new Map<
    string,
    {
      material: THREE.Material;
      meshes: THREE.Mesh[];
      castShadow: boolean;
      receiveShadow: boolean;
    }
  >();

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    if (child instanceof THREE.InstancedMesh) return;
    if (Array.isArray(child.material)) return;
    if (child.userData.noMerge === true) return;
    const material = child.material as THREE.Material;
    const key = `${material.uuid}|${child.castShadow ? 1 : 0}|${child.receiveShadow ? 1 : 0}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.meshes.push(child);
    else
      buckets.set(key, {
        material,
        meshes: [child],
        castShadow: child.castShadow,
        receiveShadow: child.receiveShadow,
      });
  });

  for (const bucket of buckets.values()) {
    if (bucket.meshes.length < 2) continue;
    const geometries: THREE.BufferGeometry[] = [];
    for (const mesh of bucket.meshes) {
      const geometry = mesh.geometry.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      geometries.push(geometry);
    }
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    root.add(mesh);
    for (const old of bucket.meshes) {
      old.geometry.dispose();
      old.removeFromParent();
    }
  }

  // Remove the empty groupings left behind (palm fronds, cactus arms, …).
  const empties: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child !== root && child.children.length === 0 && !(child instanceof THREE.Mesh)) {
      empties.push(child);
    }
  });
  for (const empty of empties) empty.removeFromParent();
}
