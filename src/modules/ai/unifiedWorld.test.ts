import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {textWorldItems,mergeWorldItems,terrainDescription,imageWorldParts} from './unifiedWorld';
import {cloudWorldShell,composeCloudWorld} from './cloudWorld';
import {createEmptyWorldPlan} from '../../core/world-plan/factory';
import {generatedGlbToWorld} from './generatedMesh';
import {createTerrainSampler} from '../../core/generation/terrain';
import {buildWorldScene} from '../../core/scene/sceneBuilder';
import {exportWorldToGlb} from '../../core/export/gltf';

describe('unified scene planning',()=>{
 it('handles Arabic duals, plurals, attached conjunctions and numbers without mistaking rivers for models',()=>{
  const items=textWorldItems('وادي فيه نهر و٣ أشجار وشجرتين وبيت');
  expect(items).toHaveLength(6);expect(items.map(i=>i.search)).toEqual(['tree','tree','tree','tree','tree','house']);
  expect(textWorldItems('جبال مع نهر')).toHaveLength(0);
  expect(textWorldItems('جبال ونهر و١٦ شجرة')).toHaveLength(16);
  expect(textWorldItems('جبال ونهر و١٧ شجرة').length).toBeGreaterThan(16);
  expect(textWorldItems('forest with no trees')).toHaveLength(0);
  expect(textWorldItems('الكثير من السيارات وبيتين').map(i=>i.search)).toEqual(['car','car','car','house','house']);
  expect(textWorldItems('بيت شجرة صخرة').map(i=>i.search)).toEqual(['house','tree','rock']);
 });
 it('preserves inferred text counts when a category also appears in the image',()=>{
  const labels=new Uint8Array(4096).fill(2);for(let y=5;y<15;y++)for(let x=5;x<15;x++)labels[y*64+x]=4;
  const image=imageWorldParts(labels);expect(image.items).toHaveLength(1);
  expect(mergeWorldItems(textWorldItems('3 trees'),image.items)).toHaveLength(3);
  expect(terrainDescription('without river', ['river','mountain'])).toBe('without river and mountain');
 });
 it('retains visible river geometry and inland water in the local shell',async()=>{
  const base=createEmptyWorldPlan({seed:22});
  const valley=cloudWorldShell(base,'text','وادي مع نهر');expect(valley.terrain.style).toBe('valley');
  expect(valley.objects.some(o=>o.kind==='river')).toBe(true);
  const scene=buildWorldScene(valley);let river=false;scene.traverse(o=>{if(o.name==='river-water')river=true;});expect(river).toBe(true);
  expect((await exportWorldToGlb(valley)).objectCount).toBeGreaterThanOrEqual(1);
  const flat=cloudWorldShell(base,'text','أرض مسطحة فيها بحيرة');
  expect(flat.terrain.style).toBe('flat');expect(flat.terrain.lakeBasin).toBeDefined();
  const flatSampler=createTerrainSampler(flat.terrain,flat.seed);
  expect(flatSampler.heightAt(0,0)).toBeLessThan(flat.terrain.waterLevel!);
  expect(flatSampler.heightAt(flat.terrain.size*.4,0)).toBeGreaterThan(flat.terrain.waterLevel!);
  const flatScene=buildWorldScene(flat);expect(flatScene.getObjectByName('water')).toBeTruthy();
  const {deserializeWorldPlan,serializeWorldPlan}=await import('../../core/world-plan/migrate');
  expect(deserializeWorldPlan(serializeWorldPlan(flat)).terrain.lakeBasin).toEqual(flat.terrain.lakeBasin);
  const lake=cloudWorldShell(base,'text','جبال فيها بحيرة');expect(lake.terrain.style).toBe('mountains');expect(lake.terrain.waterLevel).not.toBeNull();
  const sampler=createTerrainSampler(lake.terrain,lake.seed);const half=lake.terrain.size*.45;let under=0;for(let x=-half;x<=half;x+=8)for(let z=-half;z<=half;z+=8)if(sampler.heightAt(x,z)<lake.terrain.waterLevel!)under++;expect(under).toBeGreaterThan(0);
  const buffer=readFileSync('src/test/fixtures/trimesh-vertex-colors.glb');const obj=(await generatedGlbToWorld(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength) as ArrayBuffer,'tree')).objects[0]!;
  const items=textWorldItems('شجرتين');const result=composeCloudWorld(base,items,[obj,obj],'text','شجرتين',lake);
  expect(result.objects).toHaveLength(2);expect(result.terrain).toEqual(lake.terrain);
 },20000);
});
