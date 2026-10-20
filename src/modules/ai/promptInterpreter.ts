import { clamp, titleFromPrompt } from '../../core/utils/id';
import { seedFromPrompt } from '../../core/world-plan/factory';
import {
  BASE_COUNTS,
  BIOME_PROFILES,
  SCALE_SETTINGS,
  SETTLEMENT_BUILDINGS,
  SETTLEMENT_LANTERNS,
} from '../../core/generation/biomes';
import type {
  BiomeId,
  FarmFeatures,
  InterpretOptions,
  PromptInterpretation,
  PromptInterpreter,
  TimeOfDay,
  WorldDensity,
  WorldIntent,
  WorldScale,
  WorldStyle,
} from './types';

const BIOME_KEYWORDS: Record<BiomeId, string[]> = {
  island: [
    'island',
    'islands',
    'archipelago',
    'atoll',
    'ocean',
    'sea',
    'coast',
    'coastal',
    'lagoon',
    'beach',
    'tropical',
  ],
  desert: ['desert', 'dune', 'dunes', 'sand', 'sandy', 'arid', 'oasis', 'sahara', 'mesa', 'badlands'],
  mountains: [
    'mountain',
    'mountains',
    'alpine',
    'alps',
    'peak',
    'peaks',
    'cliff',
    'cliffs',
    'highland',
    'summit',
    'canyon',
    'snow',
    'snowy',
  ],
  ruins: ['ruin', 'ruins', 'ancient', 'temple', 'abandoned', 'forgotten', 'crumbling', 'derelict'],
  forest: [
    'forest',
    'forests',
    'wood',
    'woods',
    'woodland',
    'jungle',
    'grove',
    'taiga',
    'wooded',
  ],
  meadow: ['meadow', 'field', 'fields', 'plain', 'plains', 'grass', 'grassland', 'valley', 'prairie', 'savanna'],
};

const SETTLEMENT_KEYWORDS = [
  'village',
  'town',
  'city',
  'settlement',
  'hamlet',
  'houses',
  'huts',
  'outpost',
  'camp',
  'market',
];

const NIGHT_KEYWORDS = ['night', 'midnight', 'moon', 'moonlit', 'starry', 'stars', 'dark', 'nocturnal'];
const SUNSET_KEYWORDS = ['sunset', 'sunrise', 'dusk', 'dawn', 'golden hour', 'twilight', 'evening'];
const WATER_KEYWORDS = [
  'lake',
  'lakes',
  'river',
  'pond',
  'water',
  'sea',
  'ocean',
  'coast',
  'lagoon',
  'island',
  'oasis',
];
const DRY_KEYWORDS = ['dry', 'arid', 'no water', 'waterless'];
const SMALL_KEYWORDS = ['small', 'tiny', 'little', 'compact', 'mini'];
const LARGE_KEYWORDS = ['large', 'huge', 'vast', 'expansive', 'big', 'massive', 'endless'];

const COUNT_ALIASES: Record<string, 'trees' | 'rocks' | 'buildings' | 'lanterns'> = {
  tree: 'trees',
  trees: 'trees',
  pine: 'trees',
  pines: 'trees',
  oak: 'trees',
  oaks: 'trees',
  palm: 'trees',
  palms: 'trees',
  cactus: 'trees',
  cacti: 'trees',
  rock: 'rocks',
  rocks: 'rocks',
  boulder: 'rocks',
  boulders: 'rocks',
  stone: 'rocks',
  stones: 'rocks',
  house: 'buildings',
  houses: 'buildings',
  hut: 'buildings',
  huts: 'buildings',
  building: 'buildings',
  buildings: 'buildings',
  tower: 'buildings',
  towers: 'buildings',
  ruin: 'buildings',
  ruins: 'buildings',
  lantern: 'lanterns',
  lanterns: 'lanterns',
  light: 'lanterns',
  lights: 'lanterns',
};

const COUNT_LIMITS = { trees: 600, rocks: 400, buildings: 200, lanterns: 120 };

const FARM_KEYWORDS = [
  'farm',
  'farms',
  'farmstead',
  'barn',
  'barns',
  'wheat',
  'coop',
  'coops',
  'chicken',
  'chickens',
  'hen',
  'hens',
  'poultry',
  'farmhouse',
  'ranch',
  'silo',
  'orchard',
  'homestead',
  'paddock',
  'crops',
  'crop',
  'harvest',
];

const CARTOON_KEYWORDS = [
  'cartoon',
  'low-poly',
  'low poly',
  'lowpoly',
  'stylized',
  'stylised',
  'toy',
  'playful',
  'cozy',
  'charming',
];
const NATURAL_KEYWORDS = ['realistic', 'natural', 'photorealistic', 'lifelike'];
const DENSE_KEYWORDS = ['dense', 'lush', 'abundant', 'thick', 'overgrown', 'bustling'];
const SPARSE_KEYWORDS = ['sparse', 'minimal', 'empty', 'quiet', 'few trees'];

function detectStyle(text: string): { style: WorldStyle; matched: string[] } {
  const cartoon = matches(text, CARTOON_KEYWORDS);
  if (cartoon.length > 0) return { style: 'cartoon', matched: cartoon };
  const natural = matches(text, NATURAL_KEYWORDS);
  if (natural.length > 0) return { style: 'natural', matched: natural };
  return { style: 'stylized', matched: [] };
}

function detectDensity(text: string): { density: WorldDensity; matched: string[] } {
  const dense = matches(text, DENSE_KEYWORDS);
  if (dense.length > 0) return { density: 'dense', matched: dense };
  const sparse = matches(text, SPARSE_KEYWORDS);
  if (sparse.length > 0) return { density: 'sparse', matched: sparse };
  return { density: 'normal', matched: [] };
}

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

function detectWheatFieldCount(text: string): number {
  const digit = /(\d)\s*wheat\s*fields?/.exec(text);
  if (digit?.[1]) return clamp(Number.parseInt(digit[1], 10), 1, 3);
  const word = /(one|two|three|four)\s+wheat\s*fields?/.exec(text);
  if (word?.[1]) return clamp(WORD_NUMBERS[word[1]] ?? 2, 1, 3);
  return /wheat\s*fields?|fields?\s*of\s*wheat/.test(text) ? (text.includes('large') ? 3 : 2) : 0;
}

function detectFarmFeatures(text: string, timeOfDay: TimeOfDay): FarmFeatures | undefined {
  const farmMatches = matches(text, FARM_KEYWORDS);
  if (farmMatches.length === 0) return undefined;

  const wheatFields = Math.max(1, detectWheatFieldCount(text) || 2);
  const river = matches(text, ['river', 'creek', 'stream', 'brook']).length > 0;
  const bridge = matches(text, ['bridge', 'crossing']).length > 0;
  const orchard = matches(text, ['orchard', 'apple', 'fruit']).length > 0;
  const coop = matches(text, ['coop', 'chicken', 'chickens', 'hen', 'hens', 'poultry']).length > 0;

  return {
    farm: true,
    farmhouse: matches(text, ['farmhouse', 'farm house', 'house', 'cottage', 'homestead']).length > 0 || farmMatches.length > 0,
    barn: text.includes('barn') || farmMatches.length > 0,
    silo: text.includes('silo') || text.includes('granary'),
    coop,
    wheatFields: wheatFields || 2,
    fences: matches(text, ['fence', 'fences', 'fenced', 'paddock', 'enclosure', 'wall', 'walls']).length > 0,
    dirtPaths:
      matches(text, ['path', 'paths', 'lane', 'lanes', 'road', 'roads', 'track', 'trail', 'dirt']).length > 0,
    orchard,
    river,
    bridge,
    rocks: matches(text, ['rock', 'rocks', 'stone', 'stones', 'boulder', 'boulders']).length > 0 || !/no rocks/.test(text),
    bushes:
      matches(text, ['bush', 'bushes', 'hedge', 'hedges', 'shrub', 'shrubs']).length > 0 ||
      !/no (bushes|hedges|shrubs)/.test(text),
    lanterns:
      matches(text, ['lantern', 'lanterns', 'lamp', 'lamps']).length > 0 || timeOfDay === 'night',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word matching avoids false positives such as "sea" in "season". */
function matches(haystack: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(haystack));
}

function detectBiome(text: string): { biome: BiomeId; matched: string[] } {
  const scores: { biome: BiomeId; score: number; matched: string[] }[] = [];
  for (const [biome, keywords] of Object.entries(BIOME_KEYWORDS) as [BiomeId, string[]][]) {
    const found = matches(text, keywords);
    scores.push({ biome, score: found.length, matched: found });
  }
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  if (!best || best.score === 0) return { biome: 'meadow', matched: [] };
  return { biome: best.biome, matched: best.matched };
}

function detectTime(text: string): { timeOfDay: TimeOfDay; matched: string[] } {
  const night = matches(text, NIGHT_KEYWORDS);
  if (night.length > 0) return { timeOfDay: 'night', matched: night };
  const sunset = matches(text, SUNSET_KEYWORDS);
  if (sunset.length > 0) return { timeOfDay: 'sunset', matched: sunset };
  return { timeOfDay: 'day', matched: [] };
}

function detectScale(text: string): { scale: WorldScale; matched: string[] } {
  const large = matches(text, LARGE_KEYWORDS);
  if (large.length > 0) return { scale: 'large', matched: large };
  const small = matches(text, SMALL_KEYWORDS);
  if (small.length > 0) return { scale: 'small', matched: small };
  return { scale: 'medium', matched: [] };
}

function detectExplicitCounts(text: string): {
  counts: Partial<Record<'trees' | 'rocks' | 'buildings' | 'lanterns', number>>;
  matched: string[];
} {
  const counts: Partial<Record<'trees' | 'rocks' | 'buildings' | 'lanterns', number>> = {};
  const matched: string[] = [];
  const pattern = /\b(\d{1,3})\s*(?:x\s*)?([a-z]+)\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const rawValue = match[1];
    const rawWord = match[2];
    if (!rawValue || !rawWord) continue;
    const bucket = COUNT_ALIASES[rawWord];
    if (!bucket) continue;
    const value = clamp(Number.parseInt(rawValue, 10), 0, COUNT_LIMITS[bucket]);
    counts[bucket] = value;
    matched.push(`${value} ${bucket}`);
  }

  if (/(no|without|zero)\s+(trees?|forest)/.test(text)) {
    counts.trees = 0;
    matched.push('no trees');
  }
  if (/(no|without|zero)\s+(rocks?|stones?)/.test(text)) {
    counts.rocks = 0;
    matched.push('no rocks');
  }
  if (/(no|without|zero)\s+(buildings?|houses?)/.test(text)) {
    counts.buildings = 0;
    matched.push('no buildings');
  }

  return { counts, matched };
}

function buildIntent(prompt: string, options: InterpretOptions = {}): WorldIntent {
  const text = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
  const biomeResult = detectBiome(text);
  const timeResult = detectTime(text);
  const scaleResult = detectScale(text);
  const countResult = detectExplicitCounts(text);
  const styleResult = detectStyle(text);
  const densityResult = detectDensity(text);
  const features = detectFarmFeatures(text, timeResult.timeOfDay);
  const farm = features !== undefined;
  const settlementMatches = matches(text, SETTLEMENT_KEYWORDS);
  const settlement = settlementMatches.length > 0 || farm;
  const waterMatches = matches(text, WATER_KEYWORDS);
  const dry = matches(text, DRY_KEYWORDS).length > 0;

  // A farm is a meadow scene; farm cues outweigh a stray biome word.
  const biome = farm ? 'meadow' : biomeResult.biome;
  const scale = options.scale ?? scaleResult.scale;
  const style = options.style ?? styleResult.style;
  const density = options.density ?? densityResult.density;
  const factor = SCALE_SETTINGS[scale].countFactor;
  const base = BASE_COUNTS[biome];

  let buildings = Math.round(base.buildings * factor);
  let lanterns = Math.round(base.lanterns * factor);
  if (settlement) {
    buildings = Math.max(buildings, Math.round(SETTLEMENT_BUILDINGS * factor));
    lanterns = Math.max(lanterns, Math.round(SETTLEMENT_LANTERNS * factor));
  }
  if (timeResult.timeOfDay === 'night') {
    lanterns = Math.max(lanterns, Math.round(6 * factor));
  }

  const counts = {
    trees: countResult.counts.trees ?? Math.round(base.trees * factor),
    rocks: countResult.counts.rocks ?? Math.round(base.rocks * factor),
    buildings: countResult.counts.buildings ?? buildings,
    lanterns: countResult.counts.lanterns ?? lanterns,
  };

  const water = farm
    ? Boolean(features?.river)
    : biome === 'island'
      ? true
      : !dry && waterMatches.length > 0;

  const cues: string[] = [];
  cues.push(`biome: ${biome}`);
  if (biomeResult.matched.length > 0) cues.push(`matched: ${biomeResult.matched.slice(0, 4).join(', ')}`);
  cues.push(`time: ${timeResult.timeOfDay}`);
  if (settlementMatches.length > 0) cues.push(`settlement: ${settlementMatches[0]}`);
  if (water) cues.push('water: enabled');
  if (scale !== 'medium') cues.push(`scale: ${scale}`);
  if (options.scale) cues.push('size override');
  if (options.style) cues.push('style override');
  if (options.density) cues.push('density override');
  cues.push(...countResult.matched);
  if (countResult.matched.length === 0) {
    cues.push(`default counts for ${BIOME_PROFILES[biome].label.toLowerCase()}`);
  }
  if (features) {
    const named = [
      features.farmhouse ? 'farmhouse' : null,
      features.barn ? 'barn' : null,
      features.silo ? 'silo' : null,
      features.coop ? 'coop' : null,
      `${features.wheatFields} wheat fields`,
      features.fences ? 'fences' : null,
      features.dirtPaths ? 'dirt paths' : null,
      features.orchard ? 'orchard' : null,
      features.river ? 'river' : null,
      features.bridge ? 'bridge' : null,
    ].filter(Boolean);
    cues.push(`structures: ${named.join(', ')}`);
    cues.push(`style: ${style}`);
    if (density !== 'normal') cues.push(`density: ${density}`);
  }

  const summaryParts = [
    (features ? 'Farmstead' : BIOME_PROFILES[biome].label) + (settlement && !features ? ' settlement' : ''),
    timeResult.timeOfDay,
    features
      ? `${features.wheatFields} wheat field${features.wheatFields === 1 ? '' : 's'}`
      : `${counts.trees} trees`,
    features ? `${style} style` : `${counts.rocks} rocks`,
  ];
  if (!features && counts.buildings > 0) summaryParts.push(`${counts.buildings} buildings`);

  return {
    prompt,
    name: titleFromPrompt(prompt),
    seed: options.seed ?? seedFromPrompt(prompt),
    biome,
    timeOfDay: timeResult.timeOfDay,
    scale,
    settlement,
    water,
    features,
    style,
    density,
    counts,
    cues,
    summary: summaryParts.join(' · '),
  };
}

/**
 * Deterministic, dependency-free prompt interpreter.
 *
 * This is intentionally transparent: it reports every cue it matched so users
 * can see exactly why a world looks the way it does. It does not call any API.
 */
const LOCAL_INTERPRETER_ID = 'local-heuristic-v1';
const LOCAL_INTERPRETER_LABEL = 'Offline prompt interpreter';

export const localPromptInterpreter: PromptInterpreter = {
  id: LOCAL_INTERPRETER_ID,
  label: LOCAL_INTERPRETER_LABEL,
  offline: true,
  async interpret(prompt, options) {
    const intent = buildIntent(prompt, options);
    return {
      intent,
      providerId: LOCAL_INTERPRETER_ID,
      providerLabel: LOCAL_INTERPRETER_LABEL,
      offline: true,
    };
  },
};

export const promptInterpreters: PromptInterpreter[] = [localPromptInterpreter];

/** Exported for tests and for future provider implementations. */
export function interpretPromptLocally(prompt: string, options?: InterpretOptions): PromptInterpretation {
  return {
    intent: buildIntent(prompt, options),
    providerId: localPromptInterpreter.id,
    providerLabel: localPromptInterpreter.label,
    offline: true,
  };
}
