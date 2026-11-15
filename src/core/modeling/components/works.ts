import { MeshBuilder, type Vec3 } from '../mesh';
import { arch, box, cylinder, extrude, lathe, prism, sphere, torus } from '../primitives';
import {
  blade, boulder, cask, chain, componentBudget, detailRng, displace, dressedBlock, flame, gear,
  leafCluster, planks, post, roofPanel, rope, spike, stairs, stoneWall, tuft, wheel, type Quality,
} from '../detail';
import { seatOnGround } from '../scale';
import { chance, range } from '../../generation/rng';
import { affordable, cloth, leanLift, strut, take, type Spend } from './common';

/**
 * Works: what people build to build, to cross, to reach and to harvest.
 *
 * A ladder, a scaffold, a dock, a bridge, an aqueduct, a mine portal, a
 * haystack, a crop row, a scarecrow, a loom, a water wheel and a millstone.
 * These are the pieces of a site rather than of a room: they are judged by
 * whether a body can climb them, walk them, moor to them and work at them, so
 * their dimensions come from the same human measures as everything else in the
 * library — a rung at 28 cm, a guard rail at a metre, a quay a step above the
 * water.
 *
 * The house rules hold here as they do everywhere in `components/`:
 *
 * 1. Metres, Y up, the ground at y = 0. A pile driven into a riverbed still
 *    stands on y = 0, because the bed is where the model starts.
 * 2. Centred on X and Z, seated with `seatOnGround` at the end.
 * 3. Surfaces come from `SURFACES`, and no model uses more than ten of them.
 * 4. A budget is spent on representation, never on extent: a poorer scaffold
 *    loses its braces and its couplers, not its platform, because a platform is
 *    what makes it a scaffold.
 *
 * Long spans are the trap in this file. A bridge of twenty metres and an
 * aqueduct of four arches are built from repeated members, and a repeated
 * member is the cheapest way to spend ten times the allowance, so every
 * repetition here counts what one unit costs, works out how many units the
 * allowance buys, and builds that many — the span is carried by the members
 * that are charged unconditionally.
 */

/** The woods a site is built from. One wood per model, chosen once. */
const WOOD = {
  oak: 'wood-oak',
  pine: 'wood-pine',
  dark: 'wood-dark',
  weathered: 'wood-weathered',
} as const;

/** Which wood a work is built from. */
export type WorkWood = keyof typeof WOOD;

/** Iron that has been out in the weather, which is where all of this lives. */
const IRON = 'iron-rusted';

/**
 * A deck of boards laid over a frame.
 *
 * Boards run the long way by default, which is how a platform, a bridge and a
 * quay are laid: each board spans the length and the boards lie side by side
 * across it, so the deck never parts along its own span.
 */
function deck(
  width: number,
  depth: number,
  thickness: number,
  boards: number,
  seed: number,
  along = true,
  bevel?: number,
): MeshBuilder {
  const part = planks({
    width: Math.max(0.1, width),
    height: Math.max(0.1, depth),
    thickness: Math.max(0.012, thickness),
    count: Math.max(1, Math.round(boards)),
    horizontal: along,
    // A chamfered board costs four times a square one, and a deck is nothing but
    // boards, so a poor allowance lays them square.
    bevel: bevel ?? Math.max(0.002, thickness * 0.16),
    seed,
  });
  part.rotateX(-Math.PI / 2);
  return part;
}

/** A square timber between two points: a ledger, a transom, a brace, a rafter. */
function timber(from: Vec3, to: Vec3, section: number, sides = 4): MeshBuilder {
  return strut(from, to, Math.max(0.008, section * 0.5), sides, true);
}

/** Centres a part over the origin on X and Z, keeping its feet where they are. */
function centre(part: MeshBuilder): MeshBuilder {
  const bounds = part.bounds();
  part.translate(-bounds.center[0], 0, -bounds.center[2]);
  return part;
}

/**
 * How many of a repeated member an allowance buys.
 *
 * A repetition is the one place a generator can silently spend ten times its
 * budget: four arches of voussoirs, twenty piles, thirty paddles. So the unit
 * is built once and counted, and the count is what the allowance buys, never
 * less than `minimum` — dropping below the minimum would collapse the span, and
 * the rule is that a poorer model loses detail and keeps its extent.
 */
function units(state: Spend, unit: MeshBuilder, budget: number, minimum: number, wanted: number): number {
  const data = unit.build();
  const cost = Math.max(1, data.indices.length / 3);
  const room = Math.floor(Math.max(0, budget - state.spent) / cost);
  return Math.max(minimum, Math.min(wanted, room));
}

/**
 * A slice of what is left of an allowance, for a part that can fall back to its
 * own texture.
 *
 * Masonry is the one repetition that cannot be counted out: a twenty metre wall
 * of ashlar is six hundred blocks whether or not the allowance covers them, and
 * `stoneWall` builds them all and bills them all. So a wall is handed a slice of
 * what is left and decides for itself how much of it can be solid, falling back
 * to one face carrying the texture when the slice is thin. That is the trade the
 * rest of the library makes, one level down.
 */
function share(state: Spend, budget: number, parts: number): number {
  return Math.max(40, Math.floor(Math.max(0, budget - state.spent) / Math.max(1, parts)));
}

/**
 * A pier of masonry: narrow, deep and load-bearing.
 *
 * A pier is not a wall and cannot be built with `stoneWall`, which sizes its
 * quoins from the wall's thickness: a pier a metre and a half wide and four
 * metres deep comes back twenty metres wide, because its corner stones are six
 * metres long. So a pier is a dressed block, and it only gets a stone face once
 * it is wide enough for one to be honest about.
 */
function pier(width: number, height: number, depth: number, seed: number, rich: boolean): MeshBuilder {
  if (rich && width >= depth * 2.2) {
    const wall = stoneWall({
      width,
      height,
      thickness: depth,
      style: 'ashlar',
      seed,
    });
    centre(wall);
    return wall;
  }
  const block = dressedBlock({
    width,
    height,
    depth,
    chamfer: Math.min(0.07, width * 0.07),
    seed,
  });
  block.translate(0, height / 2, 0);
  return block;
}

export interface LadderOptions {
  /** Height of the top of the stiles above the ground, in metres. */
  height?: number;
  /** Clear distance between the stiles. */
  width?: number;
  /**
   * `straight` leans and climbs. `extension` is two ladders, the upper one
   * narrower and overlapped. `step` is an A-frame that stands on its own and is
   * climbed from one side, with boards instead of rungs.
   */
  style?: 'straight' | 'extension' | 'step';
  /** Rung spacing. A climbing ladder is 28 cm and a step is 24 cm. */
  rise?: number;
  wood?: WorkWood;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A ladder: two stiles and the rungs between them.
 *
 * The stiles carry the height and are charged whatever they cost; the rungs are
 * what a poor ladder loses, from the top down, because a ladder with eight
 * rungs still climbs to where eight rungs reach and a ladder with no stiles is
 * firewood. A step ladder stands on four feet, so its rear legs are splayed
 * back from the hinge and tied, and it carries boards rather than rungs — a
 * board is what a paint pot stands on.
 */
export function ladder(options: LadderOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 811);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'pine'];
  const style = options.style ?? 'straight';
  const height = Math.max(0.8, options.height ?? 4);
  const width = Math.max(0.24, options.width ?? 0.38);
  const rise = Math.max(0.18, options.rise ?? (style === 'step' ? 0.24 : 0.28));
  const stile = style === 'step' ? 0.06 : 0.055;

  if (style === 'step') {
    // An A-frame: the front stiles stand upright and the rear ones splay back to
    // the floor, so the ladder holds itself up and is climbed from one side.
    const depth = 0.92;
    const frontZ = depth * 0.32;
    const topY = height * 0.97;
    for (const side of [-1, 1]) {
      const front = box(stile, height, stile, { bevel: stile * 0.16, bevelSegments: 1 });
      front.translate(side * (width / 2 + stile / 2), height / 2, frontZ);
      builder.add(take(spent, front), undefined, wood);
      // The rear leg runs from the floor behind to the top of the front stile.
      const rear = timber([side * (width / 2 + stile / 2), 0, -depth * 0.5], [side * (width / 2 + stile / 2), topY, frontZ], stile * 0.86);
      builder.add(take(spent, rear), undefined, wood);
    }
    // Boards instead of rungs, each one standing on both front stiles.
    const steps = Math.max(1, Math.round((height - rise * 1.4) / rise));
    const unit = deck(width + stile * 2, 0.19, 0.03, 2, (options.seed ?? 811) + 3, true, budget > 1200 ? undefined : 0);
    const count = units(spent, unit, budget, 1, steps);
    for (let index = 0; index < count; index += 1) {
      const board = deck(width + stile * 2, 0.19, 0.03, 2, (options.seed ?? 811) + 3 + index, true, budget > 1200 ? undefined : 0);
      board.translate(0, rise * (index + 1), frontZ);
      builder.add(take(spent, board), undefined, wood);
    }
    const top = deck(width + stile * 2.4, 0.26, 0.036, 3, (options.seed ?? 811) + 29, true, budget > 1200 ? undefined : 0);
    top.translate(0, topY, frontZ * 0.7);
    builder.add(take(spent, top), undefined, wood);
    // A tie across the rear legs keeps the frame from opening out under a load.
    const tie = timber([-width / 2 - stile, topY * 0.42, -depth * 0.24], [width / 2 + stile, topY * 0.42, -depth * 0.24], stile * 0.6);
    const tieData = affordable(spent, tie, budget);
    if (tieData) builder.add(tieData, undefined, wood);
    const hinge = cylinder(stile * 0.42, stile * 0.42, width + stile * 2.4, { radialSegments: 8 });
    hinge.rotateZ(Math.PI / 2);
    hinge.translate(0, topY + stile * 0.3, frontZ * 0.72);
    const hingeData = affordable(spent, hinge, budget);
    if (hingeData) builder.add(hingeData, undefined, IRON);
  } else {
    for (const side of [-1, 1]) {
      const part = box(stile, height, 0.068, { bevel: stile * 0.16, bevelSegments: 1 });
      part.translate(side * (width / 2 + stile / 2), height / 2, 0);
      builder.add(take(spent, part), undefined, wood);
    }
    const sections = style === 'extension' ? 2 : 1;
    for (let section = 0; section < sections; section += 1) {
      // An extension ladder's upper section is narrower, so it slides inside the
      // lower one, and the two overlap by three rungs where the ties hold them.
      const narrow = section === 1 ? 0.86 : 1;
      const base = section === 1 ? height * 0.62 : 0;
      const top = section === 1 ? height * 1.34 : height;
      const count = Math.max(2, Math.round((top - base - rise) / rise));
      for (let index = 0; index < count; index += 1) {
        const rung = cylinder(0.019 * narrow, 0.021 * narrow, width * narrow, { radialSegments: budget > 1200 ? 8 : 6 });
        rung.rotateZ(Math.PI / 2);
        rung.translate(0, base + rise * (index + 1), section * 0.075);
        const data = affordable(spent, rung, budget);
        if (data) builder.add(data, undefined, wood);
      }
      if (section === 1) {
        for (const side of [-1, 1]) {
          const rail = box(stile * 0.86, top - base, 0.058, { bevel: stile * 0.14, bevelSegments: 1 });
          rail.translate(side * (width * narrow / 2 + stile * 0.43), (base + top) / 2, 0.075);
          builder.add(take(spent, rail), undefined, wood);
        }
        // Two ties across the overlap, which is the whole of the joint.
        for (const at of [base + rise * 0.6, top - rise * 0.6]) {
          const tie = box(width * 1.4, 0.05, 0.16, { bevel: 0.008, bevelSegments: 1 });
          tie.translate(0, at, 0.038);
          const data = affordable(spent, tie, budget);
          if (data) builder.add(data, undefined, IRON);
        }
      }
    }
    // Feet: iron shoes on the stiles, because the bottom metre of a ladder is
    // the part that rots and the part that slips.
    for (const side of [-1, 1]) {
      const shoe = box(stile * 1.3, 0.05, 0.09, { bevel: 0.008, bevelSegments: 1 });
      shoe.translate(side * (width / 2 + stile / 2), 0.025, 0);
      const data = affordable(spent, shoe, budget);
      if (data) builder.add(data, undefined, IRON);
    }
  }
  void rng;

  seatOnGround(builder);
  return builder;
}

export interface ScaffoldOptions {
  /** Length of one bay along X, in metres. */
  width?: number;
  /** Height of one lift, in metres. */
  height?: number;
  /** Depth of the platform along Z. */
  depth?: number;
  /** Bays side by side. */
  bays?: number;
  /** Lifts stacked up. */
  lifts?: number;
  /** `timber` is lashed poles; `tube` is steel scaffolding with couplers. */
  style?: 'timber' | 'tube';
  /** Boards laid across the top lift. */
  deck?: boolean;
  /** Diagonal braces in the faces: what stops a scaffold folding sideways. */
  braces?: boolean;
  wood?: WorkWood;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A scaffold: standards, ledgers, transoms, braces and a platform.
 *
 * Built bay by bay and lift by lift so a caller can ask for one panel or a run
 * of six. The standards carry the height and are charged; the ledgers and
 * transoms carry the span between them and are charged; braces, boards, guard
 * rails and couplers are representation and are spent only where the allowance
 * reaches. A scaffold with no braces is a real thing — it is what a scaffold
 * looks like halfway up — and it is what a poor budget buys rather than a
 * shorter scaffold.
 */
export function scaffold(options: ScaffoldOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 821);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'pine'];
  const style = options.style ?? 'timber';
  const bay = Math.max(1.2, options.width ?? 3);
  const lift = Math.max(1.2, options.height ?? 3);
  const depth = Math.max(0.7, options.depth ?? 1.5);
  const bays = Math.max(1, Math.round(options.bays ?? 1));
  const lifts = Math.max(1, Math.round(options.lifts ?? 1));
  const braces = options.braces ?? true;
  const boarded = options.deck ?? true;
  const top = lift * lifts;
  const span = bay * bays;
  const metal = style === 'tube';
  const frameSurface = metal ? 'steel' : wood;
  const section = metal ? 0.048 : 0.09;

  // Standards: two rows of uprights, one at each edge of the platform.
  const standards = (bays + 1) * 2;
  const standardUnit = metal
    ? cylinder(section / 2, section / 2, top, { radialSegments: budget > 1400 ? 10 : 7 })
    : post({ height: top, radius: section / 2, sides: budget > 1400 ? 8 : 6, cap: 'flat', seed: (options.seed ?? 821) + 5 });
  const standardCount = units(spent, standardUnit, budget, Math.min(standards, 4), standards);
  for (let index = 0; index < standardCount; index += 1) {
    const at = index % (bays + 1);
    const row = index < bays + 1 ? -1 : 1;
    const part = metal
      ? cylinder(section / 2, section / 2, top, { radialSegments: budget > 1400 ? 10 : 7 })
      : post({ height: top, radius: section / 2, sides: budget > 1400 ? 8 : 6, cap: 'flat', seed: (options.seed ?? 821) + 5 + index });
    // A tube is centred on its own middle and a timber post stands on its foot,
    // so only the tube is lifted: raising both by half the height stands the
    // timber scaffold three metres in the air.
    part.translate(-span / 2 + at * bay, metal ? top / 2 : 0, row * depth / 2);
    builder.add(take(spent, part), undefined, frameSurface);
  }

  // Ledgers along the length and transoms across it, at every lift.
  for (let level = 1; level <= lifts; level += 1) {
    const y = lift * level;
    for (const row of [-1, 1]) {
      const ledger = timber([-span / 2, y, row * depth / 2], [span / 2, y, row * depth / 2], section * 0.9);
      builder.add(take(spent, ledger), undefined, frameSurface);
    }
    for (let at = 0; at <= bays; at += 1) {
      const transom = timber([-span / 2 + at * bay, y, -depth / 2], [-span / 2 + at * bay, y, depth / 2], section * 0.8);
      const data = affordable(spent, transom, budget);
      if (data) builder.add(data, undefined, frameSurface);
    }
  }

  // Braces across the outside face, alternating direction so the run does not
  // rack one way. A brace is a strut from a standard's foot to the next one's
  // head, and it is the member that turns four poles into a frame.
  if (braces) {
    for (let at = 0; at < bays; at += 1) {
      for (const row of [-1, 1]) {
        const x0 = -span / 2 + at * bay;
        const flip = (at + (row > 0 ? 1 : 0)) % 2 === 0;
        const brace = timber(
          [flip ? x0 : x0 + bay, lift * 0.06, row * depth / 2],
          [flip ? x0 + bay : x0, lift * 0.94, row * depth / 2],
          section * 0.6,
        );
        const data = affordable(spent, brace, budget);
        if (data) builder.add(data, undefined, frameSurface);
      }
    }
  }

  // Couplers: a tube scaffold is held by fittings, and the fittings are what a
  // reader looks at to tell steel from timber.
  if (metal && budget > 900) {
    const joints = (bays + 1) * lifts;
    const couplers = Math.min(joints * 2, Math.floor((budget - spent.spent) / 26));
    for (let index = 0; index < couplers; index += 1) {
      // Walk the joints, then the two rows: taking the row from the parity of the
      // index instead put a second coupler exactly on top of the first whenever a
      // scaffold had one lift, which is a doubled skin over every joint.
      const at = index % (bays + 1);
      const level = 1 + Math.floor(index / (bays + 1)) % lifts;
      const row = Math.floor(index / joints) === 0 ? -1 : 1;
      const coupler = box(section * 1.9, section * 1.5, section * 1.9, { bevel: section * 0.14, bevelSegments: 1 });
      coupler.translate(-span / 2 + at * bay, lift * level, row * depth / 2);
      const data = affordable(spent, coupler, budget);
      if (data) builder.add(data, undefined, 'iron-wrought');
    }
  }
  // Lashings: a timber scaffold is tied at every joint with rope.
  if (!metal && budget > 900) {
    for (let at = 0; at <= bays; at += 1) {
      for (const row of [-1, 1]) {
        const lashing = torus(section * 0.62, section * 0.16, { radialSegments: 4, tubularSegments: 8 });
        lashing.rotateX(Math.PI / 2);
        lashing.translate(-span / 2 + at * bay, lift * lifts * 0.96, row * depth / 2);
        const data = affordable(spent, lashing, budget);
        if (data) builder.add(data, undefined, 'rope');
      }
    }
  }

  // The platform, its guard rail and its toe board: the part a body stands on
  // and the part that keeps a body and a brick on it.
  if (boarded) {
    const boards = deck(span, depth, 0.042, Math.max(3, Math.round(depth / (budget > 1200 ? 0.24 : 0.4))), (options.seed ?? 821) + 17, true, budget > 1200 ? undefined : 0);
    boards.translate(0, top + 0.021, 0);
    builder.add(take(spent, boards), undefined, wood);
    for (const row of [-1, 1]) {
      const rail = timber([-span / 2, top + 1.0, row * depth / 2], [span / 2, top + 1.0, row * depth / 2], section * 0.7);
      const railData = affordable(spent, rail, budget);
      if (railData) builder.add(railData, undefined, frameSurface);
      const toe = box(span, 0.15, 0.024, { bevel: 0.004, bevelSegments: 1 });
      toe.translate(0, top + 0.11, row * (depth / 2 - 0.012));
      const toeData = affordable(spent, toe, budget);
      if (toeData) builder.add(toeData, undefined, wood);
    }
  }

  // A ladder bay at one end, so the platform can be reached from the ground.
  if (boarded && budget > 1500 && chance(rng, 0.75)) {
    const climb = ladder({ height: top + 0.4, width: 0.36, style: 'straight', rise: 0.28, seed: (options.seed ?? 821) + 31 });
    climb.rotateX(-0.16);
    climb.translate(-span / 2 - 0.3, leanLift(0.05, 0.16), depth / 2 + 0.28);
    const data = affordable(spent, climb, budget);
    if (data) builder.add(data, undefined, wood);
  }

  seatOnGround(builder);
  return builder;
}

export interface DockOptions {
  /** Length of the quay along X, in metres. */
  length?: number;
  /** Width of the deck along Z. */
  width?: number;
  /** Height of the deck above the bed. A quay stands a step above the water. */
  height?: number;
  /** `pile` is timber on driven piles, `stone` a masonry quay, `float` a pontoon. */
  style?: 'pile' | 'stone' | 'float';
  /** Bollards and a mooring ring. */
  moorings?: boolean;
  /** Steps down to the water at the shore end. */
  steps?: boolean;
  wood?: WorkWood;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A dock: a deck held over water, with something to tie a boat to.
 *
 * Three quays, all the same size from the water. A piled quay stands on driven
 * piles with stringers and cross beams under the boards, and the piles are the
 * expensive part, so the count of them is what the allowance decides. A stone
 * quay is a wall with a coping, and it holds its own weight, so a poor one
 * loses its rings and its steps and keeps its masonry. A pontoon floats on two
 * casks laid on their sides and is chained to the bed, which is the only quay
 * that moves with the tide.
 */
export function dock(options: DockOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 829);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'weathered'];
  const style = options.style ?? 'pile';
  const length = Math.max(2, options.length ?? 8);
  const width = Math.max(1.2, options.width ?? 3);
  const height = Math.max(0.4, options.height ?? 1);
  const deckY = height;
  const moorings = options.moorings ?? true;

  if (style === 'stone') {
    // A masonry quay: one wall run, a coping that overhangs it on the water
    // side, and fenders where a hull would otherwise rub the stone.
    const wall = stoneWall({
      width: length,
      height: deckY - 0.12,
      thickness: width,
      style: budget > 1400 ? 'ashlar' : 'rubble',
      budget: share(spent, budget, 3),
      seed: (options.seed ?? 829) + 7,
    });
    centre(wall);
    wall.translate(0, 0, 0);
    builder.add(take(spent, wall), undefined, 'stone-dressed');
    const coping = box(length * 1.02, 0.16, width * 1.06, { bevel: 0.02, bevelSegments: 1 });
    coping.translate(0, deckY - 0.04, 0);
    builder.add(take(spent, coping), undefined, 'stone-pale');
    // A string course below the coping, which is how a quay sheds its water.
    const course = box(length * 1.01, 0.07, width * 1.02, { bevel: 0.012, bevelSegments: 1 });
    course.translate(0, deckY * 0.72, 0);
    const courseData = affordable(spent, course, budget);
    if (courseData) builder.add(courseData, undefined, 'stone-dressed');
    for (const side of [-1, 1]) {
      const fender = cylinder(0.07, 0.07, length * 0.9, { radialSegments: 6 });
      fender.rotateZ(Math.PI / 2);
      fender.translate(0, deckY * 0.44, side * (width / 2 + 0.04));
      const data = affordable(spent, fender, budget);
      if (data) builder.add(data, undefined, wood);
    }
  } else if (style === 'float') {
    // A pontoon: two casks laid on their sides carry the deck, and a chain to
    // the bed keeps it from going downstream.
    for (const at of [-length * 0.28, length * 0.28]) {
      // A staved cask is six hundred triangles of the allowance on its own, so a
      // poor pontoon floats on plain drums and a rich one on barrels.
      const drum = budget > 1400
        ? cask({ height: width * 0.86, radius: 0.34, staves: 12, hoops: 2, seed: (options.seed ?? 829) + 11 })
        : (() => {
          const plain = cylinder(0.34, 0.34, width * 0.86, { radialSegments: budget > 700 ? 12 : 9 });
          plain.translate(0, width * 0.43, 0);
          return plain;
        })();
      drum.rotateX(Math.PI / 2);
      drum.translate(at, 0.36, 0);
      builder.add(take(spent, drum), undefined, wood);
    }
    for (const side of [-1, 1]) {
      const bearer = timber([-length / 2, 0.66, side * width * 0.34], [length / 2, 0.66, side * width * 0.34], 0.11);
      builder.add(take(spent, bearer), undefined, wood);
    }
    const boards = deck(length, width, 0.05, Math.max(4, Math.round(width / (budget > 1200 ? 0.26 : 0.44))), (options.seed ?? 829) + 19, true, budget > 1200 ? undefined : 0);
    boards.translate(0, deckY * 0.72, 0);
    builder.add(take(spent, boards), undefined, wood);
    for (const end of [-1, 1]) {
      const mooring = chain({
        from: [end * length * 0.44, deckY * 0.66, 0],
        to: [end * length * 0.5, 0, end * 0.1],
        link: 0.09,
        radius: 0.017,
        sag: 0.16,
      });
      const data = affordable(spent, mooring, budget);
      if (data) builder.add(data, undefined, 'chain');
    }
  } else {
    // A piled quay. The piles are the expensive repetition here, so the unit is
    // counted first and the allowance decides how many of them there are; the
    // stringers and the deck are charged whatever they cost, because they are
    // the span.
    const wanted = Math.max(4, Math.round(length / 1.6) * 2);
    const pileUnit = cylinder(0.1, 0.13, deckY + 0.2, { radialSegments: budget > 1400 ? 9 : 7 });
    const piles = units(spent, pileUnit, budget, 4, wanted);
    for (let index = 0; index < piles; index += 1) {
      const row = index % 2 === 0 ? -1 : 1;
      const along = Math.floor(index / 2);
      const columns = Math.ceil(piles / 2);
      const x = columns === 1 ? 0 : -length / 2 + 0.3 + (along * (length - 0.6)) / (columns - 1);
      const pile = cylinder(0.1, 0.13, deckY + 0.2, { radialSegments: budget > 1400 ? 9 : 7, wobble: 0.012, wobbleSeed: index + 3 });
      pile.translate(x, (deckY + 0.2) / 2, row * (width / 2 - 0.24));
      builder.add(take(spent, pile), undefined, wood);
      // An iron shoe on the head of the pile, where the beam bears on it.
      if (budget > 1200) {
        const shoe = cylinder(0.125, 0.115, 0.05, { radialSegments: 8 });
        shoe.translate(x, deckY - 0.14, row * (width / 2 - 0.24));
        const data = affordable(spent, shoe, budget);
        if (data) builder.add(data, undefined, IRON);
      }
    }
    for (const side of [-1, 1]) {
      const stringer = timber([-length / 2, deckY - 0.14, side * (width / 2 - 0.24)], [length / 2, deckY - 0.14, side * (width / 2 - 0.24)], 0.14);
      builder.add(take(spent, stringer), undefined, wood);
    }
    const beams = Math.max(2, Math.round(length / 1.6));
    for (let index = 0; index < beams; index += 1) {
      const x = -length / 2 + 0.3 + (index * (length - 0.6)) / Math.max(1, beams - 1);
      const beam = timber([x, deckY - 0.07, -width / 2 + 0.24], [x, deckY - 0.07, width / 2 - 0.24], 0.12);
      const data = affordable(spent, beam, budget);
      if (data) builder.add(data, undefined, wood);
    }
    const boards = deck(length, width, 0.05, Math.max(4, Math.round(width / (budget > 1200 ? 0.24 : 0.44))), (options.seed ?? 829) + 23, true, budget > 1200 ? undefined : 0);
    boards.translate(0, deckY, 0);
    builder.add(take(spent, boards), undefined, wood);
    // A wale along the face, which is the timber a hull actually touches.
    const wale = box(length * 1.01, 0.14, 0.06, { bevel: 0.012, bevelSegments: 1 });
    wale.translate(0, deckY - 0.3, width / 2 + 0.02);
    const waleData = affordable(spent, wale, budget);
    if (waleData) builder.add(waleData, undefined, wood);
  }

  if (moorings) {
    // Bollards: a short fat post with a cap, tied in pairs where a boat is held.
    const bollards = style === 'stone' ? 2 : Math.max(1, Math.round(length / 4));
    for (let index = 0; index < bollards; index += 1) {
      const x = bollards === 1 ? length * 0.3 : -length * 0.34 + (index * (length * 0.68)) / Math.max(1, bollards - 1);
      // A bollard stands proud of the deck by a fifth of a metre: the quay is
      // measured a metre and a fifth tall over all, and a post half a metre over
      // the deck makes it a third again as tall as the reference it is swept for.
      const part = post({ height: 0.17, radius: 0.09, sides: budget > 1200 ? 10 : 7, cap: 'flat', seed: (options.seed ?? 829) + index });
      part.translate(x, deckY + (style === 'float' ? -0.28 : 0.02), -width / 2 + 0.28);
      const data = affordable(spent, part, budget);
      if (data) builder.add(data, undefined, style === 'stone' ? 'iron-wrought' : wood);
    }
    for (const side of [-1, 1]) {
      const ring = torus(0.09, 0.018, { radialSegments: 4, tubularSegments: 10 });
      ring.rotateY(Math.PI / 2);
      ring.translate(length * 0.18 * side, deckY * (style === 'float' ? 0.5 : 0.62), side * (width / 2 + 0.04));
      const data = affordable(spent, ring, budget);
      if (data) builder.add(data, undefined, IRON);
    }
  }

  if (options.steps ?? true) {
    // Steps down the water face, so a boat can be reached at any tide.
    // Steeper than a stair inside a building, because the flight has to reach the
    // bed from the deck without pushing the quay's footprint out into the water:
    // a quarter metre of run to every fifth of a metre of fall.
    const risers = Math.max(2, Math.round(deckY / 0.28));
    const stepRise = deckY / risers;
    const tread = 0.24;
    const part = stairs({ steps: risers, rise: stepRise, tread, width: Math.min(1.4, width * 0.6), sides: 'none', seed: (options.seed ?? 829) + 41 });
    part.rotateY(Math.PI);
    part.translate(length * 0.3, deckY - risers * stepRise, width / 2 + risers * tread);
    const data = affordable(spent, part, budget);
    if (data) builder.add(data, undefined, style === 'stone' ? 'stone-dressed' : wood);
  }

  // Water under the quay: a sheet at the bed, so a pile quay is visibly standing
  // in something rather than on nothing.
  if (style !== 'stone' && budget > 800) {
    const sheet = box(length * 1.08, 0.012, width * 1.02, { bevel: 0, bevelSegments: 1 });
    sheet.translate(0, 0.02, 0);
    const data = affordable(spent, sheet, budget);
    if (data) builder.add(data, undefined, 'glass');
  }
  void rng;

  seatOnGround(builder);
  return builder;
}

export interface BridgeOptions {
  /** Clear span between the abutments, in metres. */
  span?: number;
  /** Width of the carriageway along Z. */
  width?: number;
  /** Height of the deck above the bed, in metres. */
  height?: number;
  /**
   * `timber` is a trestle, `stone` an arcade on piers with cutwaters, `covered`
   * a trestle with a roof over it, `rope` a footbridge hung between two towers.
   */
  style?: 'timber' | 'stone' | 'covered' | 'rope';
  /** Openings in a stone bridge. */
  arches?: number;
  /** Parapet or railing along both edges. */
  railing?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A bridge: a deck carried over something you would rather not cross.
 *
 * The deck and whatever holds it up are charged; bracing, cutwaters, copings,
 * voussoir joints and roof shingles are representation. A stone bridge keeps
 * its piers and its arch rings whatever the allowance, and loses its cornice
 * and its cutwaters first, because a bridge with no cornice still carries a
 * cart and a bridge with no arch does not cross anything.
 *
 * A rope bridge is the exception: its towers are charged and its walkway sags,
 * and what a poor budget buys is fewer hangers and a narrower walk, which is
 * what a rope bridge in disrepair actually looks like.
 */
export function bridge(options: BridgeOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 839);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const style = options.style ?? 'timber';
  const span = Math.max(3, options.span ?? (style === 'stone' ? 16 : style === 'rope' ? 14 : 12));
  const width = Math.max(1, options.width ?? (style === 'rope' ? 1.2 : style === 'stone' ? 5 : 4));
  const height = Math.max(1.6, options.height ?? (style === 'stone' ? 5 : style === 'covered' ? 4.6 : 3.5));
  const railing = options.railing ?? true;
  const deckY = height * (style === 'stone' ? 0.72 : 0.74);

  if (style === 'stone') {
    // A poorer bridge crosses the same span on fewer arches: the openings are
    // representation, the span is not.
    const wanted = Math.round(options.arches ?? (span > 12 ? 3 : 2));
    const arches = Math.max(1, budget > 2500 ? wanted : budget > 1000 ? Math.max(1, Math.round(wanted * 0.7)) : 1);
    const pierWidth = Math.max(0.8, span / (arches * 2.6));
    const opening = (span - pierWidth * (arches + 1)) / arches;
    const springing = height * 0.3;
    const rise = Math.max(0.6, deckY - springing - 0.5);
    const crown = springing + rise + 0.34;

    // Piers, full height to the deck line: they carry the arches and the
    // spandrels, so they are charged before anything else in the bridge.
    for (let index = 0; index <= arches; index += 1) {
      const x = -span / 2 + pierWidth / 2 + index * (opening + pierWidth);
      const upright = pier(pierWidth, deckY, width, (options.seed ?? 839) + index * 3, budget > 2200);
      upright.translate(x, 0, 0);
      builder.add(take(spent, upright), undefined, 'stone-dressed');
      // A cutwater on both faces: a triangular nose that parts the flood and
      // takes the debris, and the first thing a river removes from a bridge.
      for (const side of [-1, 1]) {
        const nose = prism({ sides: 3, radius: Math.min(pierWidth * 0.24, width * 0.08), height: deckY * 0.72, topScale: 0.4, caps: true });
        centre(nose);
        nose.rotateY(side > 0 ? 0 : Math.PI);
        nose.translate(x, 0, side * (width / 2 + width * 0.02));
        const data = affordable(spent, nose, budget);
        if (data) builder.add(data, undefined, 'stone-pale');
      }
    }
    // Arches between the piers, one ring per opening.
    for (let index = 0; index < arches; index += 1) {
      const x = -span / 2 + pierWidth + opening / 2 + index * (opening + pierWidth);
      const ring = arch({
        span: opening,
        rise,
        thickness: 0.34,
        depth: width,
        segments: budget > 2500 ? 18 : budget > 1000 ? 12 : 7,
        voussoirs: budget > 2500,
        style: arches > 2 ? 'segmental' : 'round',
      });
      ring.translate(x, springing, -width / 2);
      builder.add(take(spent, ring), undefined, 'stone-dressed');
      // Spandrel: the masonry between the crown of the arch and the deck.
      const fill = box(opening, Math.max(0.1, deckY - crown), width * 0.98, { bevel: 0, bevelSegments: 1 });
      fill.translate(x, (crown + deckY) / 2, 0);
      const data = affordable(spent, fill, budget);
      if (data) builder.add(data, undefined, 'stone-rough');
    }
    // Cornice, deck and parapets.
    const cornice = box(span * 1.03, 0.18, width * 1.08, { bevel: 0.02, bevelSegments: 1 });
    cornice.translate(0, deckY - 0.09, 0);
    const corniceData = affordable(spent, cornice, budget);
    if (corniceData) builder.add(corniceData, undefined, 'stone-pale');
    const slab = box(span * 1.01, 0.2, width, { bevel: 0, bevelSegments: 1 });
    slab.translate(0, deckY + 0.1, 0);
    builder.add(take(spent, slab), undefined, 'stone-dressed');
    if (railing) {
      for (const side of [-1, 1]) {
        const parapet = stoneWall({
          width: span,
          height: height - deckY - 0.2,
          thickness: 0.26,
          style: budget > 1400 ? 'ashlar' : 'rubble',
          budget: share(spent, budget, 2),
          seed: (options.seed ?? 839) + 51 + side,
        });
        centre(parapet);
        parapet.translate(0, deckY + 0.2, side * (width / 2 - 0.13));
        builder.add(take(spent, parapet), undefined, 'stone-dressed');
        const coping = box(span * 1.02, 0.09, 0.36, { bevel: 0.016, bevelSegments: 1 });
        coping.translate(0, height - 0.045, side * (width / 2 - 0.13));
        const data = affordable(spent, coping, budget);
        if (data) builder.add(data, undefined, 'stone-pale');
      }
    }
  } else if (style === 'rope') {
    // Two towers, two cables, a walk that sags between them, and hangers that
    // carry the walk from the cables. Nothing here is straight, and the sag is
    // the point: a rope bridge hangs, it does not stand.
    const tower = height * 0.94;
    const walkY = deckY;
    const sag = span * 0.045;
    for (const end of [-1, 1]) {
      for (const side of [-1, 1]) {
        const leg = timber(
          [end * span / 2 + end * 0.22, 0, side * width * 0.42],
          [end * span / 2, tower, side * width * 0.3],
          0.13,
        );
        builder.add(take(spent, leg), undefined, 'wood-dark');
      }
      const cap = timber([end * span / 2, tower, -width * 0.3], [end * span / 2, tower, width * 0.3], 0.12);
      builder.add(take(spent, cap), undefined, 'wood-dark');
      const anchor = box(0.7, 0.36, width * 0.8, { bevel: 0.04, bevelSegments: 1 });
      anchor.translate(end * (span / 2 + 0.5), 0.18, 0);
      const data = affordable(spent, anchor, budget);
      if (data) builder.add(data, undefined, 'stone-rough');
    }
    for (const side of [-1, 1]) {
      // The cable is a catenary, sampled, and the walk hangs from it.
      const points = Math.max(6, budget > 1200 ? 14 : 9);
      const path: Vec3[] = [];
      for (let index = 0; index <= points; index += 1) {
        const t = index / points;
        const x = -span / 2 + t * span;
        const droop = Math.sin(t * Math.PI) * sag;
        path.push([x, tower * 0.96 - droop, side * width * 0.3]);
      }
      const cable = rope({
        path,
        radius: 0.045,
        strands: budget > 1400 ? 3 : 2,
        twist: budget > 1400 ? 5 : 3,
        segments: Math.max(8, budget > 1400 ? points * 2 : points),
      });
      builder.add(take(spent, cable), undefined, 'rope');
      const hangers = Math.max(3, Math.floor((budget - spent.spent) / 40));
      for (let index = 1; index < Math.min(hangers, points); index += 1) {
        const t = index / points;
        const x = -span / 2 + t * span;
        const droop = Math.sin(t * Math.PI) * sag;
        const walk = walkY - Math.sin(t * Math.PI) * sag * 0.5;
        const hanger = timber([x, tower * 0.96 - droop, side * width * 0.3], [x, walk, side * width * 0.36], 0.02, 3);
        const data = affordable(spent, hanger, budget);
        if (data) builder.add(data, undefined, 'rope');
      }
    }
    // The walk: boards laid across, following the sag rather than ignoring it.
    const boards = Math.max(6, Math.min(40, Math.floor(Math.max(0, budget - spent.spent) / 12)));
    for (let index = 0; index < boards; index += 1) {
      const t = (index + 0.5) / boards;
      const board = box(width * 0.94, 0.035, span / boards * 0.72, { bevel: 0.004, bevelSegments: 1 });
      board.translate(-span / 2 + t * span, walkY - Math.sin(t * Math.PI) * sag * 0.5, 0);
      const data = affordable(spent, board, budget);
      if (data) builder.add(data, undefined, 'wood-weathered');
    }
    for (const side of [-1, 1]) {
      const hand = rope({
        path: [
          [-span / 2, tower * 0.7, side * width * 0.42],
          [0, walkY - sag * 0.4 + 0.8, side * width * 0.42],
          [span / 2, tower * 0.7, side * width * 0.42],
        ],
        radius: 0.03,
        strands: 3,
        twist: 4,
        segments: 12,
      });
      const data = affordable(spent, hand, budget);
      if (data) builder.add(data, undefined, 'rope');
    }
  } else {
    // A trestle: bents of two battered posts and a cap, standing in the water or
    // over a road, with stringers on the caps and a deck on the stringers.
    const bents = Math.max(2, Math.round(span / 3) + 1);
    for (let index = 0; index < bents; index += 1) {
      const x = -span / 2 + (index * span) / (bents - 1);
      for (const side of [-1, 1]) {
        const post = timber(
          [x + side * width * 0.1, 0, side * (width / 2 - 0.2)],
          [x, deckY - 0.1, side * (width / 2 - 0.3)],
          0.17,
        );
        builder.add(take(spent, post), undefined, 'wood-dark');
      }
      const cap = timber([x, deckY - 0.1, -width / 2 + 0.24], [x, deckY - 0.1, width / 2 - 0.24], 0.2);
      builder.add(take(spent, cap), undefined, 'wood-dark');
      // A brace in each bent, so the trestle does not fold across the span.
      // The brace lies in the plane of its own bent, from one post's foot to the
      // other post's head: that is what stops a trestle folding across the
      // carriageway. Bracing along the span is the longitudinal below.
      const brace = timber([x, deckY * 0.22, -width * 0.34], [x, deckY * 0.78, width * 0.34], 0.09);
      const data = affordable(spent, brace, budget);
      if (data) builder.add(data, undefined, 'wood-dark');
      if (index > 0 && budget > 1200) {
        const previous = -span / 2 + ((index - 1) * span) / (bents - 1);
        const longitudinal = timber([previous, deckY * 0.5, width * 0.32], [x, deckY * 0.5, width * 0.32], 0.07);
        const longData = affordable(spent, longitudinal, budget);
        if (longData) builder.add(longData, undefined, 'wood-dark');
      }
    }
    for (const side of [-1, 1]) {
      const stringer = timber([-span / 2, deckY - 0.02, side * (width / 2 - 0.3)], [span / 2, deckY - 0.02, side * (width / 2 - 0.3)], 0.16);
      builder.add(take(spent, stringer), undefined, 'wood-oak');
    }
    const boards = deck(span * 1.02, width, 0.06, Math.max(4, Math.round(width / (budget > 1200 ? 0.26 : 0.42))), (options.seed ?? 839) + 13, true, budget > 1200 ? undefined : 0);
    boards.translate(0, deckY + 0.03, 0);
    builder.add(take(spent, boards), undefined, 'wood-oak');

    if (style === 'covered') {
      // A covered bridge: trusses at both edges, siding over the lower half and
      // a roof over all of it, because the timbers last a century longer dry.
      const ridge = height;
      const eave = deckY + 0.5;
      // The roof is what makes this bridge covered, so its share is set aside
      // before the siding and the posts are paid for. A `roofPanel` floors its own
      // budget at a hundred and twenty triangles a panel, which is more than a
      // thin allowance has left by the time the trusses are built: without a
      // reserve the roof cannot be afforded at all and a covered bridge stops
      // being covered, which is the one thing it may not do.
      const roofShare = budget > 900 ? Math.min(900, Math.floor(budget * 0.24)) : 0;
      const trim = Math.max(0, budget - roofShare);
      for (const side of [-1, 1]) {
        const truss = timber([-span / 2, eave, side * (width / 2 - 0.1)], [span / 2, eave, side * (width / 2 - 0.1)], 0.14);
        builder.add(take(spent, truss), undefined, 'wood-dark');
        const posts = Math.max(3, Math.round(span / 2.4));
        for (let index = 0; index <= posts; index += 1) {
          const x = -span / 2 + (index * span) / posts;
          const upright = box(0.1, eave - deckY, 0.1, { bevel: 0.012, bevelSegments: 1 });
          upright.translate(x, (eave + deckY) / 2, side * (width / 2 - 0.1));
          const data = affordable(spent, upright, trim);
          if (data) builder.add(data, undefined, 'wood-dark');
        }
        // Siding below the eave, with a gap at eye level to see out of.
        const side_ = planks({
          width: span,
          height: eave - deckY - 0.35,
          thickness: 0.035,
          count: Math.max(3, budget > 1400 ? 7 : 4),
          horizontal: true,
          seed: (options.seed ?? 839) + 17 + side,
        });
        side_.translate(0, deckY + (eave - deckY - 0.35) / 2 + 0.05, side * (width / 2 - 0.06));
        const sideData = affordable(spent, side_, trim);
        if (sideData) builder.add(sideData, undefined, 'wood-weathered');
      }
      // The roof: two panels pitched down from the ridge. A `roofPanel` is a flat
      // sheet running out along +Z from its own origin, so the near slope is
      // pitched down from the ridge as it stands and the far slope is mirrored
      // first — `mirror` flips the winding, which is what keeps the shingles
      // facing out of the roof instead of into it.
      const slope = Math.hypot(width / 2, ridge - eave);
      const pitch = Math.atan2(ridge - eave, width / 2);
      // A `shingle` or `slate` panel is laid at a fixed cost — twelve hundred
      // triangles a panel, whatever the allowance it is handed — so it is only
      // asked for when the budget can pay that outright. Thatch is laid to the
      // budget it is given, which is what a thin allowance needs.
      const roofStyle = budget > 5200 ? 'shingle' : 'thatch';
      // The reserve is a ceiling as well as a floor: whatever is left of the
      // allowance, the roof does not spend more than the share set aside for it.
      const roofAllowance = Math.max(0, Math.min(roofShare, budget - spent.spent));
      const laid = roofAllowance >= 260;
      for (const side of [-1, 1]) {
        // A laid roof when the reserve can pay for one, boards over the rafters
        // when it cannot: either way the bridge is covered and either way the
        // ridge is where it was drawn.
        const panel = laid
          ? roofPanel({
            width: span * 1.04,
            slopeLength: slope * 1.04,
            style: roofStyle,
            overhang: 0.16,
            budget: Math.floor(roofAllowance / 2),
            seed: (options.seed ?? 839) + 23 + side,
          })
          : (() => {
            const sheet = box(span * 1.06, 0.055, slope * 1.04 + 0.3, { bevel: 0, bevelSegments: 1 });
            sheet.translate(0, 0, (slope * 1.04 + 0.3) / 2 - 0.16);
            return sheet;
          })();
        if (side < 0) panel.mirror('z');
        panel.rotateX(side * pitch);
        panel.translate(0, ridge, 0);
        builder.add(take(spent, panel), undefined, laid ? roofStyle : 'wood-weathered');
      }
      const ridgeCap = box(span * 1.06, 0.1, 0.24, { bevel: 0.02, bevelSegments: 1 });
      ridgeCap.translate(0, ridge - 0.02, 0);
      const ridgeData = affordable(spent, ridgeCap, trim);
      if (ridgeData) builder.add(ridgeData, undefined, 'wood-dark');
    } else if (railing) {
      for (const side of [-1, 1]) {
        const rail = timber([-span / 2, deckY + 0.95, side * (width / 2 - 0.1)], [span / 2, deckY + 0.95, side * (width / 2 - 0.1)], 0.09);
        const railData = affordable(spent, rail, budget);
        if (railData) builder.add(railData, undefined, 'wood-oak');
        const balusters = Math.max(3, Math.round(span / 0.7));
        for (let index = 0; index <= balusters; index += 1) {
          const x = -span / 2 + (index * span) / balusters;
          const part = box(0.055, 0.9, 0.055, { bevel: 0.008, bevelSegments: 1 });
          part.translate(x, deckY + 0.5, side * (width / 2 - 0.1));
          const data = affordable(spent, part, budget);
          if (data) builder.add(data, undefined, 'wood-oak');
        }
      }
    }
  }
  void rng;

  seatOnGround(builder);
  return builder;
}

export interface AqueductOptions {
  /** Length of the run along X, in metres. */
  length?: number;
  /** Height to the top of the channel's parapets. */
  height?: number;
  /** Width of the channel along Z. */
  width?: number;
  /** Arches in the lower arcade. */
  arches?: number;
  /** Two arcades, the upper one smaller, as at Pont du Gard. */
  tiers?: 1 | 2;
  /** `stone` is ashlar, `brick` is a brick arcade. */
  style?: 'stone' | 'brick';
  /** Water running in the channel. */
  water?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * An aqueduct: an arcade of arches carrying a water channel across a valley.
 *
 * The piers and the arch rings are charged, the channel floor and its two
 * parapets are charged, and what a poor allowance loses is the voussoir
 * joints, the cornice and the second tier. Water is representation and comes
 * last, because an aqueduct without water in it is still an aqueduct — it is
 * how most of them survive.
 */
export function aqueduct(options: AqueductOptions = {}): MeshBuilder {
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const length = Math.max(6, options.length ?? 20);
  const height = Math.max(4, options.height ?? 12);
  const width = Math.max(1.6, options.width ?? 4);
  const tiers = options.tiers ?? 1;
  const brick = options.style === 'brick';
  const masonry = brick ? 'brick' : 'stone-dressed';
  const surface = brick ? 'brick-pale' : 'stone-pale';
  const channelFloor = height - 1.5;

  /**
   * One arcade: piers, arch rings and the fill above the crowns, from `base` to
   * `top`. The upper tier of a two-tier aqueduct is the same work at a smaller
   * pitch, so it is the same code with more openings and less height.
   */
  const arcade = (base: number, top: number, wanted: number, depth: number, seed: number): void => {
    // The bays are the repetition and the repetition is the cost, so a poorer
    // aqueduct crosses the same valley on fewer arches: the span is carried by
    // the channel above, which is charged whatever it costs.
    const openings = Math.max(2, Math.min(wanted, Math.round(wanted * (budget > 4000 ? 1 : budget > 1600 ? 0.7 : 0.45))));
    const pierWidth = Math.max(0.7, length / (openings * 2.8));
    const opening = (length - pierWidth * (openings + 1)) / openings;
    const springing = base + (top - base) * 0.42;
    const rise = Math.max(0.5, top - springing - 0.42);
    const crown = springing + rise + 0.32;
    for (let index = 0; index <= openings; index += 1) {
      const x = -length / 2 + pierWidth / 2 + index * (opening + pierWidth);
      // Only as far as this arcade's own springing: on a second tier the
      // springing is measured from the ground, and a pier built to it stands four
      // metres proud of the whole aqueduct.
      const upright = pier(pierWidth, springing + 0.1 - base, depth, seed + index * 5, budget > 2200);
      upright.translate(x, base, 0);
      builder.add(take(spent, upright), undefined, masonry);
    }
    for (let index = 0; index < openings; index += 1) {
      const x = -length / 2 + pierWidth + opening / 2 + index * (opening + pierWidth);
      const ring = arch({
        span: opening,
        rise,
        thickness: 0.32,
        depth,
        segments: budget > 4000 ? 16 : budget > 1600 ? 11 : 7,
        voussoirs: budget > 4000,
        style: brick ? 'round' : 'segmental',
      });
      ring.translate(x, springing, -depth / 2);
      builder.add(take(spent, ring), undefined, masonry);
      const fill = box(opening, Math.max(0.08, top - crown), depth * 0.96, { bevel: 0, bevelSegments: 1 });
      fill.translate(x, (crown + top) / 2, 0);
      const data = affordable(spent, fill, budget);
      if (data) builder.add(data, undefined, brick ? 'brick-pale' : 'stone-rough');
    }
  };

  // Two arcades are twice the masonry of one, and masonry is the part that
  // cannot be dropped: at a thin allowance the aqueduct is built as one arcade,
  // which is the same aqueduct at the same height over the same valley.
  if (tiers === 2 && budget > 1600) {
    const lower = channelFloor * 0.62;
    arcade(0, lower, Math.max(2, Math.round(length / 6)), width, (options.seed ?? 853) + 3);
    arcade(lower, channelFloor - 0.2, Math.max(4, Math.round(length / 3.2)), width * 0.78, (options.seed ?? 853) + 29);
  } else {
    arcade(0, channelFloor - 0.2, Math.max(2, Math.round(options.arches ?? length / 5)), width, (options.seed ?? 853) + 3);
  }
  void brick;

  // A cornice under the channel, then the channel itself: a floor, two parapets
  // and the water between them.
  const cornice = box(length * 1.02, 0.22, width * 1.1, { bevel: 0.024, bevelSegments: 1 });
  cornice.translate(0, channelFloor - 0.11, 0);
  const corniceData = affordable(spent, cornice, budget);
  if (corniceData) builder.add(corniceData, undefined, surface);
  const floor = box(length, 0.2, width, { bevel: 0, bevelSegments: 1 });
  floor.translate(0, channelFloor + 0.1, 0);
  builder.add(take(spent, floor), undefined, masonry);
  for (const side of [-1, 1]) {
    const parapet = box(length, 1.3, width * 0.16, { bevel: 0.02, bevelSegments: 1 });
    parapet.translate(0, channelFloor + 0.2 + 0.65, side * (width / 2 - width * 0.08));
    builder.add(take(spent, parapet), undefined, masonry);
    const coping = box(length * 1.01, 0.1, width * 0.22, { bevel: 0.018, bevelSegments: 1 });
    coping.translate(0, height - 0.05, side * (width / 2 - width * 0.08));
    const data = affordable(spent, coping, budget);
    if (data) builder.add(data, undefined, surface);
  }
  if (options.water ?? true) {
    const sheet = box(length * 0.98, 0.02, width * 0.66, { bevel: 0, bevelSegments: 1 });
    sheet.translate(0, channelFloor + 0.32, 0);
    const data = affordable(spent, sheet, budget);
    if (data) builder.add(data, undefined, 'glass');
  }

  seatOnGround(builder);
  return builder;
}

export interface MineEntranceOptions {
  /** Width of the opening, in metres. */
  width?: number;
  /** Height of the opening, in metres. */
  height?: number;
  /** `timber` is a three-piece portal set, `stone` a masonry arch, `adit` a bare mouth in the rock. */
  style?: 'timber' | 'stone' | 'adit';
  /** Rails and sleepers running out of the mouth. */
  track?: boolean;
  /** An A-frame over the shaft, with a pulley and a bucket. */
  headframe?: boolean;
  /** A lamp hung in the portal. */
  lamp?: boolean;
  /** A heap of spoil beside the entrance. */
  spoil?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A mine entrance: a hole in a hillside, held open, with the works around it.
 *
 * The rock face is charged because it is the hillside, the portal that holds
 * the mouth open is charged because without it the model is a cave, and the
 * track, the headframe, the lamp and the spoil heap are what a working mine has
 * and an abandoned one does not — so those are what a poor allowance drops.
 */
export function mineEntrance(options: MineEntranceOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 857);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const style = options.style ?? 'timber';
  const width = Math.max(1, options.width ?? 1.6);
  const height = Math.max(1.2, options.height ?? 2);
  const face = 2.6;

  // The hillside: three masses, sunk into the ground so the rock meets the
  // earth instead of resting on it, with the mouth between them.
  for (const mass of [
    [-width / 2 - face * 0.34, 0.1, face * 0.5, 0.9],
    [width / 2 + face * 0.34, 0.1, face * 0.5, 1.2],
    [0, height + face * 0.3, face * 0.62, 0.7],
  ] as const) {
    const [x, y, radius, roughness] = mass;
    const rock = boulder({
      radius,
      roughness,
      stretch: [1.5, y === height + face * 0.3 ? 0.7 : 1.35, 1.1],
      segments: budget > 1800 ? 9 : budget > 800 ? 7 : 5,
      facets: budget > 900,
      sink: y > 1 ? 0 : radius * 0.5,
      seed: (options.seed ?? 857) + Math.round(x * 10) + 5,
    });
    rock.translate(x, y, 0);
    builder.add(take(spent, rock), undefined, 'stone-rough');
  }
  // The mouth itself: a dark recess set back into the face, and a floor of
  // crushed rock running out of it.
  const recess = box(width, height, 0.5, { bevel: 0, bevelSegments: 1 });
  recess.translate(0, height / 2, 0.2);
  builder.add(take(spent, recess), undefined, 'soil');
  const floorSlab = box(width * 1.2, 0.06, 1.4, { bevel: 0.01, bevelSegments: 1 });
  floorSlab.translate(0, 0.03, 0.6);
  const floorData = affordable(spent, floorSlab, budget);
  if (floorData) builder.add(floorData, undefined, 'gravel');

  if (style === 'stone') {
    // A masonry arch over the mouth, with a low wall each side of it.
    const ring = arch({
      span: width,
      rise: height * 0.34,
      thickness: 0.34,
      depth: 0.8,
      segments: budget > 1800 ? 16 : budget > 800 ? 10 : 6,
      voussoirs: budget > 1800,
      style: 'segmental',
    });
    ring.translate(0, height * 0.78, -0.1);
    builder.add(take(spent, ring), undefined, 'stone-dressed');
    for (const side of [-1, 1]) {
      const jamb = pier(0.5, height * 0.82, 0.8, (options.seed ?? 857) + 13 + side, budget > 2200);
      jamb.translate(side * (width / 2 + 0.25), 0, -0.1);
      builder.add(take(spent, jamb), undefined, 'stone-dressed');
    }
  } else if (style === 'timber') {
    // A three-piece set: two legs and a head, the whole of a timber portal, and
    // the reason the hillside stays where it is.
    const section = Math.max(0.16, width * 0.12);
    for (const side of [-1, 1]) {
      const leg = box(section, height * 1.02, section, { bevel: section * 0.12, bevelSegments: 1 });
      leg.translate(side * (width / 2 + section / 2), height * 0.51, 0.3);
      builder.add(take(spent, leg), undefined, 'wood-dark');
    }
    const head = box(width + section * 2.4, section * 1.1, section * 1.2, { bevel: section * 0.1, bevelSegments: 1 });
    head.translate(0, height + section * 0.4, 0.3);
    builder.add(take(spent, head), undefined, 'wood-dark');
    // Lagging behind the head: boards holding the rock above the mouth.
    const lagging = planks({
      width: width + section * 2,
      height: height * 0.5,
      thickness: 0.045,
      count: budget > 1200 ? 6 : 4,
      horizontal: true,
      seed: (options.seed ?? 857) + 19,
    });
    lagging.translate(0, height * 0.72, 0.52);
    const lagData = affordable(spent, lagging, budget);
    if (lagData) builder.add(lagData, undefined, 'wood-weathered');
    for (const side of [-1, 1]) {
      const brace = timber(
        [side * (width / 2 + section * 1.4), 0, 0.3],
        [side * (width / 2 + section * 0.5), height * 0.86, 0.3],
        section * 0.5,
      );
      const data = affordable(spent, brace, budget);
      if (data) builder.add(data, undefined, 'wood-dark');
    }
  } else {
    // A bare adit: the rock holds itself, and the only timber is a prop left
    // where a miner thought the roof looked soft.
    const prop = box(0.13, height * 0.94, 0.13, { bevel: 0.016, bevelSegments: 1 });
    prop.rotateZ(range(rng, -0.08, 0.08));
    prop.translate(width * 0.32, height * 0.47, 0.24);
    builder.add(take(spent, prop), undefined, 'wood-weathered');
    const cap = box(width * 0.6, 0.11, 0.15, { bevel: 0.014, bevelSegments: 1 });
    cap.translate(width * 0.16, height * 0.94, 0.24);
    const capData = affordable(spent, cap, budget);
    if (capData) builder.add(capData, undefined, 'wood-weathered');
  }

  if (options.track ?? true) {
    // Rails on sleepers: two rails and the ties under them, running out of the
    // mouth toward the tip.
    for (const side of [-1, 1]) {
      const rail = box(0.06, 0.09, 2.4, { bevel: 0.008, bevelSegments: 1 });
      rail.translate(side * width * 0.28, 0.11, 1.5);
      const data = affordable(spent, rail, budget);
      if (data) builder.add(data, undefined, IRON);
    }
    const sleepers = Math.max(3, budget > 1200 ? 7 : 4);
    for (let index = 0; index < sleepers; index += 1) {
      const sleeper = box(width * 0.78, 0.07, 0.14, { bevel: 0.008, bevelSegments: 1 });
      sleeper.translate(0, 0.05, 0.5 + (index * 2.1) / Math.max(1, sleepers - 1));
      const data = affordable(spent, sleeper, budget);
      if (data) builder.add(data, undefined, 'wood-weathered');
    }
  }

  if (options.headframe ?? true) {
    // An A-frame over the shaft with a pulley at the top and a bucket on a rope:
    // the silhouette that says this hole is worked, not merely open.
    const frameTop = height + 1.7;
    for (const side of [-1, 1]) {
      for (const depth of [-0.5, 0.9]) {
        const leg = timber(
          [side * width * 0.62, 0, depth],
          [side * width * 0.18, frameTop, 0.2],
          0.1,
        );
        const data = affordable(spent, leg, budget);
        if (data) builder.add(data, undefined, 'wood-dark');
      }
    }
    const pulley = wheel({ radius: 0.26, width: 0.06, spokes: 8, iron: true, dished: 0, seed: (options.seed ?? 857) + 37 });
    pulley.rotateY(Math.PI / 2);
    pulley.translate(0, frameTop - 0.3, 0.2);
    const pulleyData = affordable(spent, pulley, budget);
    if (pulleyData) builder.add(pulleyData, undefined, IRON);
    const haul = chain({ from: [0, frameTop - 0.3, 0.42], to: [0, 0.5, 0.9], link: 0.08, radius: 0.014, sag: 0.08 });
    const haulData = affordable(spent, haul, budget);
    if (haulData) builder.add(haulData, undefined, 'chain');
    const bucket = cask({ height: 0.4, radius: 0.2, staves: 8, hoops: 2, seed: (options.seed ?? 857) + 43 });
    bucket.translate(0, 0.42, 0.9);
    const bucketData = affordable(spent, bucket, budget);
    if (bucketData) builder.add(bucketData, undefined, 'wood-dark');
  }

  if (options.lamp ?? true) {
    // A caged lamp hung on the portal, burning behind iron.
    const cage = cylinder(0.075, 0.06, 0.18, { radialSegments: 6 });
    cage.translate(width * 0.3, height * 0.72, 0.44);
    const cageData = affordable(spent, cage, budget);
    if (cageData) builder.add(cageData, undefined, IRON);
    const fire = flame({ height: 0.13, radius: 0.045, layers: 2 });
    fire.translate(width * 0.3, height * 0.68, 0.44);
    const fireData = affordable(spent, fire, budget);
    if (fireData) builder.add(fireData, undefined, 'glass-warm');
  }

  if (options.spoil ?? true) {
    // The tip: a heap of what came out, with the largest lumps rolled to the toe.
    const heap = boulder({
      radius: 0.85,
      roughness: 0.85,
      stretch: [1.5, 0.52, 1.2],
      segments: budget > 1800 ? 8 : 5,
      facets: true,
      sink: 0.42,
      seed: (options.seed ?? 857) + 61,
    });
    heap.translate(width / 2 + face * 0.5, 0, 1.5);
    const heapData = affordable(spent, heap, budget);
    if (heapData) builder.add(heapData, undefined, 'gravel');
    const lumps = budget > 1400 ? 5 : 3;
    for (let index = 0; index < lumps; index += 1) {
      const lump = boulder({
        radius: range(rng, 0.09, 0.18),
        roughness: 0.9,
        facets: true,
        sink: 0.3,
        segments: 5,
        seed: (options.seed ?? 857) + 71 + index,
      });
      lump.translate(width / 2 + face * 0.5 + range(rng, -0.9, 0.9), 0, 2.3 + range(rng, -0.3, 0.5));
      const data = affordable(spent, lump, budget);
      if (data) builder.add(data, undefined, 'stone-rough');
    }
  }

  // The hillside is sunk into the ground on purpose — a portal cut into a hill
  // has rock going down below the surface it is cut into — so seating this model
  // on its lowest point would lift the whole entrance into the air. It is
  // centred over the origin and left as deep as it was dug.
  const bounds = builder.bounds();
  builder.translate(-bounds.center[0], 0, -bounds.center[2]);
  return builder;
}

export interface HaystackOptions {
  /** Radius of a round stack, half the length of a long one. */
  radius?: number;
  /** Height of the stack above the ground. */
  height?: number;
  /** `round` is a conical rick, `long` a ridge of hay, `rick` a square stack with a thatched cap. */
  style?: 'round' | 'long' | 'rick';
  /** A net of rope over the stack, weighted at the eaves. */
  netting?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A haystack: a year of a field, stacked so that the weather runs off it.
 *
 * The stack is a surface of straw, so the shape is the whole of the work — a
 * round rick is a lathe profile that bellies at the bottom and rounds at the
 * top, a long stack is that section extruded along a ridge, and a square rick
 * is boards with a thatched cap on it. All three are lumpy, because hay settles
 * where it was thrown, so the profile is displaced and the base is left alone,
 * and all three throw wisps, because straw that has been stacked outdoors has
 * strands pulled out of it by every wind.
 */
export function haystack(options: HaystackOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 863);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const style = options.style ?? 'round';
  const radius = Math.max(0.5, options.radius ?? 1.2);
  const height = Math.max(0.8, options.height ?? 2);
  const segments = budget > 1400 ? 16 : budget > 700 ? 12 : 9;

  /**
   * The section of a rick: wide at the foot where the hay was trampled, belly
   * at a third of the height, shoulder, then a rounded crown that sheds rain.
   */
  const section = (r: number, h: number): [number, number][] => {
    const points = budget > 1200 ? 9 : 6;
    const profile: [number, number][] = [];
    for (let index = 0; index <= points; index += 1) {
      const t = index / points;
      const belly = 1 + 0.09 * Math.sin(t * Math.PI * 0.9);
      const taper = t < 0.62 ? belly : 1 - Math.pow((t - 0.62) / 0.38, 1.7) * 0.94;
      profile.push([Math.max(0.02, r * taper), t * h]);
    }
    return profile;
  };

  if (style === 'long') {
    // A ridge of hay: the same section, extruded along its length, with the
    // crown flattened into a ridge so the rain has somewhere to run to.
    const length = radius * 2.6;
    const profile = section(radius * 0.78, height);
    const stack = extrude(profile, { depth: length, bevel: radius * 0.16, bevelSegments: 1, caps: true });
    stack.rotateY(Math.PI / 2);
    stack.translate(-length / 2, 0, 0);
    displace(stack, { amplitude: radius * 0.05, frequency: 2.4, octaves: 2, preserveBase: true, recompute: true, seed: (options.seed ?? 863) + 7 });
    builder.add(take(spent, stack), undefined, 'thatch');
    const ridge = box(length * 0.96, 0.12, radius * 0.5, { bevel: 0.05, bevelSegments: 1 });
    ridge.translate(0, height + 0.02, 0);
    const ridgeData = affordable(spent, ridge, budget);
    if (ridgeData) builder.add(ridgeData, undefined, 'thatch');
  } else if (style === 'rick') {
    // A square rick: a stack of trusses, a thatched cap pitched over it and a
    // course of boards at the foot to keep the bottom straw out of the mud.
    const side = radius * 1.5;
    const body = box(side, height * 0.72, side, { bevel: side * 0.05, bevelSegments: 1 });
    displace(body, { amplitude: side * 0.03, frequency: 3, octaves: 2, preserveBase: true, recompute: true, seed: (options.seed ?? 863) + 11 });
    body.translate(0, height * 0.36, 0);
    builder.add(take(spent, body), undefined, 'thatch');
    const capHeight = height * 0.3;
    const pitch = Math.atan2(capHeight, side / 2);
    const slope = Math.hypot(side / 2, capHeight);
    for (const sideSign of [-1, 1]) {
      const panel = roofPanel({
        width: side * 1.1,
        slopeLength: slope * 1.06,
        style: 'thatch',
        overhang: 0.14,
        budget: Math.max(160, Math.floor((budget - spent.spent) / 3)),
        seed: (options.seed ?? 863) + 17 + sideSign,
      });
      if (sideSign < 0) panel.mirror('z');
      panel.rotateX(sideSign * pitch);
      panel.translate(0, height * 0.72 + capHeight, 0);
      const data = affordable(spent, panel, budget);
      if (data) builder.add(data, undefined, 'thatch');
    }
    const foot = box(side * 1.06, 0.14, side * 1.06, { bevel: 0.02, bevelSegments: 1 });
    foot.translate(0, 0.07, 0);
    const footData = affordable(spent, foot, budget);
    if (footData) builder.add(footData, undefined, 'wood-weathered');
  } else {
    // A round rick, which is the shape a stack takes when it is built by hand
    // from the middle outward.
    const stack = lathe(section(radius, height), { segments, caps: true });
    displace(stack, { amplitude: radius * 0.055, frequency: 2.6, octaves: 2, preserveBase: true, recompute: true, seed: (options.seed ?? 863) + 3 });
    builder.add(take(spent, stack), undefined, 'thatch');
    // A cap of thatch over the crown, tied down against the wind.
    const cap = lathe(section(radius * 0.52, height * 0.2), { segments: Math.max(8, segments - 4), caps: false });
    cap.translate(0, height * 0.86, 0);
    const capData = affordable(spent, cap, budget);
    if (capData) builder.add(capData, undefined, 'thatch');
  }

  // A base of trodden ground and litter, so the stack stands on something.
  const litter = cylinder(radius * 1.24, radius * 1.34, 0.06, { radialSegments: Math.max(8, segments - 2) });
  litter.translate(0, 0.03, 0);
  // Charged, because this is the footprint the stack is swept for: a rick that
  // loses its trodden ground at a poor budget is placed in a smaller hole.
  builder.add(take(spent, litter), undefined, 'soil');

  if (options.netting ?? style !== 'long') {
    // Rope over the crown and down both sides, weighted at the eaves: how a
    // thatched stack is held together in a wind.
    for (const sideSign of [-1, 1]) {
      const path: Vec3[] = [];
      const points = 7;
      for (let index = 0; index <= points; index += 1) {
        const t = index / points;
        const profile = section(radius, height);
        const at = profile[Math.min(profile.length - 1, Math.round(t * (profile.length - 1)))]!;
        path.push([sideSign * at[0] * 1.01, at[1], 0]);
      }
      const net = rope({ path, radius: 0.018, strands: 2, twist: 4, segments: 12 });
      const data = affordable(spent, net, budget);
      if (data) builder.add(data, undefined, 'rope');
      const weight = sphere(0.06, { widthSegments: 6, heightSegments: 5 });
      weight.translate(sideSign * radius * 1.06, 0.14, 0);
      const weightData = affordable(spent, weight, budget);
      if (weightData) builder.add(weightData, undefined, 'stone-rough');
    }
  }

  // Wisps pulled out of the surface, which is what makes straw read as straw
  // rather than as a smooth brown solid.
  const wisps = Math.max(4, Math.min(24, Math.floor((budget - spent.spent) / 9)));
  for (let index = 0; index < wisps; index += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const t = range(rng, 0.18, 0.92);
    const at = section(radius, height)[Math.round(t * (budget > 1200 ? 9 : 6))]!;
    const strand = spike({ height: range(rng, 0.16, 0.34), radius: 0.016, sides: 3 });
    strand.rotateZ(Math.PI / 2 - range(rng, 0.5, 1.1));
    strand.rotateY(angle);
    strand.translate(Math.cos(angle) * at[0] * 0.96, at[1], Math.sin(angle) * at[0] * 0.96);
    const data = affordable(spent, strand, budget);
    if (data) builder.add(data, undefined, chance(rng, 0.3) ? 'grass' : 'thatch');
  }

  seatOnGround(builder);
  return builder;
}

export interface CropRowOptions {
  /** Length of the row along X, in metres. */
  length?: number;
  /** Width of the row along Z. */
  width?: number;
  /** What is growing: `wheat`, `maize`, `cabbage`, `vine` or `bean`. */
  crop?: 'wheat' | 'maize' | 'cabbage' | 'vine' | 'bean';
  /** Parallel rows side by side. */
  rows?: number;
  /** Stakes and a wire, for anything that climbs. */
  stakes?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A crop row: a ridge of soil with a year's planting on it.
 *
 * The ridge is extruded so it has a real profile — flat at the furrow, crowned
 * where the roots are — and the plants are the repetition, so the allowance
 * decides how many of them stand in the row and not how long the row is. A poor
 * wheat field is a sparse one, which is what a poor wheat field is; it is not a
 * short one, because the field was measured out before the seed was bought.
 */
export function cropRow(options: CropRowOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 877);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const crop = options.crop ?? 'wheat';
  const length = Math.max(1, options.length ?? 3);
  const rowWidth = Math.max(0.4, options.width ?? 1);
  const rows = Math.max(1, Math.round(options.rows ?? 1));
  const climbing = crop === 'vine' || crop === 'bean';
  const stakes = options.stakes ?? climbing;
  const tall = crop === 'maize';
  const height = tall ? 1.7 : climbing ? 1.1 : 0.85;

  for (let row = 0; row < rows; row += 1) {
    const z = rows === 1 ? 0 : -((rows - 1) * rowWidth) / 2 + row * rowWidth;
    // The ridge: a crowned profile extruded along the length of the row.
    const profile: [number, number][] = [
      [-rowWidth * 0.44, 0],
      [-rowWidth * 0.3, 0.1],
      [0, 0.15],
      [rowWidth * 0.3, 0.1],
      [rowWidth * 0.44, 0],
    ];
    const ridge = extrude(profile, { depth: length, bevel: 0.02, bevelSegments: 1, caps: true });
    ridge.rotateY(Math.PI / 2);
    ridge.translate(-length / 2, 0, z);
    builder.add(take(spent, ridge), undefined, 'soil');

    const stations = Math.max(3, Math.round(length / (tall ? 0.42 : crop === 'cabbage' ? 0.34 : 0.24)));
    const unit = crop === 'cabbage'
      ? leafCluster({ radius: 0.15, leaves: 12, length: 0.16, width: 0.1, clumps: 1, seed: (options.seed ?? 877) + 5 })
      : tuft({ height: height * (climbing ? 0.7 : 1), blades: tall ? 9 : 7, radius: rowWidth * 0.16, seed: (options.seed ?? 877) + 5 });
    const planted = units(spent, unit, budget, Math.max(2, Math.round(stations * 0.4)), stations);
    for (let index = 0; index < planted; index += 1) {
      const x = -length / 2 + 0.14 + (index * (length - 0.28)) / Math.max(1, planted - 1);
      if (crop === 'cabbage') {
        const head = leafCluster({
          radius: range(rng, 0.12, 0.17),
          leaves: budget > 1200 ? 16 : 11,
          length: 0.17,
          width: 0.11,
          clumps: 1,
          seed: (options.seed ?? 877) + index * 7,
        });
        head.translate(x + range(rng, -0.03, 0.03), 0.16, z + range(rng, -0.04, 0.04));
        const data = affordable(spent, head, budget);
        if (data) builder.add(data, undefined, 'foliage-olive');
      } else if (tall) {
        // Maize: a stalk, leaves that droop from it, and a tassel at the top.
        const stalk = cylinder(0.019, 0.028, height * 0.92, { radialSegments: 5 });
        stalk.translate(x, 0.15 + height * 0.46, z);
        const stalkData = affordable(spent, stalk, budget);
        if (stalkData) builder.add(stalkData, undefined, 'foliage-olive');
        const leaves = budget > 1400 ? 5 : 3;
        for (let blade_ = 0; blade_ < leaves; blade_ += 1) {
          const leaf = blade({
            length: range(rng, 0.4, 0.62),
            width: 0.055,
            widest: 0.3,
            droop: 0.5,
            twist: range(rng, -0.4, 0.4),
            segments: 5,
            across: 2,
          });
          leaf.rotateY((blade_ / leaves) * Math.PI * 2 + range(rng, -0.3, 0.3));
          leaf.translate(x, 0.15 + height * range(rng, 0.35, 0.8), z);
          const data = affordable(spent, leaf, budget);
          if (data) builder.add(data, undefined, 'foliage');
        }
        const tassel = spike({ height: 0.22, radius: 0.026, sides: 4 });
        tassel.translate(x, 0.15 + height * 0.92, z);
        const tasselData = affordable(spent, tassel, budget);
        if (tasselData) builder.add(tasselData, undefined, 'thatch');
      } else if (climbing) {
        // A climber: a stake, a wire between the stakes, and the plant on both.
        const stake = post({ height: height, radius: 0.021, sides: 5, cap: 'pointed', seed: (options.seed ?? 877) + index });
        stake.translate(x, 0.14, z);
        const stakeData = affordable(spent, stake, budget);
        if (stakeData) builder.add(stakeData, undefined, 'wood-weathered');
        const plant = tuft({ height: height * 0.82, blades: 8, radius: rowWidth * 0.14, seed: (options.seed ?? 877) + index * 11 });
        plant.translate(x, 0.15, z);
        const data = affordable(spent, plant, budget);
        if (data) builder.add(data, undefined, 'foliage-dark');
        if (crop === 'bean' && budget > 1200) {
          for (let pod = 0; pod < 3; pod += 1) {
            const bean = cylinder(0.011, 0.011, 0.11, { radialSegments: 4 });
            bean.rotateZ(range(rng, -0.9, 0.9));
            bean.translate(x + range(rng, -0.07, 0.07), 0.15 + height * range(rng, 0.3, 0.7), z + range(rng, -0.05, 0.05));
            const podData = affordable(spent, bean, budget);
            if (podData) builder.add(podData, undefined, 'foliage-olive');
          }
        }
        if (crop === 'vine' && budget > 1200) {
          const bunch = sphere(0.05, { widthSegments: 5, heightSegments: 4, radii: [0.045, 0.068, 0.045] });
          bunch.translate(x + range(rng, -0.06, 0.06), 0.15 + height * range(rng, 0.4, 0.66), z + range(rng, -0.05, 0.05));
          const bunchData = affordable(spent, bunch, budget);
          if (bunchData) builder.add(bunchData, undefined, 'crystal-violet');
        }
      } else {
        // Wheat: a tuft of straw with an ear on top of it.
        const plant = tuft({ height: height * range(rng, 0.86, 1.04), blades: budget > 1200 ? 10 : 7, radius: rowWidth * 0.13, seed: (options.seed ?? 877) + index * 13 });
        plant.translate(x, 0.14, z + range(rng, -0.03, 0.03));
        const data = affordable(spent, plant, budget);
        if (data) builder.add(data, undefined, 'thatch');
        if (budget > 900) {
          const ear = spike({ height: 0.17, radius: 0.021, sides: 4 });
          ear.rotateZ(range(rng, -0.3, 0.3));
          ear.translate(x, 0.14 + height * 0.86, z);
          const earData = affordable(spent, ear, budget);
          if (earData) builder.add(earData, undefined, 'grass');
        }
      }
    }

    // A wire along the stakes, which is what a climber is actually grown on.
    if (stakes && climbing) {
      for (const at of [height * 0.42, height * 0.78]) {
        const wire = rope({
          path: [[-length / 2 + 0.1, 0.15 + at, z], [length / 2 - 0.1, 0.15 + at, z]],
          radius: 0.008,
          strands: 2,
          twist: 6,
          segments: 8,
        });
        const data = affordable(spent, wire, budget);
        if (data) builder.add(data, undefined, 'rope');
      }
    }
  }
  if (stakes && !climbing) {
    // A row of wheat is sometimes staked and tied against lodging.
    for (const end of [-1, 1]) {
      const stake = post({ height: 0.9, radius: 0.026, sides: 5, cap: 'pointed', seed: (options.seed ?? 877) + 91 });
      stake.translate(end * (length / 2 - 0.1), 0, 0);
      const data = affordable(spent, stake, budget);
      if (data) builder.add(data, undefined, 'wood-weathered');
    }
  }

  seatOnGround(builder);
  return builder;
}

export interface ScarecrowOptions {
  /** Height of the top of the hat above the ground. */
  height?: number;
  /** `rag` is a dressed figure in torn cloth, `straw` a bundle on a post, `coat` a long coat with buttons. */
  dress?: 'rag' | 'straw' | 'coat';
  /** A hat: a cone of thatch or a soft cap. */
  hat?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A scarecrow: a figure on a post, dressed to move in the wind.
 *
 * The post and the arms carry the height and the span and are charged. The
 * head, the hat, the clothing and the straw are representation, and they are
 * what a poor allowance takes away in that order — a scarecrow with no coat is
 * still a scarecrow, and a post with nothing on it is a post. Everything soft
 * here is built to hang or to splay, because a scarecrow's whole business is
 * being mistaken for a person from two hundred metres and moving when it is not.
 */
export function scarecrow(options: ScarecrowOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 881);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const dress = options.dress ?? 'rag';
  const height = Math.max(1.2, options.height ?? 1.9);
  const shoulder = height * 0.78;
  const armSpan = 0.42;

  // The post, driven into the ground, and the arms across it.
  const post_ = post({ height: shoulder + 0.1, radius: 0.038, sides: 6, cap: 'flat', seed: (options.seed ?? 881) + 3 });
  post_.translate(0, 0, 0);
  builder.add(take(spent, post_), undefined, 'wood-weathered');
  const arms = box(armSpan * 2, 0.05, 0.05, { bevel: 0.008, bevelSegments: 1 });
  arms.rotateZ(range(rng, -0.09, 0.09));
  arms.translate(0, shoulder, 0);
  builder.add(take(spent, arms), undefined, 'wood-weathered');

  // The head: a sack drawn tight at the neck, tilted because the post is.
  const head = sphere(0.105, {
    widthSegments: budget > 900 ? 12 : 8,
    heightSegments: budget > 900 ? 9 : 6,
    radii: [0.105, 0.122, 0.1],
  });
  head.rotateZ(range(rng, -0.16, 0.16));
  head.translate(0, shoulder + 0.2, 0.01);
  const headData = affordable(spent, head, budget);
  if (headData) builder.add(headData, undefined, 'fabric-linen');
  const neck = rope({
    path: [[0, shoulder + 0.06, 0], [0, shoulder + 0.13, 0.01]],
    radius: 0.012,
    strands: 2,
    twist: 5,
    segments: 5,
  });
  const neckData = affordable(spent, neck, budget);
  if (neckData) builder.add(neckData, undefined, 'rope');

  if (options.hat ?? true) {
    // A thatch cone: the brim is a shallow prism and the crown a smaller one.
    const brim = prism({ sides: budget > 900 ? 10 : 7, radius: 0.22, height: 0.05, topScale: 0.7, caps: true });
    brim.rotateZ(range(rng, -0.1, 0.1));
    brim.translate(0, shoulder + 0.28, 0.01);
    const brimData = affordable(spent, brim, budget);
    if (brimData) builder.add(brimData, undefined, 'thatch');
    const crown = prism({ sides: budget > 900 ? 10 : 7, radius: 0.15, height: 0.2, topScale: 0.34, caps: true });
    crown.translate(0, shoulder + 0.32, 0.01);
    const crownData = affordable(spent, crown, budget);
    if (crownData) builder.add(crownData, undefined, 'thatch');
  }

  if (dress === 'coat') {
    // A long coat: a lathe from the shoulders to below the knee, flaring, with
    // buttons down the front and the hem left ragged.
    const hem = height * 0.3;
    const profile: [number, number][] = [];
    const points = budget > 1200 ? 8 : 5;
    for (let index = 0; index <= points; index += 1) {
      const t = index / points;
      profile.push([0.14 + t * 0.13 + Math.sin(t * 3) * 0.012, shoulder - t * (shoulder - hem)]);
    }
    const coat = lathe(profile, { segments: budget > 1400 ? 16 : 11, caps: false });
    coat.translate(0, 0, 0.01);
    builder.add(take(spent, coat), undefined, 'fabric-blue');
    if (budget > 1100) {
      for (let index = 0; index < 4; index += 1) {
        const button = sphere(0.012, { widthSegments: 5, heightSegments: 4 });
        button.translate(0, hem + (shoulder - hem) * (0.2 + index * 0.2), 0.16);
        const data = affordable(spent, button, budget);
        if (data) builder.add(data, undefined, 'brass');
      }
    }
    // Sleeves along the arms, tied at the wrists.
    for (const side of [-1, 1]) {
      const sleeve = cylinder(0.052, 0.062, armSpan * 0.92, { radialSegments: 6 });
      sleeve.rotateZ(Math.PI / 2);
      sleeve.translate(side * armSpan * 0.5, shoulder - 0.01, 0.01);
      const data = affordable(spent, sleeve, budget);
      if (data) builder.add(data, undefined, 'fabric-blue');
    }
  } else if (dress === 'rag') {
    // Torn cloth over the shoulders, hanging in strips, and straw coming out of
    // every opening: the neck, the cuffs and the hem.
    const sheet = cloth(
      0.62,
      height * 0.44,
      budget > 1200 ? 7 : 5,
      5,
      (u: number, v: number) => Math.sin(u * Math.PI) * 0.06 - Math.pow(v, 3) * 0.14,
    );
    sheet.translate(0, shoulder - height * 0.2, 0.04);
    builder.add(take(spent, sheet), undefined, 'fabric');
    const strips = Math.max(3, budget > 1200 ? 7 : 4);
    for (let index = 0; index < strips; index += 1) {
      const strip = box(0.045, height * range(rng, 0.14, 0.3), 0.008, { bevel: 0, bevelSegments: 1 });
      strip.rotateZ(range(rng, -0.2, 0.2));
      strip.translate(-0.28 + (index * 0.56) / Math.max(1, strips - 1), shoulder - height * 0.36, 0.06);
      const data = affordable(spent, strip, budget);
      if (data) builder.add(data, undefined, chance(rng, 0.4) ? 'fabric-linen' : 'fabric');
    }
  } else {
    // No clothes at all: a bundle of straw tied to a cross.
    void dress;
  }

  // Straw at the neck, the cuffs and the hem, which is what gives the figure
  // away at fifty paces and what the crows are actually afraid of moving.
  const tufts = Math.max(4, Math.min(18, Math.floor((budget - spent.spent) / 14)));
  for (let index = 0; index < tufts; index += 1) {
    const at = index % 3;
    const origin: Vec3 = at === 0
      ? [0, shoulder + 0.1, 0.02]
      : at === 1
        ? [index % 2 === 0 ? -armSpan : armSpan, shoulder - 0.02, 0.02]
        : [range(rng, -0.18, 0.18), height * 0.34, 0.05];
    const wisp = tuft({ height: range(rng, 0.16, 0.3), blades: 5, radius: 0.05, seed: (options.seed ?? 881) + index * 17 });
    wisp.rotateZ(range(rng, -1.1, 1.1));
    wisp.rotateY(range(rng, 0, Math.PI * 2));
    wisp.translate(origin[0], origin[1], origin[2]);
    const data = affordable(spent, wisp, budget);
    if (data) builder.add(data, undefined, 'thatch');
  }

  seatOnGround(builder);
  return builder;
}

export interface LoomOptions {
  /** Width of the warp, in metres. */
  width?: number;
  /** Height of the frame. */
  height?: number;
  /** `floor` is a treadle loom, `upright` a warp-weighted loom, `tapestry` a wide upright frame. */
  style?: 'floor' | 'upright' | 'tapestry';
  /** Threads stretched in the frame. */
  warp?: boolean;
  /** A bench in front of a floor loom, where the weaver sits. */
  bench?: boolean;
  wood?: WorkWood;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A loom: a frame that holds threads under tension so other threads can cross them.
 *
 * A floor loom stands on four posts and works with two shafts and two treadles
 * at the weaver's feet, the warp running from the beam at the back to the cloth
 * beam at the front. An upright loom leans against nothing at all: the warp
 * hangs from the top beam and is held in tension by clay weights at the bottom,
 * which is the oldest way of doing it and needs no pit and no treadles. The
 * frame is charged, the warp and the weights are what the allowance buys.
 */
export function loom(options: LoomOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 883);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'oak'];
  const style = options.style ?? 'floor';
  const width = Math.max(0.6, options.width ?? 1.4);
  const height = Math.max(0.9, options.height ?? (style === 'floor' ? 1.6 : 1.7));
  const depth = style === 'floor' ? 0.95 : 0.3;
  const member = Math.max(0.05, width * 0.055);

  if (style === 'floor') {
    // Four posts, a warp beam at the back top and a cloth beam at the front.
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        const post_ = box(member, height, member, { bevel: member * 0.14, bevelSegments: 1 });
        post_.translate(side * (width / 2), height / 2, end * (depth / 2 - member / 2));
        builder.add(take(spent, post_), undefined, wood);
      }
    }
    for (const end of [-1, 1]) {
      const beam = cylinder(member * 0.62, member * 0.62, width + member, { radialSegments: budget > 1200 ? 10 : 7 });
      beam.rotateZ(Math.PI / 2);
      beam.translate(0, height * (end < 0 ? 0.86 : 0.62), end * (depth / 2 - member / 2));
      builder.add(take(spent, beam), undefined, wood);
    }
    // The warp: a sheet of threads from the back beam down to the cloth beam.
    if (options.warp ?? true) {
      const threads = Math.max(6, Math.min(40, Math.floor((budget - spent.spent) / 8)));
      for (let index = 0; index < threads; index += 1) {
        const x = -width / 2 + member + (index * (width - member * 2)) / Math.max(1, threads - 1);
        const thread = timber(
          [x, height * 0.86, -depth / 2 + member / 2],
          [x, height * 0.62, depth / 2 - member / 2],
          0.008,
          3,
        );
        const data = affordable(spent, thread, budget);
        if (data) builder.add(data, undefined, 'fabric-linen');
      }
      // The cloth already woven, rolled on the front beam.
      const roll = cylinder(member * 0.72, member * 0.72, width * 0.86, { radialSegments: 9 });
      roll.rotateZ(Math.PI / 2);
      roll.translate(0, height * 0.62, depth / 2 - member / 2);
      const rollData = affordable(spent, roll, budget);
      if (rollData) builder.add(rollData, undefined, 'fabric');
    }
    // Two heddle shafts, hanging between the beams: the frames that lift every
    // other thread, and the reason a loom can weave anything at all.
    for (let index = 0; index < 2; index += 1) {
      const shaft = box(width * 0.94, member * 0.4, member * 0.5, { bevel: 0.006, bevelSegments: 1 });
      shaft.translate(0, height * (0.72 - index * 0.06), -depth * 0.06 + index * 0.1);
      const data = affordable(spent, shaft, budget);
      if (data) builder.add(data, undefined, wood);
      const lower = box(width * 0.94, member * 0.34, member * 0.44, { bevel: 0.006, bevelSegments: 1 });
      lower.translate(0, height * (0.42 - index * 0.05), -depth * 0.06 + index * 0.1);
      const lowerData = affordable(spent, lower, budget);
      if (lowerData) builder.add(lowerData, undefined, wood);
    }
    // Treadles at the weaver's feet, pivoting at the back.
    for (const side of [-1, 1]) {
      const treadle = box(width * 0.3, 0.035, depth * 0.52, { bevel: 0.006, bevelSegments: 1 });
      treadle.rotateX(side * 0.12);
      treadle.translate(side * width * 0.22, 0.16, depth * 0.1);
      const data = affordable(spent, treadle, budget);
      if (data) builder.add(data, undefined, wood);
      const cord = rope({
        path: [[side * width * 0.22, 0.18, depth * 0.02], [side * width * 0.22, height * 0.44, -depth * 0.06]],
        radius: 0.007,
        strands: 2,
        twist: 5,
        segments: 6,
      });
      const cordData = affordable(spent, cord, budget);
      if (cordData) builder.add(cordData, undefined, 'rope');
    }
    if (options.bench ?? true) {
      // The weaver's bench: a board on four legs, at sitting height.
      const seat = box(width * 0.9, 0.05, 0.3, { bevel: 0.008, bevelSegments: 1 });
      seat.translate(0, 0.45, depth / 2 + 0.34);
      const seatData = affordable(spent, seat, budget);
      if (seatData) builder.add(seatData, undefined, wood);
      for (const side of [-1, 1]) {
        for (const end of [-1, 1]) {
          const leg = box(0.045, 0.44, 0.045, { bevel: 0.006, bevelSegments: 1 });
          leg.translate(side * width * 0.38, 0.22, depth / 2 + 0.34 + end * 0.11);
          const data = affordable(spent, leg, budget);
          if (data) builder.add(data, undefined, wood);
        }
      }
      // A shuttle left on the bench.
      const shuttle = lathe([[0, 0], [0.024, 0.03], [0.028, 0.09], [0.018, 0.16], [0, 0.19]], { segments: 7, caps: true });
      shuttle.rotateZ(Math.PI / 2);
      shuttle.translate(width * 0.16, 0.5, depth / 2 + 0.34);
      const shuttleData = affordable(spent, shuttle, budget);
      if (shuttleData) builder.add(shuttleData, undefined, 'wood-dark');
    }
  } else {
    // An upright loom: two posts, a top beam the warp hangs from, a bottom beam
    // and clay weights holding the tension. It leans against a wall in use, and
    // a model that leans is a model that falls over in an empty field, so it
    // stands on its own two feet with a foot brace.
    const lean = 0.1;
    for (const side of [-1, 1]) {
      const post_ = timber([side * width / 2, 0, 0], [side * width / 2 - side * lean * 0.4, height, 0], member);
      builder.add(take(spent, post_), undefined, wood);
    }
    const topBeam = cylinder(member * 0.66, member * 0.66, width + member * 1.4, { radialSegments: budget > 1200 ? 10 : 7 });
    topBeam.rotateZ(Math.PI / 2);
    topBeam.translate(0, height - member * 0.4, 0);
    builder.add(take(spent, topBeam), undefined, wood);
    const bottomBeam = cylinder(member * 0.56, member * 0.56, width + member, { radialSegments: 8 });
    bottomBeam.rotateZ(Math.PI / 2);
    bottomBeam.translate(0, height * 0.22, depth * 0.2);
    const bottomData = affordable(spent, bottomBeam, budget);
    if (bottomData) builder.add(bottomData, undefined, wood);
    for (const side of [-1, 1]) {
      const brace = timber([side * width / 2, 0, 0], [side * width / 2, height * 0.24, depth * 0.62], member * 0.7);
      const data = affordable(spent, brace, budget);
      if (data) builder.add(data, undefined, wood);
    }
    if (options.warp ?? true) {
      // The warp hangs from the top beam and is weighted at the bottom, in
      // bundles rather than one thread per weight, which is how it is done.
      const bundles = Math.max(3, Math.min(16, Math.floor((budget - spent.spent) / 46)));
      for (let index = 0; index < bundles; index += 1) {
        const x = -width / 2 + member + (index * (width - member * 2)) / Math.max(1, bundles - 1);
        const threads = Math.max(2, budget > 1200 ? 4 : 3);
        for (let thread = 0; thread < threads; thread += 1) {
          const at = x + (thread - (threads - 1) / 2) * 0.016;
          const strand = timber([at, height - member * 0.4, 0], [at + range(rng, -0.01, 0.01), height * 0.3, depth * 0.1], 0.005, 3);
          const data = affordable(spent, strand, budget);
          if (data) builder.add(data, undefined, 'wool');
        }
        const weight = cylinder(0.038, 0.052, 0.075, { radialSegments: 7 });
        weight.translate(x, height * 0.27, depth * 0.1);
        const weightData = affordable(spent, weight, budget);
        if (weightData) builder.add(weightData, undefined, 'terracotta');
        const hole = torus(0.012, 0.004, { radialSegments: 3, tubularSegments: 7 });
        hole.rotateX(Math.PI / 2);
        hole.translate(x, height * 0.31, depth * 0.1);
        const holeData = affordable(spent, hole, budget);
        if (holeData) builder.add(holeData, undefined, 'terracotta');
      }
      // The band already woven, hanging from the top beam.
      const woven = box(width * 0.86, height * 0.3, 0.014, { bevel: 0.004, bevelSegments: 1 });
      woven.translate(0, height * 0.66, -member * 0.2);
      const wovenData = affordable(spent, woven, budget);
      if (wovenData) builder.add(wovenData, undefined, 'fabric');
    }
    if (style === 'tapestry' && budget > 1400) {
      // A basket of yarn at the foot of the frame.
      const basket = cask({ height: 0.24, radius: 0.17, bilge: 0.1, staves: 9, hoops: 1, seed: (options.seed ?? 883) + 19 });
      basket.translate(width * 0.42, 0, depth * 0.9);
      const data = affordable(spent, basket, budget);
      if (data) builder.add(data, undefined, 'wood-pine');
      for (let index = 0; index < 3; index += 1) {
        const ball = sphere(0.055, { widthSegments: 6, heightSegments: 5 });
        ball.translate(width * 0.42 + range(rng, -0.06, 0.06), 0.24, depth * 0.9 + range(rng, -0.05, 0.05));
        const ballData = affordable(spent, ball, budget);
        if (ballData) builder.add(ballData, undefined, index % 2 === 0 ? 'wool' : 'fabric-blue');
      }
    }
  }

  seatOnGround(builder);
  return builder;
}

export interface WaterWheelOptions {
  /** Radius of the wheel, in metres. */
  radius?: number;
  /** Axial width of the wheel. */
  width?: number;
  /**
   * `undershot` is driven by the current against flat paddles, `overshot` by
   * water poured into buckets at the top from a launder, `breast` by water
   * admitted at the middle into curved blades.
   */
  style?: 'undershot' | 'overshot' | 'breast';
  /** The launder that feeds an overshot or breast wheel. */
  chute?: boolean;
  /** Masonry or timber bearings carrying the axle. */
  frame?: boolean;
  /** A toothed pit wheel on the axle, driving the mill machinery. */
  gearing?: boolean;
  wood?: WorkWood;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A water wheel: the oldest engine in the library, and the simplest.
 *
 * The wheel is built in its own plane with its axle along Z, so it is rolled
 * with `rotateZ` and steered with `rotateY`, exactly as `wheel` is. The rim and
 * the spokes are charged because they are the wheel; the paddles and buckets
 * are the repetition, so the unit is counted and the allowance decides how many
 * of them the wheel carries — a wheel with eight buckets turns slower than a
 * wheel with sixteen and that is the honest trade. The launder, the bearings
 * and the pit wheel are all works around the wheel and are spent last.
 */
export function waterWheel(options: WaterWheelOptions = {}): MeshBuilder {
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'oak'];
  const style = options.style ?? 'overshot';
  const radius = Math.max(0.6, options.radius ?? 2);
  const width = Math.max(0.3, options.width ?? (style === 'undershot' ? 0.7 : 0.9));
  const hubY = radius * 1.02;
  const segments = budget > 2200 ? 24 : budget > 1000 ? 18 : 12;

  // Two rims, one at each side of the wheel, tied by the buckets between them.
  for (const side of [-1, 1]) {
    const rim = torus(radius, width * 0.06, {
      radialSegments: budget > 1200 ? 5 : 4,
      tubularSegments: segments,
    });
    rim.rotateX(Math.PI / 2);
    rim.translate(0, hubY, side * width / 2);
    builder.add(take(spent, rim), undefined, wood);
  }
  // Hub and spokes: a wheel is a disc with most of it missing. The rims above are
  // this wheel's felloes, so the spokes run from the hub straight out to them —
  // building a `wheel` here would pay for a second set of felloes, a tyre and two
  // collars, which is five hundred triangles of a thin allowance spent on parts
  // the wheel already has.
  const hub = cylinder(width * 0.17, width * 0.19, width * 0.92, { radialSegments: budget > 1200 ? 10 : 7 });
  hub.rotateX(Math.PI / 2);
  hub.translate(0, hubY, 0);
  builder.add(take(spent, hub), undefined, 'wood-dark');
  const spokes = budget > 1600 ? 12 : budget > 800 ? 10 : 7;
  const spokeUnit = box(width * 0.12, radius * 0.86, width * 0.16, { bevel: 0, bevelSegments: 1 });
  const spokeCount = units(spent, spokeUnit, budget, 5, spokes);
  for (let index = 0; index < spokeCount; index += 1) {
    const angle = (index / spokeCount) * Math.PI * 2;
    const spoke = box(width * 0.12, radius * 0.86, width * 0.16, { bevel: 0, bevelSegments: 1 });
    spoke.translate(0, radius * 0.47, 0);
    spoke.rotateZ(angle);
    spoke.translate(0, hubY, 0);
    builder.add(take(spent, spoke), undefined, wood);
  }
  for (const side of [-1, 1]) {
    const collar = torus(width * 0.21, width * 0.045, { radialSegments: 3, tubularSegments: 8 });
    collar.rotateX(Math.PI / 2);
    collar.translate(0, hubY, side * width * 0.4);
    const data = affordable(spent, collar, budget);
    if (data) builder.add(data, undefined, IRON);
  }
  // The axle, with iron gudgeons at both ends bearing in the frame.
  const axle = cylinder(width * 0.09, width * 0.09, width * 1.9, { radialSegments: budget > 1200 ? 10 : 7 });
  axle.rotateX(Math.PI / 2);
  axle.translate(0, hubY, 0);
  builder.add(take(spent, axle), undefined, 'wood-dark');
  for (const side of [-1, 1]) {
    const gudgeon = cylinder(width * 0.055, width * 0.055, width * 0.22, { radialSegments: 8 });
    gudgeon.rotateX(Math.PI / 2);
    gudgeon.translate(0, hubY, side * width * 0.86);
    const data = affordable(spent, gudgeon, budget);
    if (data) builder.add(data, undefined, IRON);
  }

  // Paddles, buckets or blades, around the rim.
  const wanted = style === 'undershot' ? Math.max(8, Math.round(segments * 0.9)) : Math.max(10, Math.round(segments * 1.4));
  const bladeUnit = style === 'overshot'
    ? (() => {
      // A bucket is two boards: a radial one and a tangential one, which is what
      // holds the water until it comes to the bottom of the wheel.
      const part = new MeshBuilder();
      const radial = box(width * 0.88, radius * 0.24, width * 0.035, { bevel: 0, bevelSegments: 1 });
      radial.translate(0, radius * 0.86, 0);
      part.add(radial);
      const tangential = box(width * 0.88, width * 0.035, radius * 0.22, { bevel: 0, bevelSegments: 1 });
      tangential.translate(0, radius * 0.97, -radius * 0.1);
      part.add(tangential);
      return part;
    })()
    : paddle();
  // A paddle is a board out at the rim, not one through the hub: a board centred
  // on the axle comes back on itself half a turn later, so every paddle had a
  // twin folded exactly over it and the wheel was skinned twice.
  function paddle(): MeshBuilder {
    const board = box(width * 0.9, radius * (style === 'breast' ? 0.3 : 0.26), width * 0.04, { bevel: 0, bevelSegments: 1 });
    if (style === 'breast') board.rotateZ(-0.24);
    board.translate(0, radius * 0.79, 0);
    const part = new MeshBuilder();
    part.add(board);
    return part;
  }
  const count = units(spent, bladeUnit, budget, Math.max(6, Math.round(wanted * 0.35)), wanted);
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const part = style === 'overshot'
      ? (() => {
        const blade = new MeshBuilder();
        const radial = box(width * 0.88, radius * 0.24, width * 0.035, { bevel: 0, bevelSegments: 1 });
        radial.translate(0, radius * 0.86, 0);
        blade.add(radial);
        const tangential = box(width * 0.88, width * 0.035, radius * 0.22, { bevel: 0, bevelSegments: 1 });
        tangential.translate(0, radius * 0.97, -radius * 0.1);
        blade.add(tangential);
        return blade;
      })()
      : paddle();
    part.rotateZ(angle);
    part.translate(0, hubY, 0);
    builder.add(take(spent, part), undefined, wood);
    // Water in the buckets of an overshot wheel, on the descending side only,
    // because that is the side that is doing the work.
    if (style === 'overshot' && budget > 1400 && Math.sin(angle) < -0.05 && Math.cos(angle) > -0.4) {
      const load = box(width * 0.8, radius * 0.06, radius * 0.16, { bevel: 0, bevelSegments: 1 });
      load.rotateZ(angle);
      load.translate(0, hubY + radius * 0.9, 0);
      const data = affordable(spent, load, budget);
      if (data) builder.add(data, undefined, 'glass');
    }
  }

  if (options.chute ?? style !== 'undershot') {
    // The launder: a boarded channel bringing water to the top of the wheel on
    // a falling gradient, on trestles of its own.
    const top = hubY + radius * 0.94;
    const run = radius * 1.7;
    const chuteWidth = width * 0.8;
    const floor = box(run, 0.04, chuteWidth, { bevel: budget > 1200 ? 0.006 : 0, bevelSegments: 1 });
    floor.rotateZ(0.14);
    floor.translate(run / 2 - radius * 0.1, top + 0.14, 0);
    const floorData = affordable(spent, floor, budget);
    if (floorData) builder.add(floorData, undefined, wood);
    for (const side of [-1, 1]) {
      const wall = box(run, 0.16, 0.03, { bevel: 0.004, bevelSegments: 1 });
      wall.rotateZ(0.14);
      wall.translate(run / 2 - radius * 0.1, top + 0.24, side * chuteWidth / 2);
      const data = affordable(spent, wall, budget);
      if (data) builder.add(data, undefined, wood);
    }
    const water = box(run * 0.94, 0.03, chuteWidth * 0.78, { bevel: 0, bevelSegments: 1 });
    water.rotateZ(0.14);
    water.translate(run / 2 - radius * 0.1, top + 0.2, 0);
    const waterData = affordable(spent, water, budget);
    if (waterData) builder.add(waterData, undefined, 'glass');
    // The fall from the launder's lip onto the wheel.
    const fall = box(chuteWidth * 0.7, radius * 0.5, 0.03, { bevel: 0, bevelSegments: 1 });
    fall.translate(-radius * 0.14, top - radius * 0.22, 0);
    const fallData = affordable(spent, fall, budget);
    if (fallData) builder.add(fallData, undefined, 'glass');
    for (const at of [run * 0.45, run * 0.85]) {
      const trestle = box(0.1, top + 0.1, 0.1, { bevel: 0.012, bevelSegments: 1 });
      trestle.translate(at - radius * 0.1, (top + 0.1) / 2, 0);
      const data = affordable(spent, trestle, budget);
      if (data) builder.add(data, undefined, 'wood-dark');
    }
    // A sluice gate across the launder, which is how the mill is stopped.
    const gate = box(0.05, 0.24, chuteWidth * 1.1, { bevel: 0.006, bevelSegments: 1 });
    gate.translate(run * 0.72, top + 0.26, 0);
    const gateData = affordable(spent, gate, budget);
    if (gateData) builder.add(gateData, undefined, 'wood-dark');
  }

  if (options.frame ?? true) {
    // Bearings: masonry piers with the axle carried in an iron box on each.
    for (const side of [-1, 1]) {
      // The masonry that carries the axle, one block at each end of it.
      const pierBlock = pier(radius * 0.5, hubY + width * 0.1, radius * 0.42, (options.seed ?? 887) + 31 + side, budget > 2200);
      pierBlock.translate(0, 0, side * (width / 2 + radius * 0.24));
      builder.add(take(spent, pierBlock), undefined, 'stone-rough');
      const bearing = box(width * 0.2, width * 0.2, width * 0.14, { bevel: 0.01, bevelSegments: 1 });
      bearing.translate(0, hubY, side * (width / 2 + radius * 0.02));
      const data = affordable(spent, bearing, budget);
      if (data) builder.add(data, undefined, IRON);
    }
  }

  if (options.gearing ?? true) {
    // The pit wheel on the axle, inside the frame: a toothed wheel that turns
    // the machinery, and the reason a water wheel is an engine and not a pump.
    const pit = gear({
      radius: radius * 0.44,
      teeth: budget > 2000 ? 18 : budget > 900 ? 12 : 8,
      thickness: width * 0.2,
      bore: radius * 0.08,
      spokes: 5,
      seed: (options.seed ?? 887) + 41,
    });
    pit.translate(0, hubY, -(width / 2 + radius * 0.1));
    const data = affordable(spent, pit, budget);
    if (data) builder.add(data, undefined, 'wood-dark');
  }

  // The tail race: water leaving under the wheel, so the wheel is in a stream.
  if (budget > 900) {
    const sheet = box(radius * 3.4, 0.014, width * 1.6, { bevel: 0, bevelSegments: 1 });
    sheet.translate(0, 0.03, 0);
    const data = affordable(spent, sheet, budget);
    if (data) builder.add(data, undefined, 'glass');
  }

  seatOnGround(builder);
  return builder;
}

export interface MillstoneOptions {
  /** Radius of the stones, in metres. */
  radius?: number;
  /** Thickness of each stone. */
  thickness?: number;
  /** `coupled` is the pair at work, `single` one stone lying flat, `leaning` one stood on its edge beside the other. */
  rest?: 'coupled' | 'single' | 'leaning';
  /** Furrows cut in the grinding face. */
  furrows?: boolean;
  /** A hopper feeding grain into the eye of the runner. */
  hopper?: boolean;
  quality?: Quality;
  budget?: number;
  seed?: number;
}

/**
 * A millstone: two discs of stone, one turned against the other.
 *
 * The bedstone lies and the runner turns on it, carried on a rynd across the
 * eye — the hole in the middle that the grain comes down through and the shaft
 * goes up through. The furrows on the grinding face are what a miller cuts and
 * re-cuts all his working life, and they are the first thing this model loses
 * when the allowance is small, because from any distance a millstone is a disc.
 */
export function millstone(options: MillstoneOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 889);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const radius = Math.max(0.25, options.radius ?? 0.78);
  const thickness = Math.max(0.06, options.thickness ?? 0.17);
  const rest = options.rest ?? 'coupled';
  const segments = budget > 1400 ? 24 : budget > 700 ? 18 : 13;

  /** One stone: a disc, chamfered at its rim, with a face that is not quite flat. */
  const stone = (seed: number): MeshBuilder => {
    const profile: [number, number][] = [
      [0, 0],
      [radius * 0.9, 0],
      [radius, thickness * 0.24],
      [radius, thickness * 0.76],
      [radius * 0.9, thickness],
      [0, thickness],
    ];
    const part = lathe(profile, { segments, caps: false });
    displace(part, {
      amplitude: thickness * 0.07,
      frequency: 1.6,
      octaves: 2,
      preserveBase: false,
      recompute: true,
      seed,
    });
    return part;
  };

  // A timber bear or a low plinth under the bedstone, so the stone is off the
  // floor and the meal can be swept out from under it.
  const plinth = box(radius * 2.3, thickness * 0.42, radius * 2.3, { bevel: 0.02, bevelSegments: 1 });
  plinth.translate(0, thickness * 0.21, 0);
  const plinthData = affordable(spent, plinth, budget);
  if (plinthData) builder.add(plinthData, undefined, 'wood-dark');
  const base = plinthData ? thickness * 0.42 : 0;

  if (rest === 'single') {
    const part = stone((options.seed ?? 889) + 3);
    part.translate(0, base, 0);
    builder.add(take(spent, part), undefined, 'stone-rough');
  } else if (rest === 'leaning') {
    // The bedstone lies, and the runner is stood on its edge beside it: how a
    // pair is left when the mill is stopped and the stones are being dressed.
    const bed = stone((options.seed ?? 889) + 3);
    bed.translate(0, base, 0);
    builder.add(take(spent, bed), undefined, 'stone-rough');
    const runner = stone((options.seed ?? 889) + 11);
    runner.rotateZ(Math.PI / 2 - 0.14);
    // Stood on its edge and leaning a little: placed by its own lowest point, so
    // the rim rests on the ground rather than the stone hanging above it.
    const lowest = runner.bounds().min[1];
    runner.translate(radius * 1.6, -lowest, 0);
    builder.add(take(spent, runner), undefined, 'stone-dressed');
  } else {
    const bed = stone((options.seed ?? 889) + 3);
    bed.translate(0, base, 0);
    builder.add(take(spent, bed), undefined, 'stone-rough');
    const runner = stone((options.seed ?? 889) + 11);
    runner.translate(0, base + thickness * 0.98, 0);
    builder.add(take(spent, runner), undefined, 'stone-dressed');
    // The eye: a dark hole through the runner, and the rynd that carries it.
    const eye = cylinder(radius * 0.16, radius * 0.16, thickness * 1.04, { radialSegments: 9, caps: false });
    eye.translate(0, base + thickness * 0.98 + thickness * 0.5, 0);
    const eyeData = affordable(spent, eye, budget);
    if (eyeData) builder.add(eyeData, undefined, 'soil');
    const rynd = box(radius * 1.5, thickness * 0.16, thickness * 0.24, { bevel: 0.006, bevelSegments: 1 });
    rynd.translate(0, base + thickness * 0.94, 0);
    const ryndData = affordable(spent, rynd, budget);
    if (ryndData) builder.add(ryndData, undefined, 'iron-wrought');
    // The quant: the upright shaft that turns the runner, through the eye.
    const shaft = cylinder(radius * 0.1, radius * 0.11, thickness * 3.2, { radialSegments: 8 });
    shaft.translate(0, base + thickness * 1.6, 0);
    const shaftData = affordable(spent, shaft, budget);
    if (shaftData) builder.add(shaftData, undefined, 'wood-dark');
  }

  if (options.furrows ?? true) {
    // Furrows: radial grooves cut in the grinding face, alternating with the
    // lands that do the grinding. They are laid out from the eye outward.
    const furrows = Math.max(6, budget > 1600 ? 20 : budget > 800 ? 14 : 9);
    const face = rest === 'single' ? base + thickness : rest === 'coupled' ? base + thickness * 1.98 : base + thickness;
    for (let index = 0; index < furrows; index += 1) {
      const angle = (index / furrows) * Math.PI * 2;
      const furrow = box(radius * 0.74, thickness * 0.06, radius * 0.07, { bevel: 0, bevelSegments: 1 });
      furrow.translate(radius * 0.48, face + thickness * 0.02, 0);
      furrow.rotateY(angle);
      const data = affordable(spent, furrow, budget);
      if (data) builder.add(data, undefined, 'stone-pale');
    }
  }

  if (options.hopper ?? rest === 'coupled') {
    // The hopper over the eye, on two bearers, with a shoe beneath it: grain
    // goes in at the top and is shaken into the eye a little at a time.
    const top = base + thickness * 2 + thickness * 1.5;
    for (const side of [-1, 1]) {
      const bearer = timber([side * radius * 1.1, base, side * radius * 0.2], [side * radius * 0.2, top + 0.1, 0], 0.05);
      const data = affordable(spent, bearer, budget);
      if (data) builder.add(data, undefined, 'wood-oak');
    }
    const hopper = prism({ sides: 4, radius: radius * 0.16, height: radius * 0.5, topScale: 2.5, caps: false });
    hopper.rotateY(Math.PI / 4);
    hopper.translate(0, top - radius * 0.34, 0);
    const hopperData = affordable(spent, hopper, budget);
    if (hopperData) builder.add(hopperData, undefined, 'wood-oak');
    // Grain in the hopper, level with its rim.
    const grain = cylinder(radius * 0.36, radius * 0.34, radius * 0.06, { radialSegments: 10 });
    grain.translate(0, top + radius * 0.13, 0);
    const grainData = affordable(spent, grain, budget);
    if (grainData) builder.add(grainData, undefined, 'sand');
    // A sack of meal leaning against the stones.
    const sack = cask({ height: radius * 0.7, radius: radius * 0.3, bilge: 0.22, staves: 8, hoops: 0, seed: (options.seed ?? 889) + 51 });
    sack.rotateZ(0.3);
    sack.translate(radius * 1.5, base + leanLift(radius * 0.3, 0.3), radius * 0.5);
    const sackData = affordable(spent, sack, budget);
    if (sackData) builder.add(sackData, undefined, 'fabric-linen');
  }
  void rng;

  seatOnGround(builder);
  return builder;
}
