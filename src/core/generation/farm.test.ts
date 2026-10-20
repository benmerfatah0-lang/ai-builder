import { describe, expect, it } from 'vitest';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlanWithReport } from './generateWorld';
import { createTerrainSampler } from './terrain';
import {
  footprintFromObject,
  footprintFromPoints,
  footprintFromRect,
  footprintsOverlap,
} from './placement';
import { validateScenePlan, repairScenePlan } from '../world-plan/validateScene';
import { regenerateObjectInPlan, regenerateRegion } from './regenerate';
import { validateWorldPlan, type WorldObject } from '../world-plan/schema';

const FARM_PROMPT =
  'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths';

function farmPlan(seed = 20261020) {
  const interpretation = interpretPromptLocally(FARM_PROMPT, { seed });
  return generateWorldPlanWithReport(interpretation.intent);
}

function distance2D(a: readonly number[], b: readonly number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

/** World-space vertices of a polyline object (its local points are offsets). */
function polylineWorldPoints(object: WorldObject): [number, number, number][] {
  if (object.kind !== 'path' && object.kind !== 'river' && object.kind !== 'fence') return [];
  return object.points.map((point) => [
    object.transform.position[0] + point[0],
    object.transform.position[1] + point[1],
    object.transform.position[2] + point[2],
  ]);
}

describe('farm prompt interpretation', () => {
  it('detects every structure in the farm brief', () => {
    const { intent } = interpretPromptLocally(FARM_PROMPT, { seed: 7 });
    expect(intent.biome).toBe('meadow');
    expect(intent.scale).toBe('large');
    expect(intent.style).toBe('cartoon');
    expect(intent.features?.farm).toBe(true);
    expect(intent.features?.farmhouse).toBe(true);
    expect(intent.features?.barn).toBe(true);
    expect(intent.features?.coop).toBe(true);
    expect(intent.features?.fences).toBe(true);
    expect(intent.features?.dirtPaths).toBe(true);
    expect(intent.cues.some((cue) => cue.includes('farmhouse'))).toBe(true);
  });

  it('honours explicit size, style and density overrides from the UI', () => {
    const { intent } = interpretPromptLocally('A little farm with a barn', {
      seed: 12,
      scale: 'small',
      style: 'natural',
      density: 'dense',
    });
    expect(intent.scale).toBe('small');
    expect(intent.style).toBe('natural');
    expect(intent.density).toBe('dense');
    const report = generateWorldPlanWithReport(intent);
    expect(report.plan.terrain.size).toBe(110);
    expect(report.plan.terrain.heightScale).toBeGreaterThan(3);
  });

  it('still interprets non-farm prompts with the scatter generator', () => {
    const { intent } = interpretPromptLocally('A misty pine forest at night with lanterns');
    expect(intent.features).toBeUndefined();
    expect(intent.biome).toBe('forest');
  });
});

describe('farm generator', () => {
  it('produces a valid v3 plan with all requested structures', () => {
    const report = farmPlan();
    expect(report.validation.valid).toBe(true);
    expect(validateWorldPlan(report.plan).success).toBe(true);
    expect(report.plan.schemaVersion).toBe(3);

    const kinds = new Set(report.plan.objects.map((object) => object.kind));
    for (const kind of ['building', 'field', 'path', 'fence', 'tree']) {
      expect(kinds.has(kind as WorldObject['kind'])).toBe(true);
    }

    const buildings = report.plan.objects.filter((object) => object.kind === 'building');
    expect(buildings.some((object) => object.name === 'Farmhouse')).toBe(true);
    expect(buildings.some((object) => object.name === 'Barn')).toBe(true);
    expect(buildings.some((object) => object.name === 'Chicken coop')).toBe(true);
    expect(report.plan.objects.filter((object) => object.kind === 'field')).toHaveLength(3);
    expect(report.plan.objects.filter((object) => object.kind === 'fence').length).toBeGreaterThan(6);
    expect(report.plan.objects.filter((object) => object.kind === 'path').length).toBeGreaterThan(4);
    expect(report.plan.groups.map((group) => group.name)).toEqual(
      expect.arrayContaining(['Farmstead', 'Wheat fields', 'Paths', 'Fences']),
    );
    expect(report.warnings).toHaveLength(0);
  });

  it('grounds buildings and keeps solid footprints apart', () => {
    const report = farmPlan();
    const sampler = createTerrainSampler(report.plan.terrain, report.plan.seed);
    const solids = report.plan.objects.filter(
      (object) => object.kind === 'building' || object.kind === 'field',
    );
    for (const object of solids) {
      const [x, y, z] = object.transform.position;
      expect(Math.abs(y - sampler.heightAt(x, z))).toBeLessThan(0.01);
    }

    for (let a = 0; a < solids.length; a += 1) {
      const boxA = footprintFromObject(solids[a]!);
      if (!boxA) continue;
      for (let b = a + 1; b < solids.length; b += 1) {
        const boxB = footprintFromObject(solids[b]!);
        if (!boxB) continue;
        if (solids[a]!.kind === 'field' && solids[b]!.kind === 'field') continue;
        expect(footprintsOverlap(boxA, boxB)).toBe(false);
      }
    }
  });

  it('connects every building to the dirt path network', () => {
    const report = farmPlan();
    const paths = report.plan.objects.filter((object) => object.kind === 'path');
    const pathPoints = paths.flatMap((object) => polylineWorldPoints(object));
    expect(pathPoints.length).toBeGreaterThan(20);

    const buildings = report.plan.objects.filter((object) => object.kind === 'building');
    for (const building of buildings) {
      const nearest = Math.min(
        ...pathPoints.map((point) => distance2D(building.transform.position, point)),
      );
      // Lanes stop at the door; allow the building radius plus a doorstep.
      expect(nearest).toBeLessThan(8);
    }

    // The main lane starts near the south edge of the terrain and ends in the yard.
    const lane = paths.find((object) => object.name === 'Main dirt lane');
    expect(lane).toBeDefined();
    const points = polylineWorldPoints(lane!);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    expect(first[2]).toBeGreaterThan(report.plan.terrain.size * 0.3);
    expect(Math.abs(last[0])).toBeLessThan(1);
    expect(Math.abs(last[2] - 6)).toBeLessThan(1);
  });

  it('keeps lanes clear of the crops and the fields inside their fence', () => {
    const report = farmPlan();
    const fields = report.plan.objects.filter((object) => object.kind === 'field');
    const paths = report.plan.objects.filter((object) => object.kind === 'path');
    expect(fields.length).toBeGreaterThan(1);

    // Crops opt out of collision reporting, so measure their nominal bed.
    const fieldBox = (field: WorldObject) => {
      const [width, , depth] = field.meta.dimensions;
      return footprintFromRect(
        field.transform.position[0],
        field.transform.position[2],
        width * field.transform.scale[0],
        depth * field.transform.scale[2],
        field.transform.rotation[1],
      );
    };
    for (const path of paths) {
      const width = path.kind === 'path' ? path.width : 3;
      const footprint = footprintFromPoints(polylineWorldPoints(path), width);
      for (const field of fields) {
        expect(footprintsOverlap(footprint, fieldBox(field))).toBe(false);
      }
    }

    // Every field sits inside the fenced block (5 segments: 4 sides + a gate split).
    const fieldFences = report.plan.objects.filter(
      (object) => object.kind === 'fence' && object.name.startsWith('Field fence'),
    );
    expect(fieldFences.length).toBeGreaterThanOrEqual(4);
    const fencePoints = fieldFences.flatMap((object) => polylineWorldPoints(object));
    const minX = Math.min(...fencePoints.map((point) => point[0]));
    const maxX = Math.max(...fencePoints.map((point) => point[0]));
    const minZ = Math.min(...fencePoints.map((point) => point[2]));
    const maxZ = Math.max(...fencePoints.map((point) => point[2]));
    for (const field of fields) {
      const box = fieldBox(field);
      expect(box.minX).toBeGreaterThan(minX - 0.5);
      expect(box.maxX).toBeLessThan(maxX + 0.5);
      expect(box.minZ).toBeGreaterThan(minZ - 0.5);
      expect(box.maxZ).toBeLessThan(maxZ + 0.5);
    }
  });

  it('places lantern posts even in daylight so the yard reads at dusk', () => {
    const report = farmPlan();
    const lanterns = report.plan.objects.filter((object) => object.kind === 'lantern');
    expect(lanterns.length).toBeGreaterThanOrEqual(3);
    expect(lanterns.every((object) => object.meta.region === 'paths')).toBe(true);
  });

  it('is deterministic per seed and varies across seeds', () => {
    const a = farmPlan(99);
    const b = farmPlan(99);
    const c = farmPlan(100);
    const fingerprint = (plan: typeof a.plan) =>
      plan.objects.map((object) => `${object.kind}:${object.name}:${object.transform.position.join(',')}`);

    expect(fingerprint(a.plan)).toEqual(fingerprint(b.plan));
    expect(fingerprint(c.plan)).not.toEqual(fingerprint(a.plan));
  });

  it('adds a river and a bridge when the prompt asks for a stream crossing', () => {
    const interpretation = interpretPromptLocally(
      'A small cartoon farm with a barn, a wheat field, a stream and a bridge',
      { seed: 4242 },
    );
    const report = generateWorldPlanWithReport(interpretation.intent);
    expect(report.validation.valid).toBe(true);
    expect(report.plan.objects.filter((object) => object.kind === 'river')).toHaveLength(1);
    const bridge = report.plan.objects.find((object) => object.kind === 'bridge');
    expect(bridge).toBeDefined();
    expect(bridge?.kind).toBe('bridge');
    if (bridge?.kind === 'bridge') expect(bridge.length).toBeGreaterThan(8);
  });
});

describe('scene validation and recovery', () => {
  it('rejects unsupported geometry and missing bridge dependencies', () => {
    const report = farmPlan();
    const broken = {
      ...report.plan,
      objects: report.plan.objects.map((object, index) =>
        index === 0
          ? { ...object, meta: { ...object.meta, geometry: 'dragon.scale' } }
          : object,
      ),
    };
    const validation = validateScenePlan(broken);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((issue) => issue.code === 'unsupported-geometry')).toBe(true);

    const bridgeOnly = {
      ...report.plan,
      objects: [
        ...report.plan.objects,
        {
          id: 'obj_bridge_test',
          name: 'Lonely bridge',
          parentId: null,
          kind: 'bridge' as const,
          length: 10,
          width: 3,
          deckColor: '#a17b4c',
          railColor: '#7a5a36',
          visible: true,
          locked: false,
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          meta: {
            category: 'structure' as const,
            geometry: 'structure.bridge',
            dimensions: [3, 1.5, 10] as [number, number, number],
            source: 'procedural' as const,
            status: 'generated' as const,
          },
        },
      ],
    };
    const missing = validateScenePlan(bridgeOnly);
    expect(missing.valid).toBe(false);
    expect(missing.errors.some((issue) => issue.code === 'missing-dependency')).toBe(true);
  });

  it('warns about floating objects and repairs them safely', () => {
    const report = farmPlan();
    const objects = report.plan.objects.map((object) =>
      object.id === report.plan.objects[0]!.id
        ? {
            ...object,
            transform: {
              ...object.transform,
              position: [
                object.transform.position[0],
                object.transform.position[1] + 6,
                object.transform.position[2],
              ] as [number, number, number],
            },
          }
        : object,
    );
    const floating = { ...report.plan, objects };
    const validation = validateScenePlan(floating);
    expect(validation.warnings.some((issue) => issue.code === 'floating')).toBe(true);

    const repaired = repairScenePlan(floating);
    expect(repaired.moved.length).toBeGreaterThan(0);
    const fixed = repaired.plan.objects.find(
      (object) => object.id === report.plan.objects[0]!.id,
    );
    expect(fixed).toBeDefined();
  });

  it('drops unbuildable objects during recovery', () => {
    const report = farmPlan();
    const broken = {
      ...report.plan,
      objects: report.plan.objects.map((object, index) =>
        index === 0
          ? { ...object, meta: { ...object.meta, geometry: 'statue.unknown' } }
          : object,
      ),
    };
    const repaired = repairScenePlan(broken);
    expect(repaired.removed.length).toBe(1);
    expect(validateScenePlan(repaired.plan).valid).toBe(true);
  });
});

describe('regeneration', () => {
  it('re-rolls one object without moving or renaming it', () => {
    const report = farmPlan();
    const tree = report.plan.objects.find((object) => object.kind === 'tree');
    expect(tree).toBeDefined();
    const result = regenerateObjectInPlan(report.plan, tree!.id, { seed: 123456 });
    const rebuilt = result.changed[0]!;
    expect(rebuilt.id).toBe(tree!.id);
    expect(rebuilt.name).toBe(tree!.name);
    expect(rebuilt.parentId).toBe(tree!.parentId);
    expect(rebuilt.transform.position).toEqual(tree!.transform.position);
    expect(rebuilt.meta.seed).toBe(123456);
    expect(rebuilt.meta.status).toBe('generated');
    expect(result.plan.objects).toHaveLength(report.plan.objects.length);
  });

  it('re-rolls a field crop pattern in place', () => {
    const report = farmPlan();
    const field = report.plan.objects.find((object) => object.kind === 'field');
    expect(field).toBeDefined();
    if (field?.kind !== 'field') throw new Error('field missing');
    const result = regenerateObjectInPlan(report.plan, field.id, { seed: 555 });
    const rebuilt = result.plan.objects.find((object) => object.id === field.id);
    if (rebuilt?.kind !== 'field') throw new Error('field lost');
    expect(rebuilt.seed).toBe(555);
    expect(rebuilt.width).toBe(field.width);
    expect(rebuilt.depth).toBe(field.depth);
    expect(rebuilt.transform.position).toEqual(field.transform.position);
  });

  it('regenerates only the objects inside a region', () => {
    const report = farmPlan();
    const region = 'landscape';
    const before = new Map(report.plan.objects.map((object) => [object.id, object]));
    const result = regenerateRegion(report.plan, region, { seed: 8080 });
    expect(result.changed.length).toBeGreaterThan(0);
    expect(result.changed.every((object) => object.meta.region === region)).toBe(true);
    for (const object of result.plan.objects) {
      if (object.meta.region !== region) {
        expect(object).toBe(before.get(object.id));
      }
    }
  });
});
