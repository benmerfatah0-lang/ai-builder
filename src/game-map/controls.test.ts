import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

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
