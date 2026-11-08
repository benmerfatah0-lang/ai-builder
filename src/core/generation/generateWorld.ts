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
import { makeTerrainRiver } from './villageRiver';
import { generateFarmPlan } from './farm';
import { buildAssetLayout } from './assetLayout';
import { footprintFromObject, footprintFromRect, PlacementLedger } from './placement';
import { validateScenePlan, type SceneValidation } from '../world-plan/validateScene';

interface TimeSettings {
  sunElevation: number;
  sunAzimuth: number;
  sunIntensity: number;
  ambientIntensity: number;
  sunColor: string;
}

const TIME_SETTINGS: Record<TimeOfDay, TimeSettings> = {
  // Physical light units (three r155+): ~1.0 directional + modest hemisphere
  // ambient is full daylight. Brighter values bleach the terrain palette.
  day: {
    sunElevation: 52,
    sunAzimuth: 220,
    sunIntensity: 1.15,
    ambientIntensity: 0.32,
    sunColor: '#fff2dc',
  },
  sunset: {
    sunElevation: 12,
    sunAzimuth: 262,
    sunIntensity: 1.0,
    ambientIntensity: 0.26,
    sunColor: '#ffb066',
  },
  night: {
    sunElevation: 42,
    sunAzimuth: 200,
    sunIntensity: 0.4,
    ambientIntensity: 0.2,
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
  avoidRiver?: boolean;
  side?: -1 | 1;
  ledger?: PlacementLedger;
  footprintSize?: number;
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
    avoidRiver,
    side,
    ledger,
    footprintSize = minSpacing,
  } = options;
  const spacingSq = minSpacing * minSpacing;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = Math.sqrt(range(rng, 0, 1)) * (radius - minRadius) + minRadius;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;

    if ((avoidRiver && Math.abs(x) < 7) || (side && x * side < 7)) continue;
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
    if (blocked || (ledger && !ledger.isFree(footprintFromRect(x, z, footprintSize, footprintSize), 0.5))) continue;

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
            : object.variant === 'bush' ? 'Bush' : 'Cactus';
    case 'rock':
      return object.variant === 'crag' ? 'Crag' : 'Boulder';
    case 'building':
      return object.variant === 'tower' ? 'Tower' : object.variant === 'ruin' ? 'Ruin' : 'House';
    case 'lantern':
      return 'Lantern';
    case 'river':
      return 'Village river';
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
  const terrainStyle = intent.mountainousForest ? 'mountains' : profile.terrainStyle;

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
      heightScale: (intent.mountainousForest ? BIOME_PROFILES.mountains.heightScale : profile.heightScale) * (intent.scale === 'large' ? 1.15 : 1),
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
export interface GenerationReport {
  plan: WorldPlan;
  /** Non-fatal notes from generator steps that had to skip work. */
  warnings: string[];
  validation: SceneValidation;
}

/**
 * Generation entry point with diagnostics.
 *
 * Farm prompts run the structured layout generator; everything else keeps using
 * the original scatter generator. Both results are validated before they reach
 * the editor, so callers can show warnings without blocking the build.
 */
export function generateWorldPlanWithReport(intent: WorldIntent): GenerationReport {
  if (intent.features?.farm) {
    const farm = generateFarmPlan(intent);
    const validation = validateScenePlan(farm.plan);
    return {
      plan: farm.plan,
      warnings: [...farm.warnings, ...(intent.villageRiver ? ['نهر المزرعة ليس مضموناً أن يمر وسط القرية في قالب المزرعة.'] : []), ...validation.warnings.map((issue) => issue.message)],
      validation,
    };
  }

  if (intent.assets?.length) {
    const shell = generateWorldPlanScatter({ ...intent, river: false, villageRiver: false,
      settlement: false, counts: { trees: 0, rocks: 0, buildings: 0, lanterns: 0 } });
    const result = buildAssetLayout(shell, intent, intent.assets);
    const warnings = [...result.warnings];
    if (intent.river) {
      const river = makeTerrainRiver(result.plan, 'z', 0, -shell.terrain.size * .36, shell.terrain.size * .36);
      // The central strip was reserved before placing the named objects.
      if (shell.terrain.waterLevel === null || river.points.every((p) => p[1] + river.transform.position[1] > shell.terrain.waterLevel! + .2)) {
        result.plan.objects.push({ ...river, id: `obj_${intent.seed.toString(36)}_river` });
        warnings.push('النهر سطح زخرفي يتبع التضاريس؛ لا يحفر مجرى ولا يحاكي تدفق الماء.');
        if (intent.villageRiver) warnings.push('لم يُضمن مرور النهر وسط تجمع البيوت عند تحديد عناصر مستقلة.');
      } else warnings.push('تعذّر إضافة النهر فوق سطح الماء الآخر.');
    }
    if (intent.landscape) addLandscapeBackground(result.plan, intent, warnings);
    const validation = validateScenePlan(result.plan);
    return { plan: result.plan, warnings: [...warnings, ...validation.warnings.map((issue) => issue.message)], validation };
  }

  const plan = generateWorldPlanScatter(intent);
  const validation = validateScenePlan(plan);
  const actual = {
    trees: plan.objects.filter((object) => object.kind === 'tree').length,
    rocks: plan.objects.filter((object) => object.kind === 'rock').length,
    buildings: plan.objects.filter((object) => object.kind === 'building').length,
    lanterns: plan.objects.filter((object) => object.kind === 'lantern').length,
  };
  const placementWarnings = (Object.keys(actual) as (keyof typeof actual)[])
    .filter((key) => actual[key] < intent.counts[key])
    .map((key) => `وُضع ${actual[key]} من ${intent.counts[key]} ${key} بسبب المساحة أو الماء.`);
  return {
    plan,
    warnings: [...placementWarnings, ...(intent.river && !plan.objects.some((o) => o.kind === 'river') ? ['تعذّر إضافة النهر: ربما لم تتوفر بيوت على جانبيه أو غمر مستوى الماء مساره.'] : []), ...(intent.river && plan.objects.some((o) => o.kind === 'river') ? ['النهر سطح زخرفي فوق التضاريس، لا يحفر مجرى ولا يحاكي تدفق الماء.'] : []), ...validation.warnings.map((issue) => issue.message)],
    validation,
  };
}

export function generateWorldPlan(intent: WorldIntent): WorldPlan {
  return generateWorldPlanWithReport(intent).plan;
}

/** Populate the named biome after explicit objects, never adding a second copy
 * of a requested category. All candidates are checked against existing footprints. */
function addLandscapeBackground(plan: WorldPlan, intent: WorldIntent, warnings: string[]): void {
  const requested = new Set(intent.assets?.map((request) => request.assetId));
  const hasTrees = ['tree','pine','palm','broadleaf','cactus'].some((id) => requested.has(id));
  const hasRocks = ['boulder','crag'].some((id) => requested.has(id));
  const hasBuildings = ['house','tower','ruin'].some((id) => requested.has(id));
  const rng = mulberry32((intent.seed ^ 0x9e3779b9) >>> 0);
  const sampler = createTerrainSampler(plan.terrain, intent.seed);
  const ledger = new PlacementLedger();
  for (const object of plan.objects) {
    if (object.kind === 'river' || object.kind === 'path') continue;
    const box = footprintFromObject(object);
    if (box) ledger.add(box, object.name);
  }
  const profile = BIOME_PROFILES[intent.biome];
  const place = (count: number, factory: (position: [number, number, number]) => WorldObject) => {
    let placed = 0;
    for (let index = 0; index < count && plan.objects.length < MAX_WORLD_OBJECTS; index++) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const angle = range(rng, 0, Math.PI * 2), distance = Math.sqrt(rng()) * plan.terrain.size * .44;
        const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
        if (intent.river && Math.abs(x) < 9) continue;
        const y = sampler.heightAt(x,z);
        if (plan.terrain.waterLevel !== null && y < plan.terrain.waterLevel + .35) continue;
        const object = factory([x,y,z]);
        const box = footprintFromObject(object);
        if (box && !ledger.isFree(box, .75)) continue;
        if (box) ledger.add(box, object.name);
        plan.objects.push({ ...object, name: `${displayName(object)} background ${plan.objects.length + 1}`, id: `obj_${intent.seed.toString(36)}_bg_${plan.objects.length.toString(36)}` });
        placed++;
        break;
      }
    }
    return placed;
  };
  // Buildings are intentionally only added for settlements, not a lone house in a forest.
  const tasks: [number, (position: [number, number, number]) => WorldObject][] = [
    [hasBuildings || !intent.settlement ? 0 : intent.counts.buildings, (pos) => createBuilding('house', pos, rng, profile.buildingColors)],
    [hasTrees ? 0 : intent.counts.trees, (pos) => createTree(treeVariantForBiome(intent,rng), pos, rng)],
    [hasRocks ? 0 : intent.counts.rocks, (pos) => createRock(rng() < .35 ? 'crag' : 'boulder', pos, rng, profile.rockColor)],
    [requested.has('lantern') ? 0 : intent.counts.lanterns, (pos) => createLantern(pos)],
  ];
  for (const [count, factory] of tasks) {
    const placed = place(count, factory);
    if (placed < count) warnings.push(`وُضع ${placed} من ${count} عناصر الخلفية بسبب المساحة أو الماء.`);
  }
}

function generateWorldPlanScatter(intent: WorldIntent): WorldPlan {
  let plan = buildPlanShell(intent);
  const profile = BIOME_PROFILES[intent.biome];
  const reserveRiver = Boolean(intent.river && (!intent.villageRiver || intent.counts.buildings >= 2));
  const rng = mulberry32(intent.seed);
  const sampler = createTerrainSampler(plan.terrain, intent.seed);

  if (intent.water) {
    const waterLevel =
      intent.biome === 'island' ? 0.5 : computeInlandWaterLevel(sampler);
    plan = { ...plan, terrain: { ...plan.terrain, waterLevel } };
  }

  const occupied: [number, number][] = [];
  const ledger = new PlacementLedger();
  const objects: WorldObject[] = [];
  const radius = plan.terrain.size * 0.44;
  const waterLevel = plan.terrain.waterLevel;

  const add = (object: WorldObject) => {
    if (objects.length >= MAX_WORLD_OBJECTS) return;
    objects.push(object);
    const footprint = footprintFromObject(object);
    if (footprint) ledger.add(footprint, object.name);
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
      footprintSize: 9, ledger,
      occupied,
      sampler,
      waterLevel,
      attempts: reserveRiver ? 100 : 60,
      avoidRiver: reserveRiver,
      ...(reserveRiver && intent.villageRiver ? { side: (index % 2 ? 1 : -1) as -1 | 1 } : {}),
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
      if ((!reserveRiver || Math.abs(x) >= 7) && ledger.isFree(footprintFromRect(x, z, 1.5, 1.5), .5) && (waterLevel === null || y > waterLevel + 0.35)) position = [x, y, z];
    }
    if (!position) {
      position = findPlacement(rng, {
        radius: radius * 0.8,
        minSpacing: 1.5,
        footprintSize: 1.5, ledger,
        occupied,
        sampler,
        waterLevel,
        avoidRiver: reserveRiver,
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
      footprintSize: 4.5, ledger,
      occupied,
      sampler,
      waterLevel,
      avoidRiver: reserveRiver,
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
      footprintSize: 5, ledger,
      occupied,
      sampler,
      waterLevel,
      avoidRiver: reserveRiver,
    });
    if (!position) break;
    add(createRock(variant, position, rng, profile.rockColor));
  }

  if (reserveRiver && (!intent.villageRiver || (objects.some((o) => o.kind === 'building' && o.transform.position[0] < 0) && objects.some((o) => o.kind === 'building' && o.transform.position[0] > 0))) && objects.length < MAX_WORLD_OBJECTS) {
    const river = makeTerrainRiver(plan, 'z', 0, -plan.terrain.size * 0.32, plan.terrain.size * 0.32);
    const level = plan.terrain.waterLevel;
    if (level === null || river.points.every((p) => p[1] + river.transform.position[1] > level + .2)) objects.push(river);
  }

  // Stable, seed-derived object IDs keep generated worlds diffable.
  const seedTag = intent.seed.toString(36);
  const renamed = numberObjectNames(objects).map((object, index) => ({
    ...object,
    id: `obj_${seedTag}_${index.toString(36)}`,
  }));

  return { ...plan, objects: renamed, description: `${plan.description} · ${formatSummary(intent, renamed.length)}` };
}
