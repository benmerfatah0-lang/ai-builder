import * as THREE from 'three';
import type { PhotoModel } from '../world-plan/schema';

/** A colored voxel-like shell. The mirrored back and depth are a guess, not recovered geometry. */
export function buildPhotoModelGeometry(model: PhotoModel, cells = model.cells): THREE.BufferGeometry {
  const unit = 4 / Math.max(model.width, model.height);
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const indexedCube = new THREE.BoxGeometry(1, 1, 1);
  const cube = indexedCube.toNonIndexed();
  indexedCube.dispose();
  const p = cube.getAttribute('position'), n = cube.getAttribute('normal');
  for (const cell of cells) {
    const depth = unit * (0.8 + cell.depth * 0.45);
    const x = (cell.x + 0.5 - model.width / 2) * unit;
    const y = (model.height - cell.y - 0.5) * unit;
    const color = new THREE.Color(cell.color);
    for (let i = 0; i < p.count; i++) {
      positions.push(x + p.getX(i) * unit, y + p.getY(i) * unit, p.getZ(i) * depth);
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      colors.push(color.r, color.g, color.b);
    }
  }
  cube.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function photoModelDimensions(model: PhotoModel): [number, number, number] {
  const unit = 4 / Math.max(model.width, model.height);
  return [model.width * unit, model.height * unit, unit * (0.8 + Math.max(...model.cells.map((cell) => cell.depth)) * 0.45)];
}
