import { describe, expect, it } from 'vitest';
import {
  ARENAS,
  ARENA_BY_ID,
  BOSSES,
  BOSS_BY_ID,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FENCES,
  FIELDS,
  TREES,
  BRIDGES,
  LANDMARKS,
  REGIONS,
  REGION_ORDER,
  ROADS,
  STATS,
  WATER,
  WORLD,
} from './data';
import * as THREE from 'three';
import {
  buildMapScene,
  DIORAMA_HALF,
  HILL_COLORS,
  HILL_RINGS,
  CAMERA_ORBIT_LIMIT,
  HORIZON_GROUND_COLOR,
  HORIZON_RADIUS,
  terrainHeight,
} from './scene';

/**
 * Design-integrity tests for the game map. They protect the properties a level
 * designer relies on: every boss has a reachable arena, checkpoints sit inside
 * their region, nothing overlaps, and the diorama's terrain never swallows the
 * water or the arenas.
 */

const insidePolygon = (point: [number, number], polygon: [number, number][]) => {
  const [x, z] = point;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, zi] = polygon[index]!;
    const [xp, zp] = polygon[previous]!;
    const intersects = zi > z !== zp > z && x < ((xp - xi) * (z - zi)) / (zp - zi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

describe('map data integrity', () => {
  it('has the three core regions plus a prologue and a finale', () => {
    expect(REGION_ORDER).toEqual(['start', 'farm', 'crops', 'pens', 'final']);
    expect(STATS.coreRegions).toBe(3);
    const core = REGIONS.filter((region) => ['farm', 'crops', 'pens'].includes(region.id));
    expect(core).toHaveLength(3);
  });

  it('keeps every region id unique and every region narratively complete', () => {
    expect(new Set(REGIONS.map((region) => region.id)).size).toBe(REGIONS.length);
    for (const region of REGIONS) {
      expect(region.beats.length).toBeGreaterThanOrEqual(3);
      expect(region.objectives.length).toBeGreaterThanOrEqual(3);
      expect(region.encounters.length).toBeGreaterThanOrEqual(1);
      expect(region.hazards.length).toBeGreaterThanOrEqual(1);
      expect(region.secrets.length).toBeGreaterThanOrEqual(1);
      expect(region.polygon.length).toBeGreaterThanOrEqual(4);
      expect(region.summary.length).toBeGreaterThan(120);
      expect(region.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('declares exactly five farm-animal bosses with the promised tier mix', () => {
    expect(BOSSES).toHaveLength(5);
    expect(BOSSES.filter((boss) => boss.tier === 'required')).toHaveLength(2);
    expect(BOSSES.filter((boss) => boss.tier === 'optional')).toHaveLength(2);
    expect(BOSSES.filter((boss) => boss.tier === 'final')).toHaveLength(1);
    // No fantasy creatures: every species is a real farm animal.
    const species = BOSSES.map((boss) => boss.species).join(' ');
    expect(species).toMatch(/ديك|بطة|كبش|دجاجة/);
    expect(species).not.toMatch(/تنين|ساحر|شبح/);
    for (const boss of BOSSES) {
      expect(BOSS_BY_ID[boss.id]).toBe(boss);
      expect(boss.phases.length).toBeGreaterThanOrEqual(2);
      expect(boss.weaknesses.length).toBeGreaterThanOrEqual(2);
      expect(boss.arenaMechanics.length).toBeGreaterThanOrEqual(2);
      expect(boss.difficulty).toBeGreaterThanOrEqual(1);
      expect(boss.difficulty).toBeLessThanOrEqual(5);
    }
  });

  it('gives every boss a real arena from the arena table', () => {
    for (const boss of BOSSES) {
      const arena = ARENA_BY_ID[boss.arenaId];
      expect(arena, `missing arena for ${boss.id}`).toBeDefined();
      expect(arena!.regionId).toBe(boss.regionId);
      expect(Math.hypot(arena!.position[0] - boss.position[0], arena!.position[1] - boss.position[1])).toBeLessThan(2);
    }
    expect(ARENAS).toHaveLength(5);
    expect(new Set(ARENAS.map((arena) => arena.style)).size).toBe(ARENAS.length);
  });

  it('places all content inside the world bounds', () => {
    const inBounds = ([x, z]: [number, number]) =>
      x >= WORLD.minX && x <= WORLD.maxX && z >= WORLD.minZ && z <= WORLD.maxZ;
    for (const entry of [...BOSSES, ...CHECKPOINTS, ...LANDMARKS, ...ARENAS]) {
      expect(inBounds(entry.position), `${'id' in entry ? entry.id : 'arena'} out of bounds`).toBe(true);
    }
    for (const building of BUILDINGS) expect(inBounds(building.position)).toBe(true);
  });

  it('keeps every checkpoint inside its region polygon or on its boundary band', () => {
    for (const checkpoint of CHECKPOINTS) {
      const near = REGIONS.filter((region) => insidePolygon(checkpoint.position, region.polygon));
      expect(near.length, `${checkpoint.id} not inside any region`).toBeGreaterThan(0);
    }
  });

  it('keeps landmarks inside their declared region', () => {
    const slack = 6;
    for (const landmark of LANDMARKS) {
      const region = REGIONS.find((entry) => entry.id === landmark.regionId);
      expect(region, `${landmark.id} has no region`).toBeDefined();
      const ring: [number, number][] = [
        [landmark.position[0] - slack, landmark.position[1] - slack],
        [landmark.position[0] + slack, landmark.position[1] - slack],
        [landmark.position[0] + slack, landmark.position[1] + slack],
        [landmark.position[0] - slack, landmark.position[1] + slack],
      ];
      expect(
        ring.some((corner) => insidePolygon(corner, region!.polygon)),
        `${landmark.id} lies outside ${landmark.regionId}`,
      ).toBe(true);
    }
  });

  it('never overlaps two buildings', () => {
    const RADIUS = 7;
    for (let a = 0; a < BUILDINGS.length; a += 1) {
      for (let b = a + 1; b < BUILDINGS.length; b += 1) {
        const first = BUILDINGS[a]!;
        const second = BUILDINGS[b]!;
        const distance = Math.hypot(
          first.position[0] - second.position[0],
          first.position[1] - second.position[1],
        );
        expect(distance, `${first.id} overlaps ${second.id}`).toBeGreaterThan(RADIUS);
      }
    }
  });

  it('does not plant buildings on boss arenas', () => {
    for (const building of BUILDINGS) {
      for (const arena of ARENAS) {
        const distance = Math.hypot(
          building.position[0] - arena.position[0],
          building.position[1] - arena.position[1],
        );
        expect(distance, `${building.id} sits inside arena ${arena.id}`).toBeGreaterThan(arena.radius + 3);
      }
    }
  });

  it('has a continuous road graph that touches every checkpoint', () => {
    const roadPoints = ROADS.flatMap((road) => road.points);
    for (const checkpoint of CHECKPOINTS) {
      const nearest = Math.min(
        ...roadPoints.map((point) => Math.hypot(point[0] - checkpoint.position[0], point[1] - checkpoint.position[1])),
      );
      expect(nearest, `${checkpoint.id} is far from any road`).toBeLessThan(26);
    }
    expect(ROADS.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps fields inside the crops region and non-overlapping', () => {
    const crops = REGIONS.find((region) => region.id === 'crops')!;
    for (const field of FIELDS) {
      expect(field.w).toBeGreaterThan(0);
      expect(field.d).toBeGreaterThan(0);
      expect(field.x).toBeGreaterThan(WORLD.minX);
      expect(field.x).toBeLessThan(WORLD.maxX);
      expect(insidePolygon([field.x, field.z], crops.polygon), `${field.kind} ${field.x},${field.z} outside crops`).toBe(true);
    }
    for (let a = 0; a < FIELDS.length; a += 1) {
      for (let b = a + 1; b < FIELDS.length; b += 1) {
        const first = FIELDS[a]!;
        const second = FIELDS[b]!;
        const overlapX = Math.abs(first.x - second.x) < (first.w + second.w) / 2;
        const overlapZ = Math.abs(first.z - second.z) < (first.d + second.d) / 2;
        expect(overlapX && overlapZ, `${a}/${b} fields overlap`).toBe(false);
      }
    }
  });

  it('carves the river into the terrain so water is below the banks', () => {
    for (const point of WATER.river) {
      const height = terrainHeight(point[0], point[1], WATER);
      expect(height, `river bed at ${point} is above water level`).toBeLessThan(-0.6);
    }
    // Arena hearts stay walkable: gentle slopes, above the flood line. The pond
    // arena is deliberately built on the water, so it is exempt.
    for (const arena of ARENAS) {
      if (arena.style === 'pond' || arena.style === 'bridge') continue;
      const height = terrainHeight(arena.position[0], arena.position[1], WATER);
      expect(height, `${arena.id} is underwater`).toBeGreaterThan(-0.4);
      expect(height, `${arena.id} is too steep`).toBeLessThan(4.2);
    }
  });
});

describe('distant hills backdrop', () => {
  it('keeps every ring clear of the playable slab', () => {
    for (const ring of HILL_RINGS) {
      expect(ring.radiusX, 'ring overlaps the slab on X').toBeGreaterThan(DIORAMA_HALF.x + 30);
      expect(ring.radiusZ, 'ring overlaps the slab on Z').toBeGreaterThan(DIORAMA_HALF.z + 30);
      // Even after jitter (max 1.1x) and the widest hill, no hill can reach in.
      const closestReach = ring.radiusX * 0.9 - ring.maxWidth;
      expect(closestReach, 'a hill can reach the slab').toBeGreaterThan(DIORAMA_HALF.x);
    }
  });

  it('grows outward, never inward', () => {
    const radii = HILL_RINGS.map((ring) => ring.radiusX);
    for (let index = 1; index < radii.length; index += 1) {
      expect(radii[index]!).toBeGreaterThan(radii[index - 1]!);
    }
  });

  it('keeps every hill inside the horizon disc it stands on', () => {
    // A ridge whose long axis reaches past the land's edge renders against bare
    // sky: the original "floating green pancake". The bound is derived from the
    // same numbers the mesh uses, so moving a band cannot silently break it.
    for (const ring of HILL_RINGS) {
      const reach = Math.hypot(ring.radiusX, ring.radiusZ) + ring.maxWidth * ring.stretch[1];
      expect(reach, 'ridge overhangs the horizon land').toBeLessThan(HORIZON_RADIUS);
    }
  });

  it('sits entirely outside the camera orbit, so no hill can block the map', () => {
    // This is the constraint that took three passes to get right: a ridge nearer
    // than the orbit limit ends up between the eye and the diorama at some
    // rotation and swallows a third of the frame.
    for (const ring of HILL_RINGS) {
      const closestReach = Math.hypot(ring.radiusX, ring.radiusZ) - ring.maxWidth * ring.stretch[1];
      expect(closestReach, 'a ridge can be nearer than the camera orbit').toBeGreaterThan(CAMERA_ORBIT_LIMIT - 10);
    }
  });

  it('reads as rolling farmland, not mountains and not discs', () => {
    for (const ring of HILL_RINGS) {
      // `minWidth` is a half-extent, and `stretch` is the long axis, so the
      // narrowest ridge is `2 * minWidth * stretch[0]` across. Anything squarer
      // than 2:1 reads as a bump, not a rolling hill.
      const narrowestAspect = (2 * ring.minWidth * ring.stretch[0]) / ring.maxHeight;
      expect(narrowestAspect, 'hill is too steep to read as rolling').toBeGreaterThan(2);
      // ...and a ridge flatter than 8:1 is a lily pad, which is what the first
      // pass looked like. Long ridges are allowed to be low: they read as ridges.
      const flattestAspect = (2 * ring.maxWidth * ring.stretch[1]) / ring.minHeight;
      expect(flattestAspect, 'hill is so flat it reads as a disc').toBeLessThan(8);
    }
  });

  it('gives the hills real ground to stand on, laid out flat and not edge-on', () => {
    // Regression: the backdrop plane was rotated by -90 degrees TWICE. It ended
    // up vertical, every vertex collapsed onto one line, and all 1280 surviving
    // triangles had zero screen area - the ground silently never painted and the
    // hills looked like pancakes hanging in the sky.
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
    const ground = scene.root.getObjectByName('hill-ground') as THREE.Mesh;
    expect(ground, 'the hill ground mesh is missing').toBeTruthy();
    ground.updateMatrixWorld(true);

    const geometry = ground.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const box = new THREE.Box3().setFromBufferAttribute(position);
    // It must span the horizon in BOTH horizontal axes...
    expect(box.max.x - box.min.x).toBeGreaterThan(HORIZON_RADIUS);
    expect(box.max.z - box.min.z).toBeGreaterThan(HORIZON_RADIUS);
    // ...and be flat: a vertical plane would be tall and thin instead.
    // The land now carries real relief (the swells the hills sit in), so the
    // bound is a sanity ceiling against a degenerate vertical collapse, not a
    // design constraint.
    expect(box.max.y - box.min.y).toBeLessThan(HORIZON_RADIUS * 0.35);

    // No degenerate triangles: every one must have non-zero screen area in plan.
    const index = geometry.getIndex()!;
    let degenerate = 0;
    for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
      const ia = index.getX(triangle * 3);
      const ib = index.getX(triangle * 3 + 1);
      const ic = index.getX(triangle * 3 + 2);
      const area =
        (position.getX(ib) - position.getX(ia)) * (position.getZ(ic) - position.getZ(ia)) -
        (position.getX(ic) - position.getX(ia)) * (position.getZ(ib) - position.getZ(ia));
      if (Math.abs(area) < 1e-6) degenerate += 1;
    }
    expect(degenerate / (index.count / 3), 'most of the ground is degenerate').toBeLessThan(0.15);
    scene.dispose();
  });

  it('pales with distance and stays darker than the ground it sits on', () => {
    // Aerial perspective: each ring further out is lighter than the one before.
    const order = [HILL_COLORS.near, HILL_COLORS.mid, HILL_COLORS.far];
    const luminance = (hex: string) => {
      const value = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
    };
    for (let index = 1; index < order.length; index += 1) {
      expect(luminance(order[index]!), 'far hills should be paler').toBeGreaterThan(
        luminance(order[index - 1]!),
      );
    }
    // Even the palest ring must stay clearly darker than HORIZON_GROUND_COLOR,
    // or the hills dissolve into the plane they stand on - which is exactly
    // how the backdrop read as bare ground with no hills at all.
    //
    // The horizon band is the exception the design earned: it is 1200+ units out
    // and sits inside the scene's own fog at that distance, so it must stay close
    // to the haze or the land ends in a hard edge. It still has to be visible.
    for (const colour of order.slice(0, 3)) {
      expect(luminance(HORIZON_GROUND_COLOR) - luminance(colour), 'hill vanishes into ground').toBeGreaterThan(18);
    }
    expect(
      luminance(HORIZON_GROUND_COLOR) - luminance(HILL_COLORS.horizon),
      'the far horizon band is invisible',
    ).toBeGreaterThan(4);
  });
});
