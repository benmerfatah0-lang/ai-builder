/**
 * Renders a contact sheet of the chosen Quaternius models.
 *
 * The map's own renderer draws a whole diorama; this is a small standalone
 * rasteriser for judging the models *before* committing to embedding them, so a
 * pack that turns out to be at the wrong scale or the wrong style never reaches
 * the bundle.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { encodePng } from './png';

const SRC = process.env.MODELS_SRC ?? '/tmp/qx/quaternius-showcase-main/public/glb';
/** Point at /tmp/model-cache to preview the compressed bytes that actually ship. */
const FROM = process.env.PREVIEW_FROM ?? 'src';
const OUT = process.env.PREVIEW_OUT ?? '/tmp/models-preview.png';
const W = 1100;
const H = 620;

const rows: { label: string; files: string[] }[] = [
  {
    label: 'buildings',
    files: ['medieval_village_pack/House_1', 'medieval_village_pack/House_2', 'medieval_village_pack/Mill'],
  },
  {
    label: 'animals',
    files: ['animals_pack/Cow', 'animals_pack/Fox', 'animals_pack/Husky', 'animals_pack/Alpaca', 'animals_pack/Donkey'],
  },
  {
    label: 'crops',
    files: ['crops_pack/Wheat_Crop', 'crops_pack/Corn_4', 'crops_pack/Pumpkin_3', 'crops_pack/Tomato_3'],
  },
  {
    label: 'nature+props',
    files: ['simple_nature_pack/Tree2', 'simple_nature_pack/Bush2', 'medieval_village_pack/Barrel', 'medieval_village_pack/Well'],
  },
];

const loader = new GLTFLoader();
const scene = new THREE.Scene();
const ambient = new THREE.AmbientLight(0xffffff, 0.8);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(4, 9, 7);
scene.add(sun);

const slots: { row: number; column: number }[] = [];
for (let row = 0; row < rows.length; row += 1) {
  for (let column = 0; column < rows[row]!.files.length; column += 1) {
    slots.push({ row, column });
  }
}
const perRow = rows.map((row) => row.files.length);

function loadOne(path: string): Promise<THREE.Group> {
  return new Promise((resolve, reject) => {
    const file = FROM === 'cache' ? `model-cache/${path.split('/')[1]}.glb` : `${SRC}/${path}.glb`;
    const buffer = readFileSync(FROM === 'cache' ? `/tmp/${file}` : file);
    const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    loader.parse(ab as ArrayBuffer, '', (gltf) => resolve(gltf.scene), (error) => reject(error));
  });
}

const rowOffset = (row: number) => row * 2.6;
const columnOffset = (row: number, column: number) => {
  const count = perRow[row]!;
  const spacing = 6.2 / Math.max(count, 3);
  return (column - (count - 1) / 2) * spacing;
};

async function main() {
  const list: { row: number; column: number; path: string }[] = [];
  rows.forEach((row, r) => row.files.forEach((f, c) => list.push({ row: r, column: c, path: f })));

  for (const entry of list) {
    const obj = await loadOne(entry.path);
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3().subVectors(box.max, box.min);
    const target = 1.9;
    const scale = target / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(scale);
    box.setFromObject(obj);
    obj.position.set(columnOffset(entry.row, entry.column), -rowOffset(entry.row) - box.min.y, 0);
    obj.rotation.y = 0.55;
    scene.add(obj);
  }

  const camera = new THREE.PerspectiveCamera(34, W / H, 0.1, 200);
  camera.position.set(7, 2.2, 13.5);
  camera.lookAt(0, -3.6, 0);
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);

  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    rgb[i * 3] = 188;
    rgb[i * 3 + 1] = 217;
    rgb[i * 3 + 2] = 234;
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

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const index = geometry.index;
    const color = (mesh.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(0xbbbbbb);
    // glTF stores base colors in linear space; the framebuffer is sRGB.
    const srgb = new THREE.Color().copySRGBToLinear(color);
    mesh.updateWorldMatrix(true, false);
    const count = index ? index.count : position.count;
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
      const light = 0.42 + 0.58 * Math.abs(nrm.dot(lightDir));
      const tint = (value: number) => Math.min(255, Math.round(Math.pow(value, 1 / 2.2) * 255 * light * (facing > 0 ? 1 : 0.86)));
      const fr = tint(color.r);
      const fg = tint(color.g);
      const fb = tint(color.b);

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
  });

  writeFileSync(OUT, encodePng(rgb, W, H));
  console.log(`wrote ${OUT}`);
}

void slots;
void main();
