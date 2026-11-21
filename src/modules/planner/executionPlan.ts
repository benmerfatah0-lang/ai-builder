import { ASSET_LIBRARY } from '../../core/assets/catalog';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import type { ExecutionPlan, GenerationStep, WorldSpec } from './worldSpec';
import { labelFor } from './lexicon';
import { materialLabel, terrainLabel, timeLabel } from './specSummary';

/**
 * The execution plan.
 *
 * The planner always produces a complete, ordered, dependency-checked plan
 * *before* any world generation runs: nothing is created until `preflight.ok`
 * is true and the topological order is acyclic. Each step names the producer
 * that will run it, so the executor in `planner.ts` is a thin interpreter over
 * this list and the existing generators stay the only things that build geometry.
 */

/** Reserved for connector objects (roads, bridges, river ribbons). */
const RELATION_RESERVE = 48;
/** Reserved for water ribbons and basins added after the scatter. */
const WATER_RESERVE = 4;

export function buildSteps(spec: WorldSpec): GenerationStep[] {
  const requested = countRequested(spec);
  // Every step's budget is carved out of one pot, so the plan can never commit
  // to more objects than the document may hold.
  const available = Math.max(0, MAX_WORLD_OBJECTS - RELATION_RESERVE - WATER_RESERVE);
  const landmarkBudget = Math.min(60, spec.buildings.filter((building) => building.count <= 4).length * 4 + 12);
  const buildingBudget = Math.min(available - landmarkBudget, spec.buildings.reduce((sum, building) => sum + building.count, 0));
  const assetBudget = Math.min(available - landmarkBudget - buildingBudget, spec.assets.reduce((sum, asset) => sum + asset.count, 0));
  const vegetationBudget = Math.max(0, available - landmarkBudget - buildingBudget - assetBudget);

  return [
    step('validate-input', 'التحقق من الوصف والمواصفات', 'validate', [], { objects: 0 }, `${spec.cues.length} إشارة مفهومة · ${spec.relations.length} علاقة مكانية`),
    step('resolve-terrain', 'تكوين التضاريس والماء', 'terrain', ['validate-input'], { objects: 0 }, `${terrainLabel(spec.terrain.style)} · مقاس ${spec.dimensions.size} · ارتفاع ${spec.terrain.heightScale}`),
    step('resolve-biomes', 'توزيع البيئات', 'biomes', ['resolve-terrain'], { objects: 0 }, spec.biomes.map((zone) => `${labelFor(zone.biome)} ${(zone.weight * 100).toFixed(0)}%`).join('، ')),
    step('resolve-regions', 'تحديد المناطق', 'regions', ['resolve-biomes'], { objects: 0 }, `${spec.regions.length} منطقة`),
    step('resolve-positions', 'حل العلاقات المكانية إلى إحداثيات', 'relations', ['resolve-regions'], { objects: 0 }, `${spec.relations.filter((relation) => relation.status === 'resolved').length} علاقة محلولة`),
    step('place-landmarks', 'وضع المعالم الكبرى', 'landmarks', ['resolve-positions'], { objects: landmarkBudget }, spec.buildings.filter((building) => building.count <= 4).map((building) => building.label).join('، ') || '—'),
    step('place-buildings', 'وضع المباني والمستوطنات', 'buildings', ['place-landmarks'], { objects: buildingBudget }, `${spec.buildings.reduce((sum, building) => sum + building.count, 0)} مبنى`),
    step('place-assets', 'وضع العناصر المحددة', 'assets', ['place-buildings'], { objects: assetBudget }, `${spec.assets.reduce((sum, asset) => sum + asset.count, 0)} عنصر`),
    step('place-vegetation', 'نثر النباتات والصخور', 'vegetation', ['place-assets'], { objects: vegetationBudget }, `أشجار ${spec.counts.trees} · صخور ${spec.counts.rocks}`),
    step('connect-paths', 'ربط المواقع بالطرق والجسور', 'paths', ['place-buildings', 'resolve-positions'], { objects: RELATION_RESERVE }, `${spec.relations.filter((relation) => relation.predicate === 'connected-by' || relation.predicate === 'across').length} وصلة`),
    step('add-water', 'إضافة الأنهار والبحيرات', 'water', ['resolve-terrain', 'resolve-positions'], { objects: WATER_RESERVE }, spec.terrain.river ? 'نهر' : spec.terrain.lake ? 'بحيرة' : '—'),
    step('apply-materials', 'تطبيق المواد والألوان', 'materials', ['place-assets'], { objects: 0 }, materialLabel(spec.materials.palette)),
    step('apply-lighting', 'ضبط الإضاءة والشمس', 'lighting', ['resolve-biomes'], { objects: 0 }, [timeLabel(spec.lighting.timeOfDay), spec.lighting.sunElevation !== undefined ? `ارتفاع ${spec.lighting.sunElevation}°` : ''].filter(Boolean).join(' · ')),
    step('apply-environment', 'ضبط السماء والضباب والجو', 'environment', ['apply-lighting'], { objects: 0 }, spec.environment.weather.map(labelFor).join('، ') || 'صافٍ'),
    step('validate-scene', 'التحقق الدلالي من المشهد', 'validate', ['place-vegetation', 'connect-paths', 'add-water', 'apply-materials', 'apply-environment'], { objects: 0 }, 'أخطاء تمنع البناء · تحذيرات لا تمنعه'),
    step('report', 'تقرير التنفيذ', 'report', ['validate-scene'], { objects: 0 }, `${requested} عنصر مطلوب`),
  ];
}

function step(
  id: string,
  title: string,
  producer: GenerationStep['producer'],
  dependsOn: string[],
  budget: { objects: number },
  detail: string,
): GenerationStep {
  return { id, title, producer, dependsOn, budget, status: 'pending', detail };
}

/** Kahn's algorithm; returns the order and any nodes left in a cycle. */
export function topologicalOrder(steps: GenerationStep[]): { order: string[]; cycle: string[] } {
  const ids = new Set(steps.map((entry) => entry.id));
  const incoming = new Map(steps.map((entry) => [entry.id, entry.dependsOn.filter((id) => ids.has(id)).length]));
  const dependents = new Map<string, string[]>();
  for (const entry of steps) {
    for (const dependency of entry.dependsOn) {
      if (!ids.has(dependency)) continue;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), entry.id]);
    }
  }
  const ready = steps.filter((entry) => (incoming.get(entry.id) ?? 0) === 0).map((entry) => entry.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const left = (incoming.get(dependent) ?? 1) - 1;
      incoming.set(dependent, left);
      if (left === 0) ready.push(dependent);
    }
  }
  return { order, cycle: steps.map((entry) => entry.id).filter((id) => !order.includes(id)) };
}

export interface PreflightInput {
  spec: WorldSpec;
  /** Blocking clarifications the user has not answered. */
  unanswered: string[];
}

export function preflight({ spec, unanswered }: PreflightInput): { ok: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const known = new Set(ASSET_LIBRARY.map((asset) => asset.id));

  if (spec.dimensions.size < 32 || spec.dimensions.size > 512) errors.push(`مقاس العالم ${spec.dimensions.size} خارج الحد المسموح (32–512).`);
  if (!Number.isInteger(spec.dimensions.resolution) || spec.dimensions.resolution < 16 || spec.dimensions.resolution > 256) {
    errors.push(`دقة التضاريس ${spec.dimensions.resolution} خارج الحد المسموح (16–256).`);
  }
  if (unanswered.length) errors.push(`توجد ${unanswered.length} أسئلة حاجبة بلا إجابة؛ لا يمكن البناء قبل حسمها.`);

  for (const building of spec.buildings) {
    if (building.realized === 'unrealized') warnings.push(`«${building.label}» معرّف في المواصفات لكن لا يوجد باني محلي له.`);
    else if (!known.has(building.assetId)) errors.push(`الأصل «${building.assetId}» غير موجود في المكتبة المحلية.`);
  }
  for (const asset of spec.assets) {
    if (asset.realized === 'unrealized') continue;
    if (!known.has(asset.assetId)) errors.push(`الأصل «${asset.assetId}» غير موجود في المكتبة المحلية.`);
  }
  for (const animal of spec.animals) warnings.push(animal.notice);

  const requested = countRequested(spec);
  if (requested > MAX_WORLD_OBJECTS) warnings.push(`الطلب (${requested}) يتجاوز سعة المستند (${MAX_WORLD_OBJECTS})؛ سيُقلم تلقائياً.`);
  for (const relation of spec.relations) {
    if (relation.status === 'unsupported') warnings.push(`العلاقة «${relation.subject} ${relation.predicate} ${relation.object}» لم تُحل: ${relation.note ?? 'مرجع مفقود'}.`);
  }
  if (spec.terrain.river && spec.terrain.waterLevel === null && !spec.terrain.lake) {
    warnings.push('نهر بلا مستوى ماء عام؛ سيظهر كشريط زخرفي يتبع التضاريس.');
  }

  const { cycle } = topologicalOrder(spec.execution.steps);
  if (cycle.length) errors.push(`خطة التنفيذ تحتوي دورة اعتماد: ${cycle.join(' ← ')}.`);

  return { ok: errors.length === 0, errors, warnings };
}

const TREE_ASSETS = ['tree', 'pine', 'palm', 'broadleaf', 'cactus', 'bush'];
const ROCK_ASSETS = ['boulder', 'crag', 'rock'];
const HOUSE_KINDS = ['house', 'tower', 'ruin', 'castle', 'barn', 'coop'];

/**
 * Total objects the description asks for, before clamping.
 *
 * Matches how the generators actually spend the budget: when explicit assets
 * cover a category, `addLandscapeBackground` skips that category's scatter
 * counts, so counting both would over-estimate and clamp too early.
 */
/**
 * How many objects each scatter counter will really add.
 *
 * A counter covered by explicit assets adds nothing: `addLandscapeBackground`
 * skips a category the requests already provide. The budget solver uses this so
 * it never "saves" room by cutting a counter that was already free.
 */
export function scatterContribution(spec: WorldSpec): { trees: number; rocks: number; buildings: number; lanterns: number } {
  const covers = (ids: string[]) => spec.assets.some((asset) => ids.includes(asset.assetId));
  return {
    trees: covers(TREE_ASSETS) ? 0 : spec.counts.trees,
    rocks: covers(ROCK_ASSETS) ? 0 : spec.counts.rocks,
    buildings: spec.buildings.some((building) => HOUSE_KINDS.includes(building.kind)) ? 0 : spec.counts.buildings,
    lanterns: covers(['lantern']) ? 0 : spec.counts.lanterns,
  };
}

export function countRequested(spec: WorldSpec): number {
  const explicit = spec.assets.reduce((sum, asset) => sum + asset.count, 0) +
    spec.buildings.reduce((sum, building) => sum + building.count, 0);
  const scatter = scatterContribution(spec);
  return explicit + scatter.trees + scatter.rocks + scatter.buildings + scatter.lanterns;
}

export function buildExecutionPlan(spec: WorldSpec, unanswered: string[] = []): ExecutionPlan {
  const steps = spec.execution.steps.length ? spec.execution.steps : buildSteps(spec);
  const { order } = topologicalOrder(steps);
  const requested = countRequested(spec);
  const budgets = {
    maxObjects: MAX_WORLD_OBJECTS,
    reservedForRelations: RELATION_RESERVE,
    estimatedObjects: Math.min(requested, MAX_WORLD_OBJECTS),
  };
  const checks = preflight({ spec, unanswered });
  return { steps, order, budgets, preflight: checks };
}

/** Marks a step as executed; returns a new plan (never mutates). */
export function advance(plan: ExecutionPlan, id: string, status: 'done' | 'skipped', detail?: string): ExecutionPlan {
  return {
    ...plan,
    steps: plan.steps.map((entry) => (entry.id === id ? { ...entry, status, ...(detail ? { detail } : {}) } : entry)),
  };
}
