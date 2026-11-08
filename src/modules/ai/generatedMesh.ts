import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { bytesToBase64, MAX_GENERATED_VERTICES, MAX_GENERATED_INDICES, MAX_GENERATED_DATA, type GeneratedMeshData } from '../../core/world-plan/generatedMesh';
import { createEmptyWorldPlan, createTransform } from '../../core/world-plan/factory';
import { createMeta } from '../../core/world-plan/objectMeta';
import { createId } from '../../core/utils/id';
import { validateWorldPlan, type WorldPlan } from '../../core/world-plan/schema';

const MAX_GLB_BYTES = 12_000_000;

/** Reject remote resources, compressed extensions, oversized accessors and malformed GLB before invoking the loader. */
export function checkGeneratedGlb(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 24 || buffer.byteLength > MAX_GLB_BYTES) throw new Error('حجم ملف المجسم غير مدعوم.');
  const v = new DataView(buffer);
  if (v.getUint32(0,true)!==0x46546c67 || v.getUint32(4,true)!==2 || v.getUint32(8,true)!==buffer.byteLength || v.getUint32(16,true)!==0x4e4f534a) throw new Error('ملف المجسم ليس GLB صالحاً.');
  const jsonLength=v.getUint32(12,true);
  if (!jsonLength || jsonLength > 2_000_000 || 20+jsonLength+8 > buffer.byteLength) throw new Error('ملف المجسم غير صالح.');
  const binOffset=20+jsonLength;
  if(v.getUint32(binOffset+4,true)!==0x004e4942 || binOffset+8+v.getUint32(binOffset,true)!==buffer.byteLength) throw new Error('بيانات المجسم غير مكتملة.');
  let doc: any;
  try { doc=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,jsonLength))); } catch { throw new Error('بيانات المجسم غير صالحة.'); }
  if (!doc || typeof doc!=='object' || doc.asset?.version!=='2.0' || !Array.isArray(doc.meshes) || doc.meshes.length<1 || doc.meshes.length>100 || !Array.isArray(doc.accessors) || doc.accessors.length>1000 || !Array.isArray(doc.buffers) || doc.buffers.length!==1 || doc.buffers[0]?.uri !== undefined || !Number.isInteger(doc.buffers[0]?.byteLength) || doc.buffers[0].byteLength > v.getUint32(binOffset,true) || doc.images?.length || (doc.extensionsUsed ?? []).some((ext:unknown)=>ext!=='KHR_mesh_quantization' && ext!=='KHR_materials_unlit') || (doc.extensionsRequired ?? []).some((ext:unknown)=>ext!=='KHR_mesh_quantization' && ext!=='KHR_materials_unlit')) throw new Error('المجسم يحتوي موارد أو ميزات غير مدعومة.');
  let total=0;
  for (const accessor of doc.accessors) {
    if (!accessor || !Number.isInteger(accessor.count) || accessor.count<0 || accessor.count>MAX_GENERATED_INDICES || accessor.sparse || !['SCALAR','VEC2','VEC3','VEC4'].includes(accessor.type)) throw new Error('المجسم معقد جداً أو غير صالح.');
    total += accessor.count;
  }
  if (total>2_000_000 || (doc.nodes?.length??0)>500 || (doc.bufferViews?.length??0)>1000 || doc.skins?.length || doc.animations?.length) throw new Error('المجسم معقد جداً للهاتف.');
  for (const view of doc.bufferViews ?? []) {
    if (!view || view.buffer !== 0 || !Number.isInteger(view.byteLength) || view.byteLength < 0 || !Number.isInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > doc.buffers[0].byteLength) throw new Error('بيانات المجسم غير صالحة.');
  }
  const nodes = doc.nodes ?? []; const seen = new Set<number>(); const visiting = new Set<number>();
  const visit = (i:number) => {
    if (!Number.isInteger(i) || i < 0 || i >= nodes.length || visiting.has(i)) throw new Error('بنية المجسم غير صالحة.');
    if (seen.has(i)) return;
    visiting.add(i);
    const children=nodes[i]?.children ?? [];
    if (!Array.isArray(children) || children.length > 500) throw new Error('بنية المجسم غير صالحة.');
    for (const child of children) visit(child);
    visiting.delete(i); seen.add(i);
  };
  for (let i=0;i<nodes.length;i++) visit(i);
}

/** Flatten mesh node transforms and vertex colours into a portable, bounded project object. */
export async function generatedGlbToWorld(buffer: ArrayBuffer, prompt: string, worldName?: string, sourceLabel='Shap-E'): Promise<WorldPlan> {
  checkGeneratedGlb(buffer);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  try {
  gltf.scene.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((item) => { if (item instanceof THREE.Mesh) meshes.push(item); });
  let vertices=0, indices=0;
  for (const mesh of meshes) {
    const p=mesh.geometry.getAttribute('position');
    if (!p || p.itemSize!==3 || mesh.morphTargetInfluences || mesh instanceof THREE.SkinnedMesh || (mesh.geometry.getAttribute('color') && mesh.geometry.getAttribute('color').count !== p.count) || (mesh.geometry.index?.count ?? p.count) % 3 !== 0) throw new Error('نوع هندسة المجسم غير مدعوم.');
    vertices += p.count; indices += mesh.geometry.index?.count ?? p.count;
  }
  if (vertices<3 || vertices>MAX_GENERATED_VERTICES || indices<3 || indices>MAX_GENERATED_INDICES || indices%3) throw new Error('المجسم أكبر من سعة الهاتف أو لا يحتوي مثلثات صالحة.');
  const raw = new Uint8Array(vertices*15+indices*4);
  if (Math.ceil(raw.length/3)*4 > MAX_GENERATED_DATA) throw new Error('المجسم أكبر من سعة المشروع.');
  const view=new DataView(raw.buffer); const box=new THREE.Box3(); const point=new THREE.Vector3();
  const scratch: {positions:Float32Array; colors:Uint8Array; indices:Uint32Array}[]=[];
  for (const mesh of meshes) {
    const position=mesh.geometry.getAttribute('position'); const color=mesh.geometry.getAttribute('color');
    const mat=Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const tint=mat && 'color' in mat && mat.color instanceof THREE.Color ? mat.color : new THREE.Color('#ffffff');
    const p=new Float32Array(position.count*3), c=new Uint8Array(position.count*3);
    for(let i=0;i<position.count;i++) {
      point.set(position.getX(i),position.getY(i),position.getZ(i)).applyMatrix4(mesh.matrixWorld);
      if (![point.x,point.y,point.z].every((n)=>Number.isFinite(n) && Math.abs(n)<1_000_000)) throw new Error('إحداثيات المجسم غير صالحة.');
      box.expandByPoint(point); p.set([point.x,point.y,point.z],i*3);
      for(let k=0;k<3;k++) {
        const source=color ? (k===0?color.getX(i):k===1?color.getY(i):color.getZ(i)) : 1;
        const channel=k===0?tint.r:k===1?tint.g:tint.b;
        c[i*3+k]=Math.round(255*THREE.MathUtils.clamp(Number.isFinite(source)?source*channel:1,0,1));
      }
    }
    const index=mesh.geometry.index; const ix=new Uint32Array(index?.count ?? position.count);
    for(let i=0;i<ix.length;i++) { const n=index?index.getX(i):i; if(!Number.isInteger(n)||n<0||n>=position.count) throw new Error('مثلثات المجسم غير صالحة.'); ix[i]=n; }
    scratch.push({positions:p,colors:c,indices:ix});
  }
  const dimensions=box.getSize(new THREE.Vector3()); const largest=Math.max(dimensions.x,dimensions.y,dimensions.z);
  if (!Number.isFinite(largest)||largest<1e-7) throw new Error('المجسم الناتج فارغ.');
  const scale=8/largest, cx=(box.min.x+box.max.x)/2, cz=(box.min.z+box.max.z)/2;
  let offset=0, indexOffset=0;
  for(const part of scratch) {
    const count=part.positions.length/3;
    for(let i=0;i<count;i++) {
      view.setFloat32((offset+i)*12, (part.positions[i*3]!-cx)*scale,true);
      view.setFloat32((offset+i)*12+4, (part.positions[i*3+1]!-box.min.y)*scale,true);
      view.setFloat32((offset+i)*12+8, (part.positions[i*3+2]!-cz)*scale,true);
    }
    for(let i=0;i<part.indices.length;i++) view.setUint32(vertices*12+(indexOffset+i)*4,part.indices[i]!+offset,true);
    raw.set(part.colors,vertices*12+indices*4+offset*3);
    offset+=count; indexOffset+=part.indices.length;
  }
  const data:GeneratedMeshData={vertices,indices,data:bytesToBase64(raw)};
  const plan=createEmptyWorldPlan({name:worldName?.trim().slice(0,80)||'مجسّم مولّد',description:`${sourceLabel}: ${prompt}`.slice(0,500)});
  plan.terrain={...plan.terrain,style:'flat',size:32,heightScale:0,waterLevel:null};
  plan.objects=[{id:createId('obj'),name:prompt.trim().slice(0,80)||'مجسّم مولّد',parentId:null,transform:createTransform(),visible:true,locked:false,kind:'primitive',primitive:'generated-mesh',color:'#ffffff',meta:{...createMeta({category:'prop',geometry:'primitive.generated-mesh',dimensions:[Math.max(.01,dimensions.x*scale),Math.max(.01,dimensions.y*scale),Math.max(.01,dimensions.z*scale)],status:'generated'}),generatedMesh:data}}];
  if (!validateWorldPlan(plan).success) throw new Error('تعذّر التحقق من المجسم الناتج.');
  return plan;
  } finally {
    gltf.scene.traverse((item) => {
      if (!(item instanceof THREE.Mesh)) return;
      item.geometry.dispose();
      for (const material of (Array.isArray(item.material) ? item.material : [item.material])) material.dispose();
    });
  }
}

/** A click explicitly sends the prompt to the shared, anonymous Shap-E Space. */
export async function requestGeneratedGlb(prompt:string, signal:AbortSignal):Promise<ArrayBuffer> {
  const response=await fetch('/api/text-to-3d',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:prompt}),signal});
  if (!response.ok) {
    let error='الخدمة المجانية غير متاحة حالياً أو انتهت حصتها. جرّب لاحقاً.';
    try { const body=await response.json(); if(body.error==='busy') error='يوجد طلب توليد آخر قيد التنفيذ؛ انتظر حتى ينتهي.'; } catch { /* server may not return JSON */ }
    throw new Error(error);
  }
  const contentLength=Number(response.headers.get('Content-Length'));
  if(contentLength>MAX_GLB_BYTES) throw new Error('المجسم الناتج أكبر من سعة الهاتف.');
  if (!response.body) {
    const result=await response.arrayBuffer();
    if(result.byteLength>MAX_GLB_BYTES) throw new Error('المجسم الناتج أكبر من سعة الهاتف.');
    return result;
  }
  const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let size=0;
  try {
    while (true) {
      const {done,value}=await reader.read(); if(done) break;
      size+=value.byteLength;
      if(size>MAX_GLB_BYTES) { await reader.cancel(); throw new Error('المجسم الناتج أكبر من سعة الهاتف.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) { result.set(chunk,offset);offset+=chunk.byteLength; }
  return result.buffer;
}
