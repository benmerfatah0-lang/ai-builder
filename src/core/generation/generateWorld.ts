import type { WorldIntent, TimeOfDay } from '../../modules/ai/types';
import type {
  BuildingObject,
  WorldEnvironment,
  WorldObject,
  WorldPlan,
} from '../world-plan/schema';
import { MAX_WORLD_OBJECTS, WORLD_PLAN_SCHEMA_VERSION } from '../world-plan/schema';
import { createId } from '../utils/id';
import { BIOME_PROFILES, SCALE_SETTINGS } from './biomes';
import { mulberry32, range, pickWeighted, type Rng } from './rng';
import { createTerrainSampler, type TerrainSampler } from './terrain';
import { createBuilding, createLantern, createRock, createTree } from '../assets/catalog';

interface TimeSettings {
  sunElevation: number;
  sunAzimuth: number;
  sunIntensity: number;
  ambientIntensity: number;
  sunColor: string;
}

const TIME_SETTINGS: Record<TimeOfDay, TimeSettings> = {
  day: {
    sunElevation: 52,
    sunAzimuth: 220,
    sunIntensity: 2.2,
    ambientIntensity: 0.55,
    sunColor: '#fff2dc',
  },
  sunset: {
    sunElevation: 12,
    sunAzimuth: 262,
    sunIntensity: 1.55,
    ambientIntensity: 0.36,
    sunColor: '#ffb066',
  },
  night: {
    sunElevation: 42,
    sunAzimuth: 200,
    sunIntensity: 0.5,
    ambientIntensity: 0.24,
    sunColor: '#bcc8ff',
  },
};

function formatSummary(intent: WorldIntent, total: number): string {
  const parts = [
    `${intent.counts.trees} trees`,
    `${intent.counts.rocks} rocks`,
    `${intent.counts.buildings} buildings`,
    `${intent.counts.lanterns} lanterns`,
  ];
  return `Generated ${total} objects · ${parts.join(' · ')}`;
}

interface PlacementOptions {
  radius: number;
  minRadius?: number;
  minSpacing: number;
  attempts?: number;
  occupied: [number, number][];
  sampler: TerrainSampler;
  waterLevel: number | null;
}

/** Rejection-sampled placement that keeps objects above water and apart. */
function findPlacement(rng: Rng, options: PlacementOptions): [number, number, number] | null {
  const {
    radius,
    minRadius = 0,
    minSpacing,
    attempts = 30,
    occupied,
    sampler,
    waterLevel,
  } = options;
  const spacingSq = minSpacing * minSpacing;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = Math.sqrt(range(rng, 0, 1)) * (radius - minRadius) + minRadius;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;

    if (Math.abs(x) > sampler.size / 2 - 2 || Math.abs(z) > sampler.size / 2 - 2) continue;

    const y = sampler.heightAt(x, z);
    if (waterLevel !== null && y < waterLevel + 0.35) continue;

    let blocked = false;
    for (const [ox, oz] of occupied) {
      const dx = ox - x;
      const dz = oz - z;
      if (dx * dx + dz * dz < spacingSq) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;

    return [x, y, z];
  }

  return null;
}

function treeVariantForBiome(intent: WorldIntent, rng: Rng) {
  switch (intent.biome) {
    case 'forest':
      return pickWeighted(rng, [
        { value: 'pine' as const, weight: 0.45 },
        { value: 'broadleaf' as const, weight: 0.55 },
      ]);
    case 'mountains':
      return pickWeighted(rng, [
        { value: 'pine' as const, weight: 0.82 },
        { value: 'broadleaf' as const, weight: 0.18 },
      ]);
    case 'desert':
      return pickWeighted(rng, [
        { value: 'cactus' as const, weight: 0.68 },
        { value: 'palm' as const, weight: 0.32 },
      ]);
    case 'island':
      return pickWeighted(rng, [
        { value: 'palm' as const, weight: 0.72 },
        { value: 'broadleaf' as const, weight: 0.28 },
      ]);
    case 'ruins':
      return pickWeighted(rng, [
        { value: 'broadleaf' as const, weight: 0.65 },
        { value: 'pine' as const, weight: 0.35 },
      ]);
    default:
      return pickWeighted(rng, [
        { value: 'broadleaf' as const, weight: 0.72 },
        { value: 'pine' as const, weight: 0.28 },
      ]);
  }
}

function displayName(object: WorldObject): string {
  switch (object.kind) {
    case 'tree':
      return object.variant === 'pine'
        ? 'Pine'
        : object.variant === 'broadleaf'
          ? 'Broadleaf'
          : object.variant === 'palm'
            ? 'Palm'
            : 'Cactus';
    case 'rock':
      return object.variant === 'crag' ? 'Crag' : 'Boulder';
    case 'building':
      return object.variant === 'tower' ? 'Tower' : object.variant === 'ruin' ? 'Ruin' : 'House';
    case 'lantern':
      return 'Lantern';
    case 'primitive':
      return object.primitive.charAt(0).toUpperCase() + object.primitive.slice(1);
    default:
      return 'Object';
  }
}

/** Renumbers object names within each archetype for a readable hierarchy. */
export function numberObjectNames(objects: WorldObject[]): WorldObject[] {
  const counters = new Map<string, number>();
  return objects.map((object) => {
    const label = displayName(object);
    const index = (counters.get(label) ?? 0) + 1;
    counters.set(label, index);
    return { ...object, name: `${label} ${index}` };
  });
}

function buildEnvironment(intent: WorldIntent): WorldEnvironment {
  const profile = BIOME_PROFILES[intent.biome];
  const time = TIME_SETTINGS[intent.timeOfDay];
  const skyColor = profile.sky[intent.timeOfDay];

  return {
    skyColor,
    fogColor: skyColor,
    fogDensity: profile.fogDensity * (intent.timeOfDay === 'night' ? 1.2 : 1),
    sunColor: time.sunColor,
    sunAzimuth: time.sunAzimuth,
    sunElevation: time.sunElevation,
    sunIntensity: time.sunIntensity,
    ambientIntensity: time.ambientIntensity,
  };
}

function buildPlanShell(intent: WorldIntent): WorldPlan {
  const profile = BIOME_PROFILES[intent.biome];
  const scale = SCALE_SETTINGS[intent.scale];
  const now = new Date().toISOString();
  const terrainStyle = profile.terrainStyle;

  return {
    schemaVersion: WORLD_PLAN_SCHEMA_VERSION,
    id: createId('world'),
    name: intent.name.slice(0, 80),
    description: `Generated from: “${intent.prompt}” (${intent.summary})`.slice(0, 500),
    seed: intent.seed,
    createdAt: now,
    updatedAt: now,
    environment: buildEnvironment(intent),
    terrain: {
      style: terrainStyle,
      size: scale.size,
      resolution: scale.resolution,
      heightScale: profile.heightScale * (intent.scale === 'large' ? 1.15 : 1),
      waterLevel: null,
      palette: { ...profile.palette },
    },
    groups: [],
    objects: [],
  };
}

/**
 * Pick a water surface that is actually visible: roughly the 18th percentile of
 * terrain height. This works across hills, mountains and dunes, unlike a fixed
 * absolute level which would sit entirely below high terrain.
 */
function computeInlandWaterLevel(sampler: TerrainSampler): number {
  const half = sampler.size * 0.46;
  const samples: number[] = [];
  const steps = 20;
  for (let ix = 0; ix <= steps; ix += 1) {
    for (let iz = 0; iz <= steps; iz += 1) {
      const x = -half + (ix / steps) * half * 2;
      const z = -half + (iz / steps) * half * 2;
      samples.push(sampler.heightAt(x, z));
    }
  }
  samples.sort((a, b) => a - b);
  const index = Math.min(samples.length - 1, Math.floor(samples.length * 0.18));
  return Math.round((samples[index] ?? 0) * 1000) / 1000;
}

/**
 * Turn an interpreted intent into a complete, deterministic WorldPlan body.
 *
 * Only document metadata (id, timestamps) is random. Terrain, placement and
 * colors are derived exclusively from the intent seed, so the same prompt and
 * seed always rebuild the same world.
 */
export function generateWorldPlan(intent: WorldIntent): WorldPlan {
  let plan = buildPlanShell(intent);
  const profile = BIOME_PROFILES[intent.biome];
  const rng = mulberry32(intent.seed);
  const sampler = createTerrainSampler(plan.terrain, intent.seed);

  if (intent.water) {
    const waterLevel =
      intent.biome === 'island' ? 0.5 : computeInlandWaterLevel(sampler);
    plan = { ...plan, terrain: { ...plan.terrain, waterLevel } };
  }

  const occupied: [number, number][] = [];
  const objects: WorldObject[] = [];
  const radius = plan.terrain.size * 0.44;
  const waterLevel = plan.terrain.waterLevel;

  const add = (object: WorldObject) => {
    if (objects.length >= MAX_WORLD_OBJECTS) return;
    objects.push(object);
    occupied.push([object.transform.position[0], object.transform.position[2]]);
  };

  // Buildings first: they are the largest objects and define the settlement core.
  const buildingVariant = (): BuildingObject['variant'] => {
    if (intent.biome === 'ruins' && !intent.settlement) {
      return pickWeighted(rng, [
        { value: 'ruin' as const, weight: 0.8 },
        { value: 'tower' as const, weight: 0.2 },
      ]);
    }
    return pickWeighted(rng, [
      { value: 'house' as const, weight: 0.78 },
      { value: 'tower' as const, weight: 0.22 },
    ]);
  };

  for (let index = 0; index < intent.counts.buildings; index += 1) {
    const position = findPlacement(rng, {
      radius: intent.settlement ? plan.terrain.size * 0.26 : radius,
      minSpacing: 8,
      occupied,
      sampler,
      waterLevel,
      attempts: 60,
    });
    if (!position) break;
    const variant = buildingVariant();
    const colors =
      variant === 'ruin'
        ? { wall: profile.buildingColors.wall, roof: profile.buildingColors.roof }
        : profile.buildingColors;
    add(createBuilding(variant, position, rng, colors));
  }

  // Lanterns near the settlement centre (or scattered at night in the wild).
  const lanternAnchor = objects.find((object) => object.kind === 'building');
  for (let index = 0; index < intent.counts.lanterns; index += 1) {
    let position: [number, number, number] | null = null;
    if (lanternAnchor) {
      const [bx, , bz] = lanternAnchor.transform.position;
      const angle = range(rng, 0, Math.PI * 2);
      const distance = range(rng, 2.5, 6);
      const x = bx + Math.cos(angle) * distance;
      const z = bz + Math.sin(angle) * distance;
      const y = sampler.heightAt(x, z);
      if (waterLevel === null || y > waterLevel + 0.35) position = [x, y, z];
    }
    if (!position) {
      position = findPlacement(rng, {
        radius: radius * 0.8,
        minSpacing: 1.5,
        occupied,
        sampler,
        waterLevel,
      });
    }
    if (!position) break;
    add(createLantern(position));
  }

  // Trees.
  for (let index = 0; index < intent.counts.trees; index += 1) {
    const position = findPlacement(rng, {
      radius,
      minSpacing: 2.6,
      occupied,
      sampler,
      waterLevel,
    });
    if (!position) break;
    add(createTree(treeVariantForBiome(intent, rng), position, rng));
  }

  // Rocks.
  for (let index = 0; index < intent.counts.rocks; index += 1) {
    const variant = rng() < 0.35 ? ('crag' as const) : ('boulder' as const);
    const position = findPlacement(rng, {
      radius,
      minSpacing: 1.9,
      occupied,
      sampler,
      waterLevel,
    });
    if (!position) break;
    add(createRock(variant, position, rng, profile.rockColor));
  }

  // Stable, seed-derived object IDs keep generated worlds diffable.
  const seedTag = intent.seed.toString(36);
  const renamed = numberObjectNames(objects).map((object, index) => ({
    ...object,
    id: `obj_${seedTag}_${index.toString(36)}`,
  }));

  return { ...plan, objects: renamed, description: `${plan.description} · ${formatSummary(intent, renamed.length)}` };
}
