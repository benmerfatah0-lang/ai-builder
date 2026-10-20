import type {
  ObjectCategory,
  ObjectMeta,
  WorldObject,
} from './schema';

/**
 * Builders for generation metadata.
 *
 * `meta` is required on every drawable object (schema v3), so both the asset
 * library and the procedural planner go through these helpers. Keeping the
 * defaults in one place also makes v2 → v3 migration deterministic.
 */

export interface MetaInput {
  category: ObjectCategory;
  geometry: string;
  dimensions: [number, number, number];
  source?: ObjectMeta['source'];
  status?: ObjectMeta['status'];
  role?: string;
  seed?: number;
  region?: string;
  anchor?: 'ground' | 'terrain' | 'water';
  avoidOverlap?: boolean;
  collision?: boolean;
}

export function createMeta(input: MetaInput): ObjectMeta {
  return {
    category: input.category,
    geometry: input.geometry,
    dimensions: input.dimensions,
    source: input.source ?? 'procedural',
    status: input.status ?? 'generated',
    ...(input.role ? { role: input.role } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.region ? { region: input.region } : {}),
    placement: {
      anchor: input.anchor ?? 'terrain',
      avoidOverlap: input.avoidOverlap ?? true,
    },
    collision: {
      shape: input.collision === false ? 'none' : 'box',
      blocking: input.collision !== false,
    },
  };
}

/** Metadata inferred for documents written before v3. */
export function inferMetaForObject(object: WorldObject): ObjectMeta {
  switch (object.kind) {
    case 'tree':
      return createMeta({
        category: 'vegetation',
        geometry: `tree.${object.variant}`,
        dimensions:
          object.variant === 'bush'
            ? [1.6, 1.2, 1.6]
            : object.variant === 'palm'
              ? [3.4, 4.4, 3.4]
              : object.variant === 'cactus'
                ? [1, 2.6, 1]
                : [2.4, 4.2, 2.4],
        source: 'library',
        status: 'edited',
        collision: object.variant !== 'bush',
      });
    case 'rock':
      return createMeta({
        category: 'rock',
        geometry: `rock.${object.variant}`,
        dimensions: object.variant === 'crag' ? [2.6, 2.2, 2.6] : [1.8, 1.4, 1.8],
        source: 'library',
        status: 'edited',
      });
    case 'building':
      return createMeta({
        category: 'structure',
        geometry: `building.${object.variant}`,
        dimensions:
          object.variant === 'barn'
            ? [5.2, 4.6, 6.4]
            : object.variant === 'coop'
              ? [2.2, 2, 2]
              : object.variant === 'tower'
                ? [3.7, 7.7, 3.7]
                : [3.4, 4.3, 3],
        source: 'library',
        status: 'edited',
      });
    case 'lantern':
      return createMeta({
        category: 'prop',
        geometry: 'prop.lantern',
        dimensions: [0.5, 1.4, 0.5],
        source: 'library',
        status: 'edited',
      });
    case 'path':
      return createMeta({
        category: 'path',
        geometry: `path.${object.style}`,
        dimensions: [8, 0.1, 8],
        source: 'procedural',
        status: 'generated',
        anchor: 'terrain',
        collision: false,
      });
    case 'river':
      return createMeta({
        category: 'water',
        geometry: 'water.river',
        dimensions: [8, 0.1, 8],
        source: 'procedural',
        status: 'generated',
        anchor: 'terrain',
        collision: false,
      });
    case 'fence':
      return createMeta({
        category: 'fence',
        geometry: `fence.${object.style}`,
        dimensions: [8, object.height, 0.2],
        source: 'procedural',
        status: 'generated',
        anchor: 'terrain',
      });
    case 'field':
      return createMeta({
        category: 'field',
        geometry: 'field.wheat',
        dimensions: [object.width, 1, object.depth],
        source: 'procedural',
        status: 'generated',
        anchor: 'terrain',
        avoidOverlap: false,
        collision: false,
      });
    case 'bridge':
      return createMeta({
        category: 'structure',
        geometry: 'structure.bridge',
        dimensions: [object.width, 1.6, object.length],
        source: 'procedural',
        status: 'generated',
        anchor: 'water',
      });
    case 'primitive':
    default:
      return createMeta({
        category: 'prop',
        geometry: 'primitive.box',
        dimensions: [2, 2, 2],
        source: 'library',
        status: 'edited',
      });
  }
}
