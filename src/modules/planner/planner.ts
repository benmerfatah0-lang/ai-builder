import { generateWorldPlanWithReport, type GenerationReport } from '../../core/generation/generateWorld';
import { validateScenePlan, type SceneValidation } from '../../core/world-plan/validateScene';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import type { PromptInterpretation, WorldIntent, WorldScale, WorldStyle, WorldDensity } from '../ai/types';
import type { WorldPlan } from '../../core/world-plan/schema';
import { extractFrames } from './frames';
import { solveSpec, intentFromSpec, type SolveOptions } from './solve';
import { resolveLayout } from './layout';
import { applySpecToPlan } from './realize';
import { advance } from './executionPlan';
import { labelFor } from './lexicon';
import { materialLabel, terrainLabel } from './specSummary';
import { createLocalLlmBackend, enrichmentGaps, mergeEnrichment, ruleBackend, type PlannerBackend } from './backends';
import type { ClarificationAnswers } from './contradictions';
import type { Clarification, ExecutionPlan, WorldSpec } from './worldSpec';

/**
 * The advanced world planner — the public façade.
 *
 * Pipeline (all stages run before a single object is created):
 *
 *   description
 *     → tier 0 `interpretPromptLocally`      (existing engine, unchanged)
 *     → `extractFrames`                      (bilingual lexicon + relations)
 *     → `solveSpec`                          (constraints, budgets, negations)
 *     → `detectContradictions`               (clarifications)
 *     → optional local-model enrichment      (gaps only, validated)
 *     → terrain shell via the existing generator (counts zeroed)
 *     → `resolveLayout`                      (relations → coordinates)
 *     → `intentFromSpec`                     (project onto `WorldIntent`)
 *     → `generateWorldPlanWithReport`        (existing generator)
 *     → `applySpecToPlan`                    (roads, materials, weather, tags)
 *     → `validateScenePlan`                  (existing semantic validator)
 *
 * Nothing here replaces a generator: the existing pipeline does the building,
 * and the planner decides *what* to ask it for and *where*.
 */

export type PlannerStage = 'interpret' | 'frames' | 'solve' | 'clarify' | 'enrich' | 'layout' | 'generate' | 'validate';

export interface PlanWorldOptions {
  seed?: number;
  style?: WorldStyle | 'auto';
  scale?: WorldScale | 'auto';
  density?: WorldDensity | 'auto';
  /** Answers to previously raised clarifications. */
  answers?: ClarificationAnswers;
  /** Optional free local language model. Disabled by default; never required. */
  llm?: { enabled: boolean; model?: string; url?: string; timeoutMs?: number };
  signal?: AbortSignal;
  onStage?: (stage: PlannerStage) => void;
  /** Extra backends, for tests and future tiers. */
  backends?: PlannerBackend[];
}

export interface PlannerResult {
  spec: WorldSpec;
  interpretation: PromptInterpretation;
  /** Blocking questions that must be answered before generation may run. */
  blocking: Clarification[];
  tier: WorldSpec['tier'];
  offline: boolean;
  stages: PlannerStage[];
}

export class PlannerBlockedError extends Error {
  readonly clarifications: Clarification[];
  constructor(clarifications: Clarification[]) {
    super('يحتاج المخطط إجابات قبل إنشاء العالم.');
    this.name = 'PlannerBlockedError';
    this.clarifications = clarifications;
  }
}

function interpretOptions(options: PlanWorldOptions): { seed?: number; style?: WorldStyle; scale?: WorldScale; density?: WorldDensity } {
  return {
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.style && options.style !== 'auto' ? { style: options.style } : {}),
    ...(options.scale && options.scale !== 'auto' ? { scale: options.scale } : {}),
    ...(options.density && options.density !== 'auto' ? { density: options.density } : {}),
  };
}

/** Builds the complete specification and execution plan for a description. */
export async function planWorld(description: string, options: PlanWorldOptions = {}): Promise<PlannerResult> {
  const stages: PlannerStage[] = [];
  const text = description.trim();
  const run = <T>(stage: PlannerStage, work: () => T): T => {
    options.onStage?.(stage);
    stages.push(stage);
    return work();
  };

  const interpretation = run('interpret', () => interpretPromptLocally(text, interpretOptions(options)));
  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

  const frames = run('frames', () => extractFrames(text));
  const solveOptions: SolveOptions = {
    ...(options.answers ? { answers: options.answers } : {}),
    ...(options.scale && options.scale !== 'auto' ? { scaleOverride: options.scale } : {}),
  };
  let spec = run('solve', () => solveSpec(frames, interpretation, solveOptions));

  run('clarify', () => undefined);
  const blocking = spec.clarifications.filter((item) => item.severity === 'blocking' && !isAnswered(item, options.answers));

  // Optional local model: gaps only, validated, and never allowed to override
  // counts, negations, budgets or positions.
  const wantsLlm = options.llm?.enabled === true;
  if (wantsLlm && !blocking.length) {
    const backend = createLocalLlmBackend({
      ...(options.llm?.model ? { model: options.llm.model } : {}),
      ...(options.llm?.url ? { url: options.llm.url } : {}),
      ...(options.llm?.timeoutMs ? { timeoutMs: options.llm.timeoutMs } : {}),
    });
    options.onStage?.('enrich');
    stages.push('enrich');
    if (await backend.available(options.signal)) {
      const enrichment = await backend.enrich({
        prompt: text,
        language: frames.language,
        knownTerms: spec.cues.slice(0, 120),
        gaps: enrichmentGaps(spec, frames),
      }, options.signal);
      const merged = mergeEnrichment(spec, frames, enrichment);
      spec = merged.spec;
    } else {
      spec = {
        ...spec,
        notices: [...spec.notices, 'النموذج اللغوي المحلي غير متاح الآن؛ اعُتمد المحرّك القواعدي وحده (بدون إنترنت).'],
      };
    }
  } else if (wantsLlm && blocking.length) {
    spec = { ...spec, notices: [...spec.notices, 'لم يُستشر النموذج المحلي لأن هناك أسئلة حاجبة بلا إجابة.'] };
  }

  if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  return {
    spec: { ...spec, tier: spec.tier, offline: interpretation.offline && !wantsLlm },
    interpretation,
    blocking,
    tier: spec.tier,
    offline: interpretation.offline && !wantsLlm,
    stages,
  };
}

function isAnswered(item: Clarification, answers?: ClarificationAnswers): boolean {
  return Boolean(answers && item.options.some((option) => option.id === answers[item.id]));
}

export interface ExecutionResult {
  plan: WorldPlan;
  spec: WorldSpec;
  intent: WorldIntent;
  warnings: string[];
  validation: SceneValidation;
  execution: ExecutionPlan;
  report: GenerationReport;
}

/**
 * Runs the execution plan against the existing generators.
 *
 * Synchronous and network-free: by the time this is called every decision has
 * already been made and recorded in `spec.execution`.
 */
export function executePlannerResult(result: PlannerResult, overrides: { name?: string; description?: string } = {}): ExecutionResult {
  if (result.blocking.length) throw new PlannerBlockedError(result.blocking);

  const spec = result.spec;
  const interpretation = result.interpretation;

  // Stage: terrain. A draft intent (identical in every field that shapes
  // terrain: biome, scale, landform, water, seed) is run through the existing
  // generator with all counts zeroed, so the layout resolver samples exactly the
  // heightfield the final world will have. No new terrain code is introduced.
  const draft = intentFromSpec(spec, interpretation);
  const shell = generateWorldPlanWithReport({
    ...draft,
    assets: undefined,
    features: undefined,
    settlement: false,
    landscape: false,
    villageRiver: false,
    river: false,
    counts: { trees: 0, rocks: 0, buildings: 0, lanterns: 0 },
  }).plan;

  // Stage: spatial resolution. Relations become coordinates on that terrain.
  const resolved = resolveLayout(spec, shell.terrain);

  // Stage: generation, through the untouched existing pipeline.
  const intent = intentFromSpec(resolved, interpretation);
  const report = generateWorldPlanWithReport(intent);

  // Stage: realization of everything a WorldIntent cannot carry.
  const realized = applySpecToPlan(report.plan, resolved);

  // Stage: validation, with the existing recoverable-object fallback.
  let validation = validateScenePlan(realized.plan);
  let plan = realized.plan;
  if (!validation.valid && validation.recoverable.length) {
    const droppable = new Set(validation.recoverable);
    plan = { ...plan, objects: plan.objects.filter((object) => !droppable.has(object.id)) };
    validation = validateScenePlan(plan);
  }

  const name = overrides.name?.trim();
  if (name) plan = { ...plan, name: name.slice(0, 80) };

  const execution = markExecution(resolved.execution, { plan, report, resolved });
  const warnings = dedupe([...report.warnings, ...realized.warnings, ...resolved.notices, ...execution.preflight.warnings]);

  return { plan, spec: { ...resolved, execution }, intent, warnings, validation, execution, report };
}

function markExecution(
  execution: ExecutionPlan,
  outcome: { plan: WorldPlan; report: GenerationReport; resolved: WorldSpec },
): ExecutionPlan {
  let next = execution;
  const detail: Record<string, string> = {
    'validate-input': `${outcome.resolved.cues.length} إشارة · ${outcome.resolved.relations.length} علاقة`,
    'resolve-terrain': `${terrainLabel(outcome.plan.terrain.style)} · ${outcome.plan.terrain.size} وحدة · ماء ${outcome.plan.terrain.waterLevel === null ? 'لا' : 'نعم'}`,
    'resolve-biomes': outcome.resolved.biomes.map((zone) => labelFor(zone.biome)).join('، '),
    'resolve-regions': `${outcome.resolved.regions.length} منطقة`,
    'resolve-positions': `${outcome.resolved.relations.filter((relation) => relation.status === 'resolved').length} علاقة محلولة`,
    'place-landmarks': `${outcome.plan.objects.filter((object) => object.kind === 'primitive').length} عنصر مكتبة`,
    'place-buildings': `${outcome.plan.objects.filter((object) => object.kind === 'building').length} مبنى`,
    'place-assets': `${outcome.plan.objects.length} عنصر إجمالاً`,
    'place-vegetation': `${outcome.plan.objects.filter((object) => object.kind === 'tree').length} شجرة · ${outcome.plan.objects.filter((object) => object.kind === 'rock').length} صخرة`,
    'connect-paths': `${outcome.plan.objects.filter((object) => object.kind === 'path').length} طريق · ${outcome.plan.objects.filter((object) => object.kind === 'bridge').length} جسر`,
    'add-water': `${outcome.plan.objects.filter((object) => object.kind === 'river').length} نهر · حوض بحيرة ${outcome.plan.terrain.lakeBasin ? 'نعم' : 'لا'}`,
    'apply-materials': materialLabel(outcome.resolved.materials.palette),
    'apply-lighting': `شمس ${outcome.plan.environment.sunIntensity.toFixed(2)} · محيط ${outcome.plan.environment.ambientIntensity.toFixed(2)}`,
    'apply-environment': `ضباب ${outcome.plan.environment.fogDensity.toFixed(4)} · ${outcome.resolved.environment.weather.map(labelFor).join('، ') || 'صافٍ'}`,
    'validate-scene': outcome.report.validation.valid ? 'صالح' : 'غير صالح',
    report: `${outcome.report.warnings.length} تحذير`,
  };
  for (const id of execution.order) {
    next = advance(next, id, 'done', detail[id]);
  }
  return next;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/** Convenience for tests and other callers: plan and execute in one step. */
export async function planAndBuildWorld(
  description: string,
  options: PlanWorldOptions = {},
  overrides: { name?: string } = {},
): Promise<ExecutionResult & { result: PlannerResult }> {
  const result = await planWorld(description, options);
  if (result.blocking.length) throw new PlannerBlockedError(result.blocking);
  return { ...executePlannerResult(result, overrides), result };
}

/** The tier that is always available, exported for callers that display it. */
export const plannerTierLabel = (tier: WorldSpec['tier']): string =>
  tier === 'rules+local-llm' ? 'المحرّك القواعدي + نموذج لغة محلي' : ruleBackend.label;
