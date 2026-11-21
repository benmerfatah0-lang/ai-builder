import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import type { Terrain } from '../../core/world-plan/schema';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { extractFrames } from './frames';
import { WorldLayout, resolveLayout } from './layout';
import { solveSpec } from './solve';

function terrain(overrides: Partial<Terrain> = {}): Terrain {
  const base = createEmptyWorldPlan({ seed: 11 }).terrain;
  return { ...base, style: 'mountains', size: 160, resolution: 64, heightScale: 40, ...overrides };
}

function specFor(description: string): ReturnType<typeof solveSpec> {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed: 11 }));
}

describe('WorldLayout', () => {
  const layout = new WorldLayout(terrain(), 11, undefined);

  it('samples the real terrain and stays inside its bounds', () => {
    expect(Number.isFinite(layout.heightAt(0, 0))).toBe(true);
    const bounds = layout.bounds();
    expect(bounds.minX).toBeLessThan(bounds.maxX);
    for (const [x, z] of layout.scatter(bounds, 12)) {
      expect(x).toBeGreaterThanOrEqual(bounds.minX);
      expect(x).toBeLessThanOrEqual(bounds.maxX);
      expect(z).toBeGreaterThanOrEqual(bounds.minZ);
      expect(z).toBeLessThanOrEqual(bounds.maxZ);
    }
  });

  it('finds the highest and lowest ground', () => {
    const high = layout.highest(3);
    const low = layout.lowest(3);
    expect(high).toHaveLength(3);
    expect(Math.min(...high.map(([x, z]) => layout.heightAt(x, z)))).toBeGreaterThan(
      Math.max(...low.map(([x, z]) => layout.heightAt(x, z))),
    );
  });

  it('lays out rings, lines and chains', () => {
    const ring = layout.ring([0, 0], 20, 8);
    expect(ring).toHaveLength(8);
    expect(ring.every(([x, z]) => Math.hypot(x, z) > 10)).toBe(true);

    const line = layout.line([-40, 0], [40, 0], 7);
    expect(line).toHaveLength(7);
    expect(line[0]![0]).toBeLessThan(line[6]![0]);

    const { ordered, polyline } = layout.chain([[-30, -30], [0, 0], [30, 25]]);
    expect(ordered.length).toBeGreaterThanOrEqual(3);
    expect(polyline.length).toBeGreaterThanOrEqual(ordered.length);
    expect(polyline.length).toBeLessThanOrEqual(64);
  });

  it('offsets around an anchor in the requested direction', () => {
    const anchor: [number, number] = [0, 0];
    const right = layout.anchorOffset(anchor, 'right', 0);
    const left = layout.anchorOffset(anchor, 'left', 0);
    const near = layout.anchorOffset(anchor, 'near', 0);
    expect(right[0]).not.toBe(left[0]);
    expect(Math.hypot(near[0], near[1])).toBeGreaterThan(0);
    // Several objects on the same side do not collapse onto one point.
    const first = layout.anchorOffset(anchor, 'near', 0);
    const second = layout.anchorOffset(anchor, 'near', 1);
    expect(Math.hypot(first[0] - second[0], first[1] - second[1])).toBeGreaterThan(0.5);
  });

  it('gives every compass selector its own centre', () => {
    const centers = (['north', 'south', 'east', 'west', 'center'] as const).map((selector) => layout.regionCenter(selector));
    expect(new Set(centers.map(([x, z]) => `${x.toFixed(1)},${z.toFixed(1)}`)).size).toBe(centers.length);
  });

  it('is deterministic for the same terrain and seed', () => {
    // Two fresh layouts walk the same seeded sequence; a reused one has already
    // consumed randomness, which is exactly why callers build one per world.
    const first = new WorldLayout(terrain(), 11, undefined);
    const second = new WorldLayout(terrain(), 11, undefined);
    expect(first.highest(4)).toEqual(second.highest(4));
    expect(first.scatter(first.bounds(), 6)).toEqual(second.scatter(second.bounds(), 6));
    expect(new WorldLayout(terrain(), 12, undefined).highest(4)).not.toEqual(first.highest(4));
  });
});

describe('resolveLayout', () => {
  it('puts a castle on the summit and a village around the lake', () => {
    const spec = resolveLayout(specFor('قلعة فوق جبل وقرية تحيط ببحيرة'), terrain({ waterLevel: 2 }));
    const castle = spec.buildings.find((building) => building.kind === 'castle')!;
    const houses = spec.buildings.filter((building) => building.kind === 'house');
    expect(spec.positions[castle.id]?.length).toBeGreaterThan(0);
    expect(houses.length).toBeGreaterThan(0);
    const relation = spec.relations.find((entry) => entry.predicate === 'on-top-of');
    expect(relation?.status).toBe('resolved');
    expect(relation?.resolved?.length).toBeGreaterThan(0);
  });

  it('resolves a relation anchored on the terrain itself', () => {
    const spec = resolveLayout(specFor('ثلاث خيام عند كثبان مرتفعة'), terrain({ style: 'dunes' }));
    const relation = spec.relations.find((entry) => entry.predicate === 'near');
    expect(relation?.status).toBe('resolved');
    expect(relation?.resolved).toHaveLength(3);
  });

  it('chains a road through the positions it connected', () => {
    const spec = resolveLayout(specFor('بيوت تربطها طرق'), terrain());
    const road = spec.relations.find((relation) => relation.predicate === 'connected-by');
    expect(road?.status).toBe('resolved');
    expect((road?.polyline?.length ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('marks a relation it cannot resolve instead of guessing silently', () => {
    const spec = resolveLayout(specFor('قلعة فوق جبل'), terrain());
    spec.relations.push({
      id: 'r-ghost',
      predicate: 'near',
      subject: 'شيء',
      object: 'شيء آخر',
      subjectId: 'b-does-not-exist',
      objectId: 'a-does-not-exist',
      status: 'pending',
    });
    const resolved = resolveLayout(spec, terrain());
    const ghost = resolved.relations.find((relation) => relation.id === 'r-ghost');
    expect(ghost?.status).toBe('unsupported');
    expect(resolved.notices.join(' ')).toContain('شيء');
  });

  it('keeps every resolved position inside the terrain and dry when water is present', () => {
    const ground = terrain({ waterLevel: 3 });
    const layout = new WorldLayout(ground, 11, undefined);
    const spec = resolveLayout(specFor('قلعة فوق جبل وقرية تحيط ببحيرة وثلاث خيام عند النهر'), ground);
    const half = ground.size / 2;
    for (const positions of Object.values(spec.positions)) {
      for (const [x, z] of positions) {
        expect(Math.abs(x)).toBeLessThanOrEqual(half);
        expect(Math.abs(z)).toBeLessThanOrEqual(half);
        expect(Number.isFinite(layout.heightAt(x, z))).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    const description = 'قلعة فوق جبل وقرية تحيط ببحيرة';
    const ground = terrain();
    expect(resolveLayout(specFor(description), ground).positions).toEqual(resolveLayout(specFor(description), ground).positions);
  });
});
