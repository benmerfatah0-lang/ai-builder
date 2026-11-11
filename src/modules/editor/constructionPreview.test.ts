import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { addPhotoModels, photoToModel } from '../ai/photoModel';
import { constructionStage } from './constructionPreview';
import type { ImageReference } from '../ai/imageReferences';

const source: ImageReference = { title: 'File:Elephant.png', url: 'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0', query: 'فيل' };
const bytes = new Uint8Array(12*12*4);
for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);

describe('temporary map construction', () => {
  it('renders placed cells bottom-up without changing either the saved or prepared plan', () => {
    const model = photoToModel({width:12,height:12,rgba:bytes}, source);
    const base = createEmptyWorldPlan({seed:1});
    const before = addPhotoModels(base, model, 'فيل', 1);
    const after = addPhotoModels(before, model, 'زرافة', 2);
    const stage = constructionStage({base,before,after}, 2, 'one', 'زرافة', model.height);
    expect(stage.base).toBe(base);
    expect(base.objects).toHaveLength(0);
    expect(stage.objects).toHaveLength(3);
    expect(stage.objects[0]!.meta.photoModel!.cells).toHaveLength(model.cells.length);
    expect(stage.objects.slice(1).every((o) => o.meta.photoModel!.cells.length === 12 && o.meta.photoModel!.cells.every(c => c.y >= model.height-2))).toBe(true);
    expect(after.objects.slice(1).every((o) => o.meta.photoModel!.cells.length === model.cells.length)).toBe(true);
    expect(stage.objects.slice(1).map((o) => o.transform)).toEqual(after.objects.slice(1).map((o) => o.transform));
  });
});
