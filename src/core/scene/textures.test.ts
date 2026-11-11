import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { getSurfaceTexture } from './textures';
import { createEmptyWorldPlan } from '../world-plan/factory';
import { createBuilding, createTree } from '../assets/catalog';
import { mulberry32 } from '../generation/rng';
import { buildWorldScene, disposeObject3D, findNodeObject } from './sceneBuilder';

describe('procedural surface textures', () => {
  it('creates bounded, shared repeatable textures without external assets', () => {
    const wood = getSurfaceTexture('wood');
    expect(getSurfaceTexture('wood')).toBe(wood);
    expect(wood.image.width).toBe(128);
    expect(wood.image.height).toBe(128);
    expect(wood.image.data!.length).toBe(128 * 128 * 4);
    expect(wood.wrapS).toBe(THREE.RepeatWrapping);
    expect(wood.wrapT).toBe(THREE.RepeatWrapping);
    expect(wood.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(wood.generateMipmaps).toBe(true);
    expect(new Set(wood.image.data).size).toBeGreaterThan(5);
    expect(getSurfaceTexture('sand').image.data).not.toEqual(wood.image.data);
  });

  it('assigns maps to terrain, foliage, bark and buildings, and keeps them shared on disposal', () => {
    const plan = createEmptyWorldPlan({ seed: 42 });
    const tree = createTree('pine', [0, 0, 0], mulberry32(1));
    const house = createBuilding('house', [4, 0, 0], mulberry32(2));
    plan.objects.push(tree, house);
    const root = buildWorldScene(plan, { includeLights: false });
    const terrain = root.getObjectByName('terrain') as THREE.Mesh;
    expect((terrain.material as THREE.MeshStandardMaterial).map).toBe(getSurfaceTexture('grass'));
    const maps = (id: string) => {
      const found = new Set<THREE.Texture | null>();
      findNodeObject(root, id)?.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) found.add(child.material.map);
      });
      return found;
    };
    expect(maps(tree.id).has(getSurfaceTexture('bark'))).toBe(true);
    expect(maps(tree.id).has(getSurfaceTexture('foliage'))).toBe(true);
    expect(maps(house.id).has(getSurfaceTexture('roof'))).toBe(true);
    expect(maps(house.id).has(getSurfaceTexture('plaster'))).toBe(true);
    let disposed = 0;
    const texture = getSurfaceTexture('bark');
    const onDispose = () => disposed++;
    texture.addEventListener('dispose', onDispose);
    disposeObject3D(root);
    texture.removeEventListener('dispose', onDispose);
    expect(disposed).toBe(0);
    expect(getSurfaceTexture('bark')).toBe(texture);
  });
});
