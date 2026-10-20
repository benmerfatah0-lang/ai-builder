import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlan } from '../generation/generateWorld';
import { buildWorldScene, disposeObject3D, findNodeObject } from '../scene/sceneBuilder';
import { exportWorldToGlb } from './gltf';
import { createLantern } from '../assets/catalog';
import type { WorldPlan } from '../world-plan/schema';

function samplePlan(): WorldPlan {
  return generateWorldPlan(
    interpretPromptLocally(
      'A meadow with 8 trees, 3 rocks and a small village at sunset',
      { seed: 2024 },
    ).intent,
  );
}

describe('shared scene builder', () => {
  it('builds terrain and visible objects', () => {
    const plan = samplePlan();
    const root = buildWorldScene(plan, { includeLights: false });
    expect(root.getObjectByName('terrain')).toBeDefined();
    const nodesGroup = root.getObjectByName('world-nodes');
    expect(nodesGroup).toBeDefined();
    expect(nodesGroup?.children).toHaveLength(plan.objects.length);
    for (const object of plan.objects) {
      expect(findNodeObject(root, object.id)).not.toBeNull();
    }
    disposeObject3D(root);
  });

  it('excludes hidden objects unless requested', () => {
    const base = samplePlan();
    const hidden = { ...createLantern([0, 0, 0]), visible: false };
    const plan: WorldPlan = { ...base, objects: [...base.objects, hidden] };

    const visibleOnly = buildWorldScene(plan, { includeLights: false });
    expect(visibleOnly.getObjectByName('world-nodes')?.children).toHaveLength(
      plan.objects.length - 1,
    );
    expect(findNodeObject(visibleOnly, hidden.id)).toBeNull();
    disposeObject3D(visibleOnly);

    const everything = buildWorldScene(plan, { includeLights: false, includeHidden: true });
    expect(everything.getObjectByName('world-nodes')?.children).toHaveLength(plan.objects.length);
    expect(findNodeObject(everything, hidden.id)).not.toBeNull();
    disposeObject3D(everything);
  });

  it('tags meshes with their world object id for picking', () => {
    const plan = samplePlan();
    const root = buildWorldScene(plan, { includeLights: false });
    const first = plan.objects[0];
    if (!first) throw new Error('expected objects');
    const group = findNodeObject(root, first.id);
    expect(group).toBeDefined();
    const id = first.id;
    expect(plan.objects.some((object) => object.id === id)).toBe(true);
    let meshes = 0;
    group?.traverse((child) => {
      if (child.userData.worldObjectId !== id) return;
      if (child.type === 'Mesh') meshes += 1;
    });
    expect(meshes).toBeGreaterThan(0);
    disposeObject3D(root);
  });
});

describe('glTF export', () => {
  it('produces a valid binary glTF 2.0 container', async () => {
    const plan = samplePlan();
    const result = await exportWorldToGlb(plan);

    expect(result.bytes).toBeGreaterThan(1000);
    expect(result.objectCount).toBe(plan.objects.length);

    const view = new DataView(result.buffer);
    expect(view.getUint32(0, true)).toBe(0x46546c67); // "glTF"
    expect(view.getUint32(4, true)).toBe(2); // version
    expect(view.getUint32(8, true)).toBe(result.bytes); // total length

    const jsonChunkLength = view.getUint32(12, true);
    expect(view.getUint32(16, true)).toBe(0x4e4f534a); // "JSON"
    const jsonBytes = new Uint8Array(result.buffer, 20, jsonChunkLength);
    const json = JSON.parse(new TextDecoder().decode(jsonBytes).trim()) as {
      asset: { version: string };
      meshes: unknown[];
      nodes: unknown[];
      buffers: { byteLength: number }[];
    };

    expect(json.asset.version).toBe('2.0');
    expect(json.meshes.length).toBeGreaterThan(0);
    expect(json.nodes.length).toBeGreaterThanOrEqual(plan.objects.length);
    expect(json.buffers[0]?.byteLength).toBeGreaterThan(0);
  }, 20000);
});
