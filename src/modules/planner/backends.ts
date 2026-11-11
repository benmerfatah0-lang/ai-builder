import { llmEnrichmentSchema, type LlmEnrichment, type WorldSpec } from './worldSpec';
import { LEXICON, labelFor } from './lexicon';
import { extractFrames, type Frames } from './frames';

/**
 * Inference backends for the planner.
 *
 * Tiering rule (the important one): **the deterministic rule tier is always
 * authoritative for anything that can break a world** — counts, budgets,
 * negations, positions and terrain. A local language model may only *fill gaps*
 * the rules could not fill, and everything it returns is validated against a
 * strict schema before it is allowed near the spec.
 *
 * Nothing here talks to a paid or remote service. The optional neural tier is a
 * model the user installed on their own machine, reached through the local
 * phone/desktop server; when it is absent, slow, disabled or wrong, the planner
 * silently stays on rules and remains fully offline.
 */

export interface EnrichRequest {
  prompt: string;
  language: 'ar' | 'en' | 'mixed';
  /** Lexicon terms the planner already recognises, so the model stays in vocabulary. */
  knownTerms: string[];
  /** What the rule tier could not resolve; the model is asked only about these. */
  gaps: string[];
}

export interface PlannerBackend {
  id: string;
  label: string;
  /** True when the backend never touches the network. */
  offline: boolean;
  available(signal?: AbortSignal): Promise<boolean>;
  enrich(request: EnrichRequest, signal?: AbortSignal): Promise<LlmEnrichment | null>;
}

/** Tier 0/1: the deterministic engine itself. Always available, never fails. */
export const ruleBackend: PlannerBackend = {
  id: 'rules-v1',
  label: 'المحرّك القواعدي المحلي',
  offline: true,
  async available() {
    return true;
  },
  async enrich() {
    return null;
  },
};

export interface LocalLlmOptions {
  /** Relative endpoint served by the local phone/desktop server. */
  url?: string;
  /** Model name passed through to the local runtime (llama.cpp, Ollama, …). */
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_LLM_URL = '/api/local-llm';
const DEFAULT_TIMEOUT = 20_000;

/**
 * Tier 3: a free local language model, reached only through the local server and
 * only when the user enabled it. The server refuses to proxy anywhere except a
 * localhost URL it was started with, so this backend can never reach the cloud.
 */
export function createLocalLlmBackend(options: LocalLlmOptions = {}): PlannerBackend {
  const url = options.url ?? DEFAULT_LLM_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

  const call = async (body: unknown, signal?: AbortSignal): Promise<unknown> => {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  return {
    id: 'local-llm',
    label: 'نموذج لغة محلي (اختياري)',
    offline: true,
    async available(signal) {
      const result = await call({ probe: true, ...(options.model ? { model: options.model } : {}) }, signal);
      return Boolean(result && typeof result === 'object' && (result as { ok?: boolean }).ok === true);
    },
    async enrich(request, signal) {
      const result = await call(
        {
          prompt: request.prompt.slice(0, 2000),
          language: request.language,
          knownTerms: request.knownTerms.slice(0, 200),
          gaps: request.gaps.slice(0, 20),
          ...(options.model ? { model: options.model } : {}),
        },
        signal,
      );
      if (!result || typeof result !== 'object') return null;
      const payload = (result as { enrichment?: unknown }).enrichment ?? result;
      const parsed = llmEnrichmentSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  };
}

// ── Merging ──────────────────────────────────────────────────────────────────

/**
 * Which terrain forms each biome may plausibly sit on.
 *
 * A model may only fill a gap that does not contradict what the description
 * already fixed: suggesting dunes for a forest, or a desert biome for a world
 * built around a mountain, would silently undo the rule tier's reading.
 */
const BIOME_LANDFORMS: Record<string, string[]> = {
  meadow: ['flat', 'hills', 'valley', 'plateau'],
  forest: ['flat', 'hills', 'mountains', 'valley', 'plateau', 'canyon'],
  mountains: ['mountains', 'hills', 'valley', 'canyon', 'plateau', 'volcano', 'crater', 'flat'],
  desert: ['dunes', 'flat', 'canyon', 'plateau', 'crater', 'volcano'],
  island: ['islands', 'flat', 'hills', 'volcano', 'crater'],
  ruins: ['flat', 'hills', 'mountains', 'dunes', 'valley', 'plateau', 'canyon', 'islands', 'volcano', 'crater'],
};

const fits = (biome: string | undefined, landform: string): boolean =>
  !biome || (BIOME_LANDFORMS[biome] ?? []).includes(landform);

const ANIMAL_IDS = new Set(LEXICON.filter((entry) => entry.category === 'animal').map((entry) => entry.id));
const WEATHER_IDS = new Set(LEXICON.filter((entry) => entry.category === 'weather').map((entry) => entry.id));
const ARCHITECTURE_IDS = new Set(LEXICON.filter((entry) => entry.category === 'architecture').map((entry) => entry.id));

function matchesLexicon(value: string, ids: Set<string>): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (ids.has(normalized)) return normalized;
  const entry = LEXICON.find((candidate) => ids.has(candidate.id) &&
    (candidate.en.some((term) => term.toLowerCase() === normalized) || candidate.ar.some((term) => term === normalized)));
  return entry?.id;
}

/**
 * Merge local-model hints into a rule-produced spec.
 *
 * Only gaps are filled. Counts, negations, budgets, terrain numbers and
 * positions produced by the rule tier are never modified here.
 */
export function mergeEnrichment(spec: WorldSpec, frames: Frames, enrichment: LlmEnrichment | null): { spec: WorldSpec; applied: string[] } {
  if (!enrichment) return { spec, applied: [] };
  const applied: string[] = [];
  const next: WorldSpec = { ...spec, tier: 'rules+local-llm' };

  const rejected: string[] = [];
  if (enrichment.biome && !frames.biomes.length) {
    if (fits(enrichment.biome, next.terrain.style)) {
      next.primaryBiome = enrichment.biome;
      next.biomes = [{ id: 'zone-primary', biome: enrichment.biome, weight: 1 }];
      applied.push(`البيئة: ${labelFor(enrichment.biome)}`);
    } else {
      rejected.push(`البيئة «${labelFor(enrichment.biome)}» تتعارض مع شكل الأرض «${labelFor(next.terrain.style)}»`);
    }
  }
  if (enrichment.landform && !frames.landform) {
    if (fits(next.primaryBiome, enrichment.landform)) {
      next.terrain = { ...next.terrain, style: enrichment.landform };
      applied.push(`شكل التضاريس: ${labelFor(enrichment.landform)}`);
    } else {
      rejected.push(`شكل الأرض «${labelFor(enrichment.landform)}» لا يناسب بيئة «${labelFor(next.primaryBiome)}»`);
    }
  }
  if (enrichment.timeOfDay && !frames.time) {
    next.lighting = { ...next.lighting, timeOfDay: enrichment.timeOfDay };
    applied.push(`الوقت: ${enrichment.timeOfDay}`);
  }
  if (enrichment.scale && !frames.scale) {
    applied.push(`المقياس مقترح من النموذج المحلي (${enrichment.scale}) ولم يُعتمد لأنه يغيّر أبعاد العالم؛ يُترك للمفسّر القواعدي.`);
  }
  if (enrichment.density && !frames.density) {
    next.environment = { ...next.environment, density: enrichment.density };
    applied.push(`الكثافة: ${enrichment.density}`);
  }
  if (enrichment.style && !frames.style) {
    next.environment = { ...next.environment, style: enrichment.style };
    applied.push(`الأسلوب: ${enrichment.style}`);
  }
  if (enrichment.weather?.length) {
    const known = enrichment.weather
      .map((value) => matchesLexicon(value, WEATHER_IDS))
      .filter((id): id is string => typeof id === 'string' && !next.environment.weather.includes(id));
    if (known.length) {
      next.environment = { ...next.environment, weather: [...next.environment.weather, ...known] };
      applied.push(`الطقس: ${known.map(labelFor).join('، ')}`);
    }
  }
  if (enrichment.architecture?.length) {
    // An architecture style describes buildings, never a material palette, so it
    // is only allowed to tag buildings the rules left unstyled.
    const known = enrichment.architecture
      .map((value) => matchesLexicon(value, ARCHITECTURE_IDS))
      .filter((id): id is string => typeof id === 'string' && !frames.architecture.includes(id));
    const style = known[0];
    if (style && next.buildings.some((building) => !building.architecture)) {
      next.buildings = next.buildings.map((building) => (building.architecture ? building : { ...building, architecture: style }));
      applied.push(`الطراز المعماري: ${labelFor(style)}`);
    }
  }
  if (enrichment.materials?.wall || enrichment.materials?.roof) {
    next.materials = {
      ...next.materials,
      ...(enrichment.materials.wall && !frames.materials.length ? { wall: enrichment.materials.wall } : {}),
      ...(enrichment.materials.roof && !frames.materials.length ? { roof: enrichment.materials.roof } : {}),
    };
    applied.push('ألوان المواد من النموذج المحلي');
  }
  if (enrichment.animals?.length) {
    const added = enrichment.animals.filter((animal) => ANIMAL_IDS.has(animal.id) && !next.animals.some((existing) => existing.id === animal.id));
    if (added.length) {
      next.animals = [
        ...next.animals,
        ...added.map((animal) => ({
          id: animal.id,
          count: animal.count,
          label: labelFor(animal.id),
          realized: 'unrealized' as const,
          notice: `«${labelFor(animal.id)}» ×${animal.count}: معروف في المواصفات، ولا يوجد باني إجرائي محلي له بعد.`,
        })),
      ];
      applied.push(`حيوانات إضافية: ${added.map((animal) => labelFor(animal.id)).join('، ')}`);
    }
  }
  if (enrichment.regions?.length && next.regions.length < 8) {
    const added = enrichment.regions
      .filter((region) => !next.regions.some((existing) => existing.name === region.name && existing.selector === region.selector))
      .slice(0, 8 - next.regions.length)
      .map((region, index) => ({
        id: `region-llm-${index}`,
        name: region.name.slice(0, 40),
        shape: 'circle' as const,
        selector: region.selector,
        ...(region.biome ? { biome: region.biome } : {}),
        members: [],
      }));
    if (added.length) {
      next.regions = [...next.regions, ...added];
      applied.push(`مناطق مقترحة: ${added.map((region) => region.name).join('، ')}`);
    }
  }
  if (enrichment.relations?.length && !spec.relations.length) {
    // A relation must be grounded in two real objects to be resolvable. The model
    // names them in free text, so the suggestion is reported and never applied:
    // an ungrounded relation would place objects by guesswork.
    next.notices = [
      ...next.notices,
      `اقترح النموذج المحلي ${enrichment.relations.length} علاقة مكانية ولم تُعتمد، لأنها لا تربط عناصر معروفة في الوصف.`,
    ];
  }
  if (enrichment.clarifications?.length) {
    const added = enrichment.clarifications
      .filter((question) => !next.clarifications.some((existing) => existing.question === question))
      .slice(0, 4)
      .map((question, index) => ({
        id: `llm-${index}`,
        severity: 'advisory' as const,
        question: question.slice(0, 200),
        options: [{ id: 'accept', label: 'اعتمد الافتراضي' }, { id: 'ignore', label: 'تجاهل' }],
        defaultOption: 'accept',
        reason: 'سؤال من النموذج المحلي الاختياري.',
      }));
    if (added.length) {
      next.clarifications = [...next.clarifications, ...added];
      applied.push(`${added.length} سؤال استيضاحي إضافي`);
    }
  }
  if (enrichment.name && /^untitled world$/i.test(next.name)) {
    next.name = enrichment.name.slice(0, 80);
    applied.push(`الاسم: ${next.name}`);
  }

  next.notices = [
    ...next.notices,
    ...rejected.map((reason) => `لم يُعتمد اقتراح النموذج المحلي: ${reason}.`),
    applied.length
      ? `أضاف النموذج المحلي: ${applied.join('، ')}. بقيت الأعداد والمواقع والنفي من المحرّك القواعدي.`
      : 'لم يضف النموذج المحلي شيئاً مقبولاً؛ اعُتمدت نتائج المحرّك القواعدي وحده.',
  ];
  return { spec: next, applied };
}

/** What the rule tier could not resolve; this is all a model is asked about. */
export function enrichmentGaps(spec: WorldSpec, frames: Frames): string[] {
  const gaps: string[] = [];
  if (!frames.biomes.length && !frames.landform) gaps.push('biome');
  if (!frames.landform) gaps.push('landform');
  if (!frames.time) gaps.push('timeOfDay');
  if (!frames.scale) gaps.push('scale');
  if (!frames.density) gaps.push('density');
  if (!frames.weather.length) gaps.push('weather');
  if (!frames.architecture.length) gaps.push('architecture');
  if (!frames.regions.length) gaps.push('regions');
  if (!spec.relations.length) gaps.push('relations');
  if (!spec.animals.length) gaps.push('animals');
  return gaps;
}

/** Kept exported for tests: the frames a merge is validated against. */
export function framesOf(description: string): Frames {
  return extractFrames(description);
}
