import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXPANDED_ASSETS } from './expandedDefinitions';
import { ASSET_LIBRARY, placementForNewObject } from './catalog';
import { parseAssetRequests } from '../../modules/ai/assetRequests';
import { mulberry32 } from '../generation/rng';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { validateScenePlan } from '../world-plan/validateScene';
import { deserializeWorldPlan, serializeWorldPlan } from '../world-plan/migrate';
import { createWorldObjectGroup, disposeObject3D } from '../scene/sceneBuilder';
import { exportWorldToGlb } from '../export/gltf';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { unknownTopics } from '../../modules/ai/unknownResearch';
import { editWorldByText } from '../../modules/ai/worldEdit';
import { generateWorldPlanWithReport } from '../generation/generateWorld';
import { createTerrainSampler } from '../generation/terrain';
import type { TerrainStyle } from '../world-plan/schema';

describe('expanded local asset catalog', () => {
  it('provides distinct editable and bounded geometry for every added asset', () => {
    expect(EXPANDED_ASSETS).toHaveLength(32);
    expect(ASSET_LIBRARY.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ASSET_LIBRARY.map((a) => a.id)).size).toBe(ASSET_LIBRARY.length);
    for (const def of EXPANDED_ASSETS) expect(parseAssetRequests(def.ar)?.[0]?.assetId, def.ar).toBe(def.id);
    for (const [i, def] of EXPANDED_ASSETS.entries()) {
      const asset = ASSET_LIBRARY.find((a) => a.id === def.id)!;
      const object = asset.create(mulberry32(10), [0,0,0]);
      const plan = { ...createEmptyWorldPlan({ seed: 5 }), objects: [object] };
      expect(validateScenePlan(plan).valid, def.id).toBe(true);
      const group = createWorldObjectGroup(object, false);
      let meshes = 0;
      group.traverse((node) => { if (node instanceof THREE.Mesh) meshes++; });
      expect(meshes, def.id).toBeGreaterThan(0);
      expect(meshes, def.id).toBeLessThanOrEqual(10);
      group.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(group, true);
      const size = box.getSize(new THREE.Vector3());
      expect(size.x, `${i} ${def.id} width`).toBeLessThanOrEqual(def.dimensions[0] * 1.02);
      expect(size.y, `${i} ${def.id} height`).toBeLessThanOrEqual(def.dimensions[1] * 1.02);
      expect(size.z, `${i} ${def.id} depth`).toBeLessThanOrEqual(def.dimensions[2] * 1.02);
      expect(box.min.y, def.id).toBeGreaterThan(-0.1);
      disposeObject3D(group);
    }
  });
  it('does not place a new library object into a completely blocked world', () => {
    const plan = createEmptyWorldPlan({ seed: 15 });
    plan.terrain = { ...plan.terrain, style:'flat', size:32, waterLevel:null };
    const castle = ASSET_LIBRARY.find((asset) => asset.id === 'castle')!.create(mulberry32(1), [0,0,0]);
    castle.transform.scale = [10,1,10];
    plan.objects.push(castle);
    const bench = ASSET_LIBRARY.find((asset) => asset.id === 'bench')!.create(mulberry32(2), [0,0,0]);
    expect(placementForNewObject(plan, createTerrainSampler(plan.terrain, plan.seed), mulberry32(3), bench)).toBeNull();
  });
  it('serializes, reopens and exports every new kind in one GLB', async () => {
    const plan = createEmptyWorldPlan({ seed: 5 });
    plan.objects = EXPANDED_ASSETS.map((def, i) => ASSET_LIBRARY.find((a) => a.id === def.id)!.create(mulberry32(i), [(i%8)*12-42,0,Math.floor(i/8)*12-18]));
    const reloaded = deserializeWorldPlan(serializeWorldPlan(plan));
    expect(reloaded.objects).toEqual(plan.objects);
    expect(validateScenePlan(reloaded).valid).toBe(true);
    const glb = await exportWorldToGlb(reloaded);
    expect(glb.objectCount).toBe(EXPANDED_ASSETS.length);
    expect(new DataView(glb.buffer).getUint32(0, true)).toBe(0x46546c67);
  }, 20000);
  it('understands new Arabic and English descriptions, counts and negation without network', () => {
    const result = generateWorldPlanWithReport(interpretPromptLocally('غابة فيها قلعة و3 فطر ونافورة', {seed: 42}).intent);
    expect(result.validation.valid).toBe(true);
    expect(result.plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'castle')).toHaveLength(1);
    expect(result.plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'mushroom')).toHaveLength(3);
    expect(result.plan.objects.some((o) => o.kind === 'primitive' && o.primitive === 'fountain')).toBe(true);
    expect(result.plan.objects.some((o) => o.kind === 'tree')).toBe(true);
    expect(unknownTopics('غابة فيها قلعة و3 فطر ونافورة').terms).toEqual([]);
    expect(parseAssetRequests('وادي فيه ورود و5 مقاعد ولا نافورة')).toMatchObject([{assetId:'flower',count:3},{assetId:'bench',count:5}]);
    expect(parseAssetRequests('زهرة 3 ومقعد')).toMatchObject([{assetId:'flower',count:3},{assetId:'bench',count:1}]);
    expect(interpretPromptLocally('وادي بدون فوهة بركانية', {seed:4}).intent.landform).toBe('valley');
    expect(interpretPromptLocally('لا بركان', {seed:4}).intent.landform).toBeUndefined();
    const english = generateWorldPlanWithReport(interpretPromptLocally('a valley with a castle and 2 benches but no fountain', {seed:4}).intent);
    expect(english.plan.terrain.style).toBe('valley');
    expect(english.plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'bench')).toHaveLength(2);
    expect(english.plan.objects.some((o) => o.kind === 'primitive' && o.primitive === 'fountain')).toBe(false);
  });
  it('adds and edits new assets independently, including extras in farm layouts', () => {
    const base = createEmptyWorldPlan({seed:17});
    const added = editWorldByText(base, [], 'أضف برميل').plan;
    expect(added.objects).toHaveLength(1);
    expect(added.objects[0]).toMatchObject({ kind:'primitive', primitive:'barrel' });
    expect(editWorldByText(added, [], 'احذف البرميل').plan.objects).toHaveLength(0);
    const farm = generateWorldPlanWithReport(interpretPromptLocally('مزرعة فيها 2 برميل وطاحونة هوائية', {seed:10}).intent);
    expect(farm.validation.valid).toBe(true);
    expect(farm.plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'barrel')).toHaveLength(2);
    expect(farm.plan.objects.filter((o) => o.kind === 'primitive' && o.primitive === 'windmill')).toHaveLength(1);
  });
});

describe('new terrain forms', () => {
  it.each([
    ['وادي', 'valley'], ['هضبة', 'plateau'], ['أخدود', 'canyon'], ['بركان', 'volcano'], ['فوهة بركانية', 'crater'],
  ] as const)('generates %s and validates its deterministic terrain', (word, style) => {
    const { intent } = interpretPromptLocally(`${word} فيه قلعة`, {seed:42});
    const result = generateWorldPlanWithReport(intent);
    expect(result.plan.terrain.style).toBe(style);
    expect(result.validation.valid).toBe(true);
    expect(unknownTopics(`${word} فيه قلعة`).terms).toEqual([]);
    const sample = createTerrainSampler(result.plan.terrain, result.plan.seed);
    const points = [[0,0], [10,15], [35,-25], [-40,20]] as const;
    const heights = points.map(([x,z]) => sample.heightAt(x,z));
    expect(heights.every(Number.isFinite)).toBe(true);
    expect(new Set(heights.map((h)=>h.toFixed(3))).size).toBeGreaterThan(1);
    expect(points.map(([x,z]) => createTerrainSampler(result.plan.terrain,42).heightAt(x,z))).toEqual(heights);
    expect(deserializeWorldPlan(serializeWorldPlan(result.plan)).terrain.style).toBe(style as TerrainStyle);
  });
});
