import type { WorldObject } from './schema';

/**
 * Registry of procedural geometry ids the renderer can build.
 *
 * The validator rejects plans that reference an unknown geometry, and the
 * regeneration code uses the registry to re-roll an object without guessing
 * which builder produced it.
 */
export const SUPPORTED_GEOMETRY: readonly string[] = [
  'primitive.box',
  'primitive.sphere',
  'primitive.cylinder',
  'primitive.cone',
  'primitive.torus',
  'primitive.plane',
  'tree.pine',
  'tree.broadleaf',
  'tree.palm',
  'tree.cactus',
  'tree.bush',
  'rock.boulder',
  'rock.crag',
  'building.house',
  'building.tower',
  'building.ruin',
  'building.barn',
  'building.coop',
  'path.dirt',
  'path.stone',
  'path.gravel',
  'water.river',
  'fence.wood',
  'fence.stone',
  'fence.rail',
  'field.wheat',
  'structure.bridge',
  'structure.silo',
  'prop.lantern',
];

const SUPPORTED = new Set(SUPPORTED_GEOMETRY);

export function isSupportedGeometry(geometry: string): boolean {
  return SUPPORTED.has(geometry);
}

/** Geometry id for documents written before v3 (or hand-authored objects). */
export function geometryIdForObject(object: WorldObject): string {
  switch (object.kind) {
    case 'primitive':
      return `primitive.${object.primitive}`;
    case 'tree':
      return `tree.${object.variant}`;
    case 'rock':
      return `rock.${object.variant}`;
    case 'building':
      return object.variant === 'tower' && object.meta.geometry === 'structure.silo'
        ? 'structure.silo'
        : `building.${object.variant}`;
    case 'lantern':
      return 'prop.lantern';
    case 'path':
      return `path.${object.style}`;
    case 'river':
      return 'water.river';
    case 'fence':
      return `fence.${object.style}`;
    case 'field':
      return 'field.wheat';
    case 'bridge':
      return 'structure.bridge';
  }
}
