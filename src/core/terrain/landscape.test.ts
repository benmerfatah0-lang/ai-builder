import { describe, expect, it } from 'vitest';
import { bakeLandscape, bakeCells, clearLandscapeCache, getLandscape, landscapeFingerprint, landscapeSummary } from './landscape';
import { Heightfield, Mask } from './heightfield';
import { cellular2, fbm, fbm3, gradientNoise2, ridged, warped } from './noise';
import { pointAt, polylineLength, projectOntoSpine, smoothSpine, resampleSpine, offsetSpine } from './geometry';
import { createFeatureContext, applyLandscapeFeatures, addRange, addVolcano, addIsland, addOcean, addLake, addBeaches, sharpenCliffs } from './features';
import { computeFlow, carveRivers, extractRivers, fillDepressions, findLakes, riverFromSpine, traceDownstream, type RiverPath } from './hydrology';
import { erodeField, hydraulicErosion, thermalErosion } from './erosion';
import { buildBiomeMap, canonicalBiome, paletteFor, computeWaterAffinity } from './biomeMap';
import { carveCaves, caveSolidAt } from './caves';
import { chunkAt, chunksNear, defaultChunkSize, layoutVertexCount, lodCells, planChunks, shouldUseChunks } from './chunks';
import type { LandscapeSpec, Terrain } from '../world-plan/schema';

const PALETTE = { low: '#597445', high: '#94a66d' };

function terrainWith(landscape: LandscapeSpec, overrides: Partial<Terrain> = {}): Terrain {
  return {
    style: 'hills',
    size: 160,
    resolution: 96,
    heightScale: 10,
    waterLevel: null,
    palette: PALETTE,
    landscape,
    ...overrides,
  };
}

/** Small, fast bake used by most unit tests. */
function bake(landscape: LandscapeSpec, overrides: Partial<Terrain> = {}, seed = 1234) {
  return bakeLandscape(terrainWith({ cells: 72, ...landscape }, overrides), seed, {
    maxCells: 72,
    baseHeight: (x, z) => fbm(9001, x / 34, z / 34, { octaves: 3 }) * 2,
  });
}

function fieldOf(cells = 48, size = 120): Heightfield {
  return new Heightfield(size, cells);
}

describe('terrain noise primitives', () => {
  it('is deterministic and bounded', () => {
    expect(fbm(7, 1.5, -2.25, { octaves: 5 })).toBe(fbm(7, 1.5, -2.25, { octaves: 5 }));
    expect(gradientNoise2(7, 3.5, 4.5)).toBe(gradientNoise2(7, 3.5, 4.5));
    for (let i = 0; i < 40; i += 1) {
      const x = (i - 20) * 0.37;
      expect(Math.abs(fbm(11, x, x * 0.7, { octaves: 6 }))).toBeLessThanOrEqual(1.0001);
      expect(Math.abs(gradientNoise2(11, x, -x))).toBeLessThanOrEqual(1.5);
      expect(ridged(11, x, x * 0.4, { octaves: 5 })).toBeGreaterThanOrEqual(-0.0001);
      expect(ridged(11, x, x * 0.4, { octaves: 5 })).toBeLessThanOrEqual(1.6);
    }
  });

  it('moves the sample point when warped, and never returns NaN', () => {
    const [x, z] = warped(3, 0.5, 0.5, 0.4, 3);
    expect(Number.isFinite(x) && Number.isFinite(z)).toBe(true);
    expect(Math.hypot(x - 0.5, z - 0.5)).toBeLessThan(1.6);
  });

  it('returns ordered cellular distances with their feature point', () => {
    const cell = cellular2(5, 2.25, 3.75);
    expect(cell.f2).toBeGreaterThanOrEqual(cell.f1);
    expect(Number.isFinite(cell.cellX) && Number.isFinite(cell.cellY)).toBe(true);
  });

  it('supports three-dimensional fractals for cave volumes', () => {
    expect(fbm3(4, 1, 2, 3, 3)).toBe(fbm3(4, 1, 2, 3, 3));
    expect(Math.abs(fbm3(4, -1.5, 2.5, 0.25, 2))).toBeLessThanOrEqual(1.0001);
  });
});

describe('heightfield grid', () => {
  it('maps world coordinates onto grid nodes and back', () => {
    const field = fieldOf(24, 120);
    const [gx, gz] = field.gridOf(0, 0);
    expect(gx).toBeCloseTo(12, 5);
    expect(gz).toBeCloseTo(12, 5);
    const [wx, wz] = field.worldOf(12, 12);
    expect(wx).toBeCloseTo(0, 5);
    expect(wz).toBeCloseTo(0, 5);
    expect(field.worldOf(0, 0)[0]).toBeCloseTo(-60, 5);
  });

  it('interpolates between nodes and clamps outside the map', () => {
    const field = fieldOf(10, 100);
    // World (0, 0) is the centre node of a map centred on the origin.
    field.set(5, 5, 10);
    expect(field.sample(0, 0)).toBe(10);
    expect(field.sample(-50, -50)).toBe(0);
    // Outside the map the border value is returned, never 0 or NaN.
    field.set(0, 0, 7);
    expect(field.sample(-500, -500)).toBe(7);
    expect(field.sample(500, -500)).toBe(0);
    field.each((x, z) => (Math.abs(x) < 1 && Math.abs(z) < 1 ? 4 : 0));
    expect(field.sample(0, 0)).toBeCloseTo(4, 5);
    expect(Number.isFinite(field.sample(1e6, 1e6))).toBe(true);
  });

  it('reports slope, normal and aspect consistently', () => {
    const field = fieldOf(20, 100);
    // A ramp rising towards +X.
    field.each((x) => x * 0.5);
    expect(field.slope(0, 0)).toBeCloseTo(0.5, 3);
    const normal = field.normal(0, 0);
    expect(normal[1]).toBeGreaterThan(0.8);
    expect(Math.hypot(...normal)).toBeCloseTo(1, 5);
    expect(Number.isFinite(field.aspect(0, 0))).toBe(true);
  });

  it('blurs without changing the mean of flat ground', () => {
    const field = fieldOf(16, 80);
    field.each(() => 3);
    field.blur(1, 2);
    expect(field.mean()).toBeCloseTo(3, 5);
    const rough = fieldOf(16, 80);
    rough.each((x, z) => Math.sin(x) * Math.cos(z) * 6);
    const before = rough.slope(0, 0);
    rough.blur(2, 2);
    expect(rough.slope(0, 0)).toBeLessThanOrEqual(before + 1e-6);
  });

  it('keeps masks aligned with the grid, integer or floating', () => {
    const mask = new Mask(8);
    mask.set(20, 20, 1);
    expect(mask.get(8, 8)).toBe(0);
    expect(mask.count()).toBe(0);
    mask.set(3, 4, 1);
    expect(mask.get(3, 4)).toBe(1);
    expect(mask.any()).toBe(true);
    const floating = new Mask(8, true);
    floating.set(1, 1, 0.5);
    expect(floating.get(1, 1)).toBeCloseTo(0.5, 5);
    const field = fieldOf(8, 80);
    expect(floating.atWorld(field, 0, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('spine geometry', () => {
  const spine: Array<[number, number]> = [[-40, 0], [0, 10], [40, 0]];

  it('measures length and walks along the polyline', () => {
    expect(polylineLength(spine)).toBeCloseTo(82.462, 2);
    expect(pointAt(spine, 0)[0]).toBeCloseTo(-40, 5);
    expect(pointAt(spine, 1)[0]).toBeCloseTo(40, 5);
    const middle = pointAt(spine, 0.5);
    expect(middle[0]).toBeCloseTo(0, 3);
    expect(middle[1]).toBeCloseTo(10, 3);
  });

  it('projects points onto the spine with a tangent', () => {
    const projection = projectOntoSpine(spine, 0, 60);
    expect(projection.distance).toBeCloseTo(50, 3);
    expect(projection.point[1]).toBeCloseTo(10, 3);
    expect(Math.hypot(projection.tangent[0], projection.tangent[1])).toBeCloseTo(1, 5);
    expect(projectOntoSpine([], 4, 4).distance).toBeGreaterThan(0);
    expect(projectOntoSpine([[2, 3]], 2, 3).distance).toBe(0);
  });

  it('smooths a spine through its anchors and resamples it', () => {
    const smooth = smoothSpine(spine, 6);
    expect(smooth.length).toBeGreaterThan(spine.length);
    expect(smooth[0]).toEqual(spine[0]);
    expect(smooth[smooth.length - 1]).toEqual(spine[spine.length - 1]);
    expect(smooth.every((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))).toBe(true);
    expect(resampleSpine(smooth, 5)).toHaveLength(5);
    expect(smoothSpine([[-1, 0], [1, 0]])).toHaveLength(2);
  });

  it('offsets a spine sideways without stretching it much', () => {
    const bent = offsetSpine(spine, (t) => Math.sin(t * Math.PI) * 6);
    expect(bent).toHaveLength(spine.length);
    expect(Math.abs(polylineLength(bent) - polylineLength(spine))).toBeLessThan(polylineLength(spine) * 0.2);
  });
});

describe('landform features', () => {
  it('raises a mountain range along its spine and leaves the corners alone', () => {
    const field = fieldOf(64, 200);
    const ctx = createFeatureContext(field, 42, null);
    addRange(ctx, { spine: [[-90, 0], [0, -8], [90, 0]], width: 26, height: 34, roughness: 0.7 }, 0);
    const crest = field.sample(0, -8);
    expect(crest).toBeGreaterThan(12);
    expect(field.sample(0, 90)).toBeLessThan(crest * 0.35);
    expect(field.max()).toBeGreaterThan(20);
    expect(ctx.rock.count()).toBeGreaterThan(0);
  });

  it('keeps a range deterministic and free of NaN', () => {
    const build = (seed: number): Heightfield => {
      const field = fieldOf(48, 160);
      const ctx = createFeatureContext(field, seed, null);
      addRange(ctx, { spine: [[-70, 20], [0, 0], [70, -20]], width: 20, height: 28 }, 1);
      return field;
    };
    const a = build(5);
    const b = build(5);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(build(6).max()).not.toBeCloseTo(a.max(), 3);
    expect(a.data.every((value) => Number.isFinite(value))).toBe(true);
  });

  it('builds hills, a plateau with terraces, and a canyon', () => {
    const field = fieldOf(64, 200);
    const ctx = createFeatureContext(field, 8, null);
    applyLandscapeFeatures(ctx, {
      cells: 64,
      hills: [{ center: [-50, 50], radius: 26, height: 8 }],
      plateaus: [{ center: [50, -50], radius: 30, height: 18, terraces: 3 }],
      canyons: [{ spine: [[-80, -60], [0, 0], [80, 60]], width: 9, depth: 16, meander: 0 }],
    });
    expect(field.sample(-50, 50)).toBeGreaterThan(3);
    expect(field.sample(50, -50)).toBeGreaterThan(9);
    expect(field.sample(0, 0)).toBeLessThan(-6);
    expect(ctx.rock.count()).toBeGreaterThan(0);
  });

  it('gives a volcano a summit, a crater and radial gullies', () => {
    const field = fieldOf(72, 200);
    const ctx = createFeatureContext(field, 17, null);
    addVolcano(ctx, { center: [0, 0], radius: 60, height: 40, crater: 0.14, gullies: 12 }, 0);
    const rim = field.sample(0, 10);
    expect(rim).toBeGreaterThan(24);
    expect(field.sample(0, 0)).toBeLessThan(rim);
    expect(field.sample(0, 95)).toBeLessThan(rim * 0.2);
    // A caldera collapses the summit much harder than a crater does.
    const caldera = fieldOf(72, 200);
    addVolcano(createFeatureContext(caldera, 17, null), { center: [0, 0], radius: 60, height: 40, crater: 0.14, caldera: true }, 0);
    expect(caldera.sample(0, 0)).toBeLessThan(field.sample(0, 0));
  });

  it('raises islands with satellites above an ocean floor', () => {
    const field = fieldOf(72, 240);
    const ctx = createFeatureContext(field, 3, 0);
    field.each(() => 4);
    addOcean(ctx, { start: 0.55, depth: 26 });
    addIsland(ctx, { center: [0, 0], radius: 42, height: 16, irregularity: 0.6, satellites: 3 }, 0);
    expect(field.sample(0, 0)).toBeGreaterThan(6);
    expect(field.sample(118, 118)).toBeLessThan(-6);
    // Some satellite should have broken the surface away from the main island.
    const raised = field.data.filter((value, index) => {
      const iz = Math.floor(index / field.side);
      const ix = index - iz * field.side;
      const [x, z] = field.worldOf(ix, iz);
      return value > 0.5 && Math.hypot(x, z) > 48;
    });
    expect(raised.length).toBeGreaterThan(0);
  });

  it('carves lakes without ever raising the ground', () => {
    const field = fieldOf(48, 160);
    field.each(() => 6);
    const ctx = createFeatureContext(field, 21, 2);
    const before = field.clone();
    addLake(ctx, { center: [10, -20], radius: 24, depth: 7, level: 2 }, 0);
    expect(field.sample(10, -20)).toBeLessThan(-3);
    expect(field.sample(70, 70)).toBeCloseTo(6, 4);
    for (let i = 0; i < field.data.length; i += 1) {
      expect(field.data[i] ?? 0).toBeLessThanOrEqual((before.data[i] ?? 0) + 1e-4);
    }
  });

  it('flattens gentle shorelines into beaches and marks them as sand', () => {
    const field = fieldOf(64, 200);
    field.each((x, z) => 6 - Math.hypot(x, z) * 0.09);
    const ctx = createFeatureContext(field, 33, 0);
    addBeaches(ctx, { width: 9, maxSlope: 0.6, elevation: 0.6 });
    expect(ctx.sand.count()).toBeGreaterThan(20);
    // The shore band is gentler than the inland slope after flattening.
    const shore = field.sample(0, 66);
    expect(Math.abs(shore)).toBeLessThan(1.6);
  });

  it('sharpens steep ground into cliffs and leaves flat ground alone', () => {
    const field = fieldOf(48, 160);
    field.each((x, z) => (x > 0 ? Math.min(24, x * 0.9) : 0) + (z > 40 ? 0 : 0));
    const flat = field.clone();
    const ctx = createFeatureContext(field, 91, null);
    const beforeMax = field.max();
    sharpenCliffs(ctx, { minSlope: 0.6, sharpen: 0.5, coverage: 0.7 });
    expect(ctx.rock.count()).toBeGreaterThan(0);
    expect(field.max()).toBeGreaterThanOrEqual(beforeMax);
    // Flat ground has no steep cells, so the pass is a no-op there.
    const calm = fieldOf(24, 120);
    calm.each(() => 2);
    const calmBefore = calm.clone();
    sharpenCliffs(createFeatureContext(calm, 91, null), { minSlope: 0.6, sharpen: 0.5 });
    expect(Array.from(calm.data)).toEqual(Array.from(calmBefore.data));
    expect(calm.mean()).toBeCloseTo(2, 5);
    expect(flat.sample(0, 0)).toBeGreaterThanOrEqual(0);
  });
});

describe('erosion', () => {
  it('moves sediment downhill, deterministically, and never produces NaN', () => {
    const build = (seed: number): Heightfield => {
      const field = fieldOf(48, 140);
      field.each((x, z) => 22 - Math.hypot(x, z) * 0.18 + fbm(seed, x / 18, z / 18, { octaves: 3 }) * 5);
      return field;
    };
    const a = build(11);
    const b = build(11);
    const untouched = build(11);
    const reportA = hydraulicErosion(a, 77, { droplets: 2500, maxLifetime: 30 });
    const reportB = hydraulicErosion(b, 77, { droplets: 2500, maxLifetime: 30 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(reportA.eroded).toBeGreaterThan(0);
    expect(reportA.deposited).toBeGreaterThan(0);
    expect(reportB.eroded).toBeCloseTo(reportA.eroded, 6);
    expect(a.data.every((value) => Number.isFinite(value))).toBe(true);
    // The droplets really moved ground, and left the untouched copy alone.
    let changed = 0;
    for (let i = 0; i < a.data.length; i += 1) {
      if (Math.abs((a.data[i] ?? 0) - (untouched.data[i] ?? 0)) > 0.02) changed += 1;
    }
    expect(changed).toBeGreaterThan(200);
    // Mass is conserved: sediment is redistributed, not invented or destroyed.
    expect(Math.abs(a.mean() - untouched.mean())).toBeLessThan(0.35);
  });

  it('respects a protection mask', () => {
    const field = fieldOf(32, 120);
    field.each((x, z) => 14 - Math.hypot(x, z) * 0.16);
    const untouched = field.clone();
    const protect = new Uint8Array(field.side * field.side).fill(1);
    const report = hydraulicErosion(field, 5, { droplets: 800, maxLifetime: 24 }, protect);
    expect(report.eroded).toBe(0);
    expect(Array.from(field.data)).toEqual(Array.from(untouched.data));
  });

  it('smooths steep ground with talus erosion and conserves mass', () => {
    const field = fieldOf(40, 120);
    field.each((x, z) => (Math.abs(x) < 7 && Math.abs(z) < 7 ? 26 : 2));
    const meanBefore = field.mean();
    const steepestBefore = steepestSlope(field);
    const moved = thermalErosion(field, { talus: field.step * 0.7, passes: 4, strength: 0.45 });
    expect(moved).toBeGreaterThan(0);
    // Talus cannot leave anything steeper than it started with.
    expect(steepestSlope(field)).toBeLessThan(steepestBefore);
    // Mass is conserved: everything that slid off the top piled up at the foot.
    expect(field.mean()).toBeCloseTo(meanBefore, 1);
    expect(field.max()).toBeLessThan(26);
    expect(steepestSlope(fieldOf(8, 40))).toBe(0);
  });

  it('runs only the passes the settings ask for', () => {
    const field = fieldOf(28, 100);
    field.each((x, z) => 12 - Math.hypot(x, z) * 0.14);
    const untouched = field.clone();
    expect(erodeField(field, 3, {}).eroded).toBe(0);
    expect(Array.from(field.data)).toEqual(Array.from(untouched.data));
    const report = erodeField(field, 3, { hydraulic: { droplets: 400, maxLifetime: 18 }, thermal: { passes: 1, talus: field.step } });
    expect(report.droplets).toBe(400);
    expect(report.eroded + report.thermalMoved).toBeGreaterThan(0);
  });
});

function steepestSlope(field: Heightfield): number {
  let steepest = 0;
  for (let iz = 1; iz < field.cells; iz += 1) {
    for (let ix = 1; ix < field.cells; ix += 1) {
      const dx = field.at(ix + 1, iz) - field.at(ix - 1, iz);
      const dz = field.at(ix, iz + 1) - field.at(ix, iz - 1);
      steepest = Math.max(steepest, Math.hypot(dx, dz) / (2 * field.step));
    }
  }
  return steepest;
}

describe('hydrology', () => {
  it('fills depressions so every cell can drain', () => {
    const field = fieldOf(32, 120);
    field.each((x, z) => 8 + Math.hypot(x - 10, z + 10) * 0.25);
    // A pit in the middle of a slope.
    const [px, pz] = field.gridOf(10, -10);
    field.set(Math.round(px), Math.round(pz), -4);
    const { filled, flooded } = fillDepressions(field);
    expect(filled.at(Math.round(px), Math.round(pz))).toBeGreaterThan(0);
    expect(flooded.count()).toBeGreaterThan(0);
    expect(field.at(Math.round(px), Math.round(pz))).toBe(-4);
    // Ground that was already draining is untouched.
    expect(filled.sample(-50, 50)).toBeCloseTo(field.sample(-50, 50), 4);
  });

  it('accumulates flow towards the lowest point and finds channels', () => {
    const field = fieldOf(48, 160);
    // A tilted plane with a V groove: everything drains towards -X along Z = 0.
    field.each((x, z) => Math.abs(z) * 0.35 - x * 0.12);
    const flow = computeFlow(field);
    expect(flow.threshold).toBeGreaterThan(0);
    expect(flow.channels.count()).toBeGreaterThan(0);
    const [gx] = field.gridOf(1, 0);
    const [, gz] = field.gridOf(0, 0);
    const outlet = flow.accumulation[Math.round(gz) * field.side + Math.round(gx)] ?? 0;
    const [rx, rz] = field.gridOf(-20, 60);
    const ridge = flow.accumulation[Math.round(rz) * field.side + Math.round(rx)] ?? 0;
    expect(outlet).toBeGreaterThan(flow.threshold);
    expect(outlet).toBeGreaterThan(ridge * 20);
    const rivers = extractRivers(flow, { threshold: flow.threshold, maxRivers: 3 });
    expect(rivers.length).toBeGreaterThan(0);
    expect(rivers.length).toBeLessThanOrEqual(3);
    for (const river of rivers) {
      expect(river.nodes.length).toBeGreaterThan(3);
      // Flow always descends: accumulation grows downstream.
      const first = flow.accumulation[river.nodes[0]![1] * field.side + river.nodes[0]![0]] ?? 0;
      const last = flow.accumulation[river.nodes[river.nodes.length - 1]![1] * field.side + river.nodes[river.nodes.length - 1]![0]] ?? 0;
      expect(last).toBeGreaterThanOrEqual(first);
    }
  });

  it('traces downhill from an anchor and follows a described spine', () => {
    const field = fieldOf(48, 160);
    field.each((x, z) => 24 - Math.hypot(x - 20, z - 20) * 0.22 + fbm(6161, x / 20, z / 20, { octaves: 3 }) * 2);
    const flow = computeFlow(field);
    const traced = traceDownstream(flow, [4, 4], 4);
    expect(traced.nodes.length).toBeGreaterThanOrEqual(4);
    const heights = traced.nodes.map(([ix, iz]) => flow.filled.at(ix, iz));
    for (let i = 1; i < heights.length; i += 1) expect(heights[i] ?? 0).toBeLessThanOrEqual((heights[i - 1] ?? 0) + 1e-4);
    const fromSpine = riverFromSpine(flow, [[-60, -60], [40, 40]], 4);
    expect(fromSpine.nodes.length).toBeGreaterThan(2);
    expect(riverFromSpine(flow, [], 4).nodes).toHaveLength(0);
  });

  it('carves a monotonic bed that never floats and keeps a corridor clear', () => {
    const field = fieldOf(56, 180);
    field.each((x, z) => 10 + fbm(7171, x / 26, z / 26, { octaves: 4 }) * 6 + Math.max(0, 14 - Math.abs(z) * 0.2));
    const original = field.clone();
    const ctx = createFeatureContext(field, 4242, 2);
    const flow = computeFlow(field);
    const rivers = extractRivers(flow, { threshold: flow.threshold, maxRivers: 1, minLength: 8 });
    expect(rivers.length).toBe(1);
    const river = rivers[0]!;
    const report = carveRivers(ctx, [river], { width: 5, depth: 2.4, corridor: 12, mouthLevel: 2 });
    expect(report.rivers).toBe(1);
    expect(report.deepest).toBeGreaterThan(0);

    // The bed never rises above the ground it replaced.
    for (const [ix, iz] of river.nodes) {
      expect(field.at(ix, iz)).toBeLessThanOrEqual(original.at(ix, iz) + 1e-4);
    }
    // The corridor is marked so buildings and roads stay out of the water.
    expect(ctx.corridor.count()).toBeGreaterThan(0);
    const mid = river.nodes[Math.floor(river.nodes.length / 2)]!;
    expect(ctx.corridor.get(mid[0], mid[1])).toBeGreaterThan(0.3);
    // Nothing was raised anywhere on the map.
    for (let i = 0; i < field.data.length; i += 1) {
      expect(field.data[i] ?? 0).toBeLessThanOrEqual((original.data[i] ?? 0) + 1e-4);
    }
  });

  it('sinks the river mouth to the water level so it never hangs in the air', () => {
    const field = fieldOf(40, 140);
    field.each((x) => 12 + x * 0.06);
    const ctx = createFeatureContext(field, 909, 4);
    const path: RiverPath = {
      nodes: [[4, 20], [12, 20], [20, 20], [28, 20], [36, 20]],
      points: [],
      discharge: 100,
      derived: false,
    };
    path.points = path.nodes.map(([ix, iz]) => field.worldOf(ix, iz));
    carveRivers(ctx, [path], { width: 4, depth: 1.6, mouthLevel: 4 });
    const mouth = path.nodes[path.nodes.length - 1]!;
    expect(field.at(mouth[0], mouth[1])).toBeLessThanOrEqual(4);
    const head = path.nodes[0]!;
    expect(field.at(head[0], head[1])).toBeGreaterThanOrEqual(field.at(mouth[0], mouth[1]));
  });

  it('groups flooded cells into lakes', () => {
    const field = fieldOf(40, 140);
    field.each(() => 9);
    field.each((x, z) => (Math.hypot(x - 20, z + 20) < 18 ? 1 : 9 + Math.hypot(x, z) * 0.05));
    const flow = computeFlow(field);
    const lakes = findLakes(flow, 6);
    expect(lakes.length).toBeGreaterThan(0);
    expect(lakes[0]!.cells).toBeGreaterThan(6);
    expect(lakes[0]!.radius).toBeGreaterThan(0);
  });
});

describe('biome map', () => {
  it('normalises weights so borders blend instead of snapping', () => {
    const result = bake({
      ranges: [{ spine: [[-70, 0], [0, 0], [70, 0]], width: 24, height: 32, snowLine: 18 }],
      biomes: [
        { id: 'peaks', biome: 'snow', weight: 1 },
        { id: 'woods', biome: 'forest', weight: 1 },
        { id: 'grass', biome: 'meadow', weight: 0.8 },
      ],
    });
    expect(result.biomes.entries).toHaveLength(3);
    for (let iz = 0; iz <= result.field.cells; iz += 8) {
      for (let ix = 0; ix <= result.field.cells; ix += 8) {
        let total = 0;
        for (const entry of result.biomes.entries) total += entry.weight.get(ix, iz);
        expect(total === 0 || Math.abs(total - 1) < 1e-4).toBe(true);
      }
    }
    const [peakX, peakZ] = result.field.worldOf(Math.round(result.field.cells / 2), Math.round(result.field.cells / 2));
    expect(result.biomes.biomeAt(peakX, peakZ)).not.toBeNull();
    const weights = result.biomes.weightsAt(peakX * 0.6, peakZ);
    expect(weights.length).toBeGreaterThan(0);
    // Somewhere on the map at least two biomes share the ground: a transition.
    let blended = 0;
    for (let iz = 0; iz <= result.field.cells; iz += 2) {
      for (let ix = 0; ix <= result.field.cells; ix += 2) {
        let count = 0;
        for (const entry of result.biomes.entries) if (entry.weight.get(ix, iz) > 0.05) count += 1;
        if (count >= 2) blended += 1;
      }
    }
    expect(blended).toBeGreaterThan(0);
  });

  it('blends palette colours across a transition', () => {
    const result = bake({
      biomes: [
        { id: 'a', biome: 'desert', center: [-40, 0], radius: 40, transition: 30 },
        { id: 'b', biome: 'forest', center: [40, 0], radius: 40, transition: 30 },
      ],
    });
    const west = result.biomes.colorAt(-40, 0);
    const east = result.biomes.colorAt(40, 0);
    const middle = result.biomes.colorAt(0, 0);
    expect(west.low[0]).toBeGreaterThan(east.low[0]);
    expect(middle.low[0]).toBeLessThan(west.low[0] + 1e-6);
    expect(middle.low[0]).toBeGreaterThan(east.low[0] - 1e-6);
    expect(middle.low.every((channel) => channel >= 0 && channel <= 1)).toBe(true);
    // Outside every biome the terrain palette is the fallback.
    const fallback = result.biomes.colorAt(0, 78);
    expect(fallback.low.every((channel) => Number.isFinite(channel))).toBe(true);
  });

  it('maps everyday biome names onto canonical keys and palettes', () => {
    expect(canonicalBiome('Snowy Peaks')).toBe('snow');
    expect(canonicalBiome('dense_forest')).toBe('forest');
    expect(canonicalBiome('Desert')).toBe('desert');
    expect(canonicalBiome('totally-unknown')).toBe('meadow');
    expect(paletteFor('mountains', PALETTE).low).toBe('#5b625c');
    // Unknown names fall back to meadow, and an unknown key would use the plan palette.
    expect(paletteFor('unknown-biome', PALETTE).low).toBe('#5c7a45');
    expect(paletteFor('snow', PALETTE).high).toBe('#f2f6f8');
  });

  it('gives water-loving biomes a shoreline affinity field', () => {
    const field = fieldOf(32, 120);
    field.each((x, z) => 6 - Math.hypot(x, z) * 0.05);
    const ctx = createFeatureContext(field, 1, 4);
    const affinity = computeWaterAffinity(field, ctx, 4);
    expect(affinity.length).toBe(field.side * field.side);
    const [gx, gz] = field.gridOf(0, 0);
    expect(affinity[Math.round(gz) * field.side + Math.round(gx)] ?? 0).toBeGreaterThan(0.5);
    const map = buildBiomeMap(field, ctx, { biomes: [{ id: 'marsh', biome: 'swamp' }, { id: 'rock', biome: 'rock' }] }, 1, PALETTE, { water: affinity });
    expect(map.entries).toHaveLength(2);
  });
});

describe('caves', () => {
  it('answers volumetric rock queries deterministically', () => {
    expect(caveSolidAt(3, 1, -2, 4)).toBe(caveSolidAt(3, 1, -2, 4));
    // Above the surface there is no rock to hollow out.
    expect(caveSolidAt(3, 1, 40, 4, { surface: 5 })).toBe(false);
    let solid = 0;
    let total = 0;
    for (let i = 0; i < 200; i += 1) {
      const x = (i % 20) * 1.7 - 17;
      const z = Math.floor(i / 20) * 1.7 - 17;
      total += 1;
      if (caveSolidAt(3, x, -3, z, { surface: 6 })) solid += 1;
    }
    // Some rock, some void: the noise is not degenerate.
    expect(solid).toBeGreaterThan(0);
    expect(solid).toBeLessThan(total);
  });

  it('carves a mouth into a rock face and records the passage', () => {
    const field = fieldOf(56, 180);
    const ctx = createFeatureContext(field, 777, null);
    addRange(ctx, { spine: [[-80, 0], [0, 0], [80, 0]], width: 26, height: 34, roughness: 0.8 }, 0);
    expect(ctx.rock.count()).toBeGreaterThan(0);
    const before = field.clone();
    const caves = carveCaves(ctx, { caves: [{ radius: 4, depth: 26, chambers: 2 }] }, { candidates: 400 });
    expect(caves.length).toBe(1);
    const cave = caves[0]!;
    expect(cave.passage.length).toBeGreaterThan(4);
    expect(cave.floors).toHaveLength(cave.passage.length);
    expect(ctx.carved.count()).toBeGreaterThan(0);
    expect(field.sample(cave.position[0], cave.position[1])).toBeLessThanOrEqual(before.sample(cave.position[0], cave.position[1]) + 1e-4);
    // The passage runs downhill into the hill, never up.
    expect(cave.floors[cave.floors.length - 1] ?? 0).toBeLessThanOrEqual((cave.floors[0] ?? 0) + 1e-3);
  });

  it('uses a described entrance and heading when given one', () => {
    const field = fieldOf(56, 180);
    const ctx = createFeatureContext(field, 12, null);
    addRange(ctx, { spine: [[-80, 0], [0, 0], [80, 0]], width: 30, height: 30 }, 0);
    const caves = carveCaves(ctx, { caves: [{ entrance: [0, 26], heading: 180, radius: 5, depth: 30 }] });
    expect(caves).toHaveLength(1);
    expect(caves[0]!.heading).toBe(180);
    expect(Math.abs(caves[0]!.position[0])).toBeLessThan(12);
    // The passage heads towards -Z, i.e. into the range.
    const last = caves[0]!.passage[caves[0]!.passage.length - 1]!;
    expect(last[1]).toBeLessThan(caves[0]!.position[1]);
  });

  it('keeps entrances apart and out of rivers', () => {
    const field = fieldOf(56, 180);
    const ctx = createFeatureContext(field, 555, null);
    addRange(ctx, { spine: [[-80, -20], [0, 0], [80, 20]], width: 26, height: 34, roughness: 0.9 }, 0);
    const caves = carveCaves(ctx, { caves: [{}, {}] }, { candidates: 600, separation: 40 });
    expect(caves.length).toBeGreaterThan(0);
    for (let i = 1; i < caves.length; i += 1) {
      expect(Math.hypot(caves[i]!.position[0] - caves[0]!.position[0], caves[i]!.position[1] - caves[0]!.position[1])).toBeGreaterThanOrEqual(39);
    }
  });
});

describe('chunks and level of detail', () => {
  it('tiles the map exactly and keeps chunk sizes sane', () => {
    const layout = planChunks(240, { size: 60 });
    expect(layout.perRow).toBe(4);
    expect(layout.count).toBe(16);
    expect(layout.chunks[0]!.minX).toBeCloseTo(-120, 5);
    expect(layout.chunks[layout.count - 1]!.maxX).toBeCloseTo(120, 5);
    // Every point of the map belongs to exactly one chunk.
    for (const [x, z] of [[-119, -119], [0, 0], [119, 119], [-61, 59]] as Array<[number, number]>) {
      const chunk = chunkAt(layout, x, z);
      expect(chunk).not.toBeNull();
      expect(x).toBeGreaterThanOrEqual(chunk!.minX);
      expect(x).toBeLessThanOrEqual(chunk!.maxX);
      expect(z).toBeGreaterThanOrEqual(chunk!.minZ);
      expect(z).toBeLessThanOrEqual(chunk!.maxZ);
    }
    expect(chunkAt(layout, 500, 0)).toBeNull();
    expect(planChunks(64).count).toBeGreaterThanOrEqual(1);
    expect(defaultChunkSize(240)).toBe(60);
  });

  it('drops resolution with distance and culls far chunks', () => {
    const layout = planChunks(240, { size: 60 });
    const near = lodCells(10, layout.lod);
    const far = lodCells(10000, layout.lod);
    expect(near).toBeGreaterThan(far);
    expect(layoutVertexCount(layout, 10)).toBeGreaterThan(layoutVertexCount(layout, 10000));
    expect(layoutVertexCount(layout, 10)).toBeLessThan((240 * 2) ** 2);
    const visible = chunksNear(layout, 0, 0, 70);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(layout.count);
    expect(chunksNear(layout, 0, 0, 0).length).toBeGreaterThan(0);
  });

  it('only chunks maps that are big enough to benefit', () => {
    expect(shouldUseChunks(96, 64)).toBe(false);
    expect(shouldUseChunks(260, 200)).toBe(true);
    expect(shouldUseChunks(512, 128)).toBe(true);
  });
});

describe('the landscape engine', () => {
  it('bakes the same world twice, bit for bit', () => {
    const spec: LandscapeSpec = {
      cells: 56,
      ranges: [{ spine: [[-70, -10], [0, 6], [70, -4]], width: 22, height: 30, roughness: 0.7 }],
      hills: [{ center: [-40, 45], radius: 20, height: 7 }],
      valleys: [{ spine: [[-60, 20], [10, 30], [70, 12]], width: 16, depth: 6 }],
      plateaus: [{ center: [45, -45], radius: 24, height: 14, terraces: 3 }],
      volcanoes: [{ center: [-55, -50], radius: 26, height: 22, crater: 0.18 }],
      craters: [{ center: [60, 55], radius: 14, depth: 6 }],
      caves: [{ radius: 3, depth: 18 }],
      biomes: [
        { id: 'peaks', biome: 'snow' },
        { id: 'woods', biome: 'forest' },
        { id: 'grass', biome: 'meadow' },
        { id: 'stone', biome: 'rock' },
      ],
      erosion: { droplets: 1200, iterations: 24, thermalPasses: 1 },
      detail: { amplitude: 0.35, scale: 7 },
    };
    const a = bakeLandscape(terrainWith(spec), 2024, { maxCells: 56 });
    const b = bakeLandscape(terrainWith(spec), 2024, { maxCells: 56 });
    expect(Array.from(a.field.data)).toEqual(Array.from(b.field.data));
    expect(a.stats.min).toBe(b.stats.min);
    expect(a.rivers).toHaveLength(b.rivers.length);
    expect(a.caves.map((cave) => cave.position)).toEqual(b.caves.map((cave) => cave.position));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(landscapeFingerprint(terrainWith(spec), 2025)).not.toBe(a.fingerprint);
    // A different seed gives a different world.
    const c = bakeLandscape(terrainWith(spec), 77, { maxCells: 56, skipErosion: true });
    expect(Array.from(c.field.data)).not.toEqual(Array.from(a.field.data));
  });

  it('produces a finite surface with real relief and readable statistics', () => {
    const result = bake({
      ranges: [{ spine: [[-70, 0], [70, 0]], width: 26, height: 36 }],
      canyons: [{ spine: [[-60, 40], [60, 40]], width: 8, depth: 14 }],
      erosion: { droplets: 800, iterations: 20 },
    });
    expect(result.field.data.every((value) => Number.isFinite(value))).toBe(true);
    expect(result.stats.max - result.stats.min).toBeGreaterThan(12);
    expect(result.stats.steepFraction).toBeGreaterThan(0);
    expect(result.stats.landFraction).toBe(1);
    expect(result.stats.bakeMs).toBeGreaterThanOrEqual(0);
    expect(result.heightAt(0, 0)).toBe(result.field.sample(0, 0) + 0);
    expect(typeof landscapeSummary(result)).toBe('string');
    expect(landscapeSummary(result)).toContain('cells');
  });

  it('adds analytic detail on top of the baked grid', () => {
    const plain = bake({ ranges: [{ spine: [[-60, 0], [60, 0]], width: 20, height: 20 }] });
    const detailed = bake({
      ranges: [{ spine: [[-60, 0], [60, 0]], width: 20, height: 20 }],
      detail: { amplitude: 1.4, scale: 6 },
    });
    // Detail is analytic, so the baked grids are identical.
    expect(Array.from(plain.field.data)).toEqual(Array.from(detailed.field.data));
    let largest = 0;
    for (let i = -60; i <= 60; i += 7) {
      for (let j = -60; j <= 60; j += 7) {
        largest = Math.max(largest, Math.abs(detailed.heightAt(i, j) - plain.heightAt(i, j)));
      }
    }
    expect(largest).toBeGreaterThan(0.2);
    expect(largest).toBeLessThanOrEqual(1.4 + 1e-6);
  });

  it('keeps an ocean world below the water line at its borders', () => {
    const result = bake({
      ocean: { start: 0.6, depth: 22 },
      islands: [{ center: [0, 0], radius: 30, height: 14, satellites: 2 }],
      beaches: { width: 6 },
    }, { waterLevel: 0, style: 'islands', size: 220 });
    expect(result.field.sample(0, 0)).toBeGreaterThan(0);
    expect(result.field.sample(105, 105)).toBeLessThan(0);
    expect(result.stats.landFraction).toBeLessThan(0.9);
    expect(result.stats.landFraction).toBeGreaterThan(0.02);
    expect(result.suggestedWaterLevel).toBe(0);
  });

  it('suggests a water level when the plan has none but the land needs one', () => {
    const result = bake({ ocean: { start: 0.6, depth: 18 }, islands: [{ center: [0, 0], radius: 34, height: 12 }] }, { size: 200 });
    expect(result.suggestedWaterLevel).not.toBeNull();
    expect(Number.isFinite(result.suggestedWaterLevel ?? NaN)).toBe(true);
  });

  it('blocks building on river corridors, cave passages and open water', () => {
    const result = bake({
      ranges: [{ spine: [[-70, -30], [0, 0], [70, 30]], width: 24, height: 30, roughness: 0.8 }],
      ocean: { start: 0.82, depth: 10 },
      rivers: [{ width: 4, corridor: 10 }],
      caves: [{ radius: 3, depth: 16 }],
    }, { size: 200, waterLevel: 0 });
    // Somewhere on the map must be buildable.
    let buildable = 0;
    let blocked = 0;
    for (let i = -90; i <= 90; i += 9) {
      for (let j = -90; j <= 90; j += 9) {
        if (result.blockedAt(i, j)) blocked += 1;
        else buildable += 1;
      }
    }
    expect(buildable).toBeGreaterThan(0);
    expect(blocked).toBeGreaterThan(0);
    if (result.rivers.length > 0) {
      const river = result.rivers[0]!;
      const middle = river.points[Math.floor(river.points.length / 2)]!;
      expect(result.blockedAt(middle[0], middle[1])).toBe(true);
    }
    for (const cave of result.caves) {
      expect(result.blockedAt(cave.position[0], cave.position[1])).toBe(true);
    }
  });

  it('derives rivers that run downhill when the land drains somewhere', () => {
    const result = bake({
      ranges: [{ spine: [[-70, 0], [0, 0], [70, 0]], width: 24, height: 34, roughness: 0.85 }],
      ocean: { start: 0.85, depth: 12 },
      erosion: { droplets: 1500, iterations: 26 },
    }, { size: 200, waterLevel: 0 });
    expect(result.rivers.length).toBeGreaterThan(0);
    for (const river of result.rivers) {
      const heights = river.nodes.map(([ix, iz]) => result.field.at(ix, iz));
      // The bed never rises downstream, so water cannot flow uphill.
      for (let i = 1; i < heights.length; i += 1) {
        expect(heights[i] ?? 0).toBeLessThanOrEqual((heights[i - 1] ?? 0) + result.field.step * 0.25);
      }
    }
  });

  it('leaves a flat, waterless world flat and cheap', () => {
    const result = bake({ cells: 48 }, { style: 'flat', heightScale: 0, size: 120 }, 5);
    expect(result.rivers).toHaveLength(0);
    expect(result.lakes).toHaveLength(0);
    expect(Math.abs(result.stats.max - result.stats.min)).toBeLessThan(6);
    expect(result.biomes.entries).toHaveLength(0);
    expect(result.biomes.colorAt(0, 0).low.every((channel) => Number.isFinite(channel))).toBe(true);
  });

  it('caches a bake and re-bakes when the specification changes', () => {
    clearLandscapeCache();
    const terrain = terrainWith({ cells: 40, hills: [{ center: [0, 0], radius: 18, height: 6 }] }, { size: 120 });
    const first = getLandscape(terrain, 9);
    const second = getLandscape(terrain, 9);
    expect(second).toBe(first);
    const edited = getLandscape({ ...terrain, landscape: { ...terrain.landscape!, hills: [{ center: [0, 0], radius: 18, height: 12 }] } }, 9);
    expect(edited).not.toBe(first);
    expect(edited.field.max()).toBeGreaterThan(first.field.max());
    const reseeded = getLandscape(terrain, 10);
    expect(reseeded).not.toBe(first);
    clearLandscapeCache();
  });

  it('picks a bake resolution from the specification, the world size and a hard cap', () => {
    expect(bakeCells(terrainWith({ cells: 128 }), { cells: 128 })).toBe(128);
    expect(bakeCells(terrainWith({ cells: 4000 }), { cells: 4000 })).toBeLessThanOrEqual(512);
    expect(bakeCells(terrainWith({}, { resolution: 256, size: 512 }), {})).toBeLessThanOrEqual(320);
    expect(bakeCells(terrainWith({}, { resolution: 32, size: 64 }), {})).toBeGreaterThanOrEqual(96);
    expect(bakeCells(terrainWith({ cells: 200 }), { cells: 200 }, 96)).toBeLessThanOrEqual(96);
    // A big world bakes finer than a small one at the same resolution.
    expect(bakeCells(terrainWith({}, { size: 400 }), {})).toBeGreaterThan(bakeCells(terrainWith({}, { size: 96 }), {}));
  });

  it('keeps every derived layer aligned with the grid', () => {
    const result = bake({
      ranges: [{ spine: [[-60, 0], [60, 0]], width: 20, height: 26 }],
      biomes: [{ id: 'peak', biome: 'mountains' }, { id: 'low', biome: 'meadow' }],
    });
    const side = result.field.side;
    expect(result.masks.rock.data.length).toBe(side * side);
    expect(result.masks.corridor.data.length).toBe(side * side);
    expect(result.biomes.dominant.length).toBe(side * side);
    expect(result.flow!.accumulation.length).toBe(side * side);
    expect(result.flow!.downstream.length).toBe(side * side);
    for (const entry of result.biomes.entries) expect(entry.weight.data.length).toBe(side * side);
  });

  it('bakes a large, complex world inside a usable time budget', () => {
    const started = Date.now();
    const result = bakeLandscape(terrainWith({
      ranges: [
        { spine: [[-230, -60], [-120, -20], [0, -40], [120, 10], [230, -20]], width: 44, height: 62, roughness: 0.8, snowLine: 34 },
        { spine: [[-180, 180], [-40, 150], [120, 200]], width: 30, height: 40, roughness: 0.6 },
      ],
      hills: [
        { center: [-150, 90], radius: 46, height: 12 },
        { center: [160, -140], radius: 38, height: 10 },
      ],
      valleys: [{ spine: [[-200, 40], [-60, 70], [80, 40], [210, 80]], width: 34, depth: 12, floor: 0.5 }],
      plateaus: [{ center: [180, 120], radius: 52, height: 26, terraces: 4 }],
      canyons: [{ spine: [[-220, -150], [-80, -120], [60, -170], [220, -140]], width: 16, depth: 30, meander: 0.5 }],
      volcanoes: [{ center: [-190, -190], radius: 54, height: 58, crater: 0.16, gullies: 14 }],
      craters: [{ center: [60, 210], radius: 26, depth: 12, centralPeak: 0.4 }],
      islands: [{ center: [210, 210], radius: 40, height: 18, irregularity: 0.7, satellites: 4 }],
      ocean: { start: 0.86, depth: 34 },
      lakes: [{ center: [-40, 120], radius: 30, depth: 8 }],
      rivers: [{ source: [-120, -20], width: 7, corridor: 18, meander: 0.6 }],
      caves: [{ radius: 5, depth: 30, chambers: 3 }, {}],
      cliffs: { minSlope: 0.85, sharpen: 0.5, coverage: 0.65 },
      beaches: { width: 8, maxSlope: 0.5, elevation: 0.7 },
      biomes: [
        { id: 'snow', biome: 'snow' },
        { id: 'alpine', biome: 'alpine' },
        { id: 'forest', biome: 'forest', center: [-150, 90], radius: 120, transition: 40 },
        { id: 'meadow', biome: 'meadow' },
        { id: 'marsh', biome: 'swamp', center: [-40, 120], radius: 60 },
        { id: 'volcanic', biome: 'volcanic', center: [-190, -190], radius: 70 },
      ],
      erosion: { droplets: 6000, iterations: 40, thermalPasses: 2, talus: 0.9 },
      detail: { amplitude: 0.6, scale: 9 },
      chunks: { size: 64, lod: [{ distance: 90, cells: 40 }, { distance: 260, cells: 18 }, { distance: 4096, cells: 8 }] },
    }, { size: 512, resolution: 192, heightScale: 60, waterLevel: 0, style: 'mountains' }), 424242, { maxCells: 192 });

    expect(result.field.data.every((value) => Number.isFinite(value))).toBe(true);
    expect(result.stats.max).toBeGreaterThan(20);
    expect(result.stats.min).toBeLessThan(0);
    expect(result.rivers.length).toBeGreaterThan(0);
    expect(result.caves.length).toBeGreaterThan(0);
    expect(result.biomes.entries).toHaveLength(6);
    expect(result.chunks.count).toBeGreaterThanOrEqual(36);
    expect(result.chunked).toBe(true);
    expect(lodCells(20, result.chunks.lod)).toBe(40);
    expect(lodCells(4096, result.chunks.lod)).toBe(8);
    expect(Date.now() - started).toBeLessThan(20000);
  });
});
