import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkGeneratedGlb, generatedGlbToWorld } from './generatedMesh';
import { deserializeWorldPlan, serializeWorldPlan } from '../../core/world-plan/migrate';
import { createWorldObjectGroup, disposeObject3D } from '../../core/scene/sceneBuilder';
import { exportWorldToGlb } from '../../core/export/gltf';
import { validateScenePlan } from '../../core/world-plan/validateScene';
import { base64ToBytes, bytesToBase64 } from '../../core/world-plan/generatedMesh';

function fixture():ArrayBuffer {
  const bytes=readFileSync('src/test/fixtures/trimesh-vertex-colors.glb');
  return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
}
function replaceJson(buffer:ArrayBuffer, change:(doc:any)=>void):ArrayBuffer {
  const v=new DataView(buffer); const oldLength=v.getUint32(12,true);
  const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,oldLength))); change(doc);
  const text=JSON.stringify(doc); const length=Math.ceil(text.length/4)*4;
  const out=new Uint8Array(20+length+buffer.byteLength-(20+oldLength)); const o=new DataView(out.buffer);
  out.set(new Uint8Array(buffer,0,20));o.setUint32(8,out.length,true);o.setUint32(12,length,true);
  out.fill(0x20,20,20+length);out.set(new TextEncoder().encode(text),20);
  out.set(new Uint8Array(buffer,20+oldLength),20+length);return out.buffer;
}
describe('generated geometry',()=>{
  it('turns a trimesh-style GLB into a renderable, saveable and exportable world',async()=>{
    const original=fixture();checkGeneratedGlb(original);
    const plan=await generatedGlbToWorld(original,'a strange new sculpture');
    expect(plan.objects).toHaveLength(1);expect(plan.objects[0]).toMatchObject({kind:'primitive',primitive:'generated-mesh'});
    expect(validateScenePlan(plan).valid).toBe(true);
    const restored=deserializeWorldPlan(serializeWorldPlan(plan));
    const group=createWorldObjectGroup(restored.objects[0]!,false);
    group.updateMatrixWorld(true);const box=new THREE.Box3().setFromObject(group);
    expect(box.min.y).toBeCloseTo(0,4);expect(box.max.y).toBeCloseTo(8,3);
    let count=0;group.traverse(item=>{if(item instanceof THREE.Mesh){count++;expect(item.geometry.getAttribute('color')).toBeDefined();}});
    expect(count).toBe(1);disposeObject3D(group);
    const exported=await exportWorldToGlb(restored);expect(new DataView(exported.buffer).getUint32(0,true)).toBe(0x46546c67);
  },20000);
  it('refuses external resources and compressed extensions before parsing',()=>{
    expect(()=>checkGeneratedGlb(replaceJson(fixture(),doc=>{doc.buffers[0].uri='https://evil.example/file'}))).toThrow();
    expect(()=>checkGeneratedGlb(replaceJson(fixture(),doc=>{doc.extensionsUsed=['KHR_draco_mesh_compression']}))).toThrow();
    expect(()=>checkGeneratedGlb(new ArrayBuffer(20))).toThrow();
  });
  it('allows bounded quantized and unlit assets but rejects other required extensions',async()=>{
    const accepted=replaceJson(fixture(),doc=>{doc.extensionsUsed=['KHR_mesh_quantization','KHR_materials_unlit'];doc.extensionsRequired=['KHR_mesh_quantization'];});
    checkGeneratedGlb(accepted);
    const plan=await generatedGlbToWorld(accepted,'Tree',undefined,'3DAssets.dev');
    expect(plan.objects[0]?.meta.generatedMesh).toBeDefined();expect(plan.description).toContain('3DAssets.dev');
    expect(()=>checkGeneratedGlb(replaceJson(fixture(),doc=>{doc.extensionsRequired=['EXT_meshopt_compression'];}))).toThrow();
  });
  it('rejects corrupted indices and inconsistent generated metadata',async()=>{
    const plan=await generatedGlbToWorld(fixture(),'sculpture');const data=plan.objects[0]!.meta.generatedMesh!;
    const bytes=base64ToBytes(data.data);new DataView(bytes.buffer).setUint32(data.vertices*12,0xffffffff,true);data.data=bytesToBase64(bytes);
    expect(validateScenePlan(plan).valid).toBe(false);
  });
});
