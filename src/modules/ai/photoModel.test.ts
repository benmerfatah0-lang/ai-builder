import { describe, expect, it } from 'vitest';
import { photoToModel, addPhotoModel, addPhotoModels, isSinglePhotoRequest, type TinyImage } from './photoModel';
import { buildPhotoModelGeometry } from '../../core/scene/photoModel';
import { createBuilding } from '../../core/assets/catalog';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { validateWorldPlan } from '../../core/world-plan/schema';
import { serializeWorldPlan, deserializeWorldPlan } from '../../core/world-plan/migrate';
import { createMemoryWorldRepository } from '../../core/persistence/worldRepository';
import { exportWorldToGlb } from '../../core/export/gltf';
import type { ImageReference } from './imageReferences';

const source: ImageReference = { title: 'File:Elephant.png', url: 'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', license_name: 'CC BY-SA 4.0', query: 'فيل' };
function fixture(complex = false, transparent = false): TinyImage {
  const width=12, height=12, rgba=new Uint8Array(width*height*4);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const i=(y*width+x)*4, subject=x>=3&&x<=8&&y>=2&&y<=9;
    const bg=complex ? ((x+y)%2 ? 0 : 255) : 255;
    rgba.set(subject ? [120,40,30,255] : [bg,bg,bg,transparent ? 0 : 255], i);
  }
  return { width,height,rgba };
}
describe('bounded single-photo reconstruction', () => {
  it('extracts a silhouette and guesses symmetrical depth for simple and transparent backgrounds', () => {
    for (const image of [fixture(), fixture(false, true)]) {
      const model=photoToModel(image,source);
      expect([model.width,model.height,model.cells.length]).toEqual([6,8,48]);
      expect(model.cells.some((cell) => cell.depth > 1)).toBe(true);
      expect(model.cells.every((cell) => cell.color === '#78281e')).toBe(true);
      const geometry = buildPhotoModelGeometry(model);
      geometry.computeBoundingBox();
      expect(geometry.getAttribute('position').count).toBe(48*36);
      expect(geometry.boundingBox!.min.z).toBeCloseTo(-geometry.boundingBox!.max.z);
      expect(geometry.getAttribute('color').count).toBe(48*36);
      geometry.dispose();
    }
  });
  it('refuses complex backgrounds and malformed images', () => {
    expect(() => photoToModel(fixture(true),source)).toThrow(/خلفية الصورة معقدة/);
    expect(() => photoToModel({ width: 24,height: 24,rgba:new Uint8Array(3) },source)).toThrow();
  });
  it('only creates an explicitly marked thin whole-image slab on request', () => {
    const slab = photoToModel(fixture(true), source, true);
    expect(slab.mode).toBe('full-image-slab');
    expect([slab.width, slab.height, slab.cells.length]).toEqual([12,12,144]);
    expect(slab.cells.every((cell) => cell.depth === 1)).toBe(true);
  });
  it('restricts automatic changes to simple additions of one topic', () => {
    expect(isSinglePhotoRequest('أضف لي فيل','فيل','edit')).toBe(true);
    expect(isSinglePhotoRequest('عالم فيه فيل','فيل','generate')).toBe(true);
    for (const input of ['احذف فيل','أضف فيلين','أضف 3 فيل','أضف فيل يمين البيت','أضف فيل أحمر']) expect(isSinglePhotoRequest(input,'فيل','edit')).toBe(false);
    expect(isSinglePhotoRequest('عالم فيه فيل وبيت','فيل','generate')).toBe(false);
    expect(isSinglePhotoRequest('أضف فيلين','فيلين','edit')).toBe(false);
    expect(isSinglePhotoRequest('add elephants','elephants','edit')).toBe(false);
  });
  it('persists actual geometry and attribution, validates source and exports vertices/colors and source in GLB', async () => {
    const model = photoToModel(fixture(), source);
    const empty = createEmptyWorldPlan({ seed: 1 });
    const { plan, object } = addPhotoModel({ ...empty, terrain: { ...empty.terrain, style:'flat', heightScale:0 } }, model, 'فيل');
    expect(validateWorldPlan(plan).success).toBe(true);
    expect(deserializeWorldPlan(serializeWorldPlan(plan))).toEqual(plan);
    const repo = createMemoryWorldRepository(); await repo.save(plan); expect(await repo.load(plan.id)).toEqual(plan);
    const badSource = { ...plan, objects: [{ ...object, meta: { ...object.meta, photoModel: { ...model, source: { ...model.source, url: 'https://evil.test/' } } } }] };
    expect(validateWorldPlan(badSource).success).toBe(false);
    expect(validateWorldPlan({ ...plan, objects: [{ ...object, meta: { ...object.meta, photoModel: undefined } }] }).success).toBe(false);
    const flooded = { ...empty, terrain: { ...empty.terrain, style: 'flat' as const, heightScale: 0, waterLevel: 100 } };
    expect(() => addPhotoModel(flooded, model, 'فيل')).toThrow(/لم أجد مكاناً/);
    const exportResult = await exportWorldToGlb(plan);
    const data = new DataView(exportResult.buffer);
    const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(exportResult.buffer,20,data.getUint32(12,true))).trim());
    expect(gltf.nodes.some((node: { extras?: { imageSource?: { author?: string } } }) => node.extras?.imageSource?.author === 'Alice')).toBe(true);
    expect(gltf.meshes.some((mesh: { primitives: { attributes: Record<string, number> }[] }) => mesh.primitives.some((p) => p.attributes.COLOR_0 !== undefined))).toBe(true);
  }, 20000);
  it('places copies on the requested side of a unique known object and refuses ambiguous anchors', () => {
    const model = photoToModel(fixture(), source);
    const empty = createEmptyWorldPlan({ seed: 1 });
    const house = createBuilding('house', [0,0,0], () => 0.5);
    const base = { ...empty, objects:[house], terrain:{ ...empty.terrain, style:'flat' as const, heightScale:0 } };
    const next = addPhotoModels(base, model, 'فيل', 2, {assetId:'house',direction:'right'});
    expect(next.objects).toHaveLength(3);
    expect(deserializeWorldPlan(serializeWorldPlan(next))).toEqual(next);
    expect(next.objects.slice(1).every((object) => object.transform.position[0] > house.transform.position[0])).toBe(true);
    expect(() => addPhotoModels({ ...base, objects:[house,createBuilding('house', [20,0,0], () => 0.5)] }, model, 'فيل', 1, {assetId:'house',direction:'right'})).toThrow(/عنصر مرجعي واحد/);
    expect(() => addPhotoModels(base, model, 'فيل', 10000)).toThrow(/سعة العالم/);
    expect(base.objects).toHaveLength(1);
  });

});
