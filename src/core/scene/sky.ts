import * as THREE from 'three';
import type { WorldEnvironment } from '../world-plan/schema';

/**
 * Procedural gradient sky with a sun glow, drawn as a shader dome.
 *
 * This is viewport-only: the exporter stays on the neutral scene background so
 * exported glTF files keep no enormous sky geometry. Colours come from the same
 * environment values as the lights, so the sun disc and the shadows agree.
 */

export interface SkyHandle {
  mesh: THREE.Mesh;
  update: (environment: WorldEnvironment) => void;
  dispose: () => void;
}

const VERTEX = /* glsl */ `
varying vec3 vDirection;

void main() {
  vDirection = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
uniform vec3 uSunDirection;
uniform float uSunIntensity;

varying vec3 vDirection;

void main() {
  vec3 dir = normalize(vDirection);
  float height = dir.y;

  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.6, height));
  sky = mix(uGround, sky, smoothstep(-0.22, 0.03, height));

  float sun = max(dot(dir, normalize(uSunDirection)), 0.0);
  float disc = pow(sun, 420.0) * 2.2;
  float glow = pow(sun, 12.0) * 0.28 + pow(sun, 3.0) * 0.05;

  vec3 color = sky + uSunColor * (disc + glow) * uSunIntensity;

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DEG2RAD = Math.PI / 180;

function sunDirection(environment: WorldEnvironment): THREE.Vector3 {
  const azimuth = environment.sunAzimuth * DEG2RAD;
  const elevation = Math.max(environment.sunElevation, -8) * DEG2RAD;
  return new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  ).normalize();
}

export function createSkyDome(environment: WorldEnvironment): SkyHandle {
  const uniforms = {
    uZenith: { value: new THREE.Color(environment.skyColor) },
    uHorizon: { value: new THREE.Color(environment.fogColor) },
    uGround: { value: new THREE.Color(environment.fogColor) },
    uSunColor: { value: new THREE.Color(environment.sunColor) },
    uSunDirection: { value: sunDirection(environment) },
    uSunIntensity: { value: Math.max(environment.sunIntensity, 0.2) },
  };

  const geometry = new THREE.SphereGeometry(1, 32, 20);
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.matrixAutoUpdate = false;

  const update = (next: WorldEnvironment) => {
    uniforms.uZenith.value.set(next.skyColor);
    uniforms.uHorizon.value.set(next.fogColor);
    uniforms.uGround.value.set(next.fogColor).multiplyScalar(0.34);
    uniforms.uSunColor.value.set(next.sunColor);
    uniforms.uSunDirection.value.copy(sunDirection(next));
    uniforms.uSunIntensity.value = Math.max(next.sunIntensity, 0.2);
  };

  update(environment);

  return {
    mesh,
    update,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** Keep the dome centred on the camera and just inside the far plane. */
export function placeSkyDome(sky: SkyHandle, camera: THREE.PerspectiveCamera): void {
  const radius = Math.max(camera.far * 0.85, 50);
  sky.mesh.position.copy(camera.position);
  sky.mesh.scale.setScalar(radius);
  sky.mesh.updateMatrix();
  sky.mesh.updateMatrixWorld(true);
}
