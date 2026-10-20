import type {
  BuildingObject,
  FieldObject,
  WorldObject,
  WorldPlan,
} from '../world-plan/schema';
import { createBarn, createCoop, createField } from '../assets/structures';
import { createRock, createTree } from '../assets/catalog';
import { geometryIdForObject } from '../world-plan/geometry';
import { mulberry32, pick, range, type Rng } from './rng';

/**
 * Per-object and per-region regeneration.
 *
 * Regeneration re-rolls the *variation* of an object (tree species, rock shape,
 * building palette, crop density) while preserving its id, name, parent, region
 * and transform. It therefore never moves the user's work or rebuilds the world:
 * the editor's reducer only swaps the affected objects.
 */

export interface RegenerateOptions {
  /** Explicit seed; defaults to a hash of the current object seed + call count. */
  seed?: number;
}

export interface RegenerateResult {
  plan: WorldPlan;
  changed: WorldObject[];
  message: string;
}

const HOUSE_PALETTES: [string, string][] = [
  ['#efdfc0', '#b65a44'],
  ['#e6d3b3', '#8e4f3d'],
  ['#f1e4cb', '#a9542f'],
  ['#dfd3bf', '#6b7d8a'],
];

const BARN_PALETTES: [string, string][] = [
  ['#a4503f', '#5b4436'],
  ['#8f4236', '#524034'],
  ['#b0603f', '#6a4a33'],
  ['#94513f', '#45392f'],
];

const COOP_PALETTES: [string, string][] = [
  ['#c9b18b', '#7a4d3c'],
  ['#d8c096', '#6d4436'],
  ['#bfae8d', '#84543f'],
];

const CROP_PALETTES: string[] = ['#d9b45b', '#d3ad5a', '#e0bd63', '#cfa64e'];
const PATH_PALETTES: string[] = ['#a68a63', '#b3946b', '#b09370', '#9d8060'];
const WATER_PALETTES: string[] = ['#4f7f96', '#5b93a8', '#4f8599', '#5a8aa0'];
const FENCE_PALETTES: [string, string][] = [
  ['#8a6a45', '#a8845c'],
  ['#7d5f3f', '#9b7a53'],
  ['#94724b', '#b49067'],
];

function nextSeed(object: WorldObject, planSeed: number): number {
  const base = object.meta.seed ?? planSeed;
  const mixed = (base ^ Math.imul(0x9e3779b1, 2654435761)) >>> 0;
  return mixed === base ? (base + 1) >>> 0 : mixed;
}

function adoptIdentity(rebuilt: WorldObject, original: WorldObject, seed: number): WorldObject {
  return {
    ...rebuilt,
    id: original.id,
    name: original.name,
    parentId: original.parentId,
    visible: original.visible,
    locked: original.locked,
    meta: {
      ...original.meta,
      geometry: geometryIdForObject(rebuilt),
      source: 'procedural',
      status: 'generated',
      seed,
      dimensions: rebuilt.meta.dimensions,
    },
    // Regeneration never moves, rotates or rescales the user's object.
    transform: { ...original.transform },
  };
}

/** Rebuild one object's procedural variation, keeping its identity and place. */
export function regenerateObject(
  object: WorldObject,
  planSeed: number,
  options: RegenerateOptions = {},
): WorldObject {
  const seed = options.seed ?? nextSeed(object, planSeed);
  const rng = mulberry32(seed);
  const [x, y, z] = object.transform.position;

  switch (object.kind) {
    case 'tree': {
      const variant = reRollTreeVariant(object.variant, rng);
      const rebuilt = createTree(variant, [x, y, z], rng);
      // The catalog returns the wide WorldObject union; narrow it so the
      // re-tinted copy stays type-checkable.
      if (rebuilt.kind !== 'tree') return object;
      return adoptIdentity(
        { ...rebuilt, name: object.name, color: varyHex(rebuilt.color, rng, 0.06) },
        object,
        seed,
      );
    }
    case 'rock': {
      const variant = rng() < 0.4 ? 'crag' : 'boulder';
      const rebuilt = createRock(variant, [x, y, z], rng, randomRockColor(rng));
      return adoptIdentity({ ...rebuilt, name: object.name }, object, seed);
    }
    case 'building': {
      if (object.variant === 'barn') {
        const [wall, roof] = pick(rng, BARN_PALETTES, BARN_PALETTES[0]!);
        const rebuilt = createBarn([x, y, z], rng, wall, roof);
        return adoptIdentity({ ...rebuilt, name: object.name }, object, seed);
      }
      if (object.variant === 'coop') {
        const [wall, roof] = pick(rng, COOP_PALETTES, COOP_PALETTES[0]!);
        const rebuilt = createCoop([x, y, z], rng, wall, roof);
        return adoptIdentity({ ...rebuilt, name: object.name }, object, seed);
      }
      if (object.variant === 'house') {
        const [wall, roof] = pick(rng, HOUSE_PALETTES, HOUSE_PALETTES[0]!);
        const next: BuildingObject = {
          ...object,
          color: wall,
          roofColor: roof,
          meta: { ...object.meta, seed, status: 'generated' },
        };
        return next;
      }
      return { ...object, meta: { ...object.meta, seed, status: 'generated' } };
    }
    case 'field': {
      const rebuilt: FieldObject = {
        ...object,
        cropColor: pick(rng, CROP_PALETTES, object.cropColor),
        density: Math.min(1, Math.max(0.4, object.density + range(rng, -0.08, 0.08))),
        seed,
        meta: { ...object.meta, seed, status: 'generated' },
      };
      // Rebuild crops with the new seed while keeping the field footprint.
      const fresh = createField(object.width, object.depth, [x, y, z], rng, {
        name: object.name,
        rows: object.rows,
        density: rebuilt.density,
        cropColor: rebuilt.cropColor,
        soilColor: object.soilColor,
        rotationY: object.transform.rotation[1],
        region: object.meta.region,
      });
      return adoptIdentity({ ...fresh, name: object.name, seed }, object, seed);
    }
    case 'path': {
      return {
        ...object,
        color: pick(rng, PATH_PALETTES, object.color),
        meta: { ...object.meta, seed, status: 'generated' },
      };
    }
    case 'river': {
      return {
        ...object,
        color: pick(rng, WATER_PALETTES, object.color),
        meta: { ...object.meta, seed, status: 'generated' },
      };
    }
    case 'fence': {
      const [postColor, railColor] = pick(rng, FENCE_PALETTES, [
        object.postColor,
        object.railColor,
      ]);
      return {
        ...object,
        postColor,
        railColor,
        meta: { ...object.meta, seed, status: 'generated' },
      };
    }
    case 'bridge': {
      const [postColor, railColor] = pick(rng, FENCE_PALETTES, [
        object.deckColor,
        object.railColor,
      ]);
      return {
        ...object,
        deckColor: postColor,
        railColor,
        meta: { ...object.meta, seed, status: 'generated' },
      };
    }
    case 'lantern': {
      return {
        ...object,
        color: pick(rng, ['#ffc46b', '#ffd79a', '#ffb15c'], object.color),
        meta: { ...object.meta, seed, status: 'generated' },
      };
    }
    case 'primitive':
    default:
      return { ...object, meta: { ...object.meta, seed, status: 'generated' } };
  }
}

function reRollTreeVariant(
  variant: 'pine' | 'broadleaf' | 'palm' | 'cactus' | 'bush',
  rng: Rng,
): 'pine' | 'broadleaf' | 'palm' | 'cactus' | 'bush' {
  if (variant === 'bush' || variant === 'cactus' || variant === 'palm') return variant;
  return rng() < 0.5 ? 'pine' : 'broadleaf';
}

/** Nudge a hex colour up or down by a small seeded amount. */
function varyHex(hex: string, rng: Rng, amount: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return hex;
  const factor = 1 + (rng() * 2 - 1) * amount;
  const clamp = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * factor)));
  const red = clamp((value >> 16) & 0xff);
  const green = clamp((value >> 8) & 0xff);
  const blue = clamp(value & 0xff);
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0')}`;
}

function randomRockColor(rng: Rng): string {
  return pick(rng, ['#8d8a7d', '#9a9287', '#7f7d73', '#a39c8c'], '#8d8a7d');
}

/** Regenerate every object in a named region, leaving the rest untouched. */
export function regenerateRegion(
  plan: WorldPlan,
  region: string,
  options: RegenerateOptions = {},
): RegenerateResult {
  const baseSeed = options.seed ?? ((plan.seed ^ 0x9e3779b1) >>> 0);
  const rng = mulberry32(baseSeed);
  const changed: WorldObject[] = [];
  const objects = plan.objects.map((object) => {
    if (object.meta.region !== region) return object;
    const rebuilt = regenerateObject(object, plan.seed, {
      seed: Math.floor(rng() * 0xffffffff),
    });
    changed.push(rebuilt);
    return rebuilt;
  });

  return {
    plan: {
      ...plan,
      objects,
      updatedAt: new Date().toISOString(),
    },
    changed,
    message:
      changed.length === 0
        ? `No generated objects in “${region}”.`
        : `Regenerated ${changed.length} object(s) in “${region}”.`,
  };
}

/** Regenerate a single object inside a plan and return the new plan. */
export function regenerateObjectInPlan(
  plan: WorldPlan,
  objectId: string,
  options: RegenerateOptions = {},
): RegenerateResult {
  const current = plan.objects.find((object) => object.id === objectId);
  if (!current) {
    return { plan, changed: [], message: 'That object no longer exists.' };
  }
  const rebuilt = regenerateObject(current, plan.seed, options);
  return {
    plan: {
      ...plan,
      objects: plan.objects.map((object) => (object.id === objectId ? rebuilt : object)),
      updatedAt: new Date().toISOString(),
    },
    changed: [rebuilt],
    message: `Regenerated “${current.name}”.`,
  };
}
