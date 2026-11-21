import { BIOME_PROFILES } from '../generation/biomes';
import { clamp, clamp01, cellular2, fbm, lerp, smoothstep } from './noise';
import { Heightfield, Mask } from './heightfield';
import type { FeatureContext } from './features';
import type { LandscapeSpec } from '../world-plan/schema';
import type { FlowField, LakeRegion } from './hydrology';

/**
 * Biomes as a weighted field, not as painted regions.
 *
 * A world described as "a forest at the foot of the mountains, opening onto a
 * meadow by the lake" needs several biomes that meet each other naturally. So
 * every biome gets a weight at every grid node, computed from three things:
 *
 * - **Where the description put it** (centre and radius, if given).
 * - **What ground it likes** (elevation band, slope, distance to water) — this
 *   is what makes snow sit on peaks and marsh sit beside lakes without anyone
 *   having to say so.
 * - **Seeded patch noise**, which breaks the borders into interlocking fingers
 *   instead of circles.
 *
 * Weights are then normalised per node, so the surface colour at any point is a
 * blend of the biomes that are actually present there. That blend is the reason
 * transitions look natural: between two biomes there is a band where both have
 * partial weight, and the vertex colour moves smoothly across it.
 */

export interface BiomePalette {
  low: string;
  high: string;
}

export interface BiomeEntry {
  id: string;
  /** Stable key used for palettes and reports. */
  biome: string;
  palette: BiomePalette;
  weight: Mask;
  /** Mean weight over the map, for reporting. */
  coverage: number;
}

export interface BiomeMap {
  entries: BiomeEntry[];
  ids: string[];
  /** Index of the strongest biome per node, or -1 where none applies. */
  dominant: Int16Array;
  /** Blended low/high colour in world space. */
  colorAt: (x: number, z: number) => { low: [number, number, number]; high: [number, number, number] };
  /** Id of the strongest biome at a world position, or null. */
  biomeAt: (x: number, z: number) => string | null;
  /**
   * Weights of every biome at a world position, summing to 1 when any apply.
   * `index` points into `entries`, so a caller can blend its own colour objects
   * instead of the plain 0..1 triples `colorAt` returns.
   */
  weightsAt: (x: number, z: number) => Array<{ id: string; index: number; weight: number }>;
}

/** Extra palettes for names the six classic biomes do not cover. */
const EXTRA_PALETTES: Record<string, BiomePalette> = {
  snow: { low: '#c8d3dc', high: '#f2f6f8' },
  tundra: { low: '#8b9a86', high: '#c3cdb8' },
  alpine: { low: '#6d7570', high: '#dfe4e2' },
  swamp: { low: '#3c4a34', high: '#6c7a4f' },
  marsh: { low: '#4a5a3c', high: '#7f8f5c' },
  wetland: { low: '#41513a', high: '#77885a' },
  jungle: { low: '#26491f', high: '#4f7a35' },
  rainforest: { low: '#23451d', high: '#4c7633' },
  savanna: { low: '#9c8a4e', high: '#cbb673' },
  steppe: { low: '#8e8f5c', high: '#bcb97f' },
  beach: { low: '#cbb888', high: '#e8dcb4' },
  coast: { low: '#b9ab7e', high: '#ded0a4' },
  dunes: { low: '#b58f5c', high: '#e2cb96' },
  volcanic: { low: '#3a3230', high: '#7d5a4a' },
  lava: { low: '#40241c', high: '#a24a24' },
  rock: { low: '#6a6a64', high: '#9d9d95' },
  rocky: { low: '#6a6a64', high: '#9d9d95' },
  cliff: { low: '#5f625c', high: '#94988f' },
  canyon: { low: '#8a5f43', high: '#c39270' },
  badlands: { low: '#8d6047', high: '#c08f6a' },
  plateau: { low: '#7d7a5e', high: '#b0ab85' },
  highlands: { low: '#6b7355', high: '#a4a87f' },
  valley: { low: '#5b7444', high: '#93ab6b' },
  forest_edge: { low: '#4a6238', high: '#7f9757' },
  meadow: { low: '#5c7a45', high: '#9aad72' },
  desert: { low: '#b58f5c', high: '#e2cb96' },
  island: { low: '#7e9164', high: '#c7bb8d' },
  ruins: { low: '#64694a', high: '#9d9c76' },
  mountains: { low: '#5b625c', high: '#d4d8d4' },
  forest: { low: '#3f5c36', high: '#71884d' },
};

/** Ground preferences, normalised: [min, max] elevation fraction and slope cap. */
const AFFINITY: Record<string, { elevation: [number, number]; slope: number; water: number }> = {
  snow: { elevation: [0.72, 1], slope: 1.6, water: 0 },
  tundra: { elevation: [0.55, 1], slope: 1.2, water: 0 },
  alpine: { elevation: [0.5, 1], slope: 1.4, water: 0 },
  mountains: { elevation: [0.45, 1], slope: 1.6, water: 0 },
  highlands: { elevation: [0.35, 0.9], slope: 1.2, water: 0 },
  plateau: { elevation: [0.4, 0.95], slope: 0.5, water: 0 },
  canyon: { elevation: [0, 0.6], slope: 2, water: -0.2 },
  badlands: { elevation: [0.05, 0.55], slope: 1.4, water: -0.4 },
  rock: { elevation: [0.2, 1], slope: 1.2, water: 0 },
  cliff: { elevation: [0.2, 1], slope: 0.9, water: 0 },
  volcanic: { elevation: [0.3, 1], slope: 1.6, water: -0.3 },
  desert: { elevation: [0, 0.55], slope: 0.7, water: -0.6 },
  dunes: { elevation: [0, 0.5], slope: 0.6, water: -0.7 },
  savanna: { elevation: [0, 0.6], slope: 0.7, water: -0.3 },
  steppe: { elevation: [0.05, 0.7], slope: 0.8, water: -0.2 },
  meadow: { elevation: [0, 0.65], slope: 0.8, water: 0.1 },
  valley: { elevation: [0, 0.45], slope: 0.9, water: 0.5 },
  forest: { elevation: [0.02, 0.7], slope: 1, water: 0.35 },
  jungle: { elevation: [0, 0.5], slope: 1.1, water: 0.6 },
  rainforest: { elevation: [0, 0.5], slope: 1.1, water: 0.6 },
  swamp: { elevation: [0, 0.2], slope: 0.4, water: 1 },
  marsh: { elevation: [0, 0.2], slope: 0.4, water: 1 },
  wetland: { elevation: [0, 0.25], slope: 0.5, water: 0.9 },
  beach: { elevation: [0, 0.12], slope: 0.5, water: 1 },
  coast: { elevation: [0, 0.15], slope: 0.6, water: 1 },
  island: { elevation: [0, 0.45], slope: 0.9, water: 0.7 },
  ruins: { elevation: [0, 0.8], slope: 0.9, water: 0 },
};

/** Aliases so a description can use any of the words people actually write. */
const ALIASES: Record<string, string> = {
  snowy: 'snow', snowfield: 'snow', glacier: 'snow', ice: 'snow', icy: 'snow',
  alps: 'alpine', peak: 'mountains', peaks: 'mountains', mountain: 'mountains',
  highland: 'highlands', hills: 'meadow', hill: 'meadow',
  mesa: 'plateau', tableland: 'plateau',
  gorge: 'canyon', ravine: 'canyon',
  wasteland: 'badlands',
  stones: 'rock', stone: 'rock', cliffs: 'cliff', scree: 'rock',
  volcano: 'volcanic', lavafield: 'volcanic',
  sands: 'dunes', sand: 'dunes', sahara: 'desert',
  grassland: 'savanna', prairie: 'steppe', plain: 'meadow', plains: 'meadow',
  woods: 'forest', jungleforest: 'jungle', tropics: 'jungle', tropical: 'jungle',
  bog: 'swamp', mire: 'swamp', fen: 'marsh',
  shore: 'beach', shoreline: 'beach', sandy: 'beach', seaside: 'coast',
  archipelago: 'island', atoll: 'island',
  ruin: 'ruins', ancient: 'ruins',
};

export function canonicalBiome(name: string): string {
  const key = name.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!key) return 'meadow';
  if (ALIASES[key]) return ALIASES[key]!;
  if (EXTRA_PALETTES[key]) return key;
  if (key in BIOME_PROFILES) return key;
  // Fall back to the longest known key contained in the name ("denseforest").
  let best = '';
  for (const candidate of Object.keys(EXTRA_PALETTES)) {
    if (candidate.length > best.length && key.includes(candidate)) best = candidate;
  }
  return best || 'meadow';
}

export function paletteFor(name: string, fallback: BiomePalette): BiomePalette {
  const key = canonicalBiome(name);
  const profile = (BIOME_PROFILES as Record<string, { palette?: BiomePalette }>)[key];
  if (profile?.palette) return profile.palette;
  return EXTRA_PALETTES[key] ?? fallback;
}

function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const value = clean.length === 3
    ? clean.split('').map((c) => c! + c!).join('')
    : clean.padEnd(6, '0').slice(0, 6);
  const int = Number.parseInt(value, 16);
  if (!Number.isFinite(int)) return [0.5, 0.5, 0.5];
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/**
 * A noise value sampled on a coarse lattice and bilinearly interpolated.
 *
 * Biome patch noise varies over tens of world units, so evaluating it at every
 * grid node wastes most of the bake time. Sampling it three times per feature
 * and interpolating is visually equivalent and an order of magnitude cheaper.
 */
interface CoarseField {
  spacing: number;
  nodes: number;
  data: Float32Array;
}

function buildCoarseField(field: Heightfield, spacing: number, fn: (x: number, z: number) => number): CoarseField {
  const step = Math.max(field.step, spacing);
  const nodes = Math.max(2, Math.ceil(field.size / step));
  const side = nodes + 1;
  const data = new Float32Array(side * side);
  for (let iz = 0; iz <= nodes; iz += 1) {
    const z = -field.half + iz * step;
    for (let ix = 0; ix <= nodes; ix += 1) {
      data[iz * side + ix] = fn(-field.half + ix * step, z);
    }
  }
  return { spacing: step, nodes, data };
}

function sampleCoarse(coarse: CoarseField, field: Heightfield, x: number, z: number): number {
  const gx = (x + field.half) / coarse.spacing;
  const gz = (z + field.half) / coarse.spacing;
  const x0 = clamp(Math.floor(gx), 0, coarse.nodes - 1);
  const z0 = clamp(Math.floor(gz), 0, coarse.nodes - 1);
  const tx = clamp01(gx - x0);
  const tz = clamp01(gz - z0);
  const side = coarse.nodes + 1;
  const a = coarse.data[z0 * side + x0] ?? 0;
  const b = coarse.data[z0 * side + x0 + 1] ?? 0;
  const c = coarse.data[(z0 + 1) * side + x0] ?? 0;
  const d = coarse.data[(z0 + 1) * side + x0 + 1] ?? 0;
  return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}

export interface BiomeMapOptions {
  /** Distance to water, normalised 0..1, per node — computed from flow and lakes. */
  water?: Float32Array | null;
}

/**
 * Builds the weighted biome field.
 *
 * Biomes without an explicit centre cover the whole map and compete through
 * their ground affinity and patch noise, which is how a single description
 * produces a forested lowland, rocky slopes and snowy peaks at once.
 */
export function buildBiomeMap(
  field: Heightfield,
  ctx: FeatureContext,
  landscape: LandscapeSpec,
  seed: number,
  fallback: BiomePalette,
  options: BiomeMapOptions = {},
): BiomeMap {
  const spec = landscape.biomes ?? [];
  const min = field.min();
  const max = Math.max(min + 0.001, field.max());
  const span = max - min;
  const waterLevel = ctx.waterLevel;

  // A normalised distance-to-water field drives every water-loving biome.
  const waterField = options.water ?? computeWaterAffinity(field, ctx, waterLevel);

  // Slope is read for every node of every biome, so it is measured once here
  // from grid neighbours instead of resampling the surface four times per node.
  const side = field.side;
  const slopes = new Float32Array(side * side);
  for (let iz = 0; iz <= field.cells; iz += 1) {
    for (let ix = 0; ix <= field.cells; ix += 1) {
      const dx = field.at(ix + 1, iz) - field.at(ix - 1, iz);
      const dz = field.at(ix, iz + 1) - field.at(ix, iz - 1);
      slopes[iz * side + ix] = Math.hypot(dx, dz) / (2 * field.step);
    }
  }

  const entries: BiomeEntry[] = [];
  const seen = new Set<string>();
  spec.forEach((entry, index) => {
    const biome = canonicalBiome(entry.biome || entry.id);
    const id = entry.id || `${biome}-${index + 1}`;
    if (seen.has(id)) return;
    seen.add(id);
    const palette = entry.palette ? { low: entry.palette.low, high: entry.palette.high } : paletteFor(biome, fallback);
    const weight = new Mask(field.cells, true);
    const affinity = AFFINITY[biome] ?? { elevation: [0, 1] as [number, number], slope: 2, water: 0 };
    const baseWeight = clamp(entry.weight ?? 1, 0, 1) || 1;
    const transition = Math.max(field.step, entry.transition ?? field.size * 0.09);
    const centre = entry.center;
    const radius = entry.radius ?? (centre ? field.size * 0.35 : 0);
    const patchScale = Math.max(6, field.size * (0.06 + 0.04 * (index % 3)));
    const biomeSeed = (seed + Math.imul(index + 2, 0x9e3779b1)) >>> 0;
    // Patch noise breaks the border into fingers rather than a circle.
    const patchField = buildCoarseField(field, patchScale / 3, (x, z) => {
      const cell = cellular2(biomeSeed, x / patchScale, z / patchScale);
      return 0.55 + 0.45 * (1 - clamp01(cell.f1 * 1.5)) +
        fbm(biomeSeed + 5, x / (patchScale * 0.6), z / (patchScale * 0.6), { octaves: 3 }) * 0.3;
    });
    // The radius is perturbed too, so biome borders are never perfect circles.
    const wobbleField = centre && radius > 0
      ? buildCoarseField(field, Math.max(field.step, radius * 0.4), (x, z) =>
        1 + fbm(biomeSeed + 11, x / (radius * 1.2), z / (radius * 1.2), { octaves: 3 }) * 0.28)
      : null;

    field.each((x, z, value, ix, iz) => {
      let place = 1;
      if (centre && radius > 0 && wobbleField) {
        const wobble = sampleCoarse(wobbleField, field, x, z);
        const distance = Math.hypot(x - centre[0], z - centre[1]);
        place = 1 - smoothstep(clamp01((distance - radius * wobble) / Math.max(field.step, transition)));
        // Reject the neighbourhood before reading any other layer.
        if (place <= 0.002) return value;
      }
      const patches = sampleCoarse(patchField, field, x, z);

      const elevation = (value - min) / span;
      const [low, high] = affinity.elevation;
      // Elevation band with soft edges; outside the band the biome fades out.
      const band = low >= high ? 1 : smoothstep(clamp01((elevation - (low - 0.12)) / 0.24)) *
        (1 - smoothstep(clamp01((elevation - (high - 0.12)) / 0.24)));
      const slope = slopes[iz * side + ix] ?? 0;
      const slopeFit = affinity.slope >= 2 ? 1 : 1 - smoothstep(clamp01((slope - affinity.slope) / Math.max(0.08, affinity.slope)));
      const waterFit = affinity.water === 0
        ? 1
        : affinity.water > 0
          ? lerp(1 - affinity.water, 1, clamp01(waterField[iz * field.side + ix] ?? 0))
          : lerp(1, 1 + affinity.water, clamp01(waterField[iz * field.side + ix] ?? 0));

      // Surface overrides: sand, rock and snow beat biome preference.
      const sand = ctx.sand.get(ix, iz);
      const rock = ctx.rock.get(ix, iz);
      const snow = ctx.snow.get(ix, iz);
      let weightValue = baseWeight * place * band * slopeFit * waterFit * patches;
      if (biome === 'beach' || biome === 'coast' || biome === 'dunes' || biome === 'desert') weightValue *= 1 + sand * 2.4;
      else weightValue *= 1 - sand * 0.75;
      if (biome === 'rock' || biome === 'cliff' || biome === 'mountains' || biome === 'alpine' || biome === 'volcanic' || biome === 'badlands' || biome === 'canyon') {
        weightValue *= 1 + rock * 2;
      } else {
        weightValue *= 1 - rock * 0.7;
      }
      if (biome === 'snow' || biome === 'tundra' || biome === 'alpine') weightValue *= 1 + snow * 3;
      else weightValue *= 1 - snow * 0.9;

      weight.set(ix, iz, clamp01(Math.max(0, weightValue)));
      return value;
    });

    let total = 0;
    for (let i = 0; i < weight.data.length; i += 1) total += weight.data[i] ?? 0;
    entries.push({ id, biome, palette, weight, coverage: total / Math.max(1, weight.data.length) });
  });

  // Normalise per node and record the winner.
  const dominant = new Int16Array(side * side).fill(-1);
  const parsed = entries.map((entry) => ({ low: parseHex(entry.palette.low), high: parseHex(entry.palette.high) }));
  for (let iz = 0; iz <= field.cells; iz += 1) {
    for (let ix = 0; ix <= field.cells; ix += 1) {
      const index = iz * side + ix;
      let total = 0;
      let best = -1;
      let bestWeight = 0;
      for (let b = 0; b < entries.length; b += 1) {
        const value = entries[b]!.weight.data[index] ?? 0;
        total += value;
        if (value > bestWeight) {
          bestWeight = value;
          best = b;
        }
      }
      if (total <= 0) continue;
      for (let b = 0; b < entries.length; b += 1) {
        const data = entries[b]!.weight.data as Float32Array;
        data[index] = (data[index] ?? 0) / total;
      }
      dominant[index] = best;
    }
  }

  const sampleWeights = (x: number, z: number): Array<{ entry: BiomeEntry; palette: { low: [number, number, number]; high: [number, number, number] }; weight: number }> => {
    const [gx, gz] = field.gridOf(x, z);
    const x0 = clamp(Math.floor(gx), 0, field.cells - 1);
    const z0 = clamp(Math.floor(gz), 0, field.cells - 1);
    const tx = clamp01(gx - x0);
    const tz = clamp01(gz - z0);
    const out: Array<{ entry: BiomeEntry; palette: { low: [number, number, number]; high: [number, number, number] }; weight: number }> = [];
    for (let b = 0; b < entries.length; b += 1) {
      const data = entries[b]!.weight.data as Float32Array;
      const a = data[z0 * side + x0] ?? 0;
      const c = data[z0 * side + x0 + 1] ?? 0;
      const d = data[(z0 + 1) * side + x0] ?? 0;
      const e = data[(z0 + 1) * side + x0 + 1] ?? 0;
      const value = lerp(lerp(a, c, tx), lerp(d, e, tx), tz);
      if (value > 0.001) out.push({ entry: entries[b]!, palette: parsed[b]!, weight: value });
    }
    return out;
  };

  const fallbackLow = parseHex(fallback.low);
  const fallbackHigh = parseHex(fallback.high);

  return {
    entries,
    ids: entries.map((entry) => entry.id),
    dominant,
    colorAt: (x, z) => {
      const weights = sampleWeights(x, z);
      if (weights.length === 0) return { low: fallbackLow, high: fallbackHigh };
      let total = 0;
      const low: [number, number, number] = [0, 0, 0];
      const high: [number, number, number] = [0, 0, 0];
      for (const item of weights) {
        total += item.weight;
        low[0] += item.palette.low[0] * item.weight;
        low[1] += item.palette.low[1] * item.weight;
        low[2] += item.palette.low[2] * item.weight;
        high[0] += item.palette.high[0] * item.weight;
        high[1] += item.palette.high[1] * item.weight;
        high[2] += item.palette.high[2] * item.weight;
      }
      if (total <= 0) return { low: fallbackLow, high: fallbackHigh };
      return {
        low: [low[0] / total, low[1] / total, low[2] / total],
        high: [high[0] / total, high[1] / total, high[2] / total],
      };
    },
    biomeAt: (x, z) => {
      const weights = sampleWeights(x, z);
      if (weights.length === 0) return null;
      let best = weights[0]!;
      for (const item of weights) if (item.weight > best.weight) best = item;
      return best.entry.biome;
    },
    weightsAt: (x, z) => sampleWeights(x, z).map((item) => ({
      id: item.entry.biome,
      index: entries.indexOf(item.entry),
      weight: item.weight,
    })),
  };
}

/**
 * Normalised proximity to water (1 = shore, 0 = dry interior).
 *
 * Built from the water level, the flooded depressions and the carved river
 * corridors, so wetland biomes appear beside lakes and along rivers without the
 * description having to place them.
 */
export function computeWaterAffinity(field: Heightfield, ctx: FeatureContext, waterLevel: number | null): Float32Array {
  const affinity = new Float32Array(field.side * field.side);
  const band = Math.max(field.size * 0.02, field.step * 3);
  field.each((_x, _z, value, ix, iz) => {
    let score = ctx.corridor.get(ix, iz) * 0.8;
    if (waterLevel !== null) {
      const above = value - waterLevel;
      if (above < band * 3) score = Math.max(score, 1 - smoothstep(clamp01(above / (band * 3))));
    }
    affinity[iz * field.side + ix] = clamp01(score);
    return value;
  });
  return affinity;
}

/** Convenience: merge lake regions into the water affinity field. */
export function addLakesToAffinity(field: Heightfield, affinity: Float32Array, lakes: LakeRegion[]): Float32Array {
  if (lakes.length === 0) return affinity;
  const band = Math.max(field.size * 0.02, field.step * 3);
  for (const lake of lakes) {
    const reach = lake.radius + band * 3;
    const [gx, gz] = field.gridOf(lake.center[0], lake.center[1]);
    const x0 = clamp(Math.floor(gx - reach / field.step), 0, field.cells);
    const x1 = clamp(Math.ceil(gx + reach / field.step), 0, field.cells);
    const z0 = clamp(Math.floor(gz - reach / field.step), 0, field.cells);
    const z1 = clamp(Math.ceil(gz + reach / field.step), 0, field.cells);
    for (let iz = z0; iz <= z1; iz += 1) {
      for (let ix = x0; ix <= x1; ix += 1) {
        const [wx, wz] = field.worldOf(ix, iz);
        const distance = Math.hypot(wx - lake.center[0], wz - lake.center[1]);
        if (distance > reach) continue;
        const index = iz * field.side + ix;
        const score = distance <= lake.radius ? 1 : 1 - smoothstep(clamp01((distance - lake.radius) / (band * 3)));
        affinity[index] = Math.max(affinity[index] ?? 0, score);
      }
    }
  }
  return affinity;
}

/** Marks flooded cells as water in the flow field so biomes can read it. */
export function waterMaskFromFlow(flow: FlowField, ctx: FeatureContext): Mask {
  const mask = new Mask(flow.filled.cells, true);
  for (let iz = 0; iz <= flow.filled.cells; iz += 1) {
    for (let ix = 0; ix <= flow.filled.cells; ix += 1) {
      if (flow.flooded.get(ix, iz)) mask.set(ix, iz, 1);
      else if (ctx.corridor.get(ix, iz) > 0.55) mask.set(ix, iz, 0.6);
    }
  }
  return mask;
}
