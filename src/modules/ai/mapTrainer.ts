/**
 * Lightweight self-training for the existing world planner. It does not learn
 * geometry, game rules or from the web: it searches three density multipliers
 * on locally generated maps, scoring simple safety/coverage heuristics.
 */
import { z } from 'zod';
import { generateWorldPlanWithReport, type GenerationReport } from '../../core/generation/generateWorld';
import { mulberry32 } from '../../core/generation/rng';
import { interpretPromptLocally } from './promptInterpreter';
import type { WorldIntent } from './types';

const weightsSchema = z.object({
  trees: z.number().finite().min(0.65).max(1.35),
  rocks: z.number().finite().min(0.65).max(1.35),
  buildings: z.number().finite().min(0.65).max(1.35),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), attempts: z.number().int().min(0).max(100000),
  accepted: z.number().int().min(0).max(100000), weights: weightsSchema,
  lastGain: z.number().finite().min(0).max(100).nullable(),
}).strict().refine((value) => value.accepted <= value.attempts);
export type MapTrainingState = z.infer<typeof stateSchema>;
const KEY = 'world-builder-map-trainer-v1';
const PROMPTS = ['a small meadow landscape', 'a small forest landscape', 'a small desert landscape',
  'a small mountain landscape', 'a small ruins landscape', 'a small island landscape', 'a small meadow village'];

export function initialMapTraining(): MapTrainingState {
  return { version: 1, enabled: true, attempts: 0, accepted: 0, weights: { trees: 1, rocks: 1, buildings: 1 }, lastGain: null };
}
export function loadMapTraining(storage: Pick<Storage, 'getItem'>): MapTrainingState {
  try { const raw = storage.getItem(KEY); return raw ? stateSchema.parse(JSON.parse(raw)) : initialMapTraining(); }
  catch { return initialMapTraining(); }
}
export function saveMapTraining(storage: Pick<Storage, 'setItem'>, state: MapTrainingState): void {
  storage.setItem(KEY, JSON.stringify(stateSchema.parse(state)));
}
export function removeMapTraining(storage: Pick<Storage, 'removeItem'>): void { storage.removeItem(KEY); }

/** Only adjust unspecified scatter densities; never override explicit assets, numbers or farms. */
export function applyMapTraining(intent: WorldIntent, model: MapTrainingState): WorldIntent {
  if (intent.assets?.length || intent.features?.farm || /[0-9٠-٩۰-۹]|\b(?:one|two|three|four|five|six|ten)\b|واحد|اثنين|اثنان|ثلاث|اربع|أربع|خمس|عشر/i.test(intent.prompt)) return intent;
  const { counts } = intent;
  return { ...intent, counts: { ...counts,
    trees: Math.max(0, Math.min(600, Math.round(counts.trees * model.weights.trees))),
    rocks: Math.max(0, Math.min(400, Math.round(counts.rocks * model.weights.rocks))),
    buildings: Math.max(0, Math.min(200, Math.round(counts.buildings * model.weights.buildings))),
  } };
}

/** Simple proxy score, not a human assessment of fun, quality or playability. */
export function scoreTrainingMap(report: GenerationReport): number {
  if (!report.validation.valid) return -100;
  const objects = report.plan.objects;
  const half = report.plan.terrain.size / 2;
  const occupied = new Set<string>();
  for (const object of objects) {
    const [x, , z] = object.transform.position;
    const col = Math.max(0, Math.min(3, Math.floor((x + half) / (half * 2) * 4)));
    const row = Math.max(0, Math.min(3, Math.floor((z + half) / (half * 2) * 4)));
    occupied.add(`${col}:${row}`);
  }
  const kinds = new Set(objects.map((object) => object.kind));
  const densityReward = Math.min(objects.length, 40) * 0.08;
  const overloadPenalty = Math.max(0, objects.length - 70) * 0.12;
  return occupied.size * 1.5 + kinds.size * 1.5 + densityReward - overloadPenalty - Math.min(30, report.validation.warnings.length) * 0.5;
}

/** Compare a bounded mutation and incumbent on the same synthetic prompt and seed. */
export function trainMapStep(state: MapTrainingState): MapTrainingState {
  if (!state.enabled || state.attempts >= 100000) return state;
  const rng = mulberry32((state.attempts + 1) * 1729);
  const key = (['trees', 'rocks', 'buildings'] as const)[Math.floor(rng() * 3)]!;
  const direction = rng() < 0.5 ? -1 : 1;
  const value = Math.max(0.65, Math.min(1.35, state.weights[key] + direction * 0.1));
  const candidate = { ...state, weights: { ...state.weights, [key]: value } };
  const prompt = PROMPTS[state.attempts % PROMPTS.length]!;
  const seed = Math.floor(rng() * 4294967296);
  const intent = interpretPromptLocally(prompt, { seed, scale: 'small' }).intent;
  const baseline = scoreTrainingMap(generateWorldPlanWithReport(applyMapTraining(intent, state)));
  const challenger = scoreTrainingMap(generateWorldPlanWithReport(applyMapTraining(intent, candidate)));
  const gain = challenger - baseline;
  const accepted = gain > 0.01;
  return stateSchema.parse({ ...state, attempts: state.attempts + 1,
    accepted: state.accepted + (accepted ? 1 : 0), weights: accepted ? candidate.weights : state.weights,
    lastGain: accepted ? Math.min(100, gain) : 0 });
}
