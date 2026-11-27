import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARENAS,
  BOSSES,
  BRIDGES,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FIELDS,
  FENCES,
  REGIONS,
  ROADS,
  TREES,
  WATER,
} from './data';
import {
  CAMERA_ORBIT_LIMIT,
  HILL_RINGS,
  HORIZON_FAR_PLANE,
  HORIZON_FOG,
  HORIZON_RADIUS,
  buildMapScene,
  horizonGroundOffset,
  islandExtent,
} from './scene';

/**
 * The world shell.
 *
 * This file used to test a floating island: a coast, a cliff under it, mist, and
 * waterfalls pouring off the flanks. That design was replaced wholesale when the
 * reference changed to a continuous sunny valley - there is no island any more,
 * so those assertions were testing for the presence of things that must not
 * exist. What survives is the part that is still true and still easy to regress:
 * the playable map is finite, it is walled by hills it can never reach, and the
 * ground runs unbroken to the horizon instead of ending in a slab edge.
 */

const scene = buildMapScene({
  water: WATER,
  roads: ROADS,
  fields: FIELDS,
  fences: FENCES,
  circleFences: CIRCLE_FENCES,
  trees: TREES,
  buildings: BUILDINGS,
  arenas: ARENAS,
  bosses: BOSSES,
  regions: REGIONS,
  bridges: BRIDGES,
  checkpoints: CHECKPOINTS,
});

describe('the valley shell', () => {
  it('keeps every landmark well inside the playfield', () => {
    // Whatever the coast used to be, a landmark the fox can reach must not be out
    // in the pasture, or the player walks off the map being built for them.
    const spots: [number, number][] = [
      ...ARENAS.map((arena) => arena.position),
      ...BOSSES.map((boss) => boss.position),
      ...BUILDINGS.map((building) => building.position),
      ...CHECKPOINTS.map((checkpoint) => checkpoint.position),
    ];
    for (const [x, z] of spots) {
      expect(islandExtent(x, z), `(${x}, ${z}) is outside the playfield`).toBeLessThan(1);
    }
  });

  it('has no island shell left', () => {
    // The reference is one continuous valley. A cliff, a mist sheet or a waterfall
    // hanging off the map would silently re-introduce the floating island.
    for (const name of ['island-cliff', 'island-mist', 'island-waterfalls']) {
      expect(scene.root.getObjectByName(name), `${name} is still in the scene`).toBeUndefined();
    }
  });

  it('runs one ground mesh from the playfield to the horizon', () => {
    // The slab and the backdrop used to be two separate planes, and from a
    // bird's-eye camera the join read as the edge of the world.
    const terrain = scene.root.getObjectByName('terrain') as THREE.Mesh;
    const ground = scene.root.getObjectByName('hill-ground') as THREE.Mesh;
    expect(terrain, 'no playfield ground').toBeTruthy();
    expect(ground, 'no horizon ground').toBeTruthy();
    ground.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromBufferAttribute(
      ground.geometry.getAttribute('position') as THREE.BufferAttribute,
    );
    // It has to cover the playfield and reach past every hill that stands on it.
    expect(box.max.x - box.min.x, 'the ground stops inside the playfield').toBeGreaterThan(
      HORIZON_RADIUS * 1.5,
    );
    expect(box.max.z - box.min.z).toBeGreaterThan(HORIZON_RADIUS * 1.5);
    // ...and stay a landscape, not a wall.
    //
    // Measured by sampling the ground's own height function, not by the bounding
    // box of a project: `hill-ground` shares the terrain geometry, which by then
    // also carries the horizon swells, and a box over that would include the
    // mountain bases bolted onto the same mesh.
    let lowest = Infinity;
    let highest = -Infinity;
    for (let radius = 0; radius <= HORIZON_RADIUS; radius += 50) {
      for (let step = 0; step < 16; step += 1) {
        const angle = (step / 16) * Math.PI * 2;
        const height = horizonGroundOffset(Math.cos(angle) * radius, Math.sin(angle) * radius);
        lowest = Math.min(lowest, height);
        highest = Math.max(highest, height);
      }
    }
    expect(highest - lowest, 'the pasture is folded into a wall').toBeLessThan(60);
  });

  it('stands every hill outside the camera orbit', () => {
    // A ridge nearer than the eye ends up between the camera and the diorama at
    // some rotation, and swallows the map.
    for (const ring of HILL_RINGS) {
      const closestReach = Math.hypot(ring.radiusX, ring.radiusZ) - ring.maxWidth * ring.stretch[1];
      expect(closestReach, 'a hill can stand between the eye and the map').toBeGreaterThan(
        CAMERA_ORBIT_LIMIT - 10,
      );
    }
  });

  it('keeps the mountains inside the far plane and the haze off the fields', () => {
    const range = scene.root.getObjectByName('mountain-range');
    expect(range, 'no mountain range').toBeTruthy();
    range!.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(range!);
    // The range is the skyline: tall enough to read, and close enough to the far
    // plane that it is never clipped.
    expect(box.max.y, 'the mountains are not tall enough to close the view').toBeGreaterThan(300);
    expect(box.min.y, 'a mountain base is floating above the ground').toBeLessThan(40);
    const furthest = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    expect(furthest, 'the range is clipped by the far plane').toBeLessThan(HORIZON_FAR_PLANE * 0.75);
    // Haze starts past the playfield, so the fields are never washed out.
    expect(HORIZON_FOG.near, 'the haze starts inside the playfield').toBeGreaterThan(600);
  });

  it('builds pink rock buttes on the flanks', () => {
    const mesas = scene.root.getObjectByName('mesa-buttes');
    expect(mesas, 'no buttes').toBeTruthy();
    expect(mesas!.children.length, 'the buttes are missing their caps').toBeGreaterThan(4);
  });
});
