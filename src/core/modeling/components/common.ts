import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { cylinder, lathe, plane } from '../primitives';
import { POST_TRIANGLES_PER_SIDE, detailRng, dressedBlock } from '../detail';
import { range } from '../../generation/rng';

/**
 * Plumbing shared by the component families.
 *
 * Cost formulas, and the half dozen small parts every family builds the same
 * way: a straight member between two points, a course of blocks around a ring,
 * a sheet of cloth, a thrown pot, and the two placements that keep a bounding
 * box honest. They live here rather than in each file so that a cask in
 * `containers` rests on a surface the same way a sack in `props` does, and so
 * that a cost is measured once and charged from the same number everywhere.
 *
 * Coordinates and conventions are the library's: metres, Y up, parts built on
 * their own origin and seated by the caller.
 */

/** Triangles a `post` costs: a band per side of its cross-section, doubled by the caps. */
export function postCost(sides: number): number {
  return Math.max(4, Math.round(sides)) * POST_TRIANGLES_PER_SIDE;
}

/** Triangles a `prism` costs: a band per side, halved when the top collapses to a point. */
export function prismCost(sides: number, pointed = false): number {
  return Math.max(3, Math.round(sides)) * (pointed ? 2 : 4);
}

/** Triangles one sheet of cloth costs: a quad per cell of its grid. */
export function clothCost(across: number, along: number): number {
  return Math.max(1, Math.round(across)) * Math.max(1, Math.round(along)) * 2;
}

/**
 * Triangles a `cask` costs: a stave is a boarded wedge and a hoop a ring.
 *
 * Measured, not guessed — eight staves and two hoops build 464 triangles, twelve
 * staves and three hoops build 756, which is 66 per stave and 28 per hoop with
 * 120 left over. The leftover is charged rather than credited, so a stall that
 * can afford three casks builds three.
 */
export function caskCost(staves: number, hoops: number): number {
  return Math.max(4, Math.round(staves)) * 66 + Math.max(1, Math.round(hoops)) * 28;
}

/**
 * Triangles a `rope` costs: a swept section of `strands * 6` points per station.
 *
 * A rope is the most expensive line in the library and the only one worth it
 * where a player stands close enough to see the lay of the strands. Charged from
 * the station count `rope` resamples to, plus the two caps, plus a margin.
 */
export function ropeCost(pathPoints: number, segments: number, strands = 3): number {
  const spans = Math.max(1, Math.round(pathPoints) - 1);
  const steps = Math.max(1, Math.round(segments / spans));
  const stations = spans * steps + 1;
  const section = Math.max(2, Math.round(strands)) * 6;
  return (stations - 1) * section * 2 + 2 * (section - 2) + 8;
}

/**
 * A straight member between two points: a pole, a brace, a stay, a guy rope.
 *
 * Everything a prop leans on is one of these, and building them as tapered
 * cylinders rather than as `rope` is the difference between a tent that costs
 * two hundred triangles and one that costs two thousand.
 */
export function strut(from: Vec3, to: Vec3, radius: number, sides = 5, caps = false): MeshBuilder {
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
export function stoneRing(
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
export function waterSheet(radius: number, segments: number, at: number): MeshBuilder {
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
export function cloth(
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
 * A thrown pot: cheaper than `vessel` and honest at arm's length.
 *
 * `vessel` builds a hero piece — handles, a foot ring, a flared lip — and costs
 * four hundred and eighty triangles before it is asked for anything. A market
 * stall needs six pots, not one, so the everyday pot is a six-station profile
 * with the wobble of a hand-thrown wall left in it.
 */
export function pot(height: number, radius: number, segments: number, seed: number): MeshBuilder {
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

/**
 * Seats a part on a surface at `y`, wherever its own bottom happens to be.
 *
 * Goods on a counter, stones in a ring and sacks on the ground are all built
 * centred on their own origin, and a sphere squashed by its own weight has a
 * bottom that no caller can predict. Lifting by the measured bottom is what
 * keeps a component's bounding box honest: one sack sunk two centimetres into a
 * counter is a prop that has fallen through the world.
 */
export function placeOn(part: MeshBuilder, x: number, y: number, z: number): void {
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
export function leanLift(radius: number, tilt: number): number {
  return Math.abs(radius * Math.sin(tilt));
}
