import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createSkyDome, placeSkyDome } from './sky';
import { animateWater } from './water';
import { WebGLUnavailableError, createViewportRenderer } from './renderer';
import { createEmptyWorldPlan } from '../world-plan/factory';

describe('WebGL bootstrap', () => {
  it('fails with a clear, actionable error when no GPU context exists', () => {
    // Node has no WebGL implementation: every attempt must be caught and turned
    // into one readable error instead of an unhandled crash.
    expect(() => createViewportRenderer(false)).toThrow(WebGLUnavailableError);
    try {
      createViewportRenderer(false);
    } catch (error) {
      expect((error as Error).message).toMatch(/WebGL 2/);
      expect((error as Error).message).toMatch(/hardware acceleration/i);
    }
  });
});

describe('shader sky', () => {
  it('builds a back-side dome with a shader material', () => {
    const plan = createEmptyWorldPlan({ seed: 4 });
    const sky = createSkyDome(plan.environment);

    expect(sky.mesh).toBeInstanceOf(THREE.Mesh);
    const material = sky.mesh.material as THREE.ShaderMaterial;
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.side).toBe(THREE.BackSide);
    expect(material.depthWrite).toBe(false);

    for (const name of ['uZenith', 'uHorizon', 'uGround', 'uSunColor', 'uSunDirection', 'uSunIntensity']) {
      expect(material.uniforms[name]).toBeDefined();
    }
    const direction = material.uniforms.uSunDirection?.value as THREE.Vector3;
    expect(direction.length()).toBeCloseTo(1, 5);

    sky.dispose();
  });

  it('tracks environment changes', () => {
    const plan = createEmptyWorldPlan({ seed: 5 });
    const sky = createSkyDome(plan.environment);
    const material = sky.mesh.material as THREE.ShaderMaterial;

    sky.update({
      ...plan.environment,
      skyColor: '#102030',
      fogColor: '#405060',
      sunColor: '#ffcc88',
      sunAzimuth: 90,
      sunElevation: 10,
      sunIntensity: 2,
    });

    expect((material.uniforms.uZenith?.value as THREE.Color).getHexString()).toBe('102030');
    expect((material.uniforms.uSunIntensity?.value as number)).toBe(2);

    const direction = material.uniforms.uSunDirection?.value as THREE.Vector3;
    // Azimuth 90°, elevation 10° → mostly +X, slightly +Y, no Z.
    expect(direction.x).toBeGreaterThan(0.9);
    expect(direction.y).toBeCloseTo(Math.sin(THREE.MathUtils.degToRad(10)), 4);
    expect(Math.abs(direction.z)).toBeLessThan(1e-6);

    sky.dispose();
  });

  it('stays centred on the camera and inside the far plane', () => {
    const plan = createEmptyWorldPlan();
    const sky = createSkyDome(plan.environment);
    const camera = new THREE.PerspectiveCamera(52, 1.6, 0.1, 1000);
    camera.position.set(12, 30, -8);

    placeSkyDome(sky, camera);

    expect(sky.mesh.position.toArray()).toEqual([12, 30, -8]);
    const scale = sky.mesh.scale.x;
    expect(scale).toBeLessThan(camera.far);
    expect(scale).toBeGreaterThan(camera.far * 0.5);

    sky.dispose();
  });
});

describe('water shimmer', () => {
  it('injects an animated ripple into the standard material', () => {
    const geometry = new THREE.PlaneGeometry(10, 10);
    const material = new THREE.MeshStandardMaterial({ color: '#3f7d9c' });
    const mesh = new THREE.Mesh(geometry, material);

    const animation = animateWater(mesh);
    expect(animation).not.toBeNull();

    const shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string } = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <normal_fragment_begin>',
    };
    material.onBeforeCompile(shader as never, {} as never);

    expect(shader.vertexShader).toContain('vWaterWorld');
    expect(shader.fragmentShader).toContain('uTime');
    expect(shader.uniforms.uTime).toBeDefined();

    animation?.update(1.5);
    expect((shader.uniforms.uTime as { value: number }).value).toBe(1.5);

    animation?.dispose();
    geometry.dispose();
    material.dispose();
  });

  it('returns null for materials it cannot patch', () => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.ShaderMaterial({ vertexShader: 'void main(){}', fragmentShader: 'void main(){}' }),
    );
    expect(animateWater(mesh)).toBeNull();
  });
});
