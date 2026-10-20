import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from '../generation/generateWorld';
import { buildWorldScene, disposeObject3D, findNodeObject } from './sceneBuilder';

const FARM_PROMPT =
  'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths';
const RIVER_PROMPT =
  'A small cartoon farm with a barn, a wheat field, fences, a stream and a bridge';

function build(prompt: string, seed = 20261020) {
  const interpretation = interpretPromptLocally(prompt, { seed });
  const report = generateWorldPlanWithReport(interpretation.intent);
  const root = buildWorldScene(report.plan, { includeLights: false, terrainResolutionCap: 64 });
  return { root, plan: report.plan };
}

function vertexCount(group: THREE.Object3D): number {
  let total = 0;
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) total += child.geometry.getAttribute('position').count;
  });
  return total;
}

function meshes(group: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) found.push(child);
  });
  return found;
}

describe('farm scene graph', () => {
  it('builds a real mesh for every generated object', () => {
    const { root, plan } = build(FARM_PROMPT);
    for (const object of plan.objects) {
      const node = findNodeObject(root, object.id);
      expect(node, `${object.name} (${object.kind})`).not.toBeNull();
      expect(meshes(node!).length).toBeGreaterThan(0);
    }
    disposeObject3D(root);
  });

  it('gives buildings believable silhouettes and grounded foundations', () => {
    const { root, plan } = build(FARM_PROMPT);
    const barn = plan.objects.find((object) => object.name === 'Barn');
    expect(barn).toBeDefined();
    const barnNode = findNodeObject(root, barn!.id)!;
    // Detail is merged by material: ~10 draw calls instead of ~25 boxes.
    expect(meshes(barnNode).length).toBeGreaterThan(5);
    expect(vertexCount(barnNode)).toBeGreaterThan(250);

    const box = new THREE.Box3().setFromObject(barnNode);
    const size = box.getSize(new THREE.Vector3());
    expect(size.x).toBeGreaterThan(6);
    expect(size.y).toBeGreaterThan(5);
    expect(size.z).toBeGreaterThan(7);
    expect(box.min.y).toBeGreaterThan(barn!.transform.position[1] - 0.35);
    expect(box.min.y).toBeLessThan(barn!.transform.position[1] + 0.1);

    const coop = plan.objects.find((object) => object.name === 'Chicken coop');
    expect(coop).toBeDefined();
    const coopNode = findNodeObject(root, coop!.id)!;
    // Coop = shed + ramp + nesting box + fenced run + three chickens, merged
    // into a handful of material groups.
    expect(meshes(coopNode).length).toBeGreaterThan(4);
    expect(vertexCount(coopNode)).toBeGreaterThan(400);

    const house = plan.objects.find((object) => object.name === 'Farmhouse');
    expect(house).toBeDefined();
    const houseBox = new THREE.Box3().setFromObject(findNodeObject(root, house!.id)!);
    expect(houseBox.getSize(new THREE.Vector3()).y).toBeGreaterThan(3.6);
    disposeObject3D(root);
  });

  it('renders crop fields with instancing instead of thousands of meshes', () => {
    const { root, plan } = build(FARM_PROMPT);
    const field = plan.objects.find((object) => object.kind === 'field');
    expect(field).toBeDefined();
    const node = findNodeObject(root, field!.id)!;
    const instanced = meshes(node).filter(
      (mesh): mesh is THREE.InstancedMesh => mesh instanceof THREE.InstancedMesh,
    );
    expect(instanced).toHaveLength(1);
    expect(instanced[0]!.count).toBeGreaterThan(100);
    expect(instanced[0]!.count).toBeLessThan(1401);
    // Field geometry stays small: soil bed + border ridges + one instanced crop.
    expect(meshes(node).length).toBeLessThan(10);
    disposeObject3D(root);
  });

  it('builds paths, fences, rivers and bridges as connected geometry', () => {
    const { root, plan } = build(RIVER_PROMPT, 4242);
    const lane = plan.objects.find((object) => object.name === 'Main dirt lane');
    expect(lane).toBeDefined();
    const laneMesh = meshes(findNodeObject(root, lane!.id)!)[0]!;
    const positions = laneMesh.geometry.getAttribute('position');
    expect(positions.count).toBeGreaterThan(10);

    const fence = plan.objects.find((object) => object.kind === 'fence');
    expect(fence).toBeDefined();
    // Posts + at least two rails per span, merged into post/rail materials.
    const fenceNode = findNodeObject(root, fence!.id)!;
    expect(meshes(fenceNode).length).toBeGreaterThanOrEqual(2);
    expect(vertexCount(fenceNode)).toBeGreaterThan(300);

    const river = plan.objects.find((object) => object.kind === 'river');
    expect(river).toBeDefined();
    expect(meshes(findNodeObject(root, river!.id)!)).toHaveLength(2);

    const bridge = plan.objects.find((object) => object.kind === 'bridge');
    expect(bridge).toBeDefined();
    const bridgeNode = findNodeObject(root, bridge!.id)!;
    expect(meshes(bridgeNode).length).toBeGreaterThanOrEqual(2);
    expect(vertexCount(bridgeNode)).toBeGreaterThan(200);
    const box = new THREE.Box3().setFromObject(bridgeNode);
    expect(box.getSize(new THREE.Vector3()).x).toBeGreaterThan(8);
    disposeObject3D(root);
  });

  it('keeps per-object transform edits intact when rebuilding the scene', () => {
    const { root, plan } = build(FARM_PROMPT);
    const barn = plan.objects.find((object) => object.name === 'Barn');
    expect(barn).toBeDefined();
    const node = findNodeObject(root, barn!.id)!;
    expect(node.position.toArray()).toEqual(barn!.transform.position);
    disposeObject3D(root);
  });
});
