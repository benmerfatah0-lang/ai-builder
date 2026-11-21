// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {semanticRegions,regionsToSceneMarks} from './semanticScene';
import {createImageScene} from './imageScene';

afterEach(()=>vi.restoreAllMocks());
describe('automatic scene photo shapes',()=>{
  it('crops one classified component, keeps the attribution and makes a pixel shape, not a full photo slab',()=>{
    const draw=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(function(this:HTMLCanvasElement){
      const canvas=this;return {drawImage:draw,getImageData:()=>({data:new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255)})} as unknown as CanvasRenderingContext2D;
    });
    const map=new Uint8Array(4096).fill(2);for(let y=12;y<24;y++)for(let x=10;x<22;x++)map[y*64+x]=76;
    const {regions}=semanticRegions(map);
    const image={naturalWidth:640,naturalHeight:320} as HTMLImageElement;
    const source={kind:'local' as const,title:'scene.png',author:'صورة من الجهاز',license_name:'غير محدد'};
    const {marks,failed}=regionsToSceneMarks(regions,image,source,'قارب بكسلي');
    expect(failed).toEqual([]);expect(marks).toHaveLength(1);expect(marks[0]?.type).toBe('photo');
    expect(marks[0]?.model).toMatchObject({mode:'silhouette',meshStyle:'blocky',source});
    expect(draw.mock.calls[0]?.slice(1,5)).toEqual([100,60,120,60]);
    const world=createImageScene('test',marks,5);expect(world.objects[0]?.kind).toBe('primitive');
  });
});
