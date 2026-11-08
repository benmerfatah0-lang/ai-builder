import { describe, expect, it } from 'vitest';
import { colorRegions, createImageScene, type SceneMark } from './imageScene';
import { photoToModel } from './photoModel';
import { serializeWorldPlan, deserializeWorldPlan } from '../../core/world-plan/migrate';
import { buildWorldScene, findNodeObject, disposeObject3D } from '../../core/scene/sceneBuilder';
import { exportWorldToGlb } from '../../core/export/gltf';
const image=()=>{const width=12,height=12,rgba=new Uint8Array(576);for(let y=0;y<12;y++)for(let x=0;x<12;x++)rgba.set(x<6?[20,90,30,255]:[30,100,190,255],4*(y*12+x));return {width,height,rgba};};
const mark=(type:SceneMark['type'],x:number,depth:number):SceneMark=>({id:type,name:type,type,x,y:.5,depth,size:1});
describe('guided scene assembly from a local image',()=>{
  it('identifies colour regions, not semantic classes',()=>{
    const regions=colorRegions(image()); expect(regions).toHaveLength(2); expect(regions.map((r)=>r.area)).toEqual([72,72]);
    expect(regions[0]!.x).toBeCloseTo(.25); expect(regions[1]!.x).toBeCloseTo(.75);
    expect(regions.every((r)=>!('type' in r))).toBe(true);
  });
  it('creates only marked independent objects at separate depths and retains a user photo silhouette',async()=>{
    const pixels=image(), mask=new Uint8Array(144);for(let y=2;y<10;y++)for(let x=2;x<8;x++) mask[y*12+x]=1;
    const model=photoToModel(pixels,{kind:'local',title:'photo.jpg',author:'صورة من الجهاز',license_name:'غير محدد'},false,mask,'smooth');
    const plan=createImageScene('منظر',[mark('broadleaf',.2,.2),mark('water',.5,.5),{...mark('photo',.8,.9),name:'شكل',model}],17);
    expect(plan.objects).toHaveLength(3); expect(plan.terrain.waterLevel).toBeNull();
    expect(plan.objects.map(o=>o.transform.position)).toEqual([[-8.4,0,8.399999999999999],[0,0,0],[8.400000000000002,0,-11.2]]);
    expect(plan.objects.map(o=>o.kind)).toEqual(['tree','primitive','primitive']);
    expect(deserializeWorldPlan(serializeWorldPlan(plan)).objects[2]!.meta.photoModel?.source).toMatchObject({kind:'local',title:'photo.jpg'});
    const scene=buildWorldScene(plan,{includeLights:false,terrainResolutionCap:16});
    for(const o of plan.objects) expect(findNodeObject(scene,o.id)).toBeTruthy();
    disposeObject3D(scene);
    const output=await exportWorldToGlb(plan); const view=new DataView(output.buffer);
    const gltf=JSON.parse(new TextDecoder().decode(new Uint8Array(output.buffer,20,view.getUint32(12,true))).trim());
    expect(gltf.nodes.some((n:{extras?:{imageSource?:{kind?:string;title?:string}}})=>n.extras?.imageSource?.kind==='local'&&n.extras?.imageSource?.title==='photo.jpg')).toBe(true);
  },20000);
  it('rejects malformed coordinates, whole-image slabs, zero annotations and excessive photo cells',()=>{
    expect(()=>createImageScene('',[],1)).toThrow();
    expect(()=>createImageScene('',[{...mark('box',.5,.5),depth:2}],1)).toThrow();
    const pixels=image(); const slab=photoToModel(pixels,{kind:'local',title:'photo.png',author:'a',license_name:'unknown'},true);
    expect(()=>createImageScene('',[{...mark('photo',.5,.5),model:slab}],1)).toThrow(/عنصراً واحداً/);
    const full=photoToModel(pixels,{kind:'local',title:'photo.png',author:'a',license_name:'unknown'},false,new Uint8Array(144).fill(1),'smooth');
    expect(()=>createImageScene('',Array.from({length:30},(_,i)=>({...mark('photo',.5,.5),id:String(i),model:full})),1)).not.toThrow();
    const large={width:24,height:24,rgba:new Uint8Array(24*24*4).fill(255)};
    const largeModel=photoToModel(large,{kind:'local',title:'photo.png',author:'a',license_name:'unknown'},false,new Uint8Array(576).fill(1),'smooth');
    expect(()=>createImageScene('',Array.from({length:9},(_,i)=>({...mark('photo',.5,.5),id:String(i),model:largeModel})),1)).toThrow(/سعة المشروع/);
  });
});
