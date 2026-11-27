import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createExplorer } from './explore';

/**
 * The camera-relative control frame must agree with the picture on screen.
 *
 * This is the one bug class a reviewer cannot diagnose from code: pressing D
 * walked زعتر *left*, and pressing W sometimes walked him backwards, because the
 * strafe axis was negated relative to what `camera.lookAt` actually projects.
 * The maths is easy to get backwards twice, so it is pinned here.
 *
 * Frame used by `createExplorer().update`:
 *   forwardX =  sin(cameraFacing), forwardZ =  cos(cameraFacing)
 *   rightX   = -forwardZ,          rightZ   =  forwardX
 */
const frame = (facing: number) => ({
  forwardX: Math.sin(facing),
  forwardZ: Math.cos(facing),
  rightX: -Math.cos(facing),
  rightZ: Math.sin(facing),
});

const cameraFor = (facing: number, distance = 24) => {
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.4, 2000);
  // The camera sits behind the fox; the fox is at the origin.
  camera.position.set(-Math.sin(facing) * distance, 10, -Math.cos(facing) * distance);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
};

const FACINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI * 0.75];

describe('explore control frame', () => {
  it('strafe-right lands on the right half of the screen at every facing', () => {
    for (const facing of FACINGS) {
      const camera = cameraFor(facing);
      const { rightX, rightZ } = frame(facing);
      const ndc = new THREE.Vector3(rightX * 5, 0, rightZ * 5).project(camera);
      expect(ndc.x, `strafe-right went left at facing ${facing.toFixed(2)}`).toBeGreaterThan(0.01);
    }
  });

  it('forward walks away from the camera and stays centred', () => {
    for (const facing of FACINGS) {
      const camera = cameraFor(facing);
      const { forwardX, forwardZ } = frame(facing);
      const origin = new THREE.Vector3(0, 0, 0).project(camera);
      const ahead = new THREE.Vector3(forwardX * 5, 0, forwardZ * 5).project(camera);
      expect(ahead.y, `forward moved toward the camera at ${facing.toFixed(2)}`).toBeGreaterThan(origin.y);
      expect(Math.abs(ahead.x), 'forward drifted sideways').toBeLessThan(1e-3);
    }
  });

  it('the two axes are perpendicular and unit length', () => {
    for (const facing of FACINGS) {
      const { forwardX, forwardZ, rightX, rightZ } = frame(facing);
      expect(Math.hypot(forwardX, forwardZ)).toBeCloseTo(1, 6);
      expect(Math.hypot(rightX, rightZ)).toBeCloseTo(1, 6);
      expect(forwardX * rightX + forwardZ * rightZ).toBeCloseTo(0, 6);
    }
  });
});

/**
 * The movement verbs themselves.
 *
 * A control scheme is not "excellent" because the keys are bound; it is excellent
 * if walk, run, jump, slide and camera-follow do measurably different things. Each
 * of these assertions is a thing a player would notice immediately if it broke.
 */
describe('explore movement verbs', () => {
  const build = () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.6, 9000);
    const explorer = createExplorer({ heightAt: () => 0, scene, camera, orbitElement: null });
    return explorer;
  };
  const step = (explorer: ReturnType<typeof build>, frames: number) => {
    const dt = 1 / 60;
    for (let index = 0; index < frames; index += 1) explorer.update(dt, index * dt);
  };

  it('runs clearly faster than it walks', () => {
    const explorer = build();
    explorer.intent.forward = 1;
    step(explorer, 90);
    const walk = explorer.player.state.speed;
    explorer.intent.sprint = true;
    step(explorer, 90);
    const run = explorer.player.state.speed;
    expect(walk).toBeGreaterThan(5);
    expect(run, 'Shift does not make the fox run').toBeGreaterThan(walk * 1.7);
  });

  it('leaves the ground on a jump and comes back down', () => {
    const explorer = build();
    explorer.intent.jump = true;
    explorer.update(1 / 60, 0);
    expect(explorer.player.state.airborne, 'jump never left the ground').toBe(true);
    let peak = explorer.player.group.position.y;
    for (let index = 0; index < 120; index += 1) {
      explorer.update(1 / 60, index / 60);
      peak = Math.max(peak, explorer.player.group.position.y);
    }
    expect(peak, 'the jump is too shallow to clear anything').toBeGreaterThan(1.5);
    expect(explorer.player.state.airborne, 'the fox never landed').toBe(false);
  });

  it('slides only while moving, and keeps its momentum', () => {
    const explorer = build();
    explorer.intent.forward = 1;
    explorer.intent.sprint = true;
    step(explorer, 120);
    const before = explorer.player.state.speed;
    explorer.intent.slide = true;
    step(explorer, 20);
    expect(explorer.sliding(), 'slide never engaged at full speed').toBe(true);
    // Steerage drops, but the fox must not stop dead: that is a brake, not a slide.
    expect(explorer.player.state.speed, 'the slide killed all momentum').toBeGreaterThan(before * 0.75);
    explorer.intent.slide = false;
    step(explorer, 10);
    expect(explorer.sliding()).toBe(false);
  });

  it('does not slide while standing still', () => {
    const explorer = build();
    explorer.intent.slide = true;
    step(explorer, 10);
    expect(explorer.sliding(), 'the fox can slide on the spot').toBe(false);
  });

  it('auto-follows the fox after the view is dragged away', () => {
    const explorer = build();
    explorer.intent.forward = 1;
    step(explorer, 30);
    explorer.setAutoFollow(true);
    explorer.orbit(600, 0);
    const before = explorer.yaw();
    step(explorer, 180);
    expect(explorer.autoFollow()).toBe(true);
    expect(Math.abs(explorer.yaw() - before), 'the camera never came back behind the fox').toBeGreaterThan(0.2);
  });

  it('leaves the camera alone when auto-follow is off', () => {
    const explorer = build();
    explorer.intent.forward = 1;
    step(explorer, 30);
    explorer.orbit(400, 0);
    const before = explorer.yaw();
    step(explorer, 120);
    expect(explorer.yaw(), 'the camera drifted although auto-follow is off').toBeCloseTo(before, 5);
  });
});
