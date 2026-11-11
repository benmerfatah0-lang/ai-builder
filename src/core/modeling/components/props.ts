import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { arch, box, cylinder, extrude, lathe, plane, prism, sphere, torus } from '../primitives';
import {
  BEVELLED_BOX_TRIANGLES, BOX_TRIANGLES, FLAME_TRIANGLES, LEAF_TRIANGLES, POST_TRIANGLES_PER_SIDE,
  STUD_TRIANGLES, barrel, componentBudget, cylinderCost, detailRng, dressedBlock, flame, fracture,
  latheCost, leafCluster, planks, planChildren, post, roofPanel, rope, scatter, settle, sphereCost,
  spike, stoneWall, torusCost, wattleFence, type Quality, type RoofStyle,
} from '../detail';
import { centerHorizontally, fitHeight, seatOnGround } from '../scale';
import { chance, pick, range } from '../../generation/rng';

/**
 * Props: the things people leave behind, from a well head to a scarecrow.
 *
 * A terrain and a set of buildings is a maquette. What makes a place read as
 * lived in is the middle scale — the objects a body works with — and every one
 * of them is a record of use. That gives this file its four rules.
 *
 * 1. **Model the use, not the shape.** A well is a hole that was lined, so the
 *    lining runs up the outside, over the rim and back down the inside, and a
 *    caller looking into it sees the far wall of its own shaft. A campfire is a
 *    ring that was cleared and stoned, so the stones stand in a circle with a
 *    bed of ash between them. A scarecrow is a coat on a cross, so it is built
 *    as a coat on a cross rather than as a small person.
 * 2. **Nothing is plumb and nothing is new.** Posts lean a degree, copings
 *    stagger by a millimetre, awnings sag between their stripes, a gate sags on
 *    its hinge side. A prop whose parts all agree exactly reads as a rendering,
 *    and the disagreement is nearly free: one `range()` per part.
 * 3. **The budget buys the silhouette last.** A poor tent keeps its guy lines
 *    and loses the folds in its canvas; a poor fence keeps its full run and
 *    gives each picket four sides instead of six; a poor stall keeps every one
 *    of its posts and drops the goods from the counter. What goes first is the
 *    surface, then the small parts, then the count — never the extent, because
 *    a prop that shrank is a prop in the wrong place.
 * 4. **Cloth is one plane thick.** Awnings, tent walls and flags are single
 *    displaced sheets, which is why the cloth surfaces are double-sided in
 *    `materials.ts`. Building them as thin solids instead would cost an order
 *    of magnitude more and read no better at the distance a world is seen from.
 *
 * Coordinates: metres, Y up, the base on y = 0, centred on X and Z — except
 * where a docstring says otherwise, as for a gate that has been swung open.
 */

/* --------------------------------------------------------------- plumbing */

/** Triangles a `post` costs: a band per side of its cross-section, doubled by the caps. */
function postCost(sides: number): number {
  return Math.max(4, Math.round(sides)) * POST_TRIANGLES_PER_SIDE;
}

/** Triangles a `prism` costs: a band per side, halved when the top collapses to a point. */
function prismCost(sides: number, pointed = false): number {
  return Math.max(3, Math.round(sides)) * (pointed ? 2 : 4);
}

/** Triangles one sheet of cloth costs: a quad per cell of its grid. */
function clothCost(across: number, along: number): number {
  return Math.max(1, Math.round(across)) * Math.max(1, Math.round(along)) * 2;
}

/** Triangles a `wattleFence` panel costs per metre of run, charged high. */
const WATTLE_PER_METRE = 170;

/**
 * Triangles a `barrel` costs: a stave is a boarded wedge and a hoop a ring.
 *
 * Measured, not guessed — eight staves and two hoops build 464 triangles, twelve
 * staves and three hoops build 756, which is 66 per stave and 28 per hoop with
 * 120 left over. The leftover is charged rather than credited, so a stall that
 * can afford three barrels builds three.
 */
function barrelCost(staves: number, hoops: number): number {
  return Math.max(4, Math.round(staves)) * 66 + Math.max(1, Math.round(hoops)) * 28;
}

/**
 * Triangles a `rope` costs: a swept section of `strands * 6` points per station.
 *
 * A rope is the most expensive line in the library and the only one worth it
 * where a player stands close enough to see the lay of the strands. Charged from
 * the station count `rope` resamples to, plus the two caps, plus a margin.
 */
function ropeCost(pathPoints: number, segments: number, strands = 3): number {
  const spans = Math.max(1, Math.round(pathPoints) - 1);
  const steps = Math.max(1, Math.round(segments / spans));
  const stations = spans * steps + 1;
  const section = Math.max(2, Math.round(strands)) * 6;
  return (stations - 1) * section * 2 + 2 * (section - 2) + 8;
}

/** The roofing surface a roof style is laid in. */
const ROOF_SURFACE: Record<RoofStyle, string> = {
  pan: 'roof-tile',
  shingle: 'shingle',
  slate: 'roof-slate',
  thatch: 'thatch',
};

/**
 * A straight member between two points: a pole, a brace, a stay, a guy rope.
 *
 * Everything a prop leans on is one of these, and building them as tapered
 * cylinders rather than as `rope` is the difference between a tent that costs
 * two hundred triangles and one that costs two thousand.
 */
function strut(from: Vec3, to: Vec3, radius: number, sides = 5, caps = false): MeshBuilder {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const length = Math.hypot(dx, dy, dz);
  const part = cylinder(radius * 0.82, radius, Math.max(1e-4, length), { radialSegments: sides, caps });
  if (length > 1e-6) {
    if (Math.abs(dy) > length - 1e-9) {
      // Straight down: turn it end over end, or the taper runs the wrong way.
      if (dy < 0) part.rotateZ(Math.PI);
    } else {
      // Tilt off the vertical first, then turn into the azimuth. The other order
      // swings the member about the world Y and lands it somewhere that is not
      // `to`, which is how a tent pole ends up inside its own canvas.
      const tilt = Math.acos(Math.max(-1, Math.min(1, dy / length)));
      part.rotateZ(tilt);
      part.rotateY(Math.atan2(dz, -dx));
    }
  }
  part.translate(from[0] + dx / 2, from[1] + dy / 2, from[2] + dz / 2);
  return part;
}

/**
 * A course of dressed blocks laid around a circle: a well rim, a fountain
 * coping, the kerb of a basin.
 *
 * Blocks are laid to the ring rather than the ring turned as one torus because
 * the joints are the read: a coping that is one smooth band is a pipe, and a
 * coping of nine blocks staggered by a millimetre is masonry.
 */
function stoneRing(
  radius: number,
  blocks: number,
  width: number,
  height: number,
  depth: number,
  seed: number,
): MeshBuilder {
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const count = Math.max(4, Math.round(blocks));
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2 + range(rng, -0.03, 0.03);
    const block = dressedBlock({
      width,
      height: height * range(rng, 0.92, 1.08),
      depth,
      chamfer: Math.min(0.025, width * 0.09),
      seed: seed + index * 7,
    });
    block.rotateY(angle);
    block.translate(Math.sin(angle) * radius, range(rng, -0.008, 0.008), Math.cos(angle) * radius);
    builder.add(block);
  }
  return builder;
}

/**
 * A sheet of standing water: one disc of `glass`, wound rim to centre so it
 * faces up.
 *
 * A disc rather than a plane because a basin is round, and a square sheet in a
 * round basin shows its corners above the water line. A well gets a dark disc of
 * soil instead of this: four metres down, water reads black, and the black is
 * what makes a shaft look deep.
 */
function waterSheet(radius: number, segments: number, at: number): MeshBuilder {
  const sheet = lathe([[Math.max(0.02, radius), 0], [0, 0]], { segments: Math.max(6, Math.round(segments)) });
  sheet.translate(0, at, 0);
  return sheet;
}

/**
 * A sheet of cloth: one displaced plane, because cloth is one plane thick.
 *
 * `sag` is sampled in unit coordinates — 0 at the near edge, 1 at the far — and
 * returns a height in metres, so a caller writes the shape of the drape rather
 * than the coordinates of it. The sheet is built in XZ facing up, which is what
 * an awning or a tent roof wants; a wall of cloth rotates it afterwards.
 */
function cloth(
  width: number,
  run: number,
  across: number,
  along: number,
  sag: (u: number, v: number) => number,
): MeshBuilder {
  return plane(Math.max(0.05, width), Math.max(0.05, run), {
    widthSegments: Math.max(1, Math.round(across)),
    heightSegments: Math.max(1, Math.round(along)),
    height: (x, z) => sag((x + width / 2) / Math.max(1e-6, width), (z + run / 2) / Math.max(1e-6, run)),
  });
}

/**
 * A small gabled roof, with its ridge along X: two slopes, a ridge board and a
 * fascia at each eave.
 *
 * `roofPanel` decides how many tiles stay solid and how many the texture
 * carries, but it has a floor — the eave, rake and ridge courses are the least it
 * will build, and on a canopy two metres wide that floor is more than a poor
 * component can give it. Below six hundred triangles a side, the roof is laid as
 * sheets instead and the surface carries the courses, which past two metres is
 * the same read for a fifth of the cost.
 *
 * The sheets come in pairs. Roofing is not a double-sided material — a house roof
 * has a bed under it and never needs to be — and the underside of a well canopy
 * is seen from the mouth, so each slope gets a soffit sheet flipped under it.
 */
function gabledCanopy(options: {
  span: number;
  run: number;
  pitch?: number;
  style?: RoofStyle;
  budget: number;
  seed: number;
}): MeshBuilder {
  const builder = new MeshBuilder();
  const span = Math.max(0.4, options.span);
  const run = Math.max(0.4, options.run);
  const pitch = Math.max(0.2, Math.min(1.2, options.pitch ?? 0.72));
  const style = options.style ?? 'shingle';
  const overhang = Math.min(0.26, span * 0.16);
  const half = run / 2;
  const rise = half * Math.tan(pitch);
  const slope = half / Math.cos(pitch) + overhang;
  const wide = span + overhang * 2;
  const surface = ROOF_SURFACE[style];
  const across = Math.max(2, Math.min(6, Math.round(wide / 0.5)));
  const along = Math.max(2, Math.min(5, Math.round(slope / 0.4)));
  const solid = options.budget >= 600;

  for (const side of [-1, 1] as const) {
    if (solid) {
      // The sequence `gableRoof` uses: `roofPanel` lies flat with its ridge at
      // z = 0, `rotateX(pitch)` drops the eave, `rotateY(±π/2)` turns the ridge
      // to run along Z. The extra quarter turn puts it along X instead, which is
      // how a canopy spans the two posts of a well head, and it leaves the rise
      // alone because a translation along Y commutes with a turn about it.
      const panel = roofPanel({
        width: wide,
        slopeLength: half / Math.cos(pitch),
        overhang,
        style,
        seed: options.seed + (side > 0 ? 0 : 7),
        budget: options.budget / 2,
      });
      panel.rotateX(pitch);
      panel.rotateY(side * Math.PI / 2);
      panel.translate(0, rise + overhang * Math.sin(pitch), 0);
      panel.rotateY(Math.PI / 2);
      builder.add(panel, undefined, surface);
      continue;
    }
    // A sheet sags between its rafters and dips a little toward the middle of its
    // span. The sag is symmetric, so one shape serves both slopes.
    const drape = (u: number, v: number): number => {
      const u01 = Math.abs(u - 0.5) * 2;
      return -(0.016 * (1 - u01 * u01) + 0.008) * Math.sin(v * Math.PI);
    };
    for (const soffit of [false, true] as const) {
      // The soffit is handed the negated drape, because the mirror that turns its
      // normal over negates the displacement too: without this the underside of
      // the roof bulges up into the sheet above it and the two cross.
      const sheet = cloth(wide, slope, across, along, soffit ? (u, v) => -drape(u, v) : drape);
      // Flipped before it is tilted, while it still lies in y = 0, so the mirror
      // turns the normal over without moving anything.
      if (soffit) sheet.mirror('y');
      sheet.rotateX(side * pitch);
      sheet.translate(0, rise - (slope / 2) * Math.sin(pitch) - (soffit ? 0.026 : 0), side * (slope / 2) * Math.cos(pitch));
      builder.add(sheet, undefined, surface);
    }
  }

  const ridge = box(wide, 0.07, 0.11, { bevel: 0.012, bevelSegments: 1 });
  ridge.translate(0, rise + 0.05, 0);
  builder.add(ridge, undefined, 'wood-dark');
  if (!solid) {
    const eaveY = rise - slope * Math.sin(pitch);
    for (const side of [-1, 1] as const) {
      const fascia = box(wide, 0.06, 0.035);
      fascia.translate(0, eaveY + 0.02, side * slope * Math.cos(pitch));
      builder.add(fascia, undefined, 'wood-dark');
    }
  }
  return builder;
}

/**
 * Triangles a `gabledCanopy` costs.
 *
 * Charged from the same threshold the builder uses: a rich canopy is handed its
 * allowance and `roofPanel` lays itself into it, while a poor one is four sheets,
 * a ridge board and two fascias, all of which are exact.
 */
function canopyCost(budget: number, span: number, run: number, pitch: number): number {
  const overhang = Math.min(0.26, span * 0.16);
  const slope = run / 2 / Math.cos(pitch) + overhang;
  if (budget >= 600) return budget + BEVELLED_BOX_TRIANGLES;
  const across = Math.max(2, Math.min(6, Math.round((span + overhang * 2) / 0.5)));
  const along = Math.max(2, Math.min(5, Math.round(slope / 0.4)));
  return 4 * clothCost(across, along) + BEVELLED_BOX_TRIANGLES + 2 * BOX_TRIANGLES;
}

/**
 * A thrown pot: cheaper than `vessel` and honest at arm's length.
 *
 * `vessel` builds a hero piece — handles, a foot ring, a flared lip — and costs
 * four hundred and eighty triangles before it is asked for anything. A market
 * stall needs six pots, not one, so the everyday pot is a six-station profile
 * with the wobble of a hand-thrown wall left in it.
 */
function pot(height: number, radius: number, segments: number, seed: number): MeshBuilder {
  const rng = detailRng(seed);
  const profile: Vec2[] = [];
  const stations = 6;
  for (let index = 0; index < stations; index += 1) {
    const t = index / (stations - 1);
    // A thrown pot swells below the shoulder and narrows to a lip that flares.
    const belly = Math.sin(Math.pow(t, 0.82) * Math.PI * 0.92);
    const r = radius * (0.44 + 0.7 * belly + (t > 0.84 ? (t - 0.84) * 1.2 : 0));
    profile.push([Math.max(radius * 0.12, r * range(rng, 0.985, 1.015)), height * t]);
  }
  const part = lathe(profile, { segments: Math.max(6, Math.round(segments)), caps: true });
  part.flatShade();
  return part;
}

/** Triangles a bucket costs: a hollow staved wall and a wire bail. */
const BUCKET_TRIANGLES = latheCost(6, 8, 1) + torusCost(4, 8);

/**
 * A staved bucket with a bail — the reason a well has a windlass.
 *
 * The wall runs up the outside, over the rim and back down the inside to a
 * floor, so looking into the bucket sees a bucket. A single turned wall would be
 * invisible from above, which is exactly the angle a bucket is seen from.
 */
function bucket(radius: number, seed: number): MeshBuilder {
  const rng = detailRng(seed);
  const r = Math.max(0.05, radius);
  const height = r * 1.45;
  const builder = new MeshBuilder();
  const wall = lathe(
    [
      [r * 0.8, 0],
      [r * 0.94, height * 0.55],
      [r, height * 0.96],
      [r * 1.02, height],
      [r * 0.9, height * 0.94],
      [r * 0.74, height * 0.1],
      [0, height * 0.08],
    ],
    { segments: 8, caps: true },
  );
  wall.flatShade();
  builder.add(wall, undefined, 'wood-oak');
  const bail = torus(r * 0.94, r * 0.06, { radialSegments: 4, tubularSegments: 8, arc: Math.PI });
  bail.rotateZ(Math.PI);
  // Hooked on by hand and never quite square to the staves.
  bail.rotateY(range(rng, -0.18, 0.18));
  bail.translate(0, height, 0);
  builder.add(bail, undefined, 'iron-wrought');
  return builder;
}

/**
 * Seats a part on a surface at `y`, wherever its own bottom happens to be.
 *
 * Goods on a counter, stones in a ring and sacks on the ground are all built
 * centred on their own origin, and a sphere squashed by its own weight has a
 * bottom that no caller can predict. Lifting by the measured bottom is what
 * keeps a component's bounding box honest: one sack sunk two centimetres into a
 * counter is a prop that has fallen through the world.
 */
function placeOn(part: MeshBuilder, x: number, y: number, z: number): void {
  part.translate(x, y - part.bounds().min[1], z);
}

/**
 * How much a tilted post has to be lifted so its whole foot stays on the ground.
 *
 * A post leans, and leaning about its foot puts half of its foot below y = 0 —
 * which is under the terrain it stands on, and reads as a post that has been
 * driven into the ground by a machine. Lifting it by the radius of its own lean
 * keeps the foot on the surface and the lean in the silhouette.
 */
function leanLift(radius: number, tilt: number): number {
  return Math.abs(radius * Math.sin(tilt));
}

/* ------------------------------------------------------------------- well */

export type WellStyle = 'frame' | 'sweep' | 'open';
export type WellLining = 'stone' | 'brick' | 'timber';

export interface WellOptions {
  /** Inside radius of the shaft, in metres. */
  radius?: number;
  /** Height of the lining above ground: what a caller specifies a well by. */
  drum?: number;
  /** `frame` is a timber head with a roof, `sweep` a shadoof, `open` a rim and nothing else. */
  style?: WellStyle;
  lining?: WellLining;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** A bucket hanging on the rope. */
  bucket?: boolean;
  /** Trodden ground around the mouth: worn cobbles and a few kicked-out stones. */
  apron?: boolean;
}

/**
 * A well: a lined shaft and the head that lifts from it.
 *
 * The shaft is the asset and it is paid for first, because a well is a hole in
 * the ground that somebody lined and the read is the hole, not the roof over it.
 * The lining is turned as one wall that runs up the outside, over the rim and
 * back down the inside, so a camera at the mouth sees the far wall of its own
 * shaft and a dark floor below instead of seeing through the model to whatever
 * stands behind it.
 *
 * The head is one of three, and all three are the same machine: a frame with a
 * windlass and a roof over it, a sweep balanced on a pivot with a counterweight
 * at the far end, or nothing but a rim. The sweep is the older one and the one
 * that belongs to a dry country, where the water is deep and the lift is long.
 *
 * A `sweep` well is not centred on its bounding box and does not try to be: the
 * pole reaches twice as far toward the bucket as toward the counterweight,
 * because that is how the machine is balanced. The *shaft* is centred on the
 * origin in every style, which is what a caller places.
 */
export function well(options: WellOptions): MeshBuilder {
  const seed = options.seed ?? 71;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.28, options.radius ?? 0.7);
  const drum = Math.max(0.25, options.drum ?? 0.72);
  const style = options.style ?? 'frame';
  const lining = options.lining ?? 'stone';
  const budget = componentBudget(options.quality, options.budget);
  const surface = lining === 'brick' ? 'brick' : lining === 'timber' ? 'plank' : 'stone-rough';
  const wall = lining === 'timber' ? 0.13 : 0.2 + radius * 0.07;
  const outer = radius + wall;
  const coping = 0.06 + radius * 0.05;

  // Facets are what the shaft is bought with: eight reads as a ring of blocks,
  // twenty reads as a turned drum.
  const segments = Math.max(8, Math.min(20, Math.round(budget / 130)));
  const profile: Vec2[] = [
    [outer, 0],
    [outer * 1.014, drum * 0.5],
    [outer + coping * 0.3, drum],
    [outer + coping, drum + 0.09],
    [outer + coping * 0.7, drum + 0.13],
    [radius + 0.03, drum + 0.11],
    [radius, drum * 0.82],
    [radius * 0.985, 0.24],
  ];
  const shaft = lathe(profile, { segments, caps: false });
  if (lining !== 'timber') {
    // Roughen the turn: a lining is coursed stone, and the courses read as
    // blocks sitting a few millimetres proud of one another.
    fracture(shaft, {
      amplitude: wall * 0.1,
      frequency: 3.2 / Math.max(0.4, radius),
      octaves: 2,
      seed,
      preserveBase: true,
    });
  }
  builder.add(shaft, undefined, surface);
  let spent = latheCost(profile.length, segments);

  // Dark, and low: what a well shows from above is its own shadow.
  builder.add(waterSheet(radius * 0.97, segments, 0.24), undefined, 'soil');
  spent += latheCost(2, segments);

  if (options.apron !== false && budget - spent > 300) {
    // Trodden ground. The mud around a well is worn into a shallow dish and
    // puddles at the mouth, and the stones kicked out of it lie where they
    // landed: a well standing on untouched grass is a well nobody draws from.
    const apronShare = Math.min((budget - spent) * 0.32, 620);
    const apronRadius = outer + 0.3 + radius * 0.42;
    const pad = lathe([[apronRadius, 0.004], [outer + 0.1, 0.03], [outer * 0.86, 0.045]], {
      segments: Math.max(8, segments - 2),
    });
    builder.add(pad, undefined, 'cobble');
    spent += latheCost(3, Math.max(8, segments - 2));
    const stones = planChildren(5, prismCost(6), Math.max(prismCost(6), apronShare - latheCost(3, segments)));
    for (let index = 0; index < stones.modeled; index += 1) {
      const angle = (index / stones.modeled) * Math.PI * 2 + range(rng, -0.3, 0.3);
      const at = apronRadius * range(rng, 0.72, 1.02);
      const stone = prism({
        sides: 6,
        radius: radius * range(rng, 0.09, 0.19),
        height: radius * range(rng, 0.08, 0.16),
        topScale: range(rng, 0.5, 0.86),
      });
      fracture(stone, { amplitude: radius * 0.03, frequency: 9, octaves: 2, seed: seed + index * 13 });
      settle(stone, rng, [Math.sin(angle) * at, 0.01, Math.cos(angle) * at], radius * 0.05);
      builder.add(stone, undefined, 'cobble');
    }
    spent += stones.modeled * prismCost(6);
  }

  if (style === 'open') {
    // Nothing but a rim, and a plank or two laid across it as a lid.
    if (budget - spent > 90 && chance(rng, 0.6)) {
      const lid = box(outer * 2.06, 0.05, outer * 1.5, { bevel: 0.008, bevelSegments: 1 });
      lid.rotateY(range(rng, -0.12, 0.12));
      lid.translate(range(rng, -0.06, 0.06), drum + 0.16, range(rng, -0.05, 0.05));
      builder.add(lid, undefined, 'wood-dark');
    }
    seatOnGround(builder, false);
    return builder;
  }

  const postRadius = 0.055 + radius * 0.03;

  if (style === 'sweep') {
    // A shadoof: a long pole balanced on a pivot, a bucket at the near end and a
    // counterweight at the far one. The pole tips, so it is built tipped — a
    // shadoof drawn level is a diagram of a shadoof.
    const pivotHeight = drum + radius * 1.5;
    const tilt = range(rng, 0.24, 0.4);
    const poleLength = radius * 5.2 + 1.4;
    const nearEnd: Vec3 = [poleLength * 0.66 * Math.cos(tilt), pivotHeight - poleLength * 0.66 * Math.sin(tilt), 0];
    const farEnd: Vec3 = [-poleLength * 0.34 * Math.cos(tilt), pivotHeight + poleLength * 0.34 * Math.sin(tilt), 0];
    for (const side of [-1, 1] as const) {
      const leg = post({ height: pivotHeight, radius: postRadius * 1.05, sides: 5, cap: 'flat', seed: seed + side });
      const legTilt = side * range(rng, 0.01, 0.03);
      leg.rotateZ(legTilt);
      leg.translate(side * (outer + postRadius), leanLift(postRadius * 1.05, legTilt), 0);
      builder.add(leg, undefined, 'wood-weathered');
    }
    spent += 2 * postCost(5);
    builder.add(strut(farEnd, nearEnd, postRadius * 0.72, 6), undefined, 'log');
    spent += cylinderCost(6, false);
    const pivot = cylinder(postRadius * 0.42, postRadius * 0.42, outer * 2.3, { radialSegments: 6 });
    pivot.rotateZ(Math.PI / 2);
    pivot.translate(0, pivotHeight, 0);
    builder.add(pivot, undefined, 'wood-dark');
    spent += cylinderCost(6);

    // The counterweight: a lump of stone lashed to the far end, because the whole
    // point of the machine is that the lift is paid for twice.
    const weight = prism({ sides: 7, radius: radius * 0.42, height: radius * 0.5, topScale: 0.6 });
    fracture(weight, { amplitude: radius * 0.06, frequency: 5, octaves: 2, seed: seed + 41 });
    weight.translate(farEnd[0], farEnd[1] + radius * 0.22, 0);
    builder.add(weight, undefined, 'stone-rough');
    spent += prismCost(7);

    if (budget - spent > 60) {
      const drop = Math.max(0.24, nearEnd[1] - drum * 0.5);
      builder.add(strut([nearEnd[0], nearEnd[1], 0], [nearEnd[0], nearEnd[1] - drop, 0], 0.012, 4), undefined, 'rope');
      spent += cylinderCost(4, false);
      if (options.bucket !== false && budget - spent > BUCKET_TRIANGLES) {
        const pail = bucket(radius * 0.33, seed + 5);
        pail.translate(nearEnd[0], Math.max(0.02, nearEnd[1] - drop), 0);
        builder.add(pail);
      }
    }
    // Seated last, and not centred: a sweep well reaches further toward its
    // bucket than toward its counterweight, and the shaft — which is what a
    // caller places — is on the origin.
    seatOnGround(builder, false);
    return builder;
  }

  // A timber head: two posts, a beam, a windlass and a roof.
  const headHeight = drum + radius * 2 + 0.5;
  const beamY = headHeight - 0.13;
  for (const side of [-1, 1] as const) {
    const upright = post({ height: headHeight, radius: postRadius, sides: 6, cap: 'flat', seed: seed + side * 3 });
    // A post is never quite plumb: it was set in a hole and tamped, and the lean
    // is the record of that. It stands on y = 0 like everything else in the
    // library, and the earth that was tamped back around it hides the joint.
    const tilt = side * range(rng, 0.004, 0.02);
    upright.rotateZ(tilt);
    upright.translate(side * (outer + postRadius * 0.8), leanLift(postRadius, tilt), range(rng, -0.02, 0.02));
    builder.add(upright, undefined, 'wood-weathered');
    if (budget - spent > postCost(6) + 2 * prismCost(6, true) + 400) {
      const collar = prism({ sides: 6, radius: postRadius * 2.3, height: postRadius * 1.5, topScale: 0.62 });
      collar.translate(side * (outer + postRadius * 0.8), 0, 0);
      builder.add(collar, undefined, 'soil');
      spent += prismCost(6, true);
    }
  }
  spent += 2 * postCost(6);

  const beam = box(outer * 2 + postRadius * 5, 0.13, 0.14, { bevel: 0.014, bevelSegments: 1 });
  beam.translate(0, beamY, 0);
  builder.add(beam, undefined, 'wood-dark');
  spent += BEVELLED_BOX_TRIANGLES;

  // The windlass: a spindle through the beam, a crank at one end and the rope
  // wound on it. This is the part that makes a well a machine rather than a hole.
  const spindleSides = Math.max(6, segments - 6);
  const spindle = cylinder(postRadius * 0.62, postRadius * 0.62, outer * 1.7, {
    radialSegments: spindleSides,
  });
  spindle.rotateZ(Math.PI / 2);
  spindle.translate(0, beamY - 0.17, 0);
  builder.add(spindle, undefined, 'wood-weathered');
  spent += cylinderCost(spindleSides);

  const crankSide = chance(rng, 0.5) ? 1 : -1;
  builder.add(
    strut(
      [crankSide * outer * 0.85, beamY - 0.17, 0],
      [crankSide * outer * 0.85, beamY - 0.17, postRadius * 2.6],
      postRadius * 0.36,
      5,
    ),
    undefined,
    'wood-weathered',
  );
  const handle = cylinder(postRadius * 0.3, postRadius * 0.3, postRadius * 2.1, { radialSegments: 5 });
  handle.translate(crankSide * outer * 0.85, beamY - 0.17, postRadius * 2.6);
  builder.add(handle, undefined, 'wood-dark');
  spent += cylinderCost(5, false) + cylinderCost(5);

  const canopySpan = outer * 2 + postRadius * 7;
  const canopyRun = outer * 2 + 0.3;
  const canopyPitch = range(rng, 0.62, 0.82);
  const canopyShare = Math.max(140, Math.min((budget - spent) * 0.42, 1600));
  const canopy = gabledCanopy({
    span: canopySpan,
    run: canopyRun,
    pitch: canopyPitch,
    style: pick(rng, ['shingle', 'thatch', 'slate'] as const, 'shingle'),
    budget: canopyShare,
    seed: seed + 17,
  });
  canopy.translate(0, beamY + 0.13, 0);
  builder.add(canopy);
  spent += canopyCost(canopyShare, canopySpan, canopyRun, canopyPitch);

  // How far the rope hangs is the story of the last time somebody drew water.
  const hang = range(rng, drum * 0.5, drum * 1.6);
  if (budget - spent > ropeCost(3, 6) + 40) {
    // Strands, because a player stands at the mouth of a well and looks down.
    builder.add(
      rope({
        path: [[0, beamY - 0.17, 0], [0.02 * radius, beamY - 0.17 - hang * 0.6, 0.01], [0, beamY - 0.17 - hang, 0]],
        radius: 0.014,
        strands: 3,
        segments: 6,
      }),
      undefined,
      'rope',
    );
    spent += ropeCost(3, 6);
  } else if (budget - spent > 40) {
    builder.add(strut([0, beamY - 0.17, 0], [0, beamY - 0.17 - hang, 0], 0.013, 4), undefined, 'rope');
    spent += cylinderCost(4, false);
  }
  if (options.bucket !== false && budget - spent > BUCKET_TRIANGLES) {
    const pail = bucket(radius * 0.33, seed + 5);
    pail.translate(0, Math.max(0.02, beamY - 0.17 - hang), 0);
    builder.add(pail);
  }
  seatOnGround(builder, false);
  return builder;
}

/* --------------------------------------------------------------- fountain */

export type FountainStyle = 'basin' | 'tiered' | 'wall';
export type FountainFinish = 'stone' | 'marble' | 'tile';

export interface FountainOptions {
  /** Outside radius of the basin, in metres. */
  radius?: number;
  /** Height of the basin wall above ground. */
  wall?: number;
  style?: FountainStyle;
  /** `tile` is a zellij basin: the same shape, glazed and blue. */
  finish?: FountainFinish;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Water running: a jet and the sheets falling from it. Off, a fountain is a bath. */
  running?: boolean;
}

/** The surface a finish is built in, and the one its basin floor is tiled with. */
const FOUNTAIN_FINISH: Record<FountainFinish, { stone: string; floor: string; roughness: number }> = {
  stone: { stone: 'stone-dressed', floor: 'cobble', roughness: 0.5 },
  marble: { stone: 'marble', floor: 'stone-pale', roughness: 0.22 },
  tile: { stone: 'ceramic-blue', floor: 'ceramic-blue', roughness: 0.16 },
};

/**
 * A fountain: a basin, something to lift the water, and the water falling.
 *
 * The falling water is the asset. A basin with a column in it reads as a
 * birdbath until there is a sheet coming off the upper bowl, and that sheet is
 * nearly free — a hollow cone of the same transparent surface as the standing
 * water, eight segments around, no caps. Everything else here is masonry and is
 * paid for the way masonry is: a ring wall turned in one piece with the rim
 * rolled over it, then a coping of individual blocks laid to the circle when the
 * budget can afford the joints.
 *
 * `wall` is the other fountain, the one that belongs to a lane rather than a
 * square: a niche in a tiled wall with a spout through it and a small basin
 * underneath, which is how a sabil is built and how it is used — you drink from
 * it, you do not walk around it.
 */
export function fountain(options: FountainOptions): MeshBuilder {
  const seed = options.seed ?? 91;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.4, options.radius ?? 1.7);
  const wallHeight = Math.max(0.25, options.wall ?? radius * 0.36);
  const style = options.style ?? 'basin';
  const finish = FOUNTAIN_FINISH[options.finish ?? 'stone'];
  const budget = componentBudget(options.quality, options.budget);
  const running = options.running !== false;
  const segments = Math.max(8, Math.min(24, Math.round(budget / 120)));
  const rim = 0.06 + radius * 0.05;
  let spent = 0;

  const basinRadius = style === 'wall' ? radius * 0.52 : radius;
  const basinWall = style === 'wall' ? wallHeight * 0.7 : wallHeight;

  // The basin in one turn: up the outside, over the rim, down the inside, across
  // the floor. A basin built as a disc with a wall around it has a seam at the
  // water line and shows its own underside from above.
  const profile: Vec2[] = [
    [basinRadius, 0],
    [basinRadius * 1.01, basinWall * 0.6],
    [basinRadius + rim * 0.4, basinWall],
    [basinRadius + rim, basinWall + rim * 0.9],
    [basinRadius + rim * 0.5, basinWall + rim * 1.2],
    [basinRadius - rim * 0.5, basinWall + rim * 0.5],
    [basinRadius - rim * 1.1, basinWall * 0.86],
    [basinRadius - rim * 1.2, basinWall * 0.2],
    [0, basinWall * 0.16],
  ];
  const basin = lathe(profile, { segments, caps: false });
  basin.flatShade();
  builder.add(basin, undefined, finish.stone);
  spent += latheCost(profile.length, segments);

  // Tiled floor under the water: the reason a fountain looks cold and clean.
  const floor = waterSheet(basinRadius - rim * 1.15, segments, basinWall * 0.17);
  builder.add(floor, undefined, finish.floor);
  spent += latheCost(2, segments);

  if (running) {
    const water = waterSheet(basinRadius - rim * 1.2, segments, basinWall * 0.78);
    builder.add(water, undefined, 'glass');
    spent += latheCost(2, segments);
  }

  const copingShare = Math.max(0, Math.min((budget - spent) * 0.3, 900));
  const wanted = Math.max(6, Math.round((Math.PI * 2 * basinRadius) / (rim * 3.4)));
  const coping = planChildren(wanted, BEVELLED_BOX_TRIANGLES, copingShare);
  if (coping.modeled >= 6 && style !== 'wall') {
    // Joints are the read: a rim turned as one band is a pipe.
    const ring = stoneRing(
      basinRadius + rim * 0.35,
      coping.modeled,
      (Math.PI * 2 * (basinRadius + rim * 0.35)) / coping.modeled * 0.94,
      rim * 1.5,
      rim * 2.6,
      seed + 3,
    );
    ring.translate(0, basinWall + rim * 0.35, 0);
    builder.add(ring, undefined, finish.stone);
    spent += coping.modeled * BEVELLED_BOX_TRIANGLES;
  }

  if (style === 'wall') {
    // A niche in a wall: the spout comes through the tiles and the basin sits
    // under it, so the whole thing is built against a plane at the back.
    const wallWidth = radius * 2.1;
    const wallHeightTotal = radius * 2.5;
    const thickness = radius * 0.24;
    const back = box(wallWidth, wallHeightTotal, thickness, { bevel: 0.02, bevelSegments: 1 });
    back.translate(0, wallHeightTotal / 2, -basinRadius - thickness / 2 - 0.02);
    builder.add(back, undefined, 'plaster-white');
    spent += BEVELLED_BOX_TRIANGLES;

    // The niche: a horseshoe arch recessed into the wall, tiled inside.
    const archSpan = radius * 0.9;
    const niche = arch({
      span: archSpan,
      rise: archSpan * 0.72,
      thickness: thickness * 0.5,
      depth: radius * 0.9,
      segments: Math.max(8, Math.round(segments / 2)),
      voussoirs: coping.each > BEVELLED_BOX_TRIANGLES * 2,
    });
    // `arch` stands in XY and extrudes along +Z, which is exactly a niche in a
    // wall: laid flat it would be an arch you walk over, and its own thickness
    // would hang below the ground.
    niche.translate(0, basinWall + radius * 0.62, -basinRadius - thickness);
    builder.add(niche, undefined, 'ceramic-blue');
    spent += 84;

    const tileShare = Math.max(0, Math.min((budget - spent) * 0.22, 600));
    const tiles = planChildren(Math.max(4, Math.round(radius * 8)), BOX_TRIANGLES, tileShare);
    for (let index = 0; index < tiles.modeled; index += 1) {
      const column = index % Math.max(2, Math.round(Math.sqrt(tiles.modeled)));
      const row = Math.floor(index / Math.max(2, Math.round(Math.sqrt(tiles.modeled))));
      const tile = box(wallWidth / 5, radius * 0.3, 0.02);
      tile.translate(
        -wallWidth * 0.34 + (column * wallWidth * 0.68) / Math.max(1, tiles.modeled / 2 - 1),
        basinWall + radius * 0.2 + row * radius * 0.32,
        -basinRadius - thickness - 0.01,
      );
      builder.add(tile, undefined, pick(rng, ['ceramic-blue', 'ceramic', 'stone-pale'] as const, 'ceramic-blue'));
    }
    spent += tiles.modeled * BOX_TRIANGLES;

    // The spout: bronze through the tiles, worn shiny where the water runs.
    const spout = cylinder(radius * 0.05, radius * 0.07, radius * 0.5, { radialSegments: 6 });
    spout.rotateX(Math.PI / 2.5);
    spout.translate(0, basinWall + radius * 0.72, -basinRadius - thickness * 0.2);
    builder.add(spout, undefined, 'bronze');
    spent += cylinderCost(6);
    if (running) {
      const fall = cylinder(radius * 0.02, radius * 0.05, basinWall + radius * 0.5, {
        radialSegments: 6,
        caps: false,
      });
      fall.translate(0, (basinWall + radius * 0.5) / 2 + basinWall * 0.3, -basinRadius + radius * 0.1);
      builder.add(fall, undefined, 'glass');
      spent += cylinderCost(6, false);
    }
    // Centred on its box like every other component: the niche faces +Z and the
    // wall is behind it, so a caller butts the back of the bounds onto a wall.
    centerHorizontally(builder);
    seatOnGround(builder, false);
    return builder;
  }

  // The piece in the middle: a pedestal, and for a tiered fountain a bowl on it
  // with a second column and a smaller bowl above.
  const columnShare = Math.max(0, budget - spent - (running ? 220 : 0));
  const columnSegments = Math.max(6, Math.min(14, Math.round(columnShare / 90)));
  const tiers = style === 'tiered' ? 2 : 1;
  let at = basinWall * 0.17;
  let bowlRadius = basinRadius * 0.4;
  for (let tier = 0; tier < tiers; tier += 1) {
    const columnHeight = (tier === 0 ? basinRadius * 0.72 : basinRadius * 0.42) * (style === 'tiered' ? 1 : 1.2);
    const columnProfile: Vec2[] = [
      [bowlRadius * 0.46, 0],
      [bowlRadius * 0.4, columnHeight * 0.08],
      [bowlRadius * 0.24, columnHeight * 0.16],
      [bowlRadius * 0.2, columnHeight * 0.82],
      [bowlRadius * 0.3, columnHeight * 0.92],
      [bowlRadius * 0.26, columnHeight],
    ];
    const column = lathe(columnProfile, { segments: columnSegments, caps: false });
    column.flatShade();
    column.translate(0, at, 0);
    builder.add(column, undefined, finish.stone);
    spent += latheCost(columnProfile.length, columnSegments);
    at += columnHeight;

    if (style === 'tiered' || tier === 0) {
      // A bowl is a turned dish with its rim rolled outward, so water leaves it
      // as a sheet at the lip rather than running down the outside.
      const bowlProfile: Vec2[] = [
        [bowlRadius * 0.18, 0],
        [bowlRadius * 0.86, bowlRadius * 0.04],
        [bowlRadius, bowlRadius * 0.24],
        [bowlRadius * 1.02, bowlRadius * 0.3],
        [bowlRadius * 0.92, bowlRadius * 0.28],
        [bowlRadius * 0.7, bowlRadius * 0.1],
        [bowlRadius * 0.16, bowlRadius * 0.06],
      ];
      const bowl = lathe(bowlProfile, { segments: columnSegments, caps: false });
      bowl.flatShade();
      bowl.translate(0, at - bowlRadius * 0.02, 0);
      builder.add(bowl, undefined, finish.stone);
      spent += latheCost(bowlProfile.length, columnSegments);
      if (running) {
        builder.add(waterSheet(bowlRadius * 0.88, columnSegments, at + bowlRadius * 0.16), undefined, 'glass');
        spent += latheCost(2, columnSegments);
      }
      at += bowlRadius * 0.3;
      bowlRadius *= 0.56;
    }
  }

  if (running && budget - spent > 60) {
    // The jet, and the sheet falling off the top bowl. Both are the transparent
    // surface, both are hollow, and neither is capped: water you can see through
    // is what water looks like from the outside of it.
    const jetHeight = Math.max(0.12, basinRadius * 0.3);
    const jet = cylinder(0.012, 0.03, jetHeight, { radialSegments: 5, caps: false });
    jet.translate(0, at + jetHeight / 2, 0);
    builder.add(jet, undefined, 'glass');
    spent += cylinderCost(5, false);
    const fallHeight = Math.max(0.2, at - basinWall * 0.78);
    const fall = cylinder(basinRadius * 0.06, basinRadius * 0.14, fallHeight, {
      radialSegments: Math.max(6, Math.round(columnSegments * 0.7)),
      caps: false,
    });
    fall.translate(0, basinWall * 0.78 + fallHeight / 2, 0);
    builder.add(fall, undefined, 'glass');
    spent += cylinderCost(Math.max(6, Math.round(columnSegments * 0.7)), false);
  }

  if (style === 'basin' && budget - spent > 400) {
    // A step up to the rim on one side, worn hollow in the middle by feet.
    const step = box(radius * 0.9, basinWall * 0.42, radius * 0.34, { bevel: 0.015, bevelSegments: 1 });
    step.translate(radius * range(rng, 0.2, 0.4) * (chance(rng, 0.5) ? 1 : -1), basinWall * 0.21, basinRadius + radius * 0.16);
    builder.add(step, undefined, finish.stone);
    spent += BEVELLED_BOX_TRIANGLES;
  }
  seatOnGround(builder, false);
  return builder;
}

/* ----------------------------------------------------------- market stall */

export type AwningStyle = 'striped' | 'plain' | 'thatch' | 'none';

export interface MarketStallOptions {
  /** Across the front, along X. */
  width?: number;
  /** Back to front, along Z. */
  depth?: number;
  /** Height of the awning at its front edge. */
  height?: number;
  style?: AwningStyle;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** What is for sale: crates, pots, sacks, produce. A stall without goods is a shelter. */
  goods?: boolean;
  /** The board the goods are sold from. */
  counter?: boolean;
}

/** The two cloths a striped awning alternates, and the surfaces goods are sold in. */
const AWNING_STRIPE = ['fabric-linen', 'fabric'] as const;
const PRODUCE_SURFACE = ['foliage', 'petal-warm', 'petal', 'foliage-olive'] as const;

/**
 * A market stall: four posts, an awning, a counter and the day's goods.
 *
 * The awning is striped because that is what a market awning is — the stripes
 * come from the widths of the cloth the canopy was sewn from, and a stall with a
 * single-colour roof reads as a shelter rather than a shop. Each stripe is one
 * sheet, and the sheets sag between the rafters, which is the difference between
 * a canopy and a plane tilted in space.
 *
 * The goods are the budget's first sacrifice and the silhouette's last: a poor
 * stall keeps its posts, its awning and its counter and simply has less on it,
 * because a stall that lost a post is not a poor stall, it is a collapsed one.
 */
export function marketStall(options: MarketStallOptions): MeshBuilder {
  const seed = options.seed ?? 113;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = Math.max(1.2, options.width ?? 3);
  const depth = Math.max(0.9, options.depth ?? 2);
  const height = Math.max(1.6, options.height ?? 2.4);
  const style = options.style ?? 'striped';
  const budget = componentBudget(options.quality, options.budget);
  // One ware, one sack cloth and one crop per stall, decided once: a stall sells
  // one kind of thing, and picking per item would cost four draw calls for the
  // same read. The variety between stalls comes from the seed.
  const ware = pick(rng, ['ceramic', 'terracotta', 'ceramic-blue'] as const, 'ceramic');
  const sack = pick(rng, ['wool', 'fabric-linen', 'wattle'] as const, 'wool');
  const produce = pick(rng, PRODUCE_SURFACE, 'foliage');
  const signWood = chance(rng, 0.5) ? 'wood-painted' : 'wood-oak';
  const drop = depth * 0.2;
  const slope = Math.hypot(depth + depth * 0.16, drop);
  let spent = 0;

  const postSides = budget > 1400 ? 6 : 5;
  const postRadius = 0.05 + width * 0.012;
  const corners: [number, number, number][] = [
    [-width / 2 + postRadius, height, -depth / 2 + postRadius],
    [width / 2 - postRadius, height, -depth / 2 + postRadius],
    [-width / 2 + postRadius, height - drop, depth / 2 - postRadius],
    [width / 2 - postRadius, height - drop, depth / 2 - postRadius],
  ];
  for (const [x, postHeight, z] of corners) {
    const upright = post({ height: postHeight, radius: postRadius, sides: postSides, cap: 'flat', seed: seed + Math.round(x * 10) });
    const tilt = range(rng, -0.012, 0.012);
    upright.rotateZ(tilt);
    upright.translate(x, leanLift(postRadius, tilt), z);
    builder.add(upright, undefined, 'wood-weathered');
    spent += postCost(postSides);
  }

  if (style !== 'none') {
    const stripes = style === 'striped' ? Math.max(3, Math.min(9, Math.round(width / 0.42))) : 1;
    const across = Math.max(1, Math.round(width / stripes / 0.3));
    const along = style === 'thatch' ? 4 : 3;
    const awningShare = Math.min((budget - spent) * 0.34, 1400);
    const valance = style !== 'thatch' && awningShare > clothCost(stripes * 2, 3) * 2 + 200;
    for (let index = 0; index < stripes; index += 1) {
      const stripeWidth = width / stripes;
      const sheet = cloth(stripeWidth * 1.02, slope, across, along, (u, v) => {
        // Each stripe dips between its own two rafters and the whole canopy dips
        // toward the free front edge, where nothing holds it up.
        const u01 = Math.abs(u - 0.5) * 2;
        return -(0.05 + 0.05 * v) * (1 - u01 * u01) - stripeWidth * 0.06 * Math.sin(v * Math.PI);
      });
      sheet.rotateX(Math.atan2(drop, depth));
      sheet.translate(-width / 2 + stripeWidth * (index + 0.5), height - drop * 0.42, 0);
      builder.add(sheet, undefined, style === 'thatch' ? 'thatch' : AWNING_STRIPE[index % 2]!);
      spent += clothCost(across, along);
    }
    // Battens under the canopy, where the stripes meet: the rafters the cloth is
    // laid on, and the reason the sag reads as sag.
    const battens = planChildren(stripes + 1, BOX_TRIANGLES, Math.max(BOX_TRIANGLES, awningShare - spent * 0.2));
    for (let index = 0; index < battens.modeled; index += 1) {
      const x = -width / 2 + (width * index) / Math.max(1, battens.modeled - 1);
      const batten = strut([x, height, -depth / 2], [x, height - drop, depth / 2 + depth * 0.08], 0.028, 4);
      builder.add(batten, undefined, 'wood-weathered');
      spent += cylinderCost(4, false);
    }
    if (valance) {
      // A valance hanging at the front edge, scalloped: the strip of cloth that
      // says what is sold here, cut so the rain runs off it in drops.
      const scallops = Math.max(3, Math.round(width / 0.42));
      const valanceDepth = Math.min(0.34, height * 0.13);
      const strip = cloth(width, valanceDepth, scallops * 3, 3, (u, v) => -0.012 * Math.sin(u * Math.PI * 2 * 3) * v);
      strip.rotateX(Math.PI / 2);
      // Cut the hanging edge into scallops by lifting the vertices that fall
      // outside them, which is how a scalloped valance is cut from a rectangle.
      for (let index = 0; index < strip.vertexCount; index += 1) {
        const point = strip.positionAt(index);
        const u = (point[0] + width / 2) / width;
        const cut = valanceDepth * (0.42 + 0.4 * Math.cos(u * Math.PI * 2 * scallops));
        if (point[1] > -cut) strip.setPosition(index, [point[0], -cut, point[2]]);
      }
      strip.computeNormals();
      strip.translate(0, height - drop - 0.02, depth / 2 + depth * 0.07);
      builder.add(strip, undefined, AWNING_STRIPE[1]!);
      spent += clothCost(scallops * 3, 3);
    }
  }

  const counterTop = 0.9;
  if (options.counter !== false) {
    const boards = Math.max(3, Math.min(7, Math.round(width / 0.34)));
    const top = planks({ width: width * 0.98, height: depth * 0.66, thickness: 0.05, count: boards, horizontal: true, seed });
    top.translate(0, counterTop, depth * 0.12);
    builder.add(top, undefined, 'plank');
    spent += boards * BEVELLED_BOX_TRIANGLES;
    const skirt = box(width * 0.94, counterTop - 0.08, 0.04, { bevel: 0.01, bevelSegments: 1 });
    skirt.translate(0, (counterTop - 0.08) / 2, depth * 0.44);
    builder.add(skirt, undefined, 'plank');
    spent += BEVELLED_BOX_TRIANGLES;
    // A shelf behind, and the jars on it: the stock that is not for touching.
    if (budget - spent > 320) {
      const shelf = box(width * 0.9, 0.04, depth * 0.3);
      shelf.translate(0, counterTop * 0.55, -depth * 0.3);
      builder.add(shelf, undefined, 'plank');
      spent += BOX_TRIANGLES;
      const jars = planChildren(Math.round(width * 1.6), latheCost(6, 7), Math.min((budget - spent) * 0.3, 500));
      const spots = scatter(rng, jars.modeled, width * 0.84, depth * 0.24, 0.5);
      for (let index = 0; index < spots.length; index += 1) {
        const spot = spots[index]!;
        const jar = pot(0.22 + range(rng, -0.03, 0.05), 0.075, 7, seed + index * 11);
        jar.translate(spot[0], counterTop * 0.57, -depth * 0.3 + spot[1]);
        builder.add(jar, undefined, ware);
      }
      spent += jars.modeled * latheCost(6, 7);
    }
  }

  if (options.goods !== false && budget - spent > 240) {
    // The day's goods, on the counter and on the ground in front of it. Placed on
    // a jittered grid so they spread the way stock is laid out — evenly, but not
    // in lines — and each one is whatever the allowance can still afford.
    const goodsShare = Math.min(budget - spent, budget * 0.34);
    const onCounter = options.counter !== false ? Math.max(3, Math.round(width * 1.8)) : 0;
    const onGround = Math.max(3, Math.round(width * 1.4));
    const plan = planChildren(onCounter + onGround, BOX_TRIANGLES, goodsShare);
    const spots = scatter(rng, plan.modeled, width * 0.92, depth * 0.5 + 0.9, 0.66);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      const onTop = options.counter !== false && spot[1] < depth * 0.34;
      const y = onTop ? counterTop + 0.03 : 0;
      const z = onTop ? depth * 0.12 + spot[1] * 0.5 : depth * 0.5 + 0.45 + spot[1];
      const each = plan.each;
      if (each > latheCost(6, 8) && chance(rng, 0.34)) {
        const potPart = pot(range(rng, 0.2, 0.34), range(rng, 0.09, 0.14), 8, seed + index * 13);
        placeOn(potPart, spot[0], y, z);
        builder.add(potPart, undefined, ware);
      } else if (each > sphereCost(6, 4) && chance(rng, 0.4)) {
        // A sack: a sphere squashed by its own weight and tied at the neck.
        const bag = sphere(range(rng, 0.13, 0.2), { widthSegments: 6, heightSegments: 4 });
        bag.scale(1, 0.78, 1);
        bag.computeNormals();
        placeOn(bag, spot[0], y, z);
        builder.add(bag, undefined, sack);
      } else if (each > barrelCost(8, 2) && chance(rng, 0.18)) {
        const cask = barrel({ height: range(rng, 0.5, 0.72), radius: range(rng, 0.17, 0.24), staves: 8, hoops: 2, seed: seed + index * 17 });
        placeOn(cask, spot[0], y, z);
        builder.add(cask, undefined, 'wood-oak');
      } else if (each > LEAF_TRIANGLES * 8 && chance(rng, 0.5)) {
        // Produce: a heap of leaves with something round under it.
        const heap = leafCluster({ radius: range(rng, 0.11, 0.17), leaves: 8, seed: seed + index * 19 });
        placeOn(heap, spot[0], y + 0.02, z);
        builder.add(heap, undefined, produce);
      } else {
        const crate = box(range(rng, 0.24, 0.4), range(rng, 0.18, 0.3), range(rng, 0.2, 0.34));
        crate.rotateY(range(rng, -0.3, 0.3));
        placeOn(crate, spot[0], y, z);
        builder.add(crate, undefined, 'wood-pine');
      }
      spent += each;
    }
  }

  if (style !== 'none' && budget - spent > 260) {
    // The sign: a board hanging from the front edge of the awning, swinging free.
    const board = box(width * 0.42, 0.3, 0.035, { bevel: 0.008, bevelSegments: 1 });
    board.rotateY(range(rng, -0.16, 0.16));
    board.translate(range(rng, -width * 0.16, width * 0.16), height - drop - 0.44, depth / 2 + depth * 0.06);
    builder.add(board, undefined, signWood);
    spent += BEVELLED_BOX_TRIANGLES;
    for (const side of [-1, 1] as const) {
      const link = strut(
        [board.bounds().min[0] + (side > 0 ? board.bounds().size[0] : 0), height - drop - 0.3, depth / 2 + depth * 0.06],
        [board.bounds().min[0] + (side > 0 ? board.bounds().size[0] : 0), height - drop - 0.06, depth / 2 + depth * 0.04],
        0.008,
        4,
      );
      builder.add(link, undefined, 'iron-wrought');
      spent += cylinderCost(4, false);
    }
  }
  seatOnGround(builder, false);
  return builder;
}

/* --------------------------------------------------------------- signpost */

export type SignpostStyle = 'finger' | 'board' | 'milestone';

export interface SignpostOptions {
  /** Height of the post above ground. */
  height?: number;
  /** Directional arms, for `finger`; ignored by the other styles. */
  arms?: number;
  style?: SignpostStyle;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Painted timber rather than bare: a sign somebody maintains. */
  painted?: boolean;
}

/**
 * A signpost: the one prop that tells a player the world has somewhere else in it.
 *
 * Three kinds, because three kinds of place need three kinds of sign. A
 * fingerpost at a crossroads, its arms pointing where the roads go and staggered
 * in height so every one of them can be read from the same place. A board at a
 * gate, under a small hood because the letters are the point and rain is what
 * ruins them. A milestone on a road, which is a stone and does not need to be
 * tall, only to be there at the interval it was set at.
 */
export function signpost(options: SignpostOptions): MeshBuilder {
  const seed = options.seed ?? 131;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.6, options.height ?? 2.2);
  const style = options.style ?? 'finger';
  const budget = componentBudget(options.quality, options.budget);
  const painted = options.painted ?? chance(rng, 0.4);
  const timber = painted ? 'wood-painted' : 'wood-weathered';
  let spent = 0;

  if (style === 'milestone') {
    // A stone: a dressed block with a domed head, sunk in a bed of its own grit.
    const sides = Math.max(6, Math.min(12, Math.round(budget / 90)));
    const shaft = cylinder(height * 0.16, height * 0.19, height * 0.82, { radialSegments: sides, ripple: 0.02 });
    fracture(shaft, { amplitude: height * 0.012, frequency: 6 / height, octaves: 2, seed, preserveBase: true });
    shaft.translate(0, height * 0.41, 0);
    builder.add(shaft, undefined, 'stone-dressed');
    spent += cylinderCost(sides);
    const head = sphere(height * 0.17, { widthSegments: sides, heightSegments: Math.max(3, Math.round(sides / 2)) });
    head.scale(1, 0.6, 1);
    head.computeNormals();
    head.translate(0, height * 0.83, 0);
    builder.add(head, undefined, 'stone-dressed');
    spent += sphereCost(sides, Math.max(3, Math.round(sides / 2)));
    const bed = prism({ sides: Math.max(5, sides - 2), radius: height * 0.3, height: height * 0.1, topScale: 0.9 });
    fracture(bed, { amplitude: height * 0.02, frequency: 7 / height, octaves: 2, seed: seed + 9 });
    builder.add(bed, undefined, 'gravel');
    spent += prismCost(Math.max(5, sides - 2));
    fitHeight(builder, height, 1.4);
    return builder;
  }

  const postSides = budget > 900 ? 6 : 5;
  const postRadius = Math.max(0.045, height * 0.032);
  const upright = post({ height, radius: postRadius, sides: postSides, cap: 'pointed', seed });
  const postTilt = range(rng, -0.015, 0.015);
  upright.rotateZ(postTilt);
  upright.translate(0, leanLift(postRadius, postTilt), 0);
  builder.add(upright, undefined, timber);
  spent += postCost(postSides);

  // Set in the ground, not balanced on it: a mound of what was dug out.
  if (budget - spent > 120) {
    const collar = prism({ sides: 6, radius: postRadius * 2.6, height: postRadius * 1.6, topScale: 0.6 });
    collar.rotateY(range(rng, 0, Math.PI));
    builder.add(collar, undefined, 'soil');
    spent += prismCost(6, true);
  }

  if (style === 'board') {
    const boardWidth = Math.min(height * 0.72, 1.1);
    const boardHeight = Math.min(height * 0.3, 0.42);
    const board = box(boardWidth, boardHeight, 0.04, { bevel: 0.008, bevelSegments: 1 });
    board.translate(0, height * 0.78, postRadius + 0.02);
    builder.add(board, undefined, painted ? 'wood-painted' : 'plank');
    spent += BEVELLED_BOX_TRIANGLES;
    // A hood over the letters: two sheets and a ridge, because rain is what
    // erases a sign and the hood is the cheapest way to keep it legible.
    const hood = gabledCanopy({
      span: boardWidth + 0.12,
      run: 0.3,
      pitch: 0.8,
      style: 'shingle',
      budget: Math.max(140, Math.min(budget - spent, 600)),
      seed: seed + 23,
    });
    hood.translate(0, height * 0.78 + boardHeight / 2 + 0.02, postRadius + 0.06);
    builder.add(hood);
    spent += canopyCost(Math.max(140, Math.min(budget - spent, 600)), boardWidth + 0.12, 0.3, 0.8);
    for (const side of [-1, 1] as const) {
      const brace = strut(
        [side * postRadius * 0.9, height * 0.62, postRadius * 0.6],
        [side * boardWidth * 0.4, height * 0.78 - boardHeight * 0.4, postRadius + 0.02],
        postRadius * 0.3,
        4,
      );
      builder.add(brace, undefined, timber);
      spent += cylinderCost(4, false);
    }
    fitHeight(builder, height, 1.4);
    return builder;
  }

  // A fingerpost: arms staggered in height and turned to different bearings, so
  // they can all be read from the one place a traveller stands.
  // Arms are the first thing a bigger allowance buys: a fingerpost with four
  // arms is a crossroads, and one with two is a fork in a lane.
  const wanted = Math.max(1, Math.min(4, Math.round(options.arms ?? (budget > 2000 ? 4 : budget > 800 ? 3 : 2))));
  const arms = planChildren(wanted, 16, Math.max(16, budget - spent));
  const armLength = Math.min(height * 0.52, 0.86);
  for (let index = 0; index < arms.modeled; index += 1) {
    const t = arms.modeled === 1 ? 0.5 : index / (arms.modeled - 1);
    const at = height * (0.62 + 0.3 * t);
    const bearing = (index / arms.modeled) * Math.PI * 2 + range(rng, -0.22, 0.22);
    // The arm is extruded as a board with a point on it: a pentagon section is
    // sixteen triangles, where a chamfered box is forty-four and has no point.
    const section: Vec2[] = [
      [0, -armLength * 0.075],
      [armLength * 0.82, -armLength * 0.075],
      [armLength, 0],
      [armLength * 0.82, armLength * 0.075],
      [0, armLength * 0.075],
    ];
    const arm = extrude(section, { depth: 0.032 });
    arm.rotateX(Math.PI / 2);
    // Drooped while the arm still points along +X, so what goes down is its tip,
    // and only then turned to its bearing. Turned first, the droop tilts it about
    // an axis that is no longer across the arm; turned twice, four arms collapse
    // onto two bearings and a crossroads signpost points at two places.
    arm.rotateZ(-range(rng, 0.006, 0.03));
    arm.rotateY(bearing);
    arm.translate(0, at + range(rng, -0.014, 0.006), 0);
    builder.add(arm, undefined, painted ? 'wood-painted' : 'plank');
    spent += 16;
    const nail = cylinder(0.012, 0.012, postRadius * 2.4, { radialSegments: 4 });
    nail.rotateZ(Math.PI / 2);
    nail.rotateY(bearing);
    nail.translate(Math.sin(bearing) * postRadius * 0.4, at, Math.cos(bearing) * postRadius * 0.4);
    builder.add(nail, undefined, 'iron-wrought');
    spent += cylinderCost(4);
  }

  if (budget - spent > 90) {
    const finial = sphere(postRadius * 1.5, { widthSegments: 6, heightSegments: 4 });
    finial.translate(0, height + postRadius * 0.6, 0);
    builder.add(finial, undefined, timber);
    spent += sphereCost(6, 4);
  }
  fitHeight(builder, height, 1.4);
  return builder;
}

/* ------------------------------------------------------------------ fence */

export type FenceStyle = 'picket' | 'rail' | 'wattle' | 'stone';

export interface FenceOptions {
  /** Run of the fence along X, in metres. */
  length: number;
  /** Height of the infill; posts stand a little proud of it. */
  height?: number;
  style?: FenceStyle;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Post spacing in metres; each style has its own default. */
  spacing?: number;
  /** A gap in the run for a gate: nothing is built across it, and the posts at its edges are heavier. */
  gap?: { at: number; width: number };
  /** How broken the fence is, 0 = new, 1 = half of it is gone. */
  ruin?: number;
}

/** Triangles a picket costs: a board extruded to a point, which is sixteen. */
const PICKET_TRIANGLES = 16;

/**
 * A fence: posts, and whatever the local material is between them.
 *
 * Four kinds, and they are four economies rather than four shapes. Pickets are
 * sawn boards, which is a lot of work and reads as a place that keeps something
 * out; rails are two or three poles, which is a day's work and reads as a
 * boundary between fields; wattle is woven hazel, which is free and rots in a
 * decade; dry stone is what you build where there is no wood, and it is the only
 * one of the four that gets better as it falls down.
 *
 * A poor fence keeps its whole run. The spacing widens or the boards get thinner,
 * because a fence that stops half way is not a cheap fence, it is a different
 * fence — and the extent is what a caller places.
 */
export function fence(options: FenceOptions): MeshBuilder {
  const seed = options.seed ?? 149;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const length = Math.max(0.6, options.length);
  const height = Math.max(0.35, options.height ?? 1.1);
  const style = options.style ?? 'picket';
  const budget = componentBudget(options.quality, options.budget);
  const ruin = Math.max(0, Math.min(1, options.ruin ?? 0));
  const spacing = Math.max(0.7, options.spacing ?? (style === 'picket' ? 1.7 : style === 'rail' ? 2.3 : 2.4));
  const half = length / 2;
  let spent = 0;

  // A gap splits the run into the spans that actually get built, and puts a
  // heavier post at each of its edges, which is where the load of a gate goes.
  const gap = options.gap;
  const spans: [number, number][] = [];
  const gatePosts: number[] = [];
  if (gap && gap.width > 0.2) {
    const width = Math.min(length * 0.8, Math.max(0.5, gap.width));
    const at = Math.max(-half + width / 2 + 0.1, Math.min(half - width / 2 - 0.1, gap.at));
    if (at - width / 2 > -half + 0.15) spans.push([-half, at - width / 2]);
    if (at + width / 2 < half - 0.15) spans.push([at + width / 2, half]);
    gatePosts.push(at - width / 2, at + width / 2);
  } else {
    spans.push([-half, half]);
  }
  const built = spans.reduce((sum, [from, to]) => sum + (to - from), 0);

  const postSides = budget > 2200 ? 6 : budget > 800 ? 5 : 4;
  const postRadius = style === 'stone' ? 0.05 : 0.045 + height * 0.016;
  const postHeight = height * (style === 'picket' ? 1.05 : 1.12);

  // A dry stone wall carries itself: the only uprights it has are the piers
  // either side of a gate, and those are stone too. `planChildren` floors its
  // count at one — a component that was asked for something builds something —
  // so a wall asks for no plan at all rather than a plan for zero posts, which
  // would leave one timber post standing at the end of a stone wall.
  const wantedPosts = spans.reduce((sum, [from, to]) => sum + Math.max(2, Math.round((to - from) / spacing) + 1), 0);
  const posts = style === 'stone'
    ? { modeled: 0, each: 0 }
    : planChildren(wantedPosts, postCost(postSides), Math.min(budget * 0.42, wantedPosts * postCost(postSides)));
  const postAt: number[] = [];
  for (const [from, to] of spans) {
    const bays = Math.max(1, Math.round((to - from) / spacing));
    for (let index = 0; index <= bays; index += 1) {
      if (postAt.length >= posts.modeled) break;
      postAt.push(from + ((to - from) * index) / bays);
    }
  }
  for (let index = 0; index < postAt.length; index += 1) {
    const at = postAt[index]!;
    const isGatePost = gatePosts.some((gateAt) => Math.abs(gateAt - at) < 0.06);
    const upright = post({
      height: postHeight * (isGatePost ? 1.16 : range(rng, 0.97, 1.03)),
      radius: postRadius * (isGatePost ? 1.5 : 1),
      sides: isGatePost ? Math.min(8, postSides + 2) : postSides,
      cap: isGatePost ? 'pointed' : pick(rng, ['pointed', 'flat', 'round'] as const, 'pointed'),
      seed: seed + index * 11,
    });
    const tilt = range(rng, -0.022, 0.022);
    upright.rotateZ(tilt);
    upright.rotateY(range(rng, -0.2, 0.2));
    upright.translate(at, leanLift(postRadius, tilt), range(rng, -0.02, 0.02));
    builder.add(upright, undefined, isGatePost ? 'wood-dark' : 'wood-weathered');
    spent += postCost(isGatePost ? Math.min(8, postSides + 2) : postSides);
  }

  if (style === 'stone') {
    // Dry stone: no posts to speak of, just a wall, and it is `stoneWall` that
    // decides how many of its blocks stay solid at this allowance. A wall is
    // thicker at its foot than at its head, which is the whole reason it stands
    // without mortar, and `stoneWall` in rubble style builds that batter.
    const wallShare = Math.max(120, budget - spent);
    const thickness = 0.4 + height * 0.12;
    for (const [from, to] of spans) {
      const share = (wallShare * (to - from)) / Math.max(0.2, built);
      const run = stoneWall({
        width: to - from,
        height,
        thickness,
        style: 'rubble',
        ruin: Math.max(ruin, 0.18),
        seed: seed + Math.round(from * 13),
        budget: share,
      });
      run.translate((from + to) / 2, 0, 0);
      builder.add(run, undefined, 'stone-rough');
      spent += share;
    }
    for (const at of gatePosts) {
      // Piers at the gate, taller and squarer than the wall: the load of a gate
      // goes into the ground through them, and a wall that meets a gate without
      // one leans into the opening within a year.
      const pier = stoneWall({
        width: thickness * 1.3,
        height: height * 1.22,
        thickness: thickness * 1.3,
        style: 'rubble',
        ruin: 0,
        seed: seed + Math.round(at * 17),
        budget: Math.max(120, (budget - spent) / Math.max(1, gatePosts.length)),
      });
      pier.translate(at, 0, 0);
      builder.add(pier, undefined, 'stone-rough');
      spent += Math.max(120, (budget - spent) / Math.max(1, gatePosts.length));
      const cap = dressedBlock({ width: thickness * 1.5, height: thickness * 0.3, depth: thickness * 1.5, chamfer: 0.02, seed: seed + Math.round(at) });
      cap.translate(at, height * 1.22, 0);
      builder.add(cap, undefined, 'stone-dressed');
      spent += BEVELLED_BOX_TRIANGLES;
    }
    seatOnGround(builder, false);
    return builder;
  }

  const infillShare = Math.max(0, budget - spent);

  if (style === 'picket') {
    // Boards pointed at the top: a pentagon section extruded to a thickness, at
    // sixteen triangles, where a chamfered box is forty-four and has no point.
    const wanted = Math.max(4, Math.round((built / (0.075 + height * 0.012)) * (1 - ruin * 0.5)));
    const plan = planChildren(wanted, PICKET_TRIANGLES, infillShare);
    // Laid across the whole run at the spacing the allowance allows, so a poor
    // fence is a sparse fence and not half a fence.
    const step = built / plan.modeled;
    let laid = 0;
    for (const [from, to] of spans) {
      const runLength = to - from;
      const inSpan = Math.max(1, Math.round((plan.modeled * runLength) / Math.max(0.2, built)));
      for (let index = 0; index < inSpan && laid < plan.modeled; index += 1, laid += 1) {
        const at = from + (runLength * (index + 0.5)) / inSpan + range(rng, -step * 0.16, step * 0.16);
        const picketHeight = height * range(rng, 0.9, 1.02);
        const picketWidth = Math.min(step * 0.62, 0.06 + height * 0.014);
        const section: Vec2[] = [
          [-picketWidth / 2, 0],
          [picketWidth / 2, 0],
          [picketWidth / 2, picketHeight * 0.88],
          [0, picketHeight],
          [-picketWidth / 2, picketHeight * 0.88],
        ];
        const picket = extrude(section, { depth: 0.022 });
        picket.rotateY(range(rng, -0.06, 0.06));
        picket.translate(at, 0, range(rng, -0.012, 0.012));
        builder.add(picket, undefined, chance(rng, 0.16) ? 'wood-dark' : 'plank');
        spent += PICKET_TRIANGLES;
      }
    }
    // Two rails behind the pickets, spliced at the posts.
    if (infillShare - spent > 2 * spans.length * BOX_TRIANGLES) {
      for (const [from, to] of spans) {
        for (const at of [height * 0.18, height * 0.78]) {
          const rail = box(to - from, height * 0.075, 0.035);
          rail.translate((from + to) / 2, at, -0.03);
          builder.add(rail, undefined, 'wood-weathered');
          spent += BOX_TRIANGLES;
        }
      }
    }
  }

  if (style === 'rail') {
    // Rails are poles, not boards: the whole economy of a field fence is that it
    // is split rather than sawn, and a pole is a strut between two posts.
    const rails = height > 1.4 ? 3 : 2;
    const bays: [number, number][] = [];
    for (const [from, to] of spans) {
      const inSpan = postAt.filter((at) => at >= from - 1e-6 && at <= to + 1e-6);
      for (let index = 0; index + 1 < inSpan.length; index += 1) bays.push([inSpan[index]!, inSpan[index + 1]!]);
    }
    const wanted = bays.length * rails * (1 - ruin * 0.4);
    const plan = planChildren(Math.max(1, Math.round(wanted)), cylinderCost(5, false), infillShare);
    let laid = 0;
    for (const [from, to] of bays) {
      for (let rail = 0; rail < rails; rail += 1) {
        if (laid >= plan.modeled) break;
        laid += 1;
        const at = height * (0.22 + (0.62 * rail) / Math.max(1, rails - 1));
        const sag = range(rng, 0.01, 0.05);
        const pole = strut([from, at + sag, range(rng, -0.02, 0.02)], [to, at, range(rng, -0.02, 0.02)], postRadius * 0.62, 5);
        builder.add(pole, undefined, rail === rails - 1 ? 'wood-dark' : 'log');
        spent += cylinderCost(5, false);
      }
    }
    // Wiring, where a rail fence has been patched rather than rebuilt.
    if (ruin > 0.25 && infillShare - spent > 60) {
      const wire = strut([spans[0]![0], height * 0.5, 0.05], [spans[spans.length - 1]![1], height * 0.46, 0.05], 0.006, 4);
      builder.add(wire, undefined, 'iron-rusted');
      spent += cylinderCost(4, false);
    }
  }

  if (style === 'wattle') {
    // Woven hazel between the posts: the cheap medieval boundary, and the only
    // one of the four that is a panel rather than a frame.
    const bays: [number, number][] = [];
    for (const [from, to] of spans) {
      const inSpan = postAt.filter((at) => at >= from - 1e-6 && at <= to + 1e-6);
      for (let index = 0; index + 1 < inSpan.length; index += 1) bays.push([inSpan[index]!, inSpan[index + 1]!]);
    }
    const plan = planChildren(Math.max(1, Math.round(bays.length * (1 - ruin * 0.4))), WATTLE_PER_METRE * spacing * 0.5, infillShare);
    for (let index = 0; index < Math.min(plan.modeled, bays.length); index += 1) {
      const [from, to] = bays[index]!;
      // `wattleFence` drives its stakes 0.15 m into the ground and leaves them
      // standing 0.2 m proud of the weave, so the panel is asked for the height
      // that leaves the whole fence at the height a caller specified, and it is
      // seated on its own lowest point rather than sunk: a component's bounding
      // box is what the world is built against, and nothing may be under it.
      const panel = wattleFence({
        length: to - from,
        height: Math.max(0.3, height * range(rng, 0.96, 1.0) - 0.35),
        seed: seed + index * 29,
      });
      placeOn(panel, (from + to) / 2, 0, 0);
      builder.add(panel, undefined, 'wattle');
      spent += (to - from) * WATTLE_PER_METRE;
    }
  }

  if (ruin > 0.1 && budget - spent > 120) {
    // What fell off a fence lies under it: a couple of pickets or a rail, in the
    // grass on the side it fell to.
    const debris = planChildren(Math.max(1, Math.round(ruin * 3)), PICKET_TRIANGLES, Math.min(budget - spent, 200));
    for (let index = 0; index < debris.modeled; index += 1) {
      const piece = box(height * range(rng, 0.5, 0.86), 0.05, 0.024);
      piece.rotateZ(range(rng, -0.1, 0.1));
      piece.rotateY(range(rng, -0.5, 0.5));
      piece.translate(range(rng, -half * 0.7, half * 0.7), 0.03, range(rng, 0.16, 0.5) * (chance(rng, 0.5) ? 1 : -1));
      builder.add(piece, undefined, 'wood-weathered');
      spent += BOX_TRIANGLES;
    }
  }
  seatOnGround(builder, false);
  return builder;
}

/* ------------------------------------------------------------------- gate */

export type GateStyle = 'plank' | 'batten' | 'wattle' | 'iron';

export interface GateOptions {
  /** Width of the opening, along X. */
  width?: number;
  /** Height of a leaf, from the ground to its head. */
  height?: number;
  style?: GateStyle;
  /** One leaf hangs from one post; two meet in the middle. */
  leaves?: 1 | 2;
  /** How far the leaves are swung: 0 shut, 1 open square to the fence. */
  open?: number;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Strap hinges and studs in iron. */
  iron?: boolean;
}

/**
 * A gate: two posts, a leaf or two, and the iron that hangs them.
 *
 * A leaf sags at its free edge, because it hangs from hinges on one side and has
 * been doing so for years, and the sag is the reason a gate reads as a gate
 * rather than as a fence panel that happens to be movable. `open` swings each
 * leaf about its own hinge line — the geometry is turned about the post, not
 * about the world origin, so a gate opened ninety degrees still meets its post.
 *
 * An open gate is not centred on its bounding box and does not pretend to be: it
 * reaches out along Z on whichever side it was hung. The *opening* is centred on
 * the origin in every case, which is what a caller places.
 */
export function gateWood(options: GateOptions): MeshBuilder {
  const seed = options.seed ?? 167;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = Math.max(0.7, options.width ?? 3);
  const height = Math.max(0.6, options.height ?? 1.6);
  const style = options.style ?? 'plank';
  const leaves = options.leaves === 1 ? 1 : 2;
  const open = Math.max(0, Math.min(1, options.open ?? 0));
  const budget = componentBudget(options.quality, options.budget);
  const iron = options.iron !== false;
  let spent = 0;

  const postRadius = 0.07 + width * 0.012;
  const postHeight = height * 1.2;
  const postSides = budget > 1200 ? 6 : 5;
  for (const side of [-1, 1] as const) {
    const upright = post({ height: postHeight, radius: postRadius, sides: postSides, cap: 'pointed', seed: seed + side * 5 });
    const tilt = side * range(rng, 0.006, 0.02);
    upright.rotateZ(tilt);
    upright.translate(side * (width / 2 + postRadius * 0.9), leanLift(postRadius, tilt), 0);
    builder.add(upright, undefined, 'wood-dark');
    spent += postCost(postSides);
    if (budget - spent > 200) {
      // A stone at the foot of a gate post: the post is the part that rots, and
      // this is what keeps it out of the mud.
      const footing = prism({ sides: 6, radius: postRadius * 2.1, height: postRadius * 1.7, topScale: 0.72 });
      fracture(footing, { amplitude: postRadius * 0.24, frequency: 8, octaves: 2, seed: seed + side * 31 });
      footing.translate(side * (width / 2 + postRadius * 0.9), 0, 0);
      builder.add(footing, undefined, 'stone-rough');
      spent += prismCost(6);
    }
  }

  const leafWidth = width / leaves - 0.03;
  const clearance = 0.04;
  for (let index = 0; index < leaves; index += 1) {
    const leaf = new MeshBuilder();
    const boards = Math.max(3, Math.min(7, Math.round(leafWidth / 0.19)));
    if (style === 'wattle') {
      const frame = 0.07;
      // The rails run between the stiles rather than across them: two members
      // that overlap at a corner lay their outer faces in one plane, and two
      // faces in one plane winding the same way are a doubled skin. Butted end to
      // end, the joint is a pair of faces with opposite normals, which is a joint.
      for (const [w, h, x, y] of [
        [leafWidth - frame * 2, frame, 0, frame / 2],
        [leafWidth - frame * 2, frame, 0, height - frame / 2],
        [frame, height, -leafWidth / 2 + frame / 2, height / 2],
        [frame, height, leafWidth / 2 - frame / 2, height / 2],
      ] as [number, number, number, number][]) {
        const member = box(w, h, 0.05);
        member.translate(x, y, 0);
        leaf.add(member, undefined, 'wood-dark');
        spent += BOX_TRIANGLES;
      }
      // Asked short by the 0.35 m its stakes add, seated inside the frame rather
      // than sunk under it, and set a few millimetres clear of the frame on every
      // axis: a weave that is exactly flush with the members it is nailed to lays
      // its faces in the same planes as theirs, and two faces in one plane winding
      // the same way are a doubled skin. Proud of the frame is also how a hurdle
      // is made — the weaving is nailed to the inside face of the timbers.
      const panel = wattleFence({
        length: leafWidth - frame * 2 - 0.02,
        height: Math.max(0.24, height - frame * 2 - 0.37),
        seed: seed + index * 17,
      });
      placeOn(panel, 0, frame + 0.01 + (height - frame * 2 - 0.02 - panel.bounds().size[1]) / 2, 0.008);
      leaf.add(panel, undefined, 'wattle');
      spent += (leafWidth - frame * 2) * WATTLE_PER_METRE;
    } else if (style === 'iron') {
      // Bars with points on them: a gate that is meant to be looked through and
      // not climbed, which is a statement about what is behind it.
      const bars = planChildren(Math.max(4, Math.round(leafWidth / 0.11)), BOX_TRIANGLES, Math.max(0, budget - spent) / Math.max(1, leaves));
      for (let bar = 0; bar < bars.modeled; bar += 1) {
        const at = -leafWidth / 2 + (leafWidth * (bar + 0.5)) / bars.modeled;
        const shaft = box(0.028, height * 0.94, 0.028);
        shaft.translate(at, height * 0.47, 0);
        leaf.add(shaft, undefined, 'iron-wrought');
        spent += BOX_TRIANGLES;
        if (bars.each > BOX_TRIANGLES + STUD_TRIANGLES) {
          const point = spike({ height: 0.09, radius: 0.022, sides: 4 });
          point.translate(at, height * 0.94, 0);
          leaf.add(point, undefined, 'iron-wrought');
          spent += 16;
        }
      }
      for (const at of [height * 0.14, height * 0.86]) {
        const rail = box(leafWidth, 0.055, 0.04);
        rail.translate(0, at, 0);
        leaf.add(rail, undefined, 'iron-rusted');
        spent += BOX_TRIANGLES;
      }
    } else {
      // Boards are the leaf, so they are planned against the leaf's share: a
      // poor gate gets fewer and wider boards, which is also what a poor gate is.
      const leafShare = Math.max(BEVELLED_BOX_TRIANGLES * 3, (budget - spent) / Math.max(1, leaves));
      const boardPlan = planChildren(boards, BEVELLED_BOX_TRIANGLES, leafShare * 0.62);
      const boardsPart = planks({
        width: leafWidth,
        height,
        thickness: style === 'batten' ? 0.04 : 0.05,
        count: boardPlan.modeled,
        horizontal: style === 'batten',
        seed: seed + index * 19,
      });
      boardsPart.translate(0, height / 2, 0);
      leaf.add(boardsPart, undefined, 'plank');
      spent += boardPlan.modeled * BEVELLED_BOX_TRIANGLES;
      if (style === 'batten') {
        // A batten gate is boarded the other way and held by battens, so the
        // boards run across and the battens run up.
        const battens = planChildren(3, BOX_TRIANGLES, Math.max(BOX_TRIANGLES, leafShare * 0.3));
        for (let batten = 0; batten < battens.modeled; batten += 1) {
          const at = -leafWidth / 2 + (leafWidth * (batten + 0.5)) / battens.modeled;
          const uprightMember = box(0.075, height * 0.94, 0.035);
          uprightMember.translate(at, height / 2, 0.045);
          leaf.add(uprightMember, undefined, 'wood-dark');
          spent += BOX_TRIANGLES;
        }
      } else {
        // Two battens and a brace between them: the Z that stops a boarded leaf
        // from parallelogramming on its own hinges.
        const braceShare = Math.max(0, leafShare * 0.3);
        for (const at of [height * 0.16, height * 0.84]) {
          const batten = box(leafWidth * 0.94, 0.085, 0.032);
          batten.translate(0, at, 0.042);
          leaf.add(batten, undefined, 'wood-dark');
          spent += BOX_TRIANGLES;
        }
        if (braceShare > BEVELLED_BOX_TRIANGLES + 20) {
          const brace = strut(
            [-leafWidth * 0.44, height * 0.17, 0.045],
            [leafWidth * 0.44, height * 0.83, 0.045],
            0.032,
            4,
          );
          leaf.add(brace, undefined, 'wood-dark');
          spent += cylinderCost(4, false);
        }
      }
      if (iron && budget - spent > STUD_TRIANGLES * 4 + 60) {
        // Strap hinges and studs: the iron is what a gate is worth, and it is
        // bolted through the battens, not through the boards.
        for (const at of [height * 0.16, height * 0.84]) {
          const strap = box(leafWidth * 0.78, 0.05, 0.012);
          strap.translate(index === 0 ? leafWidth * 0.06 : -leafWidth * 0.06, at, 0.062);
          leaf.add(strap, undefined, 'iron-wrought');
          spent += BOX_TRIANGLES;
        }
        const studs = planChildren(6, STUD_TRIANGLES, Math.max(STUD_TRIANGLES, budget - spent));
        for (let stud = 0; stud < studs.modeled; stud += 1) {
          const head = cylinder(0.017, 0.021, 0.016, { radialSegments: 5 });
          head.rotateX(Math.PI / 2);
          head.translate(
            -leafWidth * 0.36 + (leafWidth * 0.72 * stud) / Math.max(1, studs.modeled - 1),
            stud % 2 === 0 ? height * 0.16 : height * 0.84,
            0.07,
          );
          leaf.add(head, undefined, 'riveted');
          spent += STUD_TRIANGLES;
        }
      }
    }

    // Hang it: hinge at the post, sag at the free edge, then swing.
    //
    // The leaf is built centred, so the first move puts its hinge edge on the
    // origin and the rest of it reaching toward the middle of the opening — which
    // is away from the post it hangs on, not toward it. The swing and the sag then
    // happen about the hinge, and only the last move carries the leaf to the post
    // it hangs from. Getting the first move the other way round leaves both leaves
    // hanging outside their own gate with the middle of the opening empty, which
    // still looks like a gate from the front and still measures the right width.
    const hingeSide = leaves === 1 ? -1 : index === 0 ? -1 : 1;
    leaf.translate(-hingeSide * (leafWidth / 2), 0, 0);
    leaf.rotateZ(hingeSide * range(rng, 0.012, 0.034));
    if (open > 0) leaf.rotateY(-hingeSide * open * Math.PI * 0.46);
    leaf.translate(hingeSide * (width / 2 - clearance), clearance + height * 0.02, 0);
    builder.add(leaf);
  }

  if (leaves === 2 && open < 0.02 && budget - spent > 100) {
    // A latch bar across the meeting stiles, and the hook it drops onto.
    const bar = box(width * 0.34, 0.06, 0.05, { bevel: 0.008, bevelSegments: 1 });
    bar.rotateY(range(rng, -0.05, 0.05));
    bar.translate(0, height * 0.52, 0.075);
    builder.add(bar, undefined, 'wood-dark');
    spent += BEVELLED_BOX_TRIANGLES;
    const hook = cylinder(0.012, 0.012, 0.12, { radialSegments: 4 });
    hook.rotateX(Math.PI / 2);
    hook.translate(width * 0.15, height * 0.5, 0.06);
    builder.add(hook, undefined, 'iron-wrought');
    spent += cylinderCost(4);
  }
  seatOnGround(builder, false);
  return builder;
}

/* ------------------------------------------------------------ street lamp */

export type LampStyle = 'post' | 'wall';

export interface StreetLampOptions {
  /** Height of the whole lamp for a post, or the rise of the bracket for a wall lamp. */
  height?: number;
  /** Lanterns on one post: one at a door, three at a square. */
  arms?: number;
  style?: LampStyle;
  /** A flame in the glass and the warm surface on it. */
  lit?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Cast iron, a stone plinth, or painted timber. */
  finish?: 'iron' | 'stone' | 'timber';
}

/** Triangles a lantern costs with no flame in it, which is the least a lamp can be. */
const LANTERN_FLOOR = 4 * BOX_TRIANGLES + 2 * BEVELLED_BOX_TRIANGLES + 8 + prismCost(4, true) + 16;

/**
 * A street lamp: a column, a bracket, and a lantern with a flame in it.
 *
 * The lantern is the asset and the flame is what makes it a lamp rather than a
 * box on a pole, so both are paid for before the column is fluted and before the
 * plinth gets a moulding on it. `arms` buys more lanterns before it buys a
 * richer one, because a square lit from three sides is lit and a square lit from
 * one is not.
 *
 * A `wall` lamp is the same machine without the column: a plate bolted to a wall,
 * a bracket out from it, and the lantern at the end. Its plate lies on the −Z
 * face of its bounds, which is the face a caller puts against the wall.
 */
export function streetLamp(options: StreetLampOptions): MeshBuilder {
  const seed = options.seed ?? 181;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const style = options.style ?? 'post';
  const height = Math.max(0.5, options.height ?? (style === 'post' ? 4.2 : 0.72));
  const lit = options.lit !== false;
  const finish = options.finish ?? 'iron';
  const budget = componentBudget(options.quality, options.budget);
  const metal = finish === 'timber' ? 'wood-painted' : finish === 'stone' ? 'stone-dressed' : 'iron-wrought';
  const lanternEach = LANTERN_FLOOR + (lit ? FLAME_TRIANGLES * 2 : 0);
  const wanted = Math.max(1, Math.min(3, Math.round(options.arms ?? (style === 'wall' ? 1 : 1))));
  const lanterns = planChildren(wanted, LANTERN_FLOOR, Math.min(budget * 0.62, budget));
  let spent = lanterns.modeled * lanternEach;
  const structureShare = Math.max(0, budget - spent);

  const bracketLength = style === 'wall' ? height * 0.62 : Math.min(0.42, height * 0.12);
  const lanternHeight = Math.min(0.42, height * (style === 'wall' ? 0.42 : 0.1));

  for (let index = 0; index < lanterns.modeled; index += 1) {
    // Evenly spaced, and then not quite: a lamp with three arms was assembled by
    // somebody, and the arms were bolted on in the order they came out of a crate.
    const bearing = lanterns.modeled === 1
      ? range(rng, -0.2, 0.2)
      : (index / lanterns.modeled) * Math.PI * 2 + range(rng, -0.09, 0.09);
    const at: Vec3 = style === 'wall'
      ? [0, height - lanternHeight * 0.6, bracketLength]
      : [Math.sin(bearing) * bracketLength, height - lanternHeight * 0.62, Math.cos(bearing) * bracketLength];
    const lantern = lanternUnit(lanternHeight, lit, seed + index * 23, Math.max(90, lanternEach));
    lantern.translate(at[0], at[1], at[2]);
    builder.add(lantern);
    // The bracket: out from the column and braced back to it, because a lantern
    // is a weight at the end of a lever and every lamp has an answer to that.
    const root: Vec3 = style === 'wall' ? [0, at[1] + lanternHeight * 0.5, 0.02] : [0, at[1] + lanternHeight * 0.5, 0];
    builder.add(strut(root, at, 0.022, 5), undefined, metal);
    spent += cylinderCost(5, false);
    const braceRoot: Vec3 = style === 'wall'
      ? [0, at[1] - lanternHeight * 0.9, 0.02]
      : [Math.sin(bearing) * bracketLength * 0.16, at[1] - lanternHeight * 1.1, Math.cos(bearing) * bracketLength * 0.16];
    builder.add(strut(braceRoot, at, 0.016, 4), undefined, metal);
    spent += cylinderCost(4, false);
  }

  if (style === 'wall') {
    const plate = box(height * 0.42, height * 0.9, 0.05, { bevel: 0.01, bevelSegments: 1 });
    plate.translate(0, height * 0.5, -0.025);
    builder.add(plate, undefined, metal);
    spent += BEVELLED_BOX_TRIANGLES;
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
      const bolt = cylinder(0.012, 0.012, 0.03, { radialSegments: 4 });
      bolt.rotateX(Math.PI / 2);
      bolt.translate(dx * height * 0.15, height * (0.5 + dy * 0.32), 0.01);
      builder.add(bolt, undefined, 'riveted');
      spent += cylinderCost(4);
    }
    fitHeight(builder, height, 1.4, false);
    return builder;
  }

  const shaftSides = structureShare > 900 ? 10 : structureShare > 400 ? 8 : 6;
  const plinthHeight = Math.min(height * 0.14, 0.5);
  const shaftHeight = height - plinthHeight - lanternHeight * 0.6;
  // Fluting needs height rows to show, and rows cost: a plain post is sixteen
  // triangles and a fluted one over three rows is forty-eight.
  const fluted = structureShare > cylinderCost(shaftSides, false, 3) + 500;
  const shaft = cylinder(
    height * 0.016,
    height * 0.028,
    shaftHeight,
    { radialSegments: shaftSides, heightSegments: fluted ? 3 : 1, caps: false, ripple: fluted ? 0.06 : 0 },
  );
  shaft.translate(0, plinthHeight + shaftHeight / 2, 0);
  builder.add(shaft, undefined, metal);
  spent += cylinderCost(shaftSides, false, fluted ? 3 : 1);

  if (finish === 'stone' || structureShare > 600) {
    // A plinth and a moulding: the part of a lamp post that survives being hit
    // by a cart, which is why it is the part made of stone.
    const plinth = prism({ sides: 4, radius: height * 0.058, height: plinthHeight * 0.72, topScale: 0.86 });
    plinth.rotateY(Math.PI / 4);
    plinth.translate(0, plinthHeight * 0.36, 0);
    builder.add(plinth, undefined, finish === 'stone' ? 'stone-dressed' : 'iron-rusted');
    spent += prismCost(4);
    const moulding = torus(height * 0.042, height * 0.011, { radialSegments: 4, tubularSegments: shaftSides });
    moulding.rotateX(Math.PI / 2);
    moulding.translate(0, plinthHeight * 0.76, 0);
    builder.add(moulding, undefined, metal);
    spent += torusCost(4, shaftSides);
  } else {
    const foot = cylinder(height * 0.05, height * 0.062, plinthHeight, { radialSegments: shaftSides });
    foot.translate(0, plinthHeight / 2, 0);
    builder.add(foot, undefined, metal);
    spent += cylinderCost(shaftSides);
  }

  // The collar the brackets come out of, and a finial on top.
  const collar = torus(height * 0.03, height * 0.012, { radialSegments: 4, tubularSegments: shaftSides });
  collar.rotateX(Math.PI / 2);
  collar.translate(0, plinthHeight + shaftHeight, 0);
  builder.add(collar, undefined, metal);
  spent += torusCost(4, shaftSides);
  if (structureShare > 260) {
    const finial = spike({ height: height * 0.05, radius: height * 0.014, sides: 4 });
    finial.translate(0, plinthHeight + shaftHeight + height * 0.02, 0);
    builder.add(finial, undefined, metal);
    spent += 16;
  }
  // Seated but not centred: the column is on the origin and the lanterns hang off
  // it, so a one-armed lamp is not symmetric about Z and does not try to be. The
  // column is what a caller places.
  fitHeight(builder, height, 1.25, false);
  return builder;
}

/**
 * One lantern: a frame, four panes, a pyramidal cap and a flame inside.
 *
 * The frame is built around the glass rather than the glass being set into a
 * box, because a lantern is mostly hole — and the hole is what a lit lamp shows
 * at night, from the side that faces away from you as much as the side that
 * faces you.
 */
function lanternUnit(height: number, lit: boolean, seed: number, allowance: number): MeshBuilder {
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = height * range(rng, 0.6, 0.7);
  const glassHeight = height * 0.6;
  const base = box(width * 1.16, height * 0.1, width * 1.16, { bevel: 0.008, bevelSegments: 1 });
  base.translate(0, height * 0.05, 0);
  builder.add(base, undefined, 'iron-wrought');
  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
    const bar = box(width * 0.11, glassHeight, width * 0.11);
    bar.translate(Math.sin(angle) * width * 0.52, height * 0.1 + glassHeight / 2, Math.cos(angle) * width * 0.52);
    builder.add(bar, undefined, 'iron-wrought');
    // A pane is a plane: two triangles of transparent surface, which is the same
    // read as a solid sheet of glass for a twentieth of the cost.
    const pane = plane(width * 0.94, glassHeight, { orientation: 'xy' });
    pane.rotateY(angle + Math.PI / 2);
    pane.translate(Math.sin(angle + Math.PI / 4) * width * 0.5, height * 0.1 + glassHeight / 2, Math.cos(angle + Math.PI / 4) * width * 0.5);
    builder.add(pane, undefined, lit ? 'glass-warm' : 'glass');
  }
  const crown = box(width * 1.2, height * 0.07, width * 1.2, { bevel: 0.008, bevelSegments: 1 });
  crown.translate(0, height * 0.1 + glassHeight + height * 0.03, 0);
  builder.add(crown, undefined, 'iron-wrought');
  const cap = prism({ sides: 4, radius: width * 0.86, height: height * 0.24, topScale: 0 });
  cap.rotateY(Math.PI / 4);
  cap.translate(0, height * 0.1 + glassHeight + height * 0.06, 0);
  builder.add(cap, undefined, 'iron-rusted');
  if (lit && allowance > LANTERN_FLOOR + FLAME_TRIANGLES) {
    const fire = flame({ height: glassHeight * 0.72, radius: width * 0.22, layers: 2 });
    fire.translate(0, height * 0.12, 0);
    builder.add(fire, undefined, 'glass-warm');
  }
  return builder;
}

/* ---------------------------------------------------------------- brazier */

export type BrazierStyle = 'tripod' | 'pedestal' | 'hanging';

export interface BrazierOptions {
  /** Radius of the bowl, in metres. */
  radius?: number;
  /** Height of the rim above ground. */
  height?: number;
  style?: BrazierStyle;
  /** Coals and a flame on it. */
  lit?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Cast bronze, hammered iron, or iron gone green and rusty outside. */
  metal?: 'bronze' | 'iron' | 'weathered';
}

/**
 * A brazier: a bowl of fire at a height somebody can stand next to.
 *
 * The bowl is the asset and it is turned as one piece with its rim rolled over,
 * because a rolled rim is what keeps a coal from landing on the person beside it.
 * Under the bowl there are three legs or a pedestal, and which one is a matter of
 * where it lives: three legs stand on uneven ground, which is most ground, and a
 * pedestal belongs to a courtyard where somebody swept.
 *
 * A hanging brazier has no legs at all — three stays up to a ring, for a hook in
 * a beam or a bracket on a wall — and it is the one style that is not seated on
 * the ground, because a thing that hangs hangs: its ring is at the height it was
 * asked for and its bowl is below that, in the air.
 *
 * `height` is the rim for a standing brazier and the ring for a hanging one. A
 * lit brazier stands taller than either by the flame on it, which is not part of
 * the height anybody specifies: you do not hang a brazier so that its fire is at
 * shoulder height, you hang it so that its *rim* is.
 */
export function brazier(options: BrazierOptions): MeshBuilder {
  const seed = options.seed ?? 197;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.12, options.radius ?? 0.34);
  const height = Math.max(radius * 1.4, options.height ?? radius * 2.8);
  const style = options.style ?? (chance(rng, 0.62) ? 'tripod' : 'pedestal');
  const lit = options.lit !== false;
  const budget = componentBudget(options.quality, options.budget);
  const metal = options.metal ?? (style === 'pedestal' ? 'bronze' : 'iron-wrought');
  const surface = metal === 'bronze' ? 'bronze' : metal === 'weathered' ? 'copper-patina' : 'iron-wrought';
  const segments = Math.max(8, Math.min(16, Math.round(budget / 110)));
  const bowlHeight = radius * 0.72;
  // A hanging brazier is specified by the height of its ring, a standing one by
  // the height of its rim, and both are built to it rather than normalized to it
  // afterwards: the flame stands above the rim, and a component that normalizes
  // after lighting shrinks its own bowl to pay for the fire.
  const ringY = style === 'hanging' ? height : height + radius * 0.9;
  const rimY = style === 'hanging' ? height - radius * 0.9 - bowlHeight : height - bowlHeight;
  let spent = 0;

  // The bowl: out to a belly, up to a rim rolled outward, and back down inside to
  // a floor. One turn, so the rim has no seam and the inside is visible.
  const profile: Vec2[] = [
    [radius * 0.3, 0],
    [radius * 0.86, bowlHeight * 0.42],
    [radius, bowlHeight * 0.86],
    [radius * 1.04, bowlHeight],
    [radius * 0.96, bowlHeight * 0.98],
    [radius * 0.72, bowlHeight * 0.6],
    [radius * 0.34, bowlHeight * 0.3],
    [0, bowlHeight * 0.26],
  ];
  const bowl = lathe(profile, { segments, caps: false });
  bowl.flatShade();
  bowl.translate(0, rimY, 0);
  builder.add(bowl, undefined, surface);
  spent += latheCost(profile.length, segments);

  if (lit && budget - spent > 120) {
    // Ash, then coals, then the flame above them: a fire is a bed with something
    // burning on it, and a flame floating in an empty bowl is a torch nobody lit.
    const ash = waterSheet(radius * 0.7, segments, rimY + bowlHeight * 0.3);
    builder.add(ash, undefined, 'soil');
    spent += latheCost(2, segments);
    const coals = planChildren(Math.max(3, Math.round(radius * 16)), prismCost(5, true), Math.min((budget - spent) * 0.3, 320));
    const spots = scatter(rng, coals.modeled, radius * 1.1, radius * 1.1, 0.8);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      const coal = prism({ sides: 5, radius: radius * range(rng, 0.1, 0.2), height: radius * range(rng, 0.14, 0.3), topScale: 0 });
      fracture(coal, { amplitude: radius * 0.05, frequency: 12, octaves: 2, seed: seed + index * 19 });
      placeOn(coal, spot[0] * 0.6, rimY + bowlHeight * 0.3, spot[1] * 0.6);
      builder.add(coal, undefined, chance(rng, 0.3) ? 'iron-rusted' : 'stone-rough');
      spent += prismCost(5, true);
    }
    const fire = flame({ height: radius * range(rng, 1.5, 2.1), radius: radius * 0.52, layers: budget > 1400 ? 3 : 2 });
    fire.translate(0, rimY + bowlHeight * 0.34, 0);
    builder.add(fire, undefined, 'glass-warm');
    spent += FLAME_TRIANGLES * (budget > 1400 ? 3 : 2);
  }

  if (style === 'pedestal') {
    const columnProfile: Vec2[] = [
      [radius * 0.72, 0],
      [radius * 0.6, rimY * 0.06],
      [radius * 0.3, rimY * 0.12],
      [radius * 0.2, rimY * 0.78],
      [radius * 0.3, rimY * 0.92],
      [radius * 0.34, rimY],
    ];
    const column = lathe(columnProfile, { segments: Math.max(6, segments - 4), caps: false });
    column.flatShade();
    builder.add(column, undefined, surface);
    spent += latheCost(columnProfile.length, Math.max(6, segments - 4));
  } else if (style === 'hanging') {
    // Three stays up to a ring, and the ring is what the hook goes through.
    for (let index = 0; index < 3; index += 1) {
      const angle = (index / 3) * Math.PI * 2;
      builder.add(
        strut(
          [Math.sin(angle) * radius * 0.94, rimY + bowlHeight * 0.7, Math.cos(angle) * radius * 0.94],
          [0, ringY, 0],
          radius * 0.05,
          4,
        ),
        undefined,
        'chain',
      );
      spent += cylinderCost(4, false);
    }
    const ring = torus(radius * 0.22, radius * 0.035, { radialSegments: 4, tubularSegments: 8 });
    ring.rotateX(Math.PI / 2);
    ring.translate(0, ringY, 0);
    builder.add(ring, undefined, 'iron-wrought');
    spent += torusCost(4, 8);
  } else {
    const legs = 3;
    for (let index = 0; index < legs; index += 1) {
      const angle = (index / legs) * Math.PI * 2 + range(rng, -0.08, 0.08);
      const top: Vec3 = [Math.sin(angle) * radius * 0.5, rimY + bowlHeight * 0.16, Math.cos(angle) * radius * 0.5];
      const foot: Vec3 = [Math.sin(angle) * radius * 1.02, 0, Math.cos(angle) * radius * 1.02];
      // Splayed and curved: a leg is a straight member only in the sense that it
      // gets from the bowl to the ground, so it goes in two pieces with a knee.
      const knee: Vec3 = [
        Math.sin(angle) * radius * 0.94,
        rimY * range(rng, 0.42, 0.52),
        Math.cos(angle) * radius * 0.94,
      ];
      builder.add(strut(top, knee, radius * 0.075, 5), undefined, surface);
      builder.add(strut(knee, foot, radius * 0.06, 5), undefined, surface);
      spent += 2 * cylinderCost(5, false);
      const pad = prism({ sides: 5, radius: radius * 0.16, height: radius * 0.09, topScale: 0.7 });
      pad.translate(foot[0], 0, foot[2]);
      builder.add(pad, undefined, surface);
      spent += prismCost(5);
    }
  }
  if (style !== 'hanging') seatOnGround(builder, false);
  return builder;
}

/* --------------------------------------------------------------- campfire */

export type CampfireStyle = 'teepee' | 'log-cabin' | 'pit';

export interface CampfireOptions {
  /** Radius of the fire, in metres; the ring of stones stands just outside it. */
  radius?: number;
  style?: CampfireStyle;
  /** Coals, a flame and light on the stones around it. */
  lit?: boolean;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** A tripod and a pot over the fire: this one is being cooked on. */
  cooking?: boolean;
  /**
   * A log or two to sit on, because a fire is a place people sit.
   *
   * Off by default: the seats more than double the footprint of the asset, and a
   * caller placing a fire in a courtyard wants the fire, not a camp around it.
   */
  seats?: boolean;
}

/**
 * A campfire: a ring that was cleared, stones around it, and wood stacked in it.
 *
 * The ring comes first, in every sense. A fire built on grass is a fire that
 * spreads, so the ground inside it is scraped bare and stoned around, and that
 * ring is what makes a pile of burning logs read as a camp rather than as a
 * wildfire. The stones are set on a jittered circle, each one sunk a little into
 * the ash, and they are the only part of the fire that survives it.
 *
 * The wood is stacked the way it burns: leaning together in a teepee so the flame
 * climbs the middle, or crossed in a crib so it burns down evenly, or laid flat in
 * a pit where the wind cannot get at it. A fire that is not one of these three is
 * a pile of sticks.
 */
export function campfire(options: CampfireOptions): MeshBuilder {
  const seed = options.seed ?? 211;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.2, options.radius ?? 0.55);
  const style = options.style ?? 'teepee';
  const lit = options.lit !== false;
  const budget = componentBudget(options.quality, options.budget);
  const cooking = options.cooking ?? false;
  let spent = 0;

  const stoneShare = Math.min(budget * 0.42, 620);
  const stones = planChildren(Math.max(5, Math.round(radius * 16)), prismCost(6), stoneShare);
  for (let index = 0; index < stones.modeled; index += 1) {
    const angle = (index / stones.modeled) * Math.PI * 2 + range(rng, -0.14, 0.14);
    const at = radius * range(rng, 0.94, 1.1);
    const stone = prism({
      sides: 6,
      radius: radius * range(rng, 0.16, 0.28),
      height: radius * range(rng, 0.16, 0.3),
      topScale: range(rng, 0.45, 0.85),
    });
    fracture(stone, { amplitude: radius * 0.05, frequency: 10, octaves: 2, seed: seed + index * 23 });
    // Sunk into the ash and tilted out, the way a stone settles when it is
    // kicked into a ring and then heated and cooled a hundred times.
    settle(stone, rng, [Math.sin(angle) * at, 0.005, Math.cos(angle) * at], radius * 0.1);
    stone.rotateZ(range(rng, -0.16, 0.16));
    builder.add(stone, undefined, chance(rng, 0.24) ? 'stone-rough' : 'cobble');
    spent += prismCost(6);
  }

  // Scraped bare, and ash on it.
  const bed = lathe(
    [
      [radius * 1.02, 0.002],
      [radius * 0.7, 0.035],
      [0, 0.05],
    ],
    { segments: Math.max(8, Math.min(14, stones.modeled)), },
  );
  builder.add(bed, undefined, 'soil');
  spent += latheCost(3, Math.max(8, Math.min(14, stones.modeled)));

  const logRadius = radius * 0.11;
  const woodShare = Math.max(0, budget - spent - (lit ? FLAME_TRIANGLES * 3 : 0) - (cooking ? 320 : 0));
  const logs = planChildren(style === 'log-cabin' ? 6 : 7, cylinderCost(6, false), woodShare);

  if (style === 'teepee') {
    // Leaning together so the flame climbs the middle and the wood feeds itself
    // down into the coals as it burns away.
    for (let index = 0; index < logs.modeled; index += 1) {
      const angle = (index / logs.modeled) * Math.PI * 2 + range(rng, -0.1, 0.1);
      const lean = range(rng, 0.42, 0.62);
      const topY = radius * range(rng, 1.5, 2.1);
      builder.add(
        strut(
          [Math.sin(angle) * radius * 0.82, 0.02, Math.cos(angle) * radius * 0.82],
          [Math.sin(angle) * radius * lean * 0.2, topY, Math.cos(angle) * radius * lean * 0.2],
          logRadius * range(rng, 0.8, 1.2),
          6,
        ),
        undefined,
        index % 3 === 0 ? 'wood-dark' : 'log',
      );
      spent += cylinderCost(6, false);
    }
  } else if (style === 'log-cabin') {
    // Crossed in a crib: two logs a course, each course turned ninety degrees,
    // which burns down evenly and leaves a bed of coals rather than a hole.
    let course = 0;
    for (let index = 0; index < logs.modeled; index += 1) {
      const along = course % 2 === 0;
      const level = 0.04 + logRadius * 2 * Math.floor(course / 2) + logRadius;
      const offset = index % 2 === 0 ? -1 : 1;
      const reach = radius * range(rng, 0.72, 0.92);
      const from: Vec3 = along ? [-reach, level, offset * logRadius] : [offset * logRadius, level, -reach];
      const to: Vec3 = along ? [reach, level, offset * logRadius] : [offset * logRadius, level, reach];
      builder.add(strut(from, to, logRadius * range(rng, 0.9, 1.15), 6), undefined, course % 3 === 0 ? 'wood-dark' : 'log');
      spent += cylinderCost(6, false);
      course += 1;
    }
  } else {
    // A pit: the wood lies flat in a shallow scrape with a lip of earth around
    // it, for a wind that would blow a teepee apart.
    for (let index = 0; index < logs.modeled; index += 1) {
      const angle = (index / logs.modeled) * Math.PI + range(rng, -0.2, 0.2);
      const at = radius * range(rng, 0, 0.34);
      const level = 0.05 + logRadius * (index % 3);
      builder.add(
        strut(
          [Math.sin(angle) * radius * 0.7 + Math.cos(angle) * at, level, Math.cos(angle) * radius * 0.7 - Math.sin(angle) * at],
          [-Math.sin(angle) * radius * 0.7 + Math.cos(angle) * at, level + range(rng, -0.01, 0.01), -Math.cos(angle) * radius * 0.7 - Math.sin(angle) * at],
          logRadius * range(rng, 0.9, 1.2),
          6,
        ),
        undefined,
        index % 2 === 0 ? 'log' : 'wood-dark',
      );
      spent += cylinderCost(6, false);
    }
  }

  if (lit && budget - spent > FLAME_TRIANGLES * 2) {
    const layers = budget > 1600 ? 3 : 2;
    const fire = flame({ height: radius * range(rng, 1.5, 2.3), radius: radius * 0.44, layers });
    fire.translate(0, 0.04 + (style === 'pit' ? 0 : radius * 0.16), 0);
    builder.add(fire, undefined, 'glass-warm');
    spent += FLAME_TRIANGLES * layers;
    // Charred ends: the parts of the logs that are in the fire are black, and the
    // parts that are not are still bark.
    for (let index = 0; index < Math.min(3, logs.modeled); index += 1) {
      const angle = (index / 3) * Math.PI * 2;
      const char = prism({ sides: 5, radius: logRadius * 1.2, height: logRadius * 1.6, topScale: 0.4 });
      char.rotateZ(range(rng, -0.4, 0.4));
      char.translate(Math.sin(angle) * radius * 0.2, 0.08, Math.cos(angle) * radius * 0.2);
      builder.add(char, undefined, 'wood-dark');
      spent += prismCost(5);
    }
  }

  if (cooking && budget - spent > 260) {
    // A tripod and a pot: three poles lashed together over the fire, a line down
    // from the lashing, and a pot hanging on it at the height the cook left it.
    const tripodHeight = radius * 3.4;
    for (let index = 0; index < 3; index += 1) {
      const angle = (index / 3) * Math.PI * 2 + range(rng, -0.1, 0.1);
      builder.add(
        strut(
          [Math.sin(angle) * radius * 1.7, 0, Math.cos(angle) * radius * 1.7],
          [Math.sin(angle) * radius * 0.12, tripodHeight, Math.cos(angle) * radius * 0.12],
          radius * 0.075,
          5,
        ),
        undefined,
        'log',
      );
      spent += cylinderCost(5, false);
    }
    const lashing = torus(radius * 0.16, radius * 0.03, { radialSegments: 4, tubularSegments: 8 });
    lashing.rotateX(Math.PI / 2);
    lashing.translate(0, tripodHeight * 0.94, 0);
    builder.add(lashing, undefined, 'rope');
    spent += torusCost(4, 8);
    const hang = tripodHeight * range(rng, 0.42, 0.56);
    builder.add(strut([0, tripodHeight * 0.94, 0], [0, hang, 0], radius * 0.02, 4), undefined, 'chain');
    spent += cylinderCost(4, false);
    const potProfile: Vec2[] = [
      [radius * 0.3, 0],
      [radius * 0.52, radius * 0.12],
      [radius * 0.56, radius * 0.42],
      [radius * 0.5, radius * 0.58],
      [radius * 0.44, radius * 0.6],
      [radius * 0.42, radius * 0.16],
      [0, radius * 0.1],
    ];
    const potPart = lathe(potProfile, { segments: 8, caps: false });
    potPart.flatShade();
    potPart.translate(0, hang - radius * 0.6, 0);
    builder.add(potPart, undefined, 'iron-rusted');
    spent += latheCost(potProfile.length, 8);
    const bail = torus(radius * 0.42, radius * 0.02, { radialSegments: 4, tubularSegments: 8, arc: Math.PI });
    bail.rotateZ(Math.PI);
    bail.translate(0, hang - radius * 0.02, 0);
    builder.add(bail, undefined, 'iron-wrought');
    spent += torusCost(4, 8);
  }

  if (options.seats === true && budget - spent > 220) {
    // A log or two to sit on, dragged to the warm side and left there.
    const seats = planChildren(chance(rng, 0.5) ? 1 : 2, cylinderCost(7, true), Math.min(budget - spent, 320));
    for (let index = 0; index < seats.modeled; index += 1) {
      const angle = range(rng, 0, Math.PI * 2);
      const at = radius * range(rng, 2.1, 2.7);
      const length = radius * range(rng, 2.4, 3.6);
      const logPart = cylinder(radius * 0.2, radius * 0.24, length, {
        radialSegments: 7,
        wobble: 0.05,
        wobbleSeed: seed + index * 37,
      });
      fracture(logPart, { amplitude: radius * 0.03, frequency: 4, octaves: 2, seed: seed + index * 41 });
      logPart.rotateZ(Math.PI / 2);
      logPart.rotateY(angle + Math.PI / 2 + range(rng, -0.3, 0.3));
      placeOn(logPart, Math.sin(angle) * at, 0, Math.cos(angle) * at);
      // The same two surfaces as the wood in the fire: a seat log is the same
      // log, and a campfire with a cook on it is already at ten materials.
      builder.add(logPart, undefined, index % 2 === 0 ? 'log' : 'wood-dark');
      spent += cylinderCost(7);
    }
  }
  seatOnGround(builder, false);
  return builder;
}

/* ------------------------------------------------------------------- tent */

export type TentStyle = 'ridge' | 'bell' | 'lean-to' | 'pavilion';
export type TentCloth = 'linen' | 'wool' | 'hide' | 'canvas';

export interface TentOptions {
  /** Across, along X. */
  width?: number;
  /** Along Z. */
  depth?: number;
  /** Ridge or crown height above ground. */
  height?: number;
  style?: TentStyle;
  /** `small` and `large` fill in width, depth and height together. */
  size?: 'small' | 'large';
  cloth?: TentCloth;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** The door flap tied back, so the inside is not a secret. */
  open?: boolean;
  /** Guy ropes and pegs: a tent that is not pegged down is a sail. */
  guys?: boolean;
}

/** The surface a cloth name is sold in. */
const TENT_CLOTH: Record<TentCloth, string> = {
  linen: 'fabric-linen',
  wool: 'wool',
  hide: 'hide',
  canvas: 'fabric',
};

/**
 * A tent: a frame, a sheet over it, and ropes holding the sheet down.
 *
 * Cloth is one plane thick, so a tent is built from single displaced sheets hung
 * on a frame — which is also how a tent is built. The sheets sag between their
 * poles and pull taut toward their pegs, and that sag is the whole read: a tent
 * whose roof is a flat plane is a box with a cloth texture on it.
 *
 * The door is a hole, not a painted rectangle. A ridge tent's end wall is built
 * as two panels either side of the opening and a triangle above it, so an open
 * flap shows the inside of the far wall rather than the back of the door, and a
 * bell tent's wall is turned through an arc that stops short of its own doorway.
 */
export function tent(options: TentOptions): MeshBuilder {
  const seed = options.seed ?? 223;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const large = options.size === 'large';
  const style = options.style ?? (large ? 'pavilion' : 'ridge');
  const width = Math.max(0.9, options.width ?? (large ? 5 : 2.6));
  const depth = Math.max(0.9, options.depth ?? (large ? 5 : 2.6));
  const height = Math.max(0.8, options.height ?? (large ? 3 : style === 'bell' ? 2.4 : 1.8));
  const fabric = TENT_CLOTH[options.cloth ?? (style === 'pavilion' ? 'canvas' : 'linen')];
  const budget = componentBudget(options.quality, options.budget);
  const open = options.open ?? false;
  const guys = options.guys !== false;
  const poleRadius = Math.max(0.03, Math.min(0.07, width * 0.022));
  let spent = 0;

  const poleShare = Math.min(budget * 0.34, 900);
  const sheetShare = Math.min(budget * 0.3, 900);

  if (style === 'bell' || style === 'pavilion') {
    const radius = Math.max(width, depth) / 2;
    const wallHeight = style === 'pavilion' ? height * 0.42 : height * 0.36;
    // A pavilion is specified to its peak, and its peak carries a finial and a
    // pennant, so the roof is built short of the peak by the crown and the crown
    // is spent on what stands above it. Built the other way round, `fitHeight`
    // has to shrink the whole pavilion to pay for a flag, and the walls — the
    // part a caller actually measures — come out low.
    const crown = style === 'pavilion' ? Math.min(height * 0.12, 0.42) : 0;
    const peak = height - crown;
    const roofHeight = peak - wallHeight;
    const doorAngle = Math.PI * 0.26;
    const segments = Math.max(8, Math.min(20, Math.round(sheetShare / 22)));
    // The wall is turned through an arc that stops short of the doorway, so the
    // door is a gap in the wall and not a flap drawn over a solid one.
    //
    // `cylinder` sweeps its arc from atan2(z, x) = 0, and `rotateY(a)` turns that
    // angle down by `a`, so the gap — which the sweep leaves between the end of
    // the arc and zero — is brought round to face +Z by 3π/2 less half its width.
    const wall = cylinder(radius, radius * 1.02, wallHeight, {
      radialSegments: segments,
      caps: false,
      arc: Math.PI * 2 - doorAngle,
      wobble: style === 'pavilion' ? 0 : 0.012,
      wobbleSeed: seed,
    });
    wall.rotateY(Math.PI * 1.5 - doorAngle / 2);
    wall.translate(0, wallHeight / 2, 0);
    builder.add(wall, undefined, fabric);
    spent += cylinderCost(segments, false);

    if (style === 'pavilion') {
      // A pavilion's wall is paneled and scalloped at the hem, and the panels are
      // separate sheets because that is how it is sewn and how it hangs.
      const panels = planChildren(Math.max(6, segments), clothCost(1, 3), Math.max(clothCost(1, 3), sheetShare * 0.5));
      for (let index = 0; index < panels.modeled; index += 1) {
        const angle = doorAngle / 2 + Math.PI / 2 + (index / panels.modeled) * (Math.PI * 2 - doorAngle);
        const panelWidth = (Math.PI * 2 * radius * (1 - doorAngle / (Math.PI * 2))) / panels.modeled;
        const panel = cloth(panelWidth * 1.04, wallHeight, 1, 3, (u, v) => -0.03 * Math.sin(u * Math.PI) * (1 - v * 0.4));
        panel.rotateX(Math.PI / 2);
        panel.rotateY(angle);
        panel.translate(Math.sin(angle) * radius * 1.01, wallHeight / 2, Math.cos(angle) * radius * 1.01);
        builder.add(panel, undefined, index % 2 === 0 ? fabric : 'fabric-blue');
        spent += clothCost(1, 3);
      }
    }

    // The roof: a cone of cloth on a centre pole, pulled down to the wall and
    // out past it, because the hem is where the water leaves.
    const roofSides = Math.max(8, Math.min(18, segments));
    const roof = prism({ sides: roofSides, radius: radius * 1.06, height: roofHeight, topScale: 0 });
    roof.rotateY(Math.PI / roofSides);
    roof.translate(0, wallHeight, 0);
    builder.add(roof, undefined, fabric);
    spent += prismCost(roofSides, true);

    const pole = post({ height: peak, radius: poleRadius * 1.3, sides: 6, cap: 'pointed', seed });
    pole.translate(0, 0, 0);
    builder.add(pole, undefined, 'log');
    spent += postCost(6);

    // The doorway flap: hung from the head of the gap, because that is where the
    // lacing is, and thrown outward when the door is open so it stands over the
    // doorway rather than across it.
    const flapWidth = radius * doorAngle * 1.05;
    const flap = cloth(flapWidth, wallHeight * 0.96, 3, 3, (u, v) => -0.05 * Math.sin(u * Math.PI) * (0.4 + v * 0.6));
    flap.rotateX(Math.PI / 2);
    flap.translate(0, -wallHeight * 0.48, 0);
    if (open) flap.rotateX(-1.35);
    flap.translate(0, wallHeight * 0.96, radius * 1.02);
    builder.add(flap, undefined, fabric);
    spent += clothCost(3, 3);

    if (style === 'pavilion' && budget - spent > 240) {
      // A finial and a pennant at the peak: the part of a pavilion that says
      // whose it is, and the part that is visible from the rest of the camp.
      const finial = spike({ height: crown * 0.8, radius: poleRadius * 0.9, sides: 4 });
      finial.translate(0, peak, 0);
      builder.add(finial, undefined, 'brass');
      spent += 16;
      // Hung off the finial and streaming out, with its head inside the crown: a
      // flag that stands above the peak it hangs from is a flag on a pole of its
      // own, and this pavilion is measured to its peak.
      const pennant = cloth(width * 0.44, crown * 0.5, 3, 2, (u, v) => 0.05 * Math.sin(u * Math.PI * 2) * v);
      pennant.rotateX(Math.PI / 2);
      pennant.rotateY(Math.PI / 2);
      pennant.translate(width * 0.3, peak + crown * 0.42, 0);
      builder.add(pennant, undefined, 'fabric');
      spent += clothCost(3, 2);
    }
    if (guys && budget - spent > 200) {
      const pegs = planChildren(Math.max(4, Math.round(radius * 3)), cylinderCost(4, false) + 16, Math.min(budget - spent, poleShare));
      for (let index = 0; index < pegs.modeled; index += 1) {
        const angle = (index / pegs.modeled) * Math.PI * 2 + Math.PI / pegs.modeled;
        const at = radius * 1.42;
        builder.add(
          strut(
            [Math.sin(angle) * radius * 1.0, wallHeight * 0.86, Math.cos(angle) * radius * 1.0],
            [Math.sin(angle) * at, 0.02, Math.cos(angle) * at],
            poleRadius * 0.34,
            4,
          ),
          undefined,
          'rope',
        );
        spent += cylinderCost(4, false);
        const peg = spike({ height: 0.22, radius: 0.018, sides: 4 });
        peg.rotateZ(range(rng, -0.2, 0.2));
        peg.translate(Math.sin(angle) * at, 0, Math.cos(angle) * at);
        builder.add(peg, undefined, 'wood-dark');
        spent += 16;
      }
    }
    fitHeight(builder, height, 1.15);
    return builder;
  }

  // One rope and one peg, wherever a sheet has to be held down.
  const guy = (from: Vec3, to: Vec3): void => {
    builder.add(strut(from, to, poleRadius * 0.32, 4), undefined, 'rope');
    spent += cylinderCost(4, false);
    const peg = spike({ height: 0.2, radius: 0.016, sides: 4 });
    peg.rotateZ(range(rng, -0.24, 0.24));
    peg.translate(to[0], 0, to[2]);
    builder.add(peg, undefined, 'wood-dark');
    spent += 16;
  };

  // Cloth sags by a share of the span it is stretched over: a fixed two
  // centimetres reads as flat on a five metre pavilion and as a hammock on a
  // shelter. Taut at the ridge and at the pegs, slack between, and a little
  // heavier toward the hem, where nothing holds it but a pole.
  const drape = (span: number) => (u: number, v: number): number => {
    const u01 = Math.abs(u - 0.5) * 2;
    const belly = (0.018 + span * 0.022) * (1 - u01 * u01);
    return -belly * Math.sin(v * Math.PI) - belly * 0.3 * v;
  };

  const across = Math.max(2, Math.min(7, Math.round(sheetShare / 90)));
  const along = Math.max(2, Math.min(6, Math.round(depth / 0.5)));
  const halfWidth = width / 2;
  const halfDepth = depth / 2;

  if (style === 'lean-to') {
    // A lean-to is one slope between a tall back and a low front, with its ends
    // closed and its front open: it is a roof you sleep under facing a fire, and
    // a lean-to with a wall at the front is a ridge tent somebody flattened.
    const backZ = -halfDepth;
    const frontZ = halfDepth;
    const eaveHeight = Math.max(height * 0.3, 0.5);
    const overhang = Math.min(depth * 0.07, 0.22);
    const hemZ = frontZ + overhang;
    const hemY = Math.max(0.02, eaveHeight - overhang * Math.tan(Math.atan2(height - eaveHeight, depth)));
    const slopePitch = Math.atan2(height - hemY, hemZ - backZ);
    const slopeLength = Math.hypot(hemZ - backZ, height - hemY);

    const sheet = cloth(width + width * 0.1, slopeLength, across, along, drape(slopeLength));
    sheet.rotateX(slopePitch);
    sheet.translate(0, (height + hemY) / 2, (backZ + hemZ) / 2);
    builder.add(sheet, undefined, fabric);
    spent += clothCost(across, along);

    // Two tall posts at the back, two short ones at the front, a rail across each
    // end and rafters down the slope, which is what the sheet is lashed to.
    const frame = planChildren(7, cylinderCost(5, false), Math.max(cylinderCost(5, false), poleShare));
    const corners: [number, number, number][] = [
      [-halfWidth * 0.97, height, backZ],
      [halfWidth * 0.97, height, backZ],
      [-halfWidth * 0.97, eaveHeight, frontZ],
      [halfWidth * 0.97, eaveHeight, frontZ],
    ];
    for (let index = 0; index < Math.min(corners.length, frame.modeled); index += 1) {
      const [x, top, z] = corners[index]!;
      builder.add(strut([x, 0, z], [x, top, z], poleRadius, 5), undefined, 'log');
      spent += cylinderCost(5, false);
    }
    if (frame.modeled > 4) {
      for (const [z, at] of [[backZ, height], [frontZ, eaveHeight]] as [number, number][]) {
        builder.add(strut([-halfWidth * 0.97, at - poleRadius, z], [halfWidth * 0.97, at - poleRadius, z], poleRadius * 0.8, 4), undefined, 'wood-dark');
        spent += cylinderCost(4, false);
      }
      const rafters = planChildren(3, cylinderCost(4, false), Math.max(cylinderCost(4, false), poleShare * 0.34));
      for (let index = 0; index < rafters.modeled; index += 1) {
        const x = -halfWidth * 0.9 + (halfWidth * 1.8 * (index + 0.5)) / rafters.modeled;
        builder.add(strut([x, height - poleRadius * 1.4, backZ], [x, hemY + poleRadius, hemZ - overhang * 0.4], poleRadius * 0.6, 4), undefined, 'wood-dark');
        spent += cylinderCost(4, false);
      }
    }

    // The ends are triangles in the plane of the slope, not gables across it: a
    // lean-to has no ridge to build a gable under.
    const endThickness = 0.024;
    const endProfile: Vec2[] = [
      [-backZ, height],
      [-hemZ, hemY],
      [-hemZ, 0],
      [-backZ, 0],
    ];
    for (const side of [-1, 1] as const) {
      const end = extrude(endProfile, { depth: endThickness });
      // Turned so the profile's own X becomes the world's Z, and its extrusion
      // becomes the world's X, then stood at the end it closes.
      end.rotateY(Math.PI / 2);
      end.translate(side > 0 ? halfWidth - endThickness : -halfWidth, 0, 0);
      builder.add(end, undefined, fabric);
      spent += 4 * endProfile.length - 4;
    }

    if (guys && budget - spent > 140) {
      const pegs = planChildren(4, cylinderCost(4, false) + 16, Math.min(budget - spent, poleShare));
      const anchors: [Vec3, Vec3][] = [
        [[-halfWidth, eaveHeight, frontZ], [-halfWidth * 1.32, 0, frontZ + depth * 0.3]],
        [[halfWidth, eaveHeight, frontZ], [halfWidth * 1.32, 0, frontZ + depth * 0.3]],
        [[-halfWidth, height, backZ], [-halfWidth * 1.32, 0, backZ - depth * 0.24]],
        [[halfWidth, height, backZ], [halfWidth * 1.32, 0, backZ - depth * 0.24]],
      ];
      for (let index = 0; index < Math.min(pegs.modeled, anchors.length); index += 1) {
        const [from, to] = anchors[index]!;
        guy(from, to);
      }
    }
    fitHeight(builder, height, 1.25);
    return builder;
  }

  // A ridge tent: two slopes off a ridge, and a gable at each end. The sheet runs
  // from the ridge to a hem that overhangs the pole line, and the hem is where it
  // is measured from — computed from the two ends rather than by adding an
  // overhang to a slope that was already finished, which lands the hem under the
  // ground and costs the whole tent a percent of its height when it is seated.
  const eaveHeight = height * 0.06;
  const overhangX = Math.min(width * 0.05, 0.16);
  const hemZ = halfWidth + overhangX;
  const hemY = Math.max(0.02, eaveHeight - overhangX * Math.tan(Math.atan2(height - eaveHeight, halfWidth)));
  const pitch = Math.atan2(height - hemY, hemZ);
  const slopeLength = Math.hypot(hemZ, height - hemY);

  for (const side of [-1, 1] as const) {
    const sheet = cloth(width + width * 0.12, slopeLength, across, along, drape(slopeLength));
    // No mirrored copy: cloth is a double-sided material, so one sheet serves for
    // the weather side and the inside of the tent alike, and the sag stays a sag.
    sheet.rotateX(side * pitch);
    sheet.translate(0, (height + hemY) / 2, side * (hemZ / 2));
    builder.add(sheet, undefined, fabric);
    spent += clothCost(across, along);
  }

  // The end walls: one board each, notched for the doorway, so the door is a hole
  // through the tent. Cut as a single polygon rather than as panels either side of
  // the opening with a triangle over it, because three pieces that meet along the
  // head of the door lay their meeting edges in one plane, and two faces in one
  // plane winding the same way are a doubled skin that z-fights on screen.
  const doorWidth = Math.min(width * 0.46, 1.1);
  // The wall's silhouette runs from its bottom corner to the apex, so the head of
  // the door has to sit under that line: a door taller than the wall it is cut in
  // pokes through the roof behind it.
  const doorHeight = Math.min((height - eaveHeight) * 0.66, height * (1 - doorWidth / width) - 0.06);
  const thickness = 0.022;
  const endProfile: Vec2[] = [
    [-halfWidth, 0],
    [0, height],
    [halfWidth, 0],
    [doorWidth / 2, 0],
    [doorWidth / 2, doorHeight],
    [-doorWidth / 2, doorHeight],
    [-doorWidth / 2, 0],
  ];
  for (const side of [-1, 1] as const) {
    const wall = extrude(endProfile, { depth: thickness });
    wall.translate(0, 0, side > 0 ? halfDepth : -halfDepth - thickness);
    builder.add(wall, undefined, fabric);
    spent += 4 * endProfile.length - 4;
  }

  // The flap hangs on the left jamb and is swung out and back when the door is
  // open, so the opening is genuinely clear of it. Swung about its own middle, or
  // about a point under the ground, it buries itself in the floor and drags the
  // whole tent up with it when the tent is seated.
  const swing = open ? -1.95 : 0;
  const flap = cloth(doorWidth * 1.04, doorHeight * 1.02, 3, 3, (u, v) => -0.05 * Math.sin(u * Math.PI) * (0.3 + v * 0.7));
  flap.rotateX(Math.PI / 2);
  flap.translate(doorWidth * 0.52, doorHeight * 0.51, 0);
  flap.rotateY(swing);
  flap.translate(-doorWidth / 2, 0, halfDepth + thickness * 1.6);
  builder.add(flap, undefined, fabric);
  spent += clothCost(3, 3);

  // The frame: an A-frame at each end, a tie across each of them so it does not
  // fold shut under the sheet, and a ridge pole between the two.
  const frameZ = [-halfDepth, halfDepth];
  const framePoles = planChildren(frameZ.length * 2 + 1, cylinderCost(5, false), Math.max(cylinderCost(5, false), poleShare - spent * 0.2));
  let laid = 0;
  for (const z of frameZ) {
    for (const side of [-1, 1] as const) {
      if (laid >= framePoles.modeled) break;
      laid += 1;
      builder.add(strut([side * halfWidth * 0.98, 0, z], [0, height, z], poleRadius, 5), undefined, 'log');
      spent += cylinderCost(5, false);
    }
    if (laid < framePoles.modeled) {
      builder.add(strut([-halfWidth * 0.86, eaveHeight + height * 0.16, z], [halfWidth * 0.86, eaveHeight + height * 0.16, z], poleRadius * 0.7, 4), undefined, 'wood-dark');
      spent += cylinderCost(4, false);
      laid += 1;
    }
  }
  if (framePoles.modeled > 4) {
    builder.add(strut([0, height - poleRadius, -halfDepth], [0, height - poleRadius, halfDepth], poleRadius * 0.8, 5), undefined, 'log');
    spent += cylinderCost(5, false);
  }

  if (guys && budget - spent > 160) {
    // Pegged at the ridge ends and at the four eaves, and the ropes pull the
    // sheet taut, which is what makes the sag read as cloth under tension.
    const pegs = planChildren(6, cylinderCost(4, false) + 16, Math.min(budget - spent, poleShare));
    const anchors: [Vec3, Vec3][] = [
      [[0, height, -halfDepth], [0, 0, -halfDepth - depth * 0.34]],
      [[0, height, halfDepth], [0, 0, halfDepth + depth * 0.34]],
      [[-halfWidth, eaveHeight + 0.05, -halfDepth], [-halfWidth * 1.42, 0, -halfDepth - depth * 0.2]],
      [[halfWidth, eaveHeight + 0.05, -halfDepth], [halfWidth * 1.42, 0, -halfDepth - depth * 0.2]],
      [[-halfWidth, eaveHeight + 0.05, halfDepth], [-halfWidth * 1.42, 0, halfDepth + depth * 0.2]],
      [[halfWidth, eaveHeight + 0.05, halfDepth], [halfWidth * 1.42, 0, halfDepth + depth * 0.2]],
    ];
    for (let index = 0; index < Math.min(pegs.modeled, anchors.length); index += 1) {
      const [from, to] = anchors[index]!;
      guy(from, to);
    }
  }
  fitHeight(builder, height, 1.25);
  return builder;
}
