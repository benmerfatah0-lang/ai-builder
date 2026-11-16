/**
 * Offline software renderer for the game map diorama.
 *
 * The sandbox has no GPU and no browser, so this script walks the *real* scene
 * graph returned by `buildMapScene` and paints it with a z-buffered flat
 * shader. It doubles as visual QA for the map and as the source of the preview
 * images committed to `docs/`.
 *
 *   npx tsx scripts/renderGameMap.ts --view overview
 *   npx tsx scripts/renderGameMap.ts --eye 120,150,190 --target 0,0,0 --out docs/map.png
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as THREE from 'three';
import {
  ARENAS,
  BOSSES,
  BRIDGES,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FENCES,
  FIELDS,
  REGIONS,
  ROADS,
  TREES,
  WATER,
} from '../src/game-map/data';
import { buildMapScene } from '../src/game-map/scene';
import { buildOverlays } from '../src/game-map/overlays';

interface Options {
  out: string;
  width: number;
  height: number;
  eye: [number, number, number];
  target: [number, number, number];
  fov: number;
  view: string;
  overlays: boolean;
  beaconRegion: string | null;
}

const VIEWS: Record<string, { eye: [number, number, number]; target: [number, number, number]; fov?: number }> = {
  overview: { eye: [196, 300, 340], target: [-8, 0, 4], fov: 31 },
  top: { eye: [0, 430, 16], target: [0, 0, 4], fov: 29 },
  start: { eye: [24, 30, 178], target: [0, 2, 118], fov: 52 },
  farm: { eye: [44, 42, 118], target: [14, 2, 34], fov: 48 },
  crops: { eye: [-10, 42, 92], target: [-62, 2, 50], fov: 48 },
  pens: { eye: [24, 54, -22], target: [-6, 2, -96], fov: 50 },
  finale: { eye: [-14, 30, -84], target: [-46, 2, -134], fov: 50 },
  south: { eye: [-92, 62, -178], target: [-20, 0, -80], fov: 46 },
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    ...VIEWS.overview!,
    out: 'docs/game-map/overview.png',
    width: 1400,
    height: 900,
    view: 'overview',
    fov: 38,
    eye: [0, 0, 0],
    target: [0, 0, 0],
    overlays: true,
    beaconRegion: null,
  };
  let view = 'overview';
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) continue;
    index += 1;
    if (flag === '--view') view = value;
    else if (flag === '--out') options.out = value;
    else if (flag === '--size') {
      const [width, height] = value.split('x').map(Number);
      if (width && height) {
        options.width = width;
        options.height = height;
      }
    } else if (flag === '--eye') options.eye = value.split(',').map(Number) as [number, number, number];
    else if (flag === '--target') options.target = value.split(',').map(Number) as [number, number, number];
    else if (flag === '--fov') options.fov = Number(value);
    else if (flag === '--overlays') options.overlays = value !== 'off';
    else if (flag === '--beacon') options.beaconRegion = value;
  }
  const preset = VIEWS[view] ?? VIEWS.overview!;
  options.view = view;
  if (!argv.includes('--eye')) options.eye = preset.eye;
  if (!argv.includes('--target')) options.target = preset.target;
  if (!argv.includes('--fov') && preset.fov) options.fov = preset.fov;
  if (!argv.includes('--out')) options.out = `docs/game-map/${view}.png`;
  return options;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 8 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const options = parseArgs(process.argv.slice(2));
const WIDTH = options.width;
const HEIGHT = options.height;

const map = buildMapScene({
  water: WATER,
  roads: ROADS,
  fields: FIELDS,
  fences: FENCES,
  circleFences: CIRCLE_FENCES,
  trees: TREES,
  buildings: BUILDINGS,
  arenas: ARENAS,
  bosses: BOSSES,
  regions: REGIONS,
  bridges: BRIDGES,
  checkpoints: CHECKPOINTS,
});
const scene = new THREE.Group();
scene.add(map.root);
if (options.overlays) {
  const beaconRegion = options.beaconRegion
    ? REGIONS.find((region) => region.id === options.beaconRegion)
    : undefined;
  const overlay = buildOverlays({
    heightAt: map.heightAt,
    regions: REGIONS,
    arenas: ARENAS,
    bosses: BOSSES,
    showRoute: true,
    showArenas: true,
    showRegions: true,
    beacon: beaconRegion ? { center: beaconRegion.center, color: '#fff1c4' } : null,
  });
  overlay.animate(1.2);
  scene.add(overlay.group);
}
scene.updateMatrixWorld(true);

const camera = new THREE.PerspectiveCamera(options.fov, WIDTH / HEIGHT, 0.4, 2000);
camera.position.set(...options.eye);
camera.lookAt(...options.target);
camera.updateMatrixWorld(true);

interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  colour: THREE.Color;
  emissive: THREE.Color;
  opacity: number;
}

const triangles: Triangle[] = [];
const instanceMatrix = new THREE.Matrix4();
const worldMatrix = new THREE.Matrix4();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();
const scratch = new THREE.Color();

const isTransparent = (material: THREE.Material | undefined) =>
  !!material && 'opacity' in material && (material as THREE.MeshStandardMaterial).transparent === true && (material as THREE.MeshStandardMaterial).opacity < 0.95;

let skipped = 0;

scene.traverse((node) => {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh || !mesh.geometry) return;
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const index = geometry.getIndex();
  const material = (
    Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  ) as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | undefined;
  const colours = geometry.getAttribute('color');
  const instanced = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh
    ? (mesh as unknown as THREE.InstancedMesh)
    : null;
  const copies = instanced ? instanced.count : 1;
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);
  // Skip additive glows / beams: they are viewport-only and would wash out.
  if (material && (material as THREE.Material).blending === THREE.AdditiveBlending) {
    skipped += copies * triangleCount;
    return;
  }
  const opacity = isTransparent(material) ? Math.max(0.15, (material as THREE.MeshStandardMaterial).opacity) : 1;

  for (let copy = 0; copy < copies; copy += 1) {
    if (instanced) {
      instanced.getMatrixAt(copy, instanceMatrix);
      worldMatrix.multiplyMatrices(mesh.matrixWorld, instanceMatrix);
    } else {
      worldMatrix.copy(mesh.matrixWorld);
    }
    for (let t = 0; t < triangleCount; t += 1) {
      const i0 = index ? index.getX(t * 3) : t * 3;
      const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(position, i0).applyMatrix4(worldMatrix);
      b.fromBufferAttribute(position, i1).applyMatrix4(worldMatrix);
      c.fromBufferAttribute(position, i2).applyMatrix4(worldMatrix);
      if (colours) {
        scratch.setRGB(
          (colours.getX(i0) + colours.getX(i1) + colours.getX(i2)) / 3,
          (colours.getY(i0) + colours.getY(i1) + colours.getY(i2)) / 3,
          (colours.getZ(i0) + colours.getZ(i1) + colours.getZ(i2)) / 3,
        );
      } else if (material?.color) {
        scratch.copy(material.color);
      } else {
        scratch.setRGB(0.8, 0.8, 0.8);
      }
      const emissive = new THREE.Color(0, 0, 0);
      if (material && 'emissive' in material && material.emissive && material.emissive.getHex() !== 0) {
        emissive.copy(material.emissive).multiplyScalar(material.emissiveIntensity ?? 1);
      }
      triangles.push({ a: a.clone(), b: b.clone(), c: c.clone(), colour: scratch.clone(), emissive, opacity });
    }
  }
});

console.log(`Scene: ${triangles.length} triangles (${skipped} additive skipped)`);

const colour = new Float32Array(WIDTH * HEIGHT * 3);
const depth = new Float32Array(WIDTH * HEIGHT).fill(Infinity);

// Warm late-afternoon sky, matching the map's mood.
const skyTop = new THREE.Color('#9fc4e0');
const skyHorizon = new THREE.Color('#f3e6d2');
for (let y = 0; y < HEIGHT; y += 1) {
  const t = y / HEIGHT;
  const blend = Math.min(1, Math.max(0, t * 1.35));
  const r = skyTop.r * (1 - blend) + skyHorizon.r * blend;
  const g = skyTop.g * (1 - blend) + skyHorizon.g * blend;
  const bl = skyTop.b * (1 - blend) + skyHorizon.b * blend;
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 3;
    colour[i] = r;
    colour[i + 1] = g;
    colour[i + 2] = bl;
  }
}

const sunDirection = new THREE.Vector3(-0.62, 0.6, 0.5).normalize();
const sunColour = new THREE.Color('#fff0d2');
const fillDirection = new THREE.Vector3(0.4, 0.5, -0.6).normalize();
const view = camera.matrixWorldInverse;
const projection = camera.projectionMatrix;
const toView = (point: THREE.Vector3) => point.clone().applyMatrix4(view);
const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const normal = new THREE.Vector3();

let painted = 0;
for (const triangle of triangles) {
  const va = toView(triangle.a);
  const vb = toView(triangle.b);
  const vc = toView(triangle.c);
  if (va.z > -0.4 || vb.z > -0.4 || vc.z > -0.4) continue;
  const pa = va.clone().applyMatrix4(projection);
  const pb = vb.clone().applyMatrix4(projection);
  const pc = vc.clone().applyMatrix4(projection);
  if (pa.z < -1 || pb.z < -1 || pc.z < -1) continue;

  const ax = ((pa.x + 1) / 2) * WIDTH;
  const bx = ((pb.x + 1) / 2) * WIDTH;
  const cx = ((pc.x + 1) / 2) * WIDTH;
  const ay = ((1 - pa.y) / 2) * HEIGHT;
  const by = ((1 - pb.y) / 2) * HEIGHT;
  const cy = ((1 - pc.y) / 2) * HEIGHT;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(WIDTH - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(HEIGHT - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) continue;

  ab.subVectors(triangle.b, triangle.a);
  ac.subVectors(triangle.c, triangle.a);
  normal.crossVectors(ab, ac).normalize();
  const facing = normal.dot(sunDirection);
  const diffuse = Math.max(0, facing);
  const skyTerm = 0.36 + Math.max(0, normal.y) * 0.14;
  const fill = Math.max(0, normal.dot(fillDirection)) * 0.14;
  const exposure = skyTerm + 0.78 * diffuse + fill;
  const r = triangle.colour.r * exposure * sunColour.r + triangle.emissive.r * 1.4;
  const g = triangle.colour.g * exposure * sunColour.g + triangle.emissive.g * 1.4;
  const bl = triangle.colour.b * exposure * sunColour.b + triangle.emissive.b * 1.4;

  const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(area) < 1e-9) continue;
  const inverse = 1 / area;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inverse;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inverse;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * pa.z + w1 * pb.z + w2 * pc.z;
      const pixel = y * WIDTH + x;
      if (z >= depth[pixel]!) continue;
      depth[pixel] = z;
      const offset = pixel * 3;
      const opacity = triangle.opacity;
      colour[offset] = colour[offset]! * (1 - opacity) + r * opacity;
      colour[offset + 1] = colour[offset + 1]! * (1 - opacity) + g * opacity;
      colour[offset + 2] = colour[offset + 2]! * (1 - opacity) + bl * opacity;
      painted += 1;
    }
  }
}

// Gentle vignette for a diorama feel.
const bytes = new Uint8Array(WIDTH * HEIGHT * 3);
for (let y = 0; y < HEIGHT; y += 1) {
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 3;
    const nx = (x / WIDTH - 0.5) * 2;
    const ny = (y / HEIGHT - 0.5) * 2;
    const vignette = 1 - Math.min(0.28, (nx * nx + ny * ny) * 0.12);
    for (let channel = 0; channel < 3; channel += 1) {
      const value = Math.pow(Math.max(0, colour[i + channel]!), 1 / 2.2) * 255 * vignette;
      bytes[i + channel] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
}

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, encodePng(bytes, WIDTH, HEIGHT));
console.log(`Rendered ${painted} px → ${options.out} (${WIDTH}×${HEIGHT}, view=${options.view})`);
