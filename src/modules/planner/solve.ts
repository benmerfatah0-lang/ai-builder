import { BASE_COUNTS, BIOME_PROFILES, SCALE_SETTINGS } from '../../core/generation/biomes';
import { ASSET_LIBRARY } from '../../core/assets/catalog';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { labelFor } from './lexicon';
import { detectContradictions, resolveWithAnswers, type ClarificationAnswers } from './contradictions';
import { buildExecutionPlan, buildSteps, countRequested, scatterContribution } from './executionPlan';
import type { Frames, MentionFrame } from './frames';
import type { PromptInterpretation, WorldIntent } from '../ai/types';
import type { AssetRequest } from '../ai/assetRequests';
import type {
  AnimalSpec, AssetSpec, BiomeZone, BuildingKind, BuildingSpec, EnvironmentSpec, LightingSpec,
  MaterialSpec, NegationSpec, PlacementSpec, RegionSpec, SpatialRelation, TerrainConfig, WorldSpec,
} from './worldSpec';
import { WORLD_SPEC_VERSION } from './worldSpec';

/**
 * The constraint solver: frames → structured `WorldSpec`.
 *
 * Tier 0 (`interpretPromptLocally`) stays authoritative for everything it
 * already understands — biome, time of day, farm features, river, spelling
 * corrections, seed. The solver then *adds* what the legacy interpreter cannot
 * express: regions, spatial relations, architecture and materials, weather,
 * animals, explicit large counts, negations applied to terrain as well as
 * objects, and the execution plan.
 *
 * Deterministic: the same description, seed and answers always produce the same
 * spec.
 */

const KNOWN_ASSETS = new Set(ASSET_LIBRARY.map((asset) => asset.id));

/**
 * Legacy aliases that collide with a material word: "stone houses" must not add
 * a boulder next to the houses it already describes.
 */
const MATERIAL_COLLISIONS: Record<string, string[]> = {
  boulder: ['stone-mat'],
};

/** Objects per settlement word when the description gives no number. */
const SETTLEMENT_HOUSES: Record<string, Record<'small' | 'medium' | 'large', number>> = {
  village: { small: 4, medium: 6, large: 9 },
  town: { small: 8, medium: 12, large: 18 },
  city: { small: 14, medium: 20, large: 30 },
  camp: { small: 2, medium: 4, large: 6 },
  farm: { small: 2, medium: 3, large: 4 },
};

const BUILDING_KINDS = new Set<BuildingKind>([
  'house', 'castle', 'tower', 'watchtower', 'ruin', 'barn', 'coop', 'windmill',
  'lighthouse', 'shrine', 'gazebo', 'market-stall', 'tent', 'well', 'fountain',
  'stone-arch', 'bridge', 'mine-entrance', 'column', 'wall',
]);

const ROUGHNESS: Record<string, number> = {
  flat: 0.05, hills: 0.5, mountains: 0.9, dunes: 0.35, islands: 0.5,
  valley: 0.6, plateau: 0.45, canyon: 0.85, volcano: 0.8, crater: 0.7,
};

const MATERIAL_COLORS: Record<string, { wall: string; roof: string }> = {
  'stone-mat': { wall: '#a8a294', roof: '#6f6a60' },
  'wood-mat': { wall: '#9a7550', roof: '#5d4230' },
  'brick-mat': { wall: '#a8583f', roof: '#5b4436' },
  'clay-mat': { wall: '#c39a6b', roof: '#8a6547' },
  'sand-mat': { wall: '#d8c39a', roof: '#a58a63' },
  'metal-mat': { wall: '#9aa2ab', roof: '#6b727a' },
  'thatch-mat': { wall: '#c8ab7a', roof: '#a98a4e' },
  'snow-mat': { wall: '#e8eef2', roof: '#b9c6cf' },
  'white-mat': { wall: '#e6e2d8', roof: '#b9b4a8' },
  'dark-mat': { wall: '#4e4a46', roof: '#332f2c' },
  'red-mat': { wall: '#a8483c', roof: '#5f2c25' },
};

const ARCHITECTURE_COLORS: Record<string, { wall: string; roof: string }> = {
  medieval: { wall: '#9b9486', roof: '#5c5a52' },
  ancient: { wall: '#b3a894', roof: '#7d7361' },
  modern: { wall: '#c8ccd0', roof: '#5a6167' },
  'desert-arch': { wall: '#d6bb8d', roof: '#9c7f56' },
  gothic: { wall: '#8b8579', roof: '#4a4a52' },
  viking: { wall: '#8d6b48', roof: '#4f4133' },
  rustic: { wall: '#a98a63', roof: '#6b5138' },
  'ruined-arch': { wall: '#8f8878', roof: '#6e6a5f' },
};

export interface SolveOptions {
  answers?: ClarificationAnswers;
  /** Cap on total drawable objects; defaults to the schema maximum. */
  maxObjects?: number;
  /** Explicit world scale chosen in the UI; beats every word in the text. */
  scaleOverride?: WorldIntent['scale'];
}

export function solveSpec(frames: Frames, base: PromptInterpretation, options: SolveOptions = {}): WorldSpec {
  const intent = base.intent;
  const maxObjects = Math.min(options.maxObjects ?? MAX_WORLD_OBJECTS, MAX_WORLD_OBJECTS);
  const negated = new Set(frames.negations);
  const live = frames.mentions.filter((mention) => !mention.negated);

  // ── Scale and dimensions ──────────────────────────────────────────────────
  // An explicit UI choice wins, then a world-level scale word, then tier 0 —
  // unless the only scale word described a single object ("a small village"),
  // which must not resize the terrain.
  const scale = options.scaleOverride ?? frames.scale ?? (frames.scaleFromObject ? 'medium' : intent.scale);
  const settings = SCALE_SETTINGS[scale];
  const dimensions = {
    size: settings.size,
    resolution: settings.resolution,
    scale,
    source: options.scaleOverride ? 'explicit' as const : frames.scale ? 'scale-word' as const : 'default' as const,
    areaUnitsSquared: settings.size * settings.size,
  };

  // ── Biomes ────────────────────────────────────────────────────────────────
  const primaryBiome = intent.biome;
  const extraBiomes = frames.biomes.filter((biome) => biome !== primaryBiome && !negated.has(biome));
  const biomes: BiomeZone[] = [{
    id: 'zone-primary',
    biome: primaryBiome,
    weight: extraBiomes.length ? 0.6 : 1,
  }];
  for (const [index, biome] of extraBiomes.entries()) {
    const region = frames.regions[index % Math.max(1, frames.regions.length)];
    biomes.push({
      id: `zone-${biome}`,
      biome,
      weight: 0.4 / extraBiomes.length,
      ...(region ? { region: region.id, selector: region.selector } : {}),
    });
  }

  // ── Terrain ───────────────────────────────────────────────────────────────
  const profile = BIOME_PROFILES[primaryBiome];
  const wantsWater = intent.water && !['water', 'sea', 'lake', 'river', 'marsh'].some((id) => negated.has(id));
  const hasLakeMention = live.some((mention) => mention.entry.id === 'lake') && !negated.has('lake');
  const wantsOasis = live.some((mention) => mention.entry.id === 'oasis') && !negated.has('oasis');
  const wantsLake = (live.some((mention) => mention.entry.id === 'lake') && !negated.has('lake')) || wantsOasis;
  const wantsRiver = (intent.river || live.some((mention) => mention.entry.id === 'river')) && !negated.has('river');
  // "a castle on top of a tall mountain" names the mountain as a biome rather
  // than a landform; a landmark anchored to it still makes terrain mountainous.
  const mountainAnchor = frames.relations.some((relation) =>
    (relation.predicate === 'on-top-of' || relation.predicate === 'at-foot-of') &&
    frames.mentions.find((mention) => mention.id === relation.object)?.entry.id === 'mountains');
  const style = frames.landform ?? intent.landform ??
    (mountainAnchor && frames.biomes.includes('mountains') && profile.terrainStyle !== 'mountains'
      ? 'mountains'
      : profile.terrainStyle);
  const heightScale = style === 'flat' ? 0 : Math.round(profile.heightScale * (style === 'mountains' ? 1.15 : style === 'hills' ? 0.85 : 1));
  const palette = paletteFor(
    profile.palette,
    frames.weather,
    primaryBiome,
    live.some((mention) => mention.entry.id === 'oasis'),
  );

  const terrain: TerrainConfig = {
    style,
    heightScale,
    roughness: ROUGHNESS[style] ?? 0.5,
    waterLevel: null,
    water: wantsWater || wantsLake || wantsRiver,
    ...(wantsLake ? {
      lake: {
        x: 0,
        z: 0,
        // An oasis is a pool in the sand, not a lake: smaller and shallower.
        radius: Math.max(5, Math.round(dimensions.size * (hasLakeMention ? 0.18 : 0.08))),
        depth: primaryBiome === 'mountains' ? 3 : hasLakeMention ? 2 : 1.5,
      },
    } : {}),
    ...(wantsRiver ? {
      river: {
        axis: 'z',
        width: 4.2,
        excavates: false,
        ...(frames.relations.some((relation) => relation.predicate === 'through') ? { throughRegion: 'center' } : {}),
      },
    } : {}),
    palette,
    ...(frames.landform && intent.landform && frames.landform !== intent.landform
      ? { ignored: [intent.landform] }
      : {}),
  };

  // ── Regions ───────────────────────────────────────────────────────────────
  const regions: RegionSpec[] = frames.regions.map((region) => ({
    id: region.id,
    name: region.name,
    shape: region.selector === 'center' ? 'circle' : region.selector === 'edge' ? 'ring' : 'band',
    selector: region.selector,
    ...(region.biome ? { biome: region.biome } : {}),
    ...(region.landform ? { landform: region.landform } : {}),
    members: region.mentions,
  }));

  // ── Buildings and settlements ─────────────────────────────────────────────
  const buildings: BuildingSpec[] = [];
  const settlements: MentionFrame[] = [];
  for (const mention of live) {
    if (mention.entry.category === 'settlement') {
      settlements.push(mention);
      continue;
    }
    if (mention.entry.category !== 'structure') continue;
    const kind = (BUILDING_KINDS.has(mention.entry.id as BuildingKind) ? mention.entry.id : 'house') as BuildingKind;
    const assetId = mention.entry.assetId ?? mention.entry.id;
    buildings.push({
      id: `b-${mention.id}`,
      kind,
      assetId,
      count: mention.count,
      label: mention.entry.ar[0] ?? mention.entry.en[0] ?? mention.entry.id,
      ...(mention.architecture ? { architecture: mention.architecture } : {}),
      ...(mention.material || mention.architecture ? { material: materialFor(mention, frames) } : {}),
      ...(mention.size ? { size: mention.size } : {}),
      ...(regionFor(mention, regions) ? { region: regionFor(mention, regions) } : {}),
      placement: placementFor(mention, frames),
      realized: KNOWN_ASSETS.has(assetId) ? 'procedural' : 'unrealized',
    });
  }

  const settlementRegions: RegionSpec[] = [];
  /**
   * A settlement mention stands for the houses it produces. Relations about the
   * settlement ("قرية تحيط ببحيرة") must therefore drive the placement of those
   * houses, whether the solver created them or the description named them.
   */
  const settlementAlias = new Map<string, string>();
  for (const mention of settlements) {
    const table = SETTLEMENT_HOUSES[mention.entry.id] ?? SETTLEMENT_HOUSES.village!;
    const explicitHouses = live.find((candidate) => candidate.entry.id === 'house');
    const count = mention.countSource === 'explicit' && mention.count > 1
      ? mention.count
      : explicitHouses?.count ?? table[scale];
    const regionId = `region-${mention.entry.id}`;
    settlementRegions.push({
      id: regionId,
      name: mention.entry.ar[0] ?? mention.entry.id,
      shape: mention.entry.id === 'farm' ? 'rect' : 'circle',
      ...(mention.region ? { selector: selectorOf(mention.region) } : {}),
      density: frames.density === 'dense' ? 1.3 : frames.density === 'sparse' ? 0.7 : 1,
      members: [mention.id],
    });
    const housesId = `b-${mention.id}-houses`;
    if (!explicitHouses) {
      buildings.push({
        id: housesId,
        kind: 'house',
        assetId: 'house',
        count,
        label: 'بيوت',
        ...(frames.architecture[0] ? { architecture: frames.architecture[0] } : {}),
        material: materialFor(mention, frames),
        region: regionId,
        placement: { strategy: mention.entry.id === 'farm' ? 'scatter' : 'ring', region: regionId, radius: Math.max(8, dimensions.size * 0.16) },
        realized: 'procedural',
      });
      settlementAlias.set(mention.id, housesId);
    } else {
      // The description named the houses itself; they still belong to this
      // settlement, so its region and its relations apply to them.
      const named = buildings.find((building) => building.id === `b-${explicitHouses.id}`);
      if (named) {
        named.region = named.region ?? regionId;
        settlementAlias.set(mention.id, named.id);
      }
    }
  }
  regions.push(...settlementRegions);

  // ── Assets (vegetation, props, paths) ─────────────────────────────────────
  const assets: AssetSpec[] = [];
  // Oasis and shore vegetation ("واحة نخيل") belongs at the water's edge, not
  // scattered over the whole desert.
  const shoreVegetation = wantsOasis || (terrain.water && primaryBiome === 'desert');
  for (const mention of live) {
    if (!['vegetation', 'prop'].includes(mention.entry.category)) continue;
    const assetId = mention.entry.assetId;
    if (!assetId) continue;
    const existing = assets.find((entry) => entry.assetId === assetId);
    if (existing) {
      existing.count += mention.count;
      continue;
    }
    assets.push({
      id: `a-${mention.id}`,
      assetId,
      label: mention.entry.ar[0] ?? mention.entry.id,
      count: mention.count,
      category: mention.entry.category === 'vegetation' ? 'vegetation' : assetId === 'boulder' ? 'rock' : assetId === 'dirt-path' ? 'path' : 'prop',
      ...(mention.size ? { size: mention.size } : {}),
      ...(regionFor(mention, regions) ? { region: regionFor(mention, regions) } : {}),
      placement: mention.entry.category === 'vegetation' && shoreVegetation && !mention.region
        ? { strategy: 'water-edge' as const }
        : placementFor(mention, frames),
      realized: KNOWN_ASSETS.has(assetId) || assetId === 'tree' ? 'procedural' : 'unrealized',
    });
  }

  // Merge anything the legacy parser recognized that the lexicon missed, so the
  // planner never loses information tier 0 already had.
  const mergedFromLegacy: string[] = [];
  for (const request of intent.assets ?? []) {
    const known = [...buildings, ...assets].some((entry) => entry.assetId === request.assetId);
    if (known) continue;
    // Tier 0 reads "بدون أشجار نخيل" as "no trees" *and* "3 palms"; the refined
    // negation wins, so an excluded asset is never merged back in.
    if (negated.has(request.assetId)) continue;
    // Tier 0 also reads "stone houses" as a boulder plus houses. When the lexicon
    // understood the same word as a material, the material wins.
    if (MATERIAL_COLLISIONS[request.assetId]?.some((id) => frames.materials.includes(id))) continue;
    mergedFromLegacy.push(request.assetId);
    assets.push({
      id: `a-legacy-${request.assetId}`,
      assetId: request.assetId,
      label: labelFor(request.assetId) !== request.assetId ? labelFor(request.assetId) : request.assetId,
      count: request.count,
      category: 'prop',
      ...(request.size ? { size: request.size } : {}),
      placement: { strategy: 'scatter' },
      realized: KNOWN_ASSETS.has(request.assetId) || request.assetId === 'tree' ? 'procedural' : 'unrealized',
    });
  }

  // ── Animals ───────────────────────────────────────────────────────────────
  const animals: AnimalSpec[] = frames.animals.map((animal) => ({
    id: animal.id,
    count: animal.count,
    label: labelFor(animal.id),
    realized: 'unrealized',
    notice: `«${labelFor(animal.id)}» ×${animal.count}: معروف في المواصفات، ولا يوجد باني إجرائي محلي له بعد.`,
  }));

  // ── Counts (explicit numbers beat conservative defaults) ──────────────────
  const counts = { ...intent.counts };
  const explicit = (id: string) => live.find((mention) => mention.entry.id === id && mention.countSource === 'explicit')?.count;
  const treeCount = ['tree', 'pine', 'palm', 'cactus', 'bush'].map(explicit).find((value) => value !== undefined);
  if (treeCount !== undefined) counts.trees = treeCount;
  const rockCount = ['rock'].map(explicit).find((value) => value !== undefined);
  if (rockCount !== undefined) counts.rocks = rockCount;
  const buildingCount = ['house', 'castle', 'tower'].map(explicit).find((value) => value !== undefined);
  if (buildingCount !== undefined) counts.buildings = buildingCount;
  const lanternCount = explicit('lantern');
  if (lanternCount !== undefined) counts.lanterns = lanternCount;

  // ── Negations ─────────────────────────────────────────────────────────────
  const negations: NegationSpec[] = [...negated].map((target) => ({
    target,
    label: labelFor(target),
    applied: true,
  }));
  const negatedIds = new Set(negated);
  const keptAssets = assets.filter((asset) => !negatedIds.has(asset.assetId));
  const keptBuildings = buildings.filter((building) => !negatedIds.has(building.assetId) && !negatedIds.has(building.kind));
  assets.length = 0;
  assets.push(...keptAssets);
  buildings.length = 0;
  buildings.push(...keptBuildings);
  // A generic exclusion ("بدون أشجار", "no trees") removes the vegetation
  // scatter entirely. A species exclusion ("بدون أشجار نخيل") only drops that
  // species' assets and thins the scatter, because the user still wants a
  // vegetated world.
  const GENERIC_TREE_IDS = ['tree', 'forest', 'orchard'];
  const SPECIES_TREE_IDS = ['pine', 'palm', 'cactus', 'bush', 'fern', 'bamboo', 'dead-tree'];
  const negatedSpecies = SPECIES_TREE_IDS.filter((id) => negatedIds.has(id));
  let treesRestored = false;
  if (GENERIC_TREE_IDS.some((id) => negatedIds.has(id))) {
    counts.trees = 0;
  } else if (negatedSpecies.length && counts.trees === 0 && treeCount === undefined) {
    // Tier 0 zeroed every tree because it cannot scope the negation to a
    // species. Restore the biome's own default, thinned, so "بدون أشجار نخيل"
    // leaves a green world without palms instead of a bare one.
    const densityFactor = frames.density === 'dense' ? 1.4 : frames.density === 'sparse' ? 0.65 : 1;
    counts.trees = Math.max(1, Math.round(BASE_COUNTS[primaryBiome].trees * SCALE_SETTINGS[scale].countFactor * densityFactor * 0.7));
    treesRestored = true;
  }
  if (['rock', 'boulder', 'crag'].some((id) => negatedIds.has(id))) counts.rocks = 0;
  if (['house', 'castle', 'tower', 'village', 'city', 'town'].some((id) => negatedIds.has(id))) counts.buildings = 0;
  if (negatedIds.has('lantern')) counts.lanterns = 0;

  // ── Materials, lighting, environment ──────────────────────────────────────
  const materials = worldMaterials(frames, profile.buildingColors);
  const lighting: LightingSpec = lightingFor(frames, intent.timeOfDay);
  const environment: EnvironmentSpec = {
    // Weather-derived colours and fog first, so the authoritative fields below
    // are never overwritten by the helper's defaults.
    ...environmentColors(frames, profile),
    weather: frames.weather.filter((id) => !negated.has(id)),
    water: terrain.water,
    ...(intent.style || frames.style ? { style: frames.style ?? intent.style } : {}),
    ...(intent.density || frames.density ? { density: frames.density ?? intent.density } : {}),
    ...(seasonFor(frames.weather) ? { season: seasonFor(frames.weather) } : {}),
  };

  // ── Relations ─────────────────────────────────────────────────────────────
  const relations: SpatialRelation[] = frames.relations.map((relation) => {
    const subject = frames.mentions.find((mention) => mention.id === relation.subject);
    const object = frames.mentions.find((mention) => mention.id === relation.object);
    const via = relation.via ? frames.mentions.find((mention) => mention.id === relation.via) : undefined;
    const second = relation.second ? frames.mentions.find((mention) => mention.id === relation.second) : undefined;
    return {
      id: relation.id,
      predicate: relation.predicate,
      subject: labelOf(subject, frames.language),
      object: labelOf(object, frames.language),
      ...(via ? { via: labelOf(via, frames.language) } : {}),
      ...(second ? { second: labelOf(second, frames.language) } : {}),
      subjectId: specIdFor(subject, buildings, assets, settlementAlias),
      objectId: anchorIdFor(object, buildings, assets, settlementAlias),
      status: 'pending' as const,
    };
  }).filter((relation) => relation.subjectId && relation.objectId);

  // Attach the resolved placement strategy to the subjects of each relation.
  for (const relation of relations) {
    const target = [...buildings, ...assets].find((entry) => entry.id === relation.subjectId);
    if (!target) continue;
    // "البيوت تربطها طرق" must not erase a stronger placement ("قرية تحيط
    // ببحيرة"): the road is chained through whatever positions the houses got.
    if (relation.predicate === 'connected-by' && target.placement && target.placement.strategy !== 'scatter') continue;
    target.placement = placementForPredicate(relation.predicate, relation.objectId, dimensions.size);
    if (!target.region) {
      const anchorRegion = [...buildings, ...assets].find((entry) => entry.id === relation.objectId)?.region;
      if (anchorRegion) target.region = anchorRegion;
    }
  }

  const spec: WorldSpec = {
    specVersion: WORLD_SPEC_VERSION,
    prompt: intent.prompt,
    name: intent.name,
    seed: intent.seed,
    language: frames.language,
    dimensions,
    terrain,
    biomes,
    primaryBiome,
    regions,
    buildings,
    assets,
    animals,
    materials,
    lighting,
    environment,
    relations,
    positions: {},
    negations,
    counts,
    clarifications: [],
    notices: [],
    cues: [...intent.cues, ...frames.cues.filter((cue) => !intent.cues.includes(cue))],
    execution: { steps: [], order: [], budgets: { maxObjects, reservedForRelations: 0, estimatedObjects: 0 }, preflight: { ok: false, errors: [], warnings: [] } },
    tier: 'rules',
    offline: base.offline,
  };

  // ── Budgets: clamp before asking, then report what was clamped ────────────
  const requested = countRequested(spec);
  const notices: string[] = [];
  if (requested > maxObjects) {
    clampToBudget(spec, maxObjects);
    notices.push(`العدد المطلوب (${requested}) تجاوز السعة (${maxObjects})؛ قُلِّصت النباتات أولاً ثم العناصر الصغيرة، وبقيت المعالم كما هي.`);
  }
  if (mergedFromLegacy.length) {
    notices.push(`أُضيفت عناصر فهمها المفسّر المحلي الأصلي: ${mergedFromLegacy.filter((id) => !id.startsWith('-')).join('، ') || '—'}.`);
  }
  if (terrain.ignored?.length) {
    notices.push(`شكل أرض مذكور لم يُعتمد لأن الوصف حدّد شكلاً أدق: ${terrain.ignored.join('، ')}.`);
  }
  if (frames.landform && intent.features?.farm) {
    notices.push('قالب المزرعة يحتفظ بتضاريسه؛ شكل الأرض المطلوب لا يُطبق داخل قالب المزرعة.');
  }
  notices.push(...frames.negationNotes);
  if (negatedSpecies.length && !negations.some((negation) => negation.target === 'tree')) {
    notices.push(treesRestored
      ? `استُثنيت ${negatedSpecies.map(labelFor).join('، ')} فقط؛ أُعيد نثر الأشجار الأخرى إلى ${counts.trees} لأن المفسّر الأصلي كان قد أوقفها كلها.`
      : `استُثنيت ${negatedSpecies.map(labelFor).join('، ')} فقط؛ بقيت بقية النباتات كما هي.`);
  }

  const hasHighGround = style === 'mountains' || style === 'volcano' || style === 'plateau' || style === 'canyon' ||
    primaryBiome === 'mountains' || frames.mentions.some((mention) => mention.entry.id === 'mountain-terrain');
  const contradictions = detectContradictions({
    frames,
    requestedObjects: requested,
    hasHighGround,
    hasWater: terrain.water,
  });
  const { resolved, unansweredBlocking } = resolveWithAnswers(contradictions.clarifications, options.answers ?? {});
  applyAnswersToSpec(spec, resolved);

  spec.notices = [...notices, ...contradictions.notices, ...spec.notices];
  spec.clarifications = contradictions.clarifications.map((item) => ({
    ...item,
    ...(resolved[item.id] ? { reason: `${item.reason} (الإجابة المعتمدة: ${resolved[item.id]})` } : {}),
  }));
  // The complete execution plan is built last, so it reflects the answers and
  // the clamped budget — and nothing is generated before it exists.
  const steps = buildSteps(spec);
  spec.execution = buildExecutionPlan(
    { ...spec, execution: { steps, order: [], budgets: { maxObjects, reservedForRelations: 0, estimatedObjects: 0 }, preflight: { ok: false, errors: [], warnings: [] } } },
    unansweredBlocking.map((item) => item.id),
  );
  return spec;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function labelOf(mention: MentionFrame | undefined, language: Frames['language']): string {
  if (!mention) return '—';
  return language === 'en' ? mention.entry.en[0] ?? mention.entry.id : mention.entry.ar[0] ?? mention.entry.id;
}

function specIdFor(
  mention: MentionFrame | undefined,
  buildings: BuildingSpec[],
  assets: AssetSpec[],
  alias?: Map<string, string>,
): string {
  if (!mention) return '';
  const aliased = alias?.get(mention.id);
  if (aliased) return aliased;
  return buildings.find((entry) => entry.id === `b-${mention.id}`)?.id ??
    assets.find((entry) => entry.id === `a-${mention.id}`)?.id ?? '';
}

/** Water bodies a relation can be anchored to without being placeable objects. */
const WATER_ANCHORS: Record<string, string> = {
  lake: 'terrain-lake', sea: 'terrain-sea', river: 'terrain-river',
  water: 'terrain-water', marsh: 'terrain-marsh', oasis: 'terrain-oasis',
};
/** Relief a relation can be anchored to; the layout solver reads real heights. */
const HIGH_ANCHORS = new Set(['mountains', 'mountain-terrain', 'hills', 'dunes', 'volcano', 'plateau', 'canyon', 'crater']);

/**
 * Anchor side of a relation. A mountain, a lake or a forest is not an object the
 * planner places, but it is a perfectly good anchor: the layout resolver samples
 * the real terrain (highest point, lake basin, shoreline) for these ids.
 */
function anchorIdFor(
  mention: MentionFrame | undefined,
  buildings: BuildingSpec[],
  assets: AssetSpec[],
  alias?: Map<string, string>,
): string {
  if (!mention) return '';
  const placeable = specIdFor(mention, buildings, assets, alias);
  if (placeable) return placeable;
  const water = WATER_ANCHORS[mention.entry.id];
  if (water) return water;
  if (HIGH_ANCHORS.has(mention.entry.id)) return 'terrain-summit';
  if (mention.entry.category === 'landform' || mention.entry.category === 'biome') return 'terrain-area';
  if (mention.entry.category === 'settlement') return `region-${mention.entry.id}`;
  return '';
}

function selectorOf(regionId: string): RegionSpec['selector'] {
  switch (regionId) {
    case 'north': return 'north';
    case 'south': return 'south';
    case 'east': return 'east';
    case 'west': return 'west';
    case 'center': return 'center';
    case 'edge': return 'edge';
    case 'summit-region': return 'summit';
    case 'base-region': return 'base';
    case 'slope-region': return 'slope';
    case 'waterfront-region': return 'waterfront';
    default: return 'center';
  }
}

function regionFor(mention: MentionFrame, regions: RegionSpec[]): string | undefined {
  if (!mention.region) return undefined;
  return regions.find((region) => region.id === `region-${mention.region}`)?.id ?? `region-${mention.region}`;
}

function placementFor(mention: MentionFrame, frames: Frames): PlacementSpec {
  if (mention.region) {
    const selector = selectorOf(mention.region);
    if (selector === 'summit') return { strategy: 'highest', region: `region-${mention.region}` };
    if (selector === 'base') return { strategy: 'lowest', region: `region-${mention.region}` };
    if (selector === 'slope') return { strategy: 'scatter', region: `region-${mention.region}` };
    if (selector === 'waterfront') return { strategy: 'water-edge', region: `region-${mention.region}` };
    return { strategy: 'region-center', region: `region-${mention.region}` };
  }
  if (mention.entry.category === 'vegetation' && frames.density === 'dense') return { strategy: 'scatter' };
  if (mention.entry.id === 'road') return { strategy: 'chain' };
  if (['sea', 'marsh'].includes(mention.entry.id)) return { strategy: 'water-edge' };
  return { strategy: 'scatter' };
}

function placementForPredicate(predicate: SpatialRelation['predicate'], anchorId: string, size: number): PlacementSpec {
  switch (predicate) {
    case 'on-top-of': return { strategy: 'highest', anchor: anchorId };
    case 'at-foot-of': return { strategy: 'lowest', anchor: anchorId };
    case 'surrounding':
    case 'surrounded-by': return { strategy: 'ring', anchor: anchorId, radius: Math.max(8, size * 0.16) };
    case 'inside': return { strategy: 'region-center', anchor: anchorId };
    case 'through':
    case 'across': return { strategy: 'line', anchor: anchorId };
    case 'between': return { strategy: 'midpoint', anchor: anchorId };
    case 'along': return { strategy: 'water-edge', anchor: anchorId };
    case 'connected-by': return { strategy: 'chain', anchor: anchorId };
    default: return {
      strategy: 'anchor-offset',
      anchor: anchorId,
      direction: predicate === 'left-of' ? 'left'
        : predicate === 'right-of' ? 'right'
          : predicate === 'front-of' ? 'front'
            : predicate === 'behind' ? 'behind' : 'near',
      radius: Math.max(4, size * 0.05),
    };
  }
}

function materialFor(mention: MentionFrame, frames: Frames): MaterialSpec {
  const paletteId = mention.material ?? frames.materials[0];
  const architecture = mention.architecture ?? frames.architecture[0];
  const fromMaterial = paletteId ? MATERIAL_COLORS[paletteId] : undefined;
  const fromArchitecture = architecture ? ARCHITECTURE_COLORS[architecture] : undefined;
  const colors = fromMaterial ?? fromArchitecture;
  return {
    ...(paletteId ? { palette: paletteId.replace(/-mat$/, '') } : {}),
    ...(colors ? { wall: colors.wall, roof: colors.roof } : {}),
    ...(paletteId === 'metal-mat' ? { metalness: 0.55, roughness: 0.45 } : paletteId === 'stone-mat' ? { roughness: 0.95 } : {}),
  };
}

function worldMaterials(frames: Frames, fallback: { wall: string; roof: string }): MaterialSpec {
  const paletteId = frames.materials[0];
  const architecture = frames.architecture[0];
  const colors = (paletteId ? MATERIAL_COLORS[paletteId] : undefined) ?? (architecture ? ARCHITECTURE_COLORS[architecture] : undefined) ?? fallback;
  return {
    ...(paletteId ? { palette: paletteId.replace(/-mat$/, '') } : {}),
    wall: colors.wall,
    roof: colors.roof,
    ...(paletteId === 'metal-mat' ? { metalness: 0.55, roughness: 0.45 } : { roughness: 0.9 }),
  };
}

function paletteFor(palette: { low: string; high: string }, weather: string[], biome: string, hasOasis: boolean): { low: string; high: string } {
  if (weather.includes('snow')) return { low: '#c9d4da', high: '#f0f5f8' };
  if (weather.includes('sandstorm')) return { low: '#b58f5c', high: '#e2cb96' };
  if (weather.includes('rain') || weather.includes('storm')) return { low: shade(palette.low, -12), high: shade(palette.high, -8) };
  if (biome === 'desert' && hasOasis) return { low: palette.low, high: '#d8cf9c' };
  return palette;
}

function environmentColors(frames: Frames, profile: { sky: Record<string, string>; fogDensity: number }): EnvironmentSpec {
  const out: EnvironmentSpec = { weather: [], water: false };
  if (frames.weather.includes('fog')) out.fogDensity = Math.min(1, profile.fogDensity * 4 + 0.012);
  else if (frames.weather.includes('sandstorm')) out.fogDensity = Math.min(1, profile.fogDensity * 5 + 0.02);
  else if (frames.weather.includes('rain') || frames.weather.includes('storm')) out.fogDensity = Math.min(1, profile.fogDensity * 2.5 + 0.006);
  else if (frames.weather.includes('snow')) out.fogDensity = Math.min(1, profile.fogDensity * 2 + 0.004);
  if (frames.weather.includes('storm')) {
    out.skyColor = '#4b5158';
    out.fogColor = '#5b6169';
  } else if (frames.weather.includes('fog')) {
    out.skyColor = '#b9c2c6';
    out.fogColor = '#c4cbce';
  } else if (frames.weather.includes('sandstorm')) {
    out.skyColor = '#c9a878';
    out.fogColor = '#d5b98d';
  } else if (frames.weather.includes('snow')) {
    out.skyColor = '#c3d2dc';
    out.fogColor = '#d8e2e8';
  }
  return out;
}

function seasonFor(weather: string[]): string | undefined {
  if (weather.includes('snow')) return 'winter';
  if (weather.includes('hot')) return 'summer';
  if (weather.includes('rain')) return 'spring';
  if (weather.includes('sandstorm')) return 'dry';
  return undefined;
}

function lightingFor(frames: Frames, timeOfDay: WorldIntent['timeOfDay']): LightingSpec {
  const requested: string[] = [];
  let sunIntensityScale = 1;
  let ambientIntensityScale = 1;
  const weather = frames.weather;
  if (weather.includes('storm')) {
    sunIntensityScale = 0.55;
    ambientIntensityScale = 1.25;
    requested.push('عاصفة');
  } else if (weather.includes('cloudy') || weather.includes('rain')) {
    sunIntensityScale = 0.75;
    ambientIntensityScale = 1.15;
    requested.push('غيوم');
  } else if (weather.includes('fog')) {
    sunIntensityScale = 0.85;
    ambientIntensityScale = 1.1;
    requested.push('ضباب');
  } else if (weather.includes('snow')) {
    sunIntensityScale = 0.9;
    ambientIntensityScale = 1.2;
    requested.push('ثلج');
  } else if (weather.includes('hot')) {
    sunIntensityScale = 1.12;
    requested.push('حر');
  }
  const lighting: LightingSpec = { timeOfDay, sunIntensityScale, ambientIntensityScale, requested };
  if (/شمس منخفضة|low sun|شمس عالية|high sun|noon sun/.test(frames.normalized)) {
    lighting.sunElevation = /منخفضة|low/.test(frames.normalized) ? 14 : 72;
    requested.push(lighting.sunElevation < 30 ? 'شمس منخفضة' : 'شمس عالية');
  }
  return lighting;
}

/** Darkens/lightens a hex colour by a signed amount, clamped per channel. */
export function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const int = Number.parseInt(value.length === 3 ? value.split('').map((char) => char + char).join('') : value, 16);
  if (!Number.isFinite(int)) return hex;
  const channel = (shift: number) => Math.max(0, Math.min(255, Math.round(((int >> shift) & 0xff) + amount)));
  return `#${((1 << 24) + (channel(16) << 16) + (channel(8) << 8) + channel(0)).toString(16).slice(1)}`;
}

/** Applies answered clarifications; unanswered blocking items stop execution. */
function applyAnswersToSpec(spec: WorldSpec, resolved: Record<string, string>): void {
  const answer = (id: string) => resolved[id];
  if (answer('water-contradiction') === 'drop-water') {
    spec.terrain.water = false;
    spec.terrain.waterLevel = null;
    delete spec.terrain.lake;
    delete spec.terrain.river;
    spec.environment.water = false;
  }
  if (answer('forest-without-trees') === 'no-trees') {
    spec.counts.trees = 0;
    spec.assets = spec.assets.filter((asset) => asset.category !== 'vegetation');
  }
  if (answer('forest-without-trees') === 'keep-trees') {
    // The user chose the forest, so the blanket exclusion tier 0 read out of the
    // sentence is withdrawn and the biome's own tree cover comes back.
    spec.negations = spec.negations.filter((negation) => negation.target !== 'tree');
    const restored = Math.round(BASE_COUNTS[spec.primaryBiome].trees * SCALE_SETTINGS[spec.dimensions.scale].countFactor);
    spec.counts.trees = Math.max(spec.counts.trees, restored);
    spec.notices.push(`أُبقيت الأشجار (${spec.counts.trees}) لأن الغابة بلا أشجار ليست غابة.`);
  }
  if (answer('desert-dense-forest') === 'desert-oasis') {
    spec.assets = spec.assets.map((asset) => (asset.assetId === 'pine' ? { ...asset, assetId: 'palm', label: 'نخيل', count: Math.min(asset.count, 6) } : asset));
    spec.environment.density = 'sparse';
  }
  if (answer('desert-dense-forest') === 'forest') {
    spec.primaryBiome = 'forest';
    spec.biomes = [{ id: 'zone-primary', biome: 'forest', weight: 1 }];
    spec.terrain.style = 'hills';
  }
  if (answer('island-without-water') === 'no-island') {
    spec.primaryBiome = 'meadow';
    spec.biomes = [{ id: 'zone-primary', biome: 'meadow', weight: 1 }];
    spec.terrain.style = 'hills';
    spec.terrain.water = false;
  }
  if (answer('flat-and-mountainous') === 'flat') {
    spec.terrain.style = 'hills';
    spec.terrain.heightScale = Math.min(spec.terrain.heightScale, 8);
  }
  if (answer('river-negated-but-crossed') === 'road') {
    delete spec.terrain.river;
    spec.assets.push({
      id: 'a-road-substitute', assetId: 'dirt-path', label: 'طريق', count: 4,
      category: 'path', placement: { strategy: 'chain' }, realized: 'procedural',
    });
  }
  if (answer('conflicting-time') === 'day') spec.lighting.timeOfDay = 'day';
  if (answer('hot-and-snow') === 'hot') {
    spec.environment.weather = spec.environment.weather.filter((id) => id !== 'snow');
    spec.terrain.palette = paletteFor(BIOME_PROFILES[spec.primaryBiome].palette, [], spec.primaryBiome, false);
  }
  if (answer('multiple-biomes') === 'split' && spec.biomes.length > 1) {
    const share = 1 / spec.biomes.length;
    spec.biomes = spec.biomes.map((zone) => ({ ...zone, weight: share }));
  }
  if (answer('object-budget') === 'even') clampToBudget(spec, MAX_WORLD_OBJECTS, 'even');
}

/** Reduces requested objects to the budget; landmarks are protected by default. */
export function clampToBudget(spec: WorldSpec, maxObjects: number, mode: 'landmarks-first' | 'even' = 'landmarks-first'): void {
  const cap = Math.max(0, maxObjects);
  const before = countRequested(spec);
  if (before <= cap) return;
  const factor = cap / before;
  const fits = () => countRequested(spec) <= cap;

  if (mode === 'even') {
    spec.counts.trees = Math.floor(spec.counts.trees * factor);
    spec.counts.rocks = Math.floor(spec.counts.rocks * factor);
    spec.counts.buildings = Math.floor(spec.counts.buildings * factor);
    spec.counts.lanterns = Math.floor(spec.counts.lanterns * factor);
    for (const asset of spec.assets) asset.count = Math.max(1, Math.floor(asset.count * factor));
    for (const building of spec.buildings) building.count = Math.max(1, Math.floor(building.count * factor));
    spec.notices.push(budgetNotice(before, countRequested(spec), cap, 'even'));
    return;
  }

  // Landmarks first, in four phases, each stopping as soon as the world fits.
  // The remaining budget is re-measured after every cut, because a counter that
  // explicit assets already cover costs nothing and cutting it saves nothing.
  const scatter = scatterContribution(spec);

  // 1. Thin the anonymous scatter proportionally.
  for (const key of ['trees', 'rocks', 'buildings', 'lanterns'] as const) {
    if (scatter[key] === 0) continue;
    spec.counts[key] = Math.floor(spec.counts[key] * factor);
  }
  // 2. Then give up what is left of it before touching anything the user named.
  for (const key of ['trees', 'rocks', 'lanterns', 'buildings'] as const) {
    if (fits()) break;
    spec.counts[key] = 0;
  }
  if (fits()) {
    spec.notices.push(budgetNotice(before, countRequested(spec), cap, 'landmarks-first'));
    return;
  }

  // 3. Then thin the named groups, largest first, keeping at least one of each.
  const thin = (list: { count: number }[], ratio: number): void => {
    for (const entry of list) {
      if (fits()) return;
      entry.count = Math.max(1, Math.floor(entry.count * ratio));
    }
  };
  thin([...spec.assets].sort((a, b) => b.count - a.count), 0.5);
  if (!fits()) thin([...spec.buildings].sort((a, b) => b.count - a.count), 0.5);
  if (!fits()) thin([...spec.assets, ...spec.buildings], 0);
  if (fits()) {
    spec.notices.push(budgetNotice(before, countRequested(spec), cap, 'landmarks-first'));
    return;
  }

  // 4. Last resort: drop named objects — props before landmarks, and never the
  //    last landmark standing.
  const dropped: string[] = [];
  const props = [...spec.assets].sort((a, b) => a.count - b.count);
  while (!fits() && props.length) {
    const asset = props.shift()!;
    dropped.push(asset.label);
    spec.assets.splice(spec.assets.indexOf(asset), 1);
  }
  const landmarks = [...spec.buildings].sort((a, b) => rankOfBuilding(a) - rankOfBuilding(b) || a.count - b.count);
  while (!fits() && landmarks.length && spec.buildings.length > 1) {
    const building = landmarks.shift()!;
    dropped.push(building.label);
    spec.buildings.splice(spec.buildings.indexOf(building), 1);
  }
  spec.notices.push(budgetNotice(before, countRequested(spec), cap, 'landmarks-first', dropped));
}

function budgetNotice(before: number, after: number, cap: number, mode: string, dropped: string[] = []): string {
  const how = mode === 'even' ? 'بالتساوي بين كل الفئات' : 'بحيث بقيت المعالم والمباني أولاً';
  const loss = dropped.length ? ` وحُذفت: ${dropped.join('، ')}` : '';
  return `قُلِّص العدد المطلوب من ${before} إلى ${after} ليبقى داخل سعة ${cap} عنصراً، ${how}${loss}.`;
}

/** Landmarks outrank ordinary buildings; a castle outlives a fence. */
function rankOfBuilding(building: BuildingSpec): number {
  const rank: Record<string, number> = {
    castle: 100, lighthouse: 90, watchtower: 85, tower: 80, shrine: 70, 'mine-entrance': 70,
    'stone-arch': 60, ruin: 50, windmill: 45, fountain: 40, well: 40, 'market-stall': 35,
    bridge: 30, barn: 25, house: 20, wall: 10, tent: 10, gazebo: 8, column: 5, coop: 5,
  };
  return rank[building.kind] ?? 15;
}

/**
 * Project the spec onto the existing `WorldIntent`, so the current generators do
 * the building. Only fields the planner understood better are overridden; every
 * other value is inherited from tier 0.
 */
export function intentFromSpec(spec: WorldSpec, base: PromptInterpretation): WorldIntent {
  const requests: AssetRequest[] = [];
  const landmarksFirst = [...spec.buildings].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  for (const building of landmarksFirst) {
    if (building.realized === 'unrealized') continue;
    requests.push({
      assetId: building.assetId,
      count: building.count,
      ...(building.size ? { size: building.size } : {}),
      ...(building.material?.wall ? { referenceColor: building.material.wall } : {}),
      ...(spec.positions[building.id]?.length ? { positions: spec.positions[building.id] } : {}),
      ...(building.region ? { region: building.region } : {}),
    });
  }
  for (const asset of spec.assets) {
    if (asset.realized === 'unrealized') continue;
    requests.push({
      assetId: asset.assetId,
      count: asset.count,
      ...(asset.size ? { size: asset.size } : {}),
      ...(spec.positions[asset.id]?.length ? { positions: spec.positions[asset.id] } : {}),
      ...(asset.region ? { region: asset.region } : {}),
    });
  }
  // Pairwise relations the legacy parser already understood (left / right /
  // front / behind / near) survive, re-indexed onto the new request list. A
  // planner-resolved absolute position always wins over a relative direction.
  const legacyAssets = base.intent.assets ?? [];
  for (const legacy of legacyAssets) {
    if (!legacy.relation) continue;
    const legacyAnchor = legacyAssets[legacy.relation.target];
    if (!legacyAnchor) continue;
    const target = requests.find((request) => request.assetId === legacy.assetId);
    const anchor = requests.find((request) => request.assetId === legacyAnchor.assetId);
    if (!target || !anchor || target === anchor || target.relation || target.positions) continue;
    target.relation = { target: requests.indexOf(anchor), direction: legacy.relation.direction };
  }

  const hasAssets = requests.length > 0;
  // Whether the world keeps a natural background is the interpreter's call: it
  // already reads "غابة" or "صحراء" as a landscape, and a bare "شجرة" as one
  // object. The planner only turns the background on when it understood *more*
  // vegetation than the interpreter did (for example a negation it could scope
  // to one species instead of every tree).
  const wantsBackground = base.intent.landscape === true || spec.counts.trees > base.intent.counts.trees;
  const summary = [
    `${spec.dimensions.size}×${spec.dimensions.size} وحدة · ${spec.primaryBiome}`,
    `${spec.buildings.reduce((sum, building) => sum + building.count, 0)} مبنى`,
    `${spec.assets.reduce((sum, asset) => sum + asset.count, 0)} عنصر`,
    `${spec.counts.trees} شجرة · ${spec.counts.rocks} صخرة`,
    spec.relations.length ? `${spec.relations.length} علاقة مكانية` : '',
  ].filter(Boolean).join(' · ');

  return {
    ...base.intent,
    name: spec.name,
    seed: spec.seed,
    biome: spec.primaryBiome,
    timeOfDay: spec.lighting.timeOfDay,
    scale: spec.dimensions.scale,
    settlement: base.intent.settlement || spec.buildings.some((building) => building.kind === 'house' && building.count >= 3),
    water: spec.terrain.water,
    ...(spec.terrain.style !== BIOME_PROFILES[spec.primaryBiome].terrainStyle || base.intent.landform
      ? { landform: base.intent.landform ?? spec.terrain.style }
      : {}),
    river: spec.terrain.river !== undefined || base.intent.river === true,
    villageRiver: base.intent.villageRiver,
    ...(hasAssets ? { assets: requests } : {}),
    // Explicit assets plus a vegetation request: ask the generator to keep the
    // surroundings, which is exactly what `landscape` already does.
    landscape: hasAssets && wantsBackground ? true : base.intent.landscape,

    ...(spec.environment.style ? { style: spec.environment.style } : {}),
    ...(spec.environment.density ? { density: spec.environment.density } : {}),
    counts: spec.counts,
    cues: spec.cues,
    summary,
  };
}
