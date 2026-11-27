#!/usr/bin/env node
/**
 * Turns the chosen Quaternius models into one TypeScript module of packed
 * triangles.
 *
 * Why not `?url` assets: Vite emits those as separate files the page fetches at
 * runtime, and the deliverable has to work with no network at all. A generated
 * module is code, not an asset, so Rollup keeps it inline.
 *
 * Why not the GLB: `GLTFLoader` is ~50 KB of code and the files carry a scene
 * graph, skinning, animation, UVs and 32-bit floats for a still prop with one
 * flat colour. `tools/meshPack.mjs` bakes the transforms, quantises positions to
 * 16 bits and keeps one colour per primitive, which is everything the map draws.
 * 5.82 MB of source becomes well under a megabyte, with no loader on the page.
 *
 * Draco was measured and rejected: three's DRACOLoader needs `draco_decoder.wasm`,
 * which Vite always emits as a sidecar file, so the page would fetch it.
 *
 * Sources are CC0-1.0 (public domain) from Quaternius. See assets/models/LICENSE.md.
 *
 * Usage: node tools/buildModels.mjs [--models <dir>] [--out <file>]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openGlb, flattenScene, packScene } from './meshPack.mjs';

const SRC = process.env.MODELS_SRC ?? '/tmp/qx/quaternius-showcase-main/public/glb';
const OUT = process.env.MODELS_OUT ?? 'src/game-map/models/generated.ts';
const CACHE = '/tmp/model-cache';

/**
 * The shortlist. Each entry replaces a procedural building, crop or critter, so
 * nothing here is decorative filler. Kept tight on purpose: every kilobyte in
 * this file is a kilobyte the phone has to download.
 */
const LIST = [
  // nature
  'simple_nature_pack/Tree1', 'simple_nature_pack/Tree2', 'simple_nature_pack/Tree3',
  'simple_nature_pack/Bush1', 'simple_nature_pack/Bush3',
  'simple_nature_pack/Rock1', 'simple_nature_pack/Rock2',
  // crops: each kind uses the detail its silhouette needs. Nothing here is a
  // hero asset, but a wheat field is eight hundred copies of one file, so the
  // cheap LODs earn their keep.
  'crops_pack/Wheat_4', 'crops_pack/Corn_1', 'crops_pack/Tomato_2',
  'crops_pack/Pumpkin_1', 'crops_pack/Carrot_1', 'crops_pack/Lettuce_1',
  'crops_pack/Flower_2', 'crops_pack/Rice_2', 'crops_pack/BushBerries_1',
  'crops_pack/Beet_2', 'crops_pack/Grass_1',
  // animals
  'animals_pack/Cow', 'animals_pack/Bull', 'animals_pack/Alpaca',
  'animals_pack/Donkey', 'animals_pack/Horse', 'animals_pack/Husky',
  'animals_pack/ShibaInu', 'animals_pack/Fox', 'animals_pack/Deer',
  // buildings & props
  'medieval_village_pack/House_1', 'medieval_village_pack/House_2',
  'medieval_village_pack/House_3', 'medieval_village_pack/Stable',
  'medieval_village_pack/Mill', 'medieval_village_pack/Well',
  'medieval_village_pack/Barrel', 'medieval_village_pack/Cart',
  'medieval_village_pack/Hay', 'medieval_village_pack/Crate',
  'medieval_village_pack/Bench_1', 'medieval_village_pack/MarketStand_1',
];

mkdirSync(CACHE, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const models = [];
let rawTotal = 0;
let finalTotal = 0;

for (const entry of LIST) {
  const [pack, name] = entry.split('/');
  const src = join(SRC, pack, `${name}.glb`);
  if (!existsSync(src)) {
    console.warn(`  MISSING ${entry}`);
    continue;
  }
  const original = readFileSync(src);
  rawTotal += original.length;

  const { json, bin } = openGlb(src);
  const flat = flattenScene(json, bin);
  const packed = packScene(flat);
  writeFileSync(join(CACHE, `${name}.bin`), Buffer.from(packed.data, 'base64'));

  finalTotal += packed.bytes;
  models.push({ pack, name, b64: packed.data, ...packed });
  const pct = Math.round((1 - packed.bytes / original.length) * 100);
  console.log(
    `  ${entry.padEnd(34)} ${(original.length / 1024).toFixed(0).padStart(4)} KB -> ` +
      `${(packed.bytes / 1024).toFixed(0).padStart(3)} KB  (-${pct}%)  ` +
      `${packed.triangles} tris, ${packed.vertices} verts`,
  );
}

const banner = `/**
 * GENERATED FILE - do not edit by hand. Run \`node tools/buildModels.mjs\`.
 *
 * Low-poly models by Quaternius (CC0-1.0, public domain), packed as coloured
 * triangles by \`tools/meshPack.mjs\` and embedded as base64 so the single-file
 * build keeps its zero-network-requests promise. Node transforms are baked in,
 * positions are 16-bit relative to each model's bounding box, and each primitive
 * keeps one colour. See \`pack.ts\` for the reader.
 *
 * ${models.length} models: ${(rawTotal / 1024).toFixed(0)} KB of source GLB, ${(finalTotal / 1024).toFixed(0)} KB packed.
 */

`;

const ident = (name) => `M_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
const body = models
  .map((m) => `// ${m.pack}/${m.name} - ${(m.bytes / 1024).toFixed(1)} KB\nexport const ${ident(m.name)} =\n  '${m.b64}';`)
  .join('\n\n');

const index = `

export interface ModelEntry {
  name: string;
  pack: string;
  /** Base64 packed triangle blob; see \`pack.ts\` for the layout. */
  data: string;
  bytes: number;
  bounds: {
    /** Extent on each axis. */
    size: [number, number, number];
    min: [number, number, number];
    max: [number, number, number];
    height: number;
    footprint: number;
  };
  triangles: number;
  vertices: number;
}

export const MODELS: Record<string, ModelEntry> = {
${models
  .map(
    (m) =>
      `  '${m.name}': {\n    name: '${m.name}',\n    pack: '${m.pack}',\n    data: ${ident(m.name)},\n` +
      `    bytes: ${m.bytes},\n    bounds: ${JSON.stringify(m.bounds)},\n` +
      `    triangles: ${m.triangles},\n    vertices: ${m.vertices},\n  },`,
  )
  .join('\n')}
};

export const MODEL_NAMES = Object.keys(MODELS);
`;

writeFileSync(OUT, banner + body + index);
console.log(
  `\nwrote ${OUT}: ${models.length} models, ${(finalTotal / 1024 / 1024).toFixed(2)} MB embedded ` +
    `(from ${(rawTotal / 1024 / 1024).toFixed(2)} MB source)`,
);
console.log(`base64 module size ~${((finalTotal * 4) / 3 / 1024 / 1024).toFixed(2)} MB`);
