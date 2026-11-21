import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { buildPhotoModelGeometry, photoModelDimensions } from './photoModel';
import { photoToModel, addPhotoModel } from '../../modules/ai/photoModel';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { serializeWorldPlan, deserializeWorldPlan } from '../world-plan/migrate';
import { exportWorldToGlb } from '../export/gltf';
import type { ImageReference } from '../../modules/ai/imageReferences';
const source: ImageReference={title:'File:x.jpg',url:'https://commons.wikimedia.org/wiki/File:x.jpg',thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/250px-x.jpg',author:'Alice',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0',query:'x'};
function image() { const width=12,height=12,rgba=new Uint8Array(width*height*4); for(let y=0;y<height;y++) for(let x=0;x<width;x++) rgba.set(x>=3&&x<=8&&y>=2&&y<=9?[20+x*15,40,30,255]:[255,255,255,255],(y*width+x)*4); return {width,height,rgba}; }
describe('smooth photo geometry', () => {
  it('creates a bounded closed connected surface, smooth normals and interpolated color', () => {
    const model=photoToModel(image(),source,false,undefined,'smooth'), geometry=buildPhotoModelGeometry(model);
    const pos=geometry.getAttribute('position'), normal=geometry.getAttribute('normal'), color=geometry.getAttribute('color'), index=geometry.getIndex()!;
    expect(index).toBeTruthy(); expect(index.count).toBeGreaterThan(0); expect(index.count).toBeLessThan(50_000);
    expect(pos.count).toBe(normal.count); expect(pos.count).toBe(color.count);
    expect(Array.from(pos.array).every(Number.isFinite)).toBe(true);
    expect(Array.from(normal.array).every(Number.isFinite)).toBe(true);
    expect(Array.from(color.array).every(Number.isFinite)).toBe(true);
    expect([...Array(normal.count)].some((_,i)=>Math.abs(normal.getZ(i))>0.05 && Math.abs(normal.getX(i))>0.05)).toBe(true);
    const edges=new Map<string,number>();
    for(let i=0;i<index.count;i+=3) for(let j=0;j<3;j++) { const a=index.getX(i+j), b=index.getX(i+(j+1)%3); const key=a<b?`${a},${b}`:`${b},${a}`; edges.set(key,(edges.get(key)??0)+1); }
    expect([...edges.values()].every((n)=>n===2)).toBe(true);
    geometry.computeBoundingBox(); const size=geometry.boundingBox!.getSize(new Vector3());
    const dimensions=photoModelDimensions(model);
    expect(size.x).toBeLessThanOrEqual(dimensions[0]+1e-5); expect(size.y).toBeLessThanOrEqual(dimensions[1]+1e-5); expect(size.z).toBeLessThanOrEqual(dimensions[2]+1e-5);
    expect(new Set(Array.from(color.array)).size).toBeGreaterThan(3);
    geometry.dispose();
  });
  it('preserves old blocky geometry, and slabs remain flat even if a smooth field is requested', () => {
    const model=photoToModel(image(),source); const old={...model,meshStyle:undefined};
    expect(buildPhotoModelGeometry(old).getAttribute('position').count).toBe(model.cells.length*36);
    const slab=photoToModel(image(),source,true,undefined,'smooth'); expect(slab.meshStyle).toBe('blocky');
    expect(buildPhotoModelGeometry({...slab,meshStyle:'smooth'}).getAttribute('position').count).toBe(slab.cells.length*36);
    expect(buildPhotoModelGeometry({...model,meshStyle:'smooth'},[]).getAttribute('position').count).toBe(0);
  });
  it('preserves smooth style and attribution through project serialization and GLB export', async () => {
    const model=photoToModel(image(),source,false,undefined,'smooth');
    const base=createEmptyWorldPlan({seed:1}); const {plan}=addPhotoModel({...base,terrain:{...base.terrain,style:'flat',heightScale:0}},model,'فيل');
    const restored=deserializeWorldPlan(serializeWorldPlan(plan));
    expect(restored.objects[0]!.meta.photoModel?.meshStyle).toBe('smooth');
    const output=await exportWorldToGlb(restored); const bytes=new DataView(output.buffer);
    const gltf=JSON.parse(new TextDecoder().decode(new Uint8Array(output.buffer,20,bytes.getUint32(12,true))).trim());
    expect(gltf.nodes.some((n:{extras?:{imageMeshStyle?:string;imageSource?:{author?:string}}})=>n.extras?.imageMeshStyle==='smooth' && n.extras?.imageSource?.author==='Alice')).toBe(true);
    expect(gltf.meshes.some((m:{primitives:{attributes:Record<string,number>}[]})=>m.primitives.some(p=>p.attributes.NORMAL!==undefined && p.attributes.COLOR_0!==undefined))).toBe(true);
  },20000);
  it('bounds a maximum-size image and returns independently disposable cached geometry', () => {
    const cells=[];
    for(let y=0;y<24;y++) for(let x=0;x<24;x++) cells.push({x,y,depth:Math.min(x+1,y+1,24-x,24-y),color:'#9a5720'});
    const model={...photoToModel(image(),source,false,undefined,'smooth'),width:24,height:24,cells};
    const first=buildPhotoModelGeometry(model), second=buildPhotoModelGeometry(model);
    expect(first).not.toBe(second); expect(first.getAttribute('position').array).not.toBe(second.getAttribute('position').array);
    expect(second.getIndex()!.count/3).toBeLessThan(12_000);
    first.dispose(); expect(second.getAttribute('position').count).toBeGreaterThan(0);
    const progressive=buildPhotoModelGeometry(model,cells.filter((c)=>c.y>=20));
    expect(progressive.getAttribute('position').count).toBeGreaterThan(0);
    expect(progressive.getAttribute('position').count).toBeLessThan(second.getAttribute('position').count);
    second.dispose(); progressive.dispose();
  });

});
