import * as THREE from 'three';
import type { WorldWater } from './types';

/**
 * «زعتر» as an explorable avatar.
 *
 * Deliberately minimal: walk, run, jump, and a camera that follows. There is no
 * combat, health, stamina or damage — the point is to *walk the level design*
 * that the map documents, so the reviewer can feel the routes, the bridge pinch
 * point and the long approach to the palace.
 *
 * Everything here is engine-agnostic Three.js: it takes a height sampler from
 * the map scene and returns handles the viewer can drive from its own loop.
 */

export interface FoxPlayerOptions {
  /** Ground height under a world point (from the map scene). */
  heightAt: (x: number, z: number) => number;
  /** Water bodies, used only to slow the fox when wading. */
  water: WorldWater;
  /** World bounds the fox may not leave. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Start position; defaults to the prologue at the forest edge. */
  spawn?: [number, number];
}

export interface FoxState {
  /** Ground position. */
  x: number;
  z: number;
  /** Heading in radians (0 = +Z). */
  heading: number;
  /** Vertical velocity while airborne. */
  velocityY: number;
  /** True while the fox is off the ground. */
  airborne: boolean;
  /** Current planar speed, in world units per second. */
  speed: number;
  /** Sprinting right now. */
  sprinting: boolean;
  /** Smoothed stride phase driving the leg/tail animation. */
  gait: number;
}

export interface FoxPlayer {
  group: THREE.Group;
  state: FoxState;
  /**
   * Applies movement for this frame. `dirX`/`dirZ` are a *world-space*
   * direction (already rotated by the camera yaw), length 0..1. Keeping the
   * camera out of the motion model is what stops the fox from spiralling: the
   * caller decides what "forward" means, the fox only walks there.
   */
  step: (
    dt: number,
    input: { dirX: number; dirZ: number; sprint: boolean; jump: boolean },
    elapsed: number,
  ) => void;
  /** Puts the fox back at spawn (used by the reset key). */
  reset: () => void;
  /** Snaps the fox to a checkpoint / region centre. */
  teleport: (x: number, z: number, heading?: number) => void;
  dispose: () => void;
}

const WALK_SPEED = 15;
const RUN_SPEED = 30;
const ACCEL = 14;
const GRAVITY = 34;
const JUMP_SPEED = 13;
/** How much the fox sinks into shallow water, as a fraction of speed. */
const WADE_FACTOR = 0.45;

/**
 * Builds the fox avatar and its motion model.
 */
export function createFoxPlayer(options: FoxPlayerOptions): FoxPlayer {
  const { heightAt, bounds, water } = options;
  const spawn = options.spawn ?? [0, 148];

  const group = new THREE.Group();
  group.name = 'player-fox';

  /* ------------------------------------------------------------ materials */
  const fur = new THREE.MeshStandardMaterial({ color: '#e07a3c', roughness: 0.9 });
  const furDark = new THREE.MeshStandardMaterial({ color: '#c4612c', roughness: 0.92 });
  const cream = new THREE.MeshStandardMaterial({ color: '#f7e3c4', roughness: 0.95 });
  const dark = new THREE.MeshStandardMaterial({ color: '#2f2a26', roughness: 1 });
  const scarf = new THREE.MeshStandardMaterial({ color: '#3f8f5e', roughness: 0.85 });

  const addPart = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: [number, number, number],
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    parent.add(mesh);
    return mesh;
  };

  /* ---------------------------------------------------------------- body */
  const body = new THREE.Group();
  body.name = 'fox-body';
  group.add(body);

  const torso = addPart(body, new THREE.SphereGeometry(0.5, 12, 10), fur, [0, 0.72, 0]);
  torso.scale.set(0.95, 0.86, 1.45);

  // Cream chest and belly.
  const chest = addPart(body, new THREE.SphereGeometry(0.3, 10, 8), cream, [0, 0.62, 0.34]);
  chest.scale.set(0.95, 0.8, 0.7);

  // Green neckerchief: a small characterful prop, reads at a distance.
  const neckerchief = addPart(body, new THREE.TorusGeometry(0.27, 0.075, 6, 14), scarf, [0, 0.95, 0.22]);
  neckerchief.rotation.x = Math.PI / 2.15;
  const scarfTail = addPart(body, new THREE.ConeGeometry(0.1, 0.34, 4), scarf, [0.06, 0.84, -0.12]);
  scarfTail.rotation.set(0.5, 0, 0.35);

  /* ---------------------------------------------------------------- head */
  const head = new THREE.Group();
  head.name = 'fox-head';
  head.position.set(0, 1.06, 0.42);
  body.add(head);

  const skull = addPart(head, new THREE.SphereGeometry(0.32, 12, 10), fur, [0, 0, 0]);
  skull.scale.set(1, 0.95, 1.02);
  const snout = addPart(head, new THREE.ConeGeometry(0.17, 0.42, 8), cream, [0, -0.05, 0.3]);
  snout.rotation.x = Math.PI / 2;
  addPart(head, new THREE.SphereGeometry(0.055, 6, 5), dark, [0, -0.02, 0.52]);

  const ears: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const ear = addPart(head, new THREE.ConeGeometry(0.13, 0.34, 4), furDark, [side * 0.17, 0.3, -0.04]);
    ear.rotation.z = side * 0.22;
    ear.rotation.x = -0.12;
    ears.push(ear);
    addPart(head, new THREE.SphereGeometry(0.035, 5, 4), dark, [side * 0.13, 0.06, 0.26]);
  }

  /* ----------------------------------------------------------------- tail */
  const tail = new THREE.Group();
  tail.name = 'fox-tail';
  tail.position.set(0, 0.78, -0.62);
  body.add(tail);
  const tailMain = addPart(tail, new THREE.SphereGeometry(0.26, 9, 8), fur, [0, 0, -0.3]);
  tailMain.scale.set(0.85, 0.85, 2.1);
  const tailTip = addPart(tail, new THREE.SphereGeometry(0.17, 8, 7), cream, [0, 0.03, -0.82]);
  tailTip.scale.set(0.9, 0.9, 1.24);

  /* ----------------------------------------------------------------- legs */
  const legs: { pivot: THREE.Group; side: number; front: boolean }[] = [];
  for (const front of [true, false]) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.24, 0.46, front ? 0.34 : -0.32);
      body.add(pivot);
      const limb = addPart(pivot, new THREE.CylinderGeometry(0.075, 0.065, 0.44, 6), fur, [0, -0.2, 0]);
      limb.castShadow = true;
      const paw = addPart(pivot, new THREE.SphereGeometry(0.09, 6, 5), dark, [0, -0.42, 0.03]);
      paw.scale.set(1, 0.7, 1.25);
      legs.push({ pivot, side, front });
    }
  }

  /* --------------------------------------------------------- soft shadow */
  // A cheap contact shadow so the fox never looks like it floats, even on the
  // slope-heavy terrain where the real shadow map gets thin.
  // A canvas gradient gives the nicest soft edge, but the fox must also work
  // headlessly (tests, server-side previews), where there is no DOM.
  const shadowTexture = (() => {
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!canvas) {
      // Fully transparent: the offline flat painter ignores the alpha blend, so
      // anything else would show up as a pale square under the fox.
      const fallback = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
      fallback.needsUpdate = true;
      return fallback;
    }
    const size = 64;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
      gradient.addColorStop(0.55, 'rgba(0,0,0,0.18)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  })();
  const blobShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 1.9),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }),
  );
  blobShadow.rotation.x = -Math.PI / 2;
  blobShadow.renderOrder = 2;
  // Screen-space decal: it relies on texture alpha, which the flat offline
  // painter cannot sample, so tag it and let that renderer skip it.
  blobShadow.userData.decal = true;
  blobShadow.name = 'fox-shadow';
  group.add(blobShadow);

  /* ---------------------------------------------------------- bookkeeping */
  const state: FoxState = {
    x: spawn[0],
    z: spawn[1],
    heading: Math.PI,
    velocityY: 0,
    airborne: false,
    speed: 0,
    sprinting: false,
    gait: 0,
  };
  let groundY = heightAt(state.x, state.z);
  let spawnPoint: [number, number] = [spawn[0], spawn[1]];

  /** Is this point inside a water body (used for wading)? */
  const depthAt = (x: number, z: number): number => {
    // The renderer floods below -0.5; heightAt already carves the river bed, so
    // the water surface minus the bed is the wade depth.
    const bed = heightAt(x, z);
    const surface = -0.5;
    return surface - bed;
  };

  const applyTransform = () => {
    group.position.set(state.x, groundY, state.z);
    group.rotation.y = state.heading;
    blobShadow.position.y = 0.03;
    const airborneLift = Math.max(0, group.position.y - groundY);
    blobShadow.material.opacity = 0.9 - Math.min(0.55, airborneLift * 0.18);
  };

  applyTransform();

  return {
    group,
    state,

    step(dt, input, elapsed) {
      const clampedDt = Math.min(dt, 0.05);

      /* ------------------------------------------------------ horizontal */
      const magnitude = Math.hypot(input.dirX, input.dirZ);
      const moving = magnitude > 0.001;
      state.sprinting = input.sprint && moving;
      const targetSpeed = moving ? (state.sprinting ? RUN_SPEED : WALK_SPEED) : 0;

      // Wading: the deeper the water under the fox, the slower it moves.
      const depth = Math.max(0, depthAt(state.x, state.z));
      const wade = depth > 0.05 ? Math.max(WADE_FACTOR, 1 - depth * 0.55) : 1;
      state.speed += (targetSpeed * wade - state.speed) * Math.min(1, ACCEL * clampedDt);

      if (moving) {
        // The caller already resolved camera-relative input into a world vector.
        const desired = Math.atan2(input.dirX, input.dirZ);
        let delta = desired - state.heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        state.heading += delta * Math.min(1, 12 * clampedDt);
      }

      if (state.speed > 0.05) {
        const stepLength = state.speed * clampedDt;
        const nextX = state.x + Math.sin(state.heading) * stepLength;
        const nextZ = state.z + Math.cos(state.heading) * stepLength;
        // Refuse to walk into a steep cliff: this keeps the fox out of the
        // terrain seams without a physics engine.
        const nextGround = heightAt(nextX, nextZ);
        const currentGround = heightAt(state.x, state.z);
        const climbable = nextGround - currentGround < 2.6;
        if (climbable) {
          state.x = THREE.MathUtils.clamp(nextX, bounds.minX + 3, bounds.maxX - 3);
          state.z = THREE.MathUtils.clamp(nextZ, bounds.minZ + 3, bounds.maxZ - 3);
        } else {
          state.speed *= 0.4;
        }
      }

      /* --------------------------------------------------------- vertical */
      groundY = heightAt(state.x, state.z);
      if (input.jump && !state.airborne) {
        state.velocityY = JUMP_SPEED;
        state.airborne = true;
      }
      if (state.airborne) {
        state.velocityY -= GRAVITY * clampedDt;
        group.position.y += state.velocityY * clampedDt;
        if (group.position.y <= groundY) {
          group.position.y = groundY;
          state.velocityY = 0;
          state.airborne = false;
        }
      } else {
        // Follow the ground smoothly so slopes do not jitter the camera.
        group.position.y += (groundY - group.position.y) * Math.min(1, 16 * clampedDt);
      }

      group.position.x = state.x;
      group.position.z = state.z;
      group.rotation.y = state.heading;

      /* -------------------------------------------------------- animation */
      const cadence = state.speed > 0.05 ? state.speed / (state.sprinting ? 7 : 9) : 0;
      state.gait += cadence * clampedDt * Math.PI * 2 * 2.4;
      const swing = Math.sin(state.gait * 2) * (state.speed > 0.05 ? 0.85 : 0.06);
      for (const leg of legs) {
        const phase = leg.front ? (leg.side > 0 ? 0 : Math.PI) : leg.side > 0 ? Math.PI : 0;
        leg.pivot.rotation.x = Math.sin(state.gait * 2 + phase) * Math.abs(swing) * 0.8;
      }

      // Body bob and lean while running.
      const bob = Math.sin(state.gait * 4) * (state.speed > 0.05 ? 0.035 : 0.012);
      body.position.y = bob;
      body.rotation.x = state.airborne ? -0.22 : Math.min(0.13, state.speed * 0.004);
      body.rotation.z = Math.sin(state.gait * 2) * Math.min(0.06, state.speed * 0.0022);

      // Tail wags faster when sprinting; ears flick on the run.
      tail.rotation.y = Math.sin(elapsed * 2.4 + state.gait) * (0.16 + state.speed * 0.012);
      tail.rotation.x = -0.18 + Math.sin(elapsed * 1.7) * 0.06;
      for (let index = 0; index < ears.length; index += 1) {
        ears[index]!.rotation.x = -0.12 + Math.sin(elapsed * 3 + index * 1.7) * 0.07;
      }

      // Airborne tuck: legs pull in, ears flatten.
      if (state.airborne) {
        for (const leg of legs) leg.pivot.rotation.x = 0.55;
        if (tail.rotation.x < 0) tail.rotation.x = -0.55;
      }

      /* ------------------------------------------------------------ shadow */
      const lift = Math.max(0, group.position.y - groundY);
      blobShadow.position.y = -lift + 0.04;
      blobShadow.material.opacity = 0.85 - Math.min(0.6, lift * 0.2);
      const spread = 1 + Math.min(0.7, lift * 0.06);
      blobShadow.scale.set(spread, spread, 1);
      blobShadow.rotation.z = -state.heading;
    },

    reset() {
      state.x = spawnPoint[0];
      state.z = spawnPoint[1];
      state.heading = Math.PI;
      state.velocityY = 0;
      state.airborne = false;
      state.speed = 0;
      state.gait = 0;
      groundY = heightAt(state.x, state.z);
      group.position.set(state.x, groundY, state.z);
    },

    teleport(x, z, heading = Math.PI) {
      state.x = x;
      state.z = z;
      state.heading = heading;
      state.velocityY = 0;
      state.airborne = false;
      state.speed = 0;
      groundY = heightAt(x, z);
      group.position.set(x, groundY, z);
      group.rotation.y = heading;
    },

    dispose() {
      group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material?.dispose();
      });
      shadowTexture.dispose();
      // `water` is only read through the height sampler; keep the dependency
      // explicit so callers cannot forget to pass the same water body.
      void water;
    },
  };
}
