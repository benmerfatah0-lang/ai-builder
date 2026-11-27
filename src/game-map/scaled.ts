import type {
  ArenaDef,
  BossDef,
  BridgeSpec,
  BuildingSpec,
  CircleFence,
  FenceRun,
  FieldSpec,
  RegionDef,
  TreeZone,
  Vec2,
  WorldWater,
} from './types';
import { WORLD_SCALE, scaleWater } from './layout';

/**
 * Takes the authored coordinate space and hands it to the scene in world units.
 *
 * The whole map is authored in a compact farm-scale grid: a field is 16 units
 * wide because that reads well next to a 16-unit road spacing, and the bands are
 * 60 units deep because that is how far apart they wanted to be. None of that
 * is the right *physical* size for a valley the camera flies over, and the
 * mismatch was the difference between "a farm in a meadow" and "a farm lost in a
 * field".
 *
 * Rather than rewrite a thousand coordinates (and every test that asserts on
 * them), the scene scales at the boundary: `data.ts` stays readable and the
 * diorama grows. One multiplier, applied once.
 */

const p = (point: Vec2): Vec2 => [point[0] * WORLD_SCALE, point[1] * WORLD_SCALE];

export interface SceneData {
  water: WorldWater;
  roads: { id: string; width: number; points: Vec2[] }[];
  fields: FieldSpec[];
  fences: FenceRun[];
  circleFences: CircleFence[];
  trees: TreeZone[];
  buildings: BuildingSpec[];
  arenas: ArenaDef[];
  bosses: BossDef[];
  regions: RegionDef[];
  bridges: BridgeSpec[];
  checkpoints: { id: string; position: Vec2 }[];
}

export function scaleMapData(data: SceneData): SceneData {
  return {
    water: scaleWater(data.water),
    roads: data.roads.map((road) => ({
      ...road,
      // Width stays in authored units: a lane should still read as a lane.
      width: road.width * 1.15,
      points: road.points.map(p),
    })),
    fields: data.fields.map((field) => ({
      ...field,
      x: field.x * WORLD_SCALE,
      z: field.z * WORLD_SCALE,
      w: field.w * WORLD_SCALE,
      d: field.d * WORLD_SCALE,
    })),
    fences: data.fences.map((fence) => ({
      ...fence,
      points: fence.points.map(p),
      gaps: fence.gaps?.map((gap) => ({ start: gap.start * WORLD_SCALE, end: gap.end * WORLD_SCALE })),
    })),
    circleFences: data.circleFences.map((fence) => ({
      ...fence,
      center: p(fence.center),
      radius: fence.radius * WORLD_SCALE,
    })),
    trees: data.trees.map((zone) => ({
      ...zone,
      x: zone.x * WORLD_SCALE,
      z: zone.z * WORLD_SCALE,
      w: zone.w * WORLD_SCALE,
      d: zone.d * WORLD_SCALE,
    })),
    buildings: data.buildings.map((building) => ({
      ...building,
      position: p(building.position),
      scale: (building.scale ?? 1) * WORLD_SCALE,
    })),
    arenas: data.arenas.map((arena) => ({
      ...arena,
      position: p(arena.position),
      radius: arena.radius * WORLD_SCALE,
      home: arena.home ? { ...arena.home, offset: p(arena.home.offset ?? [0, 0]) } : undefined,
    })),
    bosses: data.bosses.map((boss) => ({
      ...boss,
      position: p(boss.position),
    })),
    regions: data.regions.map((region) => ({
      ...region,
      center: p(region.center),
      radius: region.radius * WORLD_SCALE,
      polygon: region.polygon.map(p),
    })),
    bridges: data.bridges.map((bridge) => ({
      ...bridge,
      position: p(bridge.position),
      length: bridge.length * WORLD_SCALE,
      width: bridge.width * WORLD_SCALE,
    })),
    checkpoints: data.checkpoints.map((checkpoint) => ({
      ...checkpoint,
      position: p(checkpoint.position),
    })),
  };
}

export type { ArenaDef, BossDef, BridgeSpec, BuildingSpec, CircleFence, FenceRun, FieldSpec, RegionDef, TreeZone };
