/**
 * Tiny, transparent trainable shape model. Each class learns the running mean
 * of approved dimension/detail examples. It is not a language or mesh neural
 * network. Geometry is still constructed by bounded procedural builders.
 */
import { z } from 'zod';
import type { WorldObject } from '../../core/world-plan/schema';
import type { Rng } from '../../core/generation/rng';

const sampleSchema = z.tuple([
  z.number().finite().min(0.55).max(1.8), z.number().finite().min(0.55).max(1.8),
  z.number().finite().min(0.55).max(1.8), z.number().finite().min(0.7).max(1.3),
]);
const classSchema = z.object({ count: z.number().int().min(1).max(100000), mean: sampleSchema }).strict();
const modelSchema = z.object({ version: z.literal(1), house: classSchema, tree: classSchema, rock: classSchema }).strict();
export type ShapeModel = z.infer<typeof modelSchema>;
type ShapeClass = 'house' | 'tree' | 'rock';
type ShapeSample = z.infer<typeof sampleSchema>;
const KEY = 'world-builder-shape-model-v1';

// Synthetic examples designed for this application, not downloaded models.
const INITIAL: Record<ShapeClass, ShapeSample[]> = {
  house: [[0.9, 0.9, 1, 0.85], [1, 1, 1, 1], [1.1, 1.1, 1, 1.15]],
  tree: [[0.9, 0.9, 0.9, 0.85], [1, 1, 1, 1], [1.1, 1.1, 1.1, 1.15]],
  rock: [[0.9, 0.8, 0.95, 0.9], [1, 1, 1, 1], [1.1, 1.2, 1.05, 1.1]],
};
function average(samples: ShapeSample[]) {
  return { count: samples.length, mean: [0, 1, 2, 3].map((i) => samples.reduce((sum, item) => sum + item[i]!, 0) / samples.length) as ShapeSample };
}
export function initialShapeModel(): ShapeModel {
  return { version: 1, house: average(INITIAL.house), tree: average(INITIAL.tree), rock: average(INITIAL.rock) };
}
export function readShapeModel(storage: Pick<Storage, 'getItem'>): ShapeModel {
  try {
    const raw = storage.getItem(KEY);
    return raw ? modelSchema.parse(JSON.parse(raw)) : initialShapeModel();
  } catch { return initialShapeModel(); }
}
export function saveShapeModel(storage: Pick<Storage, 'setItem'>, model: ShapeModel): void {
  storage.setItem(KEY, JSON.stringify(modelSchema.parse(model)));
}
export function resetShapeModel(storage: Pick<Storage, 'removeItem'>): ShapeModel {
  storage.removeItem(KEY);
  return initialShapeModel();
}
export function shapeClass(object: WorldObject): ShapeClass | null {
  if (object.kind === 'building' && object.variant === 'house') return 'house';
  if (object.kind === 'tree' && object.variant === 'broadleaf') return 'tree';
  if (object.kind === 'rock' && object.variant === 'boulder') return 'rock';
  return null;
}
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
/** Update one class with a user-approved example, online mean minimises squared error. */
export function trainShapeModel(model: ShapeModel, object: WorldObject): ShapeModel {
  const kind = shapeClass(object);
  if (!kind) throw new Error('اختر بيتاً أو شجرة عريضة الأوراق أو صخرة مستديرة أولاً.');
  const current = model[kind];
  if (current.count >= 100000) throw new Error('بلغ النموذج حد أمثلة التدريب.');
  const scale = object.transform.scale;
  const sample: ShapeSample = [clamp(scale[0], 0.55, 1.8), clamp(scale[1], 0.55, 1.8),
    clamp(scale[2], 0.55, 1.8), clamp(object.meta.learnedShape?.detail ?? 1, 0.7, 1.3)];
  const count = current.count + 1;
  const mean = current.mean.map((value, i) => value + (sample[i]! - value) / count) as ShapeSample;
  return modelSchema.parse({ ...model, [kind]: { count, mean } });
}
/** Sample a bounded procedural design from the learned class parameters. */
export function applyShapeModel(object: WorldObject, model: ShapeModel, rng: Rng): WorldObject {
  const kind = shapeClass(object);
  if (!kind) return object;
  const mean = model[kind].mean;
  const scale = [0, 1, 2].map((i) => clamp(mean[i]! * (0.9 + rng() * 0.2), 0.55, 1.8)) as [number, number, number];
  const detail = clamp(mean[3] * (0.85 + rng() * 0.3), 0.7, 1.3);
  const seed = Math.floor(rng() * 4294967296);
  const dimensions: [number, number, number] = kind === 'house' ? [3.8, 5.1, 3.8] : kind === 'tree' ? [4.2, 4.6, 4.2] : [2.5, 2.2, 2.5];
  return { ...object, transform: { ...object.transform, scale }, meta: { ...object.meta, dimensions, source: 'procedural', learnedShape: { detail, seed } } };
}
