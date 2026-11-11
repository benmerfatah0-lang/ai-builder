import { createTerrainSampler } from '../../core/generation/terrain';
import { createBridge, createPath } from '../../core/assets/structures';
import { makeBakedRiver, makeTerrainRiver } from '../../core/generation/villageRiver';
import { isEffectivelyLocked } from '../../core/world-plan/hierarchy';
import { MAX_WORLD_OBJECTS, type PathStyle, type Terrain, type WorldObject, type WorldPlan } from '../../core/world-plan/schema';
import { worldTransformOf } from '../../core/world-plan/hierarchy';
import { WorldLayout } from './layout';
import { pathStyleFor, type SpatialRelation, type WorldSpec } from './worldSpec';

/**
 * Realization: apply a solved `WorldSpec` to a plan the existing generators
 * already produced.
 *
 * The generators stay the only builders of geometry. This module only adds what
 * a `WorldIntent` cannot express: connector roads and bridges, lake basins,
 * weather-driven lighting and fog, architectural materials, and logical region
 * tags. It never touches a locked node or an object the user has edited, and it
 * never exceeds the document's object budget.
 */

export interface RealizeResult {
  plan: WorldPlan;
  warnings: string[];
}

type Vec3 = [number, number, number];

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const STRUCTURE_PRIMITIVES = ['castle', 'watchtower', 'lighthouse', 'shrine', 'stone-arch', 'column', 'well', 'windmill', 'gazebo', 'market-stall'];

/** Terrain-following ribbon built from planner positions, capped at 64 points. */
export function terrainPolyline(plan: WorldPlan, positions: [number, number][], style: PathStyle, region: string): WorldObject | null {
  if (positions.length < 2) return null;
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const half = plan.terrain.size / 2 - 2;
  const points = positions.filter(([x, z]) => Math.abs(x) <= half && Math.abs(z) <= half).slice(0, 64);
  if (points.length < 2) return null;
  const [originX, originZ] = points[0]!;
  const originY = sampler.heightAt(originX, originZ) + 0.06;
  const local: Vec3[] = points.map(([x, z]) => [x - originX, sampler.heightAt(x, z) + 0.06 - originY, z - originZ]);
  return createPath(local, [originX, originY, originZ], { name: 'طريق', style, width: 2.6, region: region.slice(0, 40) });
}

/**
 * Terrain, water and atmosphere only — no objects are added or repainted.
 *
 * Used by callers that place their own objects afterwards (the library/cloud
 * composer, which fetches CC0 models), so they still get the planned biome,
 * lake basin, lighting and weather without the planner touching their scene.
 */
export function applySpecToShell(plan: WorldPlan, spec: WorldSpec): RealizeResult {
  const warnings: string[] = [];
  const withLake = applyLakeBasin(plan, spec, warnings);
  return { plan: applyAtmosphere(withLake, spec), warnings };
}

export function applySpecToPlan(plan: WorldPlan, spec: WorldSpec): RealizeResult {
  const warnings: string[] = [];
  let next: WorldPlan = plan;

  // ── Landscape ─────────────────────────────────────────────────────────────
  next = applyLandscape(next, spec, warnings);

  // ── Lake basin ────────────────────────────────────────────────────────────
  next = applyLakeBasin(next, spec, warnings);

  // ── River ─────────────────────────────────────────────────────────────────
  if (spec.terrain.river && !next.objects.some((object) => object.kind === 'river') && next.objects.length < MAX_WORLD_OBJECTS) {
    // A baked landscape already carved a real channel, so the ribbon follows it;
    // otherwise the classic decorative ribbon is used, unchanged.
    const baked = makeBakedRiver(next);
    const river = baked ?? makeTerrainRiver(next, spec.terrain.river.axis, 0, -next.terrain.size * 0.36, next.terrain.size * 0.36);
    next = { ...next, objects: [...next.objects, { ...river, id: `obj_${next.seed.toString(36)}_pl_river` }] };
    warnings.push(baked
      ? 'النهر محفور في التضاريس ويتبع مسار تصريف حقيقياً نحو المصب؛ لا يطفو فوق الأرض ولا يخترق المباني.'
      : 'النهر شريط زخرفي يتبع التضاريس؛ لا يحفر مجرى ولا يحاكي تدفق الماء.');
  }

  // ── Connector roads and bridges ───────────────────────────────────────────
  const style = pathStyleFor(spec.materials, next.terrain.style);
  const added: WorldObject[] = [];
  for (const relation of spec.relations) {
    if (relation.status !== 'resolved') continue;
    if (next.objects.length + added.length >= MAX_WORLD_OBJECTS) {
      warnings.push('بلغ العالم سعة المستند؛ لم تُضف بقية الوصلات.');
      break;
    }
    const via = relation.via ?? '';
    if (relation.predicate === 'connected-by' && /طريق|ممر|road|path|trail|lane/i.test(via)) {
      // Prefer where the generator actually put the subject's objects; the
      // pre-generation positions are only a fallback.
      const positions = actualSubjectPositions(next, relation, spec);
      const chained = positions.length > 2 ? new WorldLayout(next.terrain, next.seed, spec.terrain.lake).chain(positions).polyline : positions;
      const path = terrainPolyline(next, chained.length >= 2 ? chained : relation.polyline ?? relation.resolved ?? [], style, relation.subjectId);
      if (path) added.push({ ...path, id: `obj_${next.seed.toString(36)}_pl_road${added.length}`, name: `طريق ${added.length + 1}` });
      else warnings.push(`تعذّر مدّ طريق لـ«${relation.subject}»: لا توجد مواقع فعلية داخل حدود التضاريس.`);
    }
    if (/جسر|bridge/i.test(via) && !next.objects.some((object) => object.kind === 'bridge')) {
      const positions = relation.resolved ?? relation.polyline ?? [];
      const middle = positions[Math.floor(positions.length / 2)];
      // `validateScenePlan` treats a bridge with no river as a hard error, so the
      // planner must not build one unless something is actually there to cross.
      if (middle && !next.objects.some((object) => object.kind === 'river')) {
        warnings.push(`طلبت «${relation.via}» جسراً لكن لا يوجد نهر في المشهد؛ لم يُبنَ الجسر.`);
      } else if (middle) {
        const sampler = createTerrainSampler(next.terrain, next.seed);
        const y = sampler.heightAt(middle[0], middle[1]);
        added.push({
          ...createBridge(9, [middle[0], y, middle[1]], { name: 'جسر', rotationY: 90 }),
          id: `obj_${next.seed.toString(36)}_pl_bridge${added.length}`,
        });
      }
    }
  }

  // ── Architectural materials ───────────────────────────────────────────────
  const materials = spec.materials;
  const wantsMaterial = Boolean(materials.wall || materials.roof || materials.roughness !== undefined || materials.metalness !== undefined);
  const withMaterials = [...next.objects, ...added].map((object): WorldObject => {
    if (!wantsMaterial) return object;
    if (object.meta.status === 'edited' || isEffectivelyLocked(next, object.id)) return object;
    const material = materials.roughness !== undefined || materials.metalness !== undefined
      ? {
        ...(materials.roughness !== undefined ? { roughness: clamp(materials.roughness, 0, 1) } : {}),
        ...(materials.metalness !== undefined ? { metalness: clamp(materials.metalness, 0, 1) } : {}),
      }
      : object.material;
    if (object.kind === 'building' && materials.wall && materials.roof) {
      return { ...object, color: materials.wall, roofColor: materials.roof, ...(material ? { material } : {}) };
    }
    if (object.kind === 'primitive' && STRUCTURE_PRIMITIVES.includes(object.primitive) && materials.wall) {
      return { ...object, color: materials.wall, ...(material ? { material } : {}) };
    }
    return material ? { ...object, material } : object;
  });

  // ── Logical region tags ───────────────────────────────────────────────────
  const tagged = tagRegions(withMaterials, next, spec);

  // ── Environment and lighting ──────────────────────────────────────────────
  next = applyAtmosphere({ ...next, objects: tagged }, spec);

  // ── Reporting ─────────────────────────────────────────────────────────────
  if (spec.animals.length) {
    warnings.push(`الحيوانات المذكورة (${spec.animals.map((animal) => `${animal.label} ×${animal.count}`).join('، ')}) موثّقة في المواصفات، ولا يوجد باني إجرائي محلي لها بعد؛ لم تُوضع في المشهد.`);
  }
  for (const relation of spec.relations) {
    if (relation.status === 'unsupported') warnings.push(`لم تُحل العلاقة «${relation.subject} → ${relation.object}»${relation.note ? `: ${relation.note}` : ''}.`);
  }
  for (const building of spec.buildings) {
    if (building.realized === 'unrealized') warnings.push(`«${building.label}» معرّف في المواصفات لكن لا يوجد باني محلي له؛ لم يُوضع.`);
  }

  return { plan: next, warnings };
}

/**
 * Attaches the planned landscape recipe to the terrain.
 *
 * A recipe holds absolute coordinates, so it is only applied to the terrain it
 * was derived for; if the plan's size changed in the meantime the world keeps
 * the classic surface and says so, rather than baking landforms in the wrong
 * place. When the recipe asks for an ocean and the plan has no water level, the
 * engine is asked what level the baked ground implies.
 */
export function applyLandscape(plan: WorldPlan, spec: WorldSpec, warnings: string[]): WorldPlan {
  const recipe = spec.terrain.landscape;
  if (!recipe) return plan;
  if (Math.abs(plan.terrain.size - spec.dimensions.size) > 1) {
    warnings.push('تغيّر حجم التضاريس بعد حلّ المواصفة؛ أبقيت التضاريس الكلاسيكية لأن وصفة المحرك تستخدم إحداثيات مطلقة.');
    return plan;
  }
  const terrain: Terrain = { ...plan.terrain, landscape: recipe };
  if (terrain.waterLevel === null && recipe.ocean) {
    const suggested = createTerrainSampler(terrain, plan.seed).landscape?.suggestedWaterLevel ?? null;
    if (suggested !== null && Number.isFinite(suggested)) terrain.waterLevel = clamp(suggested, -200, 200);
    else warnings.push('طلبت محيطاً لكن لم يُشتق مستوى ماء؛ بقيت اليابسة دون غمر.');
  }
  return { ...plan, terrain };
}

/** Adds the planned lake basin, spreading the existing terrain so no field is lost. */
function applyLakeBasin(plan: WorldPlan, spec: WorldSpec, warnings: string[]): WorldPlan {
  const lake = spec.terrain.lake;
  if (!lake || plan.terrain.lakeBasin) return plan;
  const waterLevel = plan.terrain.waterLevel ?? (plan.terrain.style === 'flat' ? -0.35 : null);
  if (waterLevel === null) warnings.push('طلبتَ بحيرة لكن التضاريس لا تحمل مستوى ماء؛ أُضيف حوض البحيرة دون غمر الخريطة.');
  // Spread the existing terrain first so every present (and future) field
  // survives. Rebuilding terrain field-by-field is what silently dropped
  // `lakeBasin` in the editor reducer.
  return {
    ...plan,
    terrain: {
      ...plan.terrain,
      waterLevel,
      lakeBasin: {
        x: clamp(lake.x, -256, 256),
        z: clamp(lake.z, -256, 256),
        radius: clamp(lake.radius, 1, 256),
        depth: clamp(lake.depth, 0.1, 50),
      },
    },
  };
}

/** Scales light and applies sky, fog and sun angles, always inside the schema range. */
function applyAtmosphere(plan: WorldPlan, spec: WorldSpec): WorldPlan {
  const environment = { ...plan.environment };
  const lighting = spec.lighting;
  environment.sunIntensity = clamp(environment.sunIntensity * lighting.sunIntensityScale, 0, 4);
  environment.ambientIntensity = clamp(environment.ambientIntensity * lighting.ambientIntensityScale, 0, 3);
  if (lighting.sunElevation !== undefined) environment.sunElevation = clamp(lighting.sunElevation, 0, 90);
  if (lighting.sunAzimuth !== undefined) environment.sunAzimuth = clamp(((lighting.sunAzimuth % 360) + 360) % 360, 0, 360);
  if (lighting.sunColor) environment.sunColor = lighting.sunColor;
  if (spec.environment.skyColor) environment.skyColor = spec.environment.skyColor;
  if (spec.environment.fogColor) environment.fogColor = spec.environment.fogColor;
  if (spec.environment.fogDensity !== undefined) environment.fogDensity = clamp(spec.environment.fogDensity, 0, 1);
  return { ...plan, environment };
}

interface RegionBounds {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Where the subject of a relation actually ended up in the generated plan.
 *
 * The planner resolves positions before generation, but the generators may move
 * an object to the nearest dry, unoccupied spot. Connector roads must follow the
 * real result, so this reads the plan back — by region tag first, then by object
 * kind — and only falls back to the planned positions.
 */
function actualSubjectPositions(plan: WorldPlan, relation: SpatialRelation, spec: WorldSpec): [number, number][] {
  const regionId = spec.buildings.find((building) => building.id === relation.subjectId)?.region ??
    spec.assets.find((asset) => asset.id === relation.subjectId)?.region;
  const kindHint = spec.buildings.find((building) => building.id === relation.subjectId)?.kind;
  const wanted = new Set(
    [...spec.buildings, ...spec.assets]
      .filter((entry) => entry.id === relation.subjectId)
      .map((entry) => entry.assetId),
  );
  const matches = plan.objects.filter((object) => {
    if (object.meta.status === 'edited') return true;
    if (regionId && object.meta.region === regionId) return true;
    if (object.kind === 'building' && kindHint === 'house') return true;
    if (object.kind === 'primitive' && wanted.has(object.primitive)) return true;
    return false;
  });
  const positions = matches
    .map((object) => {
      const transform = worldTransformOf(plan, object.id) ?? object.transform;
      return [transform.position[0], transform.position[2]] as [number, number];
    })
    .filter(([x, z]) => Number.isFinite(x) && Number.isFinite(z));
  return positions.length >= 2 ? positions : relation.resolved ?? [];
}

/** Assigns `meta.region` to generated objects that fall inside a named region. */
function tagRegions(objects: WorldObject[], plan: WorldPlan, spec: WorldSpec): WorldObject[] {
  const regions = spec.regions.filter((region) => region.selector);
  if (!regions.length) return objects;
  const half = plan.terrain.size / 2;
  const bounds: RegionBounds[] = regions.map((region) => {
    switch (region.selector) {
      case 'north': return { id: region.id, minX: -half, maxX: half, minZ: -half, maxZ: -half * 0.2 };
      case 'south': return { id: region.id, minX: -half, maxX: half, minZ: half * 0.2, maxZ: half };
      case 'west': return { id: region.id, minX: -half, maxX: -half * 0.2, minZ: -half, maxZ: half };
      case 'east': return { id: region.id, minX: half * 0.2, maxX: half, minZ: -half, maxZ: half };
      case 'edge': return { id: region.id, minX: -half, maxX: half, minZ: -half, maxZ: half };
      default: {
        const inner = half * 0.5;
        return { id: region.id, minX: -inner, maxX: inner, minZ: -inner, maxZ: inner };
      }
    }
  });
  return objects.map((object): WorldObject => {
    if (object.meta.region || object.meta.status === 'edited') return object;
    const [x, , z] = object.transform.position;
    const hit = bounds.find((area) => x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ);
    return hit ? { ...object, meta: { ...object.meta, region: hit.id.slice(0, 40) } } : object;
  });
}
