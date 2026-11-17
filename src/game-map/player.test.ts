import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFoxPlayer } from './player';
import { WATER, WORLD } from './data';
import { terrainHeight } from './scene';

/**
 * The fox is the only thing in the map that has to *feel* right, and no
 * screenshot can prove that. These tests drive the motion model directly and
 * assert the properties a player would notice immediately: the fox stays on the
 * ground, W moves it, it cannot leave the map, it slows in water, and it lands.
 */

const heightAt = (x: number, z: number) => terrainHeight(x, z, WATER);

const makeFox = () =>
  createFoxPlayer({ heightAt, water: WATER, bounds: WORLD, spawn: [0, 148] });

/** Runs `seconds` of simulation at 60 fps. */
const run = (
  fox: ReturnType<typeof makeFox>,
  seconds: number,
  input: { dirX: number; dirZ: number; sprint: boolean; jump: boolean },
) => {
  const steps = Math.round(seconds * 60);
  for (let index = 0; index < steps; index += 1) {
    fox.step(1 / 60, input, index / 60);
  }
};

describe('fox player', () => {
  it('spawns on the ground, not floating or sunk', () => {
    const fox = makeFox();
    expect(fox.group.position.y).toBeCloseTo(heightAt(0, 148), 3);
    expect(fox.state.airborne).toBe(false);
  });

  it('walks forward when asked, and stops when asked', () => {
    const fox = makeFox();
    const startZ = fox.state.z;
    run(fox, 1, { dirX: 0, dirZ: -1, sprint: false, jump: false });
    expect(fox.state.z).toBeLessThan(startZ); // spawn faces north (-Z)
    expect(fox.state.speed).toBeGreaterThan(1);

    run(fox, 1, { dirX: 0, dirZ: 0, sprint: false, jump: false });
    expect(fox.state.speed).toBeLessThan(0.5);
  });

  it('sprints faster than it walks', () => {
    const walker = makeFox();
    run(walker, 1.5, { dirX: 0, dirZ: -1, sprint: false, jump: false });
    const walkerDistance = Math.abs(walker.state.z - 148);

    const runner = makeFox();
    run(runner, 1.5, { dirX: 0, dirZ: -1, sprint: true, jump: false });
    const runnerDistance = Math.abs(runner.state.z - 148);

    expect(runnerDistance).toBeGreaterThan(walkerDistance * 1.4);
  });

  it('stays glued to the terrain while walking across the whole map', () => {
    const fox = makeFox();
    for (let index = 0; index < 60 * 40; index += 1) {
      fox.step(1 / 60, { dirX: 0, dirZ: -1, sprint: true, jump: false }, index / 60);
      const ground = heightAt(fox.state.x, fox.state.z);
      // Never sinks below the ground, never floats away from it.
      expect(fox.group.position.y).toBeGreaterThan(ground - 0.4);
      expect(fox.group.position.y).toBeLessThan(ground + 1.2);
    }
  });

  it('cannot walk out of the world', () => {
    const fox = makeFox();
    run(fox, 30, { dirX: 0, dirZ: -1, sprint: true, jump: false });
    expect(fox.state.x).toBeGreaterThanOrEqual(WORLD.minX);
    expect(fox.state.x).toBeLessThanOrEqual(WORLD.maxX);
    expect(fox.state.z).toBeGreaterThanOrEqual(WORLD.minZ);
    expect(fox.state.z).toBeLessThanOrEqual(WORLD.maxZ);
  });

  it('jumps, reaches a peak, and lands again', () => {
    const fox = makeFox();
    const ground = heightAt(fox.state.x, fox.state.z);
    fox.step(1 / 60, { dirX: 0, dirZ: 0, sprint: false, jump: true }, 0);
    expect(fox.state.airborne).toBe(true);

    let peak = fox.group.position.y;
    for (let index = 0; index < 120; index += 1) {
      fox.step(1 / 60, { dirX: 0, dirZ: 0, sprint: false, jump: false }, index / 60);
      peak = Math.max(peak, fox.group.position.y);
    }
    expect(peak).toBeGreaterThan(ground + 1.2);
    expect(fox.state.airborne).toBe(false);
    expect(fox.group.position.y).toBeCloseTo(heightAt(fox.state.x, fox.state.z), 0);
  });

  it('slows down when wading in the river', () => {
    const fox = makeFox();
    // Drop the fox in the middle of the river channel.
    const river = WATER.river[Math.floor(WATER.river.length / 2)]!;
    fox.teleport(river[0], river[1]);
    run(fox, 1.5, { dirX: 1, dirZ: 0, sprint: true, jump: false });
    const wetSpeed = fox.state.speed;

    const dry = makeFox();
    run(dry, 1.5, { dirX: 1, dirZ: 0, sprint: true, jump: false });
    expect(wetSpeed).toBeLessThan(dry.state.speed);
  });

  it('resets and teleports cleanly', () => {
    const fox = makeFox();
    run(fox, 2, { dirX: 0, dirZ: -1, sprint: true, jump: false });
    expect(fox.state.z).not.toBe(148);

    fox.reset();
    expect(fox.state.z).toBe(148);
    expect(fox.state.x).toBe(0);
    expect(fox.group.position.y).toBeCloseTo(heightAt(0, 148), 3);

    fox.teleport(-46, -124);
    expect(fox.state.x).toBe(-46);
    expect(fox.group.position.y).toBeCloseTo(heightAt(-46, -124), 3);
  });

  it('builds a fox with a head, tail, four legs and a shadow', () => {
    const fox = makeFox();
    const names: string[] = [];
    fox.group.traverse((node) => {
      if (node.name) names.push(node.name);
    });
    expect(names).toContain('fox-body');
    expect(names).toContain('fox-head');
    expect(names).toContain('fox-tail');
    let meshes = 0;
    fox.group.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) meshes += 1;
    });
    // Body, chest, scarf, head, snout, nose, 2 ears, 2 eyes, tail, tip,
    // 4 legs + 4 paws, shadow.
    expect(meshes).toBeGreaterThanOrEqual(20);
  });
});
