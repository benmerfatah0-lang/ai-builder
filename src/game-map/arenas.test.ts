import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ARENAS,
  BOSSES,
  BRIDGES,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FENCES,
  FIELDS,
  REGIONS,
  ROADS,
  TREES,
  WATER,
} from './data';
import { buildMapScene } from './scene';

/**
 * Every boss fights at home.
 *
 * The design rule the reviewer asked for: «إجعل لكل بوس الأريا التي تناسبه —
 * المزارع داخل البيت، البطة في البركة، الكلب في بيته». The old builder gave all
 * five the same raised disc of earth, so the map could not show that rule at all.
 * These tests pin the rule to the geometry that ships.
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

const arenaGroup = (id: string) => {
  const group = scene.root.getObjectByName(`arena-${id}`);
  expect(group, `arena ${id} was never built`).toBeTruthy();
  return group!;
};

describe('boss homes', () => {
  it('gives the rooster a farmhouse to come out of', () => {
    const group = arenaGroup('yard');
    const house = group.getObjectByName('building-yard-house');
    expect(house, 'the rooster has no house').toBeTruthy();
    expect(house!.userData.buildingKind).toBe('farmhouse');
  });

  it('puts the duck in water, not on mud', () => {
    const group = arenaGroup('bridge');
    const pond = group.getObjectByName('arena-pond-water');
    expect(pond, 'no water in the duck arena').toBeTruthy();
    // Her pond must be the biggest thing in there: a puddle would not read.
    const box = new THREE.Box3().setFromObject(pond!);
    const arena = ARENAS.find((entry) => entry.id === 'bridge')!;
    expect(box.max.x - box.min.x).toBeGreaterThan(arena.radius);
  });

  it('gives the turkey an open granary on his threshing floor', () => {
    const group = arenaGroup('threshing');
    const granary = group.getObjectByName('building-threshing-granary');
    expect(granary, 'the turkey has no granary').toBeTruthy();
    expect(granary!.userData.buildingKind).toBe('threshingGranary');
  });

  it('declares a home for the bosses that live somewhere, and none where the palace already is one', () => {
    const byStyle = Object.fromEntries(ARENAS.map((arena) => [arena.style, arena]));
    expect(byStyle.farmhouse!.home?.kind).toBe('house');
    expect(byStyle.pond!.home?.kind).toBe('pond');
    expect(byStyle.threshing!.home?.kind).toBe('threshing');
    // The hen palace is a building of its own; the arena needs no second home.
    expect(byStyle.palace!.home?.kind).toBe('palace');
  });

  it('keeps each home inside its own arena, not off in the fields', () => {
    for (const arena of ARENAS) {
      if (!arena.home) continue;
      const [ox, oz] = arena.home.offset;
      const distance = Math.hypot(ox, oz);
      expect(distance, `${arena.id}'s home sits outside the arena`).toBeLessThan(arena.radius + 12);
    }
  });

  it('gives every arena its own ground, so no two read the same', () => {
    const tones = new Set(ARENAS.map((arena) => arena.floor));
    expect(tones.size, 'arenas share one floor tone').toBeGreaterThan(2);
  });

  it('still gives every boss an arena it can stand in', () => {
    for (const boss of BOSSES) {
      const arena = ARENAS.find((entry) => entry.id === boss.arenaId);
      expect(arena, `${boss.id} has no arena`).toBeTruthy();
      const distance = Math.hypot(
        arena!.position[0] - boss.position[0],
        arena!.position[1] - boss.position[1],
      );
      expect(distance, `${boss.id} stands outside its own arena`).toBeLessThan(arena!.radius);
    }
  });
});
