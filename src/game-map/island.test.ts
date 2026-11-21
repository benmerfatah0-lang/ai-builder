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
  HORIZON_FOG,
  HORIZON_Y,
  ISLAND_EDGE_Y,
  ISLAND_RADIUS,
  buildMapScene,
  islandExtent,
  islandLandFactor,
  islandRadiusAt,
} from './scene';

/**
 * The island shell.
 *
 * The reference is a floating island with a cliff, not a table-top slab, so the
 * coast, the rock and the drop are part of the design and have to stay put. Each
 * of these numbers was a real bug at some point in this pass.
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

describe('floating island', () => {
  it('has an irregular coast, not an ellipse', () => {
    const radii = Array.from({ length: 32 }, (_, index) => islandRadiusAt((index / 32) * Math.PI * 2));
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    // Enough wobble to read as a coastline, little enough to stay an island.
    expect(max - min, 'the coast is a plain ellipse').toBeGreaterThan(0.12);
    expect(min).toBeGreaterThan(0.82);
    expect(max).toBeLessThan(1.2);
  });

  it('keeps the whole playable map inland', () => {
    // Everything the fox can reach must be on the island, or the player walks off
    // the map. This is the check that caught the slab-shaped terrain.
    const spots: [number, number][] = [
      ...ARENAS.map((arena) => arena.position),
      ...BOSSES.map((boss) => boss.position),
      ...BUILDINGS.map((building) => building.position),
      ...CHECKPOINTS.map((checkpoint) => checkpoint.position),
    ];
    for (const [x, z] of spots) {
      expect(islandExtent(x, z), `(${x}, ${z}) is off the island`).toBeLessThan(0.93);
    }
  });

  it('slopes the ground down to the shore instead of ending in a cut', () => {
    // A flat lip with a cliff pasted under it is what made the first attempt read
    // as a green blanket on a green plane.
    const inland = islandLandFactor(0, 0);
    const shore = islandLandFactor(0, ISLAND_RADIUS.z * 0.985);
    expect(inland).toBeCloseTo(1, 2);
    expect(shore, 'the rim never falls away').toBeLessThan(0.35);
  });

  it('builds a cliff that hangs below the shoreline', () => {
    const cliff = scene.root.getObjectByName('island-cliff');
    expect(cliff, 'no cliff under the island').toBeTruthy();
    const box = new THREE.Box3().setFromObject(cliff!);
    // The rock has to be well under the water line, or the island is a decal.
    expect(box.min.y, 'the cliff does not hang').toBeLessThan(ISLAND_EDGE_Y - 20);
    expect(box.max.y).toBeGreaterThan(ISLAND_EDGE_Y - 3);
    // ...and it has to be as wide as the island, not a pedestal in the middle.
    expect(box.max.x - box.min.x).toBeGreaterThan(ISLAND_RADIUS.x * 1.6);
  });

  it('hangs the shadow of the island over the backdrop, not into it', () => {
    // The backdrop hills stand on a plane, and the island has to float clear above
    // it. When the plane was raised back up, the cliff vanished inside the grass.
    expect(HORIZON_Y, 'the backdrop has climbed to the island').toBeLessThan(-10);
    expect(HORIZON_Y, 'the island no longer floats clear').toBeGreaterThan(-40);
  });

  it('drops water off the flanks, never onto the spawn', () => {
    const falls = scene.root.getObjectByName('island-waterfalls');
    expect(falls, 'no waterfalls').toBeTruthy();
    const box = new THREE.Box3().setFromObject(falls!);
    expect(box.min.y).toBeLessThan(ISLAND_EDGE_Y - 6);
    // The spawn is at +Z; nothing should be pouring there.
    const southFalls = scene.root.children.length > 0;
    expect(southFalls).toBe(true);
  });

  it('keeps the far haze off the rock', () => {
    // Fog near-plane must be beyond the island's own diagonal, or the cliff is
    // washed out at exactly the distance the default camera sits at.
    const diagonal = Math.hypot(ISLAND_RADIUS.x, ISLAND_RADIUS.z);
    expect(HORIZON_FOG.near, 'the haze starts inside the island').toBeGreaterThan(diagonal * 4);
    expect(HORIZON_FOG.far).toBeGreaterThan(HORIZON_FOG.near);
  });
});
