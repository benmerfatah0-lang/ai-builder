import { applyShapeModel } from '../../modules/ai/shapeLearner';
import { ASSET_LIBRARY } from '../assets/catalog';
import type { WorldObject, WorldPlan } from '../world-plan/schema';
import { MAX_WORLD_OBJECTS } from '../world-plan/schema';
import { normalizeAssetText } from '../../modules/ai/assetRequests';
import type { AssetDirection, AssetRequest } from '../../modules/ai/assetRequests';
import type { WorldIntent } from '../../modules/ai/types';
import { createTerrainSampler } from './terrain';
import { mulberry32, range } from './rng';
import { footprintFromRect, PlacementLedger } from './placement';

const MAX_REQUESTED_ASSETS = 300;

/** Build explicit requests using the same factories exposed by the asset library. */
export function buildAssetLayout(
  shell: WorldPlan,
  intent: WorldIntent,
  requests: AssetRequest[],
): { plan: WorldPlan; warnings: string[] } {
  const rng = mulberry32(intent.seed);
  const sampler = createTerrainSampler(shell.terrain, intent.seed);
  const ledger = new PlacementLedger();
  const objects: WorldObject[] = [];
  const warnings: string[] = [];
  const normalizedPrompt = normalizeAssetText(intent.prompt);
  if (/(?:امام|خلف|وراء|يمين|يسار|بجانب|بجوار|قرب)\s*(?:ال)?(?:جبل|جبال)/.test(normalizedPrompt) || /(?:in front of|behind|right of|left of|near)\s+(?:the\s+)?mountain/.test(normalizedPrompt)) {
    warnings.push('الجبل تضاريس وليس أصلاً مستقلاً هنا؛ تعذّر ضمان موضع العناصر بالنسبة إليه.');
  }
  const anchors = new Map<number, [number, number, number]>();
  const completed = new Set<number>();
  const visiting = new Set<number>();
  const counters = new Map<string, number>();
  const radius = shell.terrain.size * 0.38;
  const maxObjects = Math.min(MAX_REQUESTED_ASSETS, MAX_WORLD_OBJECTS);

  const assetId = (id: string) => id !== 'tree' ? id :
    intent.biome === 'desert' ? 'cactus' : intent.biome === 'island' ? 'palm' :
      intent.biome === 'forest' || intent.biome === 'mountains' ? 'pine' : 'broadleaf';

  function candidate(direction: AssetDirection | undefined, anchor: [number, number, number] | undefined, attempt: number): [number, number] {
    if (!anchor) {
      if (objects.length === 0 && attempt === 0) return [0, 0];
      const angle = range(rng, 0, Math.PI * 2);
      const distance = Math.sqrt(rng()) * radius;
      return [Math.cos(angle) * distance, Math.sin(angle) * distance];
    }
    const distance = 7 + Math.floor(attempt / 8) * 2 + range(rng, 0, 3);
    const offset = range(rng, -3, 3);
    if (direction === 'left') return [anchor[0] - distance, anchor[2] + offset];
    if (direction === 'right') return [anchor[0] + distance, anchor[2] + offset];
    if (direction === 'front') return [anchor[0] + offset, anchor[2] - distance];
    if (direction === 'behind') return [anchor[0] + offset, anchor[2] + distance];
    const angle = range(rng, 0, Math.PI * 2);
    return [anchor[0] + Math.cos(angle) * distance, anchor[2] + Math.sin(angle) * distance];
  }

  function placeRequest(index: number): void {
    if (completed.has(index)) return;
    const request = requests[index];
    if (!request || visiting.has(index)) return;
    visiting.add(index);
    if (request.relation) placeRequest(request.relation.target);
    const anchor = request.relation ? anchors.get(request.relation.target) : undefined;
    if (request.relation && !anchor) warnings.push(`لم يُعثر على العنصر المرجعي لترتيب ${request.assetId}؛ استُخدم توزيع بديل.`);
    const asset = ASSET_LIBRARY.find((entry) => entry.id === assetId(request.assetId));
    if (!asset) {
      warnings.push(`العنصر ${request.assetId} غير موجود في المكتبة.`);
    } else {
      let placed = 0;
      for (let n = 0; n < request.count && objects.length < maxObjects; n += 1) {
        const baseObject = asset.create(rng, [0, 0, 0]);
        const themed = baseObject.kind === 'building' && baseObject.variant === 'house' && intent.biome === 'desert' && requests.some((item) => item.assetId === 'mine-entrance')
          ? { ...baseObject, color: '#c5a67c', roofColor: '#9b805f', meta: { ...baseObject.meta, desertHouse: true } }
          : baseObject;
        const shaped = intent.shapeModel ? applyShapeModel(themed, intent.shapeModel, rng) : themed;
        const factors = request.size === 'small' ? [0.7, 0.7, 0.7] : request.size === 'large' ? [1.4, 1.4, 1.4] : request.size === 'tall' ? [1, 1.4, 1] : request.size === 'wide' ? [1.4, 1, 1.4] : [1, 1, 1];
        const colored = shaped.kind === 'building' && shaped.variant === 'house' && request.referenceColor && /^#[0-9a-f]{6}$/i.test(request.referenceColor) ? { ...shaped, color: request.referenceColor } : shaped;
        const object: WorldObject = { ...colored, transform: { ...shaped.transform, scale: shaped.transform.scale.map((value, axis) => value * factors[axis]!) as [number, number, number] } };
        let position: [number, number, number] | undefined;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          if (request.relation?.direction === 'near' && attempt >= 48) break;
          const [x, z] = candidate(request.relation?.direction, anchor, attempt);
          if (Math.abs(x) > shell.terrain.size / 2 - 5 || Math.abs(z) > shell.terrain.size / 2 - 5) continue;
          const y = sampler.heightAt(x, z);
          if (shell.terrain.waterLevel !== null && y < shell.terrain.waterLevel + 0.35) continue;
          const [width, , depth] = object.meta.dimensions;
          const footprint = footprintFromRect(x, z, width * object.transform.scale[0], depth * object.transform.scale[2], object.transform.rotation[1]);
          if (!ledger.isFree(footprint, 0.75)) continue;
          ledger.add(footprint, asset.label);
          position = [x, y, z];
          break;
        }
        if (!position) continue;
        const number = (counters.get(asset.id) ?? 0) + 1;
        counters.set(asset.id, number);
        const placedObject: WorldObject = {
          ...object,
          id: `obj_${intent.seed.toString(36)}_${objects.length.toString(36)}`,
          name: `${asset.label} ${number}`,
          transform: { ...object.transform, position },
        };
        objects.push(placedObject);
        if (!anchors.has(index)) anchors.set(index, position);
        placed += 1;
      }
      if (placed < request.count) warnings.push(`تم وضع ${placed} من ${request.count} من ${asset.label} بسبب المساحة أو الماء.`);
    }
    visiting.delete(index);
    completed.add(index);
  }
  requests.forEach((_, index) => placeRequest(index));
  return { plan: { ...shell, objects, description: `Generated from: “${intent.prompt}” · ${objects.length} library assets`.slice(0, 500) }, warnings };
}
