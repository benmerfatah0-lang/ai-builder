import type { WorldObject, WorldPlan } from '../../core/world-plan/schema';

/** Transient render-only state: never goes into project history, persistence or export. */
export interface PreparedConstruction { base: WorldPlan; before: WorldPlan; after: WorldPlan }
export interface ConstructionPreview { base: WorldPlan; objects: WorldObject[]; key: string; label: string; rows: number; total: number }
export function constructionStage(prepared: PreparedConstruction, rows: number, key: string, label: string, total: number): ConstructionPreview {
  const saved = new Set(prepared.base.objects.map((object) => object.id));
  const previous = new Set(prepared.before.objects.map((object) => object.id));
  const objects = prepared.after.objects.filter((object) => !saved.has(object.id)).map((object) => {
    if (previous.has(object.id) || !object.meta.photoModel) return object;
    const photo = object.meta.photoModel;
    return { ...object, meta: { ...object.meta, photoModel: { ...photo, cells: photo.cells.filter((cell) => cell.y >= photo.height - rows) } } };
  });
  return { base: prepared.base, objects, rows, total, key, label };
}
