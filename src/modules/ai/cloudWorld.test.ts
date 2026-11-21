import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generatedGlbToWorld } from './generatedMesh';
import { compactCloudMesh, composeCloudWorld, regionsToCloudItems, textToCloudItems } from './cloudWorld';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { generatedMeshValid } from '../../core/world-plan/generatedMesh';
import { deserializeWorldPlan, serializeWorldPlan } from '../../core/world-plan/migrate';
import { exportWorldToGlb } from '../../core/export/gltf';
import { validateScenePlan } from '../../core/world-plan/validateScene';

function fixture(){const b=readFileSync('src/test/fixtures/trimesh-vertex-colors.glb');return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;}
describe('cloud world construction',()=>{
  it('proposes arbitrary noun phrases and repeated objects, with limited relations and negation',()=>{
    expect(textToCloudItems('مدينة فيها قلعة وتنين و2 تمثال').map(item=>item.prompt)).toEqual(['قلعة','تنين','تمثال','تمثال']);
    const a=textToCloudItems('بيت يمين شجرة بدون تنين');expect(a.map(item=>item.prompt)).toEqual(['بيت','شجرة']);expect(a[0]!.x).toBeGreaterThan(a[1]!.x);
    const b=textToCloudItems('a robot left of a floating castle and 3 bicycles');expect(b).toHaveLength(5);expect(b[0]!.x).toBeLessThan(b[1]!.x);
    expect(textToCloudItems('20 robots')).toHaveLength(17);
  });
  it('reduces and validates generated geometry and builds a complete saveable world with independent objects',async()=>{
    const single=await generatedGlbToWorld(fixture(),'a robot');const object=single.objects[0]!;
    const compressed=compactCloudMesh(object.meta.generatedMesh!,20000);
    expect(generatedMeshValid(compressed)).toBe(true);expect(compressed.data.length).toBeLessThan(object.meta.generatedMesh!.data.length);
    const items=textToCloudItems('a robot and a dragon');
    const second={...object,meta:{...object.meta,generatedMesh:compressed}};
    const result=composeCloudWorld(createEmptyWorldPlan({seed:3}),items,[second,second],'text','a robot and a dragon');
    expect(result.objects).toHaveLength(2);expect(result.objects.map(o=>o.kind==='primitive'&&o.primitive)).toEqual(['generated-mesh','generated-mesh']);
    expect(result.objects[0]!.id).not.toBe(result.objects[1]!.id);expect(validateScenePlan(result).valid).toBe(true);
    expect(deserializeWorldPlan(serializeWorldPlan(result)).objects).toEqual(result.objects);
    expect((await exportWorldToGlb(result)).objectCount).toBe(2);
    const appended=composeCloudWorld(result,items,[second,second],'append','x');
    expect(appended.objects).toHaveLength(4);expect(appended.terrain).toEqual(result.terrain);
    expect(appended.objects.slice(0,2)).toEqual(result.objects);
    expect(()=>composeCloudWorld(result,items,[second],'text','x')).toThrow(/اكتمال/);
  },20000);
  it('maps image regions and sampled colour to independent descriptions and approximate view positions',()=>{
    const red=new Uint8Array(24*24*4);for(let i=0;i<576;i++)red.set([190,55,50,255],i*4);
    const regions=[{classId:4,label:'tree',x:2,y:20,width:10,height:20,pixels:[20*64+2,20*64+3]},{classId:20,label:'car',x:50,y:20,width:10,height:20,pixels:[20*64+50,20*64+51]}];
    const items=regionsToCloudItems(regions,{width:24,height:24,rgba:red});
    expect(items.map(item=>item.prompt)).toEqual(['A single red tree, isolated 3D object','A single red car, isolated 3D object']);
    const screenX=(x:number,z:number)=>x*.758-z*.653;
    expect(screenX(items[0]!.x,items[0]!.z)).toBeLessThan(screenX(items[1]!.x,items[1]!.z));
  });
});
