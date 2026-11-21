import { boundsOf, MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { box, cylinder, extrude, lathe, prism, sphere, torus } from '../primitives';
import {
  BEVELLED_BOX_TRIANGLES, cask, componentBudget, detailRng, flame, framedPanel, planks, post, spike,
  type Quality,
} from '../detail';
import { seatOnGround } from '../scale';
import { chance, intRange, range } from '../../generation/rng';
import { affordable, cloth, leanLift, strut, take, type Spend } from './common';

/**
 * Furniture: what a body sits, sleeps, keeps and works on.
 *
 * A room is judged in centimetres. A seat at 65 cm is not a chair, it is a
 * shelf, and a table at 60 cm is a stool — so this file is built against the
 * human measures in `scale.ts` (a seat at 0.45, a table at 0.75, a counter at
 * 0.9, a bed at 0.5) and every default in it lands on one of those numbers.
 * Four rules follow from that.
 *
 * 1. **Joinery is the read.** A leg meets a seat at a corner, a stretcher is
 *    tenoned between two legs, a door hangs on a stile, a drawer has a lip. The
 *    parts are placed so they intersect rather than touch: a leg whose top face
 *    is exactly coplanar with the underside of a seat reads as a box on a box.
 * 2. **Wood is never one flat box.** A seat is boards with a shadow gap, a panel
 *    is framed with an infill, a turned leg has a vase in it. Where the budget
 *    cannot afford boards, the surface carries them — but the silhouette keeps
 *    its thickness, because a 2 cm seat top is a shelf, not a table.
 * 3. **The budget drops decoration before it drops structure.** A poor chair
 *    keeps four legs, a seat and a back and loses its spindles, its cushion and
 *    the turn in its legs. It never loses a leg: a three-legged chair is not a
 *    cheaper chair, it is a broken one.
 * 4. **Soft things are soft.** A cushion is a chamfered box that overshoots its
 *    frame by a centimetre, a mattress bulges past the rails, a curtain is one
 *    plane of cloth. Nothing upholstered is built with sharp edges, and nothing
 *    draped is built thick.
 *
 * Coordinates: metres, Y up, the base on y = 0, centred on X and Z. A piece
 * faces +Z — a chair's sitter looks toward +Z, a wardrobe's doors open toward it.
 */

/* --------------------------------------------------------------- plumbing */

/** The woods a piece can be made in, and the surface each one sells as. */
export type FurnitureWood = 'oak' | 'pine' | 'walnut' | 'painted' | 'weathered';

const WOOD: Record<FurnitureWood, string> = {
  oak: 'wood-oak',
  pine: 'wood-pine',
  walnut: 'wood-dark',
  painted: 'wood-painted',
  weathered: 'wood-weathered',
};

/** What a piece is upholstered or covered in. */
export type Upholstery = 'linen' | 'wool' | 'velvet' | 'leather' | 'canvas' | 'straw';

const UPHOLSTERY: Record<Upholstery, string> = {
  linen: 'fabric-linen',
  wool: 'wool',
  velvet: 'velvet',
  leather: 'leather',
  canvas: 'fabric',
  straw: 'thatch',
};

/**
 * A leg, built with its foot at y = 0 and standing up +Y.
 *
 * Turned legs are a lathe of five stations — a foot, a bead, a vase, a narrow
 * neck and the tenon that goes into the seat — because that profile is what says
 * "this was made on a lathe" at any distance. Square legs are one chamfered box.
 */
function leg(height: number, thickness: number, turned: boolean, segments: number, seed: number): MeshBuilder {
  if (!turned) {
    const square = box(thickness, height, thickness, { bevel: thickness * 0.18, bevelSegments: 1 });
    square.translate(0, height / 2, 0);
    return square;
  }
  const profile: Vec2[] = [
    [thickness * 0.62, 0],
    [thickness * 0.5, height * 0.05],
    [thickness * 0.66, height * 0.12],
    [thickness * 0.42, height * 0.3],
    [thickness * 0.52, height * 0.52],
    [thickness * 0.3, height * 0.82],
    [thickness * 0.34, height],
  ];
  void seed;
  return lathe(profile, { segments: Math.max(5, Math.round(segments)), caps: true });
}

/**
 * A deck of boards: width along X, depth along Z, thickness along Y, centred on
 * the origin with its top face at y = +thickness / 2.
 *
 * Boards rather than a slab because a slab with a wood texture reads as plywood,
 * and the 1 cm shadow gap between boards is the cheapest detail in the library.
 */
function deck(
  width: number,
  depth: number,
  thickness: number,
  boards: number,
  seed: number,
  along = false,
): MeshBuilder {
  const part = planks({
    width,
    height: depth,
    thickness,
    count: Math.max(1, Math.round(boards)),
    // `along` runs the boards the long way, which is what a bench slat does.
    horizontal: along,
    gap: Math.min(0.014, depth * 0.05),
    bevel: Math.min(0.008, thickness * 0.2),
    seed,
  });
  part.rotateX(-Math.PI / 2);
  return part;
}

/**
 * Tilts a member that was built standing on its own foot at the origin.
 *
 * The turn is about the foot, so a positive `tilt` carries the *top* toward
 * `azimuth` and leaves the foot where it was — which is the wrong way round for
 * everything that splays. A chair leg or a stool leg is wider at the floor than
 * at the seat, so those callers pass a negative tilt and place the foot where the
 * floor should meet it. Lifting by `leanLift` keeps the whole foot on the ground
 * instead of driving one edge of it under the floor.
 */
function splay(part: MeshBuilder, tilt: number, azimuth: number, origin: Vec3, footRadius: number): void {
  if (Math.abs(tilt) > 1e-6) {
    part.rotateZ(tilt);
    part.rotateY(azimuth);
    part.translate(origin[0], origin[1] + leanLift(footRadius, tilt), origin[2]);
  } else {
    part.translate(origin[0], origin[1], origin[2]);
  }
}

/* ------------------------------------------------------------------ chair */

export interface ChairOptions {
  /** `stick` is a Windsor: turned legs, a saddle seat, spindles in the back. */
  style?: 'stick' | 'panel' | 'ladder' | 'arm';
  wood?: FurnitureWood;
  /** Seat height above the floor. 0.45 m is a dining chair, 0.4 a kitchen one. */
  seat?: number;
  width?: number;
  depth?: number;
  /** Back height above the seat. */
  back?: number;
  cushion?: Upholstery | false;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A chair: four legs, a seat, a back, and the joinery that holds them together.
 *
 * The rear legs run up into the back stiles in one piece, which is how a chair
 * is actually made and what gives it the two continuous lines the eye reads as a
 * chair rather than as a seat with a fence behind it.
 */
export function chair(options: ChairOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 701);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'oak'];
  const style = options.style ?? 'ladder';
  const seat = Math.max(0.34, options.seat ?? 0.45);
  // Nothing a person has sat in for twenty years is quite plumb.
  const list = range(rng, -0.012, 0.012);
  const width = Math.max(0.3, options.width ?? 0.46);
  const depth = Math.max(0.3, options.depth ?? 0.44);
  const back = Math.max(0.22, options.back ?? (style === 'stick' ? 0.52 : 0.46));
  const turned = style === 'stick' || style === 'arm';
  const segments = budget > 1600 ? 10 : budget > 800 ? 8 : 6;
  const thick = Math.max(0.026, Math.min(width, depth) * 0.085);
  const seatSlab = Math.max(0.022, depth * 0.07);

  // The legs carry the extent, so they are charged rather than planned: a chair
  // that could only afford three legs is a broken chair, not a cheaper one.
  const rearHeight = seat + back;
  const legX = width / 2 - thick * 0.6;
  const legZ = depth / 2 - thick * 0.6;
  const splayAngle = style === 'stick' ? 0.07 : 0.025;
  for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const [sx, sz] = corner;
    const rear = sz < 0;
    const part = leg(rear ? rearHeight : seat, thick, turned, segments, (options.seed ?? 701) + sx * 3 + sz * 5);
    // Each leg kicks out along its own diagonal, so the chair stands on a
    // footprint wider than its seat on both axes at once — the tilt is negative
    // because the turn is about the foot and the foot is the wider end.
    splay(part, -splayAngle, Math.atan2(sz * legZ, -sx * legX), [sx * legX, 0, sz * legZ], thick * 0.7);
    builder.add(take(spent, part), undefined, wood);
  }

  // An H-stretcher: two side members and one cross member, tenoned low.
  const stretcherY = seat * (style === 'stick' ? 0.34 : 0.3);
  const stretcherRadius = thick * 0.3;
  for (const side of [-1, 1]) {
    const run = strut([side * legX, stretcherY, -legZ], [side * legX, stretcherY, legZ], stretcherRadius, 5);
    const data = affordable(spent, run, budget);
    if (data) builder.add(data, undefined, wood);
  }
  const cross = strut([-legX, stretcherY * 0.92, 0], [legX, stretcherY * 0.92, 0], stretcherRadius, 5);
  const crossData = affordable(spent, cross, budget);
  if (crossData) builder.add(crossData, undefined, wood);

  // The seat: a saddle for a Windsor, boards for everything else. Boards keep
  // their gap down to the poorest budget because the gap is what makes it a
  // seat rather than a slab.
  const boards = budget > 900 ? 4 : budget > 420 ? 3 : 2;
  const seatPart = style === 'stick'
    ? (() => {
      const saddle = box(width * 1.04, seatSlab, depth * 1.02, { bevel: seatSlab * 0.42, bevelSegments: 2 });
      saddle.translate(0, seat + seatSlab * 0.1, 0);
      return saddle;
    })()
    : (() => {
      const boards_ = deck(width * 1.02, depth * 1.02, seatSlab, boards, (options.seed ?? 701) + 11);
      boards_.translate(0, seat, 0);
      return boards_;
    })();
  builder.add(take(spent, seatPart), undefined, wood);

  // The back.
  const backZ = -legZ - thick * 0.1;
  if (style === 'panel') {
    const panel = framedPanel({
      width: width * 0.86,
      height: back * 0.88,
      frame: thick * 1.1,
      thickness: thick * 0.6,
      infill: 'plank',
      seed: (options.seed ?? 701) + 17,
    });
    panel.translate(0, seat + back * 0.5, backZ);
    const data = affordable(spent, panel, budget);
    if (data) builder.add(data, undefined, wood);
  } else if (style === 'stick') {
    const spindles = Math.max(3, budget > 1400 ? 7 : budget > 700 ? 5 : 3);
    for (let index = 0; index < spindles; index += 1) {
      const t = spindles === 1 ? 0.5 : index / (spindles - 1);
      const at = -width * 0.36 + width * 0.72 * t;
      const height = back * (0.86 + 0.14 * Math.sin(t * Math.PI));
      const spindle = cylinder(thick * 0.18, thick * 0.22, height, { radialSegments: Math.max(4, segments - 3) });
      spindle.translate(at, seat + height / 2, backZ + thick * 0.1);
      const data = affordable(spent, spindle, budget);
      if (data) builder.add(data, undefined, wood);
    }
    // The bow is one bent stick across the top of the back: a half ring stood up
    // into the XY plane, so its ends land on the stiles and its crown is the top
    // of the chair. A torus lies flat in XZ unless it is turned, and a flat bow
    // is a halo, not a chair back.
    const bow = torus(width * 0.36, thick * 0.34, { radialSegments: 5, tubularSegments: Math.max(8, segments), arc: Math.PI });
    bow.rotateX(-Math.PI / 2);
    bow.translate(0, seat + back * 0.56, backZ + thick * 0.1);
    const bowData = affordable(spent, bow, budget);
    if (bowData) builder.add(bowData, undefined, wood);
  } else {
    // Ladder back: two or three slats across the stiles, the cheapest honest back.
    const slats = budget > 1200 ? 3 : 2;
    for (let index = 0; index < slats; index += 1) {
      const t = (index + 1) / (slats + 1);
      const slat = box(width * 0.88, back * 0.16, thick * 0.55, { bevel: 0.005, bevelSegments: 1 });
      slat.translate(0, seat + back * (0.24 + t * 0.62), backZ + thick * 0.15);
      const data = affordable(spent, slat, budget);
      if (data) builder.add(data, undefined, wood);
    }
    const rail = box(width * 0.94, thick * 0.9, thick * 0.7, { bevel: 0.005, bevelSegments: 1 });
    rail.translate(0, seat + back * 0.98, backZ + thick * 0.1);
    const railData = affordable(spent, rail, budget);
    if (railData) builder.add(railData, undefined, wood);
  }

  if (style === 'arm' || (options.style === 'arm' && budget > 700)) {
    for (const side of [-1, 1]) {
      const armY = seat + back * 0.44;
      const rest = strut(
        [side * legX * 0.9, armY, backZ],
        [side * (legX + thick * 0.4), armY - thick * 0.3, legZ * 0.7],
        thick * 0.34,
        5,
      );
      const data = affordable(spent, rest, budget);
      if (data) builder.add(data, undefined, wood);
      const support = leg(armY - seat - thick * 0.3, thick * 0.7, turned, segments - 2, (options.seed ?? 701) + side * 29);
      support.translate(side * (legX + thick * 0.4), seat, legZ * 0.7);
      const supportData = affordable(spent, support, budget);
      if (supportData) builder.add(supportData, undefined, wood);
    }
  }

  if (options.cushion) {
    const surface = UPHOLSTERY[options.cushion];
    const pad = box(width * 0.92, depth * 0.14, depth * 0.9, { bevel: depth * 0.06, bevelSegments: 2 });
    pad.translate(0, seat + seatSlab * 0.5 + depth * 0.07, 0);
    const data = affordable(spent, pad, budget);
    if (data) builder.add(data, undefined, surface);
  }

  builder.rotateZ(list);
  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ stool */

export interface StoolOptions {
  /** `milk` is a low dished stool on three splayed legs; `bench` is a plank on two ends. */
  style?: 'round' | 'square' | 'three' | 'milk' | 'plank';
  wood?: FurnitureWood;
  seat?: number;
  radius?: number;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/** A stool: a seat and the fewest legs that will hold it. */
export function stool(options: StoolOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 709);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'pine'];
  const style = options.style ?? 'round';
  const seat = Math.max(0.2, options.seat ?? (style === 'milk' ? 0.3 : 0.45));
  const radius = Math.max(0.12, options.radius ?? (style === 'milk' ? 0.17 : 0.2));
  const legs = style === 'three' || style === 'milk' ? 3 : style === 'plank' ? 0 : 4;
  const thick = radius * 0.17;
  const segments = budget > 1200 ? 12 : budget > 600 ? 9 : 7;

  if (legs > 0) {
    // Splayed legs are the whole read of a stool: they lean out from under the
    // seat so the footprint is wider than the top, which is why it does not fall.
    const splayAngle = style === 'milk' ? 0.19 : 0.13;
    for (let index = 0; index < legs; index += 1) {
      const angle = (index / legs) * Math.PI * 2 + (legs === 3 ? Math.PI / 2 : Math.PI / 4);
      const part = leg(seat, thick, style === 'round' || style === 'milk', Math.max(5, segments - 2), index * 7);
      // The foot stands wider than the seat edge and the leg leans in to meet it,
      // which is the whole reason a three-legged stool does not fall over.
      const foot = radius * (style === 'milk' ? 1.02 : 0.98);
      splay(part, -splayAngle, Math.PI - angle, [Math.cos(angle) * foot, 0, Math.sin(angle) * foot], thick);
      builder.add(take(spent, part), undefined, wood);
    }
  } else {
    // A plank stool is a board on two end supports: no legs at all.
    for (const side of [-1, 1]) {
      const support = box(thick * 2.4, seat - 0.02, radius * 1.5, { bevel: thick * 0.2, bevelSegments: 1 });
      support.translate(side * radius * 0.72, (seat - 0.02) / 2, 0);
      builder.add(take(spent, support), undefined, wood);
    }
  }

  const top = style === 'square' || style === 'plank'
    ? (() => {
      const boards = deck(radius * (style === 'plank' ? 2.1 : 1.7), radius * (style === 'plank' ? 1.1 : 1.7), thick * 1.5, budget > 700 ? 3 : 2, (options.seed ?? 709) + 5);
      boards.translate(0, seat, 0);
      return boards;
    })()
    : (() => {
      // A round seat is a disc; a milk stool's is dished, so it is a lathe of
      // two stations that falls toward the middle rather than a flat cylinder.
      const profile: Vec2[] = style === 'milk'
        ? [[radius, thick * 0.4], [radius * 0.94, 0], [radius * 0.5, -thick * 0.5], [0, -thick * 0.62]]
        : [[radius, 0], [radius * 0.98, -thick * 0.9], [radius * 0.4, -thick * 1.3], [0, -thick * 1.35]];
      const disc = lathe(profile, { segments, caps: false });
      // The rim is the seat: it lands on the height asked for, and the dish falls
      // away below it rather than standing proud of it. The rim of a milk stool is
      // the highest point of its own profile, so the disc is placed by that.
      const rim = style === 'milk' ? thick * 0.4 : 0;
      disc.translate(0, seat - rim, 0);
      return disc;
    })();
  builder.add(take(spent, top), undefined, wood);

  if (legs > 2 && budget > 700) {
    // A shelf stretcher low between the legs: three boards meeting at the middle.
    for (let index = 0; index < legs; index += 1) {
      const angle = (index / legs) * Math.PI * 2 + (legs === 3 ? Math.PI / 2 : Math.PI / 4);
      const run = strut(
        [0, seat * 0.28, 0],
        [Math.cos(angle) * radius * 0.8, seat * 0.22, Math.sin(angle) * radius * 0.8],
        thick * 0.34,
        4,
      );
      const data = affordable(spent, run, budget);
      if (data) builder.add(data, undefined, wood);
    }
  }

  void rng;
  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ bench */

export interface BenchOptions {
  /** `park` has cast ends and slats; `trestle` folds; `stone` is masonry. */
  style?: 'plank' | 'trestle' | 'park' | 'stone';
  length?: number;
  seat?: number;
  depth?: number;
  back?: boolean;
  wood?: FurnitureWood;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/** A bench: the same joinery as a chair, stretched, with the middle carried. */
export function bench(options: BenchOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 719);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const style = options.style ?? 'plank';
  const length = Math.max(0.7, options.length ?? 1.6);
  const depth = Math.max(0.28, options.depth ?? 0.42);
  const seat = Math.max(0.34, options.seat ?? 0.45);
  const hasBack = options.back ?? (style === 'park' || style === 'plank' ? chance(rng, 0.5) : false);
  const wood = WOOD[options.wood ?? (style === 'park' ? 'weathered' : 'pine')];
  const thick = Math.max(0.03, depth * 0.1);
  const segments = budget > 1400 ? 10 : budget > 700 ? 8 : 6;

  if (style === 'stone') {
    // Two masonry piers and a slab: a bench that outlives the building it was in.
    for (const side of [-1, 1]) {
      const pier = box(depth * 0.9, seat - thick, depth * 0.8, { bevel: 0.012, bevelSegments: 1 });
      pier.translate(side * (length / 2 - depth * 0.55), (seat - thick) / 2, 0);
      builder.add(take(spent, pier), undefined, 'stone-dressed');
    }
    const slabPart = box(length, thick * 1.4, depth, { bevel: 0.014, bevelSegments: 1 });
    slabPart.translate(0, seat, 0);
    builder.add(take(spent, slabPart), undefined, 'stone-pale');
    if (hasBack) {
      const backSlab = box(length * 0.96, depth * 0.9, thick, { bevel: 0.01, bevelSegments: 1 });
      backSlab.rotateX(-0.12);
      backSlab.translate(0, seat + depth * 0.55, -depth * 0.42);
      const data = affordable(spent, backSlab, budget);
      if (data) builder.add(data, undefined, 'stone-pale');
    }
    seatOnGround(builder);
    return builder;
  }

  const legX = length / 2 - depth * 0.42;
  if (style === 'trestle') {
    // A trestle is an A: two raking legs and a collar, and the top sits on it.
    for (const side of [-1, 1]) {
      for (const tilt of [-1, 1]) {
        const rake = strut(
          [side * legX, 0, tilt * depth * 0.42],
          [side * legX, seat - thick, 0],
          thick * 0.55,
          5,
        );
        builder.add(take(spent, rake), undefined, wood);
      }
      const collar = strut(
        [side * legX, seat * 0.42, -depth * 0.3],
        [side * legX, seat * 0.42, depth * 0.3],
        thick * 0.42,
        5,
      );
      const data = affordable(spent, collar, budget);
      if (data) builder.add(data, undefined, wood);
    }
    const stretcher = strut([-legX, seat * 0.52, 0], [legX, seat * 0.52, 0], thick * 0.5, 5);
    const stretcherData = affordable(spent, stretcher, budget);
    if (stretcherData) builder.add(stretcherData, undefined, wood);
  } else if (style === 'park') {
    // Cast ends: a curved iron cheek each side, bolted to the slats.
    for (const side of [-1, 1]) {
      // The cast cheek is a scroll standing in the plane of the bench's end.
      const cheek = torus(depth * 0.62, thick * 0.42, { radialSegments: 5, tubularSegments: Math.max(10, segments), arc: Math.PI * 1.25 });
      cheek.rotateX(-Math.PI / 2);
      cheek.rotateY(Math.PI / 2);
      cheek.translate(side * (length / 2 - thick), seat * 0.5, 0);
      builder.add(take(spent, cheek), undefined, 'iron-rusted');
      const foot = box(thick * 2.2, seat * 0.16, depth * 0.8, { bevel: thick * 0.2, bevelSegments: 1 });
      foot.translate(side * (length / 2 - thick), seat * 0.08, 0);
      builder.add(take(spent, foot), undefined, 'iron-rusted');
    }
  } else {
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        const part = leg(seat, thick * 0.9, false, segments, (options.seed ?? 719) + side * 5 + end);
        part.translate(side * legX, 0, end * (depth / 2 - thick * 0.7));
        builder.add(take(spent, part), undefined, wood);
      }
      const rail = strut([side * legX, seat * 0.28, -depth / 2 + thick], [side * legX, seat * 0.28, depth / 2 - thick], thick * 0.34, 4);
      const data = affordable(spent, rail, budget);
      if (data) builder.add(data, undefined, wood);
    }
    for (const end of [-1, 1]) {
      const apron = box(length - depth * 0.9, thick * 0.8, thick * 0.6, { bevel: 0.004, bevelSegments: 1 });
      apron.translate(0, seat - thick * 0.7, end * (depth / 2 - thick * 0.7));
      const data = affordable(spent, apron, budget);
      if (data) builder.add(data, undefined, wood);
    }
  }

  // The seat: slats with a gap, running the length of the bench.
  const slats = Math.max(2, budget > 1600 ? 5 : budget > 700 ? 4 : 3);
  const top = deck(length, depth, thick * 1.2, slats, (options.seed ?? 719) + 13, true);
  top.translate(0, seat, 0);
  builder.add(take(spent, top), undefined, wood);

  if (hasBack) {
    const backHeight = depth * 0.95;
    for (const side of [-1, 1]) {
      const stile = strut(
        [side * legX, seat, -depth * 0.36],
        [side * legX, seat + backHeight, -depth * 0.5],
        thick * 0.45,
        5,
      );
      builder.add(take(spent, stile), undefined, style === 'park' ? 'iron-rusted' : wood);
    }
    const backSlats = Math.max(2, budget > 1200 ? 3 : 2);
    for (let index = 0; index < backSlats; index += 1) {
      const t = (index + 1) / (backSlats + 1);
      const slat = box(length * 0.96, backHeight * 0.22, thick * 0.7, { bevel: 0.005, bevelSegments: 1 });
      slat.rotateX(-0.16);
      slat.translate(0, seat + backHeight * (0.2 + t * 0.66), -depth * (0.4 + t * 0.06));
      const data = affordable(spent, slat, budget);
      if (data) builder.add(data, undefined, wood);
    }
  }

  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ table */

export interface TableOptions {
  style?: 'dining' | 'round' | 'trestle' | 'board';
  wood?: FurnitureWood;
  /** Top height. 0.75 m is a dining table, 0.9 a counter, 0.4 a low table. */
  height?: number;
  width?: number;
  depth?: number;
  cloth?: Upholstery | false;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A table: a top thick enough to be planed flat, and the frame that keeps it so.
 *
 * The apron under the top is not decoration — it is what stops a wide top from
 * sagging — so it survives every budget, and what a poor table loses is the turn
 * in its legs and the boards in its top.
 */
export function table(options: TableOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 727);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'oak'];
  const style = options.style ?? 'dining';
  const height = Math.max(0.3, options.height ?? 0.75);
  const width = Math.max(0.5, options.width ?? (style === 'round' ? 1.2 : 1.8));
  const depth = Math.max(0.4, options.depth ?? (style === 'round' ? width : 0.9));
  const topThick = Math.max(0.03, Math.min(width, depth) * 0.045);
  const legThick = Math.max(0.05, Math.min(width, depth) * 0.075);
  const turned = style === 'dining' || style === 'round';
  const segments = budget > 1600 ? 12 : budget > 800 ? 9 : 7;

  if (style === 'round') {
    // A pedestal: one turned column on splayed feet, so no knees hit a leg.
    const columnHeight = height - topThick;
    const profile: Vec2[] = [
      [depth * 0.1, 0],
      [depth * 0.16, columnHeight * 0.06],
      [depth * 0.09, columnHeight * 0.3],
      [depth * 0.075, columnHeight * 0.72],
      [depth * 0.13, columnHeight * 0.92],
      [depth * 0.19, columnHeight],
    ];
    const column = lathe(profile, { segments: Math.max(8, segments), caps: true });
    column.translate(0, 0, 0);
    builder.add(take(spent, column), undefined, wood);
    const feet = budget > 900 ? 4 : 3;
    for (let index = 0; index < feet; index += 1) {
      const angle = (index / feet) * Math.PI * 2 + Math.PI / 6;
      const foot = strut(
        [0, columnHeight * 0.1, 0],
        [Math.cos(angle) * depth * 0.36, 0.01, Math.sin(angle) * depth * 0.36],
        legThick * 0.42,
        5,
      );
      builder.add(take(spent, foot), undefined, wood);
      const pad = box(legThick * 1.5, 0.02, legThick * 1.1, { bevel: 0.004, bevelSegments: 1 });
      pad.translate(Math.cos(angle) * depth * 0.36, 0.01, Math.sin(angle) * depth * 0.36);
      const padData = affordable(spent, pad, budget);
      if (padData) builder.add(padData, undefined, wood);
    }
    const disc = cylinder(width / 2, width / 2 * 0.985, topThick, { radialSegments: Math.max(12, segments + 8), caps: true });
    disc.translate(0, height - topThick / 2, 0);
    builder.add(take(spent, disc), undefined, wood);
  } else if (style === 'trestle') {
    for (const side of [-1, 1]) {
      const x = side * (width / 2 - depth * 0.4);
      for (const tilt of [-1, 1]) {
        const rake = strut([x, 0.02, tilt * depth * 0.36], [x, height - topThick, 0], legThick * 0.5, 5);
        builder.add(take(spent, rake), undefined, wood);
      }
      const cap = box(depth * 0.24, legThick * 0.5, depth * 0.9, { bevel: 0.006, bevelSegments: 1 });
      cap.translate(x, height - topThick - legThick * 0.2, 0);
      builder.add(take(spent, cap), undefined, wood);
    }
    const beam = strut([-width / 2 + depth * 0.4, height * 0.42, 0], [width / 2 - depth * 0.4, height * 0.42, 0], legThick * 0.46, 5);
    const beamData = affordable(spent, beam, budget);
    if (beamData) builder.add(beamData, undefined, wood);
    const boards = deck(width, depth, topThick, budget > 900 ? 4 : 3, (options.seed ?? 727) + 3);
    boards.translate(0, height - topThick / 2, 0);
    builder.add(take(spent, boards), undefined, wood);
  } else if (style === 'board') {
    // A board on two sawhorses: the working table of a place with no furniture.
    for (const side of [-1, 1]) {
      const x = side * (width / 2 - 0.12);
      for (const tilt of [-1, 1]) {
        const rake = strut([x + tilt * 0.16, 0.01, 0], [x, height - topThick, 0], legThick * 0.4, 4);
        builder.add(take(spent, rake), undefined, wood);
      }
    }
    const boards = deck(width, depth, topThick, budget > 800 ? 5 : 3, (options.seed ?? 727) + 7);
    boards.translate(0, height - topThick / 2, 0);
    builder.add(take(spent, boards), undefined, wood);
  } else {
    // Four legs, an apron on all four sides, and a top of boards.
    const legX = width / 2 - legThick * 0.8;
    const legZ = depth / 2 - legThick * 0.8;
    for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const part = leg(height - topThick, legThick, turned, segments, (options.seed ?? 727) + corner[0] * 3 + corner[1]);
      part.translate(corner[0] * legX, 0, corner[1] * legZ);
      builder.add(take(spent, part), undefined, wood);
    }
    const apronHeight = Math.min(depth * 0.22, (height - topThick) * 0.22);
    for (const side of [-1, 1]) {
      const long = box(width - legThick * 1.2, apronHeight, legThick * 0.5, { bevel: 0.005, bevelSegments: 1 });
      long.translate(0, height - topThick - apronHeight / 2, side * legZ);
      builder.add(take(spent, long), undefined, wood);
      const short = box(legThick * 0.5, apronHeight, depth - legThick * 1.6, { bevel: 0.005, bevelSegments: 1 });
      short.translate(side * legX, height - topThick - apronHeight / 2, 0);
      const shortData = affordable(spent, short, budget);
      if (shortData) builder.add(shortData, undefined, wood);
    }
    const boards = deck(width, depth, topThick, budget > 1400 ? 6 : budget > 700 ? 4 : 3, (options.seed ?? 727) + 11);
    boards.translate(0, height - topThick / 2, 0);
    builder.add(take(spent, boards), undefined, wood);
    if (budget > 1800 && chance(rng, 0.6)) {
      // A drawer in the apron: a lip and a knob, the only moving part a table has.
      const lip = box(width * 0.3, apronHeight * 0.72, legThick * 0.2, { bevel: 0.004, bevelSegments: 1 });
      lip.translate(0, height - topThick - apronHeight * 0.5, legZ + legThick * 0.3);
      const lipData = affordable(spent, lip, budget);
      if (lipData) builder.add(lipData, undefined, wood);
      const knob = sphere(legThick * 0.22, { widthSegments: 8, heightSegments: 6 });
      knob.translate(0, height - topThick - apronHeight * 0.5, legZ + legThick * 0.44);
      const knobData = affordable(spent, knob, budget);
      if (knobData) builder.add(knobData, undefined, 'brass');
    }
  }

  if (options.cloth) {
    // A cloth hangs over the edge and drops by its own weight, so it is one
    // plane wider and deeper than the top, sagging at the corners.
    const surface = UPHOLSTERY[options.cloth];
    const over = Math.min(width, depth) * 0.16;
    const drape = cloth(
      width + over * 2,
      depth + over * 2,
      budget > 900 ? 8 : 5,
      budget > 900 ? 6 : 4,
      (u, v) => {
        const edgeX = Math.min(u, 1 - u) * 2;
        const edgeZ = Math.min(v, 1 - v) * 2;
        const edge = Math.min(1, Math.min(edgeX, edgeZ) * 2.4);
        return topThick * 0.6 - (1 - edge) * over * 0.9;
      },
    );
    drape.translate(0, height + topThick * 0.4, 0);
    const data = affordable(spent, drape, budget);
    if (data) builder.add(data, undefined, surface);
  }

  seatOnGround(builder);
  return builder;
}

/* -------------------------------------------------------------------- bed */

export interface BedOptions {
  /** `four-poster` carries a tester and curtains; `straw` is a pallet on the floor. */
  style?: 'plain' | 'four-poster' | 'cot' | 'straw';
  wood?: FurnitureWood;
  length?: number;
  width?: number;
  /** Mattress top above the floor. 0.5 m is a bed, 0.2 a pallet. */
  height?: number;
  covering?: Upholstery;
  made?: boolean;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A bed: a frame that holds a mattress off the floor, and the bedding on it.
 *
 * The mattress is wider than the frame and the blanket hangs over the side,
 * because bedding is soft and soft things overhang whatever carries them. A made
 * bed has its blanket pulled square to the mattress; an unmade one has the
 * blanket thrown back and the sheet showing, which is the difference between a
 * room someone slept in and a room in a catalogue.
 */
export function bed(options: BedOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 733);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'pine'];
  const style = options.style ?? 'plain';
  const length = Math.max(1.2, options.length ?? (style === 'cot' ? 1.4 : 2));
  const width = Math.max(0.6, options.width ?? (style === 'cot' ? 0.7 : 1.5));
  const made = options.made ?? true;
  const covering = options.covering ?? 'wool';
  const rail = Math.max(0.06, width * 0.06);
  const pallet = style === 'straw';
  const frameTop = Math.max(0.18, options.height ?? (pallet ? 0.22 : style === 'cot' ? 0.42 : 0.34));
  const mattress = Math.max(0.1, width * 0.13);
  const sheet = UPHOLSTERY[options.covering ?? 'linen'];

  if (pallet) {
    // A pallet is straw roped to a frame: boards, then a straw tick that sags.
    for (const side of [-1, 1]) {
      const board = box(length, rail * 0.7, rail, { bevel: 0.005, bevelSegments: 1 });
      board.translate(0, rail * 0.35, side * (width / 2 - rail * 0.5));
      builder.add(take(spent, board), undefined, wood);
    }
    const tick = box(length * 0.96, mattress, width * 0.94, { bevel: mattress * 0.4, bevelSegments: 2 });
    tick.translate(0, rail * 0.7 + mattress * 0.4, 0);
    builder.add(take(spent, tick), undefined, UPHOLSTERY.straw);
    if (budget > 800) {
      const rope = strut([-length * 0.3, rail * 0.5, -width / 2], [-length * 0.3, rail * 0.5, width / 2], rail * 0.12, 4);
      const data = affordable(spent, rope, budget);
      if (data) builder.add(data, undefined, 'rope');
    }
    const blanket = cloth(length * 0.62, width * 1.06, 6, 4, (u, v) => {
      const edge = Math.min(1, Math.min(v, 1 - v) * 5);
      return mattress * 0.5 - (1 - edge) * mattress * 0.7 + Math.sin(u * Math.PI * 3) * mattress * 0.06;
    });
    blanket.translate(length * (made ? 0 : 0.16), frameTop + mattress * 0.55, 0);
    const blanketData = affordable(spent, blanket, budget);
    if (blanketData) builder.add(blanketData, undefined, UPHOLSTERY[covering]);
    seatOnGround(builder);
    return builder;
  }

  // The frame: two side rails, a head rail and a foot rail, on posts.
  const postHeight = style === 'four-poster' ? frameTop + 1.75 : style === 'cot' ? frameTop + width * 0.42 : frameTop + 0.55;
  const postThick = rail * 0.9;
  for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const [sx, sz] = corner;
    const height = style === 'four-poster' ? postHeight : sz < 0 ? postHeight : postHeight * 0.62;
    const part = post({
      height,
      radius: postThick * 0.62,
      sides: budget > 1400 ? 8 : 6,
      cap: style === 'four-poster' ? 'round' : 'flat',
      seed: (options.seed ?? 733) + sx * 7 + sz * 3,
    });
    part.translate(sx * (length / 2 - postThick * 0.5), 0, sz * (width / 2 - postThick * 0.5));
    builder.add(take(spent, part), undefined, wood);
  }
  for (const side of [-1, 1]) {
    const railPart = box(length - postThick, rail, rail * 0.7, { bevel: 0.005, bevelSegments: 1 });
    railPart.translate(0, frameTop - rail * 0.5, side * (width / 2 - postThick * 0.5));
    builder.add(take(spent, railPart), undefined, wood);
  }
  for (const end of [-1, 1]) {
    const railPart = box(postThick * 0.7, rail * (end < 0 ? 1.5 : 0.8), width - postThick, { bevel: 0.005, bevelSegments: 1 });
    railPart.translate(end * (length / 2 - postThick * 0.5), frameTop - rail * (end < 0 ? 0.75 : 0.4), 0);
    builder.add(take(spent, railPart), undefined, wood);
  }

  // Slats across the frame carry the mattress; a poor bed keeps two of them.
  const slats = Math.max(2, budget > 1600 ? 6 : budget > 700 ? 4 : 2);
  for (let index = 0; index < slats; index += 1) {
    const t = slats === 1 ? 0.5 : index / (slats - 1);
    const slat = box(rail * 0.5, rail * 0.3, width - postThick * 1.4, { bevel: 0, bevelSegments: 1 });
    slat.translate(-length / 2 + postThick + (length - postThick * 2) * t, frameTop - rail * 0.85, 0);
    const data = affordable(spent, slat, budget);
    if (data) builder.add(data, undefined, wood);
  }

  // The mattress overshoots the rails: bedding is soft and does not stop square.
  const mattressPart = box(length - postThick * 0.8, mattress, width - postThick * 0.4, {
    bevel: mattress * 0.42,
    bevelSegments: 2,
  });
  mattressPart.translate(0, frameTop + mattress * 0.36, 0);
  builder.add(take(spent, mattressPart), undefined, sheet);

  const bedTop = frameTop + mattress * 0.8;
  // The pillow sits at the head, and an unmade bed has it pushed to one side.
  const pillow = box(width * 0.42, mattress * 0.42, width * 0.3, { bevel: mattress * 0.2, bevelSegments: 2 });
  pillow.rotateY(made ? 0 : range(rng, -0.2, 0.24));
  pillow.translate(-length * 0.36, bedTop + mattress * 0.2, made ? 0 : range(rng, -width * 0.12, width * 0.12));
  const pillowData = affordable(spent, pillow, budget);
  if (pillowData) builder.add(pillowData, undefined, 'fabric-linen');

  // The blanket is one sheet of cloth, thrown back when the bed is unmade.
  const blanketLength = length * (made ? 0.72 : 0.5);
  const blanket = cloth(blanketLength, width * 1.08, budget > 900 ? 8 : 5, 5, (u, v) => {
    const edge = Math.min(1, Math.min(v, 1 - v) * 4.5);
    const fold = made ? 0 : Math.max(0, u - 0.72) * mattress * 1.6;
    return mattress * 0.42 - (1 - edge) * mattress * 0.85 + fold + Math.sin(u * Math.PI * 2.4) * mattress * 0.05;
  });
  blanket.translate(length * (made ? 0.08 : 0.24), bedTop + mattress * 0.2, 0);
  const blanketData = affordable(spent, blanket, budget);
  if (blanketData) builder.add(blanketData, undefined, UPHOLSTERY[covering]);

  if (style === 'four-poster' && budget > 900) {
    // A tester over the posts and curtains hung at the sides, one plane each.
    const tester = box(length * 0.98, rail * 0.5, width * 0.98, { bevel: 0.008, bevelSegments: 1 });
    tester.translate(0, postHeight - rail * 0.25, 0);
    const testerData = affordable(spent, tester, budget);
    if (testerData) builder.add(testerData, undefined, wood);
    const valance = cloth(length * 0.98, rail * 2.2, 6, 2, (u) => -Math.sin(u * Math.PI * 4) * rail * 0.24);
    valance.rotateX(Math.PI / 2);
    valance.translate(0, postHeight - rail * 1.5, width * 0.49);
    const valanceData = affordable(spent, valance, budget);
    if (valanceData) builder.add(valanceData, undefined, UPHOLSTERY[covering]);
    for (const side of [-1, 1]) {
      const curtain = cloth(length * 0.9, postHeight - frameTop, 6, 6, (u, v) => {
        const gather = Math.sin(u * Math.PI * 5) * width * 0.02 * (1 - v * 0.5);
        return gather;
      });
      curtain.rotateX(Math.PI / 2);
      curtain.rotateY(side > 0 ? 0 : Math.PI);
      curtain.translate(0, frameTop + (postHeight - frameTop) / 2, side * (width / 2 - postThick * 0.2));
      const data = affordable(spent, curtain, budget);
      if (data) builder.add(data, undefined, UPHOLSTERY[covering]);
    }
  }

  if (style === 'cot') {
    // A cot has bars down both sides so a child cannot fall out.
    const bars = Math.max(3, budget > 900 ? 7 : 4);
    for (const side of [-1, 1]) {
      for (let index = 0; index < bars; index += 1) {
        const t = index / (bars - 1);
        const bar = cylinder(rail * 0.14, rail * 0.14, width * 0.42, { radialSegments: 4 });
        bar.translate(-length / 2 + postThick + (length - postThick * 2) * t, frameTop + width * 0.21, side * (width / 2 - postThick * 0.5));
        const data = affordable(spent, bar, budget);
        if (data) builder.add(data, undefined, wood);
      }
    }
  }

  seatOnGround(builder);
  return builder;
}

/* --------------------------------------------------------------- wardrobe */

export interface WardrobeOptions {
  /** `open` hangs one door on its hinge line so the inside reads. */
  style?: 'plain' | 'panel' | 'open' | 'linen-press';
  wood?: FurnitureWood;
  width?: number;
  height?: number;
  depth?: number;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A wardrobe: a carcass, a cornice, doors on their hinge line and feet that
 * hold it off a floor that is never quite flat.
 *
 * An open door is rotated about the stile it hangs on rather than lifted off the
 * carcass, so the gap at the hinge stays closed and the door stays the thickness
 * it was made in.
 */
export function wardrobe(options: WardrobeOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 739);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'walnut'];
  const style = options.style ?? 'panel';
  const width = Math.max(0.6, options.width ?? 1.2);
  const height = Math.max(1.2, options.height ?? 2);
  const depth = Math.max(0.35, options.depth ?? 0.6);
  const wall = Math.max(0.025, Math.min(width, depth) * 0.055);
  const footHeight = height * 0.05;
  const bodyHeight = height - footHeight - wall * 1.6;

  // The carcass: two sides, a top, a bottom and a back, each a board.
  const carcassBevel = budget > 700 ? wall * 0.14 : 0;
  for (const side of [-1, 1]) {
    const panel = box(wall, bodyHeight, depth, { bevel: carcassBevel, bevelSegments: 1 });
    panel.translate(side * (width / 2 - wall / 2), footHeight + bodyHeight / 2, 0);
    builder.add(take(spent, panel), undefined, wood);
  }
  for (const end of [-1, 1]) {
    const shelfPart = box(width - wall * 2, wall, depth - wall * 0.4, { bevel: carcassBevel, bevelSegments: 1 });
    shelfPart.translate(0, footHeight + (end < 0 ? wall / 2 : bodyHeight - wall / 2), 0);
    builder.add(take(spent, shelfPart), undefined, wood);
  }
  const back = box(width - wall * 1.6, bodyHeight - wall, wall * 0.5, { bevel: 0, bevelSegments: 1 });
  back.translate(0, footHeight + bodyHeight / 2, -depth / 2 + wall * 0.4);
  builder.add(take(spent, back), undefined, wood);

  // Feet: a plinth with a bracket cut out of each corner.
  for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const foot = box(width * 0.22, footHeight, depth * 0.22, { bevel: carcassBevel, bevelSegments: 1 });
    foot.translate(corner[0] * (width / 2 - width * 0.11), footHeight / 2, corner[1] * (depth / 2 - depth * 0.11));
    builder.add(take(spent, foot), undefined, wood);
  }
  const plinth = box(width, footHeight * 0.5, depth * 0.9, { bevel: wall * 0.16, bevelSegments: 1 });
  plinth.translate(0, footHeight * 0.75, 0);
  const plinthData = affordable(spent, plinth, budget);
  if (plinthData) builder.add(plinthData, undefined, wood);

  // A cornice that overshoots the carcass, because that is what a cornice is for.
  const cornice = box(width * 1.06, wall * 1.5, depth * 1.06, { bevel: wall * 0.3, bevelSegments: 1 });
  cornice.translate(0, height - wall * 0.75, 0);
  const corniceData = affordable(spent, cornice, budget);
  if (corniceData) builder.add(corniceData, undefined, wood);

  const doorHeight = bodyHeight - wall * 1.6;
  const doorWidth = (width - wall * 2.6) / 2;
  const open = style === 'open' ? range(rng, 0.5, 0.95) : 0;
  // A door is the most expensive board in the piece, so a poor wardrobe gets one
  // panel of solid infill and a rich one gets two panels of boarding.
  const framed = budget > 900;
  const doorInfill = framed && style !== 'plain' ? 'plank' : 'solid';
  const doorPanels = budget > 1600 ? 2 : 1;
  for (const side of [-1, 1]) {
    // Each door hangs on the carcass side it stands at, not on the meeting stile:
    // the hinge is the door's outer edge, so that edge is carried to the origin,
    // the door is swung about it, and the hinge is put back where the carcass has
    // it. The swing is signed per side so both doors open outward, toward +Z.
    const hingeX = side * (doorWidth + wall * 0.3);
    const swing = side < 0 ? -open : open;
    const panel = framed
      ? framedPanel({
        width: doorWidth,
        height: doorHeight,
        frame: doorWidth * 0.16,
        thickness: wall * 0.8,
        infill: doorInfill,
        panels: doorPanels,
        seed: (options.seed ?? 739) + side * 11,
      })
      : planks({
        // A poor wardrobe has boarded doors: two boards and no frame, which is a
        // fifth of the triangles and still a door that shuts.
        width: doorWidth,
        height: doorHeight,
        thickness: wall * 0.8,
        count: 2,
        bevel: 0,
        seed: (options.seed ?? 739) + side * 11,
      });
    void doorInfill;
    const knob = sphere(wall * 0.42, { widthSegments: 8, heightSegments: 6 });
    knob.translate(-side * doorWidth * 0.4, doorHeight * 0.02, wall * 0.9);
    const knobData = affordable(spent, knob, budget);
    panel.translate(-side * doorWidth / 2, 0, 0);
    panel.rotateY(swing);
    if (knobData) {
      knob.rotateY(swing);
      panel.add(knobData, undefined, 'brass');
    }
    panel.translate(hingeX, footHeight + wall + doorHeight / 2, depth / 2 - wall * 0.2);
    builder.add(take(spent, panel), undefined, wood);
  }

  if (open > 0.2 && budget > 800) {
    // A rail with clothes on it, visible through the open door: the use of the thing.
    const rail = cylinder(wall * 0.22, wall * 0.22, width - wall * 3, { radialSegments: 5 });
    rail.rotateZ(Math.PI / 2);
    rail.translate(0, footHeight + bodyHeight * 0.86, -depth * 0.06);
    const railData = affordable(spent, rail, budget);
    if (railData) builder.add(railData, undefined, 'iron-wrought');
    const garments = Math.max(2, intRange(rng, 3, 5));
    for (let index = 0; index < garments; index += 1) {
      const at = -width * 0.3 + (width * 0.6 * index) / Math.max(1, garments - 1);
      const hang = cloth(width * 0.14, bodyHeight * range(rng, 0.42, 0.6), 2, 4, (u, v) => Math.sin(u * Math.PI * 2) * width * 0.02 * v);
      hang.rotateX(Math.PI / 2);
      hang.translate(at, footHeight + bodyHeight * 0.86 - bodyHeight * 0.26, -depth * 0.06);
      const data = affordable(spent, hang, budget);
      if (data) builder.add(data, undefined, index % 2 === 0 ? 'fabric-blue' : 'fabric-linen');
    }
  }

  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ shelf */

export interface ShelfOptions {
  /** `wall` hangs on brackets; `open` stands on the floor; `dresser` has a counter. */
  style?: 'open' | 'wall' | 'dresser';
  wood?: FurnitureWood;
  width?: number;
  height?: number;
  depth?: number;
  shelves?: number;
  goods?: 'none' | 'pots' | 'books' | 'mixed';
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A shelf: uprights, boards, and whatever the boards are holding.
 *
 * The goods are the point — a shelf with nothing on it is a ladder — so they are
 * budgeted rather than assumed, and a poor shelf keeps every board and loses the
 * pots. Boards never thin out with the budget, because a 12 mm shelf sags and a
 * sagging shelf is the one thing a carpenter is judged on.
 */
export function shelf(options: ShelfOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 743);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'pine'];
  const style = options.style ?? 'open';
  const width = Math.max(0.4, options.width ?? 1);
  const height = Math.max(0.5, options.height ?? (style === 'wall' ? 0.9 : 1.8));
  const depth = Math.max(0.16, options.depth ?? (style === 'wall' ? 0.22 : 0.35));
  const wall = Math.max(0.02, Math.min(width, depth) * 0.07);
  const wanted = Math.max(2, Math.round(options.shelves ?? (style === 'wall' ? 2 : Math.max(3, Math.round(height / 0.42)))));
  const goods = options.goods ?? (style === 'dresser' ? 'mixed' : 'pots');

  if (style === 'wall') {
    // A wall shelf hangs on brackets; the boards carry the load to them.
    for (let index = 0; index < wanted; index += 1) {
      const t = wanted === 1 ? 0.5 : index / (wanted - 1);
      const board = box(width, wall, depth, { bevel: wall * 0.18, bevelSegments: 1 });
      board.translate(0, height * (0.2 + t * 0.8) - wall / 2, 0);
      builder.add(take(spent, board), undefined, wood);
      if (budget > 700) {
        for (const side of [-1, 1]) {
          const bracket = strut(
            [side * width * 0.34, height * (0.2 + t * 0.8) - wall, -depth * 0.4],
            [side * width * 0.34, height * (0.2 + t * 0.8) - wall - depth * 0.5, -depth * 0.4],
            wall * 0.3,
            4,
          );
          const data = affordable(spent, bracket, budget);
          if (data) builder.add(data, undefined, 'iron-wrought');
        }
      }
    }
    const railPart = box(width * 1.04, wall * 1.4, wall * 0.8, { bevel: wall * 0.2, bevelSegments: 1 });
    railPart.translate(0, height - wall * 0.7, -depth * 0.4);
    const railData = affordable(spent, railPart, budget);
    if (railData) builder.add(railData, undefined, wood);
    placeGoods(builder, spent, budget, rng, width, height, depth, wanted, goods, style);
    seatOnGround(builder);
    return builder;
  }

  // A standing shelf: two uprights, a back, and boards tenoned between them.
  for (const side of [-1, 1]) {
    const upright = box(wall, height, depth, { bevel: wall * 0.16, bevelSegments: 1 });
    upright.translate(side * (width / 2 - wall / 2), height / 2, 0);
    builder.add(take(spent, upright), undefined, wood);
  }
  const back = box(width - wall * 1.6, height - wall, wall * 0.4, { bevel: 0, bevelSegments: 1 });
  back.translate(0, height / 2, -depth / 2 + wall * 0.3);
  const backData = affordable(spent, back, budget);
  if (backData) builder.add(backData, undefined, wood);
  for (let index = 0; index <= wanted; index += 1) {
    const t = index / wanted;
    const board = box(width - wall * 1.4, wall, depth - wall * 0.3, { bevel: wall * 0.16, bevelSegments: 1 });
    board.translate(0, wall / 2 + (height - wall) * t, 0);
    builder.add(take(spent, board), undefined, wood);
  }
  if (style === 'dresser' && budget > 900) {
    // A dresser has a counter at waist height and a plate rail along the top.
    const counter = box(width * 1.08, wall * 1.3, depth * 1.24, { bevel: wall * 0.24, bevelSegments: 1 });
    counter.translate(0, height * 0.48, depth * 0.08);
    const data = affordable(spent, counter, budget);
    if (data) builder.add(data, undefined, wood);
    const railPart = cylinder(wall * 0.24, wall * 0.24, width - wall * 2, { radialSegments: 5 });
    railPart.rotateZ(Math.PI / 2);
    railPart.translate(0, height - wall * 1.6, -depth * 0.2);
    const railData = affordable(spent, railPart, budget);
    if (railData) builder.add(railData, undefined, wood);
  }
  placeGoods(builder, spent, budget, rng, width, height, depth, wanted, goods, style);
  seatOnGround(builder);
  return builder;
}

/** Pots, jars and books on a shelf's boards, placed board by board. */
function placeGoods(
  builder: MeshBuilder,
  spent: Spend,
  budget: number,
  rng: ReturnType<typeof detailRng>,
  width: number,
  height: number,
  depth: number,
  shelves: number,
  goods: 'none' | 'pots' | 'books' | 'mixed',
  style: 'open' | 'wall' | 'dresser',
): void {
  if (goods === 'none') return;
  const wall = Math.max(0.02, Math.min(width, depth) * 0.07);
  // The top board of a standing shelf is left clear: a pot on top of a shelf is
  // not on the shelf, and it makes the piece taller than the height it was asked
  // for, which is the one thing the reference table judges it by.
  const rows = style === 'wall' ? shelves : Math.max(1, shelves);
  for (let row = 0; row < rows; row += 1) {
    const boardY = style === 'wall' ? height * (0.2 + (rows === 1 ? 0.5 : row / (rows - 1)) * 0.8) : wall / 2 + (height - wall) * (row / Math.max(1, shelves));
    if (goods === 'books' || (goods === 'mixed' && row % 2 === 1)) {
      // Books lean and crowd: a row is a run of spines with one gap and one tilt.
      const spine = Math.max(0.02, width * 0.028);
      const count = Math.max(3, Math.round((width * 0.86) / (spine * 1.5)));
      let at = -width * 0.43;
      for (let index = 0; index < count; index += 1) {
        const clearance = style === 'wall' ? height * 0.4 : (height - wall) / Math.max(1, shelves);
      const bookHeight = Math.min(depth * range(rng, 1.1, 1.9), clearance * 0.86);
        const bookWidth = spine * range(rng, 0.7, 1.5);
        const gap = chance(rng, 0.14);
        if (gap) at += bookWidth * 2;
        if (at + bookWidth > width * 0.44) break;
        const book = box(bookWidth, bookHeight, depth * 0.72, { bevel: bookWidth * 0.16, bevelSegments: 1 });
        const lean = index === count - 1 ? range(rng, 0.1, 0.24) : range(rng, -0.02, 0.02);
        book.rotateZ(lean);
        book.translate(at + bookWidth / 2, boardY + wall * 0.5 + bookHeight / 2 - lean * bookWidth * 0.4, depth * 0.02);
        const surface = index % 3 === 0 ? 'leather' : index % 3 === 1 ? 'leather-dark' : 'fabric-blue';
        const data = affordable(spent, book, budget);
        if (data) builder.add(data, undefined, surface);
        at += bookWidth * 1.18;
      }
      continue;
    }
    // Pots and jars: three or four across a board, no two the same size.
    const pots = Math.max(2, Math.round(width / 0.3));
    for (let index = 0; index < pots; index += 1) {
      if (!chance(rng, 0.82)) continue;
      const at = -width * 0.4 + (width * 0.8 * (index + 0.5)) / pots;
      // A pot has to fit the row it stands in and the board it stands on, or it
      // is not a pot for that shelf: too tall and it comes through the board
      // above, too fat and it stands proud of the front edge.
      const clearance = style === 'wall' ? height * 0.4 : (height - wall) / Math.max(1, shelves);
      const potHeight = Math.min(depth * range(rng, 0.9, 1.5), clearance * 0.8);
      const pot = cylinder(potHeight * 0.26, potHeight * 0.3, potHeight, {
        radialSegments: budget > 1200 ? 9 : 6,
        wobble: 0.05,
        wobbleSeed: index + row * 5,
      });
      pot.translate(at + range(rng, -0.02, 0.02), boardY + wall * 0.5 + potHeight / 2, depth * range(rng, -0.06, 0.06));
      const surface = index % 2 === 0 ? 'ceramic' : 'terracotta';
      const data = affordable(spent, pot, budget);
      if (data) builder.add(data, undefined, surface);
    }
  }
}

/* ------------------------------------------------------------------ chest */

export interface ChestOptions {
  /** `domed` is a sea chest; `strong` is iron-bound; `coffer` sits on a plinth. */
  style?: 'flat' | 'domed' | 'strong' | 'coffer';
  lid?: 'closed' | 'ajar' | 'open' | 'off';
  wood?: FurnitureWood;
  width?: number;
  height?: number;
  depth?: number;
  contents?: 'none' | 'cloth' | 'coin' | 'tools';
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A chest: a box with a lid on a hinge line, strapped in iron because wood
 * splits along the grain and a chest is carried by its ends.
 *
 * An open lid rotates about the hinge at the back rather than being lifted away,
 * so the inside of the lid is visible and the gap at the hinge stays shut. What
 * is in the chest is budgeted like anything else: a poor chest keeps its straps
 * and loses its contents.
 */
export function chest(options: ChestOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 751);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'oak'];
  const style = options.style ?? 'flat';
  const lid = options.lid ?? 'closed';
  const width = Math.max(0.4, options.width ?? 0.9);
  const depth = Math.max(0.3, options.depth ?? 0.5);
  const wall = Math.max(0.022, Math.min(width, depth) * 0.06);
  const bodyHeight = Math.max(0.18, (options.height ?? 0.55) - (style === 'domed' ? depth * 0.3 : wall * 1.6));
  const iron = style === 'strong' ? 'iron-rusted' : 'iron-wrought';
  const swing = lid === 'open' ? range(rng, 1.5, 1.9) : lid === 'ajar' ? range(rng, 0.2, 0.42) : 0;
  /** Anything but a shut lid shows what the chest is holding. */
  const shown = lid !== 'closed';

  // The body: front, back and two ends, with a floor inside.
  for (const side of [-1, 1]) {
    const end = box(wall, bodyHeight, depth, { bevel: wall * 0.14, bevelSegments: 1 });
    end.translate(side * (width / 2 - wall / 2), bodyHeight / 2, 0);
    builder.add(take(spent, end), undefined, wood);
  }
  for (const face of [-1, 1]) {
    const board = planks({
      width: width - wall * 1.6,
      height: bodyHeight - wall * 0.4,
      thickness: wall * 0.8,
      count: Math.max(2, budget > 1200 ? 4 : 3),
      horizontal: true,
      seed: (options.seed ?? 751) + face * 5,
    });
    board.translate(0, bodyHeight / 2, face * (depth / 2 - wall * 0.5));
    builder.add(take(spent, board), undefined, wood);
  }
  const floor = box(width - wall * 1.6, wall * 0.6, depth - wall * 1.2, { bevel: 0, bevelSegments: 1 });
  floor.translate(0, wall * 0.3, 0);
  const floorData = affordable(spent, floor, budget);
  if (floorData) builder.add(floorData, undefined, wood);

  // Iron straps run over the ends and up the lid, which is how a chest is carried.
  const straps = Math.max(2, budget > 1400 ? 3 : 2);
  for (let index = 0; index < straps; index += 1) {
    const t = straps === 1 ? 0.5 : index / (straps - 1);
    const at = -width * 0.34 + width * 0.68 * t;
    const strap = box(wall * 0.5, bodyHeight * 1.02, depth + wall * 0.4, { bevel: 0, bevelSegments: 1 });
    strap.translate(at, bodyHeight / 2, 0);
    const data = affordable(spent, strap, budget);
    if (data) builder.add(data, undefined, iron);
  }
  for (const side of [-1, 1]) {
    const handle = torus(depth * 0.14, wall * 0.16, { radialSegments: 4, tubularSegments: 8, arc: Math.PI });
    handle.rotateY(Math.PI / 2);
    handle.rotateX(Math.PI);
    handle.translate(side * (width / 2 + wall * 0.1), bodyHeight * 0.62, 0);
    const data = affordable(spent, handle, budget);
    if (data) builder.add(data, undefined, iron);
  }

  // The lid, hung on the hinge line at the back — or, when it has been taken off,
  // leaning against the side of the chest it came from, on the floor.
  {
    const lidPart = new MeshBuilder();
    if (style === 'domed') {
      // A sea chest's lid is a half cylinder: an extruded semicircle, so the
      // curve is real in section rather than a box with a bevel on it.
      const radius = depth / 2;
      const profile: Vec2[] = [];
      const points = budget > 1200 ? 9 : 6;
      for (let index = 0; index <= points; index += 1) {
        const angle = (index / points) * Math.PI;
        profile.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
      }
      const dome = extrude(profile, { depth: width - wall * 0.4, bevel: wall * 0.1, bevelSegments: 1 });
      dome.rotateY(Math.PI / 2);
      dome.translate((width - wall * 0.4) / 2, 0, 0);
      lidPart.add(dome);
    } else {
      const boards = planks({
        width: width - wall * 0.4,
        height: depth - wall * 0.4,
        thickness: wall * 0.9,
        count: Math.max(2, budget > 1200 ? 4 : 3),
        seed: (options.seed ?? 751) + 23,
      });
      boards.rotateX(-Math.PI / 2);
      boards.translate(0, wall * 0.45, 0);
      lidPart.add(boards);
      const lip = box(width - wall * 0.2, wall * 0.9, depth - wall * 0.2, { bevel: wall * 0.12, bevelSegments: 1 });
      lip.translate(0, -wall * 0.1, 0);
      lidPart.add(lip, undefined, wood);
    }
    if (lid === 'off') {
      // Set down beside the chest and leaning away from it, not floating over it.
      // A leaning board dips one corner below the floor, and if it is left there
      // `seatOnGround` lifts the whole chest to rescue it — a trough standing ten
      // centimetres in the air. So the lid is raised by its own dip and rests on
      // the ground while the chest stays on the ground too.
      lidPart.rotateZ(-0.22);
      const dip = -boundsOf(lidPart.build()).min[1];
      lidPart.translate(width * 0.72, dip + wall * 0.2, depth * 0.14);
    } else {
      // Rotate about the hinge at the back top edge, then put the hinge back.
      lidPart.translate(0, 0, depth / 2 - wall * 0.2);
      lidPart.rotateX(-swing);
      lidPart.translate(0, bodyHeight, -(depth / 2 - wall * 0.2));
    }
    builder.add(take(spent, lidPart), undefined, wood);
    if (budget > 900) {
      const hasp = box(wall * 0.6, wall * 1.6, wall * 0.5, { bevel: 0, bevelSegments: 1 });
      hasp.translate(0, bodyHeight * (swing > 0.1 ? 1 : 0.98), depth / 2 - wall * 0.1);
      const data = affordable(spent, hasp, budget);
      if (data) builder.add(data, undefined, iron);
      const lock = box(wall * 1.2, wall * 1.2, wall * 0.4, { bevel: wall * 0.1, bevelSegments: 1 });
      lock.translate(0, bodyHeight * 0.86, depth / 2 + wall * 0.1);
      const lockData = affordable(spent, lock, budget);
      if (lockData) builder.add(lockData, undefined, 'brass');
    }
  }

  // Contents, only where an open lid can show them.
  if (shown && options.contents && options.contents !== 'none') {
    const floorY = wall * 0.6;
    if (options.contents === 'cloth') {
      const heap = cloth(width * 0.8, depth * 0.7, 5, 4, (u, v) => Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * depth * 0.24);
      heap.translate(0, floorY + bodyHeight * 0.2, 0);
      const data = affordable(spent, heap, budget);
      if (data) builder.add(data, undefined, 'fabric-linen');
    } else if (options.contents === 'coin') {
      const coins = Math.max(6, budget > 1400 ? 18 : 9);
      for (let index = 0; index < coins; index += 1) {
        const at = [-width * 0.34 + range(rng, 0, width * 0.68), 0, -depth * 0.3 + range(rng, 0, depth * 0.6)] as Vec3;
        const coin = cylinder(depth * 0.07, depth * 0.07, wall * 0.16, { radialSegments: 6 });
        coin.rotateX(range(rng, -0.3, 0.3));
        coin.translate(at[0], floorY + wall * 0.2 + (index % 3) * wall * 0.18, at[2]);
        const data = affordable(spent, coin, budget);
        if (data) builder.add(data, undefined, index % 4 === 0 ? 'brass' : 'gold');
      }
    } else {
      // Tools: a hammer and a chisel lying across the bottom.
      const haft = cylinder(wall * 0.22, wall * 0.26, width * 0.5, { radialSegments: 5 });
      haft.rotateZ(Math.PI / 2);
      haft.translate(0, floorY + wall * 0.5, depth * 0.1);
      const haftData = affordable(spent, haft, budget);
      if (haftData) builder.add(haftData, undefined, 'wood-dark');
      const head = box(wall * 1.4, wall * 1.1, wall * 2.2, { bevel: wall * 0.16, bevelSegments: 1 });
      head.translate(width * 0.2, floorY + wall * 0.6, depth * 0.1);
      const headData = affordable(spent, head, budget);
      if (headData) builder.add(headData, undefined, 'iron-wrought');
    }
  }

  if (style === 'coffer') {
    // A coffer stands on a plinth rather than on the floor.
    const plinth = box(width * 1.04, wall * 1.4, depth * 1.04, { bevel: wall * 0.2, bevelSegments: 1 });
    plinth.translate(0, -wall * 0.2, 0);
    builder.add(take(spent, plinth), undefined, wood);
    builder.translate(0, wall * 1.2, 0);
  }

  seatOnGround(builder);
  return builder;
}

/* ----------------------------------------------------------------- throne */

export interface ThroneOptions {
  style?: 'gothic' | 'classical' | 'warlord';
  wood?: FurnitureWood;
  metal?: 'gold' | 'bronze' | 'iron';
  upholstery?: Upholstery;
  /** Raises the seat on a dais, which is most of what a throne is. */
  dais?: number;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A throne: a chair that has been made taller than the room requires.
 *
 * Everything about it is scale used as an argument — a back that rises past a
 * standing eye, a seat on a step, arms wide enough to hold a sceptre. The
 * decoration is budgeted like any other, but the height never is: a cheap throne
 * is a plain one, not a low one.
 */
export function throne(options: ThroneOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 757);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'walnut'];
  const metal = options.metal ?? 'gold';
  const surface = metal === 'gold' ? 'gold' : metal === 'bronze' ? 'bronze' : 'iron-wrought';
  const style = options.style ?? 'gothic';
  const upholstery = options.upholstery ?? 'velvet';
  const dais = Math.max(0, options.dais ?? 0.2);
  const width = 1.1;
  const depth = 1;
  const seat = dais + 0.5;
  const back = style === 'gothic' ? 1.9 : style === 'classical' ? 1.35 : 1.5;
  const wall = 0.07;

  if (dais > 0) {
    const steps = Math.max(1, Math.round(dais / 0.12));
    for (let index = 0; index < steps; index += 1) {
      const t = (index + 1) / steps;
      const step = box(width * (1.5 - t * 0.24), dais / steps, depth * (1.5 - t * 0.3), { bevel: 0.01, bevelSegments: 1 });
      step.translate(0, (dais / steps) * (index + 0.5), depth * (0.5 - t * 0.15) * 0.3);
      builder.add(take(spent, step), undefined, style === 'warlord' ? 'stone-rough' : 'marble');
    }
  }

  // The seat box and its four legs, which are carved rather than turned.
  for (const corner of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const part = box(wall * 1.5, seat - dais, wall * 1.5, { bevel: wall * 0.24, bevelSegments: 1 });
    part.translate(corner[0] * (width / 2 - wall), dais + (seat - dais) / 2, corner[1] * (depth / 2 - wall));
    builder.add(take(spent, part), undefined, wood);
  }
  const seatBox = box(width - wall * 0.6, wall * 1.2, depth - wall * 0.6, { bevel: wall * 0.2, bevelSegments: 1 });
  seatBox.translate(0, seat - wall * 0.4, 0);
  builder.add(take(spent, seatBox), undefined, wood);
  const cushion = box(width - wall * 1.2, wall * 1.5, depth - wall * 1.2, { bevel: wall * 0.7, bevelSegments: 2 });
  cushion.translate(0, seat + wall * 0.5, 0);
  const cushionData = affordable(spent, cushion, budget);
  if (cushionData) builder.add(cushionData, undefined, UPHOLSTERY[upholstery]);

  // The back: a tall panel with a shaped top, inlaid or plain by budget.
  const backPart = new MeshBuilder();
  const panel = framedPanel({
    width: width - wall * 1.4,
    height: back - seat + dais * 0.4,
    frame: wall * 1.1,
    thickness: wall * 0.7,
    infill: budget > 1200 ? 'plank' : 'solid',
    seed: (options.seed ?? 757) + 3,
  });
  panel.translate(0, (back - seat) / 2, 0);
  backPart.add(panel, undefined, wood);
  if (style === 'gothic') {
    // A pointed head: two raking members meeting over the panel.
    for (const side of [-1, 1]) {
      const rake = strut(
        [side * (width / 2 - wall * 0.9), back - seat * 0.62, 0],
        [0, back - seat + wall * 1.6, 0],
        wall * 0.5,
        5,
      );
      backPart.add(rake, undefined, wood);
    }
    const finial = spike({ height: wall * 4, radius: wall * 0.5, sides: 6 });
    finial.translate(0, back - seat + wall * 1.4, 0);
    backPart.add(finial, undefined, surface);
  } else if (style === 'classical') {
    const cornice = box(width * 1.1, wall * 1.6, wall * 1.6, { bevel: wall * 0.3, bevelSegments: 1 });
    cornice.translate(0, back - seat + wall * 0.8, 0);
    backPart.add(cornice, undefined, wood);
    for (const side of [-1, 1]) {
      const volute = torus(wall * 1.1, wall * 0.36, { radialSegments: 4, tubularSegments: 9, arc: Math.PI * 1.4 });
      volute.translate(side * (width / 2 - wall * 0.4), back - seat + wall * 2, 0);
      backPart.add(volute, undefined, surface);
    }
  } else {
    // A warlord's back is a rack of points, not a panel frame.
    const points = budget > 1200 ? 5 : 3;
    for (let index = 0; index < points; index += 1) {
      const t = index / (points - 1);
      const point = spike({ height: wall * (3 + Math.sin(t * Math.PI) * 2.4), radius: wall * 0.44, sides: 5 });
      point.translate(-width * 0.4 + width * 0.8 * t, back - seat + wall, 0);
      backPart.add(point, undefined, surface);
    }
  }
  backPart.translate(0, seat, -depth / 2 + wall * 0.6);
  backPart.rotateX(-0.06);
  backPart.translate(0, 0, -Math.sin(0.06) * (back - seat) * 0.5);
  builder.add(take(spent, backPart), undefined, wood);

  // Arms wide enough to rest a forearm on, with a support at the front.
  for (const side of [-1, 1]) {
    const arm = box(wall * 1.3, wall * 0.9, depth * 0.82, { bevel: wall * 0.2, bevelSegments: 1 });
    arm.translate(side * (width / 2 - wall * 0.4), seat + wall * 2.4, depth * 0.02);
    const armData = affordable(spent, arm, budget);
    if (armData) builder.add(armData, undefined, wood);
    const support = box(wall * 1.1, wall * 2.6, wall * 1.1, { bevel: wall * 0.2, bevelSegments: 1 });
    support.translate(side * (width / 2 - wall * 0.4), seat + wall * 0.9, depth * 0.38);
    const supportData = affordable(spent, support, budget);
    if (supportData) builder.add(supportData, undefined, wood);
    if (budget > 1600) {
      const boss = sphere(wall * 0.7, { widthSegments: 8, heightSegments: 6 });
      boss.translate(side * (width / 2 - wall * 0.4), seat + wall * 3.1, depth * 0.38);
      const data = affordable(spent, boss, budget);
      if (data) builder.add(data, undefined, surface);
    }
  }

  if (budget > 2200 && style !== 'warlord' && chance(rng, 0.8)) {
    // A banner behind the seat: one plane of cloth, hung from a rod.
    const rod = cylinder(wall * 0.22, wall * 0.22, width * 1.5, { radialSegments: 5 });
    rod.rotateZ(Math.PI / 2);
    rod.translate(0, back + wall * 1.4, -depth / 2 + wall * 0.2);
    const rodData = affordable(spent, rod, budget);
    if (rodData) builder.add(rodData, undefined, surface);
    const banner = cloth(width * 1.3, back * 0.72, 6, 6, (u, v) => Math.sin(u * Math.PI * 3) * width * 0.03 * v);
    banner.rotateX(Math.PI / 2);
    banner.translate(0, back + wall * 1.4 - back * 0.36, -depth / 2 + wall * 0.1);
    const bannerData = affordable(spent, banner, budget);
    if (bannerData) builder.add(bannerData, undefined, UPHOLSTERY[upholstery]);
  }

  seatOnGround(builder);
  return builder;
}

/* -------------------------------------------------------------- bookshelf */

export interface BookshelfOptions {
  wood?: FurnitureWood;
  width?: number;
  height?: number;
  depth?: number;
  bays?: number;
  /** 0 leaves the shelves empty, 1 fills every one to the top of its row. */
  fill?: number;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A bookshelf: a carcass, shelves, and the books that make it one.
 *
 * Books are the most repeated unit in the library after masonry, so they are
 * planned like masonry: as many as the allowance buys, evenly spread across
 * every bay, with the gaps a real shelf has. A poor bookshelf is a sparse one,
 * never a short one — the carcass keeps its full height at every budget.
 */
export function bookshelf(options: BookshelfOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 761);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const wood = WOOD[options.wood ?? 'walnut'];
  const width = Math.max(0.5, options.width ?? 1.2);
  const height = Math.max(0.8, options.height ?? 2.2);
  const depth = Math.max(0.2, options.depth ?? 0.4);
  const bays = Math.max(1, Math.round(options.bays ?? (width > 1.6 ? 2 : 1)));
  const fill = Math.max(0, Math.min(1, options.fill ?? 0.85));
  const wall = Math.max(0.022, Math.min(width, depth) * 0.06);
  const shelves = Math.max(3, Math.round(height / 0.44));

  // The carcass: two sides, a top, a bottom and a back.
  for (const side of [-1, 1]) {
    const panel = box(wall, height, depth, { bevel: wall * 0.14, bevelSegments: 1 });
    panel.translate(side * (width / 2 - wall / 2), height / 2, 0);
    builder.add(take(spent, panel), undefined, wood);
  }
  const back = box(width - wall * 1.4, height - wall, wall * 0.34, { bevel: 0, bevelSegments: 1 });
  back.translate(0, height / 2, -depth / 2 + wall * 0.3);
  builder.add(take(spent, back), undefined, wood);
  for (let index = 0; index <= shelves; index += 1) {
    const board = box(width - wall * 1.2, wall * 0.9, depth - wall * 0.3, { bevel: wall * 0.12, bevelSegments: 1 });
    board.translate(0, wall * 0.45 + (height - wall * 1.4) * (index / shelves), 0);
    builder.add(take(spent, board), undefined, wood);
  }
  if (bays > 1) {
    for (let bay = 1; bay < bays; bay += 1) {
      const divider = box(wall * 0.8, height - wall * 2, depth - wall * 0.4, { bevel: wall * 0.1, bevelSegments: 1 });
      divider.translate(-width / 2 + (width * bay) / bays, height / 2, 0);
      const data = affordable(spent, divider, budget);
      if (data) builder.add(data, undefined, wood);
    }
  }
  const cornice = box(width * 1.05, wall * 1.4, depth * 1.05, { bevel: wall * 0.26, bevelSegments: 1 });
  cornice.translate(0, height + wall * 0.2, 0);
  const corniceData = affordable(spent, cornice, budget);
  if (corniceData) builder.add(corniceData, undefined, wood);

  // The books. A spine is the cheapest honest unit in the library: one box.
  const bayWidth = (width - wall * 1.4) / bays;
  const spine = Math.max(0.018, bayWidth * 0.035);
  const perRow = Math.max(3, Math.floor((bayWidth * 0.9) / (spine * 1.35)));
  const wanted = perRow * shelves * bays;
  const affordableBooks = Math.max(0, Math.floor((budget - spent.spent) / (BEVELLED_BOX_TRIANGLES * 0.6)));
  const count = Math.round(Math.min(wanted * fill, Math.max(0, affordableBooks)));
  let placed = 0;
  for (let bay = 0; bay < bays && placed < count; bay += 1) {
    const bayX = -width / 2 + wall * 0.7 + bayWidth * (bay + 0.5);
    for (let row = 0; row < shelves && placed < count; row += 1) {
      const shelfY = wall * 0.9 + (height - wall * 1.4) * (row / shelves);
      let at = bayX - bayWidth * 0.44;
      const limit = bayX + bayWidth * 0.44;
      while (at < limit && placed < count) {
        // A row has a gap in it somewhere, and the last book before the gap leans.
        const gap = chance(rng, 0.1);
        const bookWidth = spine * range(rng, 0.7, 1.6);
        const bookHeight = Math.min(depth * 2.4, (height / shelves) * range(rng, 0.6, 0.88));
        if (gap) {
          at += bookWidth * range(rng, 1.5, 3);
          continue;
        }
        if (at + bookWidth > limit) break;
        const lean = chance(rng, 0.12) ? range(rng, 0.12, 0.3) : range(rng, -0.015, 0.015);
        const book = box(bookWidth, bookHeight, depth * range(rng, 0.6, 0.82), { bevel: bookWidth * 0.18, bevelSegments: 1 });
        book.rotateZ(lean);
        book.translate(at + bookWidth / 2, shelfY + bookHeight / 2 - lean * bookWidth * 0.5, depth * range(rng, -0.06, 0.06));
        const palette = ['leather', 'leather-dark', 'fabric-blue', 'velvet', 'paint', 'plaster-white'];
        const data = affordable(spent, book, budget);
        if (data) builder.add(data, undefined, palette[placed % palette.length]!);
        placed += 1;
        at += bookWidth * range(rng, 1.04, 1.2);
      }
    }
  }

  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ anvil */

export interface AnvilOptions {
  /** `stump` stands the anvil on a log section; `block` on masonry; `none` alone. */
  base?: 'stump' | 'block' | 'none';
  metal?: 'steel' | 'iron';
  /** Adds the hardy hole and the pritchel, the two holes an anvil is judged by. */
  holes?: boolean;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * An anvil: a horn to bend on, a face to strike on, a waist to hold it by.
 *
 * The profile is extruded rather than assembled from boxes, because an anvil's
 * silhouette is one continuous curve — horn, step, waist, heel — and boxes built
 * to it show their joints exactly where the eye looks. What sits under it is a
 * stump of elm or a block of masonry, and that is part of the height: an anvil
 * is struck at about 0.72 m, which is the stump and the body together.
 */
export function anvil(options: AnvilOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 769);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const base = options.base ?? 'stump';
  const surface = options.metal === 'iron' ? 'iron-wrought' : 'steel';
  const bodyHeight = 0.26;
  const length = 0.7;
  const width = 0.3;
  const baseHeight = base === 'none' ? 0 : base === 'stump' ? 0.46 : 0.4;
  const bevel = budget > 900 ? 0.012 : 0;

  if (base === 'stump') {
    // A log section, bark on the outside and heartwood showing on top.
    const stump = cylinder(width * 0.8, width * 0.86, baseHeight, {
      radialSegments: budget > 1200 ? 12 : 8,
      wobble: 0.025,
      wobbleSeed: 3,
    });
    stump.translate(0, baseHeight / 2, 0);
    builder.add(take(spent, stump), undefined, 'bark');
    const heart = cylinder(width * 0.72, width * 0.72, baseHeight * 0.03, { radialSegments: budget > 1200 ? 12 : 8 });
    heart.translate(0, baseHeight - baseHeight * 0.015, 0);
    const heartData = affordable(spent, heart, budget);
    if (heartData) builder.add(heartData, undefined, 'wood-cut');
  } else if (base === 'block') {
    const block = box(width * 1.5, baseHeight, width * 1.5, { bevel: 0.014, bevelSegments: 1 });
    block.translate(0, baseHeight / 2, 0);
    builder.add(take(spent, block), undefined, 'stone-rough');
  }

  // The body, in one extrusion of its own side profile.
  const profile: Vec2[] = [
    [-length * 0.5, bodyHeight * 0.62],
    [-length * 0.34, bodyHeight * 0.74],
    [-length * 0.2, bodyHeight * 0.94],
    [-length * 0.06, bodyHeight],
    [length * 0.26, bodyHeight],
    [length * 0.42, bodyHeight * 0.96],
    [length * 0.5, bodyHeight * 0.86],
    [length * 0.44, bodyHeight * 0.5],
    [length * 0.24, bodyHeight * 0.34],
    [length * 0.2, bodyHeight * 0.1],
    [length * 0.3, 0],
    [-length * 0.16, 0],
    [-length * 0.1, bodyHeight * 0.16],
    [-length * 0.3, bodyHeight * 0.4],
  ];
  const body = extrude(profile, { depth: width, bevel, bevelSegments: 1, caps: true });
  body.translate(0, baseHeight, -width / 2);
  builder.add(take(spent, body), undefined, surface);

  // The face is a separate plate, because the face is the part that is hardened.
  const face = box(length * 0.62, bodyHeight * 0.06, width * 0.96, { bevel: 0, bevelSegments: 1 });
  face.translate(length * 0.02, baseHeight + bodyHeight * 0.99, 0);
  const faceData = affordable(spent, face, budget);
  if (faceData) builder.add(faceData, undefined, 'steel-blade');

  if (options.holes !== false && budget > 700) {
    // The hardy hole is square and the pritchel round, and both go all the way
    // through, so they are built as a ring of metal around a gap rather than as
    // a dark disc on top of the face.
    const hardy = box(width * 0.16, bodyHeight * 0.1, width * 0.16, { bevel: 0, bevelSegments: 1 });
    hardy.translate(length * 0.3, baseHeight + bodyHeight * 1.005, 0);
    const hardyData = affordable(spent, hardy, budget);
    if (hardyData) builder.add(hardyData, undefined, 'soil');
    const pritchel = cylinder(width * 0.05, width * 0.05, bodyHeight * 0.1, { radialSegments: 6 });
    pritchel.translate(length * 0.16, baseHeight + bodyHeight * 1.005, 0);
    const pritchelData = affordable(spent, pritchel, budget);
    if (pritchelData) builder.add(pritchelData, undefined, 'soil');
  }

  if (budget > 1400 && chance(rng, 0.5)) {
    // A hammer left on the face: the anvil in use rather than on show.
    const haft = cylinder(0.016, 0.02, 0.34, { radialSegments: 5 });
    haft.rotateZ(Math.PI / 2 - 0.1);
    haft.translate(-length * 0.06, baseHeight + bodyHeight + 0.06, width * 0.1);
    const haftData = affordable(spent, haft, budget);
    if (haftData) builder.add(haftData, undefined, 'wood-dark');
    const head = box(0.11, 0.05, 0.05, { bevel: 0.008, bevelSegments: 1 });
    head.translate(-length * 0.06 + 0.16, baseHeight + bodyHeight + 0.09, width * 0.1);
    const headData = affordable(spent, head, budget);
    if (headData) builder.add(headData, undefined, 'iron-wrought');
  }

  seatOnGround(builder);
  return builder;
}

/* ------------------------------------------------------------------ forge */

export interface ForgeOptions {
  /** `hearth` is masonry with a hood; `bellows` adds the blast; `field` is a portable fire. */
  style?: 'hearth' | 'bellows' | 'field';
  lit?: boolean;
  /** Adds a quench barrel, a fuel heap and tools on the wall. */
  fitted?: boolean;
  seed?: number;
  budget?: number;
  quality?: Quality;
}

/**
 * A forge: a fire that is held in something, with air driven into it.
 *
 * The hearth is the asset and the hood is the reason it can be indoors; the
 * bellows is the reason it is a forge rather than a fire. Everything else —
 * the quench barrel, the fuel heap, the tools — is what a smith leaves within
 * one step of the fire, and it is all budgeted: a poor forge keeps its hearth,
 * its hood and its blast, and loses the barrel and the tools.
 */
export function forge(options: ForgeOptions = {}): MeshBuilder {
  const rng = detailRng(options.seed ?? 773);
  const budget = componentBudget(options.quality, options.budget);
  const spent: Spend = { spent: 0 };
  const builder = new MeshBuilder();
  const style = options.style ?? 'hearth';
  const lit = options.lit ?? true;
  const fitted = options.fitted ?? true;
  const width = style === 'field' ? 0.9 : 1.6;
  const depth = style === 'field' ? 0.9 : 1;
  const hearthHeight = style === 'field' ? 0.28 : 0.72;
  const masonry = style === 'field' ? 'stone-rough' : 'brick';

  if (style === 'field') {
    // A field forge is a ring of stones with a fire in it and a tuyere at the side.
    const stones = budget > 900 ? 9 : 6;
    for (let index = 0; index < stones; index += 1) {
      const angle = (index / stones) * Math.PI * 2;
      const stone = box(width * 0.16, hearthHeight * range(rng, 0.7, 1.1), depth * 0.16, { bevel: 0.014, bevelSegments: 1 });
      stone.rotateY(angle);
      stone.translate(Math.cos(angle) * width * 0.4, hearthHeight * 0.4, Math.sin(angle) * depth * 0.4);
      builder.add(take(spent, stone), undefined, masonry);
    }
  } else {
    // The hearth: a masonry box with a fire bed sunk into its top.
    const body = box(width, hearthHeight, depth, { bevel: 0.016, bevelSegments: 1 });
    body.translate(0, hearthHeight / 2, 0);
    builder.add(take(spent, body), undefined, masonry);
    const bed = box(width * 0.62, hearthHeight * 0.1, depth * 0.58, { bevel: 0.01, bevelSegments: 1 });
    bed.translate(0, hearthHeight * 0.98, depth * 0.04);
    builder.add(take(spent, bed), undefined, 'soil');
    // The working face is lower than the bed, so the smith stands at the fire.
    const lip = box(width * 1.06, hearthHeight * 0.12, depth * 0.2, { bevel: 0.012, bevelSegments: 1 });
    lip.translate(0, hearthHeight * 0.94, depth * 0.46);
    const lipData = affordable(spent, lip, budget);
    if (lipData) builder.add(lipData, undefined, 'stone-dressed');
  }

  // The hood and the flue, which is what makes an indoor fire lawful. They are
  // charged rather than planned: a forge with no hood is a bonfire, and a forge
  // that loses its chimney at a poor budget is a different asset at a different
  // height, which is the one thing a placement reads.
  if (style !== 'field') {
    const hood = prism({
      sides: 4,
      radius: width * 0.62,
      height: 0.5,
      topScale: 0.42,
      caps: true,
    });
    hood.rotateY(Math.PI / 4);
    hood.scale(1, 1, depth / width);
    hood.computeNormals();
    hood.translate(0, hearthHeight + 0.25, 0);
    builder.add(take(spent, hood), undefined, 'iron-rusted');
    const flue = cylinder(width * 0.17, width * 0.19, 0.62, { radialSegments: budget > 1400 ? 10 : 6 });
    flue.translate(0, hearthHeight + 0.5 + 0.31, 0);
    builder.add(take(spent, flue), undefined, 'iron-rusted');
  }

  // The fire and its fuel: coals are what a forge burns, not logs.
  if (lit) {
    const fire = flame({ height: style === 'field' ? 0.4 : 0.3, radius: width * 0.16, layers: budget > 1400 ? 3 : 2 });
    fire.translate(0, hearthHeight * (style === 'field' ? 0.5 : 1), depth * 0.04);
    builder.add(take(spent, fire), undefined, 'glass-warm');
  }
  const coals = Math.max(3, budget > 1200 ? 8 : 4);
  for (let index = 0; index < coals; index += 1) {
    const coal = box(width * 0.07, width * 0.05, width * 0.07, { bevel: budget > 900 ? width * 0.014 : 0, bevelSegments: 1 });
    coal.rotateY(range(rng, 0, Math.PI));
    coal.translate(
      range(rng, -width * 0.24, width * 0.24),
      hearthHeight * (style === 'field' ? 0.42 : 1.02),
      depth * 0.04 + range(rng, -depth * 0.16, depth * 0.16),
    );
    const data = affordable(spent, coal, budget);
    if (data) builder.add(data, undefined, 'soil');
  }

  if (style === 'bellows' || (style === 'hearth' && fitted && budget > 1400)) {
    // Bellows: two boards hinged at the back and a leather gusset between them,
    // with a nozzle into the fire. It is built open, which is how it is worked.
    const open = range(rng, 0.16, 0.3);
    for (const side of [-1, 1]) {
      const board = box(width * 0.5, 0.03, depth * 0.62, { bevel: 0.008, bevelSegments: 1 });
      board.rotateX(side * open);
      board.translate(-width * 0.42, hearthHeight * 0.72 + side * Math.sin(open) * depth * 0.3, -depth * 0.02);
      const data = affordable(spent, board, budget);
      if (data) builder.add(data, undefined, 'wood-pine');
    }
    const gusset = cloth(width * 0.44, depth * 0.56, 3, 3, (u, v) => Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * open * depth * 0.9);
    gusset.rotateX(Math.PI / 2);
    gusset.rotateZ(Math.PI / 2);
    gusset.translate(-width * 0.42, hearthHeight * 0.72, -depth * 0.02);
    const gussetData = affordable(spent, gusset, budget);
    if (gussetData) builder.add(gussetData, undefined, 'leather-dark');
    const nozzle = cylinder(0.026, 0.034, width * 0.3, { radialSegments: 6 });
    nozzle.rotateZ(Math.PI / 2);
    nozzle.translate(-width * 0.14, hearthHeight * 0.86, depth * 0.04);
    const nozzleData = affordable(spent, nozzle, budget);
    if (nozzleData) builder.add(nozzleData, undefined, 'iron-wrought');
  }

  if (fitted && style !== 'field') {
    // A quench tub beside the fire. It is charged rather than planned, because it
    // is what sets the forge's footprint: a forge that loses its tub at a poor
    // budget is a smaller asset, and a smaller asset is placed in the wrong hole.
    // What the budget decides is whether the tub is staved or a plain open barrel.
    const tubRadius = 0.26;
    const tubX = width * 0.5 + tubRadius * 0.92;
    const tub = budget > 1400
      ? cask({ height: 0.56, radius: tubRadius, seed: (options.seed ?? 773) + 41, staves: 10, hoops: 2 })
      : (() => {
        const open = cylinder(tubRadius, tubRadius * 0.92, 0.52, {
          radialSegments: budget > 700 ? 10 : 7,
          caps: { top: false, bottom: true },
        });
        open.translate(0, 0.26, 0);
        return open;
      })();
    tub.translate(tubX, 0, depth * 0.16);
    builder.add(take(spent, tub), undefined, 'wood-weathered');
    const water = cylinder(tubRadius * 0.9, tubRadius * 0.9, 0.01, { radialSegments: 8 });
    water.translate(tubX, 0.46, depth * 0.16);
    const waterData = affordable(spent, water, budget);
    if (waterData) builder.add(waterData, undefined, 'glass');
    if (budget > 1600) {
      // Tools hung on a rack: tongs and a poker, silhouettes rather than models.
      const rack = cylinder(0.02, 0.02, width * 0.7, { radialSegments: 4 });
      rack.rotateZ(Math.PI / 2);
      rack.translate(-width * 0.3, hearthHeight + 0.72, -depth * 0.42);
      const rackData = affordable(spent, rack, budget);
      // The rack is sold in the bellows' own pine: a forge has ten surfaces and
      // not one more, and an eleventh would be a rack of walnut in a smithy.
      if (rackData) builder.add(rackData, undefined, 'wood-pine');
      for (let index = 0; index < 3; index += 1) {
        const tool = cylinder(0.012, 0.016, 0.6, { radialSegments: 4 });
        tool.translate(-width * 0.5 + index * width * 0.2, hearthHeight + 0.42, -depth * 0.42);
        const data = affordable(spent, tool, budget);
        if (data) builder.add(data, undefined, 'iron-wrought');
      }
    }
  }

  seatOnGround(builder);
  return builder;
}
