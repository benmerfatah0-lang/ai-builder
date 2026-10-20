import type { WorldObject } from './schema';

/**
 * Colour accessors for the object union.
 *
 * Most kinds expose a primary `color`, but fences, fields and bridges use
 * purpose-named channels. The inspector and patch reducer go through these
 * helpers so editing a fence's "base colour" writes `postColor` instead of
 * adding an invalid `color` key.
 */

export function getObjectColor(object: WorldObject): string {
  switch (object.kind) {
    case 'fence':
      return object.postColor;
    case 'field':
      return object.cropColor;
    case 'bridge':
      return object.deckColor;
    default:
      return object.color;
  }
}

export function getObjectSecondaryColor(object: WorldObject): string | null {
  switch (object.kind) {
    case 'building':
      return object.roofColor;
    case 'tree':
      return object.trunkColor;
    case 'fence':
    case 'bridge':
      return object.railColor;
    case 'field':
      return object.soilColor;
    default:
      return null;
  }
}

export function secondaryColorLabel(object: WorldObject): string | null {
  switch (object.kind) {
    case 'building':
      return 'Roof';
    case 'tree':
      return 'Trunk';
    case 'fence':
    case 'bridge':
      return 'Rails';
    case 'field':
      return 'Soil';
    default:
      return null;
  }
}
