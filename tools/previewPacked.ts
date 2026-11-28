/**
 * Renders a contact sheet straight from packed model blobs.
 *
 * `previewModels.ts` draws the source GLBs through `GLTFLoader`, which is the
 * right way to judge a pack that has vertex colours and the wrong way to judge
 * one that has a texture atlas: this tool packs the file first, exactly as
 * `tools/buildModels.mjs` would, and rasterises the result. What you see is what
 * the map will draw — vertex colours, flat shading, no textures at runtime.
 *
 * Usage: PREVIEW_SRC=<dir> PREVIEW_MODELS=a,b,c node --import tsx tools/previewPacked.ts
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as THREE from 'three';
import { encodePng } from './png';
import { openGlb, flattenScene, packScene } from './meshPack.mjs';
import { composeRecipe, KIT_DIR, RECIPES } from './compose.mjs';
import { unpackModel } from '../src/game-map/models/pack';

const SRC = process.env.PREVIEW_SRC ?? '/tmp/kenney/3d';
const OUT = process.env.PREVIEW_OUT ?? '/tmp/packed-preview.png';
const W = 1400;
const H = 760;
const COLUMNS = Number(process.env.PREVIEW_COLUMNS ?? 7);

/** Bare names are resolved against every kit directory, in this order. */
const KITS = (process.env.PREVIEW_KITS ?? 'city-suburban,fantasy-town,nature,survival').split(',');
const WANTED = (process.env.PREVIEW_MODELS ?? '').split(',').filter(Boolean);

function resolve(name: string): string | null {
  if (name.includes('/')) {
    const path = `${SRC}/${name}.glb`;
    return existsSync(path) ? path : null;
  }
  for (const kit of KITS) {
    const path = `${SRC}/${kit}/${name}.glb`;
    if (existsSync(path)) return path;
  }
  return null;
}

const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(4, 9, 7);
scene.add(sun);

async function main() {
  const cells: { name: string; geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  // A recipe is a JSON array of kit pieces, so a house can be judged before it
  // is written into `tools/compose.mjs` as a named building.
  if (process.env.PREVIEW_RECIPE) {
    const pieces = JSON.parse(process.env.PREVIEW_RECIPE);
    const flat = await composeRecipe({ pieces }, process.env.KIT_DIR ?? KIT_DIR);
    const packed = packScene(flat);
    const loaded = unpackModel({
      name: 'recipe',
      pack: 'preview',
      data: packed.data,
      bytes: packed.bytes,
      bounds: packed.bounds as never,
      triangles: packed.triangles,
      vertices: packed.vertices,
    });
    cells.push({ name: 'recipe', geometry: loaded.geometry, material: loaded.material });
    console.log(
      `  recipe ${packed.triangles} tris  h=${packed.bounds.height.toFixed(2)} ` +
        `fp=${packed.bounds.footprint.toFixed(2)}  ${(packed.bytes / 1024).toFixed(0)} KB`,
    );
  }

  for (const name of (process.env.PREVIEW_RECIPES ?? '').split(',').filter(Boolean)) {
    const recipe = (RECIPES as Record<string, { pieces: unknown[] }>)[name];
    if (!recipe) {
      console.warn(`  MISSING recipe ${name}`);
      continue;
    }
    const flat = await composeRecipe(recipe, process.env.KIT_DIR ?? KIT_DIR);
    const packed = packScene(flat);
    cells.push({
      name,
      geometry: unpackModel({
        name,
        pack: 'preview',
        data: packed.data,
        bytes: packed.bytes,
        bounds: packed.bounds as never,
        triangles: packed.triangles,
        vertices: packed.vertices,
      }).geometry,
      material: unpackModel({
        name,
        pack: 'preview',
        data: packed.data,
        bytes: packed.bytes,
        bounds: packed.bounds as never,
        triangles: packed.triangles,
        vertices: packed.vertices,
      }).material,
    });
    console.log(
      `  ${name.padEnd(20)} ${String(packed.triangles).padStart(5)} tris  h=${packed.bounds.height.toFixed(2)} ` +
        `w=${packed.bounds.size[0].toFixed(2)} d=${packed.bounds.size[2].toFixed(2)}  ${(packed.bytes / 1024).toFixed(0)} KB`,
    );
  }

  for (const name of WANTED) {
    const path = resolve(name);
    if (!path) {
      console.warn(`  MISSING ${name}`);
      continue;
    }
    const { json, bin, dir } = openGlb(path);
    const flat = await flattenScene(json, bin, dir);
    const packed = packScene(flat);
    const loaded = unpackModel({
      name: basename(name),
      pack: 'preview',
      data: packed.data,
      bytes: packed.bytes,
      bounds: packed.bounds as never,
      triangles: packed.triangles,
      vertices: packed.vertices,
    });
    cells.push({ name: basename(name), geometry: loaded.geometry, material: loaded.material });
    console.log(
      `  ${name.padEnd(30)} ${String(packed.triangles).padStart(6)} tris  ` +
        `h=${packed.bounds.height.toFixed(2)} fp=${packed.bounds.footprint.toFixed(2)}  ` +
        `${(packed.bytes / 1024).toFixed(0)} KB`,
    );
  }
  if (!cells.length) throw new Error('nothing to preview');

  const rows = Math.ceil(cells.length / COLUMNS);
  const cellW = 2.6;
  const cellH = 2.6;
  const meshes: THREE.Mesh[] = [];
  cells.forEach((cell, index) => {
    const mesh = new THREE.Mesh(cell.geometry, cell.material);
    mesh.position.set(-((COLUMNS - 1) / 2) * cellW + (index % COLUMNS) * cellW, -Math.floor(index / COLUMNS) * cellH, 0);
    // Fit inside the cell: the tallest model in a kit must not run into its neighbour.
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const fit = 2.2 / Math.max(size.x, size.y, size.z);
    mesh.scale.setScalar(fit);
    box.setFromObject(mesh);
    mesh.position.y += -box.min.y - 1.1;
    mesh.rotation.y = -0.6;
    mesh.updateMatrixWorld(true);
    meshes.push(mesh);
    scene.add(mesh);
  });

  // Frame whatever the sheet turned out to be: a grid of one row and a grid of
  // six need the same margins, not the same camera.
  const bounds = new THREE.Box3();
  for (const mesh of meshes) bounds.expandByObject(mesh);
  const center = new THREE.Vector3();
  const extent = new THREE.Vector3();
  bounds.getCenter(center);
  bounds.getSize(extent);
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 600);
  const fitHeight = extent.y / 2 / Math.tan((20 * Math.PI) / 180);
  const fitWidth = extent.x / 2 / Math.tan((20 * Math.PI) / 180) / (W / H);
  const distance = Math.max(fitHeight, fitWidth) * 1.16;
  camera.position.set(center.x, center.y + distance * 0.08, center.z + distance);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    rgb[i * 3] = 236;
    rgb[i * 3 + 1] = 241;
    rgb[i * 3 + 2] = 230;
  }
  const depth = new Float32Array(W * H).fill(Infinity);
  const mv = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const lightDir = new THREE.Vector3(4, 9, 7).normalize();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const project = new THREE.Vector3();

  const shade = (x: number, y: number, z: number, r: number, g: number, bl: number) => {
    const k = y * W + x;
    if (z >= depth[k]!) return;
    depth[k] = z;
    rgb[k * 3] = r;
    rgb[k * 3 + 1] = g;
    rgb[k * 3 + 2] = bl;
  };

  const tint = (value: number, light: number) =>
    Math.min(255, Math.round(value ** (1 / 2.2) * 255 * light));

  for (const mesh of meshes) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colour = geometry.getAttribute('color') as THREE.BufferAttribute;
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    mesh.updateWorldMatrix(true, false);
    for (let tri = 0; tri < count; tri += 3) {
      const i0 = index ? index.getX(tri) : tri;
      const i1 = index ? index.getX(tri + 1) : tri + 1;
      const i2 = index ? index.getX(tri + 2) : tri + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, i2).applyMatrix4(mesh.matrixWorld);
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      nrm.crossVectors(e1, e2);
      if (nrm.lengthSq() < 1e-12) continue;
      nrm.normalize();
      toCam.copy(camera.position).sub(a);
      const facing = nrm.dot(toCam) > 0 ? 1 : -1;
      const light = (0.42 + 0.58 * Math.abs(nrm.dot(lightDir))) * (facing > 0 ? 1 : 0.86);
      const fr = tint(colour.getX(i0), light);
      const fg = tint(colour.getY(i0), light);
      const fb = tint(colour.getZ(i0), light);

      const p0 = { x: 0, y: 0, z: 0 };
      const p1 = { x: 0, y: 0, z: 0 };
      const p2 = { x: 0, y: 0, z: 0 };
      const pts = [a, b, c];
      const out = [p0, p1, p2];
      for (let i = 0; i < 3; i += 1) {
        project.copy(pts[i]!).applyMatrix4(mv);
        if (project.z < -1 || project.z > 1) {
          out[i]!.x = Number.NaN;
          continue;
        }
        out[i]!.x = (project.x * 0.5 + 0.5) * W;
        out[i]!.y = (1 - (project.y * 0.5 + 0.5)) * H;
        out[i]!.z = project.z;
      }
      if (Number.isNaN(p0.x) || Number.isNaN(p1.x) || Number.isNaN(p2.x)) continue;
      const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
      const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
      const den = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
      if (Math.abs(den) < 1e-9) continue;
      for (let y = minY; y <= maxY; y += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          const w0 = ((p1.y - p2.y) * (x - p2.x) + (p2.x - p1.x) * (y - p2.y)) / den;
          const w1 = ((p2.y - p0.y) * (x - p2.x) + (p0.x - p2.x) * (y - p2.y)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          shade(x, y, w0 * p0.z + w1 * p1.z + w2 * p2.z, fr, fg, fb);
        }
      }
    }
  }

  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, encodePng(rgb, W, H));
  console.log(`wrote ${OUT} (${cells.length} models, ${rows} rows)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
