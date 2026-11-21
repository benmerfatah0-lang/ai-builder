import * as THREE from 'three';
import { CHECKPOINTS, REGIONS, WATER, WORLD } from './data';
import type { RegionDef } from './types';
import { createFoxPlayer, type FoxPlayer } from './player';

/**
 * "Explore" mode: walk the map as زعتر instead of orbiting it.
 *
 * This is a *discovery* mode, not gameplay. It answers the designer's question
 * "how does this route actually feel?" — the river pinch point, the long quiet
 * approach to the palace, the way the crops fields hide the horizon — without a
 * single hitbox, health bar or enemy.
 *
 * Input is a tiny abstraction: the keyboard driver and the on-screen touch
 * joystick both write into `intent`, so the motion model has one source.
 */

/** Movement intent, already normalised to -1..1 and camera-relative. */
export interface MoveIntent {
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
}

export interface ExploreStatus {
  x: number;
  z: number;
  speed: number;
  sprinting: boolean;
  regionName: string | null;
  /** 0 at the prologue (south edge) → 1 at the palace (north edge). */
  progress: number;
  wading: boolean;
}

export interface ExploreHandle {
  player: FoxPlayer;
  /** Live intent object; the touch UI mutates this directly. */
  intent: MoveIntent;
  /** Ticks the fox and the chase camera. Call from the render loop. */
  update: (dt: number, elapsed: number) => void;
  status: () => ExploreStatus;
  regionAt: () => RegionDef | null;
  /** Nearest checkpoint inside `radius`, for the discovery toast. */
  nearestCheckpoint: (radius?: number) => { id: string; name: string; distance: number } | null;
  /** Snaps the chase camera behind the fox after a teleport. */
  snapCamera: () => void;
  /** True once the player has moved at all. */
  hasMoved: () => boolean;
  dispose: () => void;
}

const CAMERA_DISTANCE = 24;
const CAMERA_HEIGHT = 14;
const CAMERA_LAG = 5.5;
// Just north of the start-wood: an open clearing on the trail, so the player
// gets a readable first frame instead of a face full of pines.
const SPAWN: [number, number] = [2, 128];

const insidePolygon = (x: number, z: number, polygon: [number, number][]): boolean => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, zi] = polygon[index]!;
    const [xp, zp] = polygon[previous]!;
    if (zi > z !== zp > z && x < ((xp - xi) * (z - zi)) / (zp - zi) + xi) inside = !inside;
  }
  return inside;
};

export function createExplorer(options: {
  heightAt: (x: number, z: number) => number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Fires the first time the fox moves, so the viewer can retire its hints. */
  onFirstMove?: () => void;
}): ExploreHandle {
  const { heightAt, scene, camera } = options;

  const player = createFoxPlayer({
    heightAt,
    water: WATER,
    bounds: WORLD,
    spawn: SPAWN,
  });
  scene.add(player.group);

  const intent: MoveIntent = { forward: 0, strafe: 0, sprint: false, jump: false };
  let moved = false;

  /* --------------------------------------------------------------- camera */
  const target = new THREE.Vector3(SPAWN[0], heightAt(SPAWN[0], SPAWN[1]) + 2.2, SPAWN[1]);
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  /**
   * Yaw the chase camera is looking along. The camera sits *behind* the fox, so
   * this equals the fox's heading; it is tracked separately because a stale
   * frame must not feed back into the motion model and spin the fox.
   */
  let cameraFacing = Math.PI;

  const cameraFor = (x: number, z: number, ground: number, heading: number): THREE.Vector3 =>
    desired.set(
      x - Math.sin(heading) * CAMERA_DISTANCE,
      ground + CAMERA_HEIGHT,
      z - Math.cos(heading) * CAMERA_DISTANCE,
    );

  const snapCamera = () => {
    const { x, z, heading } = player.state;
    const ground = heightAt(x, z);
    target.set(x, ground + 2.2, z);
    camera.position.copy(cameraFor(x, z, ground, heading));
    camera.lookAt(target);
  };
  snapCamera();

  /* ----------------------------------------------------------------- loop */
  const update = (dt: number, elapsed: number) => {
    const clampedDt = Math.min(dt, 0.05);
    const ground = heightAt(player.state.x, player.state.z);

    // Resolve the intent against the direction the camera is facing, so "W"
    // always walks away from the viewer no matter which way the fox turned.
    const forwardX = Math.sin(cameraFacing);
    const forwardZ = Math.cos(cameraFacing);
    // Screen-right axis. `camera.lookAt` keeps world +X to the right of the
    // view (it builds an up=[0,1,0] basis), so screen-right is `+forwardZ` on X
    // and `-forwardX` on Z... with the sign that *matches* the screen. This was
    // previously mirrored, so pressing D walked the fox left.
    const rightX = -forwardZ;
    const rightZ = forwardX;
    const dirX = forwardX * intent.forward + rightX * intent.strafe;
    const dirZ = forwardZ * intent.forward + rightZ * intent.strafe;

    player.step(clampedDt, { dirX, dirZ, sprint: intent.sprint, jump: intent.jump }, elapsed);
    // `jump` is an edge-triggered request: consume it so holding Space does not
    // keep the fox airborne forever.
    intent.jump = false;

    if (!moved && (Math.abs(intent.forward) > 0.01 || Math.abs(intent.strafe) > 0.01)) {
      moved = true;
      options.onFirstMove?.();
    }

    const { x, z, heading } = player.state;
    lookAt.set(x, ground + 2.2, z);
    target.lerp(lookAt, Math.min(1, CAMERA_LAG * clampedDt));
    camera.position.lerp(cameraFor(x, z, ground, heading), Math.min(1, CAMERA_LAG * clampedDt));
    camera.lookAt(target);
    // Ease the control frame toward the fox so the camera never snaps.
    let turn = heading - cameraFacing;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    cameraFacing += turn * Math.min(1, 3 * clampedDt);
  };

  /* ---------------------------------------------------------------- status */
  const regionAt = (): RegionDef | null => {
    for (const region of REGIONS) {
      if (insidePolygon(player.state.x, player.state.z, region.polygon)) return region;
    }
    return null;
  };

  return {
    player,
    intent,
    update,
    regionAt,
    snapCamera,
    hasMoved: () => moved,

    status: () => {
      const { x, z, speed, sprinting } = player.state;
      const region = regionAt();
      return {
        x,
        z,
        speed,
        sprinting,
        regionName: region ? region.name : null,
        progress: THREE.MathUtils.clamp((WORLD.maxZ - z) / (WORLD.maxZ - WORLD.minZ), 0, 1),
        wading: heightAt(x, z) < -0.55,
      };
    },

    nearestCheckpoint: (radius = 9.5) => {
      let best: { id: string; name: string; distance: number } | null = null;
      for (const checkpoint of CHECKPOINTS) {
        const distance = Math.hypot(
          checkpoint.position[0] - player.state.x,
          checkpoint.position[1] - player.state.z,
        );
        if (distance <= radius && (!best || distance < best.distance)) {
          best = { id: checkpoint.id, name: checkpoint.name, distance };
        }
      }
      return best;
    },

    dispose: () => {
      scene.remove(player.group);
      player.dispose();
    },
  };
}

/** Keyboard → intent. Mounted only while explore mode is active. */
export function bindKeyboard(getIntent: () => MoveIntent): () => void {
  const keys = new Set<string>();
  const MOVE_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Space', 'ShiftLeft', 'ShiftRight',
  ]);
  const typing = (event: KeyboardEvent): boolean => {
    const target = event.target as HTMLElement | null;
    return Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
  };
  const sync = () => {
    const intent = getIntent();
    const forward = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    const strafe = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const magnitude = Math.hypot(forward, strafe);
    intent.forward = magnitude > 1 ? forward / magnitude : forward;
    intent.strafe = magnitude > 1 ? strafe / magnitude : strafe;
    // Sprint must be *held*, not toggled. The old `|| intent.sprint` made one
    // Shift press sprint forever, because nothing ever set the flag back.
    intent.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    if (keys.has('Space')) intent.jump = true;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (typing(event)) return;
    if (MOVE_CODES.has(event.code)) {
      event.preventDefault();
      // A focused <button> treats Space/Enter as "activate me", which swallows
      // the jump and re-fires whichever HUD button was last clicked. Blurring
      // it gives the movement keys the whole keyboard back.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && typeof active.blur === 'function') {
        active.blur();
      }
    }
    keys.add(event.code);
    sync();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    keys.delete(event.code);
    sync();
  };
  const onBlur = () => {
    keys.clear();
    sync();
  };
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
