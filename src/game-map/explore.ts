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
 * The camera is a proper third-person rig: the player drags to swing it around
 * the fox, and every movement key is resolved against the direction the camera
 * is looking. Turn the camera, press forward, and زعتر walks *there*. Before
 * this the chase camera was welded to the fox's heading and no drag was bound at
 * all, so rotating the view in explore mode was impossible.
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
  /** Camera azimuth in radians, so the HUD can show a compass-ish direction. */
  yaw?: number;
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
  /**
   * Swings the camera by a screen-space drag, in CSS pixels. Positive `dx` is a
   * drag to the right, positive `dy` a drag downwards.
   */
  orbit: (dx: number, dy: number) => void;
  /** Camera azimuth in radians (0 = looking along +Z). */
  yaw: () => number;
  /** Camera elevation in radians above the horizon. */
  pitch: () => number;
  dispose: () => void;
}

/** Camera boom length. Long enough to read the level, short enough to feel 3rd-person. */
export const CAMERA_DISTANCE = 26;
/** Height of the point the camera looks at, above the fox's feet. */
const EYE_HEIGHT = 2.2;
/** Default elevation of the boom: ~26°, the classic over-the-shoulder angle. */
const DEFAULT_PITCH = 0.46;
const MIN_PITCH = 0.1;
const MAX_PITCH = 1.12;
/** Radians of yaw per CSS pixel of horizontal drag. */
const YAW_PER_PIXEL = 0.0062;
const PITCH_PER_PIXEL = 0.0042;
const CAMERA_LAG = 9;
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

const wrapAngle = (value: number): number => {
  let wrapped = value;
  while (wrapped > Math.PI) wrapped -= Math.PI * 2;
  while (wrapped < -Math.PI) wrapped += Math.PI * 2;
  return wrapped;
};

export function createExplorer(options: {
  heightAt: (x: number, z: number) => number;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Element that receives camera drags (the WebGL canvas). */
  orbitElement?: HTMLElement | null;
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
  const target = new THREE.Vector3(SPAWN[0], heightAt(SPAWN[0], SPAWN[1]) + EYE_HEIGHT, SPAWN[1]);
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();

  /**
   * Azimuth the camera looks along, in world space (0 = +Z, +π/2 = +X).
   *
   * This is the *player's* control: a drag moves it, and nothing else does.
   * It used to be eased toward the fox's heading every frame, which meant the
   * camera could never be rotated — the fox dragged it back instantly.
   */
  let yaw = Math.PI;
  let pitch = DEFAULT_PITCH;

  const cameraFor = (x: number, z: number, ground: number, azimuth: number, elevation: number) => {
    const horizontal = CAMERA_DISTANCE * Math.cos(elevation);
    return desired.set(
      x - Math.sin(azimuth) * horizontal,
      ground + EYE_HEIGHT + CAMERA_DISTANCE * Math.sin(elevation),
      z - Math.cos(azimuth) * horizontal,
    );
  };

  const snapCamera = () => {
    const { x, z, heading } = player.state;
    const ground = heightAt(x, z);
    // Entering explore (or leaving a teleport) wants a sensible default: look
    // the way the fox is facing, at the standard elevation.
    yaw = wrapAngle(heading);
    pitch = DEFAULT_PITCH;
    target.set(x, ground + EYE_HEIGHT, z);
    camera.position.copy(cameraFor(x, z, ground, yaw, pitch));
    camera.lookAt(target);
  };
  snapCamera();

  /* ----------------------------------------------------------------- loop */
  const update = (dt: number, elapsed: number) => {
    const clampedDt = Math.min(dt, 0.05);
    const ground = heightAt(player.state.x, player.state.z);

    // Resolve the intent against the direction the camera is facing, so "W"
    // always walks away from the viewer no matter where the fox ended up.
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
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

    const { x, z } = player.state;
    lookAt.set(x, ground + EYE_HEIGHT + 0.35, z);
    const blend = Math.min(1, CAMERA_LAG * clampedDt);
    target.lerp(lookAt, blend);
    camera.position.lerp(cameraFor(x, z, ground, yaw, pitch), blend);
    camera.lookAt(target);
  };

  /* ---------------------------------------------------------- drag-to-look */
  const element = options.orbitElement ?? null;
  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  const orbit = (dx: number, dy: number) => {
    // Dragging right swings the view left (the horizon slides right), which is
    // what every third-person game does and what the hand expects.
    yaw = wrapAngle(yaw - dx * YAW_PER_PIXEL);
    pitch = THREE.MathUtils.clamp(pitch + dy * PITCH_PER_PIXEL, MIN_PITCH, MAX_PITCH);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    dragPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    element?.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (dragPointer === null || event.pointerId !== dragPointer) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    if (dx === 0 && dy === 0) return;
    orbit(dx, dy);
  };
  const endDrag = (event: PointerEvent) => {
    if (dragPointer !== null && dragPointer !== event.pointerId) return;
    if (dragPointer !== null) element?.releasePointerCapture?.(dragPointer);
    dragPointer = null;
  };

  if (element) {
    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', endDrag);
    element.addEventListener('pointercancel', endDrag);
  }

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
    orbit,
    yaw: () => yaw,
    pitch: () => pitch,
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
        yaw,
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
      if (element) {
        element.removeEventListener('pointerdown', onPointerDown);
        element.removeEventListener('pointermove', onPointerMove);
        element.removeEventListener('pointerup', endDrag);
        element.removeEventListener('pointercancel', endDrag);
      }
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

/**
 * Keyboard camera control, so a desktop reviewer with a trackpad can still turn
 * the view without dragging: Q/E swing left and right, R/F raise and lower.
 * The same rebindable intent-free path as `orbit`, just fed by keys.
 */
export function bindCameraKeys(getExplorer: () => { orbit: (dx: number, dy: number) => void }): () => void {
  const held = new Set<string>();
  const CODES = new Set(['KeyQ', 'KeyE', 'KeyR', 'KeyF']);
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (!CODES.has(event.code)) return;
    event.preventDefault();
    held.add(event.code);
  };
  const onKeyUp = (event: KeyboardEvent) => held.delete(event.code);
  const onBlur = () => held.clear();
  window.addEventListener('keydown', onKeyDown, { passive: false });
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  // Ticked from the render loop rather than a timer, so it costs nothing idle.
  let frame = 0;
  const tick = () => {
    const explorer = getExplorer();
    if (held.size) {
      const dx = (held.has('KeyQ') ? 18 : 0) - (held.has('KeyE') ? 18 : 0);
      const dy = (held.has('KeyR') ? 12 : 0) - (held.has('KeyF') ? 12 : 0);
      if (dx || dy) explorer.orbit(dx, dy);
    }
    frame = window.requestAnimationFrame(tick);
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    window.cancelAnimationFrame(frame);
  };
}
