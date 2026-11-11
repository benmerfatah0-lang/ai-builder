import * as THREE from 'three';
import { fbm3, ridged as ridgedNoise } from '../terrain/noise';
import { chance, intRange, mulberry32, pick, range, type Rng } from '../generation/rng';
import { MeshBuilder, type Vec2, type Vec3 } from './mesh';
import { box, cylinder, extrude, lathe, prism, sphere, sweep, torus, plane, type Frame } from './primitives';

/**
 * Ornament and detail parts shared by every component family.
 *
 * This module is where the difference between "a box with a texture" and "a
 * modeled wall" lives: individual ashlar blocks with staggered joints, merlons
 * with embrasures, alternating pan tiles, barrel hoops with rivets, chain links
 * that hang in a catenary, leaves with a midrib and a camber.
 *
 * Conventions, uniform across the module:
 * - metres, Y-up, base of the part on y = 0 unless the docstring says otherwise;
 * - centred on X and Z so a caller can translate it onto a wall or a roof;
 * - everything returns a `MeshBuilder`, so parts compose with `add` and inherit
 *   the caller's material slot;
 * - `seed` drives every random choice, so the same parameters always build the
 *   same model.
 */

export function detailRng(seed: number): Rng {
  return mulberry32(Math.abs(Math.round(seed)) >>> 0);
}

/* ----------------------------------------------------------------- budget */

export type Quality = 'low' | 'medium' | 'high';

/**
 * Triangle budget per finished asset, by quality.
 *
 * These numbers are not arbitrary: the free-model library the app already
 * searches caps at 10,000 triangles, a phone viewport wants a whole village under
 * a few hundred thousand, and the LOD generator can only decimate what was not
 * wasted in the first place. A brick modeled as a solid costs 12 triangles; the
 * same brick as a normal map costs nothing and looks the same past two metres.
 */
export const QUALITY_TRIANGLES: Record<Quality, number> = { low: 700, medium: 3000, high: 11000 };

export function qualityTriangles(quality: Quality | undefined): number {
  return QUALITY_TRIANGLES[quality ?? 'high'];
}

/** Triangles a plain box costs, and a single-segment chamfered box. */
export const BOX_TRIANGLES = 12;
export const BEVELLED_BOX_TRIANGLES = 44;

export interface RepeatedUnits {
  /** How many units to model as real geometry. */
  modeled: number;
  /** True when the count is too high and the surface must carry the detail. */
  textured: boolean;
}

/**
 * Decides how many repeated units stay solid.
 *
 * Masonry, shingles and studs all face the same question: at what point does a
 * unit stop being worth 12 triangles? The answer is distance and count, and this
 * is the single place that policy lives, so every family makes the same choice.
 */
export function planRepeatedUnits(count: number, perUnit: number, budget: number, minimum = 0): RepeatedUnits {
  if (count <= 0) return { modeled: 0, textured: false };
  const affordable = Math.floor(budget / Math.max(1, perUnit));
  if (affordable >= count) return { modeled: count, textured: false };
  return { modeled: Math.max(minimum, Math.min(count, affordable)), textured: true };
}

/* ------------------------------------------------------------- deformation */

/**
 * The triangle budget for one component: an explicit number wins over quality.
 *
 * Every family resolves its budget this way, so a caller can hand a generator
 * either a quality name or a hard number and get the same behaviour, and a scene
 * can ration a fixed allowance across the assets it is placing.
 */
export function componentBudget(quality: Quality | undefined, budget: number | undefined): number {
  if (budget !== undefined && Number.isFinite(budget)) return Math.max(60, Math.round(budget));
  return qualityTriangles(quality);
}

/**
 * How many children fit once each is reduced to its cheapest honest form.
 *
 * `planRepeatedUnits` simplifies a unit before it drops one, but a unit has a
 * floor: a mushroom cannot be less than a cap over a stipe, a cairn stone cannot
 * be less than a faceted mass. When even the floor does not fit, coverage is what
 * gives — and this is the only place in the library that decides to build fewer
 * of a thing, so every family makes that decision the same way.
 */
export function planChildren(count: number, cheapest: number, budget: number): { modeled: number; each: number } {
  const wanted = Math.max(1, Math.round(count));
  const floor = Math.max(1, Math.round(cheapest));
  const affordable = Math.max(1, Math.floor(budget / floor));
  const modeled = Math.max(1, Math.min(wanted, affordable));
  return { modeled, each: Math.max(floor, Math.floor(budget / modeled)) };
}

export interface DisplaceOptions {
  /** Peak displacement in metres. */
  amplitude: number;
  /** Noise frequency in cycles per metre. */
  frequency?: number;
  octaves?: number;
  seed?: number;
  /** Move along the vertex normal (default) or add a free 3D offset. */
  alongNormals?: boolean;
  /** Keep the base of the model flat, so a rock still sits on the ground. */
  preserveBase?: boolean;
  /** Recompute normals afterwards; leave false to keep authored shading. */
  recompute?: boolean;
}

/**
 * Displaces a mesh with 3D fractal noise.
 *
 * This is how a sphere stops being a sphere: boulders, tree crowns, terrain
 * mounds, dragon shoulders and eroded ruins all start from a smooth solid and
 * get pushed around by noise measured in world space, so two rocks made from the
 * same primitive never look alike.
 */
export function displace(builder: MeshBuilder, options: DisplaceOptions): MeshBuilder {
  const frequency = options.frequency ?? 1;
  const octaves = options.octaves ?? 3;
  const seed = options.seed ?? 1;
  const alongNormals = options.alongNormals ?? true;
  const base = builder.bounds().min[1];
  const height = Math.max(1e-4, builder.bounds().size[1]);
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const value = fbm3(seed, point[0] * frequency, point[1] * frequency, point[2] * frequency, octaves);
    let weight = 1;
    if (options.preserveBase) {
      // Fade the displacement out at the base so the part still sits flat.
      weight = Math.min(1, Math.max(0, (point[1] - base) / (height * 0.28)));
    }
    const amount = value * options.amplitude * weight;
    if (alongNormals) {
      const normal = builder.normalAt(index);
      builder.setPosition(index, [
        point[0] + normal[0] * amount,
        point[1] + normal[1] * amount,
        point[2] + normal[2] * amount,
      ]);
    } else {
      builder.setPosition(index, [point[0] + amount, point[1] + amount * 0.6, point[2] - amount]);
    }
  }
  if (options.recompute !== false) builder.computeNormals();
  return builder;
}

/** Cuts a solid into facets, the fastest way to make rock read as rock. */
export function fracture(builder: MeshBuilder, options: DisplaceOptions & { facets?: boolean }): MeshBuilder {
  displace(builder, options);
  if (options.facets !== false) builder.flatShade();
  return builder;
}

/* ------------------------------------------------------------------- rock */

export interface BoulderOptions {
  radius: number;
  seed?: number;
  /** 0 = river-smooth, 1 = shattered. */
  roughness?: number;
  /** Squash or stretch the whole mass; real boulders are rarely spherical. */
  stretch?: Vec3;
  segments?: number;
  facets?: boolean;
  /** Buries the bottom so the rock meets the ground instead of floating. */
  sink?: number;
}

/**
 * A boulder: a sphere pushed around by two noise scales, then faceted.
 *
 * The large scale sets the mass (which side is heavy), the small scale chips the
 * surface. Faceting afterwards is what sells it — smooth-shaded noise looks like
 * a inflated bag, flat-shaded noise looks like broken stone.
 */
export function boulder(options: BoulderOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 7);
  const radius = Math.max(0.05, options.radius);
  const roughness = options.roughness ?? 0.55;
  const segments = Math.max(5, Math.round(options.segments ?? 8));
  const builder = sphere(radius, {
    widthSegments: segments * 2,
    heightSegments: segments,
    radii: options.stretch ? [radius * options.stretch[0], radius * options.stretch[1], radius * options.stretch[2]] : undefined,
  });
  // Large lobes first, then chips, so the silhouette breaks before the surface.
  displace(builder, { amplitude: radius * 0.42 * roughness, frequency: 0.75 / radius, octaves: 2, seed: options.seed ?? 7 });
  displace(builder, { amplitude: radius * 0.22 * roughness, frequency: 2.1 / radius, octaves: 3, seed: (options.seed ?? 7) + 991 });
  if (options.facets !== false) builder.flatShade();
  // One flat face down: a boulder sits on something, it does not balance.
  const bounds = builder.bounds();
  const floor = bounds.min[1] + bounds.size[1] * (options.sink ?? 0.16);
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    if (point[1] > floor) continue;
    builder.setPosition(index, [point[0] * 1.06, floor, point[2] * 1.06]);
  }
  builder.computeNormals();
  builder.translate(0, -builder.bounds().min[1], 0);
  void rng;
  return builder;
}

export interface RockClusterOptions {
  radius: number;
  count?: number;
  seed?: number;
  spread?: number;
}

/** A scatter of boulders around one dominant mass, as rock actually lies. */
export function rockCluster(options: RockClusterOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 11);
  const count = Math.max(1, Math.round(options.count ?? 4));
  const spread = options.spread ?? options.radius * 1.6;
  const builder = new MeshBuilder();
  builder.add(boulder({ radius: options.radius, seed: options.seed ?? 11, roughness: range(rng, 0.45, 0.75) }));
  for (let index = 0; index < count; index += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = range(rng, spread * 0.45, spread);
    const size = options.radius * range(rng, 0.18, 0.5);
    const shard = boulder({ radius: size, seed: (options.seed ?? 11) + index * 37 + 5, roughness: range(rng, 0.5, 0.9) });
    shard.translate(Math.cos(angle) * distance, range(rng, -size * 0.2, size * 0.1), Math.sin(angle) * distance);
    builder.add(shard);
  }
  return builder;
}

/** A standing crag: tall, leaning, split vertically by frost. */
export function crag(options: { height: number; radius?: number; seed?: number; lean?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 23);
  const height = Math.max(0.4, options.height);
  const radius = Math.max(0.2, options.radius ?? height * 0.28);
  const profile: Vec2[] = [];
  const stations = 7;
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    const taper = 1 - Math.pow(t, 1.4) * 0.72;
    profile.push([radius * taper * range(rng, 0.85, 1.15), height * t]);
  }
  const builder = lathe(profile, { segments: 10, caps: true });
  displace(builder, { amplitude: radius * 0.3, frequency: 1.4 / radius, octaves: 3, seed: options.seed ?? 23 });
  // Vertical frost splitting: stretch the noise along Y so cracks run up.
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const crack = ridgedNoise((options.seed ?? 23) + 5, point[0] * 2.2, point[2] * 2.2, { octaves: 3 });
    const normal = builder.normalAt(index);
    const amount = (crack - 0.55) * radius * 0.34;
    builder.setPosition(index, [point[0] + normal[0] * amount, point[1], point[2] + normal[2] * amount]);
  }
  builder.flatShade();
  builder.translate(0, -builder.bounds().min[1], 0);
  if (options.lean) builder.rotateZ(options.lean);
  return builder;
}

/* ------------------------------------------------------------------ stone */

export type MasonryStyle = 'ashlar' | 'rubble' | 'brick' | 'adobe' | 'block';

export interface StoneWallOptions {
  /** Length along X. */
  width: number;
  /** Height along Y, from y = 0. */
  height: number;
  /** Thickness along Z, centred on z = 0. */
  thickness: number;
  style?: MasonryStyle;
  /** Course height in metres; the block length follows the style. */
  course?: number;
  seed?: number;
  /** How far blocks proud of the wall face, in metres. */
  relief?: number;
  /** 0 = tight joints, 1 = wide, recessed joints. */
  joint?: number;
  /** Leaves the wall face as a solid backing instead of individual blocks. */
  backing?: boolean;
  /** Breaks the top edge, for ruins. 0 = level, 1 = ragged. */
  ruin?: number;
  /** Triangle budget for this wall; small units fall back to the texture. */
  budget?: number;
}

/**
 * A wall of individual stones.
 *
 * Courses are staggered by half a block, each block varies in length and sits
 * proud or shy of its neighbours by a few centimetres, and the joints are
 * recessed. That is the whole difference between a castle wall and a textured
 * box: the shadow in every joint is cast by geometry, not painted on.
 */
export function stoneWall(options: StoneWallOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 31);
  const width = Math.max(0.2, options.width);
  const height = Math.max(0.2, options.height);
  const thickness = Math.max(0.06, options.thickness);
  const style = options.style ?? 'ashlar';
  const joint = Math.max(0, Math.min(1, options.joint ?? 0.5));
  const relief = options.relief ?? (style === 'rubble' ? 0.07 : 0.035);
  const ruin = Math.max(0, Math.min(1, options.ruin ?? 0));

  const wantedCourse = Math.max(0.08, options.course ?? (style === 'brick' ? 0.09 : style === 'rubble' ? 0.3 : 0.42));
  const builder = new MeshBuilder();
  const courses = Math.max(1, Math.round(height / wantedCourse));
  // The course height then divides the wall exactly. Rounding the count and
  // keeping the nominal course would let a 3.2 m wall stand 3.36 m tall, and
  // every floor stacked on it would float above its own walls.
  const courseHeight = height / courses;
  const blockLength = style === 'brick' ? courseHeight * 2.2 : style === 'rubble' ? courseHeight * range(rng, 1, 1.8) : courseHeight * 2;
  const gap = courseHeight * 0.06 * (0.5 + joint);
  const budget = Math.max(120, options.budget ?? 1600);

  // How many blocks this wall actually needs, then whether they can stay solid.
  const estimatedUnits = Math.max(1, Math.round(width / blockLength)) * courses;
  // Below this density the units are too small to see: the brick normal map
  // carries the wall and only a few proud bricks are modeled, at the corners and
  // wherever the surface is broken. That is the difference between a 60,000
  // triangle wall and a 600 triangle one that reads the same from ten metres.
  const forcedTextured = style === 'brick' && courseHeight < 0.16 && width * height > 2;
  // Coverage is never traded away for budget: when the blocks do not fit, the
  // representation steps down (chamfered, then plain, then textured) so a wall is
  // always a whole wall.
  const chamfered = !forcedTextured && estimatedUnits * BEVELLED_BOX_TRIANGLES <= budget;
  const textured = forcedTextured || (!chamfered && estimatedUnits * BOX_TRIANGLES > budget);

  if (options.backing || textured) {
    builder.add(box(width, courses * courseHeight, thickness * (textured ? 1 : 0.7), {
      bevel: textured ? 0 : 0.012,
      bevelSegments: 1,
    }).translate(0, (courses * courseHeight) / 2, textured ? 0 : -thickness * 0.15));
  }

  if (textured) {
    // Quoins: dressed corner blocks are what a real wall always has, and they
    // give the silhouette the relief the flat face no longer carries.
    const quoinCourses = Math.min(courses, Math.max(2, Math.min(12, Math.floor(budget / (BOX_TRIANGLES * 4)))));
    const quoinStep = Math.max(1, Math.floor(courses / quoinCourses));
    for (let course = 0; course < courses; course += quoinStep) {
      const stoneHeight = courseHeight - gap;
      const y = course * courseHeight + stoneHeight / 2;
      const long = course % (quoinStep * 2) === 0;
      for (const side of [-1, 1]) {
        const quoin = box(long ? thickness * 1.5 : thickness * 0.9, stoneHeight, long ? thickness * 0.9 : thickness * 1.5);
        quoin.translate(side * (width / 2 - thickness * (long ? 0.75 : 0.45)), y, 0);
        builder.add(quoin);
      }
    }
    // A scatter of proud and recessed blocks, so the face is not perfectly flat.
    const accents = Math.max(0, Math.min(24, Math.floor((budget - builder.triangleCount * 3) / BOX_TRIANGLES)));
    for (let index = 0; index < accents; index += 1) {
      const course = intRange(rng, 0, courses - 1);
      const stoneHeight = courseHeight - gap;
      const length = blockLength * range(rng, 0.6, 1.4);
      const x = range(rng, -width / 2 + length, width / 2 - length);
      const proud = relief * range(rng, 0.6, 2.4);
      const accent = box(length - gap, stoneHeight, thickness * 0.32 + proud);
      accent.translate(x, course * courseHeight + stoneHeight / 2, thickness / 2 + proud / 2 - thickness * 0.06);
      builder.add(accent);
    }
    if (ruin > 0) builder.add(ruinTop(width, height, thickness, ruin, options.seed ?? 31, budget * 0.2));
    return builder;
  }

  for (let course = 0; course < courses; course += 1) {
    const y = course * courseHeight;
    // Stagger every other course, and start the first course with a half block so
    // the corners do not line up in a vertical seam.
    let x = -width / 2 + (course % 2 === 0 ? 0 : -blockLength / 2);
    let index = 0;
    while (x < width / 2) {
      const length = style === 'rubble'
        ? blockLength * range(rng, 0.6, 1.4)
        : blockLength * (chance(rng, 0.12) ? range(rng, 0.5, 0.8) : range(rng, 0.92, 1.08));
      const visible = Math.min(length, width / 2 - x);
      if (visible > gap * 2) {
        const stoneHeight = courseHeight - gap;
        const proud = relief * (style === 'rubble' ? range(rng, -1, 1.4) : range(rng, -0.6, 1));
        const stoneDepth = thickness * range(rng, 0.86, 1) + proud;
        const top = y + stoneHeight;
        // A ruined wall loses blocks from the top down, unevenly along its run.
        const ruinLine = height * (1 - ruin * (0.35 + 0.65 * Math.abs(fbm3((options.seed ?? 31) + 7, (x + width / 2) / width * 3, 0.5, 0.5, 2))));
        const keep = ruin <= 0 || top <= ruinLine || chance(rng, 0.35);
        if (keep) {
          // A single-segment chamfer: 44 triangles instead of 108, and at block
          // scale the difference is invisible.
          const bevel = chamfered ? (style === 'rubble' ? Math.min(0.04, stoneHeight * 0.2) : Math.min(0.02, stoneHeight * 0.1)) : 0;
          const block = box(visible - gap, stoneHeight, stoneDepth, bevel > 0 ? { bevel, bevelSegments: 1 } : {});
          if (style === 'rubble') {
            // Tilt first, then place. Rotating after translating swings the stone
            // about the wall's origin, which drags it out of its course by up to
            // a sixth of a metre and pushes the wall past its own height.
            block.rotateY(range(rng, -0.05, 0.05));
            block.rotateZ(range(rng, -0.04, 0.04));
          }
          block.translate(x + visible / 2, y + stoneHeight / 2, proud * 0.5);
          builder.add(block);
        }
      }
      x += length;
      index += 1;
      // A hard stop only as a runaway guard, well above any real wall.
      if (index > 4000) break;
    }
  }
  if (ruin > 0) builder.add(ruinTop(width, height, thickness, ruin, options.seed ?? 31, budget * 0.2));
  return builder;
}

/**
 * A broken wall head: blocks missing along a ragged line.
 *
 * Ruins are not a wall with a hole in it; the top is uneven, the corners survive
 * longest and the debris lies below. This adds the missing-course silhouette that
 * makes a ruin read at a glance.
 */
export function ruinTop(width: number, height: number, thickness: number, ruin: number, seed: number, budget: number): MeshBuilder {
  const rng = detailRng(seed + 71);
  const builder = new MeshBuilder();
  // Each block is a chamfered box, so it costs 44 triangles, not 12: budgeting
  // it at the plain-box price silently overspent by a factor of four.
  const blocks = Math.max(2, Math.min(24, Math.floor(budget / BEVELLED_BOX_TRIANGLES)));
  for (let index = 0; index < blocks; index += 1) {
    if (!chance(rng, ruin)) continue;
    const length = width / blocks * range(rng, 0.5, 1.1);
    const x = -width / 2 + (width * (index + range(rng, 0.1, 0.9))) / blocks;
    const blockHeight = range(rng, 0.08, 0.3) * (0.5 + ruin);
    const part = box(length, blockHeight, thickness * range(rng, 0.6, 1), { bevel: 0.015, bevelSegments: 1 });
    part.rotateY(range(rng, -0.12, 0.12));
    part.translate(x, height - blockHeight * range(rng, 0.1, 0.7), range(rng, -thickness * 0.1, thickness * 0.1));
    builder.add(part);
  }
  return builder;
}

/** A single dressed block with a chamfer, for quoins, plinths and lintels. */
export function dressedBlock(options: { width: number; height: number; depth: number; chamfer?: number; seed?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 41);
  const chamfer = options.chamfer ?? Math.min(options.width, options.height, options.depth) * 0.08;
  const block = box(options.width, options.height, options.depth, { bevel: chamfer, bevelSegments: 1 });
  // Weathering: a stone that has stood outside is never quite a cuboid.
  displace(block, { amplitude: Math.min(options.width, options.height) * 0.012, frequency: 4, octaves: 2, seed: options.seed ?? 41 });
  void rng;
  return block;
}

/* ------------------------------------------------------------------ timber */

export interface PlankOptions {
  width: number;
  height: number;
  thickness: number;
  /** Number of planks across the width (or up the height when horizontal). */
  count?: number;
  horizontal?: boolean;
  gap?: number;
  seed?: number;
  /** Adds battens across the back, as a real boarded door or gate has. */
  battens?: boolean;
  /** Stud heads along the battens. */
  studs?: boolean;
  bevel?: number;
}

/**
 * Boarded timber: separate planks with a shadow gap, optional battens and studs.
 *
 * A flat box with a wood texture reads as plywood. Individual planks with a 1 cm
 * gap read as a door, a gate, a shutter or a barn wall — and the gap costs four
 * triangles per plank.
 */
export function planks(options: PlankOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 53);
  const builder = new MeshBuilder();
  const horizontal = options.horizontal ?? false;
  const count = Math.max(1, Math.round(options.count ?? (horizontal ? Math.max(3, options.height / 0.28) : Math.max(3, options.width / 0.24))));
  const gap = Math.max(0.004, options.gap ?? 0.014);
  const bevel = options.bevel ?? 0.008;
  const span = horizontal ? options.height : options.width;
  const unit = Math.max(gap * 2, span / count);

  for (let index = 0; index < count; index += 1) {
    const offset = -span / 2 + unit * (index + 0.5);
    const warp = range(rng, -0.006, 0.006);
    const plank = horizontal
      ? box(options.width, unit - gap, options.thickness * range(rng, 0.94, 1.04), { bevel, bevelSegments: 1 })
      : box(unit - gap, options.height, options.thickness * range(rng, 0.94, 1.04), { bevel, bevelSegments: 1 });
    if (horizontal) plank.translate(0, offset, warp);
    else plank.translate(offset, 0, warp);
    builder.add(plank);
  }

  if (options.battens) {
    const battenCount = options.width > options.height ? 2 : Math.max(2, Math.round(options.height / 0.9));
    for (let index = 0; index < battenCount; index += 1) {
      const t = battenCount === 1 ? 0.5 : index / (battenCount - 1);
      const depth = options.thickness * 0.55;
      const batten = horizontal
        ? box(options.width * 0.92, depth * 1.6, depth, { bevel: 0.006, bevelSegments: 1 })
        : box(depth * 1.6, options.height * 0.92, depth, { bevel: 0.006, bevelSegments: 1 });
      const along = horizontal ? options.height : options.width;
      const position = -along / 2 + along * (0.12 + t * 0.76);
      if (horizontal) batten.translate(0, position, -options.thickness / 2 - depth / 2);
      else batten.translate(position, 0, -options.thickness / 2 - depth / 2);
      builder.add(batten);
      if (options.studs) {
        const studs = Math.max(2, Math.round(along * 0.8 / 0.22));
        for (let stud = 0; stud < studs; stud += 1) {
          const along2 = -along * 0.4 + (along * 0.8 * stud) / Math.max(1, studs - 1);
          const head = cylinder(0.018, 0.022, 0.018, { radialSegments: 5 });
          head.rotateX(Math.PI / 2);
          if (horizontal) head.translate(along2, position, -options.thickness / 2 - depth + 0.004);
          else head.translate(position, along2, -options.thickness / 2 - depth + 0.004);
          builder.add(head);
        }
      }
    }
  }
  return builder;
}

/** A framed timber panel: stiles, rails and an infill, as in any real door. */
export function framedPanel(options: {
  width: number;
  height: number;
  frame?: number;
  thickness?: number;
  infill?: 'plank' | 'wattle' | 'solid' | 'none';
  seed?: number;
  panels?: number;
}): MeshBuilder {
  const rng = detailRng(options.seed ?? 61);
  const builder = new MeshBuilder();
  const frame = options.frame ?? Math.min(options.width, options.height) * 0.12;
  const thickness = options.thickness ?? 0.06;
  const innerWidth = Math.max(0.02, options.width - frame * 2);
  const innerHeight = Math.max(0.02, options.height - frame * 2);

  const member = { bevel: 0.006, bevelSegments: 1 };
  builder.add(box(options.width, frame, thickness, member).translate(0, options.height / 2 - frame / 2, 0));
  builder.add(box(options.width, frame, thickness, member).translate(0, -options.height / 2 + frame / 2, 0));
  builder.add(box(frame, innerHeight, thickness, member).translate(-options.width / 2 + frame / 2, 0, 0));
  builder.add(box(frame, innerHeight, thickness, member).translate(options.width / 2 - frame / 2, 0, 0));

  const panels = Math.max(1, Math.round(options.panels ?? (innerHeight > innerWidth * 1.4 ? 2 : 1)));
  for (let index = 0; index < panels; index += 1) {
    const panelHeight = innerHeight / panels;
    const y = -innerHeight / 2 + panelHeight * (index + 0.5);
    if (options.infill === 'none') continue;
    if (options.infill === 'plank') {
      const part = planks({ width: innerWidth, height: panelHeight, thickness: thickness * 0.6, count: Math.max(2, Math.round(innerWidth / 0.16)), seed: (options.seed ?? 61) + index * 13 });
      part.translate(0, y, 0);
      builder.add(part);
      continue;
    }
    if (options.infill === 'wattle') {
      // Wattle and daub: woven rods, the standard medieval infill.
      const rods = Math.max(3, Math.round(panelHeight / 0.11));
      for (let rod = 0; rod < rods; rod += 1) {
        const ry = y - panelHeight / 2 + (panelHeight * (rod + 0.5)) / rods;
        const stick = cylinder(0.016, 0.019, innerWidth * 0.98, { radialSegments: 5, caps: true, wobble: 0.08, wobbleSeed: rod + 3 });
        stick.rotateZ(Math.PI / 2);
        stick.translate(0, ry, range(rng, -0.008, 0.008));
        builder.add(stick);
      }
      for (let rod = 0; rod < Math.max(2, Math.round(innerWidth / 0.28)); rod += 1) {
        const rx = -innerWidth / 2 + (innerWidth * (rod + 0.5)) / Math.max(2, Math.round(innerWidth / 0.28));
        const stick = cylinder(0.014, 0.017, panelHeight * 0.96, { radialSegments: 5, wobble: 0.08, wobbleSeed: rod + 9 });
        stick.translate(rx, y, range(rng, -0.008, 0.008));
        builder.add(stick);
      }
      continue;
    }
    builder.add(box(innerWidth * 0.98, panelHeight * 0.96, thickness * 0.5, { bevel: 0.008 }).translate(0, y, 0));
  }
  return builder;
}

/* --------------------------------------------------------- fortification */

export interface CrenellationOptions {
  /** Length of the wall run along X. */
  length: number;
  /** Merlon height above the wall top. */
  height?: number;
  /** Merlon thickness along Z. */
  thickness?: number;
  merlon?: number;
  gap?: number;
  seed?: number;
  style?: 'square' | 'stepped' | 'pointed' | 'round';
  /** Cuts the walkway slots (crenels) into the merlon bases. */
  slots?: boolean;
}

/**
 * Battlements: alternating merlons and crenels along a wall top.
 *
 * The rhythm is what makes a castle read as a castle at any distance. Merlon and
 * gap widths follow the real ratio of about 1:1 with a merlon near 60 cm wide
 * and 70 cm high — cover for one person, a gap to shoot through.
 */
export function crenellations(options: CrenellationOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 71);
  const builder = new MeshBuilder();
  const length = Math.max(0.4, options.length);
  const height = Math.max(0.2, options.height ?? 0.7);
  const thickness = Math.max(0.1, options.thickness ?? 0.45);
  const merlon = options.merlon ?? 0.6;
  const gap = options.gap ?? 0.55;
  const unit = merlon + gap;
  const count = Math.max(1, Math.round(length / unit));
  const actualUnit = length / count;
  const merlonWidth = actualUnit * (merlon / unit);
  const style = options.style ?? 'square';

  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + actualUnit * (index + 0.5);
    const weather = range(rng, 0.94, 1.04);
    if (style === 'pointed') {
      const part = prism({ sides: 4, radius: merlonWidth * 0.62, height, topScale: 0.15, caps: true });
      part.scale(1, 1, thickness / (merlonWidth * 1.24));
      part.translate(x, 0, 0);
      builder.add(part);
      continue;
    }
    if (style === 'round') {
      const part = cylinder(merlonWidth * 0.5, merlonWidth * 0.55, height, { radialSegments: 12 });
      part.scale(1, 1, thickness / (merlonWidth * 1.1));
      part.translate(x, height / 2, 0);
      builder.add(part);
      continue;
    }
    if (style === 'stepped') {
      const lower = box(merlonWidth, height * 0.55, thickness, { bevel: 0.02 }).translate(x, height * 0.275, 0);
      const upper = box(merlonWidth * 0.66, height * 0.45, thickness * 0.92, { bevel: 0.02 }).translate(x, height * 0.775, 0);
      builder.add(lower);
      builder.add(upper);
      continue;
    }
    builder.add(box(merlonWidth * weather, height, thickness, { bevel: 0.025, bevelSegments: 1 }).translate(x, height / 2, 0));
  }
  if (options.slots) {
    // A narrow arrow slit in every other merlon: real defences, real shadows.
    for (let index = 0; index < count; index += 2) {
      const x = -length / 2 + actualUnit * (index + 0.5);
      // The slot is drawn as a dark recessed plate: cutting a real hole would
      // need a boolean, and nobody sees through an arrow slit at scene scale.
      const slot = box(0.09, height * 0.55, thickness * 0.2).translate(x, height * 0.5, thickness * 0.42);
      builder.add(slot);
    }
  }
  return builder;
}

/** A corbel: the bracket that carries a wall walk or a balcony out past the wall. */
export function corbel(options: { depth?: number; width?: number; height?: number; seed?: number } = {}): MeshBuilder {
  const depth = options.depth ?? 0.5;
  const width = options.width ?? 0.32;
  const height = options.height ?? 0.42;
  // A scroll profile: flat against the wall, curving out to carry the load.
  const profile: Vec2[] = [
    [-width / 2, 0],
    [width / 2, 0],
    [width / 2, height * 0.18],
    [width * 0.42, height * 0.42],
    [width * 0.3, height * 0.66],
    [width * 0.36, height * 0.88],
    [width * 0.36, height],
    [-width * 0.36, height],
    [-width * 0.36, height * 0.88],
    [-width * 0.3, height * 0.66],
    [-width * 0.42, height * 0.42],
    [-width / 2, height * 0.18],
  ];
  const part = extrude(profile, { depth, bevel: 0.015, bevelSegments: 1 });
  part.translate(0, 0, -depth / 2);
  return part;
}

/** A course of dentils or billets, the small repeating blocks under a cornice. */
export function dentils(options: { length: number; unit?: number; height?: number; depth?: number; gap?: number; budget?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.2, options.length);
  const unit = Math.max(0.06, options.unit ?? 0.16);
  const height = options.height ?? 0.12;
  const depth = options.depth ?? 0.14;
  const gap = options.gap ?? unit * 0.45;
  const wanted = Math.max(1, Math.round(length / unit));
  const count = planRepeatedUnits(wanted, BOX_TRIANGLES, options.budget ?? 900, 2).modeled;
  const step = length / count;
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + step * (index + 0.5);
    builder.add(box(step - gap, height, depth).translate(x, height / 2, depth / 2));
  }
  return builder;
}

/** A string course: the horizontal band that marks a floor line on a facade. */
export function stringCourse(options: { length: number; depth?: number; height?: number; seed?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.3, options.length);
  const depth = options.depth ?? 0.16;
  const height = options.height ?? 0.14;
  // Two members: a thinner projecting sill and a deeper fascia behind it, which
  // is how a string course throws the shadow line that marks a floor.
  builder.add(box(length, height * 0.55, depth * 0.7, { bevel: 0.012 }).translate(0, height * 0.275, depth * 0.15));
  builder.add(box(length, height * 0.45, depth, { bevel: 0.014 }).translate(0, height * 0.775, 0));
  return builder;
}

/* ------------------------------------------------------------------ roofs */

export type RoofStyle = 'pan' | 'shingle' | 'slate' | 'thatch';

export interface RoofPanelOptions {
  /** Width of the panel along X. */
  width: number;
  /** Length down the slope, along Z, measured on the slope. */
  slopeLength: number;
  style?: RoofStyle;
  seed?: number;
  /** Overhang past the eave, in metres. */
  overhang?: number;
  /** Tiles per metre across the width. */
  density?: number;
  /** Triangle budget; over it, the panel carries the texture and only the eave,
   * rake and ridge courses stay solid. */
  budget?: number;
}

/**
 * The underside of a roof bed: the same surface, turned over.
 *
 * A plane has one face. Roofs are seen from below — under an eave, from a
 * doorway, across a courtyard — and a roof with no underside is a hole from
 * there. Turning the same surface over costs its triangles twice and closes it.
 */
function soffitOf(width: number, run: number, segments: [number, number], height: (x: number, z: number) => number): MeshBuilder {
  const soffit = plane(width, run, { widthSegments: segments[0], heightSegments: segments[1], height });
  soffit.rotateZ(Math.PI);
  soffit.translate(0, 0, run / 2);
  return soffit;
}

/**
 * A roof panel laid in the XZ plane: ridge at z = 0, eave at z = slopeLength +
 * overhang, centred on x = 0. Callers pitch it with `rotateX` and mirror it for
 * the other side of a gable.
 *
 * `pan` alternates convex and concave barrel tiles the way Mediterranean pan
 * tiling does; `shingle` and `slate` overlap in courses so each unit casts a
 * shadow on the one below; `thatch` is a thick bundle surface with strands at the
 * eave. The caller pitches the panel with `rotateX` and mirrors it for the other
 * side of a gable — a roof made of two flat boxes never looks like a roof.
 */
export function roofPanel(options: RoofPanelOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 83);
  const builder = new MeshBuilder();
  const width = Math.max(0.3, options.width);
  const slopeLength = Math.max(0.3, options.slopeLength);
  const style = options.style ?? 'pan';
  const overhang = options.overhang ?? 0.12;
  const run = slopeLength + overhang;
  const budget = Math.max(120, options.budget ?? 1600);

  if (style === 'pan') {
    const tileWidth = 1 / Math.max(2, options.density ?? 7);
    const radius = tileWidth * 0.46;
    // A half-cylinder shell at seven segments is 14 triangles, and an over-tile
    // needs a two-triangle plate under it: still cheap enough that pan tiling
    // always stays solid.
    const count = Math.max(2, Math.min(Math.round(width / tileWidth), Math.floor(budget / 16)));
    const step = width / count;
    for (let index = 0; index < count; index += 1) {
      const x = -width / 2 + step * (index + 0.5);
      const up = index % 2 === 0;
      const length = run * range(rng, 0.985, 1.01);
      const tile = cylinder(radius, radius, length, { arc: Math.PI, caps: false, radialSegments: 7 });
      // rotateX(-90°) lays the shell's axis along Z with its crown facing +Y.
      tile.rotateX(-Math.PI / 2);
      if (up) {
        // An over-tile is a closed half-disc: the shell faces the sky and the
        // diameter plate faces the ground, so the roof is not a row of open
        // troughs with a hole in it when seen from under the eaves.
        const plate = plane(radius * 2, length, { orientation: 'xy' });
        plate.rotateY(Math.PI);
        plate.rotateX(-Math.PI / 2);
        plate.translate(x, radius, length / 2);
        builder.add(plate);
      } else {
        // An under-tile is the same shell turned inside out. Mirroring in Y drops
        // the crown into a trough and takes the winding with it, so the surface
        // you look down into faces you — a rotation would turn it away and the
        // renderer would cull the trough from view.
        tile.mirror('y');
      }
      tile.translate(x, radius, length / 2);
      builder.add(tile);
    }
    return builder;
  }

  if (style === 'thatch') {
    const thickness = 0.16;
    const bedSegments: [number, number] = [
      Math.max(2, Math.min(8, Math.round(width / 1.2))),
      Math.max(2, Math.min(8, Math.round(run / 1.2))),
    ];
    const bedHeight = (x: number, z: number): number =>
      thickness * 0.5 + Math.sin(x * 22) * 0.012 + Math.sin((z + x * 0.4) * 17) * 0.014;
    const base = plane(width, run, { widthSegments: bedSegments[0], heightSegments: bedSegments[1], height: bedHeight });
    base.translate(0, 0, run / 2);
    builder.add(base);
    builder.add(soffitOf(width, run, bedSegments, bedHeight));
    // Strands hanging over the eave, cut unevenly as a thatcher's knife does.
    const strands = planRepeatedUnits(Math.max(8, Math.round(width / 0.14)), 16, budget - 120, 8).modeled;
    for (let index = 0; index < strands; index += 1) {
      const x = -width / 2 + (width * (index + 0.5)) / strands;
      const length = range(rng, 0.08, 0.24);
      const strand = cylinder(0.011, 0.006, length, { radialSegments: 4 });
      strand.rotateX(range(rng, 0.9, 1.35));
      strand.translate(x, range(rng, -0.02, 0.03), run + range(rng, -0.06, 0.04));
      builder.add(strand);
    }
    return builder;
  }

  // Shingles and slates. An 8 × 5 m roof holds sixteen hundred of them, so the
  // honest answer is a single sloped panel carrying the shingle normal map, with
  // real units only where the eye checks the silhouette: the eave course, the
  // rake edges and the ridge. Past two metres that is indistinguishable, and it
  // costs a twentieth of the triangles.
  const courseHeight = style === 'slate' ? 0.22 : 0.18;
  const unitWidth = style === 'slate' ? 0.26 : 0.14;
  const courses = Math.max(2, Math.round(run / courseHeight));
  const actualCourse = run / courses;
  const overlap = actualCourse * 0.42;
  const thickness = style === 'slate' ? 0.022 : 0.014;
  const columns = Math.max(2, Math.round(width / unitWidth));
  const step = width / columns;
  const totalUnits = courses * columns;
  const plan = planRepeatedUnits(totalUnits, BOX_TRIANGLES, budget, 0);

  if (plan.textured) {
    const bedSegments: [number, number] = [Math.max(2, Math.round(width / 1.5)), Math.max(3, Math.round(run / 1.2))];
    const bedHeight = (): number => thickness * 0.5;
    const bed = plane(width, run, { widthSegments: bedSegments[0], heightSegments: bedSegments[1], height: bedHeight });
    // The bed runs from the ridge (z = 0) out past the eave; putting the
    // overhang at the ridge end would leave the eave short of the wall line.
    bed.translate(0, 0, run / 2);
    builder.add(bed);
    // The bed's soffit is what you see standing under the eave: without it the
    // roof is a hole from below.
    builder.add(soffitOf(width, run, bedSegments, bedHeight));
    // Solid courses at the eave and along both rakes, where they are seen edge on.
    const solidCourses = Math.max(1, Math.min(3, Math.floor(budget / (BOX_TRIANGLES * columns * 3))));
    for (let course = 0; course < solidCourses; course += 1) {
      const z = actualCourse * course + actualCourse / 2;
      for (let column = 0; column < columns; column += 1) {
        const x = -width / 2 + step * (column + 0.5) + (course % 2) * step * 0.25;
        const unit = box(step * 0.94, thickness, actualCourse + overlap);
        unit.rotateX(range(rng, -0.03, 0.06));
        unit.translate(x, thickness / 2 + course * thickness * 0.4, z);
        builder.add(unit);
      }
    }
    const rakeUnits = Math.max(2, Math.min(courses, Math.floor((budget - builder.triangleCount * 3) / (BOX_TRIANGLES * 2))));
    for (let course = 0; course < courses; course += Math.max(1, Math.floor(courses / rakeUnits))) {
      const z = actualCourse * course + actualCourse / 2;
      for (const side of [-1, 1]) {
        const unit = box(step * 0.94, thickness, actualCourse + overlap);
        unit.rotateX(range(rng, -0.03, 0.06));
        unit.translate(side * (width / 2 - step / 2), thickness / 2 + course * thickness * 0.4, z);
        builder.add(unit);
      }
    }
    return builder;
  }

  for (let course = 0; course < courses; course += 1) {
    const z = actualCourse * course + actualCourse / 2;
    const stagger = (course % 2) * step * 0.5;
    for (let column = 0; column < columns; column += 1) {
      const x = -width / 2 + step * (column + 0.5) + stagger * (column % 2 === 0 ? 1 : -1) * 0.5;
      const unit = box(step * 0.94, thickness, actualCourse + overlap);
      // Each unit tilts a hair, so light catches them differently.
      unit.rotateX(range(rng, -0.03, 0.05));
      unit.rotateZ(range(rng, -0.012, 0.012));
      unit.translate(x, thickness / 2 + course * thickness * 0.35 + range(rng, 0, 0.004), z);
      builder.add(unit);
    }
  }
  return builder;
}

/** A ridge cap: the row of half-round tiles that closes the top of a gable. */
export function ridgeCap(options: { length: number; radius?: number; seed?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 89);
  const builder = new MeshBuilder();
  const length = Math.max(0.3, options.length);
  const radius = options.radius ?? 0.13;
  const count = Math.max(2, Math.round(length / (radius * 2.1)));
  const step = length / count;
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + step * (index + 0.5);
    const tile = cylinder(radius, radius * 0.96, step * 1.12, { arc: Math.PI, caps: false, radialSegments: 8 });
    tile.rotateZ(Math.PI / 2);
    tile.rotateY(Math.PI / 2);
    tile.translate(x, radius * 0.2, range(rng, -0.01, 0.01));
    builder.add(tile);
  }
  return builder;
}

/* ------------------------------------------------------------- openings */

export interface DoorOptions {
  width: number;
  height: number;
  thickness?: number;
  seed?: number;
  /** 'plank' boards, 'frame' a panelled door, 'iron' a studded door. */
  style?: 'plank' | 'frame' | 'iron' | 'arched';
  /** Adds hinges and a handle ring. */
  hardware?: boolean;
}

/** A door leaf with boards, battens, hinges and a handle ring. */
export function door(options: DoorOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 97);
  const builder = new MeshBuilder();
  const width = Math.max(0.3, options.width);
  const height = Math.max(0.6, options.height);
  const thickness = options.thickness ?? 0.07;
  const style = options.style ?? 'plank';

  if (style === 'arched') {
    // A boarded door under a round head: the arch is cut from a solid slab.
    const radius = width / 2;
    const straight = Math.max(0.05, height - radius);
    const body = box(width, straight, thickness, { bevel: 0.01 }).translate(0, straight / 2, 0);
    builder.add(body);
    const head = cylinder(radius, radius, thickness, { arc: Math.PI, radialSegments: 14, caps: false });
    head.rotateX(Math.PI / 2);
    head.translate(0, straight, 0);
    builder.add(head);
    const boards = Math.max(3, Math.round(width / 0.18));
    const boardPlan = planRepeatedUnits(boards, BOX_TRIANGLES, 380, 3);
    const boardCount = boardPlan.modeled;
    for (let index = 0; index < boardCount; index += 1) {
      const x = -width / 2 + (width * (index + 0.5)) / boardCount;
      const board = box(width / boardCount - 0.014, straight * 0.98, thickness * 0.24);
      board.translate(x, straight / 2, thickness / 2 + thickness * 0.1);
      builder.add(board);
    }
  } else if (style === 'frame') {
    const panel = framedPanel({ width, height, thickness, infill: 'plank', seed: options.seed ?? 97, panels: height > 1.6 ? 2 : 1 });
    panel.translate(0, height / 2, 0);
    builder.add(panel);
  } else if (style === 'iron') {
    builder.add(box(width, height, thickness * 0.6, { bevel: 0.008 }).translate(0, height / 2, 0));
    // Studs are the classic case of a detail that reads as a pattern: twenty of
    // them say "studded door" just as well as eighty, at a quarter of the cost.
    const wantedRows = Math.max(3, Math.round(height / 0.22));
    const wantedColumns = Math.max(3, Math.round(width / 0.2));
    const studs = planRepeatedUnits(wantedRows * wantedColumns, 20, 700, 12);
    const rows = Math.max(2, Math.round(Math.sqrt(studs.modeled * (wantedRows / wantedColumns))));
    const columns = Math.max(2, Math.round(studs.modeled / rows));
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = -width / 2 + (width * (column + 0.5)) / columns + (row % 2 ? width / columns / 2 : 0);
        if (Math.abs(x) > width / 2 - 0.04) continue;
        const y = (height * (row + 0.5)) / rows;
        const stud = sphere(0.028, { widthSegments: 5, heightSegments: 3 });
        stud.scale(1, 1, 0.6);
        stud.translate(x, y, thickness * 0.32);
        builder.add(stud);
      }
    }
    for (const y of [height * 0.18, height * 0.82]) {
      const band = box(width * 0.98, 0.09, thickness * 0.3, { bevel: 0.01, bevelSegments: 1 }).translate(0, y, thickness * 0.28);
      builder.add(band);
    }
  } else {
    const part = planks({ width, height, thickness, count: Math.max(3, Math.round(width / 0.16)), battens: true, studs: true, seed: options.seed ?? 97 });
    part.translate(0, height / 2, 0);
    builder.add(part);
  }

  if (options.hardware !== false) {
    const hingeOffset = thickness * 0.5 + 0.01;
    for (const y of [height * 0.2, height * 0.8]) {
      const hinge = box(width * 0.42, 0.055, 0.02, { bevel: 0.006, bevelSegments: 1 }).translate(-width * 0.28, y, hingeOffset);
      builder.add(hinge);
      const pin = cylinder(0.018, 0.018, 0.12, { radialSegments: 6 }).translate(-width / 2 + 0.02, y, hingeOffset);
      builder.add(pin);
    }
    const ring = torus(0.055, 0.012, { radialSegments: 6, tubularSegments: 12 });
    ring.rotateX(Math.PI / 2);
    ring.translate(width * 0.32, height * 0.5, hingeOffset + 0.03);
    builder.add(ring);
    const plate = cylinder(0.045, 0.045, 0.016, { radialSegments: 10 });
    plate.rotateX(Math.PI / 2);
    plate.translate(width * 0.32, height * 0.5, hingeOffset + 0.005);
    builder.add(plate);
    void rng;
  }
  return builder;
}

export interface WindowOptions {
  width: number;
  height: number;
  depth?: number;
  seed?: number;
  style?: 'mullion' | 'arched' | 'slit' | 'shutter' | 'lattice';
  mullions?: number;
  transoms?: number;
  /** Adds a projecting sill and a lintel head. */
  surround?: boolean;
  glass?: boolean;
}

/**
 * A window: reveal, mullions, transoms, sill and lintel.
 *
 * Windows are where a facade is judged. A dark rectangle reads as a hole; a
 * recessed opening with a mullion, a sill that throws a shadow and a lintel that
 * carries the wall reads as a building people live in.
 */
export function windowUnit(options: WindowOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.2, options.width);
  const height = Math.max(0.25, options.height);
  const depth = options.depth ?? 0.22;
  const style = options.style ?? 'mullion';
  const frame = Math.min(width, height) * 0.09;

  if (style === 'slit') {
    // An arrow slit: splayed inward so a defender could shoot across a wide arc.
    const outer = box(width, height, depth, { bevel: 0.01 });
    builder.add(outer);
    return builder;
  }

  // Reveal: the frame of the opening itself.
  builder.add(box(width + frame * 2, frame, depth, { bevel: 0.008 }).translate(0, height / 2 + frame / 2, 0));
  builder.add(box(width + frame * 2, frame, depth, { bevel: 0.008 }).translate(0, -height / 2 - frame / 2, 0));
  builder.add(box(frame, height, depth, { bevel: 0.008 }).translate(-width / 2 - frame / 2, 0, 0));
  builder.add(box(frame, height, depth, { bevel: 0.008 }).translate(width / 2 + frame / 2, 0, 0));

  const mullions = options.mullions ?? (style === 'lattice' ? 2 : width > 0.9 ? 1 : 0);
  const transoms = options.transoms ?? (height > 1.3 ? 1 : 0);
  for (let index = 1; index <= mullions; index += 1) {
    const x = -width / 2 + (width * index) / (mullions + 1);
    builder.add(box(width * 0.055, height, depth * 0.6, { bevel: 0.006 }).translate(x, 0, 0));
  }
  for (let index = 1; index <= transoms; index += 1) {
    const y = -height / 2 + (height * index) / (transoms + 1);
    builder.add(box(width, height * 0.05, depth * 0.6, { bevel: 0.006 }).translate(0, y, 0));
  }

  if (style === 'lattice') {
    const cells = planRepeatedUnits(Math.max(3, Math.round(width / 0.12)), BOX_TRIANGLES, 500, 3).modeled;
    for (let index = 0; index <= cells; index += 1) {
      const x = -width / 2 + (width * index) / cells;
      builder.add(box(0.018, height, depth * 0.24).translate(x, 0, 0));
    }
    const rows = planRepeatedUnits(Math.max(3, Math.round(height / 0.12)), BOX_TRIANGLES, 500, 3).modeled;
    for (let index = 0; index <= rows; index += 1) {
      const y = -height / 2 + (height * index) / rows;
      builder.add(box(width, 0.018, depth * 0.24).translate(0, y, 0));
    }
  }

  if (style === 'arched') {
    const radius = width / 2 + frame;
    const head = cylinder(radius, radius, depth, { arc: Math.PI, radialSegments: 14, caps: false });
    head.rotateX(Math.PI / 2);
    head.translate(0, height / 2 + frame, 0);
    builder.add(head);
  }

  if (style === 'shutter') {
    for (const side of [-1, 1]) {
      const shutter = planks({ width: width * 0.62, height: height * 1.04, thickness: 0.04, count: 3, battens: true, seed: 101 });
      shutter.rotateY(side * 0.9);
      shutter.translate(side * (width / 2 + width * 0.28), 0, depth * 0.55);
      builder.add(shutter);
    }
  }

  if (options.glass !== false) {
    const pane = box(width * 0.98, height * 0.98, 0.012).translate(0, 0, -depth * 0.12);
    builder.add(pane);
  }

  if (options.surround) {
    const sill = box(width + frame * 4.4, frame * 0.9, depth * 1.5, { bevel: 0.012 }).translate(0, -height / 2 - frame * 1.2, depth * 0.22);
    builder.add(sill);
    const lintel = box(width + frame * 4, frame * 1.3, depth * 1.1, { bevel: 0.014 }).translate(0, height / 2 + frame * 1.4, depth * 0.1);
    builder.add(lintel);
  }
  return builder;
}

/* ---------------------------------------------------------------- stairs */

export interface StairsOptions {
  steps: number;
  rise?: number;
  tread?: number;
  width?: number;
  /** Adds side walls or a balustrade. */
  sides?: 'none' | 'wall' | 'rail';
  seed?: number;
  /** Spiral stairs inside a tower, rising around a central newel. */
  spiral?: { radius: number; turn?: number };
}

/** Straight or spiral stairs with real treads, nosings and side walls. */
export function stairs(options: StairsOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 109);
  const builder = new MeshBuilder();
  const steps = Math.max(1, Math.round(options.steps));
  const rise = options.rise ?? 0.17;
  const tread = options.tread ?? 0.28;
  const width = options.width ?? 1;

  if (options.spiral) {
    const radius = Math.max(0.5, options.spiral.radius);
    const turn = options.spiral.turn ?? Math.PI / 2;
    const newel = cylinder(radius * 0.22, radius * 0.24, steps * rise + 0.3, { radialSegments: 10 });
    newel.translate(0, (steps * rise + 0.3) / 2, 0);
    builder.add(newel);
    for (let index = 0; index < steps; index += 1) {
      const angle = turn * index;
      const step = box(radius - radius * 0.22, rise, tread, { bevel: 0.012 });
      step.translate(radius * 0.22 + (radius - radius * 0.22) / 2, rise * (index + 0.5), 0);
      step.rotateY(angle);
      builder.add(step);
    }
    return builder;
  }

  for (let index = 0; index < steps; index += 1) {
    const y = rise * index;
    const z = tread * index;
    // Each tread is a block that reaches back to the ground: a real stair is a
    // solid stepped mass, not floating planks.
    const block = box(width, rise, tread).translate(0, y + rise / 2, z + tread / 2);
    builder.add(block);
    if (index === steps - 1) continue;
    const nosing = box(width * 1.01, rise * 0.22, tread * 0.16, { bevel: 0.008, bevelSegments: 1 }).translate(0, y + rise * 0.9, z + tread * 1.02);
    builder.add(nosing);
  }

  if (options.sides === 'wall') {
    for (const side of [-1, 1]) {
      for (let index = 0; index < steps; index += 1) {
        const height = rise * (index + 1) + 0.75;
        const wall = box(0.22, height, tread).translate(side * (width / 2 + 0.11), height / 2, tread * index + tread / 2);
        builder.add(wall);
      }
      // A sloped coping follows the pitch instead of stepping.
      const pitch = Math.atan2(rise, tread);
      const length = Math.hypot(rise * steps, tread * steps);
      const coping = box(0.26, 0.12, length, { bevel: 0.02 });
      coping.rotateX(-pitch);
      coping.translate(side * (width / 2 + 0.11), rise * steps / 2 + 0.8, tread * steps / 2);
      builder.add(coping);
    }
  }
  if (options.sides === 'rail') {
    for (const side of [-1, 1]) {
      const pitch = Math.atan2(rise, tread);
      const length = Math.hypot(rise * steps, tread * steps);
      const rail = box(0.07, 0.09, length + 0.2, { bevel: 0.02 });
      rail.rotateX(-pitch);
      rail.translate(side * (width / 2 - 0.04), rise * steps / 2 + 0.95, tread * steps / 2);
      builder.add(rail);
      const posts = Math.max(2, Math.round(steps / 3));
      for (let index = 0; index <= posts; index += 1) {
        const t = index / posts;
        const post = cylinder(0.03, 0.035, 0.95, { radialSegments: 6 });
        post.translate(side * (width / 2 - 0.04), rise * steps * t + 0.475, tread * steps * t);
        builder.add(post);
      }
    }
  }
  void rng;
  return builder;
}

/* ------------------------------------------------------------ fastenings */

/** A barrel hoop or a tyre band: a ring with rivets around it. */
export function hoopBand(options: { radius: number; tube?: number; width?: number; rivets?: number; seed?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const radius = Math.max(0.03, options.radius);
  const tube = options.tube ?? radius * 0.055;
  const width = options.width ?? tube * 2.6;
  const band = cylinder(radius + tube, radius + tube, width, { radialSegments: 14, heightSegments: 1, caps: false });
  builder.add(band);
  const rivets = Math.max(0, Math.round(options.rivets ?? 8));
  for (let index = 0; index < rivets; index += 1) {
    const angle = (index / rivets) * Math.PI * 2;
    const head = sphere(tube * 0.8, { widthSegments: 5, heightSegments: 3 });
    head.scale(1, 0.7, 1);
    head.translate(Math.cos(angle) * (radius + tube * 1.4), width * 0.28, Math.sin(angle) * (radius + tube * 1.4));
    builder.add(head);
  }
  return builder;
}

/** A row of rivets or studs along a straight line, for plate and door studs. */
export function rivetRow(options: { length: number; count?: number; radius?: number; spacing?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.05, options.length);
  const radius = options.radius ?? 0.018;
  const count = Math.max(2, Math.round(options.count ?? length / (options.spacing ?? 0.12)));
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + (length * (index + 0.5)) / count;
    const head = sphere(radius, { widthSegments: 6, heightSegments: 4 });
    head.scale(1, 1, 0.65);
    head.translate(x, 0, 0);
    builder.add(head);
  }
  return builder;
}

export interface RopeOptions {
  /** Spine the rope follows, in metres. */
  path: readonly Vec3[];
  radius?: number;
  /** Number of strands twisted together. */
  strands?: number;
  /** Turns per metre along the rope. */
  twist?: number;
  segments?: number;
}

/**
 * A twisted rope along a path.
 *
 * The section is a circle with `strands` bumps rolled around the spine as it
 * advances, which is exactly how a laid rope is made — and it reads correctly
 * even at a few pixels across.
 */
export function rope(options: RopeOptions): MeshBuilder {
  const radius = Math.max(0.005, options.radius ?? 0.03);
  const strands = Math.max(2, Math.round(options.strands ?? 3));
  const twist = options.twist ?? 6;
  const path = resamplePath(options.path, options.segments ?? 8);
  let travelled = 0;
  const distances = path.map((point, index) => {
    if (index === 0) return 0;
    const previous = path[index - 1]!;
    travelled += Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
    return travelled;
  });
  return sweep(path, {
    texel: radius * 6,
    section: (t, frame: Frame) => {
      const distance = distances[Math.round(t * (distances.length - 1))] ?? t * travelled;
      const roll = distance * twist * Math.PI * 2;
      const points = strands * 6;
      const section: Vec2[] = [];
      for (let index = 0; index < points; index += 1) {
        const angle = (index / points) * Math.PI * 2;
        const bump = 1 + 0.22 * Math.cos(angle * strands + roll);
        section.push([Math.cos(angle) * radius * bump, Math.sin(angle) * radius * bump]);
      }
      void frame;
      return section;
    },
    caps: true,
  });
}

function resamplePath(path: readonly Vec3[], segments: number): Vec3[] {
  if (path.length < 2) return [...path];
  const out: Vec3[] = [];
  const steps = Math.max(1, Math.round(segments / (path.length - 1)));
  for (let index = 0; index + 1 < path.length; index += 1) {
    const a = path[index]!;
    const b = path[index + 1]!;
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  out.push([...path[path.length - 1]!] as Vec3);
  return out;
}

export interface ChainOptions {
  from: Vec3;
  to: Vec3;
  /** Link length in metres. */
  link?: number;
  radius?: number;
  /** Sag as a fraction of the span; 0 pulls the chain straight. */
  sag?: number;
}

/**
 * A hanging chain: real links, alternating 90°, on a catenary.
 *
 * Used for drawbridges, well sweeps, chandeliers, moored boats and portcullis
 * lifts. A cylinder between two points reads as a pipe; links read as a chain.
 */
export function chain(options: ChainOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const link = Math.max(0.04, options.link ?? 0.14);
  const radius = options.radius ?? link * 0.16;
  const sag = options.sag ?? 0.12;
  const [ax, ay, az] = options.from;
  const [bx, by, bz] = options.to;
  const span = Math.hypot(bx - ax, by - ay, bz - az);
  const count = Math.max(2, Math.round(span / link));
  const drop = span * sag;
  for (let index = 0; index < count; index += 1) {
    const t0 = index / count;
    const t1 = (index + 1) / count;
    const at = (t: number): Vec3 => {
      // A parabola is close enough to a catenary at these spans and stays flat.
      const sagAmount = 4 * drop * t * (1 - t);
      return [ax + (bx - ax) * t, ay + (by - ay) * t - sagAmount, az + (bz - az) * t];
    };
    const start = at(t0);
    const end = at(t1);
    const mid: Vec3 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    const ring = torus(length * 0.5, radius, { radialSegments: 4, tubularSegments: 8 });
    // Torus lies in the XZ plane; stand it up, then aim it along the link.
    ring.scale(1, 1, 0.62);
    ring.rotateX(Math.PI / 2);
    const direction = new THREE.Vector3(end[0] - start[0], end[1] - start[1], end[2] - start[2]).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    if (index % 2 === 1) quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
    ring.transform(new THREE.Matrix4().compose(new THREE.Vector3(...mid), quaternion, new THREE.Vector3(1, 1, 1)));
    builder.add(ring);
  }
  return builder;
}

/* --------------------------------------------------------------- foliage */

export interface BladeOptions {
  /** Length from base to tip, in metres. */
  length: number;
  /** Widest half-width, in metres. */
  width: number;
  /** Where along the length the blade is widest, 0 = base, 1 = tip. */
  widest?: number;
  /** Camber across the blade, so it cups instead of lying flat. */
  camber?: number;
  /** Bend down (or up) along the length. */
  droop?: number;
  /** Twist along the length, in radians. */
  twist?: number;
  segments?: number;
  /** Crosswise divisions; 2 is enough for a leaf seen at arm's length. */
  across?: number;
  /** Cuts the outline into lobes, for oak and maple leaves. */
  lobes?: number;
  lobeDepth?: number;
  /** Serrates the edge, for nettles and rose leaves. */
  serrate?: number;
}

/**
 * One leaf, feather, petal, fin or flag.
 *
 * A single routine covers all of them because they are the same object: a
 * surface whose half-width follows a profile, with a midrib ridge, a camber
 * across it and a droop along it. Lobes and serration cut the outline. The front
 * face is +Z, so callers pitch and roll it into place, and the material should be
 * two-sided.
 */
export function blade(options: BladeOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.01, options.length);
  const width = Math.max(0.005, options.width);
  const widest = Math.min(0.9, Math.max(0.05, options.widest ?? 0.35));
  const camber = options.camber ?? 0.35;
  const droop = options.droop ?? 0;
  const twist = options.twist ?? 0;
  const segments = Math.max(3, Math.round(options.segments ?? 8));
  const lobes = Math.max(0, Math.round(options.lobes ?? 0));
  const lobeDepth = options.lobeDepth ?? 0.35;
  const serrate = Math.max(0, options.serrate ?? 0);

  const halfWidthAt = (t: number): number => {
    // A leaf profile: out of the base, widest at `widest`, tapering to a point.
    const base = t < widest
      ? Math.pow(t / widest, 0.62)
      : Math.pow(1 - (t - widest) / (1 - widest), 0.85);
    let outline = Math.max(0, base);
    if (lobes > 0) {
      const lobe = Math.abs(Math.sin(t * Math.PI * lobes));
      outline *= 1 - lobeDepth * (1 - lobe) * Math.sin(t * Math.PI);
    }
    if (serrate > 0) {
      outline *= 1 - serrate * 0.5 * (Math.sin(t * Math.PI * 18) > 0 ? 1 : 0.4);
    }
    return outline * width;
  };

  const across = Math.max(2, Math.round(options.across ?? 4));
  const grid: number[][] = [];
  for (let row = 0; row <= segments; row += 1) {
    const t = row / segments;
    const y = t * length;
    const half = halfWidthAt(t);
    const ridge = (1 - Math.pow(2 * t - 1, 2)) * width * 0.22;
    const droopAmount = -droop * Math.pow(t, 1.8) * length;
    const roll = twist * t;
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const line: number[] = [];
    for (let column = 0; column <= across; column += 1) {
      const u = column / across;
      const localX = (u * 2 - 1) * half;
      // Camber: the blade cups away from the midrib, which is what a leaf does.
      const localZ = ridge * (1 - Math.pow(u * 2 - 1, 2)) - camber * half * Math.pow(Math.abs(u * 2 - 1), 1.7);
      const x = localX * cos - localZ * sin;
      const z = localX * sin + localZ * cos + droopAmount;
      line.push(builder.vertex(
        [x, y, z],
        [u * half * 2 * 4, t * length * 4],
        [0, 0, 1],
      ));
    }
    grid.push(line);
  }
  const halfAt = (row: number): number => halfWidthAt(row / segments);
  for (let row = 0; row < segments; row += 1) {
    // A leaf tapers to a point at both ends, so the first and last rows collapse
    // onto the midrib: emit one triangle there, not two zero-area slivers.
    const startCollapsed = halfAt(row) < 1e-5;
    const endCollapsed = halfAt(row + 1) < 1e-5;
    if (startCollapsed && endCollapsed) continue;
    for (let column = 0; column < across; column += 1) {
      const a = grid[row]![column]!;
      const b = grid[row]![column + 1]!;
      const c = grid[row + 1]![column + 1]!;
      const d = grid[row + 1]![column]!;
      // Rows climb and columns run left to right, so x̂ × ŷ = +ẑ faces the front.
      if (!startCollapsed) builder.triangle(a, b, c);
      if (!endCollapsed) builder.triangle(a, c, d);
    }
  }
  builder.computeNormals();
  return builder;
}

export interface LeafClusterOptions {
  radius: number;
  leaves?: number;
  seed?: number;
  length?: number;
  width?: number;
  /** Clumps leaves into lobes instead of a uniform ball. */
  clumps?: number;
}

/**
 * A cluster of individual leaves arranged on a sphere.
 *
 * Canopies are the hardest thing to fake: a green ball reads as a ball. Real
 * foliage is a cloud of separate blades catching light at every angle, so this
 * scatters actual leaves, each tilted outward and rolled at random.
 */
export function leafCluster(options: LeafClusterOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 127);
  const builder = new MeshBuilder();
  const radius = Math.max(0.1, options.radius);
  // A canopy reads as a cloud of separate blades, but each one costs triangles.
  // Forty leaves at 24 triangles is a thousand, which is what a tree crown can
  // afford inside a whole asset budget.
  const leaves = Math.max(6, Math.round(options.leaves ?? Math.min(64, Math.max(16, radius * 34))));
  const length = options.length ?? radius * 0.42;
  const width = options.width ?? length * 0.55;
  const clumps = Math.max(1, Math.round(options.clumps ?? 4));
  const clumpCentres: Vec3[] = Array.from({ length: clumps }, () => {
    const direction = randomDirection(rng);
    return [direction[0] * radius * 0.4, direction[1] * radius * 0.4, direction[2] * radius * 0.4];
  });
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let index = 0; index < leaves; index += 1) {
    // A Fibonacci sphere, then pulled toward the nearest clump centre so the
    // crown has lobes rather than an even shell.
    const t = (index + 0.5) / leaves;
    const phi = Math.acos(1 - 2 * t);
    const theta = golden * index;
    let direction: Vec3 = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
    const clump = clumpCentres[index % clumps]!;
    const pull = 0.35;
    direction = [
      direction[0] * (1 - pull) + (clump[0] / radius) * pull,
      direction[1] * (1 - pull) + (clump[1] / radius) * pull,
      direction[2] * (1 - pull) + (clump[2] / radius) * pull,
    ];
    const distance = radius * range(rng, 0.62, 1.06);
    const normalised = new THREE.Vector3(...direction).normalize();
    const leaf = blade({
      length: length * range(rng, 0.75, 1.3),
      width: width * range(rng, 0.8, 1.2),
      camber: range(rng, 0.2, 0.6),
      droop: range(rng, -0.1, 0.35),
      lobes: chance(rng, 0.3) ? intRange(rng, 2, 4) : 0,
      segments: 4,
      across: 2,
    });
    // Aim the leaf's +Y (its length) outward, then roll it about that axis.
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalised);
    quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), range(rng, 0, Math.PI * 2)));
    leaf.transform(new THREE.Matrix4().compose(
      new THREE.Vector3(normalised.x * distance, normalised.y * distance, normalised.z * distance),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    ));
    builder.add(leaf);
  }
  return builder;
}

function randomDirection(rng: Rng): Vec3 {
  const z = range(rng, -1, 1);
  const angle = range(rng, 0, Math.PI * 2);
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  return [Math.cos(angle) * radius, z, Math.sin(angle) * radius];
}

/** A feathered surface: a shaft with barbs, for wings, tails and plumes. */
export function feather(options: { length: number; width?: number; curve?: number; seed?: number; barbs?: boolean }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.05, options.length);
  const width = options.width ?? length * 0.28;
  const vane = blade({
    length,
    width,
    widest: 0.32,
    camber: 0.5,
    droop: options.curve ?? 0.18,
    segments: 9,
  });
  builder.add(vane);
  const shaft = sweep([[0, 0, 0], [0, length * 0.55, width * 0.1], [0, length, (options.curve ?? 0.18) * length * 0.4]], {
    texel: 0.1,
    section: (t) => {
      const radius = width * 0.06 * (1 - t * 0.7) + width * 0.012;
      const points: Vec2[] = [];
      for (let index = 0; index < 6; index += 1) {
        const angle = (index / 6) * Math.PI * 2;
        points.push([Math.cos(angle) * radius, Math.sin(angle) * radius * 0.8]);
      }
      return points;
    },
    caps: true,
  });
  builder.add(shaft);
  if (options.barbs !== false) {
    const count = Math.max(4, Math.round(length / 0.06));
    for (let index = 0; index < count; index += 1) {
      const t = (index + 0.5) / count;
      const half = width * Math.pow(Math.sin(t * Math.PI), 0.5) * 0.9;
      for (const side of [-1, 1]) {
        const barb = box(half, 0.006, 0.004);
        barb.rotateZ(side * 0.5);
        barb.translate(side * half / 2, t * length, width * 0.06 * side);
        builder.add(barb);
      }
    }
  }
  return builder;
}

/** A wing: a membrane of feathers fanned from a shoulder point. */
export function wing(options: { span: number; chord?: number; feathers?: number; seed?: number; droop?: number; membrane?: boolean }): MeshBuilder {
  const rng = detailRng(options.seed ?? 131);
  const builder = new MeshBuilder();
  const span = Math.max(0.2, options.span);
  const chord = options.chord ?? span * 0.42;
  const feathers = Math.max(4, Math.round(options.feathers ?? Math.max(6, span / 0.18)));
  for (let index = 0; index < feathers; index += 1) {
    const t = index / (feathers - 1);
    // Primaries are longest at the wrist, coverts shortest at the body.
    const length = chord * (0.55 + 0.75 * Math.sin(Math.PI * (0.25 + t * 0.6))) * range(rng, 0.94, 1.06);
    const featherPart = feather({ length, width: length * 0.22, curve: 0.24 + t * 0.2, seed: (options.seed ?? 131) + index * 7, barbs: length > 0.2 });
    featherPart.rotateZ(-Math.PI / 2 + (t - 0.5) * 0.55);
    featherPart.rotateY((t - 0.5) * 0.5 - (options.droop ?? 0));
    featherPart.translate(t * span, -t * t * span * (options.droop ?? 0.06), (t - 0.5) * chord * 0.1);
    builder.add(featherPart);
  }
  if (options.membrane !== false) {
    const skin = plane(span, chord, {
      widthSegments: Math.max(3, feathers),
      heightSegments: 3,
      height: (x, z) => -Math.pow(Math.abs(z) / (chord / 2), 2) * chord * 0.06 - Math.pow(x / span, 2) * span * (options.droop ?? 0.06),
    });
    skin.rotateZ(0);
    skin.translate(span / 2, 0, 0);
    builder.add(skin);
  }
  return builder;
}

/* ------------------------------------------------------------ trunks/wood */

export interface TrunkOptions {
  height: number;
  radiusBottom: number;
  radiusTop?: number;
  seed?: number;
  /** Depth of the bark fissures, as a fraction of the radius. */
  fissures?: number;
  /** Adds a flared base, which is what makes a tree look rooted. */
  rootFlare?: number;
  segments?: number;
  /** Vertical divisions; six is plenty for a trunk. */
  stations?: number;
  /** Number of buttress roots for tropical species. */
  buttress?: number;
}

/**
 * A trunk with entasis, bark fissures and a root flare.
 *
 * Three details carry a tree: the trunk must taper in a curve rather than a cone,
 * it must widen at the ground, and its bark must be broken by deep vertical
 * fissures. Without them, a cylinder with a brown texture is a pole.
 */
export function trunk(options: TrunkOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 139);
  const height = Math.max(0.2, options.height);
  const radiusBottom = Math.max(0.02, options.radiusBottom);
  const radiusTop = Math.max(0.005, options.radiusTop ?? radiusBottom * 0.55);
  const flare = options.rootFlare ?? 0.45;
  const segments = Math.max(5, Math.round(options.segments ?? 9));
  const stations = Math.max(4, Math.round(options.stations ?? 7));
  const profile: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    // Entasis: a concave taper, wider at the foot, as a growing trunk is.
    const taper = Math.pow(1 - t, 0.62);
    const flareAmount = 1 + flare * Math.pow(1 - Math.min(1, t / 0.22), 2.4);
    profile.push([
      Math.max(0.005, (radiusTop + (radiusBottom - radiusTop) * taper) * flareAmount),
      t * height,
    ]);
  }
  const builder = lathe(profile, { segments: segments * 2, caps: false });
  const fissures = options.fissures ?? 0.14;
  // Vertical fissures: ridged noise stretched along the trunk.
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const normal = builder.normalAt(index);
    const angle = Math.atan2(point[2], point[0]);
    const crack = ridgedNoise((options.seed ?? 139) + 3, angle * 2.4, point[1] * 1.6, { octaves: 3 });
    const swell = fbm3((options.seed ?? 139) + 17, point[0] * 1.4, point[1] * 0.7, point[2] * 1.4, 2);
    const amount = (crack - 0.5) * radiusBottom * fissures * 2.6 + swell * radiusBottom * 0.06;
    builder.setPosition(index, [
      point[0] + normal[0] * amount,
      point[1],
      point[2] + normal[2] * amount,
    ]);
  }
  builder.computeNormals();
  if (options.buttress) {
    const roots = Math.max(3, Math.round(options.buttress));
    for (let index = 0; index < roots; index += 1) {
      const angle = (index / roots) * Math.PI * 2 + range(rng, -0.2, 0.2);
      const rootHeight = height * range(rng, 0.12, 0.24);
      const root = box(radiusBottom * 0.5, rootHeight, radiusBottom * 2.6, { bevel: radiusBottom * 0.16, bevelSegments: 1 });
      // Lean the fin about its own centre, stand it out from the trunk, then
      // orbit it round the axis — the last rotation is meant to be about the
      // origin, the first two are not.
      root.rotateZ(-0.28);
      root.translate(radiusBottom * 1.2, rootHeight / 2 - rootHeight * 0.12, 0);
      root.rotateY(angle);
      builder.add(root);
    }
  }
  builder.translate(0, -builder.bounds().min[1], 0);
  return builder;
}

export interface BranchOptions {
  length: number;
  radiusBase: number;
  radiusTip?: number;
  /** Upward or outward bend in radians; a branch sags or lifts along its run. */
  curve?: number;
  seed?: number;
  segments?: number;
  /** Side twigs spawned along the branch. */
  twigs?: number;
}

/**
 * The curve a `branch` sweeps, exposed so a caller can put things *on* it.
 *
 * A canopy blob placed by guessing where the tip landed drifts off the limb as
 * the curve grows, and a crown that floats next to its branches reads as a ball
 * with sticks poking out of it. Sharing the formula is the only way a tree can
 * know where its own leaves belong.
 *
 * Local frame: the branch rises along +Y and bends toward +X, with a slight
 * wander in Z so no two limbs are coplanar.
 */
export function branchSpine(length: number, curve: number, t: number): Vec3 {
  return [
    Math.sin(t * curve) * length * 0.35,
    t * length * Math.cos(curve * 0.5) + Math.sin(t * Math.PI) * length * curve * 0.18,
    Math.cos(t * curve * 1.3) * length * 0.08,
  ];
}

/** A curved branch swept along a spine, optionally carrying twigs. */
export function branch(options: BranchOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 149);
  const length = Math.max(0.05, options.length);
  const radiusBase = Math.max(0.004, options.radiusBase);
  const radiusTip = Math.max(0.001, options.radiusTip ?? radiusBase * 0.4);
  const curve = options.curve ?? 0.35;
  const segments = Math.max(3, Math.round(options.segments ?? 6));
  const spine: Vec3[] = [];
  for (let index = 0; index <= segments; index += 1) {
    spine.push(branchSpine(length, curve, index / segments));
  }
  const builder = sweep(spine, {
    texel: radiusBase * 8,
    resample: 2,
    section: (t) => {
      const radius = radiusBase + (radiusTip - radiusBase) * Math.pow(t, 0.75);
      const lobes = 3;
      const points: Vec2[] = [];
      for (let index = 0; index < lobes * 2; index += 1) {
        const angle = (index / (lobes * 2)) * Math.PI * 2;
        const bump = 1 + 0.08 * Math.cos(angle * lobes + t * 3);
        points.push([Math.cos(angle) * radius * bump, Math.sin(angle) * radius * bump]);
      }
      return points;
    },
    caps: true,
  });
  const twigs = Math.round(options.twigs ?? 0);
  for (let index = 0; index < twigs; index += 1) {
    const t = range(rng, 0.3, 0.95);
    const spineIndex = Math.min(spine.length - 1, Math.round(t * spine.length));
    const origin = spine[spineIndex]!;
    const angle = range(rng, 0, Math.PI * 2);
    const twigLength = length * range(rng, 0.22, 0.45);
    const twig = branch({
      length: twigLength,
      radiusBase: radiusBase * range(rng, 0.3, 0.55),
      curve: range(rng, 0.2, 0.8),
      seed: (options.seed ?? 149) + index * 31 + 7,
      segments: 4,
    });
    twig.rotateZ(range(rng, 0.5, 1.1));
    twig.rotateY(angle);
    twig.translate(origin[0], origin[1], origin[2]);
    builder.add(twig);
  }
  return builder;
}

/* ------------------------------------------------------------- machinery */

export interface GearOptions {
  radius: number;
  teeth?: number;
  thickness?: number;
  toothHeight?: number;
  /** Bore radius; 0 leaves a solid disc. */
  bore?: number;
  spokes?: number;
  seed?: number;
}

/** A toothed wheel, for mill machinery, clocks and steam engines. */
export function gear(options: GearOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const radius = Math.max(0.05, options.radius);
  const teeth = Math.max(6, Math.round(options.teeth ?? Math.max(8, radius * 26)));
  const thickness = options.thickness ?? radius * 0.22;
  const toothHeight = options.toothHeight ?? radius * 0.14;
  const bore = Math.max(0, options.bore ?? radius * 0.16);
  const spokes = Math.max(0, Math.round(options.spokes ?? (radius > 0.6 ? 5 : 0)));

  // The web is a disc; teeth are trapezoids placed around its rim.
  builder.add(cylinder(radius, radius, thickness, { radialSegments: Math.max(12, teeth * 2), caps: true }));
  if (bore > 0) {
    // No boolean subtraction here: the hub is simply built proud of the web, so
    // the axle reads without cutting a hole that would show through the disc.
    builder.add(cylinder(bore * 1.9, bore * 1.9, thickness * 1.3, { radialSegments: 14 }));
    builder.add(hoopBand({ radius: bore * 1.95, tube: bore * 0.16, width: thickness * 1.34, rivets: 0 }));
  }
  for (let index = 0; index < teeth; index += 1) {
    const angle = (index / teeth) * Math.PI * 2;
    const tooth = box(toothHeight, (Math.PI * 2 * radius) / teeth * 0.52, thickness * 0.94, { bevel: toothHeight * 0.18, bevelSegments: 1 });
    tooth.translate(radius + toothHeight / 2 - toothHeight * 0.12, 0, 0);
    tooth.rotateY(-angle);
    // Teeth lie in the XZ plane of a Y-axis wheel, so rotate about Y.
    builder.add(tooth);
  }
  if (spokes > 0) {
    for (let index = 0; index < spokes; index += 1) {
      const angle = (index / spokes) * Math.PI * 2;
      const spoke = box(radius - bore * 1.6, thickness * 0.55, radius * 0.16);
      spoke.translate(bore * 1.6 + (radius - bore * 1.6) / 2, 0, 0);
      spoke.rotateY(-angle);
      builder.add(spoke);
    }
  }
  // The wheel works in the XZ plane; stand it up so it turns about Z.
  builder.rotateX(Math.PI / 2);
  return builder;
}

/** A wheel: tyre, hub, spokes and an iron rim, for carts and mills. */
export function wheel(options: { radius: number; width?: number; spokes?: number; seed?: number; iron?: boolean; dished?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 157);
  const builder = new MeshBuilder();
  const radius = Math.max(0.1, options.radius);
  const width = options.width ?? radius * 0.18;
  const spokes = Math.max(4, Math.round(options.spokes ?? Math.max(8, radius * 14)));
  const dished = options.dished ?? 0.06;

  // The wheel is built in the XY plane with its axle along Z, so a caller steers
  // it with rotateY and rolls it with rotateZ.
  const rimRadius = radius - width * 0.5;
  // Felloes: the wooden rim is built from curved segments, not one torus, so the
  // joints show where a wheelwright would have made them.
  const segments = Math.max(6, Math.round(spokes * 1.5));
  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const arc = ((Math.PI * 2) / segments) * 1.06;
    const felloe = torus(rimRadius, width * 0.5, { radialSegments: 5, tubularSegments: 3, arc });
    felloe.rotateX(Math.PI / 2);
    felloe.rotateZ(-angle);
    builder.add(felloe);
  }
  if (options.iron !== false) {
    const tyre = torus(radius + width * 0.06, width * 0.16, { radialSegments: 4, tubularSegments: Math.max(14, segments * 2) });
    tyre.rotateX(Math.PI / 2);
    tyre.scale(1, 1, 0.7);
    builder.add(tyre);
  }
  const hub = cylinder(width * 0.9, width * 1.05, width * 2.6, { radialSegments: 12 });
  hub.rotateX(Math.PI / 2);
  builder.add(hub);
  for (const side of [-1, 1]) {
    const collar = hoopBand({ radius: width * 1.02, tube: width * 0.12, width: width * 0.4, rivets: 0 });
    collar.rotateX(Math.PI / 2);
    collar.translate(0, 0, side * width * 0.95);
    builder.add(collar);
  }
  // A dished wheel carries its hub off the rim plane, so every spoke runs from
  // the hub toward the rim at an angle instead of lying flat. That cone is what
  // lets a wagon wheel take a sideways load.
  const dish = radius * dished;
  for (let index = 0; index < spokes; index += 1) {
    const angle = (index / spokes) * Math.PI * 2 + range(rng, -0.01, 0.01);
    const rimPoint: Vec3 = [Math.cos(angle) * rimRadius, Math.sin(angle) * rimRadius, 0];
    const hubPoint: Vec3 = [0, 0, dish];
    const direction = new THREE.Vector3(rimPoint[0] - hubPoint[0], rimPoint[1] - hubPoint[1], rimPoint[2] - hubPoint[2]);
    const length = direction.length();
    direction.normalize();
    const spoke = box(width * 0.4, length - width * 1.2, width * 0.55);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    spoke.transform(new THREE.Matrix4().compose(
      new THREE.Vector3(
        (rimPoint[0] + hubPoint[0]) / 2,
        (rimPoint[1] + hubPoint[1]) / 2,
        (rimPoint[2] + hubPoint[2]) / 2,
      ),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    ));
    builder.add(spoke);
  }
  return builder;
}

/** A screw thread or a spiral stair rail: a tube wound around a helix. */
export function helix(options: { radius: number; pitch: number; turns: number; tube?: number; radialSegments?: number }): MeshBuilder {
  const radius = Math.max(0.01, options.radius);
  const pitch = Math.max(0.01, options.pitch);
  const turns = Math.max(0.1, options.turns);
  const tube = options.tube ?? radius * 0.14;
  const steps = Math.max(8, Math.round(turns * 24));
  const spine: Vec3[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const angle = t * turns * Math.PI * 2;
    spine.push([Math.cos(angle) * radius, t * turns * pitch, Math.sin(angle) * radius]);
  }
  return sweep(spine, {
    texel: tube * 6,
    section: () => {
      const segments = Math.max(4, Math.round(options.radialSegments ?? 6));
      const points: Vec2[] = [];
      for (let index = 0; index < segments; index += 1) {
        const angle = (index / segments) * Math.PI * 2;
        points.push([Math.cos(angle) * tube, Math.sin(angle) * tube]);
      }
      return points;
    },
    caps: true,
  });
}

/* --------------------------------------------------------------- vessels */

export interface BarrelOptions {
  height: number;
  radius: number;
  seed?: number;
  /** Bilge: how much wider the middle is than the ends. */
  bilge?: number;
  staves?: number;
  hoops?: number;
}

/**
 * A barrel: staved, bilged and hooped.
 *
 * A cylinder is a drum, not a barrel. The bilge (a wider middle) lets it be
 * rolled and turned, the staves show as vertical seams, and the hoops are iron
 * bands with rivets — three details that make a 90 cm object readable across a
 * whole scene.
 */
export function barrel(options: BarrelOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 163);
  const height = Math.max(0.15, options.height);
  const radius = Math.max(0.05, options.radius);
  const bilge = options.bilge ?? 0.16;
  const staves = Math.max(8, Math.round(options.staves ?? Math.max(10, radius * 40)));
  const hoops = Math.max(2, Math.round(options.hoops ?? 3));
  const profile: Vec2[] = [];
  const stations = 8;
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    // A circular bilge curve: narrow at the heads, widest at the belly.
    const swell = 1 + bilge * Math.sin(t * Math.PI);
    profile.push([radius * swell * (t < 0.06 || t > 0.94 ? 0.94 : 1), t * height]);
  }
  const builder = lathe(profile, { segments: staves * 2, caps: true });
  // Stave seams: pull every other vertex column inward by a hair.
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const angle = Math.atan2(point[2], point[0]);
    const seam = Math.cos(angle * staves);
    const normal = builder.normalAt(index);
    const amount = seam > 0.86 ? -radius * 0.022 : 0;
    builder.setPosition(index, [point[0] + normal[0] * amount, point[1], point[2] + normal[2] * amount]);
  }
  builder.computeNormals();
  for (let index = 0; index < hoops; index += 1) {
    const t = hoops === 1 ? 0.5 : index / (hoops - 1);
    const y = height * (0.12 + t * 0.76);
    const swell = 1 + bilge * Math.sin(((0.12 + t * 0.76)) * Math.PI);
    const hoop = hoopBand({ radius: radius * swell * 1.005, tube: radius * 0.05, width: height * 0.055, rivets: chance(rng, 0.6) ? 6 : 0, seed: (options.seed ?? 163) + index });
    hoop.translate(0, y, 0);
    builder.add(hoop);
  }
  return builder;
}

/** A ceramic vessel: amphora, jug, urn or bottle, from one profile family. */
export function vessel(options: {
  height: number;
  radius?: number;
  style?: 'amphora' | 'jug' | 'urn' | 'bottle' | 'pot' | 'jar';
  seed?: number;
  handles?: boolean;
}): MeshBuilder {
  const rng = detailRng(options.seed ?? 167);
  const height = Math.max(0.08, options.height);
  const radius = Math.max(0.03, options.radius ?? height * 0.28);
  const style = options.style ?? 'urn';
  const shape: Record<string, number[]> = {
    amphora: [0.06, 0.18, 0.42, 0.62, 0.7, 0.6, 0.4, 0.2, 0.13, 0.15, 0.18],
    jug: [0.34, 0.44, 0.5, 0.48, 0.38, 0.26, 0.2, 0.2, 0.24, 0.3, 0.34],
    urn: [0.28, 0.46, 0.6, 0.66, 0.6, 0.46, 0.32, 0.24, 0.24, 0.28, 0.3],
    bottle: [0.3, 0.42, 0.46, 0.44, 0.34, 0.18, 0.11, 0.1, 0.1, 0.12, 0.14],
    pot: [0.4, 0.56, 0.68, 0.7, 0.62, 0.48, 0.36, 0.3, 0.3, 0.34, 0.36],
    jar: [0.42, 0.54, 0.6, 0.6, 0.56, 0.48, 0.4, 0.34, 0.32, 0.34, 0.36],
  };
  const factors = shape[style] ?? shape.urn!;
  const profile: Vec2[] = factors.map((factor, index) => [radius * factor, (height * index) / (factors.length - 1)]);
  const builder = lathe(profile, { segments: 22, caps: true });
  // A thrown pot is never perfectly round.
  for (let index = 0; index < builder.vertexCount; index += 1) {
    const point = builder.positionAt(index);
    const angle = Math.atan2(point[2], point[0]);
    const normal = builder.normalAt(index);
    const wobble = Math.sin(angle * 3 + point[1] * 7) * radius * 0.012 + fbm3((options.seed ?? 167) + 5, point[0] * 8, point[1] * 8, point[2] * 8, 2) * radius * 0.018;
    builder.setPosition(index, [point[0] + normal[0] * wobble, point[1], point[2] + normal[2] * wobble]);
  }
  builder.computeNormals();
  if (options.handles !== false && (style === 'amphora' || style === 'jug')) {
    for (const side of [-1, 1]) {
      const top = height * (style === 'amphora' ? 0.72 : 0.68);
      const bottom = height * (style === 'amphora' ? 0.48 : 0.36);
      const handle = sweep([
        [radius * 0.2 * side, top, 0],
        [radius * 1.05 * side, top + height * 0.05, 0],
        [radius * 1.12 * side, (top + bottom) / 2, 0],
        [radius * 0.86 * side, bottom, 0],
      ], {
        texel: radius,
        resample: 3,
        section: () => {
          const points: Vec2[] = [];
          for (let index = 0; index < 7; index += 1) {
            const angle = (index / 7) * Math.PI * 2;
            points.push([Math.cos(angle) * radius * 0.09, Math.sin(angle) * radius * 0.075]);
          }
          return points;
        },
      });
      builder.add(handle);
    }
  }
  void rng;
  return builder;
}

/* ----------------------------------------------------------------- extras */

/** A spike or a nail: a tapered four-sided point, cheaper and sharper than a cone. */
export function spike(options: { height: number; radius?: number; sides?: number }): MeshBuilder {
  return prism({
    sides: options.sides ?? 4,
    radius: Math.max(0.005, options.radius ?? options.height * 0.09),
    height: Math.max(0.02, options.height),
    topScale: 0.05,
    caps: true,
  });
}

/** A row of spikes, for palisades, portcullis feet and chevaux de frise. */
export function spikeRow(options: { length: number; count?: number; height?: number; radius?: number; spacing?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.1, options.length);
  const count = Math.max(2, Math.round(options.count ?? length / (options.spacing ?? 0.22)));
  const height = options.height ?? 0.4;
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + (length * (index + 0.5)) / count;
    const part = spike({ height, radius: options.radius ?? height * 0.08 });
    part.translate(x, 0, 0);
    builder.add(part);
  }
  return builder;
}

/** A palisade: sharpened logs driven side by side into the ground. */
export function palisade(options: { length: number; height?: number; seed?: number; tie?: boolean; budget?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 173);
  const builder = new MeshBuilder();
  const length = Math.max(0.6, options.length);
  const height = options.height ?? 2.4;
  const budget = options.budget ?? 2600;
  const count = planRepeatedUnits(Math.max(3, Math.round(length / 0.24)), 150, budget - 400, 3).modeled;
  const step = length / count;
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + step * (index + 0.5);
    const post = trunk({
      height: height * range(rng, 0.92, 1.06),
      radiusBottom: step * 0.44,
      radiusTop: step * 0.3,
      seed: (options.seed ?? 173) + index * 17,
      fissures: 0.2,
      segments: 4,
      stations: 5,
      rootFlare: 0.25,
    });
    // Sharpen the top: a palisade is pointed so a climber cannot get a grip.
    const tip = prism({ sides: 6, radius: step * 0.3, height: step * 0.9, topScale: 0, caps: true });
    tip.translate(0, height * range(rng, 0.92, 1.02), 0);
    // Lean the post about its own base — its local origin — then drive it into
    // the ground at its station. Rotating after translating would pivot it about
    // the middle of the palisade and sink the posts at both ends.
    post.rotateZ(range(rng, -0.02, 0.02));
    post.translate(x, range(rng, -0.06, 0), range(rng, -0.03, 0.03));
    builder.add(post);
    builder.add(tip.translate(x, 0, 0));
  }
  if (options.tie !== false) {
    for (const y of [height * 0.35, height * 0.72]) {
      const tie = rope({
        path: [[-length / 2, y, step * 0.4], [0, y + 0.02, step * 0.42], [length / 2, y, step * 0.4]],
        radius: 0.022,
        segments: 10,
      });
      builder.add(tie);
    }
  }
  return builder;
}

/** A woven wattle fence panel, the cheap medieval boundary. */
export function wattleFence(options: { length: number; height?: number; seed?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 179);
  const builder = new MeshBuilder();
  const length = Math.max(0.5, options.length);
  const height = options.height ?? 1.1;
  const posts = Math.max(2, Math.round(length / 1.2) + 1);
  for (let index = 0; index < posts; index += 1) {
    const x = -length / 2 + (length * index) / (posts - 1);
    const post = cylinder(0.055, 0.065, height + 0.35, { radialSegments: 7, wobble: 0.06, wobbleSeed: index + 3 });
    post.translate(x, (height + 0.35) / 2 - 0.15, 0);
    builder.add(post);
  }
  const rows = Math.max(4, Math.round(height / 0.13));
  for (let row = 0; row < rows; row += 1) {
    const y = 0.12 + (height * row) / rows;
    // Wattles alternate in front of and behind each post: that is the weave.
    for (let index = 0; index < posts - 1; index += 1) {
      const x0 = -length / 2 + (length * index) / (posts - 1);
      const x1 = -length / 2 + (length * (index + 1)) / (posts - 1);
      const front = (index + row) % 2 === 0;
      const rod = cylinder(0.021, 0.026, Math.hypot(x1 - x0, 0.03), { radialSegments: 5, wobble: 0.09, wobbleSeed: row * 7 + index });
      rod.rotateZ(Math.PI / 2 + range(rng, -0.03, 0.03));
      rod.translate((x0 + x1) / 2, y + range(rng, -0.01, 0.01), front ? 0.045 : -0.045);
      builder.add(rod);
    }
  }
  return builder;
}

/** A cloth banner or sail, hanging in folds from a rod. */
export function banner(options: { width: number; height: number; seed?: number; folds?: number; rod?: boolean; tail?: 'square' | 'pointed' | 'swallow' }): MeshBuilder {
  const rng = detailRng(options.seed ?? 181);
  const builder = new MeshBuilder();
  const width = Math.max(0.2, options.width);
  const height = Math.max(0.3, options.height);
  const folds = Math.max(1, Math.round(options.folds ?? Math.max(3, width / 0.25)));
  const cloth = plane(width, height, {
    orientation: 'xy',
    widthSegments: Math.max(6, folds * 4),
    heightSegments: Math.max(6, Math.round(height / 0.12)),
    height: (x, y) => {
      // Folds deepen toward the free bottom edge, as gravity pulls them out.
      const sag = 0.55 + 0.45 * (1 - (y + height / 2) / height);
      return Math.sin((x / width) * Math.PI * 2 * folds + range(rng, 0, 0.0001)) * width * 0.05 * sag
        + Math.sin((x / width) * Math.PI * 5.3) * width * 0.018 * sag;
    },
  });
  cloth.translate(0, height / 2, 0);
  if (options.tail === 'pointed' || options.tail === 'swallow') {
    // Cut the free edge: drop the vertices that fall outside the tail profile.
    const drop = options.tail === 'pointed' ? 0.5 : 0.34;
    for (let index = 0; index < cloth.vertexCount; index += 1) {
      const point = cloth.positionAt(index);
      const t = (point[0] + width / 2) / width;
      const cut = options.tail === 'pointed'
        ? height * (1 - Math.abs(t - 0.5) * 2) * drop
        : height * (t > 0.32 && t < 0.68 ? drop : 0);
      if (point[1] < cut) cloth.setPosition(index, [point[0], cut, point[2]]);
    }
    cloth.computeNormals();
  }
  builder.add(cloth);
  if (options.rod !== false) {
    const rod = cylinder(0.022, 0.022, width * 1.18, { radialSegments: 8 });
    rod.rotateZ(Math.PI / 2);
    rod.translate(0, height + 0.02, 0);
    builder.add(rod);
    for (const side of [-1, 1]) {
      const finial = sphere(0.045, { widthSegments: 8, heightSegments: 6 });
      finial.translate(side * width * 0.59, height + 0.02, 0);
      builder.add(finial);
    }
  }
  return builder;
}

/** A flame-shaped glow: layered cones for a brazier, torch or lantern fire. */
export function flame(options: { height: number; radius?: number; layers?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const height = Math.max(0.05, options.height);
  const radius = options.radius ?? height * 0.32;
  const layers = Math.max(2, Math.round(options.layers ?? 3));
  for (let index = 0; index < layers; index += 1) {
    const t = index / layers;
    const coneHeight = height * (1 - t * 0.35);
    const coneRadius = radius * (1 - t * 0.45);
    const cone = lathe([
      [0, 0],
      [coneRadius, coneHeight * 0.16],
      [coneRadius * 0.86, coneHeight * 0.42],
      [coneRadius * 0.44, coneHeight * 0.74],
      [coneRadius * 0.14, coneHeight * 0.93],
      [0, coneHeight],
    ], { segments: 9 - index, caps: false });
    cone.translate(0, t * height * 0.05, 0);
    builder.add(cone);
  }
  return builder;
}

/** Grass or reeds: a tuft of blades, each its own bent surface. */
export function tuft(options: { height: number; blades?: number; radius?: number; seed?: number; width?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 191);
  const builder = new MeshBuilder();
  const height = Math.max(0.05, options.height);
  const blades = Math.max(3, Math.round(options.blades ?? 7));
  const radius = options.radius ?? height * 0.25;
  for (let index = 0; index < blades; index += 1) {
    const angle = (index / blades) * Math.PI * 2 + range(rng, -0.3, 0.3);
    const distance = radius * range(rng, 0, 1);
    const bladeHeight = height * range(rng, 0.6, 1.1);
    const part = blade({
      length: bladeHeight,
      width: (options.width ?? height * 0.055) * range(rng, 0.7, 1.3),
      widest: 0.12,
      camber: 0.7,
      droop: range(rng, 0.15, 0.6),
      segments: 4,
    });
    part.rotateZ(range(rng, -0.35, 0.35));
    part.rotateY(angle);
    part.translate(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    builder.add(part);
  }
  return builder;
}

/** A crystal shard cluster, for fantasy props and ore veins. */
export function crystalCluster(options: { radius: number; shards?: number; seed?: number; height?: number; facets?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 197);
  const builder = new MeshBuilder();
  const radius = Math.max(0.05, options.radius);
  const shards = Math.max(1, Math.round(options.shards ?? intRange(rng, 4, 8)));
  const facets = Math.max(4, Math.round(options.facets ?? 6));
  for (let index = 0; index < shards; index += 1) {
    const height = (options.height ?? radius * 3) * range(rng, 0.4, 1.15);
    const shardRadius = radius * range(rng, 0.18, 0.5);
    const profile: Vec2[] = [
      [shardRadius * 0.5, 0],
      [shardRadius, height * 0.18],
      [shardRadius * 0.92, height * 0.55],
      [shardRadius * 0.5, height * 0.84],
      [0, height],
    ];
    const shard = lathe(profile, { segments: facets, caps: true });
    shard.flatShade();
    const angle = (index / shards) * Math.PI * 2 + range(rng, -0.4, 0.4);
    const distance = radius * range(rng, 0, 0.7);
    shard.rotateZ(range(rng, -0.5, 0.5));
    shard.rotateX(range(rng, -0.5, 0.5));
    shard.translate(Math.cos(angle) * distance, range(rng, -radius * 0.1, radius * 0.15), Math.sin(angle) * distance);
    builder.add(shard);
  }
  // A base rock so the crystals are growing out of something.
  const base = boulder({ radius: radius * 0.85, seed: (options.seed ?? 197) + 3, roughness: 0.7 });
  base.scale(1.3, 0.5, 1.3);
  base.translate(0, -radius * 0.2, 0);
  builder.add(base);
  return builder;
}

/** A skull-ish bone pile or a single bone, for ruins and graveyards. */
export function bone(options: { length: number; radius?: number; knuckles?: boolean }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.05, options.length);
  const radius = options.radius ?? length * 0.09;
  const shaft = cylinder(radius * 0.78, radius * 0.86, length * 0.72, { radialSegments: 8, wobble: 0.05 });
  shaft.rotateZ(Math.PI / 2);
  builder.add(shaft);
  if (options.knuckles !== false) {
    for (const side of [-1, 1]) {
      for (const offset of [-1, 1]) {
        const knob = sphere(radius * 1.15, { widthSegments: 8, heightSegments: 6 });
        knob.scale(1.1, 0.9, 1);
        knob.translate(side * length * 0.42, offset * radius * 0.5, 0);
        builder.add(knob);
      }
    }
  }
  return builder;
}

/** A picket, post or pole with a chamfered top. */
export function post(options: { height: number; radius?: number; sides?: number; cap?: 'pointed' | 'flat' | 'round'; seed?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 199);
  const builder = new MeshBuilder();
  const height = Math.max(0.1, options.height);
  const radius = options.radius ?? height * 0.06;
  const sides = Math.max(4, Math.round(options.sides ?? 6));
  const shaft = cylinder(radius * 0.92, radius, height * 0.92, { radialSegments: sides, wobble: 0.04, wobbleSeed: range(rng, 1, 9) });
  shaft.translate(0, height * 0.46, 0);
  builder.add(shaft);
  if (options.cap === 'pointed') {
    const tip = prism({ sides, radius: radius * 0.95, height: height * 0.12, topScale: 0.05, caps: true });
    tip.translate(0, height * 0.9, 0);
    builder.add(tip);
  } else if (options.cap === 'round') {
    const dome = sphere(radius, { widthSegments: sides, heightSegments: 5, phiLength: Math.PI / 2 });
    dome.translate(0, height * 0.92, 0);
    builder.add(dome);
  } else {
    const flat = cylinder(radius * 1.02, radius * 1.02, height * 0.06, { radialSegments: sides });
    flat.translate(0, height * 0.95, 0);
    builder.add(flat);
  }
  return builder;
}

export { pick, range, intRange, chance };
