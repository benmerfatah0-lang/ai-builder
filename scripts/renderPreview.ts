/**
 * Offline software renderer for generated worlds.
 *
 * The sandbox (and CI) has no GPU, so WebGL screenshots are impossible here.
 * This script walks the *real* scene graph produced by `buildWorldScene` —
 * actual geometry, transforms, material colours and instanced placements — and
 * paints it with a z-buffered flat shader. It is a visual QA aid for the
 * procedural generators, not part of the app bundle.
 *
 *   npx tsx scripts/renderPreview.ts [--prompt "…"] [--seed 20261020]
 *        [--out docs/farm-preview.png] [--size 1200x750]
 *        [--eye 96,66,118] [--target 0,2,4] [--fov 42]
 *
 * PNG output is written with `node:zlib` only, so no image tooling is needed.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as THREE from 'three';
import { interpretPromptLocally } from '../src/modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from '../src/core/generation/generateWorld';
import { buildWorldScene } from '../src/core/scene/sceneBuilder';

const FARM_PROMPT =
  'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths';

interface Options {
  prompt: string;
  seed: number;
  out: string;
  width: number;
  height: number;
  eye: [number, number, number];
  target: [number, number, number];
  fov: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    prompt: FARM_PROMPT,
    seed: 20261020,
    out: 'docs/farm-preview.png',
    width: 1200,
    height: 750,
    eye: [96, 66, 118],
    target: [0, 2, 4],
    fov: 42,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) continue;
    index += 1;
    switch (flag) {
      case '--prompt':
        options.prompt = value;
        break;
      case '--seed':
        options.seed = Number(value);
        break;
      case '--out':
        options.out = value;
        break;
      case '--size': {
        const [width, height] = value.split('x').map(Number);
        if (width && height) {
          options.width = width;
          options.height = height;
        }
        break;
      }
      case '--eye':
        options.eye = value.split(',').map(Number) as [number, number, number];
        break;
      case '--target':
        options.target = value.split(',').map(Number) as [number, number, number];
        break;
      case '--fov':
        options.fov = Number(value);
        break;
      default:
        break;
    }
  }
  return options;
}

/** Minimal PNG encoder (8-bit truecolour, no filtering) — avoids extra deps. */
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
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const options = parseArgs(process.argv.slice(2));
const { width: WIDTH, height: HEIGHT } = options;

const report = generateWorldPlanWithReport(
  interpretPromptLocally(options.prompt, { seed: options.seed }).intent,
);
const scene = buildWorldScene(report.plan, {
  includeLights: true,
  terrainResolutionCap: 128,
});

const camera = new THREE.PerspectiveCamera(options.fov, WIDTH / HEIGHT, 0.5, 900);
camera.position.set(...options.eye);
camera.lookAt(...options.target);
camera.updateMatrixWorld(true);

const colour = new Float32Array(WIDTH * HEIGHT * 3);
const depth = new Float32Array(WIDTH * HEIGHT).fill(Infinity);

// Sun direction and exposure come from the plan's environment, so a sunset or
// a night scene renders with the light the editor would actually use.
const azimuth = THREE.MathUtils.degToRad(report.plan.environment.sunAzimuth);
const elevation = THREE.MathUtils.degToRad(report.plan.environment.sunElevation);
const sunDirection = new THREE.Vector3(
  Math.cos(elevation) * Math.sin(azimuth),
  Math.sin(elevation),
  Math.cos(elevation) * Math.cos(azimuth),
).normalize();
// Daylight is nearly white; sunrise/night keep their tint but at low weight,
// otherwise a coloured key light paints the whole meadow.
const sunColour = new THREE.Color(report.plan.environment.sunColor).lerp(
  new THREE.Color(0xffffff),
  0.55,
);
const ambience = THREE.MathUtils.clamp(
  report.plan.environment.ambientIntensity * 0.5 + 0.06,
  0.05,
  0.6,
);
const direct = THREE.MathUtils.clamp(
  report.plan.environment.sunIntensity * 0.36,
  0.02,
  0.9,
);

// Sky gradient: the plan's sky is used at the horizon, lightened overhead.
const sky = new THREE.Color(report.plan.environment.skyColor);
const skyHorizon = sky.clone().lerp(new THREE.Color(report.plan.environment.fogColor), 0.45);
for (let y = 0; y < HEIGHT; y += 1) {
  const t = Math.min(1, y / HEIGHT + 0.15);
  const zenith = Math.min(1, t * 1.15);
  const r = skyHorizon.r * (1 - zenith) + sky.r * zenith * 0.78 + 0.1 * (1 - t);
  const g = skyHorizon.g * (1 - zenith) + sky.g * zenith * 0.78 + 0.12 * (1 - t);
  const b = skyHorizon.b * (1 - zenith) + sky.b * zenith * 0.78 + 0.14 * (1 - t);
  for (let x = 0; x < WIDTH; x += 1) {
    const i = (y * WIDTH + x) * 3;
    colour[i] = r;
    colour[i + 1] = g;
    colour[i + 2] = b;
  }
}

interface Triangle {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  colour: THREE.Color;
  /** Self-illumination (lantern glass, lit windows) added after shading. */
  emissive: THREE.Color;
}

const triangles: Triangle[] = [];
const vertexColour = new THREE.Color();
const emissiveColour = new THREE.Color();

scene.updateMatrixWorld(true);
const instanceMatrix = new THREE.Matrix4();
const worldMatrix = new THREE.Matrix4();
const a = new THREE.Vector3();
const b = new THREE.Vector3();
const c = new THREE.Vector3();

scene.traverse((node) => {
  const mesh = node as THREE.Mesh;
  if (!mesh.isMesh || !mesh.geometry) return;
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position');
  if (!position) return;
  const index = geometry.getIndex();
  const palette = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const colours = geometry.getAttribute('color');
  const instanced = (mesh as unknown as THREE.InstancedMesh).isInstancedMesh
    ? (mesh as unknown as THREE.InstancedMesh)
    : null;
  const copies = instanced ? instanced.count : 1;
  const triangleCount = Math.floor((index ? index.count : position.count) / 3);

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
      const material = palette[0] as THREE.MeshStandardMaterial | undefined;
      if (colours) {
        vertexColour.setRGB(colours.getX(i0), colours.getY(i0), colours.getZ(i0));
      } else if (material?.color) {
        vertexColour.copy(material.color);
      } else {
        vertexColour.setRGB(0.8, 0.8, 0.8);
      }
      if (material?.emissive && material.emissive.getHex() !== 0) {
        emissiveColour
          .copy(material.emissive)
          .multiplyScalar(material.emissiveIntensity ?? 1);
      } else {
        emissiveColour.setRGB(0, 0, 0);
      }
      triangles.push({
        a: a.clone(),
        b: b.clone(),
        c: c.clone(),
        colour: vertexColour.clone(),
        emissive: emissiveColour.clone(),
      });
    }
  }
});

const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const normal = new THREE.Vector3();
const view = camera.matrixWorldInverse;
const projection = camera.projectionMatrix;
const fog = new THREE.Color(report.plan.environment.fogColor);

const toView = (point: THREE.Vector3) => point.clone().applyMatrix4(view);

let painted = 0;
for (const triangle of triangles) {
  const va = toView(triangle.a);
  const vb = toView(triangle.b);
  const vc = toView(triangle.c);
  // Triangles straddling the near plane would flip and cover the frame.
  const near = -0.6;
  if (va.z > near || vb.z > near || vc.z > near) continue;
  const pa = va.applyMatrix4(projection);
  const pb = vb.applyMatrix4(projection);
  const pc = vc.applyMatrix4(projection);

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
  // Two-sided wrap lighting keeps leaf cards and fences readable.
  const facing = normal.dot(sunDirection);
  const wrap = Math.max(0, (facing + 0.35) / 1.35);
  const bounce = Math.max(0, -facing) * 0.22;
  const exposure = ambience + direct * (wrap + bounce);
  const haze = Math.min(0.5, Math.max(0, (triangle.a.length() - 120) / 320));
  // Ambient and key light first, then self-illumination (lantern glass, windows)
  // which must stay bright in a night scene.
  const r = (triangle.colour.r * exposure * sunColour.r + triangle.emissive.r * 1.6) * (1 - haze) + fog.r * haze;
  const g = (triangle.colour.g * exposure * sunColour.g + triangle.emissive.g * 1.6) * (1 - haze) + fog.g * haze;
  const bl = (triangle.colour.b * exposure * sunColour.b + triangle.emissive.b * 1.6) * (1 - haze) + fog.b * haze;

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
      colour[offset] = r;
      colour[offset + 1] = g;
      colour[offset + 2] = bl;
      painted += 1;
    }
  }
}

const bytes = new Uint8Array(WIDTH * HEIGHT * 3);
for (let i = 0; i < bytes.length; i += 1) {
  bytes[i] = Math.max(0, Math.min(255, Math.round(Math.pow(colour[i]!, 1 / 2.2) * 255)));
}

mkdirSync(dirname(options.out), { recursive: true });
writeFileSync(options.out, encodePng(bytes, WIDTH, HEIGHT));

const counts = report.plan.objects.reduce<Record<string, number>>((all, object) => {
  all[object.kind] = (all[object.kind] ?? 0) + 1;
  return all;
}, {});
console.log(
  `Rendered ${report.plan.objects.length} objects (${Object.entries(counts)
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ')}) — ${triangles.length} triangles, ${painted} shaded pixels.`,
);
console.log(`Warnings: ${report.warnings.length === 0 ? 'none' : report.warnings.join(' | ')}`);
console.log(`Wrote ${options.out}`);
