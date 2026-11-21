import { mulberry32, range, type Rng } from '../../core/generation/rng';
import { landscapeSchema, type LandscapeSpec, type TerrainStyle } from '../../core/world-plan/schema';
import type { BiomeId } from '../ai/types';
import type { BiomeZone, LakeSpec, RegionSelector, RiverSpec } from './worldSpec';

/**
 * From a world specification to a landscape recipe.
 *
 * The planner understands language; the terrain engine understands geometry.
 * This module is the translation layer: it turns "a castle on a mountain range
 * with a village around a lake and a river running down to the sea" into spines,
 * radii, depths and biome weights that the engine bakes deterministically.
 *
 * Rules it follows:
 *
 * - **Nothing is invented.** A feature appears in the recipe only when the
 *   description implies it (a landform word, a terrain style, a body of water,
 *   a second biome). A world described as "a tree" gets no recipe at all and
 *   keeps the classic analytic terrain byte for byte.
 * - **Negations win.** "Without a river" removes the river from the recipe.
 * - **Everything is inside the schema.** Every number is clamped to the bounds
 *   `landscapeSchema` allows, so a recipe can never make a plan invalid.
 * - **Deterministic.** Positions and jitter come from `mulberry32(seed)`.
 */

export interface LandscapeRecipeInput {
  size: number;
  resolution: number;
  heightScale: number;
  roughness: number;
  style: TerrainStyle;
  water: boolean;
  waterLevel: number | null;
  lake?: LakeSpec;
  river?: RiverSpec;
  biomes: BiomeZone[];
  primaryBiome: BiomeId;
  /** Entry ids the description actually mentioned. */
  mentions: string[];
  /** Entry ids the description ruled out. */
  negated: string[];
  seed: number;
}

/** Styles whose whole point is a landform the engine builds better. */
const LANDSCAPE_STYLES: ReadonlySet<TerrainStyle> = new Set([
  'mountains',
  'canyon',
  'volcano',
  'crater',
  'plateau',
  'islands',
  'valley',
]);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** True when the description asks for terrain the engine should bake. */
export function landscapeWanted(input: LandscapeRecipeInput): boolean {
  if (input.style === 'flat') return false;
  if (LANDSCAPE_STYLES.has(input.style)) return true;
  if (input.river) return true;
  if (input.lake) return true;
  // Several biomes means the surface has to blend between them.
  return new Set(input.biomes.map((zone) => zone.biome)).size >= 2;
}

function has(input: LandscapeRecipeInput, ...ids: string[]): boolean {
  return ids.some((id) => input.mentions.includes(id));
}

function denied(input: LandscapeRecipeInput, ...ids: string[]): boolean {
  return ids.some((id) => input.negated.includes(id));
}

/** A seeded spine crossing the map, kept inside the margins. */
function spineAcross(rng: Rng, size: number, points: number, axis: 'x' | 'z', jitter: number): [number, number][] {
  const half = size / 2;
  const reach = half - size * 0.1;
  const spine: [number, number][] = [];
  for (let index = 0; index < points; index += 1) {
    const t = points === 1 ? 0 : index / (points - 1);
    const along = -reach + t * reach * 2;
    const across = range(rng, -jitter, jitter) * size;
    spine.push(axis === 'x' ? [along, across] : [across, along]);
  }
  return spine;
}

/** A seeded point away from the centre, so features do not all stack up. */
function offCenter(rng: Rng, size: number, fraction: number): [number, number] {
  const heading = range(rng, 0, Math.PI * 2);
  const distance = size * fraction * range(rng, 0.55, 1);
  const reach = size / 2 - size * 0.14;
  return [
    clamp(Math.cos(heading) * distance, -reach, reach),
    clamp(Math.sin(heading) * distance, -reach, reach),
  ];
}

/** Where a regional biome sits, matching the layout resolver's own regions. */
function regionCenter(selector: RegionSelector | undefined, size: number): [number, number] | null {
  const reach = size * 0.3;
  switch (selector) {
    case 'north': return [0, -reach];
    case 'south': return [0, reach];
    case 'east': return [reach, 0];
    case 'west': return [-reach, 0];
    case 'center': return [0, 0];
    case 'waterfront': return null;
    case 'summit': return null;
    case 'base': return null;
    case 'slope': return null;
    default: return null;
  }
}

/**
 * Builds the recipe, or `undefined` when the description does not call for one.
 *
 * The result always parses against `landscapeSchema`; callers may still validate
 * it, and the tests do exactly that across every style and size.
 */
export function buildLandscapeRecipe(input: LandscapeRecipeInput): LandscapeSpec | undefined {
  if (!landscapeWanted(input)) return undefined;

  const rng = mulberry32((input.seed ^ 0x51ed2701) >>> 0);
  const size = Math.max(32, input.size);
  const heightScale = Math.max(0, input.heightScale);
  const roughness = clamp(input.roughness, 0, 1);
  const style = input.style;
  const recipe: LandscapeSpec = { version: 1 };

  const wantsMountains = style === 'mountains' || has(input, 'mountains', 'mountain-terrain');
  const wantsWater = input.water && !denied(input, 'water', 'sea');

  // ── Mountain ranges ───────────────────────────────────────────────────────
  if (wantsMountains && !denied(input, 'mountains')) {
    const height = clamp(heightScale * 1.7, 6, 190);
    const width = clamp(size * 0.13, 8, 200);
    const main: [number, number][] = spineAcross(rng, size, size >= 260 ? 5 : 3, rng() < 0.5 ? 'x' : 'z', 0.16);
    recipe.ranges = [{
      id: 'range-1',
      spine: main,
      width,
      height,
      roughness: clamp(0.4 + roughness * 0.5, 0, 1),
      sharpness: clamp(0.8 + roughness * 0.9, 0, 2),
      ...(height > 26 ? { snowLine: Math.round(height * 0.52) } : {}),
    }];
    if (size >= 260) {
      recipe.ranges.push({
        id: 'range-2',
        spine: spineAcross(rng, size, 3, rng() < 0.5 ? 'x' : 'z', 0.22),
        width: clamp(width * 0.7, 6, 200),
        height: clamp(height * 0.62, 4, 190),
        roughness: clamp(0.35 + roughness * 0.4, 0, 1),
      });
    }
  }

  // ── Hills ─────────────────────────────────────────────────────────────────
  if ((style === 'hills' || has(input, 'hills')) && !denied(input, 'hills')) {
    const count = size >= 260 ? 4 : 2;
    recipe.hills = Array.from({ length: count }, (_, index) => ({
      id: `hills-${index + 1}`,
      center: offCenter(rng, size, 0.28),
      radius: clamp(size * range(rng, 0.1, 0.16), 4, 200),
      height: clamp(heightScale * range(rng, 0.5, 0.85), 1, 120),
      roughness: clamp(0.35 + roughness * 0.4, 0, 1),
    }));
  }

  // ── Valleys ───────────────────────────────────────────────────────────────
  const wantsValley = style === 'valley' || has(input, 'valley') || Boolean(input.river);
  if (wantsValley && !denied(input, 'valley')) {
    recipe.valleys = [{
      id: 'valley-1',
      spine: spineAcross(rng, size, 3, input.river?.axis === 'x' ? 'x' : 'z', 0.12),
      width: clamp(size * 0.17, 6, 200),
      depth: clamp(heightScale * 0.55, 1, 120),
      floor: 0.45,
    }];
  }

  // ── Plateaus ──────────────────────────────────────────────────────────────
  if ((style === 'plateau' || has(input, 'plateau')) && !denied(input, 'plateau')) {
    recipe.plateaus = [{
      id: 'plateau-1',
      center: offCenter(rng, size, 0.24),
      radius: clamp(size * 0.19, 6, 200),
      height: clamp(heightScale * 1.15, 3, 150),
      terraces: size >= 260 ? 4 : 3,
      edge: clamp(size * 0.02, 1, 60),
    }];
  }

  // ── Canyons ───────────────────────────────────────────────────────────────
  if ((style === 'canyon' || has(input, 'canyon')) && !denied(input, 'canyon')) {
    recipe.canyons = [{
      id: 'canyon-1',
      spine: spineAcross(rng, size, 4, rng() < 0.5 ? 'x' : 'z', 0.14),
      width: clamp(size * 0.05, 3, 120),
      depth: clamp(heightScale * 1.2, 3, 150),
      meander: 0.45,
    }];
    recipe.cliffs = { minSlope: 0.8, sharpen: 0.5, coverage: 0.7 };
  }

  // ── Volcanoes and impact craters ──────────────────────────────────────────
  if ((style === 'volcano' || has(input, 'volcano')) && !denied(input, 'volcano')) {
    recipe.volcanoes = [{
      id: 'volcano-1',
      center: offCenter(rng, size, 0.18),
      radius: clamp(size * 0.17, 8, 200),
      height: clamp(heightScale * 1.9, 8, 190),
      crater: 0.16,
      gullies: 14,
    }];
    recipe.cliffs = recipe.cliffs ?? { minSlope: 0.85, sharpen: 0.45, coverage: 0.6 };
  }
  if ((style === 'crater' || has(input, 'crater')) && !denied(input, 'crater')) {
    const count = size >= 260 ? 2 : 1;
    recipe.craters = Array.from({ length: count }, (_, index) => ({
      id: `crater-${index + 1}`,
      center: index === 0 ? offCenter(rng, size, 0.16) : offCenter(rng, size, 0.3),
      radius: clamp(size * (index === 0 ? 0.14 : 0.08), 4, 200),
      depth: clamp(heightScale * (index === 0 ? 0.9 : 0.5), 2, 120),
      centralPeak: 0.35,
    }));
  }

  // ── Islands, ocean and shores ─────────────────────────────────────────────
  const wantsOcean = style === 'islands' || has(input, 'island', 'islands-terrain') ||
    (wantsWater && has(input, 'sea'));
  if (wantsOcean && !denied(input, 'island', 'sea')) {
    const isArchipelago = style === 'islands' || has(input, 'islands-terrain');
    recipe.ocean = { start: isArchipelago ? 0.62 : 0.8, depth: clamp(size * (isArchipelago ? 0.13 : 0.08), 4, 190) };
    if (isArchipelago || has(input, 'island')) {
      recipe.islands = [{
        id: 'island-1',
        center: [0, 0],
        radius: clamp(size * (isArchipelago ? 0.22 : 0.3), 6, 240),
        height: clamp(Math.max(heightScale, size * 0.06), 4, 150),
        irregularity: 0.7,
        satellites: isArchipelago ? clamp(Math.round(size / 60), 2, 12) : 0,
      }];
    }
  }

  // ── Lakes ─────────────────────────────────────────────────────────────────
  if (input.lake && !denied(input, 'lake')) {
    recipe.lakes = [{
      id: 'lake-1',
      center: [clamp(input.lake.x, -size / 2, size / 2), clamp(input.lake.z, -size / 2, size / 2)],
      radius: clamp(input.lake.radius, 2, 240),
      depth: clamp(input.lake.depth, 0.5, 60),
      ...(input.waterLevel !== null ? { level: input.waterLevel } : {}),
    }];
  }

  // ── Rivers ────────────────────────────────────────────────────────────────
  if (input.river && !denied(input, 'river')) {
    const source = recipe.ranges?.[0]?.spine[0];
    recipe.rivers = [{
      id: 'river-1',
      // A river starts in the high ground when the description gave it any.
      ...(source ? { source: [source[0], source[1]] } : {}),
      width: clamp(Math.max(2.4, input.river.width * 0.85), 1, 30),
      depth: clamp(Math.max(1, input.river.width * 0.4), 0.5, 12),
      meander: 0.55,
      carve: true,
      corridor: clamp(Math.max(9, size * 0.05), 4, 70),
    }];
  }

  // ── Caves ─────────────────────────────────────────────────────────────────
  // A described mine is an entrance into rock, and volcanic or canyon ground is
  // where a cave is expected; anywhere else the surface stays solid.
  const wantsCave = has(input, 'mine-entrance') || style === 'volcano' || style === 'canyon' || style === 'crater';
  if (wantsCave && !denied(input, 'mine-entrance')) {
    recipe.caves = [{
      id: 'cave-1',
      radius: clamp(size * 0.016, 1.5, 40),
      depth: clamp(size * 0.13, 6, 78),
      chambers: 2,
    }];
  }

  // ── Cliffs, shores and wear ───────────────────────────────────────────────
  if (!recipe.cliffs && (wantsMountains || has(input, 'rock') || style === 'plateau')) {
    recipe.cliffs = { minSlope: 0.9, sharpen: 0.4, coverage: 0.55 };
  }
  if (wantsWater && (recipe.ocean || recipe.lakes || recipe.islands) && !denied(input, 'sea')) {
    recipe.beaches = {
      width: clamp(size * 0.022, 2, 40),
      maxSlope: 0.5,
      elevation: clamp(size * 0.003, 0.2, 6),
    };
  }

  // ── Biomes ────────────────────────────────────────────────────────────────
  const zones = input.biomes.slice(0, 12);
  if (zones.length > 0) {
    recipe.biomes = zones.map((zone) => {
      const center = regionCenter(zone.selector, size);
      return {
        id: zone.id.slice(0, 40),
        biome: zone.biome.slice(0, 40),
        weight: clamp(zone.weight || 1 / zones.length, 0.05, 1),
        transition: clamp(size * 0.1, 4, 200),
        ...(center ? { center, radius: clamp(size * 0.34, 6, 400) } : {}),
      };
    });
  }

  // ── Erosion and surface detail ────────────────────────────────────────────
  recipe.erosion = {
    droplets: clamp(Math.round((size * size) / 12), 900, 26000),
    iterations: clamp(Math.round(size / 6), 16, 60),
    inertia: 0.06,
    erosionRate: clamp(0.24 + roughness * 0.2, 0.05, 0.7),
    depositionRate: 0.28,
    thermalPasses: recipe.ranges || recipe.canyons || recipe.volcanoes ? 2 : 1,
    talus: 0.95,
  };
  recipe.detail = {
    amplitude: clamp(0.2 + roughness * 1.1, 0.1, 6),
    scale: clamp(size * 0.05, 3, 120),
    octaves: 3,
  };
  if (size >= 200) {
    const chunkSize = clamp(Math.round(size / 4), 16, 128);
    recipe.chunks = {
      size: chunkSize,
      lod: [
        { distance: Math.round(chunkSize * 1.6), cells: 48 },
        { distance: Math.round(chunkSize * 4), cells: 24 },
        { distance: Math.round(chunkSize * 9), cells: 12 },
        { distance: 4096, cells: 6 },
      ],
      skirt: clamp(chunkSize * 0.03, 0.6, 12),
    };
  }

  // The recipe must never be the reason a plan fails validation.
  const parsed = landscapeSchema.safeParse(recipe);
  return parsed.success ? parsed.data : undefined;
}

/** Short Arabic description of a recipe, for the generation report. */
export function describeLandscape(recipe: LandscapeSpec | undefined): string {
  if (!recipe) return 'تضاريس تحليلية كلاسيكية';
  const parts: string[] = [];
  if (recipe.ranges?.length) parts.push(`${recipe.ranges.length} سلسلة جبلية`);
  if (recipe.hills?.length) parts.push(`${recipe.hills.length} حقول تلال`);
  if (recipe.valleys?.length) parts.push(`${recipe.valleys.length} وادي`);
  if (recipe.plateaus?.length) parts.push(`${recipe.plateaus.length} هضبة`);
  if (recipe.canyons?.length) parts.push(`${recipe.canyons.length} أخدود`);
  if (recipe.volcanoes?.length) parts.push(`${recipe.volcanoes.length} بركان`);
  if (recipe.craters?.length) parts.push(`${recipe.craters.length} فوهة`);
  if (recipe.islands?.length) parts.push(`${recipe.islands.length} جزيرة`);
  if (recipe.ocean) parts.push('محيط');
  if (recipe.lakes?.length) parts.push(`${recipe.lakes.length} بحيرة`);
  if (recipe.rivers?.length) parts.push(`${recipe.rivers.length} نهر محفور`);
  if (recipe.caves?.length) parts.push(`${recipe.caves.length} كهف`);
  if (recipe.cliffs) parts.push('منحدرات صخرية');
  if (recipe.beaches) parts.push('شواطئ');
  if (recipe.biomes?.length) parts.push(`${recipe.biomes.length} بيئات مترابطة`);
  if (recipe.erosion) parts.push('تعرية');
  if (recipe.chunks) parts.push('مقاطع مع تحسين تفاصيل');
  return parts.length ? `محرك تضاريس إجرائي: ${parts.join(' · ')}` : 'محرك تضاريس إجرائي';
}
