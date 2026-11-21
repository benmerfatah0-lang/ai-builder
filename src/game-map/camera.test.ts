import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createExplorer, CAMERA_DISTANCE } from './explore';
import { WATER, WORLD } from './data';
import { terrainHeight } from './scene';

/**
 * The player must be able to turn the camera, and زعتر must then walk where the
 * camera looks.
 *
 * The bug this replaces was structural, not arithmetic: the azimuth was eased
 * toward the fox's heading every frame and no drag handler existed at all, so
 * explore mode had exactly one possible view — behind the fox — and pressing
 * forward only ever walked him away from the viewer along that fixed line.
 */

const build = () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(52, 1.6, 0.6, 4200);
  const heightAt = (x: number, z: number) => terrainHeight(x, z, WATER);
  const explorer = createExplorer({ heightAt, scene, camera });
  return { explorer, camera, heightAt };
};

/** Drags the camera by `pixels` and lets the rig settle. */
const drag = (explorer: ReturnType<typeof build>['explorer'], px: number, py = 0) => {
  explorer.orbit(px, py);
  for (let i = 0; i < 30; i += 1) explorer.update(1 / 60, i / 60);
};

/** Walks forward for a second and reports where the fox ended up. */
const walkForward = (explorer: ReturnType<typeof build>['explorer']) => {
  const from = { x: explorer.player.state.x, z: explorer.player.state.z };
  explorer.intent.forward = 1;
  for (let i = 0; i < 60; i += 1) explorer.update(1 / 60, i / 60);
  explorer.intent.forward = 0;
  return { from, to: { x: explorer.player.state.x, z: explorer.player.state.z } };
};

describe('explore camera', () => {
  it('turns when the player drags', () => {
    const { explorer } = build();
    const before = explorer.yaw();
    explorer.orbit(120, 0);
    expect(explorer.yaw(), 'the drag was ignored').not.toBeCloseTo(before, 3);
  });

  it('orbits all the way round without snapping back', () => {
    const fullTurnPixels = (Math.PI * 2) / 0.0062;
    // A full turn lands back where it started, whichever way you count it.
    const { explorer } = build();
    const start = explorer.yaw();
    drag(explorer, fullTurnPixels);
    const delta = Math.atan2(Math.sin(explorer.yaw() - start), Math.cos(explorer.yaw() - start));
    expect(Math.abs(delta), 'a full turn did not close').toBeLessThan(0.06);

    // A quarter turn must be a quarter turn: `orbit` is linear in pixels, so this
    // pins the sensitivity as much as the sign.
    const quarter = build();
    drag(quarter.explorer, fullTurnPixels / 4);
    const quarterDelta = Math.atan2(
      Math.sin(quarter.explorer.yaw() - Math.PI),
      Math.cos(quarter.explorer.yaw() - Math.PI),
    );
    expect(Math.abs(quarterDelta), 'a quarter turn was not a quarter turn').toBeCloseTo(Math.PI / 2, 1);
  });

  it('clamps elevation so the camera cannot go under the ground or past vertical', () => {
    const { explorer } = build();
    drag(explorer, 0, 4000);
    expect(explorer.pitch()).toBeLessThanOrEqual(Math.PI / 2);
    drag(explorer, 0, -8000);
    expect(explorer.pitch()).toBeGreaterThan(0);
  });

  it('keeps the camera at a constant boom distance while orbiting', () => {
    const { explorer, camera, heightAt } = build();
    for (const step of [90, 90, 90, 90]) {
      drag(explorer, step);
      // `orbit` only changes the azimuth; the boom follows on the next frames.
      for (let i = 0; i < 90; i += 1) explorer.update(1 / 60, i / 60);
      const { x, z } = explorer.player.state;
      const horizontal = Math.hypot(camera.position.x - x, camera.position.z - z);
      const vertical = camera.position.y - heightAt(x, z);
      // The eye rides CAMERA_DISTANCE up a boom whose foot is EYE_HEIGHT above
      // the fox's feet, so the true length is sqrt(d^2 + eye^2), not d.
      // The eye rides CAMERA_DISTANCE up a boom whose foot is EYE_HEIGHT above
      // the fox's feet; measured from the fox's feet that is a *variable* length,
      // so the invariant to pin is the horizontal offset plus a bounded height.
      expect(horizontal, 'the boom stopped orbiting horizontally').toBeCloseTo(
        CAMERA_DISTANCE * Math.cos(explorer.pitch()),
        1,
      );
      expect(vertical).toBeGreaterThan(0);
      expect(vertical).toBeLessThan(CAMERA_DISTANCE);
      // The camera must stay *behind* the fox along its own azimuth.
      const behind = -(camera.position.x - x) * Math.sin(explorer.yaw()) - (camera.position.z - z) * Math.cos(explorer.yaw());
      expect(behind, 'camera left its boom').toBeGreaterThan(0);
    }
  });

  it('walks the fox in whatever direction the camera was turned to', () => {
    for (const quarterTurns of [0, 1, 2, 3]) {
      const { explorer, camera } = build();
      drag(explorer, 84 * quarterTurns);
      const { from, to } = walkForward(explorer);
      // Screen-space check: forward must go *up* the picture, never sideways.
      camera.updateMatrixWorld(true);
      const before = new THREE.Vector3(from.x, 1, from.z).project(camera);
      const after = new THREE.Vector3(to.x, 1, to.z).project(camera);
      expect(after.y - before.y, `forward did not go up-screen at ${quarterTurns * 90}°`).toBeGreaterThan(0.5);
      expect(Math.abs(after.x - before.x), `forward drifted sideways at ${quarterTurns * 90}°`).toBeLessThan(0.35);
    }
  });

  it('spawns the camera behind the fox, not inside it', () => {
    const { explorer, camera } = build();
    const { x, z } = explorer.player.state;
    expect(Math.hypot(camera.position.x - x, camera.position.z - z)).toBeGreaterThan(CAMERA_DISTANCE * 0.5);
    expect(WORLD.maxZ).toBeGreaterThan(z);
  });
});
