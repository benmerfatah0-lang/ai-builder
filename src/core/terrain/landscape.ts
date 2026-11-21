import { clamp, clamp01 } from './noise';
import { Heightfield } from './heightfield';
import { applyLandscapeFeatures, addBeaches, createFeatureContext, detailHeight, type FeatureContext } from './features';
import { carveRivers, computeFlow, extractRivers, findLakes, riverFromSpine, type CarveReport, type FlowField, type LakeRegion, type RiverPath } from './hydrology';
import { erodeField, type ErosionReport } from './erosion';
import { buildBiomeMap, computeWaterAffinity, addLakesToAffinity, type BiomeMap } from './biomeMap';
import { caveSolidAt, carveCaves, type CaveEntrance } from './caves';
import { planChunks, shouldUseChunks, type ChunkLayout, type ChunkSettings } from './chunks';
import { offsetSpine, type Vec2 } from './geometry';
import type { LandscapeSpec, Terrain } from '../world-plan/schema';

/**
 * The procedural landscape engine.
 *
 * One entry point bakes a whole world: a heightfield grid, its drainage network,
 * its biomes, its caves and its chunk/LOD layout. Everything downstream — the
 * terrain sampler used by placement, the meshes built by the renderer, the walk
 * navigation, the reports — reads that single baked result, so the surface you
 * see, the ground objects stand on and the rivers that run through it can never
 * disagree with each other.
 *
 * Guarantees:
 *
 * - **Deterministic.** Same specification and same seed ⇒ identical heights, to
 *   the last bit. Every random draw comes from `mulberry32`.
 * - **Bounded.** Work scales with the bake grid, not with the world size, and
 *   every loop has an explicit cap.
 * - **Free.** Only local arithmetic: value/gradient/cellular noise, ridged
 *   multifractals, priority flood, D8 flow, droplet and talus erosion. No paid
 *   terrain service is called, and none is optional.
 * - **Non-breaking.** A terrain without `landscape` never reaches this module, so
 *   existing worlds keep their exact analytic surface.
 */

export interface LandscapeOptions {
  /**
   * Analytic base surface (usually the classic style sampler) laid down before
   * features are applied. Passed in rather than imported to keep this module
   * free of a dependency cycle with `generation/terrain.ts`.
   */
  baseHeight?: (x: number, z: number) => number;
  /** Hard cap on bake resolution, whatever the specification asks for. */
  maxCells?: number;
  /** Disable erosion; used by tests and by very small maps. */
  skipErosion?: boolean;
  /** Disable river derivation. */
  skipRivers?: boolean;
  chunkSettings?: ChunkSettings;
}

export interface LandscapeStats {
  cells: number;
  size: number;
  min: number;
  max: number;
  mean: number;
  /** Fraction of the map above the water level (1 when there is no water). */
  landFraction: number;
  /** Fraction of nodes steeper than 45°, i.e. real cliffs. */
  steepFraction: number;
  bakeMs: number;
}

export interface LandscapeResult {
  field: Heightfield;
  masks: Pick<FeatureContext, 'rock' | 'sand' | 'snow' | 'corridor' | 'carved'>;
  biomes: BiomeMap;
  flow: FlowField | null;
  rivers: RiverPath[];
  lakes: LakeRegion[];
  caves: CaveEntrance[];
  erosion: ErosionReport;
  carving: CarveReport;
  chunks: ChunkLayout;
  chunked: boolean;
  waterLevel: number | null;
  /** Water level the engine would choose if the plan has none. */
  suggestedWaterLevel: number | null;
  size: number;
  fingerprint: string;
  stats: LandscapeStats;
  heightAt(x: number, z: number): number;
  slopeAt(x: number, z: number): number;
  normalAt(x: number, z: number): [number, number, number];
  biomeAt(x: number, z: number): string | null;
  /**
   * True where the ground must stay clear: river corridors, cave passages and
   * anything below the water line. Buildings and roads consult this so a river
   * can never run through a house.
   */
  blockedAt(x: number, z: number): boolean;
  /** Rock (true) or void (false) at a point in space, for cave queries. */
  solidAt(x: number, y: number, z: number): boolean;
}

/** Stable text key for the cache, so equal inputs never bake twice. */
export function landscapeFingerprint(terrain: Terrain, seed: number): string {
  return `${seed}|${terrain.style}|${terrain.size}|${terrain.resolution}|${terrain.heightScale}|${terrain.waterLevel}|${stableStringify(terrain.landscape ?? null)}|${terrain.lakeBasin ? `${terrain.lakeBasin.x},${terrain.lakeBasin.z},${terrain.lakeBasin.radius},${terrain.lakeBasin.depth}` : ''}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

const CACHE_LIMIT = 3;
const cache = new Map<string, LandscapeResult>();

/** Bake resolution: fine enough to hold detail, bounded so bakes stay fast. */
export function bakeCells(terrain: Terrain, landscape: LandscapeSpec, maxCells = 256): number {
  if (landscape.cells) return clamp(Math.round(landscape.cells), 32, maxCells);
  // A larger world needs more cells to keep the same ground detail per unit.
  const fromResolution = Math.round(Math.max(terrain.resolution, 64) * clamp(terrain.size / 160, 0.7, 1.6));
  return clamp(fromResolution, 96, maxCells);
}

/**
 * Bakes a landscape.
 *
 * The order of the passes is part of the design: broad landforms first, then
 * wear (erosion), then water (which must flow over the worn surface), then
 * shores and caves, then biomes last so they can read the finished ground.
 */
export function bakeLandscape(terrain: Terrain, seed: number, options: LandscapeOptions = {}): LandscapeResult {
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const landscape: LandscapeSpec = terrain.landscape ?? {};
  const size = Math.max(1, terrain.size);
  const cells = bakeCells(terrain, landscape, options.maxCells);
  const field = new Heightfield(size, cells);
  const waterLevel = terrain.waterLevel;
  const ctx = createFeatureContext(field, seed, waterLevel);

  // 1. Base surface: the classic analytic style, so `style` keeps meaning.
  if (options.baseHeight) {
    const base = options.baseHeight;
    field.each((x, z) => base(x, z));
  }

  // 2. Landforms: ranges, hills, volcanoes, craters, plateaus, islands, ocean,
  //    valleys, canyons, lakes, cliffs. Beaches wait for the final surface.
  applyLandscapeFeatures(ctx, landscape, false);

  // 3. Erosion: droplets cut rills, talus rounds the cliffs they expose.
  let erosion: ErosionReport = { eroded: 0, deposited: 0, droplets: 0, thermalMoved: 0 };
  if (!options.skipErosion) {
    const spec = landscape.erosion;
    const hydraulic = spec?.droplets === 0
      ? null
      : {
        droplets: Math.max(0, Math.round(spec?.droplets ?? clamp(Math.round((size * size) / 12), 900, 26000))),
        maxLifetime: Math.max(8, Math.round(spec?.iterations ?? clamp(cells * 0.2, 16, 64))),
        inertia: spec?.inertia,
        sedimentCapacity: spec?.sedimentCapacity,
        erosionRate: spec?.erosionRate,
        depositionRate: spec?.depositionRate,
        evaporation: spec?.evaporation,
      };
    const thermal = spec?.thermalPasses === 0
      ? null
      : {
        passes: Math.max(1, Math.round(spec?.thermalPasses ?? (landscape.ranges?.length || landscape.canyons?.length ? 2 : 1))),
        talus: Math.max(0.05, (spec?.talus ?? 0.95) * field.step),
        strength: 0.42,
      };
    if (hydraulic || thermal) erosion = erodeField(field, seed, { hydraulic, thermal });
  }

  // 4. Drainage: fill, D8, accumulation, channels, then carve the rivers.
  const flow = computeFlow(field, { threshold: clamp(Math.round(cells * cells * 0.0011), 12, 4000) });
  // A depression only counts as a lake when it is deep and wide enough to be one:
  // priority flooding also "fills" ordinary flat ground, which must not become a
  // lake, or a flat world would sprout rivers nobody asked for.
  const lakes = findLakes(
    flow,
    Math.max(6, Math.round(cells * cells * 0.0004)),
    field,
    Math.max(0.35, size * 0.004),
  ).filter((lake) => lake.depth > Math.max(0.35, size * 0.004) && lake.radius > size * 0.03);
  const rivers: RiverPath[] = [];
  let carving: CarveReport = { rivers: 0, nodes: 0, deepest: 0 };
  if (!options.skipRivers) {
    const specRivers = landscape.rivers ?? [];
    // Drainage is only derived when the description actually shaped the land: an
    // empty recipe on flat ground has nothing to drain and gets no rivers.
    const shaped = (landscape.ranges?.length ?? 0) + (landscape.hills?.length ?? 0) +
      (landscape.valleys?.length ?? 0) + (landscape.canyons?.length ?? 0) +
      (landscape.plateaus?.length ?? 0) + (landscape.volcanoes?.length ?? 0) +
      (landscape.islands?.length ?? 0) + (landscape.lakes?.length ?? 0) > 0;
    const wantsWater = shaped && (Boolean(landscape.ocean) || lakes.length > 0 || (landscape.ranges?.length ?? 0) > 0);
    if (specRivers.length > 0) {
      specRivers.forEach((river) => {
        const spine: Vec2[] = [];
        if (river.source) spine.push([river.source[0], river.source[1]]);
        if (river.mouth) spine.push([river.mouth[0], river.mouth[1]]);
        let path = spine.length > 0
          ? riverFromSpine(flow, spine, Math.max(5, Math.round(cells * 0.1)))
          : { nodes: [], points: [], discharge: 0, derived: false } as RiverPath;
        // Meanders are applied after the path is fixed, so the bed still descends.
        if (river.meander && river.meander > 0 && path.points.length > 3) {
          const meandered = offsetSpine(path.points, (t) =>
            Math.sin(t * Math.PI * (3 + river.meander! * 3)) * Math.max(1, (river.width ?? size * 0.012)) * river.meander! * 1.6);
          const nodes = meandered.map(([x, z]) => {
            const [gx, gz] = field.gridOf(x, z);
            return [clamp(Math.round(gx), 0, field.cells), clamp(Math.round(gz), 0, field.cells)] as [number, number];
          });
          path = { ...path, nodes, points: meandered };
        }
        if (path.nodes.length >= 2) rivers.push(path);
      });
    } else if (wantsWater) {
      // No river was described but the land drains somewhere: derive the real
      // channels so valleys and deltas look lived-in instead of arbitrary.
      const maxRivers = clamp(Math.round(size / 70), 1, 4);
      rivers.push(...extractRivers(flow, { threshold: flow.threshold, maxRivers, minLength: Math.max(6, Math.round(cells * 0.16)) }));
    }
    if (rivers.length > 0) {
      const specRiversForWidth = landscape.rivers ?? [];
      const widest = specRiversForWidth.reduce((best, river) => Math.max(best, river.width ?? 0), 0);
      const width = Math.max(size * 0.011, widest || size * 0.014);
      const corridor = specRiversForWidth.reduce((best, river) => Math.max(best, river.corridor ?? 0), 0);
      carving = carveRivers(ctx, rivers, {
        width,
        depth: landscape.rivers?.[0]?.depth,
        corridor: corridor > 0 ? corridor : undefined,
        mouthLevel: waterLevel,
      });
    }
  }

  // 5. Shores, now that the ground is final.
  if (landscape.beaches) addBeaches(ctx, landscape.beaches);
  else if (waterLevel !== null && (landscape.ocean || landscape.islands?.length || lakes.length > 0)) {
    addBeaches(ctx, { width: Math.max(2, size * 0.02), maxSlope: 0.5, elevation: Math.max(0.2, size * 0.003) });
  }

  // 6. Caves: carved mouths in rock faces, plus a volumetric query.
  const caves = carveCaves(ctx, landscape);

  // 7. Biomes, read off the finished ground.
  const affinity = addLakesToAffinity(field, computeWaterAffinity(field, ctx, waterLevel), lakes);
  const biomes = buildBiomeMap(field, ctx, landscape, seed, { low: terrain.palette.low, high: terrain.palette.high }, { water: affinity });

  // 8. Chunk and LOD layout for the renderer.
  const chunked = shouldUseChunks(size, terrain.resolution, options.chunkSettings);
  const chunks = planChunks(size, options.chunkSettings ?? landscape.chunks ?? {});

  const detail = landscape.detail ?? {};
  const caveSeed = (seed + 0x6a09e667) >>> 0;
  const min = field.min();
  const max = field.max();
  let land = 0;
  let steep = 0;
  const nodes = field.side * field.side;
  for (let iz = 0; iz <= field.cells; iz += 1) {
    for (let ix = 0; ix <= field.cells; ix += 1) {
      const height = field.at(ix, iz);
      if (waterLevel === null || height > waterLevel) land += 1;
      // Grid slope (rise over run) straight from neighbours: no extra sampling.
      const dx = field.at(ix + 1, iz) - field.at(ix - 1, iz);
      const dz = field.at(ix, iz + 1) - field.at(ix, iz - 1);
      if (Math.hypot(dx, dz) / (2 * field.step) > 1) steep += 1;
    }
  }
  const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const heightAt = (x: number, z: number): number => field.sample(x, z) + detailHeight(ctx, x, z, detail);

  return {
    field,
    masks: { rock: ctx.rock, sand: ctx.sand, snow: ctx.snow, corridor: ctx.corridor, carved: ctx.carved },
    biomes,
    flow,
    rivers,
    lakes,
    caves,
    erosion,
    carving,
    chunks,
    chunked,
    waterLevel,
    suggestedWaterLevel: waterLevel ?? (landscape.ocean || lakes.length > 0 ? percentile(field, 0.16) : null),
    size,
    fingerprint: landscapeFingerprint(terrain, seed),
    stats: {
      cells,
      size,
      min,
      max,
      mean: field.mean(),
      landFraction: clamp01(land / nodes),
      steepFraction: clamp01(steep / nodes),
      bakeMs: Math.max(0, finishedAt - startedAt),
    },
    heightAt,
    slopeAt: (x, z) => field.slope(x, z),
    normalAt: (x, z) => field.normal(x, z),
    biomeAt: (x, z) => biomes.biomeAt(x, z),
    blockedAt: (x, z) => {
      if (ctx.corridor.atWorld(field, x, z) > 0.35) return true;
      if (ctx.carved.atWorld(field, x, z) > 0) return true;
      if (waterLevel !== null && field.sample(x, z) < waterLevel) return true;
      return false;
    },
    solidAt: (x, y, z) => caveSolidAt(caveSeed, x, y, z, { scale: Math.max(6, size * 0.05), surface: field.sample(x, z) }),
  };
}

function percentile(field: Heightfield, fraction: number): number {
  const values = Array.from(field.data as Float32Array);
  values.sort((a, b) => a - b);
  const index = clamp(Math.round(values.length * clamp01(fraction)), 0, values.length - 1);
  return values[index] ?? 0;
}

/**
 * Bakes (or reuses) the landscape for a terrain specification.
 *
 * Baking is the expensive part of the engine, and the same terrain is sampled
 * thousands of times per frame by the renderer, the placement code and the walk
 * navigation. The cache is keyed by a fingerprint of every input that can change
 * the result, so editing the terrain in the editor re-bakes exactly once and
 * everything else reads the cached grid.
 */
export function getLandscape(terrain: Terrain, seed: number, options: LandscapeOptions = {}): LandscapeResult {
  const fingerprint = landscapeFingerprint(terrain, seed);
  const cached = cache.get(fingerprint);
  if (cached) {
    // Refresh recency without growing the cache.
    cache.delete(fingerprint);
    cache.set(fingerprint, cached);
    return cached;
  }
  const result = bakeLandscape(terrain, seed, options);
  cache.set(fingerprint, result);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return result;
}

/** Test helper: drop every cached bake. */
export function clearLandscapeCache(): void {
  cache.clear();
}

/** Height range of the baked surface, useful for reports and validation. */
export function landscapeSummary(result: LandscapeResult): string {
  const parts = [
    `${result.stats.cells} cells`,
    `height ${result.stats.min.toFixed(1)}..${result.stats.max.toFixed(1)}`,
    `${Math.round(result.stats.landFraction * 100)}% land`,
    `${result.rivers.length} rivers`,
    `${result.lakes.length} lakes`,
    `${result.caves.length} caves`,
    `${result.biomes.entries.length} biomes`,
    `${result.chunks.count} chunks`,
    `${Math.round(result.stats.bakeMs)}ms`,
  ];
  return parts.join(' · ');
}
