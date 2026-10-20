import type { SceneNode, WorldObject } from '../../../core/world-plan/schema';
import type { IconName } from '../../../ui/Icon';

export const KIND_ICONS: Record<WorldObject['kind'], IconName> = {
  primitive: 'cube',
  tree: 'tree',
  rock: 'mountain',
  building: 'layers',
  lantern: 'sun',
};

export const KIND_LABELS: Record<WorldObject['kind'], string> = {
  primitive: 'Primitive',
  tree: 'Tree',
  rock: 'Rock',
  building: 'Building',
  lantern: 'Lantern',
};

export function objectSubtitle(object: WorldObject): string {
  switch (object.kind) {
    case 'primitive':
      return object.primitive;
    case 'tree':
    case 'rock':
    case 'building':
      return object.variant;
    case 'lantern':
      return 'light';
  }
}

export function nodeIcon(node: SceneNode): IconName {
  return 'kind' in node ? KIND_ICONS[node.kind] : 'folder';
}

export function nodeTypeLabel(node: SceneNode): string {
  return 'kind' in node ? KIND_LABELS[node.kind] : 'Group';
}

export function nodeSubtitle(node: SceneNode): string {
  return 'kind' in node ? objectSubtitle(node) : 'group';
}
