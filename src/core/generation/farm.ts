import type {
  FarmFeatures,
  TimeOfDay,
  WorldDensity,
  WorldIntent,
  WorldScale,
} from '../../modules/ai/types';
import type { WorldObject, WorldPlan } from '../world-plan/schema';
import { MAX_WORLD_OBJECTS, WORLD_PLAN_SCHEMA_VERSION } from '../world-plan/schema';
import { createId } from '../utils/id';
import {
  createBuilding,
  createLantern,
  createRock,
  createTree,
} from '../assets/catalog';
import {
  createBarn,
  createBridge,
  createCoop,
  createField,
  createFence,
  createPath,
  createRiver,
  createSilo,
} from '../assets/structures';
import { createTerrainSampler, type TerrainSampler } from './terrain';
import { mulberry32, range } from './rng';
import {
  PlacementLedger,
  footprintFromPoints,
  footprintFromRect,
} from './placement';

/**
 * Structured farm generator.
 *
 * Unlike the scatter generator in `generateWorld.ts`, this lays the scene out
 * deliberately: a yard with buildings, lanes that connect them, fenced crop
 * fields, an orchard, a windbreak and (optionally) a river with a bridge.
 * Everything is driven by the intent seed, so the same prompt and seed produce
 * the same farm. Every object carries `meta.region`, which powers per-region
 * regeneration in the editor.
 */

export interface FarmBuildResult {
  plan: WorldPlan;
  warnings: string[];
}

type Vec3 = [number, number, number];

interface FarmPalette {
  wall: string;
  roof: string;
  barnWall: string;
  barnRoof: string;
  coopWall: string;
  coopRoof: string;
  field: string;
  soil: string;
  path: string;
  fencePost: string;
  fenceRail: string;
  water: string;
  foliage: string;
  trunk: string;
}

const PALETTES: FarmPalette[] = [
  {
    wall: '#efdfc0',
    roof: '#b65a44',
    barnWall: '#a5483b',
    barnRoof: '#5d4736',
    coopWall: '#d8c096',
    coopRoof: '#7c4a3a',
    field: '#dcb457',
    soil: '#7c5f42',
    path: '#b3946b',
    fencePost: '#8a6a45',
    fenceRail: '#a8845c',
    water: '#5b93a8',
    foliage: '#5d8a45',
    trunk: '#6b4d33',
  },
  {
    wall: '#e7d9c6',
    roof: '#8f5647',
    barnWall: '#8f4236',
    barnRoof: '#524034',
    coopWall: '#cdb48e',
    coopRoof: '#6d4436',
    field: '#d3ad5a',
    soil: '#6f573f',
    path: '#b09370',
    fencePost: '#7d5f3f',
    fenceRail: '#9b7a53',
    water: '#4f8599',
    foliage: '#587f45',
    trunk: '#5f4630',
  },
];

const TERRAIN_SIZES: Record<WorldScale, number> = { small: 110, medium: 170, large: 240 };

function paletteFor(seed: number): FarmPalette {
  return PALETTES[seed % PALETTES.length] ?? PALETTES[0]!;
}

function terrainSizeFor(intent: WorldIntent): number {
  return TERRAIN_SIZES[intent.scale];
}

function environmentFor(intent: WorldIntent): WorldPlan['environment'] {
  const time = intent.timeOfDay;
  const settings: Record<TimeOfDay, Pick<WorldPlan['environment'], 'skyColor' | 'fogColor' | 'sunColor' | 'sunAzimuth' | 'sunElevation' | 'sunIntensity' | 'ambientIntensity'>> =
    {
      day: {
        skyColor: '#93c4e2',
        fogColor: '#c6dce6',
        sunColor: '#fff3da',
        sunAzimuth: 216,
        sunElevation: 54,
        // Three.js r155+ uses physical light units: a directional light near 1.0
        // plus hemisphere ambient already reads as full daylight. Higher values
        // bleach the palette to pale lime once ACES tone mapping is applied.
        sunIntensity: 1.15,
        ambientIntensity: 0.32,
      },
      sunset: {
        skyColor: '#eaa878',
        fogColor: '#e6bd9c',
        sunColor: '#ffb36b',
        sunAzimuth: 264,
        sunElevation: 14,
        sunIntensity: 1.0,
        ambientIntensity: 0.26,
      },
      night: {
        skyColor: '#101733',
        fogColor: '#182544',
        sunColor: '#c0ccff',
        sunAzimuth: 200,
        sunElevation: 46,
        sunIntensity: 0.42,
        ambientIntensity: 0.24,
      },
    };
  // Light haze only: dense fog erased the far treeline and the fields.
  return { ...settings[time], fogDensity: 0.0012 };
}

function densityFactor(density: WorldDensity | undefined): number {
  if (density === 'sparse') return 0.62;
  if (density === 'dense') return 1.45;
  return 1;
}

/** Stable, readable IDs derived from the world seed (not random per build). */
function idFactory(seed: number) {
  const tag = seed.toString(36);
  let counter = 0;
  return (prefix: 'obj' | 'grp') => `${prefix}_${tag}_${(counter++).toString(36)}`;
}

function groundAt(sampler: TerrainSampler, x: number, z: number): number {
  return Math.round(sampler.heightAt(x, z) * 1000) / 1000;
}

function inBounds(sampler: TerrainSampler, x: number, z: number, margin = 3): boolean {
  const half = sampler.size / 2 - margin;
  return Math.abs(x) <= half && Math.abs(z) <= half;
}

/** Resample a coarse polyline so it follows the terrain and reads as a curve. */
function tracePath(
  sampler: TerrainSampler,
  corners: readonly [number, number][],
  step = 4,
): Vec3[] {
  const points: Vec3[] = [];
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index]!;
    const next = corners[index + 1];
    const x = current[0];
    const z = current[1];
    points.push([x, groundAt(sampler, x, z), z]);
    if (!next) break;
    const distance = Math.hypot(next[0] - x, next[1] - z);
    const steps = Math.max(1, Math.ceil(distance / step));
    for (let sub = 1; sub < steps; sub += 1) {
      const t = sub / steps;
      const px = x + (next[0] - x) * t;
      const pz = z + (next[1] - z) * t;
      points.push([px, groundAt(sampler, px, pz), pz]);
    }
  }
  return points;
}

function localPoints(points: readonly Vec3[]): Vec3[] {
  const origin = points[0] ?? ([0, 0, 0] as Vec3);
  return points.map((point) => [
    Math.round((point[0] - origin[0]) * 1000) / 1000,
    Math.round((point[1] - origin[1]) * 1000) / 1000,
    Math.round((point[2] - origin[2]) * 1000) / 1000,
  ]);
}

function moveObject<T extends WorldObject>(
  object: T,
  position: Vec3,
  rotationY: number,
  scale?: Vec3,
): T {
  return {
    ...object,
    transform: {
      ...object.transform,
      position,
      rotation: [0, rotationY, 0],
      scale: scale ?? object.transform.scale,
    },
  };
}

function defaultFeatures(): FarmFeatures {
  return {
    farm: true,
    farmhouse: true,
    barn: true,
    silo: true,
    coop: true,
    wheatFields: 2,
    fences: true,
    dirtPaths: true,
    orchard: true,
    river: false,
    bridge: false,
    rocks: true,
    bushes: true,
    lanterns: true,
  };
}

/**
 * Build a complete farm plan. Layout is authored in a local metre grid around
 * the yard, then mirrored by seed for variety. Objects are placed in dependency
 * order (buildings → fields → lanes → fences → water → vegetation), so later
 * steps can reject positions against everything already placed.
 */
export function generateFarmPlan(intent: WorldIntent): FarmBuildResult {
  const warnings: string[] = [];
  const features = { ...defaultFeatures(), ...intent.features };
  const style = intent.style ?? 'cartoon';
  const palette = paletteFor(intent.seed);
  const rng = mulberry32(intent.seed);
  const mirror = rng() < 0.5;
  const size = terrainSizeFor(intent);
  const terrain: WorldPlan['terrain'] = {
    style: 'hills',
    size,
    resolution: size >= 200 ? 160 : 128,
    // Gentle relief keeps the yard readable and lets long lanes follow the ground.
    heightScale: style === 'natural' ? 3.4 : 2.6,
    waterLevel: null,
    palette: { low: '#688a4b', high: '#a8bd78' },
  };
  const sampler = createTerrainSampler(terrain, intent.seed);
  const grow = idFactory(intent.seed);
  const groupIds = {
    farmstead: grow('grp'),
    fields: grow('grp'),
    fences: grow('grp'),
    paths: grow('grp'),
    landscape: grow('grp'),
    water: grow('grp'),
  } as const;

  const groups: WorldPlan['groups'] = [
    { nodeType: 'group', id: groupIds.farmstead, name: 'Farmstead', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    { nodeType: 'group', id: groupIds.fields, name: 'Wheat fields', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    { nodeType: 'group', id: groupIds.fences, name: 'Fences', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    { nodeType: 'group', id: groupIds.paths, name: 'Paths', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    { nodeType: 'group', id: groupIds.landscape, name: 'Landscape', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
    { nodeType: 'group', id: groupIds.water, name: 'Pond & crossings', parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, visible: true, locked: false },
  ];

  const objects: WorldObject[] = [];
  const ledger = new PlacementLedger();

  const add = (object: WorldObject, groupId: string, region: string, footprint?: { width: number; depth: number; margin?: number }) => {
    if (objects.length >= MAX_WORLD_OBJECTS) {
      warnings.push('Object limit reached; some details were skipped.');
      return object;
    }
    const [x, , z] = object.transform.position;
    const target: WorldObject = {
      ...object,
      parentId: groupId,
      meta: { ...object.meta, region, source: 'procedural', status: 'generated' },
    };
    objects.push(target);
    if (footprint) {
      ledger.add(
        footprintFromRect(x, z, footprint.width, footprint.depth, object.transform.rotation[1]),
        object.id,
      );
    }
    return target;
  };

  const spot = (x: number, z: number): Vec3 => {
    const worldX = mirror ? -x : x;
    return [worldX, groundAt(sampler, worldX, z), z];
  };
  /** Mirror a layout polyline exactly like `spot` mirrors object positions. */
  const layoutCorners = (corners: [number, number][]): [number, number][] =>
    corners.map(([x, z]) => [mirror ? -x : x, z]);

  // ---------------------------------------------------------------- buildings
  const houseX = 20;
  const houseZ = 4;
  try {
    const house = createBuilding('house', spot(houseX, houseZ), rng, {
      wall: palette.wall,
      roof: palette.roof,
    });
    const placed = moveObject(
      house,
      spot(houseX, houseZ),
      mirror ? 90 : -90,
      [1.08, 1.05, 1.08],
    );
    placed.name = 'Farmhouse';
    add(placed, groupIds.farmstead, 'farmstead', { width: 3.8, depth: 3.4 });
  } catch (error) {
    warnings.push(`Farmhouse could not be placed (${(error as Error).message}).`);
  }

  try {
    const barn = createBarn(spot(-18, 2), rng, palette.barnWall, palette.barnRoof);
    const placed = moveObject(barn, spot(-18, 2), mirror ? -90 : 90, [1, 1, 1]);
    add(placed, groupIds.farmstead, 'farmstead', { width: 6.6, depth: 7.8 });
  } catch (error) {
    warnings.push(`Barn could not be placed (${(error as Error).message}).`);
  }

  if (features.silo) {
    try {
      const silo = createSilo(spot(-24, -5), rng);
      const placed = moveObject(silo, spot(-24, -5), mirror ? 90 : -90, [0.62, 0.68, 0.62]);
      placed.name = 'Grain silo';
      add(placed, groupIds.farmstead, 'farmstead', { width: 2.4, depth: 2.4 });
    } catch (error) {
      warnings.push(`Silo skipped (${(error as Error).message}).`);
    }
  }

  if (features.coop) {
    try {
      const coop = createCoop(spot(12, 24), rng, palette.coopWall, palette.coopRoof);
      const placed = moveObject(coop, spot(12, 24), 180, [1, 1, 1]);
      add(placed, groupIds.farmstead, 'farmstead', { width: 4.2, depth: 6.4 });
    } catch (error) {
      warnings.push(`Chicken coop skipped (${(error as Error).message}).`);
    }
  }

  // ------------------------------------------------------------------- fields
  const fieldDefs = [
    { name: 'Wheat field (west)', x: -12, z: -30, width: 18, depth: 11 },
    { name: 'Wheat field (east)', x: 9, z: -30, width: 14, depth: 11 },
    { name: 'Wheat field (far)', x: -8, z: -45, width: 16, depth: 10 },
  ];
  const fieldCount = Math.max(1, Math.min(fieldDefs.length, Math.round(features.wheatFields)));
  const fields: WorldObject[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const definition = fieldDefs[index];
    if (!definition) continue;
    try {
      const field = createField(
        definition.width,
        definition.depth,
        spot(definition.x, definition.z),
        rng,
        {
          name: definition.name,
          rows: Math.round(definition.depth / 1.4),
          density: 0.92,
          cropColor: palette.field,
          soilColor: palette.soil,
          rotationY: 0,
          region: 'fields',
        },
      );
      const placed = moveObject(field, spot(definition.x, definition.z), 0);
      add(placed, groupIds.fields, 'fields', {
        width: definition.width,
        depth: definition.depth,
      });
      fields.push(placed);
    } catch (error) {
      warnings.push(`${definition.name} failed (${(error as Error).message}).`);
    }
  }

  // -------------------------------------------------------------------- paths
  const makePath = (name: string, corners: [number, number][], width = 3.2) => {
    const traced = tracePath(sampler, layoutCorners(corners));
    const origin = traced[0] ?? ([0, 0, 0] as Vec3);
    const path = createPath(localPoints(traced), origin, {
      name,
      width,
      color: palette.path,
      style: 'dirt',
      region: 'paths',
    });
    add(path, groupIds.paths, 'paths');
    // Lanes block vegetation but not other lanes (they may legitimately meet).
    ledger.add(footprintFromPoints(traced, width + 2), path.id);
    return traced;
  };

  makePath(
    'Main dirt lane',
    [
      [0, size * 0.36],
      [0, 30],
      [0, 18],
      [0, 6],
    ],
    3.8,
  );
  if (features.dirtPaths) {
    makePath('Lane to the farmhouse', [
      [0, 6],
      [12, 6],
      [16, 5],
      [17.7, 4],
    ], 2.8);
    makePath('Lane to the barn', [
      [0, 6],
      [-10, 6],
      [-13, 3],
      [-13.7, 2],
    ], 2.8);
    makePath('Lane to the coop', [
      [0, 6],
      [6, 14],
      [10, 21],
      [11.6, 23],
    ], 2.4);
    // The lane stops on the headland in front of the field gate; tracks never
    // run between the crop rows.
    makePath('Lane to the fields', [
      [0, 6],
      [0, -18],
      [0, -22.5],
    ], 2.8);
  }

  // Fence the field block with a gate aligned to the field lane.
  const fieldGateHalf = 2.2;

  // -------------------------------------------------------------------- river
  let riverCenterX = 0;
  if (features.river) {
    riverCenterX = mirror ? -size * 0.34 : size * 0.34;
    const zStart = -size * 0.42;
    const zEnd = size * 0.42;
    const riverCorners: [number, number][] = [];
    for (let z = zStart; z <= zEnd; z += 6) {
      const x = riverCenterX + Math.sin(z / 17) * 3.4;
      riverCorners.push([x, z]);
    }
    const traced = riverCorners.map(([x, z]) => [x, groundAt(sampler, x, z) + 0.08, z] as Vec3);
    const origin = traced[0] ?? ([0, 0, 0] as Vec3);
    const river = createRiver(localPoints(traced), origin, {
      name: 'Mill creek',
      width: 7,
      color: palette.water,
      region: 'water',
    });
    add(river, groupIds.water, 'water');
    ledger.add(footprintFromPoints(traced, 9), river.id);

    if (features.bridge) {
      const bridgeZ = 10;
      const centerX = riverCenterX + Math.sin(bridgeZ / 17) * 3.4;
      const bridge = createBridge(12, [centerX, groundAt(sampler, centerX, bridgeZ), bridgeZ], {
        name: 'Mill creek bridge',
        width: 3.4,
        deckColor: '#a17b4c',
        railColor: '#7a5a36',
        rotationY: 90,
        region: 'water',
      });
      add(bridge, groupIds.water, 'water', { width: 12, depth: 3.6 });
      if (features.dirtPaths) {
        makePath(
          'East meadow lane',
          [
            [0, 10],
            [16, 10],
            [28, 10],
            [size * 0.34 - 4, 10],
            [size * 0.34 + 8, 12],
          ],
          3,
        );
      }
    }
  } else if (features.bridge) {
    warnings.push('A bridge was requested without a river, so it was skipped.');
  }

  // ------------------------------------------------------------------- fences
  const addFence = (
    name: string,
    corners: [number, number][],
    style: 'wood' | 'stone' = 'wood',
  ) => {
    const traced = tracePath(sampler, layoutCorners(corners), 3);
    const origin = traced[0] ?? ([0, 0, 0] as Vec3);
    const fence = createFence(localPoints(traced), origin, {
      name,
      style,
      height: style === 'stone' ? 0.95 : 1.15,
      postColor: palette.fencePost,
      railColor: palette.fenceRail,
      region: 'boundary',
    });
    add(fence, groupIds.fences, 'boundary');
    ledger.add(footprintFromPoints(traced, 0.8), fence.id);
  };

  if (features.fences) {
    const yardMinX = -30;
    const yardMaxX = 30;
    const yardMinZ = -18;
    const yardMaxZ = 32;
    // South and north walls keep gates for the main lane.
    addFence('South pasture fence', [
      [yardMinX, yardMaxZ],
      [-3, yardMaxZ],
    ]);
    addFence('South pasture fence (east)', [
      [3, yardMaxZ],
      [yardMaxX, yardMaxZ],
    ]);
    // The field block forms the farmyard's northern boundary; only the
    // shoulders beside it need a fence.
    addFence('North pasture fence', [
      [yardMinX, yardMinZ],
      [-23, yardMinZ],
    ]);
    addFence('North pasture fence (east)', [
      [18, yardMinZ],
      [yardMaxX, yardMinZ],
    ]);
    addFence('West pasture fence', [
      [yardMinX, yardMinZ],
      [yardMinX, yardMaxZ],
    ]);
    // East fence leaves a gate for the lane to the creek.
    addFence('East pasture fence', [
      [yardMaxX, yardMinZ],
      [yardMaxX, 2],
    ]);
    addFence('East pasture fence (south)', [
      [yardMaxX, 14],
      [yardMaxX, yardMaxZ],
    ]);

    // Field enclosure with a gate on its south side.
    const fx0 = -23;
    const fx1 = 18;
    const fz0 = -52;
    const fz1 = -22;
    addFence('Field fence (south-west)', [
      [fx0, fz1],
      [-fieldGateHalf, fz1],
    ]);
    addFence('Field fence (south-east)', [
      [fieldGateHalf, fz1],
      [fx1, fz1],
    ]);
    addFence('Field fence (north)', [
      [fx0, fz0],
      [fx1, fz0],
    ]);
    addFence('Field fence (west)', [
      [fx0, fz0],
      [fx0, fz1],
    ]);
    addFence('Field fence (east)', [
      [fx1, fz0],
      [fx1, fz1],
    ]);
    if (features.orchard) {
      addFence('Orchard fence', [
        [34, 14],
        [34, 31],
        [50, 31],
      ]);
    }
  }

  // ------------------------------------------------------------------- orchard
  if (features.orchard) {
    const orchardOriginX = 38;
    const orchardOriginZ = 22;
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        if (rng() < 0.12) continue;
        const x = orchardOriginX + column * 5.2 + range(rng, -0.4, 0.4);
        const z = orchardOriginZ + row * 5.2 + range(rng, -0.4, 0.4);
        if (!inBounds(sampler, x, z, 4)) continue;
        const position = spot(x, z);
        if (!ledger.isFree(footprintFromRect(position[0], position[2], 2.8, 2.8), 0.4)) {
          continue;
        }
        const tree = createTree('broadleaf', position, rng);
        const placed = { ...tree, name: `Apple tree ${row * 3 + column + 1}` };
        add(placed, groupIds.landscape, 'orchard', { width: 2.6, depth: 2.6 });
      }
    }
  }

  // --------------------------------------------------------------- vegetation
  const factor = densityFactor(intent.density) * (intent.scale === 'large' ? 1.25 : intent.scale === 'small' ? 0.7 : 1);
  // Windbreak rows are scenery, not part of the scatter budget: counting them
  // here starved the meadow of trees on large maps.
  const treeBudget = Math.round(26 * factor);
  let plantedTrees = 0;
  const half = size / 2;

  const tryTree = (x: number, z: number, variant: 'broadleaf' | 'pine', label: string, region = 'landscape') => {
    if (objects.length >= MAX_WORLD_OBJECTS) return false;
    if (!inBounds(sampler, x, z, 4)) return false;
    const footprint = footprintFromRect(x, z, 3.4, 3.4);
    if (!ledger.isFree(footprint, 1.1)) return false;
    const y = groundAt(sampler, x, z);
    // Skip steep ground so trunks do not float on a hillside.
    const slope =
      Math.abs(sampler.heightAt(x + 1.2, z) - sampler.heightAt(x - 1.2, z)) +
      Math.abs(sampler.heightAt(x, z + 1.2) - sampler.heightAt(x, z - 1.2));
    if (slope > 1.6) return false;
    const tree = createTree(variant, [x, y, z], rng);
    add({ ...tree, name: label }, groupIds.landscape, region, { width: 3.0, depth: 3.0 });
    plantedTrees += 1;
    return true;
  };

  // Windbreak along the west and north edges.
  for (let z = -size * 0.4; z < size * 0.42; z += 6.5) {
    const x = -size * 0.4 + range(rng, -1.5, 1.5);
    tryTree(x, z, rng() < 0.4 ? 'pine' : 'broadleaf', 'Windbreak tree', 'windbreak');
  }
  for (let x = -size * 0.36; x < size * 0.4; x += 7) {
    const z = -size * 0.43 + range(rng, -1.2, 1.2);
    tryTree(x, z, rng() < 0.35 ? 'pine' : 'broadleaf', 'Windbreak tree', 'windbreak');
  }
  // South and east get thinner rows so the map does not end in bare grass.
  for (let x = -size * 0.4; x < size * 0.42; x += 11) {
    const z = size * 0.44 + range(rng, -1.2, 1.2);
    tryTree(x, z, rng() < 0.25 ? 'pine' : 'broadleaf', 'Hedgerow tree', 'windbreak');
  }
  for (let z = -size * 0.34; z < size * 0.4; z += 12) {
    const x = size * 0.44 + range(rng, -1.2, 1.2);
    tryTree(x, z, rng() < 0.3 ? 'pine' : 'broadleaf', 'Hedgerow tree', 'windbreak');
  }

  plantedTrees = 0;
  let attempts = 0;
  while (plantedTrees < treeBudget && attempts < treeBudget * 26) {
    attempts += 1;
    const angle = range(rng, 0, Math.PI * 2);
    const distance = Math.sqrt(rng()) * half * 0.82;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    tryTree(x, z, rng() < 0.22 ? 'pine' : 'broadleaf', 'Farm tree');
  }
  if (plantedTrees < treeBudget) {
    warnings.push(
      `Placed ${plantedTrees} of ${treeBudget} trees; the rest had no free ground.`,
    );
  }

  if (features.rocks) {
    let placedRocks = 0;
    const rockBudget = Math.round(7 * factor);
    for (let attempt = 0; attempt < rockBudget * 30 && placedRocks < rockBudget; attempt += 1) {
      const x = range(rng, -half * 0.8, half * 0.8);
      const z = range(rng, -half * 0.8, half * 0.8);
      if (!inBounds(sampler, x, z, 4)) continue;
      if (!ledger.isFree(footprintFromRect(x, z, 2.2, 2.2), 0.8)) continue;
      const rock = createRock('boulder', [x, groundAt(sampler, x, z), z], rng, '#8d8a7d');
      add(rock, groupIds.landscape, 'landscape', { width: 1.9, depth: 1.9 });
      placedRocks += 1;
    }
  }

  if (features.bushes) {
    let placedBushes = 0;
    const bushBudget = Math.round(15 * factor);
    for (let attempt = 0; attempt < bushBudget * 30 && placedBushes < bushBudget; attempt += 1) {
      const x = range(rng, -32, 32);
      const z = range(rng, -34, 34);
      if (!inBounds(sampler, x, z, 3)) continue;
      if (!ledger.isFree(footprintFromRect(x, z, 1.8, 1.8), 0.4)) continue;
      const bush = createTree('bush', [x, groundAt(sampler, x, z), z], rng);
      add(bush, groupIds.landscape, 'landscape', { width: 1.7, depth: 1.7 });
      placedBushes += 1;
    }
  }

  // Lantern posts are physical props, so a farm always gets the yard lights;
  // at night the plan's environment makes them read. A prompt that explicitly
  // asks for lamps (or a night scene) lights the rest of the yard too.
  {
    const lanternSpots: [number, number][] = [
      [2.4, 28],
      [2.4, 16],
      [2.4, 6],
      [16.5, 7.5],
      [-13, 0],
    ];
    if (features.lanterns) {
      lanternSpots.push([11.6, 22], [-23.2, -21], [0, -22.5]);
    }
    for (const [x, z] of lanternSpots) {
      const position = spot(x, z);
      if (!inBounds(sampler, position[0], position[2], 2)) continue;
      const lantern = createLantern(position, '#ffc46b');
      add(lantern, groupIds.paths, 'paths');
    }
  }

  // ------------------------------------------------------------------ finalise
  // Attach stable ids. Objects keep their insertion order, which is also the
  // order the hierarchy panel shows, so structures read first.
  const stableObjects = objects.map((object, index) => ({
    ...object,
    id: `obj_${intent.seed.toString(36)}_${index.toString(36)}`,
  }));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const finalObjects = stableObjects.map((object) => ({
    ...object,
    parentId: groupById.has(object.parentId ?? '') ? object.parentId : null,
  }));

  const plan: WorldPlan = {
    schemaVersion: WORLD_PLAN_SCHEMA_VERSION,
    id: createId('world'),
    name: intent.name.slice(0, 80),
    description: (
      `Generated from: “${intent.prompt}” · ` +
      `${finalObjects.length} objects · farm layout (${intent.scale}, ${style})`
    ).slice(0, 500),
    seed: intent.seed,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    environment: environmentFor(intent),
    terrain,
    groups,
    objects: finalObjects,
  };

  return { plan, warnings };
}
