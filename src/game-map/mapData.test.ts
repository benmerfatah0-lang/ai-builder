import { describe, expect, it } from 'vitest';
import {
  ARENAS,
  ARENA_BY_ID,
  BOSSES,
  BOSS_BY_ID,
  BUILDINGS,
  CHECKPOINTS,
  FIELDS,
  LANDMARKS,
  REGIONS,
  REGION_ORDER,
  ROADS,
  STATS,
  WATER,
  WORLD,
} from './data';
import { terrainHeight } from './scene';

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
    // Arena hearts stay walkable: gentle slopes, above the flood line. The
    // bridge arena is deliberately built over the river, so it is exempt.
    for (const arena of ARENAS) {
      if (arena.style === 'bridge') continue;
      const height = terrainHeight(arena.position[0], arena.position[1], WATER);
      expect(height, `${arena.id} is underwater`).toBeGreaterThan(-0.4);
      expect(height, `${arena.id} is too steep`).toBeLessThan(4.2);
    }
  });
});
