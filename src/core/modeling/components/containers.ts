import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { box, cylinder, extrude, lathe, sphere, torus } from '../primitives';
import {
  BEVELLED_BOX_TRIANGLES, BOX_TRIANGLES, componentBudget, cylinderCost,
  detailRng, displace, hoopBand, latheCost, planks, planChildren, scatter, settle, sphereCost,
  spike, torusCost, vessel, type Quality,
} from '../detail';
import { REFERENCE, seatOnGround } from '../scale';
import { chance, pick, range, type Rng } from '../../generation/rng';
import { cloth, clothCost, placeOn, postCost, prismCost, strut } from './common';

/**
 * Containers: the vessels a household keeps its life in.
 *
 * A cask, a crate, a basket, a cauldron and a jar are what a cellar, a store
 * room, a market stall and a kitchen are actually full of, and they are the props
 * a player walks up to and looks into. That last part is the design constraint,
 * and it gives this family its rules — the four in `props.ts` apply here
 * unchanged, and these are on top of them.
 *
 * 1. **A container is defined by its interior.** A cask with its head off has a
 *    wall that runs up the outside, over the chime and back down the inside,
 *    because somebody looks into it and sees the far wall of the thing. A closed
 *    cask is a solid and costs half as much, and which one a caller gets is the
 *    caller's choice, not the budget's.
 * 2. **The fastenings are where the use shows.** Hoops and their rivets, corner
 *    cleats, a rim binding, a bail: a container is held together against what is
 *    inside it and the fastenings are the record of that. They are also what a
 *    poor budget drops first, because the surface carries them at a distance.
 * 3. **What it holds is part of the asset.** Grain heaped, water level, bread in
 *    lumps, straw loose. An open cask that is empty and one that is full are
 *    different objects to a player, and the difference is one disc or one scatter.
 * 4. **Resting is a decision, not an accident.** A tapped cask lies on its side
 *    on two chocks, an amphora stands in a ring of clay because its foot is a
 *    point, a cauldron hangs from its bail. Each is placed the way it is used,
 *    and the bounding box stays honest about where that leaves it.
 *
 * Coordinates: metres, Y up, the base on y = 0, centred on X and Z — except a
 * cauldron hung from a hook, which is suspended and says so in its docstring.
 */

/* --------------------------------------------------------------- plumbing */

/** What a container is holding. */
export type Contents =
  | 'none'
  | 'grain'
  | 'salt'
  | 'water'
  | 'wine'
  | 'oil'
  | 'produce'
  | 'fish'
  | 'straw'
  | 'cloth'
  | 'pots'
  | 'tools'
  | 'coins'
  | 'stew'
  | 'gruel'
  | 'dye'
  | 'bread'
  | 'yarn'
  | 'eggs';

/** How a filling sits inside its vessel. */
type FillShape = 'level' | 'heap' | 'lumps' | 'straw' | 'drape';

/**
 * What each filling looks like.
 *
 * `level` is a flat disc at the fill line, `heap` a mound above it, `lumps` a
 * scatter of separate things, `straw` loose wisps and `drape` a folded sheet.
 * Surfaces are chosen to read at a glance rather than to be accurate: wine is
 * velvet because velvet is the darkest red in the registry, and gruel is sand
 * because sand is the palest thing that is not white.
 */
const FILLS: Record<Exclude<Contents, 'none'>, { surface: string; shape: FillShape; lumps?: number }> = {
  grain: { surface: 'sand', shape: 'heap' },
  salt: { surface: 'plaster-white', shape: 'heap' },
  water: { surface: 'glass', shape: 'level' },
  wine: { surface: 'velvet', shape: 'level' },
  oil: { surface: 'glass-warm', shape: 'level' },
  produce: { surface: 'foliage', shape: 'lumps', lumps: 7 },
  fish: { surface: 'scale-dark', shape: 'lumps', lumps: 5 },
  straw: { surface: 'thatch', shape: 'straw', lumps: 9 },
  cloth: { surface: 'fabric-linen', shape: 'drape' },
  pots: { surface: 'terracotta', shape: 'lumps', lumps: 4 },
  tools: { surface: 'iron-wrought', shape: 'lumps', lumps: 5 },
  coins: { surface: 'gold', shape: 'heap' },
  stew: { surface: 'soil', shape: 'level' },
  gruel: { surface: 'sand', shape: 'level' },
  dye: { surface: 'fabric-blue', shape: 'level' },
  bread: { surface: 'terracotta', shape: 'lumps', lumps: 5 },
  yarn: { surface: 'wool', shape: 'lumps', lumps: 4 },
  eggs: { surface: 'plaster-white', shape: 'lumps', lumps: 6 },
};

/** The surface a filling is sold in, for a caller that needs the straw only. */
export function contentsSurface(contents: Contents): string {
  return contents === 'none' ? 'thatch' : FILLS[contents].surface;
}

/** How smooth a filling is turned, by what is left of the budget. */
function fillSegments(budget: number): number {
  return budget > 520 ? 14 : budget > 240 ? 10 : 7;
}

/** Triangles a filling costs, charged before it is built. */
function fillCost(shape: FillShape, lumps: number, segments: number): number {
  switch (shape) {
    case 'level': return latheCost(2, segments);
    case 'heap': return sphereCost(segments, Math.max(3, Math.round(segments / 2)));
    case 'drape': return clothCost(3, 3);
    case 'straw': return lumps * prismCost(4, true);
    default: return lumps * sphereCost(5, 3);
  }
}

/**
 * What is inside a vessel, built flat on y = 0 and centred, for the caller to
 * drop to its own fill line.
 *
 * `null` when the vessel is empty or cannot afford the filling, so a caller never
 * has to guess whether the contents were built.
 */
function filling(
  radius: number,
  contents: Contents,
  rng: Rng,
  seed: number,
  budget: number,
): { part: MeshBuilder; surface: string; cost: number } | null {
  if (contents === 'none') return null;
  const fill = FILLS[contents];
  const r = Math.max(0.02, radius);
  const segments = fillSegments(budget);
  const wanted = Math.max(3, Math.round(fill.lumps ?? 6));
  // Charged before anything is built, so a vessel that cannot afford its contents
  // is empty rather than over budget.
  const cost = fillCost(fill.shape, wanted, segments);
  if (cost > budget) return null;
  const part = new MeshBuilder();

  if (fill.shape === 'level') {
    // A liquid finds its own level, so it is one disc and nothing else, wound rim
    // to centre so the normal faces up and the surface catches the light.
    part.add(lathe([[r, 0], [0, 0]], { segments }), undefined, fill.surface);
    return { part, surface: fill.surface, cost: latheCost(2, segments) };
  }
  if (fill.shape === 'heap') {
    const mound = sphere(r, {
      radii: [r, r * (contents === 'coins' ? 0.16 : 0.34), r],
      widthSegments: segments,
      heightSegments: Math.max(3, Math.round(segments / 2)),
      phiLength: Math.PI / 2,
    });
    // Grain is shovelled, not turned: it stands at its angle of repose with
    // hollows where the shovel went in.
    if (budget > 260) displace(mound, { amplitude: r * 0.1, frequency: 5, octaves: 2, seed: seed + 3 });
    mound.flatShade();
    part.add(mound, undefined, fill.surface);
    return { part, surface: fill.surface, cost: sphereCost(segments, Math.max(3, Math.round(segments / 2))) };
  }
  if (fill.shape === 'drape') {
    const sheet = cloth(r * 1.9, r * 1.9, 3, 3, (u, v) => r * 0.16 * Math.sin(u * Math.PI * 2) * Math.cos(v * Math.PI));
    part.add(sheet, undefined, fill.surface);
    return { part, surface: fill.surface, cost: clothCost(3, 3) };
  }

  const each = fill.shape === 'straw' ? prismCost(4, true) : sphereCost(5, 3);
  const planned = planChildren(wanted, each, budget);
  if (planned.modeled < 1) return null;
  const spots = scatter(rng, planned.modeled, r * 1.5, r * 1.5, 0.7);
  for (let index = 0; index < spots.length; index += 1) {
    const spot = spots[index]!;
    const reach = Math.hypot(spot[0], spot[1]);
    // Pulled in from the wall: a lump that touches the vessel reads as a lump
    // stuck to it, and one that has settled against the wall is out of bounds.
    const scale = reach > r * 0.8 ? (r * 0.8) / reach : 1;
    const lump = fill.shape === 'straw'
      ? spike({ height: r * range(rng, 0.8, 1.7), radius: r * 0.05, sides: 4 })
      : sphere(r * 0.2, {
        radii: [r * range(rng, 0.17, 0.24), r * (contents === 'eggs' ? 0.24 : 0.17), r * range(rng, 0.15, 0.21)],
        widthSegments: 5,
        heightSegments: 3,
      });
    lump.rotateZ(range(rng, -1.3, 1.3));
    settle(lump, rng, [spot[0] * scale, 0, spot[1] * scale], r * 0.03);
    part.add(lump, undefined, fill.surface);
  }
  return { part, surface: fill.surface, cost: planned.modeled * each };
}

/**
 * Pulls every other vertex column of a turned wall inward by a hair, so the seams
 * between staves, or between the stakes of a weave, catch a shadow.
 *
 * Displacement rather than separate boards: a cask built from twelve boards costs
 * twelve bevelled boxes, and the same cask built from one turned wall with its
 * seams pushed in costs one wall.
 */
function seams(builder: MeshBuilder, count: number, radius: number, depth = 0.022): void {
  const lobes = Math.max(3, Math.round(count));
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const angle = Math.atan2(point[2], point[0]);
    if (Math.cos(angle * lobes) <= 0.86) continue;
    const normal = builder.normalAt(index);
    const amount = -radius * depth;
    builder.setPosition(index, [
      point[0] + normal[0] * amount,
      point[1],
      point[2] + normal[2] * amount,
    ]);
  }
  builder.computeNormals();
}

/** Triangles a `spigot` costs: a plugged hole and a lever to turn it. */
const SPIGOT_TRIANGLES = cylinderCost(6, true) + BEVELLED_BOX_TRIANGLES;

/**
 * A wooden spigot through a wall: a tapered plug from `from` to `to` and a lever
 * standing off it.
 *
 * Aimed by its two ends rather than by a height, because a tapped cask lies on its
 * side and a spigot that only knows how to point along +Z is a spigot that only
 * works on a cask that is standing up.
 */
function spigot(from: Vec3, to: Vec3, size: number, surface: string): MeshBuilder {
  const part = new MeshBuilder();
  part.add(strut(from, to, size, 6, true), undefined, surface);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.max(1e-4, Math.hypot(dx, dy, dz));
  const lever = box(size * 0.5, size * 2.8, size * 0.5, { bevel: size * 0.14, bevelSegments: 1 });
  lever.translate(
    to[0] + (dx / length) * size * 0.7,
    to[1] + (dy / length) * size * 0.7 + size * 1.2,
    to[2] + (dz / length) * size * 0.7,
  );
  part.add(lever, undefined, surface);
  return part;
}

/** Triangles a wedge costs: a triangle extruded, which is two caps and three sides. */
const WEDGE_TRIANGLES = 8;

/**
 * Triangles one swept ear handle costs, measured.
 *
 * `vessel` sweeps a four-point path resampled three times, which is thirteen
 * stations, and each station carries the section's seven points: an amphora turned
 * at any resolution costs 264 for its body and 364 more for its two handles.
 */
const EAR_HANDLE_TRIANGLES = 2 * 7 * 13;

/** A wedge standing on its wide face, centred on the origin, sloping up to −X. */
function wedge(width: number, height: number, depth: number): MeshBuilder {
  const shape = extrude(
    [
      [-width / 2, 0],
      [width / 2, 0],
      [-width / 2, height],
    ],
    { depth },
  );
  shape.translate(0, 0, -depth / 2);
  return shape;
}

/** Triangles a ring of woven or hooped band costs. */
function ringCost(radial: number, tubular: number): number {
  return torusCost(radial, tubular);
}

/* ------------------------------------------------------------------ cask */

export type BarrelHead = 'closed' | 'open' | 'lid';
export type BarrelRest = 'upright' | 'side' | 'chocked';
export type BarrelWood = 'oak' | 'pine' | 'weathered' | 'painted';

export interface BarrelOptions {
  /** Widest radius of the belly, in metres. */
  radius?: number;
  /** Height of the cask standing upright. */
  height?: number;
  /** How much wider the belly is than the heads. */
  bilge?: number;
  /** `closed` is a solid; `open` is a hollow wall a caller can look into. */
  head?: BarrelHead;
  rest?: BarrelRest;
  /** Only built when the head is off and the cask is upright. */
  contents?: Contents;
  /** A spigot through the wall, where the cask is tapped. */
  tap?: boolean;
  staves?: number;
  hoops?: number;
  wood?: BarrelWood;
  /** 0 is a new cask; 1 has been rolled across a thousand decks. */
  wear?: number;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

const CASK_WOOD: Record<BarrelWood, string> = {
  oak: 'wood-oak',
  pine: 'wood-pine',
  weathered: 'wood-weathered',
  painted: 'wood-painted',
};

/**
 * A cask: staved, bilged, hooped, and resting the way it is being used.
 *
 * The bilge is not decoration. A cask is wider in the belly than at its heads so
 * that it can be rolled, pivoting on its own belly, and so that its hoops can be
 * driven on tight while the wood is dry. Everything else follows from what the
 * cask is doing: a closed one is a solid turned wall and an open one runs back
 * down inside itself so a caller looking in sees the far wall; a tapped one lies
 * on its side on two chocks with the spigot at the lowest point of the belly; a
 * worn one has rusted hoops and a wall that has been knocked about.
 *
 * `height` is the height of the upright cask. On its side the cask is as tall as
 * it is wide and as long as it was tall, which is what a caller placing it
 * against a cellar wall needs to know.
 */
export function barrel(options: BarrelOptions): MeshBuilder {
  const seed = options.seed ?? 307;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const budget = componentBudget(options.quality, options.budget);
  const radius = Math.max(0.08, options.radius ?? 0.3);
  const height = Math.max(radius * 1.3, options.height ?? radius * 3.15);
  const bilge = Math.max(0, Math.min(0.4, options.bilge ?? 0.14));
  const wear = Math.max(0, Math.min(1, options.wear ?? range(rng, 0.15, 0.6)));
  const head = options.head ?? 'closed';
  const rest = options.rest ?? 'upright';
  const wood = options.wood ?? (wear > 0.72 ? 'weathered' : 'oak');
  const surface = CASK_WOOD[wood];
  const hoopSurface = wear > 0.5 ? 'iron-rusted' : 'iron-wrought';
  const lying = rest !== 'upright';
  let spent = 0;

  // The heads are narrower than the belly by exactly the bilge, so `radius` is
  // the widest the cask gets and a caller can place it against a wall.
  const headRadius = radius / (1 + bilge);
  const wall = Math.max(0.01, radius * 0.075);
  /** Outside radius of the wall at a fraction of the cask's height. */
  const at = (t: number): number => headRadius * (1 + bilge * Math.sin(Math.PI * Math.min(1, Math.max(0, t))));

  const staves = Math.max(6, Math.round(options.staves ?? (budget > 1600 ? 14 : budget > 900 ? 12 : budget > 460 ? 10 : 8)));
  const stations = budget > 700 ? 9 : 7;
  const segments = staves * 2;

  const profile: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    profile.push([at(t), t * height]);
  }
  if (head === 'closed') {
    // A closed cask is a solid: the head is one disc and the inside is never seen,
    // so the inside is never built.
    profile.push([0, height]);
  } else {
    // Up the outside, over the chime and back down the inside to a floor one wall
    // thick. This is the difference between a vessel and a drum with a lid on it.
    profile.push([at(1) - wall * 0.4, height]);
    profile.push([at(1) - wall, height - wall * 0.8]);
    for (let index = stations - 1; index >= 1; index -= 1) {
      const t = index / stations;
      profile.push([Math.max(wall * 0.6, at(t) - wall), t * height]);
    }
    profile.push([Math.max(wall * 0.6, at(0) - wall), wall]);
    profile.push([0, wall * 0.85]);
  }

  const shell = lathe(profile, { segments });
  seams(shell, staves, radius);
  if (wear > 0.42) {
    // Knocked about: dents along the belly, faded out at the chimes so the cask
    // still stands on a flat end.
    displace(shell, { amplitude: radius * 0.014 * wear, frequency: 5.5, octaves: 2, seed: seed + 11, preserveBase: true });
    shell.flatShade();
  }
  builder.add(shell, undefined, surface);
  spent += latheCost(profile.length, segments);

  // Hoops, driven on from the ends: each sits at the radius the wall actually has
  // at its own height, so none of them float off the belly or bite into it.
  const hoopCount = Math.max(2, Math.min(5, Math.round(options.hoops ?? (budget > 1400 ? 4 : budget > 620 ? 3 : 2))));
  const hoopTube = Math.max(0.008, radius * 0.045);
  const rivets = budget > 1200 && wear < 0.8 ? 6 : 0;
  for (let index = 0; index < hoopCount; index += 1) {
    const t = 0.12 + (index / Math.max(1, hoopCount - 1)) * 0.76;
    const band = hoopBand({
      radius: at(t),
      tube: hoopTube,
      width: height * (budget > 900 ? 0.055 : 0.075),
      rivets,
      seed: seed + index * 5,
    });
    band.rotateY(range(rng, -0.02, 0.02));
    band.translate(0, t * height, 0);
    builder.add(band, undefined, hoopSurface);
    spent += cylinderCost(14, false) + rivets * sphereCost(5, 3);
  }

  if (head === 'lid' && budget - spent > latheCost(3, 10)) {
    // A loose lid, resting askew because it was lifted and put back by hand.
    const lidRadius = Math.max(wall * 2, at(1) - wall * 0.4);
    const lidSegments = Math.max(8, Math.round(segments * 0.7));
    const lid = lathe([[lidRadius, 0], [lidRadius * 0.55, wall * 0.5], [0, wall * 0.7]], { segments: lidSegments });
    lid.rotateZ(range(rng, -0.05, 0.05));
    lid.translate(range(rng, -wall * 0.6, wall * 0.6), height + wall * 0.2, range(rng, -wall * 0.6, wall * 0.6));
    builder.add(lid, undefined, surface);
    spent += latheCost(3, lidSegments);
  }

  if (lying) {
    // Rolled onto its belly: the axis lies along X and +Z still faces the person
    // drawing from it, because the turn is about Z and leaves Z alone. The cask is
    // then as long as it was tall and as tall as it is wide.
    builder.rotateZ(-Math.PI / 2);
    builder.translate(-height / 2, radius, 0);
  }

  /** Wall radius at a station along the cask's own axis, upright or on its side. */
  const wallAt = (along: number): number => at((along + (lying ? height / 2 : 0)) / (lying ? height : height));
  const tapped = options.tap ?? rest === 'chocked';
  if (tapped && budget - spent > SPIGOT_TRIANGLES) {
    const size = Math.max(0.014, radius * 0.07);
    if (!lying) {
      const t = 0.24;
      const reach = at(t);
      builder.add(
        spigot([0, t * height, reach - wall * 1.4], [0, t * height, reach + size * 2.4], size, 'wood-dark'),
      );
    } else {
      // On its side the wall at a station is a circle about (y = radius, z = 0),
      // and the spigot goes in low enough to put a jug under.
      const along = height * 0.08;
      const reach = wallAt(along);
      const y = radius * 0.44;
      const out = Math.sqrt(Math.max(reach * reach * 0.04, reach * reach - (y - radius) * (y - radius)));
      builder.add(spigot([along, y, out * 0.5], [along, y, out + size * 2.4], size, 'wood-dark'));
    }
    spent += SPIGOT_TRIANGLES;
  }

  if (rest === 'chocked' && budget - spent > 2 * WEDGE_TRIANGLES) {
    // Two wedges, one either side of the belly, sloping in under it: the only
    // thing between a tapped cask and rolling across the cellar floor.
    for (const side of [-1, 1] as const) {
      const along = side * height * 0.27;
      const gap = Math.max(0.012, radius - wallAt(along));
      const chock = wedge(0.19, gap + 0.014, Math.max(0.14, radius * 0.72));
      if (side > 0) chock.mirror('x');
      chock.translate(along, 0, 0);
      builder.add(chock, undefined, 'wood-dark');
      spent += WEDGE_TRIANGLES;
    }
  }

  if (!lying && head !== 'closed' && options.contents && options.contents !== 'none') {
    const room = Math.max(0.03, at(0.5) - wall * 1.7);
    const fill = filling(room, options.contents, rng, seed + 29, Math.max(0, budget - spent));
    if (fill) {
      // Filled to somewhere between a third and three fifths: a cask full to the
      // brim has just been opened, and one that is nearly out is on its side.
      fill.part.translate(0, wall + height * range(rng, 0.3, 0.6), 0);
      builder.add(fill.part);
      spent += fill.cost;
    }
  }

  seatOnGround(builder, false);
  return builder;
}

/* ----------------------------------------------------------------- crate */

export type CrateStyle = 'slatted' | 'boarded' | 'reinforced';
export type CrateLid = 'closed' | 'open' | 'prised';

export interface CrateOptions {
  /** Overall width, including its corner cleats. */
  width?: number;
  /** Overall height with the lid shut. A prised lid stands proud of it. */
  height?: number;
  depth?: number;
  style?: CrateStyle;
  lid?: CrateLid;
  /** Only visible when the lid is open or prised. */
  contents?: Contents;
  /** A painted ownership mark on the front, where a stencilled one would be. */
  marked?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

/**
 * A crate: boards nailed between corner cleats, with a shadow gap between them.
 *
 * The gaps are the read. A closed box with a wood texture on it is a piece of
 * furniture; the same box with a shadow line every fourteen centimetres, its
 * boards inset between four corner cleats and its lid levered half off, is a
 * thing that was packed, shipped and opened. Slats are cheaper than boards for
 * the reason they are cheaper in life — less timber — so a poor crate is a
 * slatted crate, a middling one is boarded, and a rich one is boarded and
 * strapped in iron because it is going somewhere it will be dropped.
 */
export function crate(options: CrateOptions): MeshBuilder {
  const seed = options.seed ?? 311;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const budget = componentBudget(options.quality, options.budget);
  const width = Math.max(0.16, options.width ?? 0.7);
  const depth = Math.max(0.16, options.depth ?? 0.7);
  const height = Math.max(0.14, options.height ?? 0.7);
  const style = options.style ?? (budget > 1400 ? 'reinforced' : budget > 560 ? 'boarded' : 'slatted');
  const lid = options.lid ?? 'closed';
  const wood = budget > 900 && style !== 'slatted' ? 'wood-pine' : 'wood-weathered';
  let spent = 0;

  const cleat = Math.max(0.02, Math.min(width, depth, height) * 0.09);
  const board = cleat * 0.62;
  const gap = style === 'slatted' ? board * 0.62 : board * 0.2;
  // Boards butt against the inside of the corner cleats, a hair short of touching
  // so no two faces meet exactly coplanar, and they run the full span on the two
  // broad faces and between the cleats on the two narrow ones, so no two boards
  // meet in the same plane at a corner.
  const innerWidth = width - cleat * 1.95;
  const innerDepth = depth - cleat * 1.95;
  // Boards are what the budget buys, and the four corner cleats are paid for out of
  // it first: a crate that can only afford one cleat is not a cheaper crate, it is a
  // broken one. A cheap crate is a few wide boards with their arrises left square, a
  // rich one is many narrow boards each chamfered so the shadow gap between them
  // reads at a distance. The crate never gets smaller, only coarser, and the price
  // charged for a board is the price of the board that is actually built.
  const bevel = budget > 700 ? board * 0.22 : 0;
  const boardCost = bevel > 0 ? BEVELLED_BOX_TRIANGLES : BOX_TRIANGLES;
  // Four walls and two decks share what is left, each at its own count.
  const perFace = Math.max(2, Math.floor(Math.max(0, budget - 4 * boardCost) / (6 * boardCost)));
  const rows = (span: number): number => Math.max(2, Math.min(perFace, Math.round(span / 0.085)));

  for (const face of [0, 1, 2, 3] as const) {
    const broad = face < 2;
    const span = broad ? innerWidth : innerDepth;
    const count = rows(height);
    const panel = planks({
      width: span,
      height,
      thickness: board,
      count,
      horizontal: true,
      gap,
      seed: seed + face * 3,
      bevel,
    });
    if (!broad) panel.rotateY(Math.PI / 2);
    // Inset behind the cleats: a crate's boards are nailed to something, and the
    // something is proud of them.
    const inset = (broad ? depth : width) / 2 - cleat * 0.9;
    panel.translate(broad ? 0 : (face === 2 ? inset : -inset), height / 2, broad ? (face === 0 ? inset : -inset) : 0);
    builder.add(panel, undefined, wood);
    spent += count * boardCost;
  }

  // A floor always, and a lid unless the crate has been opened and left open.
  const decks: [boolean, number][] = [[true, board / 2]];
  if (lid !== 'open') decks.push([false, height - board / 2]);
  const deckRows = rows(innerDepth);
  for (const [isFloor, y] of decks) {
    const deck = planks({
      width: innerWidth,
      height: innerDepth,
      thickness: board,
      count: deckRows,
      horizontal: true,
      gap,
      seed: seed + (isFloor ? 23 : 17),
      bevel,
    });
    deck.rotateX(-Math.PI / 2);
    if (!isFloor && lid === 'prised') {
      // Levered up about the edge a crowbar went under, and left there.
      deck.translate(innerWidth / 2, 0, 0);
      deck.rotateZ(range(rng, 0.16, 0.27));
      deck.translate(-innerWidth / 2, height + cleat * 0.5, cleat * 0.2);
    } else {
      deck.translate(0, y, 0);
    }
    builder.add(deck, undefined, wood);
    spent += deckRows * boardCost;
  }

  // The cleats are what the boards are nailed to, so they are at the corners of the
  // crate's own box and stand proud of the boards: a cleat set on a circle inside
  // the box leaves the boards sticking out past it, and the crate is then narrower
  // than the width that was asked for. They are square arrised when the boards are,
  // because a cheap crate is cheap all over.
  const cleats = planChildren(4, boardCost, Math.max(0, budget - spent));
  for (let index = 0; index < cleats.modeled; index += 1) {
    const across = index < 2 ? -1 : 1;
    const along = index % 2 === 0 ? -1 : 1;
    const post = box(cleat, height * range(rng, 0.985, 1), cleat, { bevel, bevelSegments: 1 });
    post.translate(across * (width - cleat) / 2, height / 2, along * (depth - cleat) / 2);
    post.rotateY(range(rng, -0.006, 0.006));
    builder.add(post, undefined, 'wood-dark');
    spent += boardCost;
  }

  if (style === 'reinforced' && budget - spent > 8 * BOX_TRIANGLES) {
    // Iron strapping at a third and two thirds, which is what keeps a crate that
    // has been dropped twice from opening where it landed.
    for (const t of [0.3, 0.7] as const) {
      for (const face of [0, 1, 2, 3] as const) {
        const broad = face < 2;
        const strap = box(
          broad ? width + cleat * 0.1 : cleat * 0.42,
          cleat * 0.8,
          broad ? cleat * 0.42 : depth + cleat * 0.1,
        );
        const out = (broad ? depth : width) / 2 + cleat * 0.12;
        strap.translate(broad ? 0 : (face === 2 ? out : -out), height * t, broad ? (face === 0 ? out : -out) : 0);
        builder.add(strap, undefined, 'iron-rusted');
        spent += BOX_TRIANGLES;
      }
    }
  }

  if (options.marked && budget - spent > BOX_TRIANGLES) {
    // Where a stencilled mark would be: one board's worth of paint, laid on the
    // face of the front boards. The cleats stand proud of the boards, so a mark
    // placed at the crate's own face floats clear of the timber it is painted on.
    const stencil = box(width * range(rng, 0.28, 0.4), height * 0.2, 0.005);
    stencil.translate(
      width * range(rng, -0.1, 0.1),
      height * 0.56,
      depth / 2 - cleat * 0.9 + board / 2 + 0.004,
    );
    builder.add(stencil, undefined, 'paint');
    spent += BOX_TRIANGLES;
  }

  const contents = options.contents ?? 'none';
  if (contents !== 'none') {
    if (lid === 'closed') {
      // Straw poking out of a shut crate: the only way to tell what is in it
      // without opening it, and four wisps is enough to say it.
      const wisps = planChildren(4, prismCost(4, true), Math.max(0, budget - spent));
      for (let index = 0; index < wisps.modeled; index += 1) {
        const wisp = spike({ height: cleat * range(rng, 1.6, 3.4), radius: cleat * 0.12, sides: 4 });
        wisp.rotateZ(range(rng, -0.5, 0.5));
        wisp.rotateY(range(rng, 0, Math.PI * 2));
        wisp.translate(
          range(rng, -innerWidth * 0.34, innerWidth * 0.34),
          height - board * 0.4,
          range(rng, -innerDepth * 0.34, innerDepth * 0.34),
        );
        builder.add(wisp, undefined, contentsSurface(contents));
        spent += prismCost(4, true);
      }
    } else {
      const room = Math.min(innerWidth, innerDepth) / 2 - board;
      const fill = filling(room, contents, rng, seed + 41, Math.max(0, budget - spent));
      if (fill) {
        fill.part.translate(0, board, 0);
        builder.add(fill.part);
        spent += fill.cost;
      }
    }
  }

  seatOnGround(builder, false);
  return builder;
}

/* ---------------------------------------------------------------- basket */

export type BasketStyle = 'round' | 'trug' | 'creel' | 'market' | 'tall';
export type BasketHandle = 'none' | 'bail' | 'hoop' | 'strap';
export type BasketWeave = 'wicker' | 'reed' | 'rope' | 'split';

export interface BasketOptions {
  /** Rim radius, in metres. */
  radius?: number;
  /** Height of the rim above the ground. */
  height?: number;
  style?: BasketStyle;
  weave?: BasketWeave;
  handle?: BasketHandle;
  contents?: Contents;
  /** A lid of the same weave, for a creel or a market basket. */
  lid?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

const WEAVE_SURFACE: Record<BasketWeave, string> = {
  wicker: 'wattle',
  reed: 'reed',
  rope: 'rope',
  split: 'wood-pine',
};

/**
 * A basket: a weave over a frame of stakes, with a rim bound round it.
 *
 * Wicker is the cheapest container there is and the one that reads fastest,
 * because the weave is a texture anybody can name. The wall is turned as one
 * piece and its stakes are pushed in as shadows, then the wales — the horizontal
 * weavers — are laid on it as rings at the radius the wall actually has, so they
 * sit on the weave instead of floating off it. What the budget buys is how many
 * of those rings are solid geometry and how much of the weave the surface has to
 * carry on its own; the basket never gets smaller.
 *
 * A trug is oval, and is scaled after it is built, which is why its normals are
 * recomputed rather than scaled with it.
 */
export function basket(options: BasketOptions): MeshBuilder {
  const seed = options.seed ?? 313;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const budget = componentBudget(options.quality, options.budget);
  const style = options.style ?? pick(rng, ['round', 'trug', 'market', 'creel', 'tall'] as const, 'round');
  // Ratios of one basket: the reference table's, which is the basket a person
  // carries in one hand. `round` is that basket and the rest are relatives of it —
  // a trug is a shallow oval for garden work, a creel is a load carried on the
  // back and so is nearly twice as tall as it is wide.
  const proportions: Record<BasketStyle, { height: number; taper: number; handle: BasketHandle }> = {
    round: { height: 1, taper: 0.72, handle: 'none' },
    trug: { height: 0.6, taper: 0.86, handle: 'hoop' },
    market: { height: 0.9, taper: 0.8, handle: 'bail' },
    creel: { height: 1.8, taper: 0.66, handle: 'strap' },
    tall: { height: 1.35, taper: 0.78, handle: 'none' },
  };
  const shape = proportions[style];
  const reference = REFERENCE.basket ?? [0.45, 0.35, 0.45];
  const radius = Math.max(0.07, options.radius ?? reference[0]! / 2);
  // The table's basket is as tall as its own radius and a half, so that ratio is
  // what every style is scaled by; a caller that names a height gets that height.
  const height = Math.max(radius * 0.5, options.height ?? radius * (reference[1]! / (reference[0]! / 2)) * shape.height);
  const handle = options.handle ?? shape.handle;
  const weave = options.weave ?? (style === 'creel' ? 'rope' : 'wicker');
  const surface = WEAVE_SURFACE[weave];
  const wall = Math.max(0.006, radius * 0.07);
  let spent = 0;

  /** Outside radius of the weave at a fraction of the height. */
  const at = (t: number): number => radius * (shape.taper + (1 - shape.taper) * Math.min(1, Math.max(0, t)));

  // What the budget buys is how finely the weave is turned, never how big the
  // basket is: fewer stakes, fewer stations round the wall, and one column per
  // stake instead of two when the basket cannot afford both the weave and the rim
  // binding that holds it together.
  const stakes = budget > 1600 ? 18 : budget > 800 ? 14 : budget > 420 ? 12 : 10;
  const stations = budget > 620 ? 7 : 5;
  const segments = budget > 900 ? stakes * 2 : stakes;

  const profile: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    profile.push([at(t), t * height]);
  }
  // Over the rim and back down the inside: a basket is carried with something in
  // it and looked into from above more often than from anywhere else.
  profile.push([at(1) - wall * 0.35, height + wall * 0.2]);
  profile.push([at(1) - wall, height - wall * 0.6]);
  for (let index = stations - 1; index >= 1; index -= 1) {
    const t = index / stations;
    profile.push([Math.max(wall * 0.5, at(t) - wall), t * height]);
  }
  profile.push([Math.max(wall * 0.5, at(0) - wall), wall * 0.8]);
  profile.push([0, wall * 0.7]);

  const shell = lathe(profile, { segments });
  seams(shell, stakes, radius, 0.03);
  builder.add(shell, undefined, surface);
  spent += latheCost(profile.length, segments);

  const tubular = Math.max(8, Math.min(20, stakes));

  // The rim first, because it is the part that is handled and a split rim is a
  // basket that is finished: a weave that has spent the whole budget on itself and
  // has no binding round the top is not a cheaper basket, it is a broken one. A
  // `torus` lies in XZ already, so a ring round a basket needs no turning at all.
  const rimSegments = Math.max(10, Math.min(20, tubular));
  if (budget - spent >= ringCost(5, rimSegments)) {
    const rim = torus(at(1), wall * 0.85, { radialSegments: 5, tubularSegments: rimSegments });
    rim.translate(0, height + wall * 0.1, 0);
    builder.add(rim, undefined, 'wood-dark');
    spent += ringCost(5, rimSegments);
  }

  // Wales: the horizontal weavers, laid at the radius the wall has at their own
  // height so each one lies on the weave rather than hovering off it, and paid for
  // at the price of the ring that is actually built.
  const wales = planChildren(budget > 1200 ? 5 : budget > 520 ? 4 : 3, ringCost(4, tubular), Math.max(0, budget - spent));
  for (let index = 0; index < wales.modeled; index += 1) {
    const t = 0.14 + (index / Math.max(1, wales.modeled - 1)) * 0.74;
    const band = torus(at(t), wall * 0.42, { radialSegments: 4, tubularSegments: tubular });
    band.rotateY(range(rng, -0.05, 0.05));
    band.translate(0, t * height, 0);
    builder.add(band, undefined, surface === 'rope' ? 'rope' : 'wood-dark');
    spent += ringCost(4, tubular);
  }

  if (handle !== 'none' && budget - spent > ringCost(4, 12) + 2 * postCost(4)) {
    const grip = radius * (handle === 'hoop' ? 1.15 : 1.02);
    if (handle === 'strap') {
      // A creel is carried on the back, so its straps run down the outside rather
      // than over the top.
      for (const side of [-1, 1] as const) {
        const strap = strut(
          [side * at(0.9) * 0.9, height * 0.92, 0],
          [side * at(0.2) * 0.94, height * 0.06, 0],
          wall * 0.5,
          4,
        );
        builder.add(strap, undefined, 'leather');
        spent += cylinderCost(4, false);
      }
    } else {
      // A half arc sweeps through the XZ plane, so it is stood up on its ends and
      // then swung to whichever pair of lugs it hangs from. Hung on by hand, so it
      // is never quite square to the weave — the tilt is in its own plane, which is
      // how a bail leans when one side is hooked on and the other is not.
      const bail = torus(grip, wall * 0.5, { radialSegments: 4, tubularSegments: 14, arc: Math.PI });
      bail.rotateX(-Math.PI / 2);
      bail.rotateY(handle === 'hoop' ? 0 : Math.PI / 2);
      bail.rotateZ(range(rng, -0.06, 0.06));
      bail.translate(0, height + wall * 0.2, 0);
      builder.add(bail, undefined, handle === 'hoop' ? 'wood-dark' : 'iron-wrought');
      spent += ringCost(4, 14);
      for (const side of [-1, 1] as const) {
        const lug = cylinder(wall * 0.34, wall * 0.42, wall * 1.5, { radialSegments: 4 });
        const along = handle === 'hoop' ? [side * grip, 0] as const : [0, side * grip] as const;
        lug.translate(along[0], height + wall * 0.1, along[1]);
        builder.add(lug, undefined, 'iron-wrought');
        spent += cylinderCost(4, true);
      }
    }
  }

  if (options.lid && budget - spent > latheCost(3, 12) + ringCost(4, 12)) {
    // A lid of the same weave, domed so rain runs off it, and left slightly askew
    // because it is lifted a dozen times a day.
    const lidSegments = Math.max(10, Math.round(segments * 0.6));
    const lid = lathe(
      [
        [at(1) * 1.02, 0],
        [at(1) * 0.72, radius * 0.2],
        [0, radius * 0.28],
      ],
      { segments: lidSegments },
    );
    seams(lid, stakes, radius, 0.03);
    lid.rotateZ(range(rng, -0.05, 0.05));
    const top = height + wall * (handle === 'none' ? 0.4 : 1.1);
    lid.translate(range(rng, -wall, wall), top, range(rng, -wall, wall));
    builder.add(lid, undefined, surface);
    spent += latheCost(3, lidSegments);
  }

  const contents = options.contents ?? (options.lid ? 'none' : pick(rng, ['none', 'bread', 'produce', 'yarn', 'eggs'] as const, 'none'));
  if (contents !== 'none' && !options.lid) {
    const room = Math.max(0.02, at(0.7) - wall * 1.6);
    const fill = filling(room, contents, rng, seed + 47, Math.max(0, budget - spent));
    if (fill) {
      fill.part.translate(0, height * range(rng, 0.42, 0.68), 0);
      builder.add(fill.part);
      spent += fill.cost;
    }
  }

  if (style === 'trug') {
    // A trug is oval: long across the hands and shallow from front to back. The
    // scale distorts the normals, so they are recomputed rather than scaled.
    builder.scale(1.34, 0.82, 1);
    builder.computeNormals();
  }

  seatOnGround(builder, false);
  return builder;
}

/* -------------------------------------------------------------- cauldron */

export type CauldronRest = 'legs' | 'hook' | 'stand' | 'ash';
export type CauldronLid = 'none' | 'on' | 'ajar';
export type CauldronMetal = 'iron' | 'bronze' | 'copper' | 'sooted';

export interface CauldronOptions {
  /** Belly radius, in metres. */
  radius?: number;
  /** Rim height above the ground, legs and all. */
  height?: number;
  rest?: CauldronRest;
  lid?: CauldronLid;
  metal?: CauldronMetal;
  /** Only seen when the lid is off or ajar. */
  contents?: Contents;
  /** A swinging bail, which is what a hook hangs it by. */
  bail?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

const CAULDRON_METAL: Record<CauldronMetal, string> = {
  iron: 'iron-wrought',
  bronze: 'bronze',
  copper: 'copper-patina',
  sooted: 'iron-rusted',
};

/**
 * A cauldron: a round-bellied pot that hangs over a fire or stands in it.
 *
 * The belly is turned as one piece with its rim rolled over, because a rolled rim
 * is what a bail hangs from and what keeps a ladle from chipping the edge. Under
 * the belly there are three legs, an iron stand, a bed of ash, or nothing at all
 * — and which one is a matter of where the pot lives. Three legs stand on uneven
 * ground, which is most ground; a hook means the pot hangs from a crane over the
 * fire and is off the ground entirely; a stand is for a pot that is too heavy to
 * lift; ash is for one that sits in the embers.
 *
 * `rest: 'hook'` is the one container in the library that does not touch y = 0:
 * it is suspended by its bail at the height it hangs at, and a caller places the
 * hook. Every other rest is seated on the ground.
 */
export function cauldron(options: CauldronOptions): MeshBuilder {
  const seed = options.seed ?? 317;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const budget = componentBudget(options.quality, options.budget);
  const radius = Math.max(0.1, options.radius ?? 0.34);
  const height = Math.max(radius * 1.1, options.height ?? radius * 1.75);
  const rest = options.rest ?? (chance(rng, 0.7) ? 'legs' : 'ash');
  const metal = options.metal ?? (chance(rng, 0.6) ? 'iron' : 'sooted');
  const surface = CAULDRON_METAL[metal];
  const lid = options.lid ?? 'none';
  const wantsBail = options.bail ?? rest === 'hook';
  const wall = Math.max(0.008, radius * 0.06);
  let spent = 0;

  // How deep the belly is, and how far off the ground it starts.
  const legRoom = rest === 'legs' ? radius * 0.42 : rest === 'stand' ? radius * 0.3 : rest === 'ash' ? radius * 0.1 : 0;
  const bellyDepth = Math.max(radius * 0.7, height - legRoom - (lid === 'on' ? radius * 0.12 : 0));
  const bellyBase = legRoom;
  const rimY = bellyBase + bellyDepth;

  /** Outside radius of the belly at a fraction of its depth. */
  const at = (t: number): number => {
    const clamped = Math.min(1, Math.max(0, t));
    // Round at the bottom, widest low down, then a shoulder that pulls in to the neck.
    return radius * (0.42 + 0.72 * Math.sin(Math.pow(clamped, 0.78) * Math.PI * 0.62) - 0.14 * Math.pow(clamped, 3));
  };

  const stations = budget > 700 ? 9 : 7;
  const segments = budget > 1200 ? 20 : budget > 520 ? 16 : 12;
  const profile: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    profile.push([Math.max(wall * 0.5, at(t)), bellyBase + t * bellyDepth]);
  }
  // The rim, rolled over: out, up and back down the inside.
  profile.push([at(1) + wall * 0.7, rimY + wall * 0.5]);
  profile.push([at(1) - wall * 0.2, rimY + wall * 0.9]);
  profile.push([at(1) - wall * 1.1, rimY]);
  for (let index = stations - 1; index >= 1; index -= 1) {
    const t = index / stations;
    profile.push([Math.max(wall * 0.5, at(t) - wall), bellyBase + t * bellyDepth]);
  }
  profile.push([Math.max(wall * 0.5, at(0) - wall), bellyBase + wall]);
  profile.push([0, bellyBase + wall * 0.8]);

  const belly = lathe(profile, { segments });
  // Hammered rather than cast: a cauldron is raised from a disc and the hammer
  // marks are the record of it.
  if (budget > 460) {
    displace(belly, { amplitude: radius * 0.012, frequency: 9, octaves: 2, seed: seed + 7, preserveBase: true });
  }
  belly.flatShade();
  builder.add(belly, undefined, surface);
  spent += latheCost(profile.length, segments);

  if (rest === 'legs') {
    // Three legs, splayed, because a pot that stands on three points stands on
    // ground that is not flat and does not have to be.
    const planned = planChildren(3, cylinderCost(5, true) + BOX_TRIANGLES, Math.max(0, budget - spent));
    for (let index = 0; index < planned.modeled; index += 1) {
      const angle = (index / 3) * Math.PI * 2 + range(rng, -0.1, 0.1);
      const top: Vec3 = [Math.sin(angle) * at(0.24) * 0.86, bellyBase + bellyDepth * 0.2, Math.cos(angle) * at(0.24) * 0.86];
      const foot: Vec3 = [Math.sin(angle) * radius * 0.86, 0, Math.cos(angle) * radius * 0.86];
      builder.add(strut(top, foot, radius * 0.075, 5, true), undefined, surface);
      spent += cylinderCost(5, true);
      if (budget - spent > BOX_TRIANGLES) {
        const pad = box(radius * 0.16, radius * 0.05, radius * 0.2, { bevel: radius * 0.015, bevelSegments: 1 });
        pad.rotateY(angle);
        pad.translate(foot[0], radius * 0.025, foot[2]);
        builder.add(pad, undefined, surface);
        spent += BEVELLED_BOX_TRIANGLES;
      }
    }
  } else if (rest === 'stand') {
    // An iron trivet: a ring the pot sits in, on three feet, for a pot too heavy
    // to lift on and off the fire.
    // The ring the pot sits in, at the radius the belly actually has at that
    // height: a trivet wider than the pot there is a pot that falls through it,
    // and one narrower is a pot balanced on a hoop.
    const ringY = bellyBase + bellyDepth * 0.1;
    const ringRadius = at(0.1) * 1.02;
    const ring = torus(ringRadius, radius * 0.045, { radialSegments: 4, tubularSegments: budget > 800 ? 16 : 10 });
    ring.translate(0, ringY, 0);
    builder.add(ring, undefined, 'iron-rusted');
    spent += ringCost(4, budget > 800 ? 16 : 10);
    for (let index = 0; index < 3; index += 1) {
      const angle = (index / 3) * Math.PI * 2 + 0.4;
      // Splayed out from the ring to a foot wider than the belly, which is what
      // stops a loaded pot from walking across the fire.
      const leg = strut(
        [Math.sin(angle) * ringRadius, ringY, Math.cos(angle) * ringRadius],
        [Math.sin(angle) * radius * 1.06, 0, Math.cos(angle) * radius * 1.06],
        radius * 0.05,
        4,
      );
      builder.add(leg, undefined, 'iron-rusted');
      spent += cylinderCost(4, false);
    }
  } else if (rest === 'ash') {
    // Sitting in the embers, with the ash banked up round it: the pot is where
    // the fire was, and the fire left a bed.
    const bed = lathe([[radius * 1.5, 0], [radius * 1.1, radius * 0.1], [radius * 0.6, radius * 0.12], [0, radius * 0.06]], {
      segments: budget > 700 ? 14 : 10,
    });
    displace(bed, { amplitude: radius * 0.03, frequency: 6, octaves: 2, seed: seed + 19, preserveBase: true });
    bed.flatShade();
    builder.add(bed, undefined, 'soil');
    spent += latheCost(4, budget > 700 ? 14 : 10);
    if (budget - spent > 3 * BEVELLED_BOX_TRIANGLES) {
      // A coal or two, still in the bed.
      const coals = planChildren(4, BOX_TRIANGLES, budget - spent);
      const spots = scatter(rng, coals.modeled, radius * 2.2, radius * 2.2, 0.8);
      for (const spot of spots) {
        const coal = box(radius * 0.16, radius * 0.1, radius * 0.14);
        coal.rotateY(range(rng, 0, Math.PI));
        placeOn(coal, spot[0], radius * 0.06, spot[1]);
        builder.add(coal, undefined, 'wood-dark');
        spent += BOX_TRIANGLES;
      }
    }
  }

  if (wantsBail && budget - spent > ringCost(4, 14) + 2 * postCost(4)) {
    // The bail: a swinging handle, hung from two lugs on the rolled rim, and the
    // reason a hook rest is possible at all.
    // Stood up out of the ground plane so it crowns the mouth, with its two ends
    // coming down onto the lugs either side: a hook takes the crown, and the swing
    // is what lets the pot be reached over a fire rather than into it.
    const bail = torus(radius * 1.04, wall * 0.55, { radialSegments: 4, tubularSegments: 14, arc: Math.PI });
    bail.rotateX(-Math.PI / 2);
    bail.rotateY(range(rng, -0.4, 0.4));
    bail.translate(0, rimY + wall * 0.6, 0);
    builder.add(bail, undefined, 'iron-wrought');
    spent += ringCost(4, 14);
    for (const side of [-1, 1] as const) {
      const lug = cylinder(wall * 0.4, wall * 0.5, wall * 2.2, { radialSegments: 4 });
      lug.translate(side * radius * 1.02, rimY + wall * 0.4, 0);
      builder.add(lug, undefined, 'iron-wrought');
      spent += cylinderCost(4, true);
    }
  }

  if (lid !== 'none' && budget - spent > latheCost(4, 12) + sphereCost(6, 4)) {
    // A domed lid with a knob, sitting square or propped ajar with a ladle under
    // one edge so the pot keeps warm without boiling over.
    const lidSegments = Math.max(10, Math.round(segments * 0.7));
    const cover = lathe(
      [
        [at(1) * 1.04, 0],
        [at(1) * 0.9, radius * 0.1],
        [at(1) * 0.5, radius * 0.17],
        [0, radius * 0.2],
      ],
      { segments: lidSegments },
    );
    cover.flatShade();
    if (lid === 'ajar') {
      cover.rotateZ(range(rng, 0.14, 0.22));
      cover.translate(at(1) * 0.16, rimY + wall * 0.6, -at(1) * 0.06);
    } else {
      cover.translate(0, rimY + wall * 0.5, 0);
    }
    builder.add(cover, undefined, surface);
    spent += latheCost(4, lidSegments);
    const knob = sphere(radius * 0.09, { widthSegments: 6, heightSegments: 4 });
    knob.translate(lid === 'ajar' ? at(1) * 0.16 : 0, (lid === 'ajar' ? rimY + wall * 0.6 : rimY + wall * 0.5) + radius * 0.24, lid === 'ajar' ? -at(1) * 0.06 : 0);
    builder.add(knob, undefined, lid === 'on' ? surface : 'wood-dark');
    spent += sphereCost(6, 4);
  }

  const contents = options.contents ?? (lid === 'none' ? 'stew' : 'none');
  if (contents !== 'none' && lid !== 'on') {
    const room = Math.max(0.03, at(0.86) - wall * 1.6);
    const fill = filling(room, contents, rng, seed + 53, Math.max(0, budget - spent));
    if (fill) {
      // Stew is a hand below the rim: any higher and the boil throws it out.
      fill.part.translate(0, rimY - bellyDepth * range(rng, 0.14, 0.26), 0);
      builder.add(fill.part);
      spent += fill.cost;
    }
  }

  if (rest === 'hook') {
    // Suspended by its bail, at the height it hangs at: the pot is off the ground
    // and a caller places the hook. Not seated, and deliberately so.
    builder.translate(0, radius * 0.55, 0);
    return builder;
  }
  seatOnGround(builder, false);
  return builder;
}

/* ------------------------------------------------------------------- jar */

export type JarStyle = 'amphora' | 'jug' | 'urn' | 'bottle' | 'pot' | 'jar';
export type JarFinish = 'terracotta' | 'ceramic' | 'glazed' | 'stoneware';

export interface JarOptions {
  height?: number;
  radius?: number;
  style?: JarStyle;
  finish?: JarFinish;
  /** A band of painted decoration at the shoulder. */
  painted?: boolean;
  /** A stopper in the mouth, or a cloth tied over it. */
  stopper?: 'none' | 'cork' | 'cloth';
  contents?: Contents;
  /** A ring of clay to stand a pointed foot in. */
  stand?: boolean;
  /** Fallen over, with sherds round it. */
  fallen?: boolean;
  /** Sunk into a beaten earth floor, as storage jars are. */
  sunken?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

const JAR_FINISH: Record<JarFinish, string> = {
  terracotta: 'terracotta',
  ceramic: 'ceramic',
  glazed: 'ceramic-blue',
  stoneware: 'stone-pale',
};

/**
 * A jar: a thrown vessel, its foot, its stopper and the ring it stands in.
 *
 * The body is `vessel`, which is the whole family of thrown shapes from one
 * profile; what belongs here is everything that makes it a thing in use rather
 * than a shape. An amphora has a pointed foot and cannot stand, so it stands in a
 * ring of clay or leans in a rack, and a caller that asks for one gets the ring
 * unless it says otherwise. A storage jar is sunk into a beaten earth floor up to
 * its shoulder, which is how a cellar keeps oil cool. A jar that has been knocked
 * over lies on its side with sherds round it, and the sherds are the same clay as
 * the jar because they are the jar.
 *
 * `height` is the height of the vessel standing. Fallen, it is as tall as it is
 * wide, and sunk, it is as tall as the part that is above the floor.
 */
export function jar(options: JarOptions): MeshBuilder {
  const seed = options.seed ?? 331;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const budget = componentBudget(options.quality, options.budget);
  const style = options.style ?? 'amphora';
  // Sizes hang off the reference table's amphora — the pot a person carries on one
  // shoulder — so every style is a recognisable relative of it: a jug is squat and
  // handled, a bottle narrow and tall, a storage pot wide and low.
  const reference = REFERENCE.amphora ?? [0.45, 1, 0.45];
  const shapes: Record<JarStyle, { height: number; belly: number }> = {
    amphora: { height: reference[1]!, belly: reference[0]! },
    jug: { height: reference[1]! * 0.52, belly: reference[0]! * 0.78 },
    urn: { height: reference[1]! * 0.74, belly: reference[0]! * 1.1 },
    bottle: { height: reference[1]! * 0.66, belly: reference[0]! * 0.56 },
    pot: { height: reference[1]! * 0.44, belly: reference[0]! * 1.12 },
    jar: { height: reference[1]! * 0.56, belly: reference[0]! * 1.02 },
  };
  const wanted = shapes[style];
  const height = Math.max(0.12, options.height ?? wanted.height);
  // `radius` is the radius of the pot's widest part, which is the number a caller
  // has in mind when it says how big a jar it wants.
  const radius = Math.max(height * 0.1, options.radius ?? wanted.belly / 2);
  const finish = options.finish ?? (style === 'amphora' || style === 'jug' ? 'terracotta' : 'ceramic');
  const surface = JAR_FINISH[finish];
  const fallen = options.fallen ?? false;
  const sunken = options.sunken ?? false;
  // A pointed foot cannot stand: `amphora` gets a ring unless the caller refuses one.
  const pointed = style === 'amphora' || style === 'bottle';
  const stand = options.stand ?? (pointed && !fallen && !sunken);
  let spent = 0;

  // `vessel` takes the radius its own profile is scaled by and every style is
  // widest somewhere different, so the body is turned at a nominal size and then
  // squared up across X and Z to the belly that was asked for. The height is left
  // alone, which is the one dimension a caller is quoting exactly.
  //
  // What the budget buys is how many columns the body is turned round, never the
  // handles: an amphora without its handles is a different object, and the handles
  // are what a carrier puts its fingers through. The ring it stands in, the painted
  // band and the stopper are the luxuries, and they go first.
  const handled = style === 'amphora' || style === 'jug';
  const segments = budget > 1200 ? 22 : budget > 520 ? 16 : budget > 420 ? 12 : 10;
  const body = vessel({ height, radius: height * 0.28, style, seed, handles: handled, segments });
  // Measured rather than assumed, on Z because the handles run along X and never
  // reach it: the widest station is where a painted band belongs and where the pot
  // rests when it is knocked over.
  let bellyY = height * 0.4;
  let turned = 0;
  let mouthRadius = 0;
  for (let index = 0; index < body.vertexCount; index += 1) {
    const point = body.positionAt(index);
    const across = Math.abs(point[2]);
    if (across > turned) {
      turned = across;
      bellyY = point[1];
    }
    if (point[1] > height * 0.9) mouthRadius = Math.max(mouthRadius, across);
  }
  const square = radius / Math.max(1e-3, turned);
  body.scale(square, 1, square);
  // The scale distorts the normals, so they are recomputed rather than scaled.
  body.computeNormals();
  bellyY = Math.min(height * 0.94, bellyY);
  const mouth = Math.max(radius * 0.1, mouthRadius * square);

  const sink = sunken ? height * range(rng, 0.34, 0.46) : 0;
  if (fallen) {
    // Knocked over and left: on its side, rolled a little off square, resting on
    // its own belly rather than sunk into the floor.
    body.rotateZ(-Math.PI / 2 + range(rng, -0.16, 0.16));
    body.rotateY(range(rng, 0, Math.PI * 2));
    body.translate(0, radius, 0);
  } else if (sink > 0) {
    body.translate(0, -sink, 0);
  }
  builder.add(body, undefined, surface);
  spent += latheCost(11, segments, 2) + (handled ? 2 * EAR_HANDLE_TRIANGLES : 0);

  if (options.painted && budget - spent > ringCost(4, 14)) {
    // A band at the widest station, where a painter could reach it with the pot on
    // the wheel: one ring at the belly's own radius, in the glaze rather than the
    // clay. Fallen, the same ring goes round the axis the pot now lies along.
    const band = torus(radius, height * 0.022, { radialSegments: 4, tubularSegments: 16 });
    if (fallen) band.rotateZ(-Math.PI / 2);
    band.translate(fallen ? bellyY : 0, (fallen ? radius : bellyY) - sink, 0);
    builder.add(band, undefined, finish === 'glazed' ? 'ceramic-blue' : 'paint');
    spent += ringCost(4, 16);
  }

  const stopper = options.stopper ?? 'none';
  if (stopper !== 'none' && !fallen && budget - spent > cylinderCost(6, true)) {
    if (stopper === 'cork') {
      const cork = cylinder(mouth * 0.94, mouth, height * 0.06, { radialSegments: 6 });
      cork.translate(0, height - sink + height * 0.02, 0);
      builder.add(cork, undefined, 'wood-dark');
    } else {
      // A cloth tied over the mouth, sagging into it: a knot, not a lid.
      const cloth_ = cloth(mouth * 3.2, mouth * 3.2, 3, 3, (u, v) => -mouth * 0.5 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI));
      cloth_.translate(0, height - sink + mouth * 0.24, 0);
      builder.add(cloth_, undefined, 'fabric-linen');
      spent += clothCost(3, 3);
    }
    spent += cylinderCost(6, true);
  }

  const contents = options.contents ?? 'none';
  if (contents !== 'none' && !fallen && stopper === 'none' && budget - spent > latheCost(2, 10)) {
    // A level a mouth's width down: what is left of the oil, not a full jar. It is
    // sized by the mouth it is seen through, because a level wider than the neck it
    // sits in is a level through the wall of the pot.
    const room = Math.max(0.02, Math.min(radius * 0.5, mouth * 0.82));
    const fill = filling(room, contents, rng, seed + 61, Math.max(0, budget - spent));
    if (fill) {
      fill.part.translate(0, height * 0.88 - sink, 0);
      builder.add(fill.part);
      spent += fill.cost;
    }
  }

  if (stand && budget - spent > latheCost(3, 12)) {
    // A ring of clay to stand a pointed foot in: three lumps would do, and a ring
    // is what survives.
    const ring = lathe(
      [
        [radius * 0.62, 0],
        [radius * 0.5, height * 0.06],
        [radius * 0.3, height * 0.05],
        [0, height * 0.02],
      ],
      { segments: budget > 700 ? 14 : 10 },
    );
    displace(ring, { amplitude: radius * 0.02, frequency: 7, octaves: 2, seed: seed + 3, preserveBase: true });
    ring.flatShade();
    builder.add(ring, undefined, 'terracotta');
    spent += latheCost(4, budget > 700 ? 14 : 10);
  }

  if (sink > 0 && budget - spent > latheCost(3, 12)) {
    // The floor packed back up round the jar, which is what holds it upright and
    // what tells a player the jar is part of the room rather than left in it.
    const bank = lathe(
      [
        [radius * 2.1, 0],
        [radius * 1.5, sink * 0.34],
        [radius * 0.94, sink * 0.62],
        [radius * 0.7, sink * 0.3],
        [0, 0],
      ],
      { segments: budget > 700 ? 14 : 10 },
    );
    displace(bank, { amplitude: radius * 0.03, frequency: 6, octaves: 2, seed: seed + 23, preserveBase: true });
    bank.flatShade();
    builder.add(bank, undefined, 'soil');
    spent += latheCost(5, budget > 700 ? 14 : 10);
  }

  if (fallen && budget - spent > 4 * BOX_TRIANGLES) {
    // Sherds: the same clay as the jar, because they are the jar. Scattered on the
    // side it fell toward and thin, because a sherd is a flake.
    const shards = planChildren(6, BOX_TRIANGLES, Math.max(0, budget - spent));
    const spots = scatter(rng, shards.modeled, radius * 5, radius * 5, 0.9);
    for (const spot of spots) {
      const sherd = box(radius * range(rng, 0.2, 0.4), radius * 0.05, radius * range(rng, 0.16, 0.3));
      sherd.rotateY(range(rng, 0, Math.PI * 2));
      sherd.rotateZ(range(rng, -0.3, 0.3));
      placeOn(sherd, spot[0], 0, spot[1]);
      builder.add(sherd, undefined, surface);
      spent += BOX_TRIANGLES;
    }
  }

  if (sink > 0) {
    // Sunk, the buried foot stays below y = 0 and says so: y = 0 is the floor the
    // jar was dug into, the bank is packed up to the jar at that line, and what
    // stands above the floor is the height asked for minus the burial. Seating it
    // would pull the jar back out of the floor it is sunk in.
    return builder;
  }
  seatOnGround(builder, false);
  return builder;
}
