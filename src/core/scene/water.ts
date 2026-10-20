import * as THREE from 'three';

/**
 * Viewport-only water shimmer.
 *
 * The shared scene builder keeps a plain `MeshStandardMaterial` so the glTF
 * exporter produces portable PBR water. For the live viewport we inject a small
 * GLSL ripple into the standard shader: moving highlights without extra geometry,
 * textures or a second draw pass.
 */

export interface WaterAnimation {
  update: (elapsedSeconds: number) => void;
  dispose: () => void;
}

const CACHE_KEY = 'worldbuilder-water-ripple-v1';

export function animateWater(mesh: THREE.Mesh): WaterAnimation | null {
  const material = mesh.material;
  if (!(material instanceof THREE.MeshStandardMaterial)) return null;

  const uniforms = { uTime: { value: 0 } };
  const previousCompile = material.onBeforeCompile;

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.uTime = uniforms.uTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
varying vec3 vWaterWorld;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
float rippleA = sin(vWaterWorld.x * 0.35 + uTime * 1.15) * cos(vWaterWorld.z * 0.29 - uTime * 0.85);
float rippleB = sin((vWaterWorld.x + vWaterWorld.z) * 0.11 - uTime * 0.45);
normal = normalize(normal + vec3(rippleA * 0.10 + rippleB * 0.04, 0.0, rippleA * 0.08));`,
      );

    material.userData.shader = shader;
  };

  material.customProgramCacheKey = () => CACHE_KEY;
  material.needsUpdate = true;

  return {
    update: (elapsedSeconds) => {
      uniforms.uTime.value = elapsedSeconds;
    },
    dispose: () => {
      material.onBeforeCompile = previousCompile;
      material.customProgramCacheKey = () => '';
      material.needsUpdate = true;
      delete material.userData.shader;
    },
  };
}
