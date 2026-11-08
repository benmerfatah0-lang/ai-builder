import { photoModelSchema, type PhotoModel, type WorldPlan, type PrimitiveObject, MAX_WORLD_OBJECTS, MAX_PHOTO_CELLS, validateWorldPlan } from '../../core/world-plan/schema';
import { createTransform } from '../../core/world-plan/factory';
import { createMeta } from '../../core/world-plan/objectMeta';
import { createId } from '../../core/utils/id';
import { photoModelDimensions } from '../../core/scene/photoModel';
import { footprintFromObject, footprintFromRect, PlacementLedger } from '../../core/generation/placement';
import { createTerrainSampler } from '../../core/generation/terrain';
import { worldTransformOf } from '../../core/world-plan/hierarchy';
import type { ImageReference } from './imageReferences';

export interface TinyImage { width: number; height: number; rgba: Uint8Array }
/** Isolate a simple transparent or uniform-edged background. No object recognition. */
export function photoToModel(image: TinyImage, source: ImageReference): PhotoModel {
  const { width: w, height: h, rgba } = image;
  if (w < 2 || h < 2 || w > 24 || h > 24 || rgba.length !== w * h * 4) throw new Error('بيانات الصورة غير صالحة.');
  const pixel = (i: number) => [rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!, rgba[i * 4 + 3]!] as const;
  const edges: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!x || !y || x === w - 1 || y === h - 1) edges.push(y * w + x);
  const transparent = edges.filter((i) => pixel(i)[3] < 128).length > edges.length * .25;
  const opaqueEdges = edges.filter((i) => pixel(i)[3] >= 128);
  const median = (channel: number) => opaqueEdges.map((i) => pixel(i)[channel]!).sort((a, b) => a - b)[Math.floor(opaqueEdges.length / 2)] ?? 255;
  const background = [median(0), median(1), median(2)];
  const close = (i: number) => {
    const [r,g,b,a] = pixel(i);
    if (a < 128) return true;
    if (transparent) return false;
    return Math.hypot(r-background[0]!, g-background[1]!, b-background[2]!) < 55;
  };
  if (!transparent && edges.filter(close).length < edges.length * .8) throw new Error('خلفية الصورة معقدة؛ اختر صورة لجسم واحد على خلفية بسيطة أو شفافة.');
  const removed = new Uint8Array(w * h), queue: number[] = [];
  for (const i of edges) if (close(i) && !removed[i]) { removed[i] = 1; queue.push(i); }
  for (let index = 0; index < queue.length; index++) {
    const i = queue[index]!, x = i % w, y = Math.floor(i / w);
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const xx=x+dx, yy=y+dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const next=yy*w+xx;
      if (!removed[next] && close(next)) { removed[next]=1; queue.push(next); }
    }
  }
  const foreground = Array.from({ length: w*h }, (_, i) => i).filter((i) => !removed[i] && pixel(i)[3] >= 128);
  if (foreground.length < 6 || foreground.length > w*h*.8) throw new Error('تعذّر فصل شكل واضح من الصورة؛ جرّب صورة أخرى بخلفية بسيطة.');
  const minX=Math.min(...foreground.map((i) => i%w)), maxX=Math.max(...foreground.map((i) => i%w));
  const minY=Math.min(...foreground.map((i) => Math.floor(i/w))), maxY=Math.max(...foreground.map((i) => Math.floor(i/w)));
  const mask = new Uint8Array(w*h); for (const i of foreground) mask[i]=1;
  const cells = foreground.map((i) => {
    const x=i%w, y=Math.floor(i/w);
    // The depth is a simple symmetric assumption based on distance to the silhouette edge.
    let distance=1;
    while (distance < 12 && x-distance >= 0 && x+distance < w && y-distance >= 0 && y+distance < h &&
      mask[y*w+x-distance] && mask[y*w+x+distance] && mask[(y-distance)*w+x] && mask[(y+distance)*w+x]) distance++;
    const [r,g,b] = pixel(i);
    return { x: x-minX, y: y-minY, depth: distance, color: `#${[r,g,b].map((v) => v.toString(16).padStart(2,'0')).join('')}` };
  });
  return photoModelSchema.parse({ width: maxX-minX+1, height: maxY-minY+1, cells,
    source: { title: source.title, url: source.url, author: source.author, license_name: source.license_name, license_url: source.license_url } });
}

/** Place one approx model safely, without changing existing objects or terrain. */
export function addPhotoModel(plan: WorldPlan, model: PhotoModel, name: string): { plan: WorldPlan; object: PrimitiveObject } {
  if (plan.objects.length >= MAX_WORLD_OBJECTS) throw new Error('العالم ممتلئ؛ لم يُضف المجسم.');
  const safe = photoModelSchema.parse(model);
  if (plan.objects.reduce((sum, object) => sum + (object.meta.photoModel?.cells.length ?? 0), 0) + safe.cells.length > MAX_PHOTO_CELLS) throw new Error('وصلت للحد المخصص لمجسمات الصور على الهاتف.');
  const dimensions = photoModelDimensions(safe);
  const object: PrimitiveObject = { id: createId('obj'), name: name.slice(0, 80) || 'Photo approximation', parentId: null,
    transform: createTransform(), visible: true, locked: false, kind: 'primitive', primitive: 'photo-model', color: '#ffffff',
    meta: { ...createMeta({ category: 'prop', geometry: 'primitive.photo-model', dimensions, status: 'edited' }), photoModel: safe } };
  const ledger = new PlacementLedger();
  for (const existing of plan.objects) {
    const transform = worldTransformOf(plan, existing.id);
    if (!transform) throw new Error('تعذّر فحص موقع عنصر؛ لم يُضف المجسم.');
    const bounds = footprintFromObject({ ...existing, transform, meta: { ...existing.meta, collision: { shape: 'box', blocking: true } } });
    if (bounds) ledger.add(bounds, existing.id);
  }
  const sampler = createTerrainSampler(plan.terrain, plan.seed), radius=plan.terrain.size*.36;
  for (let n=0; n<160; n++) {
    const angle = n * 2.399963, dist = n === 0 ? 0 : radius * Math.sqrt(n/160);
    const x=Math.cos(angle)*dist, z=Math.sin(angle)*dist, y=sampler.heightAt(x,z);
    const samples = [[-1,-1],[-1,1],[1,-1],[1,1]].map(([dx,dz]) => sampler.heightAt(x + dx! * dimensions[0]/2, z + dz! * dimensions[2]/2));
    if (samples.some((height) => Math.abs(height-y) > 1.2 || (plan.terrain.waterLevel !== null && height < plan.terrain.waterLevel + .35))) continue;
    if (plan.terrain.waterLevel !== null && y < plan.terrain.waterLevel + .35) continue;
    if (!ledger.isFree(footprintFromRect(x,z,dimensions[0],dimensions[2]), .75)) continue;
    const placed = { ...object, transform: createTransform([x,y,z]) };
    const next = { ...plan, objects: [...plan.objects, placed], updatedAt: new Date().toISOString() };
    if (!validateWorldPlan(next).success) throw new Error('لم يجتز المجسم فحص المشروع.');
    return { plan: next, object: placed };
  }
  throw new Error('لم أجد مكاناً مناسباً للمجسم؛ لم يتغير العالم.');
}

/** Only one simple unnamed placement: no counts, spatial relations or modifiers guessed. */
export function isSinglePhotoRequest(text: string, term: string, mode: 'edit' | 'generate'): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[\u064b-\u065f\u0670]/g, '').trim().replace(/\s+/g, ' ');
  const word = normalize(term).replace(/^ال/u, '');
  if (!/^[\p{L}]+(?: [\p{L}]+){0,2}$/u.test(word)) return false;
  // Refuse obvious dual/plural suffixes rather than silently adding only one.
  if (/(?:ين|ان|ات)$/u.test(word) || /s$/i.test(word)) return false;
  let input = normalize(text);
  if (mode === 'edit') {
    const prefix = /^(?:اضف|اضيف|ضع|اصنع|انشئ|ابني|اعمل|صمم|add|ajoute|ajouter)\s+(?:(?:لي|a|an|un|une)\s+)?/u;
    if (!prefix.test(input)) return false;
    input = input.replace(prefix, '');
  } else {
    input = input.replace(/^(?:اصنع|انشئ|ابني|اعمل|صمم|اريد|create|make|build)\s+(?:لي\s+)?/u, '');
    input = input.replace(/^(?:عالم|عالمًا|مشهد|خريطه|world|scene|map)\s+(?:فيه|فيها|مع|with|containing)\s+/u, '');
    input = input.replace(/^(?:a|an|un|une)\s+/u, '');
  }
  return input.replace(/^ال/u, '') === word;
}
