import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { MAX_WORLD_OBJECTS, type Terrain, type WorldObject, type WorldPlan } from '../../core/world-plan/schema';
import { validateScenePlan } from '../../core/world-plan/validateScene';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { extractFrames } from './frames';
import { createTerrainSampler } from '../../core/generation/terrain';
import { applySpecToPlan, applySpecToShell, terrainPolyline } from './realize';
import { solveSpec } from './solve';
import type { WorldSpec } from './worldSpec';

const BIG = 'قلعة حجرية كبيرة فوق قمة جبل، وتحتها قرية صغيرة تحيط ببحيرة، والبيوت تربطها طرق ترابية. بدون أشجار نخيل.';

function specFor(description: string): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed: 11 }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function planWith(objects: WorldObject[], terrain: Partial<Terrain> = {}): WorldPlan {
  const base = createEmptyWorldPlan({ seed: 11, name: 'fixture' });
  return {
    ...base,
    terrain: { ...base.terrain, style: 'mountains', size: 160, resolution: 64, heightScale: 30, waterLevel: 4, ...terrain },
    objects,
  };
}

function building(id: string, position: [number, number, number], extra: Partial<WorldObject> = {}): WorldObject {
  return {
    id,
    name: 'بيت',
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    kind: 'building',
    variant: 'house',
    color: '#ffffff',
    roofColor: '#8b5a2b',
    meta: { category: 'structure', geometry: 'building.house', dimensions: [4, 3, 4], source: 'procedural', status: 'generated' },
    ...extra,
  } as WorldObject;
}

function castle(id: string, position: [number, number, number], extra: Partial<WorldObject> = {}): WorldObject {
  return {
    id,
    name: 'قلعة',
    parentId: null,
    transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    kind: 'primitive',
    primitive: 'castle',
    color: '#ffffff',
    meta: { category: 'structure', geometry: 'structure.castle', dimensions: [10, 14, 10], source: 'procedural', status: 'generated' },
    ...extra,
  } as WorldObject;
}

describe('applySpecToPlan: water', () => {
  it('carves the lake basin the spec asked for and keeps the water level', () => {
    const spec = specFor(BIG);
    const plan = planWith([]);
    const result = applySpecToPlan(plan, spec);
    expect(result.plan.terrain.lakeBasin).toEqual({ x: 0, z: 0, radius: spec.terrain.lake!.radius, depth: spec.terrain.lake!.depth });
    expect(result.plan.terrain.waterLevel).toBe(4);
    expect(result.warnings).toEqual([]);
  });

  it('says so when the terrain cannot hold water at all', () => {
    const spec = specFor('صحراء فيها بحيرة');
    const result = applySpecToPlan(planWith([], { style: 'hills', waterLevel: null }), spec);
    expect(result.plan.terrain.lakeBasin).toBeTruthy();
    expect(result.warnings.join(' ')).toContain('مستوى ماء');
  });

  it('clamps an out-of-range lake into the schema instead of writing it raw', () => {
    const spec = clone(specFor(BIG));
    spec.terrain.lake = { x: 900, z: -900, radius: 5000, depth: 900 };
    const basin = applySpecToPlan(planWith([]), spec).plan.terrain.lakeBasin!;
    expect(basin.x).toBeLessThanOrEqual(256);
    expect(basin.z).toBeGreaterThanOrEqual(-256);
    expect(basin.radius).toBeLessThanOrEqual(256);
    expect(basin.depth).toBeLessThanOrEqual(50);
    expect(validateScenePlan(applySpecToPlan(planWith([]), spec).plan).errors).toEqual([]);
  });

  it('never overwrites a basin the world already has', () => {
    const spec = specFor(BIG);
    const existing = { x: 12, z: -8, radius: 9, depth: 1.2 };
    const result = applySpecToPlan(planWith([], { lakeBasin: existing }), spec);
    expect(result.plan.terrain.lakeBasin).toEqual(existing);
  });

  it('adds one river and says whether the engine carved it', () => {
    const spec = clone(specFor(BIG));
    spec.terrain.river = { axis: 'z', width: 3, excavates: false };
    const result = applySpecToPlan(planWith([]), spec);
    expect(result.plan.objects.filter((object) => object.kind === 'river')).toHaveLength(1);
    // A mountain world is baked by the landscape engine, so the river is a real
    // carved channel and the report must not call it decorative.
    expect(result.plan.terrain.landscape).toBeDefined();
    expect(result.warnings.join(' ')).toContain('محفور');
    // Running it again on the result must not stack a second river.
    expect(applySpecToPlan(result.plan, spec).plan.objects.filter((object) => object.kind === 'river')).toHaveLength(1);
  });

  it('keeps the classic decorative ribbon when the terrain was not baked', () => {
    const spec = clone(specFor(BIG));
    spec.terrain.river = { axis: 'z', width: 3, excavates: false };
    spec.terrain.landscape = undefined;
    const result = applySpecToPlan(planWith([]), spec);
    expect(result.plan.objects.filter((object) => object.kind === 'river')).toHaveLength(1);
    expect(result.plan.terrain.landscape).toBeUndefined();
    expect(result.warnings.join(' ')).toContain('زخرفي');
  });

  it('lays a carved river inside its own channel instead of floating over it', () => {
    const spec = clone(specFor(BIG));
    spec.terrain.river = { axis: 'z', width: 3, excavates: false };
    const plan = applySpecToPlan(planWith([]), spec).plan;
    const river = plan.objects.find((object) => object.kind === 'river') as
      | { points: [number, number, number][]; transform: { position: [number, number, number] }; width: number }
      | undefined;
    expect(river).toBeDefined();
    expect(river!.points.length).toBeGreaterThanOrEqual(2);
    expect(river!.points.length).toBeLessThanOrEqual(64);
    expect(river!.width).toBeGreaterThanOrEqual(0.5);
    expect(river!.width).toBeLessThanOrEqual(40);
    const sampler = createTerrainSampler(plan.terrain, plan.seed);
    const [originX, originY, originZ] = river!.transform.position;
    for (const [x, y, z] of river!.points) {
      const ground = sampler.heightAt(x + originX, z + originZ);
      // The water surface rides just above the bed it was carved into.
      expect(y + originY).toBeLessThanOrEqual(ground + 0.4);
      expect(y + originY).toBeGreaterThan(ground - 3);
      expect(Number.isFinite(ground)).toBe(true);
    }
    expect(validateScenePlan(plan).errors).toEqual([]);
  });
});

describe('applySpecToPlan: connector roads and bridges', () => {
  const houses = [building('obj_h1', [-20, 4, 10]), building('obj_h2', [0, 6, -12]), building('obj_h3', [18, 5, 14])];

  it('lays a terrain-following road between the houses the relation connects', () => {
    const spec = clone(specFor(BIG));
    const relation = spec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.status = 'resolved';
    relation.resolved = [[-20, 10], [18, 14]];
    const result = applySpecToPlan(planWith(clone(houses)), spec);
    const roads = result.plan.objects.filter((object) => object.kind === 'path');
    expect(roads.length).toBeGreaterThan(0);
    const road = roads[0]! as { points: [number, number, number][]; style: string; width: number };
    expect(road.points.length).toBeGreaterThanOrEqual(2);
    expect(road.points.length).toBeLessThanOrEqual(64);
    expect(road.points.every(([x, y, z]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))).toBe(true);
    expect(['dirt', 'stone', 'gravel']).toContain(road.style);
    expect(road.width).toBeGreaterThan(0);
    expect(validateScenePlan(result.plan).errors).toEqual([]);
  });

  it('picks the road surface from the materials and the terrain', () => {
    const stoneSpec = clone(specFor(BIG));
    const relation = stoneSpec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.status = 'resolved';
    relation.resolved = [[-20, 10], [18, 14]];
    stoneSpec.materials.palette = 'stone';
    const stoneRoad = applySpecToPlan(planWith(clone(houses)), stoneSpec).plan.objects.find((object) => object.kind === 'path') as { style: string };
    expect(stoneRoad.style).toBe('stone');

    const sandSpec = clone(stoneSpec);
    sandSpec.materials.palette = undefined;
    const sandPlan = planWith(clone(houses), { style: 'dunes' });
    expect((applySpecToPlan(sandPlan, sandSpec).plan.objects.find((object) => object.kind === 'path') as { style: string }).style).toBe('gravel');
  });

  it('does nothing for a relation that was never resolved', () => {
    const spec = specFor(BIG);
    expect(spec.relations.every((relation) => relation.status === 'pending')).toBe(true);
    expect(applySpecToPlan(planWith(clone(houses)), spec).plan.objects.filter((object) => object.kind === 'path')).toEqual([]);
  });

  it('builds a bridge over a river the scene actually has', () => {
    const spec = clone(specFor(BIG));
    spec.terrain.river = { axis: 'z', width: 3, excavates: false };
    const relation = spec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.predicate = 'across';
    relation.via = 'جسر خشبي';
    relation.status = 'resolved';
    relation.resolved = [[-20, 10], [0, 0], [18, 14]];
    const result = applySpecToPlan(planWith(clone(houses)), spec);
    expect(result.plan.objects.filter((object) => object.kind === 'bridge')).toHaveLength(1);
    expect(validateScenePlan(result.plan).errors).toEqual([]);
  });

  it('refuses to build a bridge over nothing, because validation would reject it', () => {
    const spec = clone(specFor(BIG));
    const relation = spec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.predicate = 'across';
    relation.via = 'جسر خشبي';
    relation.status = 'resolved';
    relation.resolved = [[-20, 10], [0, 0], [18, 14]];
    const result = applySpecToPlan(planWith(clone(houses)), spec);
    expect(result.plan.objects.filter((object) => object.kind === 'bridge')).toEqual([]);
    expect(result.warnings.join(' ')).toContain('لم يُبنَ الجسر');
    expect(validateScenePlan(result.plan).errors).toEqual([]);
  });

  it('stops adding connectors at the document budget and reports it', () => {
    const spec = clone(specFor(BIG));
    const relation = spec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.status = 'resolved';
    relation.resolved = [[-20, 10], [18, 14]];
    const full: WorldObject[] = Array.from({ length: MAX_WORLD_OBJECTS }, (_, index) => building(`obj_f${index}`, [0, 0, 0]));
    const result = applySpecToPlan(planWith(full), spec);
    expect(result.plan.objects.length).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(result.warnings.join(' ')).toContain('سعة المستند');
  });

  it('reports when the planned positions fall outside the terrain', () => {
    const spec = clone(specFor(BIG));
    const relation = spec.relations.find((entry) => entry.predicate === 'connected-by')!;
    relation.status = 'resolved';
    relation.resolved = [[5000, 5000], [6000, 6000]];
    const result = applySpecToPlan(planWith([]), spec);
    expect(result.plan.objects.filter((object) => object.kind === 'path')).toEqual([]);
    expect(result.warnings.join(' ')).toContain('حدود التضاريس');
  });
});

describe('applySpecToPlan: materials', () => {
  it('paints buildings and structure primitives with the requested palette', () => {
    const spec = clone(specFor(BIG));
    spec.materials = { palette: 'stone', wall: '#a8a294', roof: '#6f6a60', roughness: 0.9 };
    const result = applySpecToPlan(planWith([building('obj_h1', [0, 0, 0]), castle('obj_c1', [10, 0, 10])]), spec);
    const house = result.plan.objects.find((object) => object.id === 'obj_h1') as { color: string; roofColor: string; material?: { roughness?: number } };
    expect(house.color).toBe('#a8a294');
    expect(house.roofColor).toBe('#6f6a60');
    expect(house.material?.roughness).toBe(0.9);
    expect((result.plan.objects.find((object) => object.id === 'obj_c1') as { color: string }).color).toBe('#a8a294');
  });

  it('leaves objects the user edited or locked exactly as they are', () => {
    const spec = clone(specFor(BIG));
    spec.materials = { palette: 'stone', wall: '#123456', roof: '#654321', roughness: 0.2 };
    const edited = building('obj_edited', [0, 0, 0], { meta: { category: 'structure', geometry: 'building.house', dimensions: [4, 3, 4], source: 'manual', status: 'edited' } });
    const locked = building('obj_locked', [6, 0, 6], { locked: true });
    const result = applySpecToPlan(planWith([edited, locked]), spec);
    expect((result.plan.objects.find((object) => object.id === 'obj_edited') as { color: string }).color).toBe('#ffffff');
    expect((result.plan.objects.find((object) => object.id === 'obj_locked') as { color: string }).color).toBe('#ffffff');
  });

  it('does not invent a material when the spec asks for none', () => {
    const spec = clone(specFor('غابة'));
    spec.materials = {};
    const result = applySpecToPlan(planWith([building('obj_h1', [0, 0, 0])]), spec);
    const house = result.plan.objects.find((object) => object.id === 'obj_h1') as { color: string; material?: unknown };
    expect(house.color).toBe('#ffffff');
    expect(house.material).toBeUndefined();
  });
});

describe('applySpecToPlan: regions', () => {
  it('tags objects that fall inside a named region', () => {
    const spec = clone(specFor('قرية في الغرب وقلعة في الشرق'));
    expect(spec.regions.length).toBeGreaterThan(0);
    const west = spec.regions.find((region) => region.selector === 'west')!;
    const result = applySpecToPlan(planWith([building('obj_w', [-60, 0, 0]), building('obj_e', [60, 0, 0])]), spec);
    expect((result.plan.objects.find((object) => object.id === 'obj_w') as { meta: { region?: string } }).meta.region).toBe(west.id.slice(0, 40));
  });

  it('keeps a region tag already on the object', () => {
    const spec = clone(specFor('قرية في الغرب'));
    const tagged = building('obj_w', [-60, 0, 0], { meta: { category: 'structure', geometry: 'building.house', dimensions: [4, 3, 4], source: 'procedural', status: 'generated', region: 'my-region' } });
    const result = applySpecToPlan(planWith([tagged]), spec);
    expect((result.plan.objects.find((object) => object.id === 'obj_w') as { meta: { region?: string } }).meta.region).toBe('my-region');
  });
});

describe('applySpecToPlan: light and weather', () => {
  it('scales the generated lighting without leaving the schema range', () => {
    const spec = clone(specFor(BIG));
    spec.lighting = { timeOfDay: 'night', sunIntensityScale: 0.5, ambientIntensityScale: 1.5, requested: [] };
    const result = applySpecToPlan(planWith([]), spec);
    expect(result.plan.environment.sunIntensity).toBeCloseTo(planWith([]).environment.sunIntensity * 0.5, 5);
    expect(result.plan.environment.sunIntensity).toBeLessThanOrEqual(4);
    expect(result.plan.environment.ambientIntensity).toBeLessThanOrEqual(3);
    expect(validateScenePlan(result.plan).errors).toEqual([]);
  });

  it('clamps absurd light values instead of writing them', () => {
    const spec = clone(specFor(BIG));
    spec.lighting = { timeOfDay: 'day', sunIntensityScale: 900, ambientIntensityScale: -900, requested: [] };
    const environment = applySpecToPlan(planWith([]), spec).plan.environment;
    expect(environment.sunIntensity).toBe(4);
    expect(environment.ambientIntensity).toBe(0);
  });

  it('applies fog, sky and sun angles from the description', () => {
    const spec = clone(specFor('غابة في الليل مع ضباب كثيف'));
    const result = applySpecToPlan(planWith([]), spec);
    expect(result.plan.environment.fogDensity).toBeGreaterThan(0);
    expect(result.plan.environment.fogDensity).toBeLessThanOrEqual(1);
    expect(result.plan.environment.skyColor).toMatch(/^#[0-9a-f]{6}$/u);
    if (spec.lighting.sunElevation !== undefined) expect(result.plan.environment.sunElevation).toBe(spec.lighting.sunElevation);
  });
});

describe('applySpecToPlan: honesty about what it could not build', () => {
  it('reports animals that exist in the spec but have no local builder', () => {
    const warnings = applySpecToPlan(planWith([]), specFor('ثلاث غزلان في غابة')).warnings;
    expect(warnings.join(' ')).toContain('غزال');
    expect(warnings.join(' ')).toContain('لا يوجد باني');
  });

  it('reports every relation it could not resolve', () => {
    const spec = clone(specFor(BIG));
    spec.relations[0]!.status = 'unsupported';
    spec.relations[0]!.note = 'لا يوجد مرجع مرتفع';
    const warnings = applySpecToPlan(planWith([]), spec).warnings;
    expect(warnings.join(' ')).toContain('لم تُحل العلاقة');
    expect(warnings.join(' ')).toContain('لا يوجد مرجع مرتفع');
  });

  it('reports a building the spec knows but nothing can build', () => {
    const spec = clone(specFor(BIG));
    spec.buildings[0]!.realized = 'unrealized';
    expect(applySpecToPlan(planWith([]), spec).warnings.join(' ')).toContain('لا يوجد باني محلي له');
  });

  it('says nothing when everything it was asked to do was done', () => {
    expect(applySpecToPlan(planWith([]), specFor('غابة كثيفة')).warnings).toEqual([]);
  });
});

describe('applySpecToPlan: it never breaks the existing plan', () => {
  it('does not mutate the plan it was given', () => {
    const spec = specFor(BIG);
    const plan = planWith([building('obj_h1', [0, 0, 0])]);
    const before = clone(plan);
    applySpecToPlan(plan, spec);
    expect(plan).toEqual(before);
  });

  it('keeps every object, group and field the generator produced', () => {
    const spec = specFor(BIG);
    const objects = [building('obj_h1', [0, 0, 0]), castle('obj_c1', [10, 0, 10])];
    const plan = planWith(objects);
    const result = applySpecToPlan(plan, spec);
    expect(result.plan.objects.length).toBeGreaterThanOrEqual(objects.length);
    expect(result.plan.objects.filter((object) => object.id === 'obj_h1')).toHaveLength(1);
    expect(result.plan.groups).toEqual(plan.groups);
    expect(result.plan.seed).toBe(plan.seed);
    expect(result.plan.schemaVersion).toBe(plan.schemaVersion);
    expect(result.plan.terrain.style).toBe(plan.terrain.style);
  });

  it('always hands back a plan that passes scene validation', () => {
    for (const description of [BIG, 'صحراء فيها واحة', 'غابة في الليل مع ضباب', 'قرية حول بحيرة']) {
      const validation = validateScenePlan(applySpecToPlan(planWith([building('obj_h1', [0, 0, 0])]), specFor(description)).plan);
      expect(validation.errors).toEqual([]);
    }
  });
});

describe('applySpecToShell: terrain and atmosphere for callers that place their own objects', () => {
  it('carries the lake, the light and the weather into an empty shell', () => {
    const spec = specFor('غابة في الليل مع ضباب، فيها بحيرة');
    const shell = applySpecToShell(planWith([]), spec);
    expect(shell.plan.terrain.lakeBasin).toBeTruthy();
    expect(shell.plan.environment.sunIntensity).toBeLessThan(planWith([]).environment.sunIntensity);
    expect(shell.plan.environment.fogDensity).toBeGreaterThan(0);
    expect(shell.plan.objects).toEqual([]);
    expect(validateScenePlan(shell.plan).errors).toEqual([]);
  });

  it('never repaints or adds objects, so the caller stays in charge of the scene', () => {
    const spec = clone(specFor(BIG));
    spec.materials = { palette: 'stone', wall: '#123456', roof: '#654321', roughness: 0.1 };
    spec.relations.find((entry) => entry.predicate === 'connected-by')!.status = 'resolved';
    const objects = [building('obj_h1', [0, 0, 0])];
    const shell = applySpecToShell(planWith(objects), spec);
    expect(shell.plan.objects).toEqual(objects);
    expect((shell.plan.objects[0] as { color: string }).color).toBe('#ffffff');
    expect(shell.plan.objects.filter((object) => object.kind === 'path')).toEqual([]);
  });

  it('still reports water it cannot hold', () => {
    const shell = applySpecToShell(planWith([], { style: 'hills', waterLevel: null }), specFor('صحراء فيها بحيرة'));
    expect(shell.plan.terrain.lakeBasin).toBeTruthy();
    expect(shell.warnings.join(' ')).toContain('مستوى ماء');
  });

  it('does not mutate the shell it was given', () => {
    const plan = planWith([]);
    const before = clone(plan);
    applySpecToShell(plan, specFor(BIG));
    expect(plan).toEqual(before);
  });
});

describe('terrainPolyline', () => {
  it('returns null unless it has two usable points', () => {
    const plan = planWith([]);
    expect(terrainPolyline(plan, [[0, 0]], 'dirt', 'r')).toBeNull();
    expect(terrainPolyline(plan, [[9000, 9000], [9100, 9100]], 'dirt', 'r')).toBeNull();
  });

  it('follows the terrain and caps the ribbon at 64 points', () => {
    const plan = planWith([]);
    const many = Array.from({ length: 200 }, (_, index) => [-70 + index * 0.7, -40 + index * 0.4] as [number, number]);
    const path = terrainPolyline(plan, many, 'stone', 'region-village') as { points: [number, number, number][]; style: string };
    expect(path.style).toBe('stone');
    expect(path.points.length).toBeGreaterThan(1);
    expect(path.points.length).toBeLessThanOrEqual(64);
    // Local points are relative to the ribbon origin, so the first is the origin.
    expect(path.points[0]).toEqual([0, 0, 0]);
  });
});
