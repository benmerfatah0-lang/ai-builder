import * as THREE from 'three';

/**
 * Procedural surface textures for the modeling pipeline.
 *
 * Every map here is generated from a deterministic height field: albedo, a
 * tangent-space normal map and a roughness map. Three consequences the rest of
 * the pipeline relies on:
 *
 * 1. Nothing is downloaded, so a world builds identically offline and the same
 *    model looks the same on every machine.
 * 2. A normal map gives mortar joints, wood grain, hammered iron and scales real
 *    relief under the sun instead of a flat printed decal. That is most of what
 *    separates a modeled asset from a coloured box.
 * 3. All height fields are tileable (every lattice and feature point wraps), so
 *    a wall twenty metres wide shows no seam.
 *
 * UVs coming out of `primitives.ts` are measured in metres divided by a texel
 * size, so these textures keep `repeat = (1, 1)` and let the geometry decide the
 * scale — a 2 m door and a 20 m gate then share one brick size.
 */

export type ModelTextureKind =
  | 'plaster' | 'wattle' | 'paint' | 'stucco'
  | 'stone' | 'masonry' | 'brick' | 'block' | 'marble' | 'slate'
  | 'wood' | 'plank' | 'log' | 'bark' | 'shingle' | 'thatch' | 'tile'
  | 'metal' | 'hammered' | 'riveted' | 'chain' | 'rope'
  | 'leather' | 'fabric' | 'fur' | 'scale' | 'feather' | 'bone' | 'horn'
  | 'crystal' | 'glass' | 'ceramic' | 'rubber'
  | 'sand' | 'soil' | 'grass' | 'foliage' | 'gravel';

export interface ModelTextureSet {
  kind: ModelTextureKind;
  size: number;
  /** Neutral-ish albedo in sRGB; the material colour tints it. */
  map: THREE.DataTexture;
  /** Tangent-space normals, OpenGL convention (+Y up). */
  normalMap: THREE.DataTexture;
  /** Roughness in the green channel, multiplied by the material's roughness. */
  roughnessMap: THREE.DataTexture;
  /** How strongly the normal map perturbs the surface. */
  normalScale: number;
}

const DEFAULT_SIZE = 128;
const cache = new Map<string, ModelTextureSet>();

/* ---------------------------------------------------------------- noise ---- */

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1274126177);
  n = Math.imul(n ^ (n >>> 13), 1103515245);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Value noise on a wrapping lattice, so it tiles exactly at the texture edge. */
function tileNoise(x: number, y: number, cells: number, seed: number): number {
  const gx = x * cells;
  const gy = y * cells;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const tx = smooth(gx - x0);
  const ty = smooth(gy - y0);
  const wrap = (value: number) => ((value % cells) + cells) % cells;
  const a = hash2(wrap(x0), wrap(y0), seed);
  const b = hash2(wrap(x0 + 1), wrap(y0), seed);
  const c = hash2(wrap(x0), wrap(y0 + 1), seed);
  const d = hash2(wrap(x0 + 1), wrap(y0 + 1), seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Fractal sum of tileable octaves; each octave doubles the lattice. */
function fbm(x: number, y: number, baseCells: number, octaves: number, seed: number, gain = 0.5): number {
  let total = 0;
  let amplitude = 1;
  let weight = 0;
  let cells = baseCells;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += tileNoise(x, y, cells, seed + octave * 37) * amplitude;
    weight += amplitude;
    amplitude *= gain;
    cells *= 2;
  }
  return total / Math.max(1e-6, weight);
}

interface VoronoiSample {
  /** Distance to the nearest feature point. */
  f1: number;
  /** Distance to the second nearest, for bevelled edges between cells. */
  f2: number;
  /** Stable per-cell random value, so each stone can vary independently. */
  cell: number;
}

/** Tileable Voronoi: the basis of flagstones, leather grain and crystal facets. */
function voronoi(x: number, y: number, cells: number, seed: number): VoronoiSample {
  const gx = x * cells;
  const gy = y * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let f1 = Infinity;
  let f2 = Infinity;
  let cellValue = 0;
  const wrap = (value: number) => ((value % cells) + cells) % cells;
  for (let oy = -1; oy <= 1; oy += 1) {
    for (let ox = -1; ox <= 1; ox += 1) {
      const cx = wrap(ix + ox);
      const cy = wrap(iy + oy);
      const jitterX = hash2(cx, cy, seed);
      const jitterY = hash2(cx, cy, seed + 91);
      const dx = ix + ox + jitterX - gx;
      const dy = iy + oy + jitterY - gy;
      const distance = Math.hypot(dx, dy);
      if (distance < f1) {
        f2 = f1;
        f1 = distance;
        cellValue = hash2(cx, cy, seed + 173);
      } else if (distance < f2) {
        f2 = distance;
      }
    }
  }
  return { f1, f2, cell: cellValue };
}

/** Ridged noise: folds the value range so creases become sharp lines (bark). */
function ridged(x: number, y: number, cells: number, octaves: number, seed: number): number {
  let total = 0;
  let amplitude = 1;
  let weight = 0;
  let cellCount = cells;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += (1 - Math.abs(tileNoise(x, y, cellCount, seed + octave * 53) * 2 - 1)) * amplitude;
    weight += amplitude;
    amplitude *= 0.55;
    cellCount *= 2;
  }
  return total / Math.max(1e-6, weight);
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const mix = (a: number, b: number, t: number): number => a + (b - a) * clamp01(t);
/** Wraps a coordinate into [0,1) so hand-written patterns stay seamless. */
const wrap01 = (value: number): number => value - Math.floor(value);
const saw = (value: number): number => Math.abs(wrap01(value) * 2 - 1);

/* ------------------------------------------------------- height fields ---- */

interface SurfaceSample {
  /** Relief, 0 = deepest, 1 = highest. */
  height: number;
  /** Albedo multiplier per channel; near-neutral keeps the tint in control. */
  tint: [number, number, number];
  /** Roughness multiplier, 0 = mirror, 1 = matte. */
  roughness: number;
}

/**
 * One height field per material family.
 *
 * Each returns relief plus a subtle colour bias: mortar reads greyer than the
 * stone it holds, iron picks up warm rust in its pits, bark collects green in
 * its crevices. The bias is deliberately mild because the asset's own colour
 * multiplies it, and an inspector tint must stay recognisable.
 */
function sampleSurface(kind: ModelTextureKind, x: number, y: number): SurfaceSample {
  const grain = fbm(x, y, 24, 3, 11);
  const dust = fbm(x, y, 6, 2, 29);
  switch (kind) {
    case 'plaster':
    case 'stucco': {
      const trowel = fbm(x + Math.sin(y * Math.PI * 6) * 0.02, y, 10, 3, 5);
      const height = mix(0.42, 0.62, trowel) + (grain - 0.5) * 0.08;
      return { height, tint: [1, 0.995, 0.98], roughness: mix(0.82, 0.95, dust) };
    }
    case 'paint': {
      const stipple = fbm(x, y, 40, 2, 7);
      return { height: 0.55 + (stipple - 0.5) * 0.06, tint: [1, 1, 1], roughness: mix(0.55, 0.72, stipple) };
    }
    case 'wattle': {
      // Woven hazel rods with daub packed between them: medieval wall infill.
      const rods = 6;
      const horizontal = saw(y * rods);
      const vertical = saw(x * rods + (Math.floor(y * rods) % 2) * 0.5);
      const rod = Math.max(Math.pow(1 - horizontal, 3) * (Math.floor(x * rods) % 2 === 0 ? 1 : 0.25), Math.pow(1 - vertical, 3) * (Math.floor(x * rods) % 2 === 1 ? 1 : 0.25));
      const daub = fbm(x, y, 8, 3, 41);
      const height = mix(0.3 + (daub - 0.5) * 0.16, 0.78, rod);
      return { height, tint: rod > 0.4 ? [0.95, 0.88, 0.74] : [1, 0.98, 0.93], roughness: rod > 0.4 ? 0.9 : 0.86 };
    }
    case 'stone': {
      const coarse = fbm(x, y, 5, 4, 3);
      const pits = Math.pow(voronoi(x, y, 22, 13).f1, 0.6);
      return { height: mix(0.35, 0.72, coarse) - pits * 0.18 + (grain - 0.5) * 0.1, tint: [1, 0.99, 0.97], roughness: mix(0.7, 0.95, coarse) };
    }
    case 'masonry':
    case 'brick':
    case 'block': {
      // Integer course and column counts are what keep the tile seamless: a
      // fractional count leaves a visible seam where the texture repeats.
      const rows = kind === 'brick' ? 8 : kind === 'masonry' ? 4 : 2;
      const columns = kind === 'brick' ? 4 : 2;
      const rowHeight = 1 / rows;
      const row = Math.floor(y / rowHeight);
      const offset = (row % 2) * 0.5;
      const localY = wrap01(y / rowHeight);
      const localX = wrap01(x * columns + offset);
      // Mortar is a fixed fraction of a course, so bricks read as bricks and
      // ashlar as ashlar at any viewing distance.
      const jointY = localY < 0.12 || localY > 0.94 ? 1 : 0;
      const jointX = localX < 0.06 || localX > 0.97 ? 1 : 0;
      const joint = Math.max(jointY, jointX);
      const bevel = Math.min(localY, 1 - localY) * Math.min(localX, 1 - localX);
      const column = ((Math.floor(x * columns + offset) % columns) + columns) % columns;
      const cell = hash2(row, column, kind === 'brick' ? 71 : 97);
      const face = mix(0.5, 0.78, cell) + (fbm(x, y, 12, 3, 5 + row) - 0.5) * 0.16;
      const height = joint ? 0.24 + (grain - 0.5) * 0.06 : face + Math.min(bevel * 8, 1) * 0.08;
      const warm: [number, number, number] = kind === 'brick' ? [1, 0.94, 0.9] : [1, 0.99, 0.97];
      // Every unit is a different firing, and its arris is dirtier than its
      // face. Without both, the colour map is a flat wash and the wall only
      // reads when the light happens to rake across it — the normal map cannot
      // carry a pattern the albedo denies.
      const firing = mix(0.84, 1.06, cell) + (fbm(x, y, 9, 2, 13 + column) - 0.5) * 0.07;
      const arris = joint ? 1 : mix(0.78, 1, clamp01(bevel * 9));
      const shade = firing * arris;
      const tint: [number, number, number] = joint
        ? [0.8 * shade, 0.8 * shade, 0.83 * shade]
        : [warm[0] * shade, warm[1] * shade, warm[2] * shade];
      return { height, tint, roughness: joint ? 0.95 : mix(0.72, 0.92, cell) };
    }
    case 'marble': {
      const warp = fbm(x, y, 3, 4, 17);
      const vein = Math.pow(Math.abs(Math.sin((x * 3 + warp * 3.4) * Math.PI * 2)), 12);
      const secondary = Math.pow(Math.abs(Math.sin((y * 5 - warp * 2.2) * Math.PI * 2)), 20) * 0.5;
      return {
        height: 0.66 - vein * 0.22 - secondary * 0.14,
        tint: [1, 0.995, 0.99],
        roughness: mix(0.16, 0.4, vein + secondary),
      };
    }
    case 'slate': {
      const cells = voronoi(x, y, 5, 23);
      const edge = clamp01((cells.f2 - cells.f1) * 6);
      const split = fbm(x, y, 16, 2, 31);
      return {
        height: mix(0.28, 0.72, edge) + (split - 0.5) * 0.1 + (cells.cell - 0.5) * 0.12,
        tint: [0.97, 0.98, 1],
        roughness: mix(0.5, 0.78, split),
      };
    }
    case 'wood':
    case 'plank': {
      const planks = kind === 'plank' ? 4 : 8;
      const plank = wrap01(y * planks);
      const seam = plank < 0.05 || plank > 0.97 ? 1 : 0;
      const boardSeed = Math.floor(y * planks);
      const rings = Math.sin((x * 26 + fbm(x, y, 4, 3, boardSeed * 7 + 3) * 9 + boardSeed * 4) * Math.PI);
      const grain = mix(0.5, 0.72, (rings + 1) / 2) + (fbm(x * 3, y, 40, 2, boardSeed + 5) - 0.5) * 0.1;
      const knot = Math.pow(1 - clamp01(Math.hypot(wrap01(x - 0.3) * 4, wrap01(y - 0.4) * 8)), 8);
      const height = seam ? 0.26 : grain - knot * 0.2;
      return { height, tint: seam ? [0.9, 0.86, 0.8] : [1, 0.96, 0.9], roughness: seam ? 0.92 : mix(0.6, 0.8, grain) };
    }
    case 'log': {
      const courses = 5;
      const course = wrap01(y * courses);
      const round = Math.sin(course * Math.PI);
      const gap = course < 0.08 || course > 0.94 ? 1 : 0;
      const grain = fbm(x * 2, y, 44, 3, 19);
      const height = gap ? 0.24 : mix(0.4, 0.82, round) + (grain - 0.5) * 0.12;
      return { height, tint: gap ? [0.86, 0.83, 0.78] : [1, 0.95, 0.88], roughness: gap ? 0.95 : 0.85 };
    }
    case 'bark': {
      const fissure = ridged(x * 0.6 + fbm(x, y, 3, 2, 61) * 0.4, y, 7, 4, 43);
      const plate = voronoi(x, y, 9, 53).cell;
      const height = mix(0.24, 0.82, Math.pow(fissure, 1.6)) + (plate - 0.5) * 0.1;
      // Moss settles in the wet crevices, not on the exposed plates.
      const moss = clamp01((0.5 - fissure) * 2.4) * clamp01(plate * 1.2);
      const tint: [number, number, number] = [1 - moss * 0.06, 1, 0.94 - moss * 0.1];
      return { height, tint, roughness: mix(0.86, 0.98, 1 - fissure) };
    }
    case 'shingle':
    case 'thatch': {
      const rows = kind === 'shingle' ? 7 : 12;
      const row = Math.floor(y * rows);
      const course = wrap01(y * rows);
      const overlap = course > 0.86 ? 1 : 0;
      const stagger = (row % 2) * 0.5;
      const unit = wrap01(x * (kind === 'shingle' ? 5 : 26) + stagger);
      const edge = kind === 'shingle' && (unit < 0.04 || unit > 0.97) ? 1 : 0;
      const strand = Math.sin((unit * 90 + row * 3) * Math.PI) * 0.5 + 0.5;
      const height = kind === 'thatch'
        ? mix(0.34, 0.78, strand) + (fbm(x, y, 30, 2, row + 7) - 0.5) * 0.16 - overlap * 0.22
        : mix(0.4, 0.74, hash2(row, Math.floor(unit * 5) % 5, 3)) - overlap * 0.24 - edge * 0.2;
      return { height, tint: kind === 'thatch' ? [1, 0.95, 0.82] : [1, 0.96, 0.92], roughness: kind === 'thatch' ? 0.97 : 0.82 };
    }
    case 'tile': {
      const rows = 6;
      const columns = 6;
      const row = Math.floor(y * rows);
      const course = wrap01(y * rows);
      const unit = wrap01(x * columns + (row % 2) * 0.5);
      const barrel = Math.sin(unit * Math.PI);
      const lip = course > 0.82 ? 1 : 0;
      const height = mix(0.3, 0.8, barrel) - lip * 0.26 + (fbm(x, y, 14, 2, row) - 0.5) * 0.08;
      return { height, tint: [1, 0.97, 0.95], roughness: mix(0.5, 0.75, barrel) };
    }
    case 'metal': {
      const brushed = fbm(x * 0.4, y, 60, 2, 23);
      const scratch = Math.pow(1 - Math.abs(tileNoise(x, y * 6, 40, 71) * 2 - 1), 14);
      return { height: 0.6 + (brushed - 0.5) * 0.1 + scratch * 0.18, tint: [1, 1, 1], roughness: mix(0.24, 0.5, brushed) - scratch * 0.12 };
    }
    case 'hammered': {
      const cells = 7;
      const cell = voronoi(x, y, cells, 101);
      const dimple = Math.pow(clamp01(cell.f1 * cells * 0.62), 0.7);
      return { height: mix(0.76, 0.4, dimple) + (grain - 0.5) * 0.05, tint: [1, 1, 1], roughness: mix(0.3, 0.52, dimple) };
    }
    case 'riveted': {
      const plates = 2;
      const seamX = wrap01(x * plates) < 0.03 || wrap01(x * plates) > 0.97 ? 1 : 0;
      const seamY = wrap01(y * plates) < 0.03 || wrap01(y * plates) > 0.97 ? 1 : 0;
      const seam = Math.max(seamX, seamY);
      const rivetX = wrap01(x * 8 + 0.0625);
      const rivetY = wrap01(y * 8 + 0.0625);
      const dome = clamp01(1 - Math.hypot(rivetX - 0.5, rivetY - 0.5) * 5);
      const brushed = fbm(x * 0.5, y, 40, 2, 23);
      const height = mix(0.58, 0.42, seam) + Math.pow(dome, 2) * 0.3 + (brushed - 0.5) * 0.06;
      const rust = clamp01((0.5 - brushed) * 2) * 0.5 + seam * 0.3;
      return { height, tint: [1, 1 - rust * 0.16, 1 - rust * 0.3], roughness: mix(0.42, 0.78, rust) };
    }
    case 'chain': {
      const links = 4;
      const lx = wrap01(x * links);
      const ly = wrap01(y * links * 0.5 + (Math.floor(x * links) % 2) * 0.5);
      const ring = Math.abs(Math.hypot(lx - 0.5, (ly - 0.5) * 1.8) - 0.3);
      const wire = clamp01(1 - ring * 9);
      return { height: mix(0.2, 0.85, wire), tint: [1, 1, 1], roughness: mix(0.55, 0.3, wire) };
    }
    case 'rope': {
      const strands = 3;
      const twist = Math.sin((y * 9 + Math.floor(x * strands) / strands) * Math.PI * 2);
      const strand = wrap01(x * strands);
      const round = Math.sin(strand * Math.PI);
      const height = mix(0.3, 0.85, round * (0.7 + twist * 0.3));
      return { height, tint: [1, 0.98, 0.93], roughness: 0.9 };
    }
    case 'leather': {
      const cells = voronoi(x, y, 11, 131);
      const crease = clamp01((cells.f2 - cells.f1) * 7);
      const pore = fbm(x, y, 46, 2, 137);
      return { height: mix(0.34, 0.72, crease) + (pore - 0.5) * 0.12, tint: [1, 0.97, 0.94], roughness: mix(0.55, 0.8, pore) };
    }
    case 'fabric': {
      const threads = 22;
      const warp = Math.sin(x * threads * Math.PI * 2) * 0.5 + 0.5;
      const weft = Math.sin(y * threads * Math.PI * 2) * 0.5 + 0.5;
      const over = (Math.floor(x * threads) + Math.floor(y * threads)) % 2 === 0;
      const weave = over ? warp : weft;
      const fuzz = fbm(x, y, 34, 2, 149);
      return { height: mix(0.38, 0.7, weave) + (fuzz - 0.5) * 0.14, tint: [1, 1, 1], roughness: mix(0.86, 0.98, fuzz) };
    }
    case 'fur': {
      const strokes = fbm(x * 1.4 + Math.sin(y * 22) * 0.05, y * 0.7, 18, 4, 151);
      const clump = voronoi(x, y, 14, 157).cell;
      const hair = Math.pow(strokes, 1.4);
      return { height: mix(0.3, 0.86, hair) + (clump - 0.5) * 0.12, tint: [1, 0.99, 0.97], roughness: 0.95 };
    }
    case 'scale': {
      const rows = 9;
      const columns = 9;
      const row = Math.floor(y * rows);
      const unit = wrap01(x * columns + (row % 2) * 0.5);
      const cy = wrap01(y * rows);
      const dome = clamp01(1 - Math.hypot((unit - 0.5) * 1.1, (cy - 0.62) * 1.5) * 2.1);
      const rim = cy < 0.1 ? 0.35 : 1;
      const cell = hash2(row, Math.floor(unit * columns), 163);
      return { height: mix(0.28, 0.84, Math.pow(dome, 0.8) * rim) + (cell - 0.5) * 0.08, tint: [1, 1, 0.99], roughness: mix(0.35, 0.7, cell) };
    }
    case 'feather': {
      const barbs = Math.sin((x * 60 + Math.abs(y - 0.5) * 26) * Math.PI);
      const shaft = clamp01(1 - Math.abs(x - 0.5) * 26);
      const height = mix(0.4, 0.7, (barbs + 1) / 2) + shaft * 0.28 + (fbm(x, y, 30, 2, 167) - 0.5) * 0.08;
      return { height, tint: [1, 1, 1], roughness: mix(0.62, 0.85, shaft) };
    }
    case 'bone': {
      const pores = voronoi(x, y, 26, 173).f1;
      const streak = fbm(x * 0.5, y, 22, 3, 179);
      return { height: 0.68 - Math.pow(1 - clamp01(pores * 8), 6) * 0.2 + (streak - 0.5) * 0.08, tint: [1, 0.995, 0.97], roughness: mix(0.5, 0.72, streak) };
    }
    case 'horn': {
      const rings = Math.pow(Math.abs(Math.sin(y * 16 * Math.PI + fbm(x, y, 4, 2, 181) * 3)), 0.6);
      const fibre = fbm(x * 0.6, y, 40, 2, 191);
      return { height: mix(0.44, 0.72, rings) + (fibre - 0.5) * 0.1, tint: [1, 0.98, 0.94], roughness: mix(0.42, 0.66, fibre) };
    }
    case 'crystal': {
      const cells = voronoi(x, y, 4, 193);
      const facet = cells.cell;
      const edge = clamp01((cells.f2 - cells.f1) * 9);
      const inner = fbm(x, y, 6, 2, 197);
      return {
        height: mix(0.3, 0.86, facet * 0.7 + edge * 0.3) + (inner - 0.5) * 0.1,
        tint: [0.98, 1, 1.02],
        roughness: mix(0.05, 0.28, edge),
      };
    }
    case 'glass': {
      const streak = fbm(x * 0.7, y, 8, 2, 199);
      const bubble = Math.pow(clamp01(1 - voronoi(x, y, 12, 211).f1 * 24), 6);
      return { height: 0.72 + (streak - 0.5) * 0.03 + bubble * 0.1, tint: [0.99, 1, 1], roughness: mix(0.03, 0.14, streak) };
    }
    case 'ceramic': {
      const crackle = Math.pow(1 - clamp01(voronoi(x, y, 13, 223).f2 * 8), 8);
      return { height: 0.74 - crackle * 0.2 + (grain - 0.5) * 0.03, tint: [1, 1, 1], roughness: mix(0.18, 0.34, crackle) };
    }
    case 'rubber': {
      const dimple = voronoi(x, y, 16, 227).f1;
      return { height: 0.6 - clamp01(1 - dimple * 12) * 0.22 + (grain - 0.5) * 0.06, tint: [1, 1, 1], roughness: mix(0.78, 0.95, dimple) };
    }
    case 'sand': {
      const ripple = Math.sin((y * 14 + Math.sin(x * 6) * 1.6) * Math.PI) * 0.5 + 0.5;
      return { height: mix(0.42, 0.72, ripple) + (grain - 0.5) * 0.16, tint: [1, 0.99, 0.96], roughness: 0.92 };
    }
    case 'soil': {
      const clod = voronoi(x, y, 10, 229);
      const grit = fbm(x, y, 30, 3, 233);
      return { height: mix(0.34, 0.74, clamp01(clod.f1 * 6)) + (grit - 0.5) * 0.2, tint: [1, 0.97, 0.93], roughness: 0.96 };
    }
    case 'gravel': {
      const stones = voronoi(x, y, 12, 239);
      const round = clamp01(stones.f1 * 7);
      return { height: mix(0.28, 0.8, round) + (stones.cell - 0.5) * 0.2, tint: [1, 0.99, 0.98], roughness: mix(0.7, 0.95, stones.cell) };
    }
    case 'grass': {
      const blade = Math.pow(Math.abs(Math.sin((x * 46 + fbm(x, y, 6, 2, 241) * 5) * Math.PI)), 0.5);
      const clump = fbm(x, y, 9, 3, 251);
      return { height: mix(0.3, 0.8, blade * 0.7 + clump * 0.3), tint: [0.98, 1, 0.94], roughness: 0.9 };
    }
    case 'foliage': {
      const cells = voronoi(x, y, 7, 257);
      const vein = Math.pow(1 - clamp01(cells.f2 * 7), 3);
      const body = fbm(x, y, 12, 3, 263);
      return { height: mix(0.36, 0.78, body) + vein * 0.14, tint: [0.97, 1, 0.95], roughness: mix(0.6, 0.86, body) };
    }
  }
}

/** Relief strength per material, in tangent-space units. */
function normalStrength(kind: ModelTextureKind): number {
  switch (kind) {
    case 'masonry': case 'brick': case 'block': case 'thatch': case 'shingle': case 'tile': case 'log':
    case 'bark': case 'hammered': case 'riveted': case 'rope': case 'chain': case 'scale': case 'wattle':
    case 'gravel': case 'fur': case 'feather':
      return 1.4;
    case 'wood': case 'plank': case 'stone': case 'slate': case 'leather': case 'fabric': case 'soil':
    case 'grass': case 'foliage': case 'sand': case 'bone': case 'horn': case 'crystal': case 'rubber':
      return 0.9;
    case 'plaster': case 'stucco': case 'paint': case 'marble': case 'ceramic':
      return 0.45;
    case 'metal': case 'glass':
      return 0.25;
  }
}

function writeTexture(pixels: Uint8Array, size: number, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Geometry carries the tiling in its UVs, so the map itself never repeats.
  texture.repeat.set(1, 1);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Builds (and caches) the albedo, normal and roughness maps for a surface.
 *
 * The cache is shared and never disposed by consumers, for the same reason the
 * scene textures are: two models using the same stone must not fight over one
 * GPU resource.
 */
export function getModelTexture(kind: ModelTextureKind, size: number = DEFAULT_SIZE): ModelTextureSet {
  const key = `${kind}@${size}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const heights = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const normals = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sample = sampleSurface(kind, x / size, y / size);
      const index = y * size + x;
      heights[index] = sample.height;
      const offset = index * 4;
      albedo[offset] = Math.round(clamp01(sample.tint[0]) * 255);
      albedo[offset + 1] = Math.round(clamp01(sample.tint[1]) * 255);
      albedo[offset + 2] = Math.round(clamp01(sample.tint[2]) * 255);
      albedo[offset + 3] = 255;
      const rough = clamp01(sample.roughness);
      roughness[offset] = 255;
      roughness[offset + 1] = Math.round(rough * 255);
      roughness[offset + 2] = 255;
      roughness[offset + 3] = 255;
    }
  }

  // Central differences on the height field, wrapped so the tangent space stays
  // continuous across the tile boundary.
  const strength = normalStrength(kind) * (size / DEFAULT_SIZE);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const left = heights[y * size + ((x - 1 + size) % size)]!;
      const right = heights[y * size + ((x + 1) % size)]!;
      const down = heights[((y - 1 + size) % size) * size + x]!;
      const up = heights[((y + 1) % size) * size + x]!;
      let nx = (left - right) * strength;
      let ny = (down - up) * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      nz /= length;
      const offset = (y * size + x) * 4;
      normals[offset] = Math.round((nx * 0.5 + 0.5) * 255);
      normals[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normals[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normals[offset + 3] = 255;
    }
  }

  const set: ModelTextureSet = {
    kind,
    size,
    map: writeTexture(albedo, size, THREE.SRGBColorSpace),
    normalMap: writeTexture(normals, size, THREE.NoColorSpace),
    roughnessMap: writeTexture(roughness, size, THREE.NoColorSpace),
    normalScale: normalStrength(kind),
  };
  set.map.name = `model-${kind}-albedo`;
  set.normalMap.name = `model-${kind}-normal`;
  set.roughnessMap.name = `model-${kind}-roughness`;
  cache.set(key, set);
  return set;
}

/** Test/dev hook: every texture currently resident in the cache. */
export function cachedModelTextures(): ModelTextureKind[] {
  return [...cache.keys()].map((key) => key.split('@')[0] as ModelTextureKind);
}
