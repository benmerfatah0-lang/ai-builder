import { describe, expect, it } from 'vitest';
import { polygonMask } from './manualPhotoMask';
import { photoToModel } from './photoModel';
import type { ImageReference } from './imageReferences';
const source: ImageReference = { title:'File:x.jpg', url:'https://commons.wikimedia.org/wiki/File:x.jpg', thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/250px-x.jpg',author:'a',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0',query:'x' };
describe('user-selected outline for complex backgrounds', () => {
  it('keeps only pixels in a user-drawn outline and preserves color and source', () => {
    const rgba=new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for(let x=0;x<12;x++) rgba.set(x>=3&&x<9&&y>=2&&y<10 ? [100,20,30,255] : [(x+y)%2 ? 0 : 255,255,0,255],(y*12+x)*4);
    const mask=polygonMask(12,12,[{x:3,y:2},{x:9,y:2},{x:9,y:10},{x:3,y:10}]);
    const image={width:12,height:12,rgba};
    expect(() => photoToModel(image,source)).toThrow(/خلفية الصورة معقدة/);
    const model=photoToModel(image,source,false,mask);
    expect([model.mode,model.width,model.height,model.cells.length]).toEqual(['manual-silhouette',6,8,48]);
    expect(model.cells.every((c)=>c.color==='#64141e')).toBe(true);
    expect(model.source).toMatchObject({title:source.title,author:source.author});
  });
  it('rejects invalid or tiny masks without constructing anything', () => {
    expect(() => polygonMask(12,12,[{x:0,y:0},{x:1,y:1}])).toThrow();
    expect(() => polygonMask(12,12,[{x:0,y:0},{x:1,y:1},{x:50,y:2}])).toThrow();
    expect(() => photoToModel({width:2,height:2,rgba:new Uint8Array(16)},source,false,new Uint8Array(2))).toThrow();
  });
});
