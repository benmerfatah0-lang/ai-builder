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
import { RECIPES, composeRecipe } from './compose.mjs';
import { openObj } from './objPack.mjs';

/**
 * Where each pack lives. The map draws from four of them now — two Quaternius
 * sets for crops and animals, one for the village's own props, Quaternius's
 * farm-animal OBJs, and two Kenney kits for the cartoon houses, trees and market
 * stalls — because no single pack has a good answer for all of it.
 */
const SOURCES = {
  qx: process.env.MODELS_SRC ?? '/tmp/qx/quaternius-showcase-main/public/glb',
  kenney: process.env.KENNEY_SRC ?? '/tmp/kenney/3d',
  obj: process.env.OBJ_SRC ?? '/tmp/tilak/quaternius/farm-animals/OBJ',
};
const SRC = SOURCES.qx;
const OUT = process.env.MODELS_OUT ?? 'src/game-map/models/generated.ts';
const CACHE = '/tmp/model-cache';

/**
 * The shortlist, as `<source>:<path>` entries.
 *
 *   qx:pack/Name      Quaternius glTF, the model the previous pass used
 *   kenney:kit/name   Kenney glTF; its colours live in a colormap atlas the
 *                     packer bakes into vertex colours
 *   obj:Name          Quaternius farm-animal OBJ, which ships in no other format
 *   recipe:Name       a building assembled by `tools/compose.mjs` from Kenney's
 *                     modular fantasy-town pieces
 *
 * Nothing here is decorative filler: every entry is drawn somewhere in the map.
 */
const LIST = [
  // Nature. Three Quaternius species for the forests and two Kenney trees for the
  // hedgerows, so a treeline is not one silhouette repeated.
  'qx:simple_nature_pack/Tree1', 'qx:simple_nature_pack/Tree2', 'qx:simple_nature_pack/Tree3',
  'qx:simple_nature_pack/Bush2', 'qx:simple_nature_pack/Rock2',
  // Crops: the first-detail variants. A field is a thousand plants, so this is the
  // only level where the whole farm still fits in a phone's frame budget.
  'qx:crops_pack/Wheat_4', 'qx:crops_pack/Corn_1', 'qx:crops_pack/Tomato_2',
  'qx:crops_pack/Pumpkin_1', 'qx:crops_pack/Carrot_1', 'qx:crops_pack/Lettuce_1',
  'qx:crops_pack/Flower_2', 'qx:crops_pack/Rice_2', 'qx:crops_pack/BushBerries_1',
  'qx:crops_pack/Beet_2', 'qx:crops_pack/Grass_1',
  // Animals. Quaternius's animated pack for the herd, its farm-animals pack for
  // the sheep and the pig, which the animated one does not have.
  'qx:animals_pack/Cow', 'qx:animals_pack/Bull', 'qx:animals_pack/Alpaca',
  'qx:animals_pack/Donkey', 'qx:animals_pack/Horse', 'qx:animals_pack/Husky',
  'qx:animals_pack/ShibaInu', 'qx:animals_pack/Fox', 'qx:animals_pack/Deer',
  'obj:Sheep', 'obj:Pig',
  // Village props and the buildings no cottage can stand in for.
  'qx:medieval_village_pack/Well', 'qx:medieval_village_pack/Hay',
  'qx:medieval_village_pack/MarketStand_1', 'qx:medieval_village_pack/Mill',
  'kenney:fantasy-town/windmill',
  // The cartoon houses: Kenney's modular kit, assembled into whole buildings.
  'recipe:Cottage_House', 'recipe:Cottage_Small', 'recipe:Cottage_Plaster',
  'recipe:Cottage_Long', 'recipe:Cottage_Barn', 'recipe:Cottage_Hut',
  'recipe:Cottage_Tower',
];

/** Resolves one list entry to its key, a loader and the bytes it came from. */
async function loadEntry(entry) {
  const separator = entry.indexOf(':');
  const source = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  const name = source === 'recipe' ? path : path.split('/').pop();

  if (source === 'recipe') {
    const recipe = RECIPES[path];
    if (!recipe) throw new Error(`unknown recipe ${path}`);
    return { name, pack: 'kenney/fantasy-town', flat: await composeRecipe(recipe, SOURCES.kenney + '/fantasy-town'), raw: 0, source };
  }
  if (source === 'obj') {
    const file = join(SOURCES.obj, `${path}.obj`);
    if (!existsSync(file)) return null;
    return { name, pack: 'quaternius/farm-animals', flat: openObj(file), raw: readFileSync(file).length, source };
  }

  const file = join(SOURCES[source], `${path}.glb`);
  if (!existsSync(file)) return null;
  const original = readFileSync(file);
  const { json, bin, dir } = openGlb(file);
  return {
    name,
    pack: source === 'kenney' ? `kenney/${path.split('/')[0]}` : path.split('/')[0],
    flat: await flattenScene(json, bin, dir),
    raw: original.length,
    source,
  };
}

mkdirSync(CACHE, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const models = [];
let rawTotal = 0;
let finalTotal = 0;

for (const entry of LIST) {
  const loaded = await loadEntry(entry);
  if (!loaded) {
    console.warn(`  MISSING ${entry}`);
    continue;
  }
  const packed = packScene(loaded.flat);
  writeFileSync(join(CACHE, `${loaded.name}.bin`), Buffer.from(packed.data, 'base64'));

  rawTotal += loaded.raw;
  finalTotal += packed.bytes;
  models.push({ pack: loaded.pack, name: loaded.name, b64: packed.data, ...packed });
  const freed = loaded.raw ? `(-${Math.round((1 - packed.bytes / loaded.raw) * 100)}%)` : '(composed)';
  console.log(
    `  ${entry.padEnd(38)} ${String(packed.triangles).padStart(5)} tris  ` +
      `${(packed.bytes / 1024).toFixed(0).padStart(4)} KB ${freed}`,
  );
}

const banner = `/**
 * GENERATED FILE - do not edit by hand. Run \`node tools/buildModels.mjs\`.
 *
 * Low-poly models by Quaternius and Kenney (both CC0-1.0, public domain), packed
 * as coloured triangles by \`tools/meshPack.mjs\` and embedded as base64 so the
 * single-file build keeps its zero-network-requests promise. Node transforms are
 * baked in, positions are 16-bit relative to each model's bounding box, colours
 * are baked to the vertex — from the material, or from Kenney's colormap atlas —
 * and the Kenney houses are assembled by \`tools/compose.mjs\` before packing.
 * See \`pack.ts\` for the reader, \`assets/models/LICENSE.md\` for the packs.
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
