import { boundsOf, type MeshBounds, type MeshBuilder, type MeshData } from './mesh';

/**
 * Real-world scale.
 *
 * The single most common failure of generated 3D is wrong size: a door at four
 * metres, a horse the size of a dog, a castle wall you could step over. Every
 * number here is a measured reference in metres, and the builders in
 * `components/` work in those units directly — then `normalize` corrects a model
 * to the footprint a world plan asked for, rather than the other way round.
 *
 * Everything is metric and Y-up, matching three.js and the WorldPlan transforms.
 */

/** Measured reference dimensions in metres: [length (x), height (y), depth (z)]. */
export const REFERENCE: Record<string, [number, number, number]> = {
  /* people and openings — the modules everything else is measured against */
  person: [0.5, 1.75, 0.3],
  door: [0.95, 2.1, 0.08],
  'door-double': [1.9, 2.4, 0.08],
  'gate-castle': [3.4, 4.6, 0.6],
  window: [1.1, 1.3, 0.12],
  'window-arched': [0.9, 1.8, 0.12],
  storey: [1, 3, 1],
  'step-rise': [0.3, 0.17, 0.28],
  'wall-thickness': [0.45, 1, 0.45],
  'parapet-height': [1, 1.1, 0.4],
  'railing-height': [1, 0.95, 0.08],
  'counter-height': [1, 0.9, 0.6],

  /* houses and fortifications */
  'house-small': [6, 4, 5],
  'house-medium': [9, 5.5, 7],
  'house-large': [13, 7, 10],
  'house-tower': [6, 11, 6],
  barn: [12, 7, 8],
  hut: [4, 3, 4],
  'castle-keep': [16, 22, 16],
  'castle-tower-round': [7, 16, 7],
  'castle-tower-square': [8, 18, 8],
  'curtain-wall': [12, 8, 3],
  gatehouse: [14, 14, 8],
  watchtower: [4, 9, 4],
  windmill: [8, 14, 8],
  watermill: [10, 7, 7],
  church: [22, 16, 12],
  minaret: [4, 24, 4],
  kasbah: [20, 12, 20],
  ruin: [8, 4, 6],
  well: [1.6, 1.1, 1.6],
  fountain: [3.4, 1.6, 3.4],

  /* nature */
  'tree-pine': [5, 22, 5],
  'tree-oak': [12, 18, 12],
  'tree-palm': [4, 12, 4],
  'tree-birch': [5, 15, 5],
  'tree-olive': [7, 6, 7],
  'tree-dead': [6, 9, 6],
  bush: [1.6, 1.2, 1.6],
  cactus: [1, 3.4, 1],
  'boulder-large': [3.4, 2.4, 3],
  boulder: [1.6, 1.2, 1.4],
  rock: [0.8, 0.5, 0.7],
  stump: [0.9, 0.7, 0.9],
  'log-fallen': [6, 0.7, 0.7],
  reeds: [1, 1.6, 1],
  mushroom: [0.3, 0.25, 0.3],

  /* geology, measured across × high × deep */
  'cliff-face': [8, 12, 4],
  'scree-slope': [9, 3, 7],
  'boulder-field': [22, 3, 18],
  'cave-mouth': [10, 6, 12],
  'rock-arch': [7, 3.5, 3],
  'stepping-stones': [2, 0.4, 8],
  cairn: [1.2, 1.8, 1.2],
  menhir: [1.2, 3.5, 0.7],
  hoodoo: [2.6, 6, 2.6],
  'rock-pillar': [1.6, 4.5, 1.4],
  tor: [4, 5, 4],
  stalactite: [0.6, 1.8, 0.6],
  stalagmite: [0.5, 1.4, 0.5],

  /* animals, measured at the withers and nose to tail */
  horse: [2.4, 1.6, 0.8],
  camel: [2.8, 2.1, 0.9],
  cow: [2.2, 1.4, 0.8],
  bull: [2.5, 1.6, 0.9],
  sheep: [1.3, 0.8, 0.55],
  goat: [1.2, 0.8, 0.5],
  dog: [0.9, 0.55, 0.3],
  cat: [0.5, 0.28, 0.18],
  deer: [1.7, 1.2, 0.5],
  gazelle: [1.3, 0.9, 0.45],
  wolf: [1.4, 0.85, 0.4],
  lion: [2, 1.1, 0.6],
  fox: [0.9, 0.4, 0.25],
  rabbit: [0.4, 0.22, 0.15],
  chicken: [0.4, 0.4, 0.25],
  duck: [0.5, 0.35, 0.2],
  eagle: [0.9, 0.4, 0.3],
  crow: [0.45, 0.25, 0.18],
  fish: [0.6, 0.25, 0.12],
  dragon: [8, 4, 2.4],

  /* furniture */
  chair: [0.5, 0.95, 0.5],
  stool: [0.4, 0.45, 0.4],
  'table-dining': [1.8, 0.76, 0.9],
  'table-round': [1.2, 0.75, 1.2],
  bench: [1.6, 0.85, 0.5],
  bed: [2, 0.6, 1.5],
  wardrobe: [1.2, 2, 0.6],
  chest: [0.9, 0.55, 0.5],
  shelf: [1, 1.8, 0.35],
  barrel: [0.6, 0.95, 0.6],
  crate: [0.7, 0.7, 0.7],
  basket: [0.45, 0.35, 0.45],
  cauldron: [0.7, 0.6, 0.7],
  amphora: [0.45, 1, 0.45],
  lantern: [0.25, 0.5, 0.25],
  brazier: [0.7, 1, 0.7],
  loom: [1.6, 1.7, 1],
  'mill-stone': [1.6, 0.4, 1.6],
  throne: [1.1, 1.9, 1],
  bookshelf: [1.2, 2.2, 0.4],
  anvil: [0.7, 0.55, 0.3],
  forge: [1.6, 1.2, 1],
  'market-stall': [3, 2.4, 2],
  cart: [3.2, 1.4, 1.7],
  wagon: [4.5, 2, 2],
  sledge: [2.4, 0.8, 1.2],
  boat: [5, 1.4, 1.8],
  'ship-sailing': [16, 12, 5],
  carriage: [3.6, 2.4, 1.8],
  excavator: [7, 3.4, 2.8],
  'mine-cart': [1.4, 1, 1],

  /* weapons and gear */
  sword: [0.12, 1, 0.04],
  'sword-great': [0.16, 1.5, 0.05],
  dagger: [0.09, 0.35, 0.03],
  axe: [0.3, 0.9, 0.05],
  'axe-battle': [0.4, 1.2, 0.06],
  pickaxe: [0.35, 1, 0.06],
  spear: [0.1, 2.3, 0.1],
  lance: [0.1, 3.2, 0.1],
  bow: [0.2, 1.7, 0.1],
  'shield-round': [0.85, 0.85, 0.1],
  'shield-kite': [0.6, 1.1, 0.1],
  helmet: [0.25, 0.3, 0.3],
  'armor-plate': [0.55, 1.1, 0.35],
  quiver: [0.2, 0.8, 0.2],
  mace: [0.2, 0.8, 0.2],
  hammer: [0.25, 0.9, 0.25],
  crossbow: [0.6, 0.3, 0.7],
  cannon: [0.8, 0.8, 2],
  trebuchet: [6, 7, 3],
  banner: [1.2, 2.2, 0.05],

  /* fantasy */
  'crystal-shard': [0.7, 2.2, 0.7],
  'crystal-cluster': [2.2, 2.6, 2],
  'obelisk-arcane': [1.4, 5, 1.4],
  'portal-ring': [3.4, 4, 0.5],
  'floating-island': [8, 5, 8],
  'dragon-egg': [0.7, 0.9, 0.7],
  'rune-stone': [1.2, 2.2, 0.4],
  totem: [1.2, 4, 1.2],
  'mushroom-giant': [3, 5, 3],
  'magic-orb': [0.5, 0.5, 0.5],
  staff: [0.15, 1.9, 0.15],
  gravestone: [0.7, 1.1, 0.15],
  sarcophagus: [2.1, 1, 0.9],
  statue: [1.2, 2.6, 0.9],

  /* environmental props */
  'fence-post': [0.12, 1.2, 0.12],
  'fence-panel': [2.4, 1.1, 0.1],
  'gate-wood': [3, 1.6, 0.12],
  signpost: [0.15, 2.2, 0.15],
  ladder: [0.5, 4, 0.15],
  'scaffold-section': [3, 3, 1.5],
  bridge: [12, 3.5, 4],
  'bridge-stone': [16, 5, 5],
  aqueduct: [20, 12, 4],
  dock: [8, 1.2, 3],
  'street-lamp': [0.4, 4.2, 0.4],
  'tent-small': [2.6, 1.8, 2.6],
  'tent-large': [5, 3, 5],
  campfire: [1.2, 0.5, 1.2],
  haystack: [2.4, 2, 2.4],
  'crop-row': [3, 0.9, 1],
  scarecrow: [1, 1.9, 0.4],
  'water-wheel': [4, 4, 1],
  'mine-entrance': [2.6, 2.6, 1.4],
  'ruin-column': [1, 5, 1],
  'arch-ruin': [5, 5, 1.2],
};

export type ReferenceKey = keyof typeof REFERENCE | (string & {});

/** Reference size for a named object kind, or `null` when unknown. */
export function referenceSize(key: string): [number, number, number] | null {
  return REFERENCE[key] ?? null;
}

/**
 * Height of an average person, in metres.
 *
 * Everything architectural is judged against this: a door must clear it, a
 * parapet must reach a standing eye's chest, a chair seat must sit below it.
 */
export const HUMAN_HEIGHT = 1.75;
export const DOOR_HEIGHT = 2.1;
export const STOREY_HEIGHT = 3;
export const WALL_THICKNESS = 0.45;
export const PARAPET_HEIGHT = 1.1;

export interface NormalizeOptions {
  /** Match this dimension; 'max' keeps proportions inside a bounding box. */
  by?: 'height' | 'length' | 'depth' | 'footprint' | 'max';
  /** Target size in metres. */
  target: number;
  /** Clamp the correction so a bad target cannot distort beyond reason. */
  maxFactor?: number;
}

export interface NormalizeResult {
  factor: number;
  bounds: MeshBounds;
}

/**
 * Uniformly scales a builder so its real size matches a target.
 *
 * Uniform only, deliberately: non-uniform scaling stretches normals and turns a
 * modeled sword into a bent one. When a plan asks for a 12 m house and the
 * generator produced 9 m, the whole house grows — proportions are the design.
 */
export function normalize(builder: MeshBuilder, options: NormalizeOptions): NormalizeResult {
  const before = boundsOf(builder.build());
  const measured = measure(before, options.by ?? 'max');
  const factor = measured > 1e-6 ? options.target / measured : 1;
  const clamped = clampFactor(factor, options.maxFactor ?? 6);
  if (Math.abs(clamped - 1) > 1e-6) builder.scale(clamped);
  return { factor: clamped, bounds: boundsOf(builder.build()) };
}

export function measure(bounds: MeshBounds, by: 'height' | 'length' | 'depth' | 'footprint' | 'max'): number {
  switch (by) {
    case 'height': return bounds.size[1];
    case 'length': return bounds.size[0];
    case 'depth': return bounds.size[2];
    case 'footprint': return Math.max(bounds.size[0], bounds.size[2]);
    case 'max': return Math.max(bounds.size[0], bounds.size[1], bounds.size[2]);
  }
}

function clampFactor(factor: number, maxFactor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(maxFactor, Math.max(1 / maxFactor, factor));
}

/**
 * Seats a model on the ground plane and centres it over its own origin.
 *
 * Every asset in a world plan is placed by its base, so a model whose geometry
 * starts at y = −0.4 would sink into the terrain and a model offset to +x would
 * lean out of its footprint. This is applied at the end of every component.
 */
export function seatOnGround(builder: MeshBuilder, centerHorizontally = true): MeshBounds {
  const bounds = boundsOf(builder.build());
  builder.translate(
    centerHorizontally ? -bounds.center[0] : 0,
    -bounds.min[1],
    centerHorizontally ? -bounds.center[2] : 0,
  );
  return boundsOf(builder.build());
}

/**
 * Brings a component to the height it was asked for and seats it on the ground.
 *
 * Every generator ends with this, because a model whose real height drifted from
 * its requested height is a model whose footprint, collision box and scale
 * warning are all wrong. The correction is uniform and clamped: a generator that
 * overshot by a factor of nine has a bug, and `maxFactor` keeps that bug from
 * being hidden by shrinking the asset to a speck.
 *
 * `center` is false for anything deliberately off-axis — a trunk buttressed on
 * one side, a palm leaning into the wind — where centring on the bounding box
 * would undo the lean the generator just built.
 */
export function fitHeight(builder: MeshBuilder, height: number, maxFactor = 2, center = true): void {
  normalize(builder, { by: 'height', target: Math.max(0.02, height), maxFactor });
  seatOnGround(builder, center);
}

/** Recentres on X and Z without touching the base height. */
export function centerHorizontally(builder: MeshBuilder): void {
  const bounds = boundsOf(builder.build());
  builder.translate(-bounds.center[0], 0, -bounds.center[2]);
}

/**
 * The footprint a world plan should record for a finished model.
 *
 * Placement and collision both read `meta.dimensions`, so this keeps a richly
 * modeled asset from claiming a box it does not occupy.
 */
export function dimensionsOf(data: MeshData): [number, number, number] {
  const bounds = boundsOf(data);
  return [
    Math.max(0.05, round(bounds.size[0], 3)),
    Math.max(0.05, round(bounds.size[1], 3)),
    Math.max(0.05, round(bounds.size[2], 3)),
  ];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Sanity check against real-world scale.
 *
 * Returns a short, honest description of anything implausible — a 40 m chair, a
 * 5 cm castle — so the pipeline can report it instead of silently placing it.
 */
export function scaleWarnings(kind: string, data: MeshData): string[] {
  const bounds = boundsOf(data);
  const reference = referenceSize(kind);
  const warnings: string[] = [];
  const tallest = bounds.size[1];
  if (tallest > 400) warnings.push(`${kind} is ${Math.round(tallest)} m tall, above the 400 m sanity limit`);
  if (tallest < 0.02) warnings.push(`${kind} is under 2 cm tall`);
  if (reference) {
    const ratio = tallest / Math.max(0.001, reference[1]);
    if (ratio > 4 || ratio < 0.25) {
      warnings.push(`${kind} is ${ratio.toFixed(1)}× its reference height of ${reference[1]} m`);
    }
  }
  return warnings;
}
