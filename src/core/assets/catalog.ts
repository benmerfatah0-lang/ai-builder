import type { Rng } from '../generation/rng';
import { range } from '../generation/rng';
import type {
  BuildingVariant,
  RockVariant,
  TreeVariant,
  WorldObject,
  WorldPlan,
} from '../world-plan/schema';
import { createTransform } from '../world-plan/factory';
import type { TerrainSampler } from '../generation/terrain';
import { createId } from '../utils/id';

/** Purely presentational asset descriptors used by the editor's asset library. */
export type AssetCategory = 'primitives' | 'nature' | 'structures' | 'lights';

export interface AssetDefinition {
  id: string;
  label: string;
  category: AssetCategory;
  description: string;
  /** Builds a new object placed with its base at `position`. */
  create(rng: Rng, position: [number, number, number]): WorldObject;
}

function baseObject(
  name: string,
  position: [number, number, number],
): { id: string; name: string; transform: ReturnType<typeof createTransform>; visible: boolean; locked: boolean } {
  return {
    id: createId('obj'),
    name,
    transform: createTransform(position),
    visible: true,
    locked: false,
  };
}

function primitiveAsset(
  id: string,
  label: string,
  primitive: 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane',
  color: string,
  description: string,
): AssetDefinition {
  return {
    id,
    label,
    category: 'primitives',
    description,
    create: (_rng, position) => ({
      ...baseObject(label, position),
      kind: 'primitive',
      primitive,
      color,
    }),
  };
}

const TREE_COLORS: Record<TreeVariant, { foliage: string; trunk: string }> = {
  pine: { foliage: '#355f3d', trunk: '#4b3521' },
  broadleaf: { foliage: '#5d7f3f', trunk: '#5a422b' },
  palm: { foliage: '#4e7e46', trunk: '#8a6b45' },
  cactus: { foliage: '#5c7c4a', trunk: '#5c7c4a' },
};

export function createTree(variant: TreeVariant, position: [number, number, number], rng: Rng): WorldObject {
  const palette = TREE_COLORS[variant] ?? { foliage: '#5d7f3f', trunk: '#5a422b' };
  return {
    ...baseObject(`${variant[0]?.toUpperCase() ?? 'T'}${variant.slice(1)}`, position),
    kind: 'tree',
    variant,
    color: palette.foliage,
    trunkColor: palette.trunk,
    transform: {
      ...createTransform(position),
      rotationY: range(rng, 0, 360),
      scale: [range(rng, 0.8, 1.25), range(rng, 0.8, 1.35), range(rng, 0.8, 1.25)],
    },
  };
}

export function createRock(
  variant: RockVariant,
  position: [number, number, number],
  rng: Rng,
  color = '#7d7c75',
): WorldObject {
  return {
    ...baseObject(variant === 'crag' ? 'Crag' : 'Boulder', position),
    kind: 'rock',
    variant,
    color,
    transform: {
      ...createTransform(position),
      rotationY: range(rng, 0, 360),
      scale: [range(rng, 0.7, 1.5), range(rng, 0.55, 1.2), range(rng, 0.7, 1.5)],
    },
  };
}

export function createBuilding(
  variant: BuildingVariant,
  position: [number, number, number],
  rng: Rng,
  colors: { wall: string; roof: string } = { wall: '#b8a488', roof: '#7a4d3c' },
): WorldObject {
  const label = variant[0]?.toUpperCase() ?? 'B';
  return {
    ...baseObject(`${label}${variant.slice(1)}`, position),
    kind: 'building',
    variant,
    color: colors.wall,
    roofColor: colors.roof,
    transform: {
      ...createTransform(position),
      rotationY: range(rng, 0, 360),
      scale: [range(rng, 1, 1.3), range(rng, 0.9, 1.3), range(rng, 1, 1.3)],
    },
  };
}

export function createLantern(position: [number, number, number], color = '#ffc46b'): WorldObject {
  return {
    ...baseObject('Lantern', position),
    kind: 'lantern',
    color,
  };
}

export const ASSET_LIBRARY: AssetDefinition[] = [
  primitiveAsset('box', 'Cube', 'box', '#b9b3a8', 'A six-sided block for buildings and props.'),
  primitiveAsset('sphere', 'Sphere', 'sphere', '#9aa7b5', 'A smooth sphere for orbs and markers.'),
  primitiveAsset('cylinder', 'Cylinder', 'cylinder', '#a39078', 'A cylinder for columns and platforms.'),
  primitiveAsset('cone', 'Cone', 'cone', '#c28a5b', 'A cone for roofs and markers.'),
  primitiveAsset('torus', 'Torus', 'torus', '#c2a25b', 'A ring for arches and decorative props.'),
  primitiveAsset('plane', 'Slab', 'plane', '#8d9187', 'A thin slab for platforms and paths.'),
  {
    id: 'pine',
    label: 'Pine tree',
    category: 'nature',
    description: 'Conifer for temperate and mountain biomes.',
    create: (rng, position) => createTree('pine', position, rng),
  },
  {
    id: 'broadleaf',
    label: 'Broadleaf tree',
    category: 'nature',
    description: 'Rounded canopy tree for meadows and villages.',
    create: (rng, position) => createTree('broadleaf', position, rng),
  },
  {
    id: 'palm',
    label: 'Palm tree',
    category: 'nature',
    description: 'Tropical tree for islands and oases.',
    create: (rng, position) => createTree('palm', position, rng),
  },
  {
    id: 'cactus',
    label: 'Cactus',
    category: 'nature',
    description: 'Desert plant for arid worlds.',
    create: (rng, position) => createTree('cactus', position, rng),
  },
  {
    id: 'boulder',
    label: 'Boulder',
    category: 'nature',
    description: 'Weathered round rock.',
    create: (rng, position) => createRock('boulder', position, rng),
  },
  {
    id: 'crag',
    label: 'Crag',
    category: 'nature',
    description: 'Angular rock formation.',
    create: (rng, position) => createRock('crag', position, rng),
  },
  {
    id: 'house',
    label: 'House',
    category: 'structures',
    description: 'Small dwelling with a pitched roof.',
    create: (rng, position) => createBuilding('house', position, rng),
  },
  {
    id: 'tower',
    label: 'Tower',
    category: 'structures',
    description: 'Tall stone tower.',
    create: (rng, position) => createBuilding('tower', position, rng, { wall: '#9a9384', roof: '#5a5c63' }),
  },
  {
    id: 'ruin',
    label: 'Ruin',
    category: 'structures',
    description: 'Broken walls of an ancient structure.',
    create: (rng, position) => createBuilding('ruin', position, rng, { wall: '#8f8878', roof: '#6e6a5f' }),
  },
  {
    id: 'lantern',
    label: 'Lantern',
    category: 'lights',
    description: 'Warm glowing light prop for villages and ruins.',
    create: (_rng, position) => createLantern(position),
  },
];


/** Find a non-overlapping spot near the terrain centre for manually added objects. */
export function placementForNewObject(
  plan: WorldPlan,
  sampler: TerrainSampler,
  rng: Rng,
): [number, number, number] {
  const center = plan.terrain.size * 0.12;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const x = range(rng, -center, center);
    const z = range(rng, -center, center);
    const occupied = plan.objects.some(
      (object) =>
        Math.hypot(object.transform.position[0] - x, object.transform.position[2] - z) < 2.2,
    );
    if (!occupied) return [x, sampler.heightAt(x, z), z];
  }
  return [0, sampler.heightAt(0, 0), 0];
}
