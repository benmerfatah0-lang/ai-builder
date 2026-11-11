import { mulberry32 } from '../generation/rng';
import type { LandscapeSpec } from '../world-plan/schema';
import { Heightfield, Mask } from './heightfield';
import { clamp, clamp01, cellular2, fbm, gradientNoise2, lerp, ridged, smoothstep, warped } from './noise';
import { offsetSpine, profile, projectOntoSpine, smoothSpine, type Vec2 } from './geometry';

/**
 * Landform generators.
 *
 * Each function is a pure, deterministic edit of a baked `Heightfield`: free
 * procedural algorithms only (ridged multifractal, domain warping, cellular
 * noise, radial profiles, terrace quantisation), no paid terrain service and no
 * randomness that is not derived from the world seed.
 *
 * The masks produced here drive the renderer (sand, rock, snow) and the planner
 * (river corridors that buildings must avoid), so a landform never has to be
 * re-derived from the surface afterwards.
 */

export interface FeatureContext {
  field: Heightfield;
  seed: number;
  waterLevel: number | null;
  /** Exposed rock: cliff faces, canyon walls, high bare ground. */
  rock: Mask;
  /** Sand: beaches, dunes, dry lake beds. */
  sand: Mask;
  /** Permanent snow or ice above a given elevation. */
  snow: Mask;
  /** Keep-out corridor around carved water. */
  corridor: Mask;
  /** Cells whose ground was removed to open a cave. */
  carved: Mask;
}

export function createFeatureContext(field: Heightfield, seed: number, waterLevel: number | null): FeatureContext {
  return {
    field,
    seed,
    waterLevel,
    // Floating masks: the renderer and the biome map read smooth weights, and a
    // hard 0/1 edge would show up as a visible seam on the surface.
    rock: new Mask(field.cells, true),
    sand: new Mask(field.cells, true),
    snow: new Mask(field.cells, true),
    corridor: new Mask(field.cells, true),
    carved: new Mask(field.cells),
  };
}

/** Grid node range covering a world-space box, clamped to the field. */
function nodeRange(field: Heightfield, minX: number, maxX: number, minZ: number, maxZ: number): { x0: number; x1: number; z0: number; z1: number } {
  const [gx0, gz0] = field.gridOf(minX, minZ);
  const [gx1, gz1] = field.gridOf(maxX, maxZ);
  return {
    x0: clamp(Math.floor(gx0) - 1, 0, field.cells),
    x1: clamp(Math.ceil(gx1) + 1, 0, field.cells),
    z0: clamp(Math.floor(gz0) - 1, 0, field.cells),
    z1: clamp(Math.ceil(gz1) + 1, 0, field.cells),
  };
}

function eachNode(
  field: Heightfield,
  box: { minX: number; maxX: number; minZ: number; maxZ: number },
  fn: (x: number, z: number, value: number, ix: number, iz: number) => void,
): void {
  const { x0, x1, z0, z1 } = nodeRange(field, box.minX, box.maxX, box.minZ, box.maxZ);
  for (let iz = z0; iz <= z1; iz += 1) {
    const z = -field.half + iz * field.step;
    for (let ix = x0; ix <= x1; ix += 1) {
      const x = -field.half + ix * field.step;
      fn(x, z, field.at(ix, iz), ix, iz);
    }
  }
}

function spineBounds(spine: Vec2[], margin: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [x, z] of spine) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}

function radialBounds(center: Vec2, radius: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  return { minX: center[0] - radius, maxX: center[0] + radius, minZ: center[1] - radius, maxZ: center[1] + radius };
}

// ── Mountain ranges ──────────────────────────────────────────────────────────

export interface RangeFeature {
  spine: Vec2[];
  width: number;
  height: number;
  roughness?: number;
  sharpness?: number;
  snowLine?: number;
}

/**
 * A long range along a spine.
 *
 * Three ingredients make it read as a real mountain range rather than a noisy
 * blob: ridged multifractal relief (sharp creases instead of round hills), a
 * domain-warped distance field (so the crest wanders and spurs branch off), and
 * a wide gentle skirt of foothills around the narrow crest.
 */
export function addRange(ctx: FeatureContext, range: RangeFeature, index = 0): void {
  const { field, seed } = ctx;
  const spine = smoothSpine(range.spine, 10);
  if (spine.length < 2) return;
  const roughness = clamp(range.roughness ?? 0.55, 0, 1);
  const sharpness = clamp(range.sharpness ?? 1, 0, 2);
  const crestScale = Math.max(8, range.width * 0.9);
  const detailScale = Math.max(3, range.width * 0.22);
  const rangeSeed = (seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0;

  const warpStrength = 0.42 + roughness * 0.5;
  // The warp can move the crest by at most this far, so anything beyond the
  // widest skirt plus that margin is rejected before any noise is evaluated.
  const reach = range.width * 2.3 + warpStrength * crestScale * 1.6;
  eachNode(field, spineBounds(spine, range.width * 2.4), (x, z, value, ix, iz) => {
    if (projectOntoSpine(spine, x, z).distance > reach) return;
    // Warp the sample point so the crest meanders and ridges fork.
    const [wx, wz] = warped(rangeSeed + 7, x / crestScale, z / crestScale, warpStrength, 3);
    const projection = projectOntoSpine(spine, wx * crestScale, wz * crestScale);
    // Width itself varies along the range: knots and narrow passes.
    const widthNoise = 1 + fbm(rangeSeed + 13, x / (crestScale * 1.7), z / (crestScale * 1.7), { octaves: 3 }) * 0.45;
    const width = Math.max(1, range.width * widthNoise);
    const crest = profile(projection.distance, width, 'ridge');
    if (crest <= 0.001) return;

    const relief = ridged(rangeSeed + 29, x / crestScale, z / crestScale, { octaves: 5, sharpness: 1.4 + roughness });
    const detail = fbm(rangeSeed + 41, x / detailScale, z / detailScale, { octaves: 3 }) * (0.1 + roughness * 0.22);
    // Foothills: a much wider, gentler skirt blending the range into the land.
    const skirt = profile(projection.distance, width * 2.3, 'dome') * 0.22;
    const elevation = (Math.pow(crest, sharpness) * (relief * 0.85 + 0.15) + detail * crest + skirt) * range.height;
    field.set(ix, iz, value + elevation);

    if (crest > 0.45 && relief > 0.55) ctx.rock.set(ix, iz, 1);
    if (range.snowLine !== undefined && value + elevation > range.snowLine && crest > 0.3) ctx.snow.set(ix, iz, 1);
  });
}

// ── Hills ────────────────────────────────────────────────────────────────────

export interface HillFeature {
  center: Vec2;
  radius: number;
  height: number;
  roughness?: number;
}

/** Rounded hill fields: smooth fBm mounds inside a radial mask. */
export function addHills(ctx: FeatureContext, hills: HillFeature, index = 0): void {
  const { field, seed } = ctx;
  const roughness = clamp(hills.roughness ?? 0.5, 0, 1);
  const hillSeed = (seed + Math.imul(index + 3, 0x85ebca6b)) >>> 0;
  const bumpScale = Math.max(4, hills.radius * (0.42 - roughness * 0.2));

  eachNode(field, radialBounds(hills.center, hills.radius * 1.3), (x, z, value, ix, iz) => {
    const distance = Math.hypot(x - hills.center[0], z - hills.center[1]);
    const mask = profile(distance, hills.radius, 'dome');
    if (mask <= 0.001) return;
    const [wx, wz] = warped(hillSeed + 5, x / bumpScale, z / bumpScale, 0.35, 3);
    const bumps = fbm(hillSeed, wx, wz, { octaves: 4, gain: 0.52 });
    const mound = (bumps * 0.5 + 0.5) * mask;
    field.set(ix, iz, value + mound * hills.height);
  });
}

// ── Valleys ──────────────────────────────────────────────────────────────────

export interface ValleyFeature {
  spine: Vec2[];
  width: number;
  depth: number;
  floor?: number;
}

/** Lowered corridor: `floor` 0 is a sharp V, 1 a wide flat U bottom. */
export function addValley(ctx: FeatureContext, valley: ValleyFeature, index = 0): void {
  const { field, seed } = ctx;
  const spine = smoothSpine(valley.spine, 10);
  const floor = clamp01(valley.floor ?? 0.35);
  const valleySeed = (seed + Math.imul(index + 5, 0xc2b2ae35)) >>> 0;

  const valleyReach = valley.width * (1 + 0.22 * 3.2);
  eachNode(field, spineBounds(spine, valley.width * 1.6), (x, z, value, ix, iz) => {
    if (projectOntoSpine(spine, x, z).distance > valleyReach) return;
    const [wx, wz] = warped(valleySeed + 3, x / (valley.width * 2), z / (valley.width * 2), 0.22, 2);
    const projection = projectOntoSpine(spine, wx * valley.width * 2, wz * valley.width * 2);
    const t = clamp01(projection.distance / Math.max(1, valley.width));
    // Blend a V profile with a flat floor to get a U shape.
    const v = 1 - t;
    const u = smoothstep(clamp01((t - floor) / Math.max(0.001, 1 - floor)));
    const shape = lerp(v * v, u, floor);
    const noise = fbm(valleySeed + 11, x / (valley.width * 0.8), z / (valley.width * 0.8), { octaves: 3 }) * 0.12;
    field.set(ix, iz, value - (shape + noise * (1 - t)) * valley.depth);
  });
}

// ── Plateaus ─────────────────────────────────────────────────────────────────

export interface PlateauFeature {
  center: Vec2;
  radius: number;
  height: number;
  terraces?: number;
  edge?: number;
}

/**
 * Terraced high ground.
 *
 * The top is quantised into flat steps and the perimeter is squeezed into a
 * narrow cliff band, which is how mesa and butte country actually looks: flat
 * tops, vertical edges, debris at the foot.
 */
export function addPlateau(ctx: FeatureContext, plateau: PlateauFeature, index = 0): void {
  const { field, seed } = ctx;
  const terraces = Math.max(1, Math.round(plateau.terraces ?? 3));
  const edge = Math.max(0.5, plateau.edge ?? plateau.radius * 0.18);
  const plateauSeed = (seed + Math.imul(index + 7, 0x27d4eb2d)) >>> 0;
  const step = plateau.height / terraces;

  eachNode(field, radialBounds(plateau.center, plateau.radius * 1.4), (x, z, value, ix, iz) => {
    const wobble = fbm(plateauSeed + 17, x / (plateau.radius * 0.9), z / (plateau.radius * 0.9), { octaves: 3 }) * edge * 0.6;
    const distance = Math.hypot(x - plateau.center[0], z - plateau.center[1]);
    const inner = plateau.radius - edge + wobble;
    if (distance > plateau.radius + edge) return;
    // 1 on the flat top, 0 outside, squeezed across the cliff band.
    const mask = smoothstep(clamp01((plateau.radius + edge - distance) / Math.max(0.5, edge * 2)));
    const raised = value + plateau.height * mask;
    // Quantise only where the plateau dominates, so the base terrain survives.
    const terraced = Math.round((raised - value) / (step || 1)) * step + value;
    const blended = lerp(raised, terraced + fbm(plateauSeed + 23, x / (plateau.radius * 0.35), z / (plateau.radius * 0.35), { octaves: 2 }) * step * 0.16, mask);
    field.set(ix, iz, blended);
    if (mask > 0.08 && mask < 0.92 && distance > inner) ctx.rock.set(ix, iz, 1);
  });
}

// ── Canyons ──────────────────────────────────────────────────────────────────

export interface CanyonFeature {
  spine: Vec2[];
  width: number;
  depth: number;
  meander?: number;
}

/** Deep, narrow, steep-walled channel with layered walls and a flat floor. */
export function addCanyon(ctx: FeatureContext, canyon: CanyonFeature, index = 0): void {
  const { field, seed } = ctx;
  const meander = clamp(canyon.meander ?? 0.35, 0, 1);
  const canyonSeed = (seed + Math.imul(index + 11, 0x165667b1)) >>> 0;
  const spine = offsetSpine(smoothSpine(canyon.spine, 12), (t) =>
    Math.sin(t * Math.PI * (2 + meander * 4) + (canyonSeed % 7)) * canyon.width * meander * 2.2);

  eachNode(field, spineBounds(spine, canyon.width * 3), (x, z, value, ix, iz) => {
    const projection = projectOntoSpine(spine, x, z);
    if (projection.distance >= canyon.width) return;
    const t = clamp01(projection.distance / Math.max(0.5, canyon.width));
    if (t >= 1) return;
    // 1 on the floor, 0 at the rim: a small distance change produces most of the
    // depth change, which is what makes the walls read as vertical.
    const wall = Math.pow(1 - Math.pow(t, 0.42), 1.7);
    const layering = fbm(canyonSeed + 19, x / (canyon.width * 0.5), z / (canyon.width * 0.5), { octaves: 3 }) * 0.08;
    const depth = canyon.depth * (wall + layering * (1 - wall));
    field.set(ix, iz, value - depth);
    if (wall < 0.82) ctx.rock.set(ix, iz, 1);
  });
}

// ── Volcanoes ────────────────────────────────────────────────────────────────

export interface VolcanoFeature {
  center: Vec2;
  radius: number;
  height: number;
  crater?: number;
  caldera?: boolean;
  gullies?: number;
}

/**
 * Cone with a crater or a collapsed caldera, plus radial drainage gullies.
 *
 * The cone is slightly concave (real volcanic slopes steepen towards the top),
 * the crater rim is a raised ring, and the fluting is carved by subtracting
 * ridges along evenly spaced headings — deterministic from the seed.
 */
export function addVolcano(ctx: FeatureContext, volcano: VolcanoFeature, index = 0): void {
  const { field, seed } = ctx;
  const crater = clamp(volcano.crater ?? 0.16, 0, 0.8);
  const gullies = Math.max(0, Math.round(volcano.gullies ?? 10));
  const volcanoSeed = (seed + Math.imul(index + 13, 0x7feb352d)) >>> 0;
  const rng = mulberry32(volcanoSeed);
  const headingOffset = rng() * Math.PI * 2;
  const caldera = volcano.caldera === true;

  eachNode(field, radialBounds(volcano.center, volcano.radius * 1.5), (x, z, value, ix, iz) => {
    const dx = x - volcano.center[0];
    const dz = z - volcano.center[1];
    const distance = Math.hypot(dx, dz);
    const r = distance / Math.max(1, volcano.radius);
    if (r > 1.45) return;

    // Concave cone with a noise-broken outline.
    const outline = 1 + fbm(volcanoSeed + 3, x / (volcano.radius * 0.8), z / (volcano.radius * 0.8), { octaves: 3 }) * 0.09;
    const coneR = r / outline;
    const cone = Math.max(0, 1 - Math.pow(coneR, 1.35)) * volcano.height;
    const skirt = profile(coneR, 1.45, 'dome') * volcano.height * 0.12;

    // Crater or caldera.
    const craterR = caldera ? Math.max(crater, 0.34) : crater;
    const hollow = Math.exp(-Math.pow(coneR / Math.max(0.02, craterR), 2)) * volcano.height * (caldera ? 0.85 : 0.55);
    const rim = Math.exp(-Math.pow((coneR - craterR) / Math.max(0.02, craterR * 0.42), 2)) * volcano.height * (caldera ? 0.1 : 0.16);

    // Radial gullies: fluting down the flanks.
    let fluting = 0;
    if (gullies > 0 && coneR > craterR * 1.15 && coneR < 1.2) {
      const heading = Math.atan2(dz, dx) + headingOffset;
      const lobe = Math.cos(heading * gullies);
      const gullyDepth = Math.pow(clamp01(lobe), 3) * (1 - Math.abs(coneR - (craterR + 1) / 2) * 1.6);
      fluting = Math.max(0, gullyDepth) * volcano.height * 0.09;
    }

    const rough = fbm(volcanoSeed + 31, x / (volcano.radius * 0.2), z / (volcano.radius * 0.2), { octaves: 3 }) * volcano.height * 0.03;
    const elevation = cone + skirt - hollow + rim - fluting + rough;
    field.set(ix, iz, value + elevation);
    if (coneR < 1.05 && coneR > craterR * 0.9) ctx.rock.set(ix, iz, 1);
  });
}

// ── Impact craters ───────────────────────────────────────────────────────────

export interface CraterFeature {
  center: Vec2;
  radius: number;
  depth: number;
  rim?: number;
  centralPeak?: number;
}

/** Bowl, raised rim, ejecta blanket and optional central rebound peak. */
export function addCrater(ctx: FeatureContext, crater: CraterFeature, index = 0): void {
  const { field, seed } = ctx;
  const rim = crater.rim ?? crater.depth * 0.42;
  const peak = clamp01(crater.centralPeak ?? 0.3);
  const craterSeed = (seed + Math.imul(index + 17, 0x2545f491)) >>> 0;

  eachNode(field, radialBounds(crater.center, crater.radius * 2), (x, z, value, ix, iz) => {
    const distance = Math.hypot(x - crater.center[0], z - crater.center[1]);
    const r = distance / Math.max(1, crater.radius);
    if (r > 1.9) return;
    const bowl = -crater.depth * Math.exp(-Math.pow(r / 0.72, 2.4));
    const ring = rim * Math.exp(-Math.pow((r - 1) / 0.22, 2));
    const ejecta = rim * 0.4 * Math.exp(-Math.pow((r - 1.45) / 0.4, 2)) *
      (0.6 + fbm(craterSeed + 5, x / (crater.radius * 0.4), z / (crater.radius * 0.4), { octaves: 3 }) * 0.6);
    const rebound = peak * crater.depth * 0.6 * Math.exp(-Math.pow(r / 0.2, 2));
    field.set(ix, iz, value + bowl + ring + ejecta + rebound);
    if (r < 1.25) ctx.rock.set(ix, iz, 1);
  });
}

// ── Islands and archipelagos ─────────────────────────────────────────────────

export interface IslandFeature {
  center: Vec2;
  radius: number;
  height: number;
  irregularity?: number;
  satellites?: number;
}

/**
 * One island plus optional satellites, forming an archipelago.
 *
 * The coastline is a radial falloff whose radius is perturbed by noise, so it is
 * never a circle: headlands, bays and offshore islets emerge from the same seed.
 */
export function addIsland(ctx: FeatureContext, island: IslandFeature, index = 0): void {
  const { field, seed } = ctx;
  const irregularity = clamp(island.irregularity ?? 0.5, 0, 1);
  const islandSeed = (seed + Math.imul(index + 19, 0x0f25c7d5)) >>> 0;
  const lobes = 3 + Math.round(irregularity * 3);

  const raiseIsland = (center: Vec2, radius: number, height: number, localSeed: number): void => {
    eachNode(field, radialBounds(center, radius * 1.8), (x, z, value, ix, iz) => {
      const dx = x - center[0];
      const dz = z - center[1];
      const heading = Math.atan2(dz, dx);
      const distance = Math.hypot(dx, dz);
      // Noise-broken radius: the same island has bays and headlands.
      const wobble = 1 + (
        fbm(localSeed, Math.cos(heading) * lobes + 4, Math.sin(heading) * lobes + 4, { octaves: 2 }) * 0.42 +
        gradientNoise2(localSeed + 9, heading * 2.2, radius * 0.02) * 0.16
      ) * irregularity;
      const r = distance / Math.max(1, radius * wobble);
      if (r > 1.6) return;
      const land = profile(r, 1, 'dome');
      const detail = fbm(localSeed + 21, x / Math.max(4, radius * 0.3), z / Math.max(4, radius * 0.3), { octaves: 3 }) * 0.18;
      field.set(ix, iz, Math.max(value, value * (1 - land) + (land + detail * land) * height));
      if (land > 0.72 && detail > 0.06) ctx.rock.set(ix, iz, 1);
    });
  };

  raiseIsland(island.center, island.radius, island.height, islandSeed);

  const satellites = Math.max(0, Math.round(island.satellites ?? 0));
  if (satellites > 0) {
    const rng = mulberry32(islandSeed + 77);
    for (let i = 0; i < satellites; i += 1) {
      const heading = rng() * Math.PI * 2;
      const distance = island.radius * (1.15 + rng() * 1.5);
      const radius = island.radius * (0.16 + rng() * 0.34);
      const center: Vec2 = [
        clamp(island.center[0] + Math.cos(heading) * distance, -field.half + radius, field.half - radius),
        clamp(island.center[1] + Math.sin(heading) * distance, -field.half + radius, field.half - radius),
      ];
      raiseIsland(center, radius, island.height * (0.45 + rng() * 0.45), (islandSeed + Math.imul(i + 2, 0x9e3779b1)) >>> 0);
    }
  }
}

// ── Ocean, lakes, beaches ────────────────────────────────────────────────────

/** Drops the border of the map below the water line to form an ocean. */
export function addOcean(ctx: FeatureContext, ocean: { start?: number; depth?: number } = {}): void {
  const { field } = ctx;
  const start = clamp01(ocean.start ?? 0.72);
  const depth = ocean.depth ?? field.size * 0.12;
  field.each((x, z, value) => {
    const radial = Math.max(Math.abs(x), Math.abs(z)) / field.half;
    if (radial <= start) return value;
    const falloff = smoothstep(clamp01((radial - start) / Math.max(0.001, 1 - start)));
    if (falloff <= 0.001) return value;
    const noise = fbm(ctx.seed + 51, x / (field.size * 0.22), z / (field.size * 0.22), { octaves: 3 }) * 0.08;
    return value - (falloff + noise * falloff) * depth;
  });
}

export interface LakeFeature {
  center: Vec2;
  radius: number;
  depth: number;
  level?: number | null;
}

/** Carves a lake basin, blending into the surrounding ground at its shore. */
export function addLake(ctx: FeatureContext, lake: LakeFeature, index = 0): void {
  const { field, seed } = ctx;
  const lakeSeed = (seed + Math.imul(index + 23, 0x1b873593)) >>> 0;
  const level = lake.level ?? ctx.waterLevel ?? 0;

  eachNode(field, radialBounds(lake.center, lake.radius * 1.7), (x, z, value, ix, iz) => {
    const wobble = 1 + fbm(lakeSeed, x / (lake.radius * 1.4), z / (lake.radius * 1.4), { octaves: 3 }) * 0.22;
    const distance = Math.hypot(x - lake.center[0], z - lake.center[1]);
    const r = distance / Math.max(1, lake.radius * wobble);
    if (r > 1.5) return;
    const basin = profile(r, 1, 'bowl');
    const floor = level - lake.depth;
    // Never raise ground: a lake cuts down into what is already there.
    const target = lerp(value, floor, basin);
    field.set(ix, iz, Math.min(value, target));
    if (basin > 0.9 && lake.depth < 2) ctx.sand.set(ix, iz, 1);
  });
}

/**
 * Beaches and coastlines.
 *
 * Ground close to the water line and gentle enough to walk is flattened into a
 * shallow ramp and marked as sand, which is what produces a readable shoreline
 * instead of grass meeting water at an arbitrary slope.
 */
export function addBeaches(ctx: FeatureContext, beaches: { width?: number; maxSlope?: number; elevation?: number } = {}): void {
  const { field } = ctx;
  if (ctx.waterLevel === null) return;
  const width = Math.max(0.5, beaches.width ?? Math.max(2, field.size * 0.02));
  const maxSlope = beaches.maxSlope ?? 0.55;
  const elevation = beaches.elevation ?? Math.max(0.15, field.size * 0.0025);
  const level = ctx.waterLevel;
  // Read from a snapshot: slope queries must see the pre-beach surface.
  const scratch = field.clone();

  field.each((_x, _z, _value, ix, iz) => {
    const current = scratch.at(ix, iz);
    const above = current - level;
    if (above < -width * 0.35 || above > width * 0.6 + elevation) return current;
    const dx = scratch.at(ix + 1, iz) - scratch.at(ix - 1, iz);
    const dz = scratch.at(ix, iz + 1) - scratch.at(ix, iz - 1);
    if (Math.hypot(dx, dz) / (2 * field.step) > maxSlope) return current;
    // Ramp from just below the water line to the beach crest.
    const t = clamp01((above + width * 0.35) / Math.max(0.001, width + elevation));
    const target = level - width * 0.12 + smoothstep(t) * (elevation + width * 0.12);
    ctx.sand.set(ix, iz, 1);
    return lerp(current, target, 0.82);
  });
}

// ── Cliffs and rock formations ───────────────────────────────────────────────

/**
 * Steepens ground above a slope threshold into cliff faces and marks exposed rock.
 *
 * Rather than adding new geometry, this pushes existing steep cells away from
 * their local mean: gentle ground stays gentle, and slopes that were already
 * near-vertical become crisp faces with debris at their foot.
 */
export function sharpenCliffs(ctx: FeatureContext, cliffs: { minSlope?: number; sharpen?: number; coverage?: number } = {}): void {
  const { field, seed } = ctx;
  const minSlope = cliffs.minSlope ?? 0.9;
  const sharpen = clamp01(cliffs.sharpen ?? 0.45);
  const coverage = clamp01(cliffs.coverage ?? 0.6);
  if (sharpen <= 0) return;
  const scratch = field.clone();

  for (let iz = 1; iz < field.cells; iz += 1) {
    const z = -field.half + iz * field.step;
    for (let ix = 1; ix < field.cells; ix += 1) {
      const x = -field.half + ix * field.step;
      const centre = scratch.at(ix, iz);
      const mean = (scratch.at(ix - 1, iz) + scratch.at(ix + 1, iz) + scratch.at(ix, iz - 1) + scratch.at(ix, iz + 1)) / 4;
      // Gradient over the grid, the same measure `Heightfield.slope` reports.
      const dx = scratch.at(ix + 1, iz) - scratch.at(ix - 1, iz);
      const dz = scratch.at(ix, iz + 1) - scratch.at(ix, iz - 1);
      const slope = Math.hypot(dx, dz) / (2 * field.step);
      if (slope < minSlope) continue;
      // Rock coverage is a seeded cellular pattern, so formations come in groups.
      const cell = cellular2(seed + 91, x / (field.size * 0.09), z / (field.size * 0.09));
      if (1 - clamp01(cell.f1 * 1.35) < coverage) ctx.rock.set(ix, iz, 1);
      const push = (centre - mean) * sharpen * clamp01((slope - minSlope) / Math.max(0.05, minSlope));
      field.set(ix, iz, centre + push);
      // Debris apron: material removed from the face settles below it.
      field.set(ix, iz + 1, scratch.at(ix, iz + 1) + push * 0.12);
    }
  }
}

/** High-frequency surface detail, added analytically rather than baked. */
export function detailHeight(ctx: FeatureContext, x: number, z: number, detail: { amplitude?: number; scale?: number; octaves?: number } = {}): number {
  const amplitude = detail.amplitude ?? 0;
  if (amplitude <= 0) return 0;
  const scale = Math.max(1, detail.scale ?? 9);
  return fbm(ctx.seed + 977, x / scale, z / scale, { octaves: detail.octaves ?? 3 }) * amplitude;
}

/**
 * Everything the planner may ask for, applied in a fixed, deterministic order.
 *
 * `includeBeaches` is off during a full bake because shores must be flattened
 * *after* erosion and river carving have had their say, not before.
 */
export function applyLandscapeFeatures(ctx: FeatureContext, landscape: LandscapeSpec, includeBeaches = true): void {
  const { field } = ctx;
  const ranges = landscape.ranges ?? [];
  const hills = landscape.hills ?? [];
  const valleys = landscape.valleys ?? [];
  const plateaus = landscape.plateaus ?? [];
  const canyons = landscape.canyons ?? [];
  const volcanoes = landscape.volcanoes ?? [];
  const craters = landscape.craters ?? [];
  const islands = landscape.islands ?? [];
  const lakes = landscape.lakes ?? [];

  // Order matters: broad shaping first, then a single smoothing pass to remove
  // grid-scale spikes, then the narrow features that must stay sharp, then water.
  // Blurring after carving would fill a canyon back in.
  ranges.forEach((range, index) => addRange(ctx, range, index));
  hills.forEach((hills_, index) => addHills(ctx, hills_, index));
  volcanoes.forEach((volcano, index) => addVolcano(ctx, volcano, index));
  craters.forEach((crater, index) => addCrater(ctx, crater, index));
  plateaus.forEach((plateau, index) => addPlateau(ctx, plateau, index));
  islands.forEach((island, index) => addIsland(ctx, island, index));
  if (landscape.ocean) addOcean(ctx, landscape.ocean);
  if (ranges.length || plateaus.length || volcanoes.length || islands.length) field.blur(1, 1);
  valleys.forEach((valley, index) => addValley(ctx, valley, index));
  canyons.forEach((canyon, index) => addCanyon(ctx, canyon, index));
  lakes.forEach((lake, index) => addLake(ctx, lake, index));
  if (landscape.cliffs) sharpenCliffs(ctx, landscape.cliffs);
  if (includeBeaches && landscape.beaches) addBeaches(ctx, landscape.beaches);
}
