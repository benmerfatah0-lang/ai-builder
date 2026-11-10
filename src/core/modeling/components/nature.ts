import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { box, cylinder, lathe, prism, sphere, sweep } from '../primitives';
import {
  blade, branch, detailRng, fracture, leafCluster, planRepeatedUnits, qualityTriangles,
  trunk, tuft, type Quality,
} from '../detail';
import { normalize, seatOnGround } from '../scale';
import { chance, intRange, pick, range } from '../../generation/rng';

/**
 * Plants: everything that grows, from a single grass blade to a palm tree.
 *
 * Three rules shape this file, and they are why a generated forest does not look
 * like a field of green cones.
 *
 * 1. **A plant is an architecture, not a blob.** A fern is a rachis carrying
 *    pinnae whose length follows a profile; a conifer is tiers of whorls whose
 *    radius falls off toward the crown; a palm is a curved trunk wearing leaf
 *    scars. Each generator models that structure explicitly, so the silhouette
 *    is recognisable at any distance and the shading has somewhere to go.
 * 2. **Foliage is made of leaves, and leaves are thin.** `blade` emits one
 *    surface, so every leaf-like material is two-sided. A canopy built from
 *    single-sided blades loses half its leaves to back-face culling.
 * 3. **The budget degrades representation, never coverage.** A cheap fern keeps
 *    all seven fronds and gives each one fewer pinnae; it does not become a
 *    four-frond fern. A distant tree is still a tree.
 *
 * Coordinates: metres, Y up, the base of the plant on y = 0, centred on X and Z.
 */

/* --------------------------------------------------------------- plumbing */

/** A closed ring of `segments` points at `radius`, in sweep-section space. */
function circle(radius: number, segments: number, lobes = 0, lobeDepth = 0): Vec2[] {
  const count = Math.max(3, Math.round(segments));
  const points: Vec2[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    const shape = lobes > 0 ? 1 + lobeDepth * Math.cos(angle * lobes) : 1;
    points.push([Math.cos(angle) * radius * shape, Math.sin(angle) * radius * shape]);
  }
  return points;
}

/**
 * Places a part with the transform order every other module depends on:
 * spin about its own length axis, tip away from vertical, swing around the
 * parent, then move. Rotating after translating would orbit the world origin
 * and slide the part sideways by roughly radius × angle.
 */
function attach(
  builder: MeshBuilder,
  part: MeshBuilder,
  material: string,
  at: Vec3,
  yaw = 0,
  tilt = 0,
  spin = 0,
): void {
  if (spin) part.rotateY(spin);
  if (tilt) part.rotateZ(tilt);
  if (yaw) part.rotateY(yaw);
  part.translate(at[0], at[1], at[2]);
  builder.add(part, undefined, material);
}

/** The triangle budget for a component: an explicit number wins over quality. */
function budgetOf(quality: Quality | undefined, budget: number | undefined): number {
  if (budget !== undefined && Number.isFinite(budget)) return Math.max(60, Math.round(budget));
  return qualityTriangles(quality);
}

/** Triangles one leaf of a `leafCluster` costs: a blade at four rows by two columns. */
const LEAF_TRIANGLES = 16;

/**
 * Triangles a `branch` costs, so a parent can afford one honestly.
 *
 * `branch` sweeps a six-point section along `segments * resample + 1` stations,
 * and every twig is a four-segment branch of its own. The twigs are the
 * expensive half, which is why a caller decides the twig count from its budget
 * before it decides the segment count.
 */
function branchCost(segments: number, twigs: number): number {
  return (segments * 3 + 1) * 12 + twigs * ((4 * 3 + 1) * 12);
}

/**
 * How many children fit once each is reduced to its cheapest honest form.
 *
 * `planRepeatedUnits` simplifies a unit before it drops one, but a unit has a
 * floor: a mushroom cannot be less than a cap over a stipe, a frond cannot be
 * less than a rachis. When even the floor does not fit, coverage is what gives.
 * This is the only place in the file that decides to build fewer of a thing.
 */
function planChildren(count: number, cheapest: number, budget: number): { modeled: number; each: number } {
  const wanted = Math.max(1, Math.round(count));
  const floor = Math.max(1, Math.round(cheapest));
  const affordable = Math.max(1, Math.floor(budget / floor));
  const modeled = Math.max(1, Math.min(wanted, affordable));
  return { modeled, each: Math.max(floor, Math.floor(budget / modeled)) };
}

/**
 * Makes `height` mean what the caller asked for.
 *
 * A plant overshoots or undershoots its nominal height by construction: fronds
 * tilt, leaf blobs reach past their own centre, a seed head sits above the stalk
 * that carries it. Rather than tune a dozen generators to land on a number, each
 * one builds its natural proportions and this scales the whole plant uniformly.
 * Uniform is also honest — a taller fern really is a wider fern — and it never
 * stretches a normal, which non-uniform scaling would.
 */
function fitHeight(builder: MeshBuilder, height: number, maxFactor = 2, center = true): void {
  normalize(builder, { by: 'height', target: Math.max(0.02, height), maxFactor });
  seatOnGround(builder, center);
}

/** A spine that leans away from vertical as it rises, in the XZ direction given. */
function leaningSpine(height: number, lean: number, direction: number, segments = 5, sag = 0): Vec3[] {
  const count = Math.max(2, Math.round(segments));
  const spine: Vec3[] = [];
  for (let index = 0; index <= count; index += 1) {
    const t = index / count;
    const offset = lean * height * Math.pow(t, 1.8);
    spine.push([
      Math.cos(direction) * offset,
      height * t - sag * height * Math.sin(t * Math.PI),
      Math.sin(direction) * offset,
    ]);
  }
  return spine;
}

/* ------------------------------------------------------------------ flowers */

export type FlowerStyle = 'daisy' | 'rose' | 'tulip' | 'bell' | 'thistle' | 'lily' | 'umbel';

export interface FlowerOptions {
  /** Ground to the top of the bloom, in metres. */
  height?: number;
  /** Radius of the open bloom, in metres. */
  radius?: number;
  petals?: number;
  style?: FlowerStyle;
  seed?: number;
  /** 0 = a bud, 1 = fully open. */
  bloom?: number;
  leaves?: number;
  quality?: Quality;
  budget?: number;
  stemMaterial?: string;
  petalMaterial?: string;
}

const PETAL_BY_STYLE: Record<FlowerStyle, string> = {
  daisy: 'petal-pale',
  rose: 'petal',
  tulip: 'petal',
  bell: 'petal-pale',
  thistle: 'petal',
  lily: 'petal-pale',
  umbel: 'petal-warm',
};

/**
 * One flowering plant: a stem that leans, a couple of leaves, and a bloom built
 * the way the species actually builds it.
 *
 * A daisy is a ring of narrow rays around a domed disc. A rose is three rings of
 * deeply cupped petals, each ring smaller and more upright than the last. A tulip
 * is six petals that barely open. A bell hangs. A thistle is a spiky disc on a
 * bracted cup. Getting these five silhouettes right is what lets a meadow read
 * as a meadow rather than as coloured noise.
 */
export function flower(options: FlowerOptions = {}): MeshBuilder {
  const seed = options.seed ?? 41;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const style = options.style ?? 'daisy';
  const height = Math.max(0.06, options.height ?? 0.42);
  const radius = Math.max(0.012, options.radius ?? height * 0.16);
  const bloom = Math.min(1, Math.max(0, options.bloom ?? 1));
  const budget = budgetOf(options.quality, options.budget);
  const stemMaterial = options.stemMaterial ?? 'grass';
  const petalMaterial = options.petalMaterial ?? PETAL_BY_STYLE[style];
  const stemHeight = height * (style === 'bell' ? 0.72 : 0.86);

  // The stem is a sweep rather than a cylinder so it can lean and taper; a
  // perfectly vertical tube is the single most artificial thing in a meadow.
  const stemSpine = leaningSpine(stemHeight, range(rng, 0.03, 0.11), range(rng, 0, Math.PI * 2), 4);
  const stem = sweep(stemSpine, {
    texel: 0.09,
    section: (t) => circle(Math.max(0.0016, radius * 0.09 * (1 - 0.5 * t)), 6),
    caps: true,
  });
  builder.add(stem, undefined, stemMaterial);
  const crownStation = stemSpine[stemSpine.length - 1]!;
  const leanTop: Vec3 = [crownStation[0], crownStation[1], crownStation[2]];
  /** Where the stem is at a fraction of its height, lean included. */
  const onStem = (t: number): Vec3 => {
    const index = Math.min(stemSpine.length - 1, Math.max(0, Math.round(t * (stemSpine.length - 1))));
    const point = stemSpine[index]!;
    return [point[0], point[1], point[2]];
  };

  // Leaves on the lower stem, each a lobed blade tilted outward and down.
  const leaves = Math.max(0, Math.round(options.leaves ?? (style === 'thistle' ? 3 : 2)));
  const leafPlan = planRepeatedUnits(leaves, 26, budget, 0);
  for (let index = 0; index < leafPlan.modeled; index += 1) {
    const at = range(rng, 0.08, 0.42);
    const leaf = blade({
      length: height * range(rng, 0.16, 0.3),
      width: height * range(rng, 0.05, 0.09),
      widest: 0.3,
      camber: 0.5,
      droop: range(rng, 0.35, 0.7),
      lobes: style === 'thistle' ? 0 : intRange(rng, 2, 4),
      lobeDepth: 0.4,
      serrate: style === 'rose' ? 0.35 : 0,
      segments: 3,
      across: 2,
    });
    attach(builder, leaf, stemMaterial, onStem(at),
      (index / Math.max(1, leaves)) * Math.PI * 2 + range(rng, -0.4, 0.4), 1.15 + range(rng, -0.2, 0.2));
  }

  const petalBudget = Math.max(60, budget - 120 - leafPlan.modeled * 26);

  if (style === 'bell') {
    // A hanging bell: a lathe flaring downward from the attachment point, with
    // five teeth at the rim. Traversed from the rim inward so normals face out.
    const bellHeight = radius * 2.1;
    const profile: Vec2[] = [];
    const steps = 6;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const bell = Math.pow(t, 0.62);
      profile.push([radius * (0.3 + 0.7 * bell), -bellHeight * t]);
    }
    profile.push([radius * 0.24, -bellHeight * 1.02]);
    profile.push([radius * 0.16, -bellHeight * 0.34]);
    const cup = lathe(profile, { segments: 14, texel: 0.08, caps: false });
    cup.translate(0, 0, 0);
    attach(builder, cup, petalMaterial, [leanTop[0], stemHeight, leanTop[2]], 0, Math.PI * 0.16);
    fitHeight(builder, height, 1.5);
    const teeth = planRepeatedUnits(5, 12, petalBudget, 3);
    for (let index = 0; index < teeth.modeled; index += 1) {
      const tooth = prism({ sides: 3, radius: radius * 0.13, height: radius * 0.42, topScale: 0.1 });
      const angle = (index / 5) * Math.PI * 2;
      attach(builder, tooth, petalMaterial,
        [leanTop[0] + Math.cos(angle) * radius * 0.92, stemHeight - bellHeight * 0.96, leanTop[2] + Math.sin(angle) * radius * 0.92],
        angle, Math.PI);
    }
    return builder;
  }

  if (style === 'thistle') {
    // Bracted cup, then a burst of tubular florets.
    const cupProfile: Vec2[] = [];
    for (let index = 0; index <= 5; index += 1) {
      const t = index / 5;
      cupProfile.push([radius * (0.42 + 0.5 * Math.sin(t * Math.PI * 0.8)), radius * 0.95 * t]);
    }
    const cup = lathe(cupProfile, { segments: 12, texel: 0.07, caps: false });
    attach(builder, cup, stemMaterial, [leanTop[0], stemHeight, leanTop[2]]);
    const florets = planRepeatedUnits(Math.round(options.petals ?? 22), 10, petalBudget, 8);
    for (let index = 0; index < florets.modeled; index += 1) {
      const angle = (index / florets.modeled) * Math.PI * 2 + range(rng, -0.1, 0.1);
      const spread = range(rng, 0.05, 0.5) * bloom;
      const spike = prism({ sides: 4, radius: radius * 0.045, height: radius * range(rng, 0.85, 1.5), topScale: 0.05 });
      attach(builder, spike, petalMaterial,
        [leanTop[0] + Math.cos(angle) * radius * 0.35 * (1 - spread), stemHeight + radius * 0.85, leanTop[2] + Math.sin(angle) * radius * 0.35 * (1 - spread)],
        angle, spread);
    }
    fitHeight(builder, height, 1.5);
    return builder;
  }

  if (style === 'umbel') {
    // A flat-topped cluster of tiny florets on radiating pedicels, as in yarrow
    // and cow parsley: one flat disc of flowers reads at a great distance.
    const florets = planRepeatedUnits(Math.round(options.petals ?? 14), 40, petalBudget, 5);
    const clusterRadius = radius * 1.7;
    for (let index = 0; index < florets.modeled; index += 1) {
      const angle = (index / florets.modeled) * Math.PI * 2 + range(rng, -0.25, 0.25);
      const distance = clusterRadius * Math.sqrt((index + 0.5) / florets.modeled);
      const target: Vec3 = [leanTop[0] + Math.cos(angle) * distance, stemHeight + radius * 0.18, leanTop[2] + Math.sin(angle) * distance];
      const stalk = sweep([[leanTop[0], stemHeight - radius * 0.3, leanTop[2]], target], {
        texel: 0.06,
        section: () => circle(Math.max(0.0012, radius * 0.035), 5),
        caps: false,
      });
      builder.add(stalk, undefined, stemMaterial);
      const head = sphere(radius * 0.22, { widthSegments: 7, heightSegments: 4, texel: 0.05 });
      attach(builder, head, petalMaterial, target);
    }
    fitHeight(builder, height, 1.5);
    return builder;
  }

  // Ringed blooms: daisy, rose, tulip, lily. Each style is a different set of
  // rings — how many, how far they tilt from vertical, and how deeply cupped.
  const rings: { count: number; tilt: number; length: number; width: number; camber: number; offset: number }[] =
    style === 'daisy'
      ? [{ count: Math.round(options.petals ?? 13), tilt: 1.32, length: radius, width: radius * 0.15, camber: 0.28, offset: 0 }]
      : style === 'tulip'
        ? [{ count: Math.round(options.petals ?? 6), tilt: 0.42, length: radius * 1.45, width: radius * 0.5, camber: 1.05, offset: 0 }]
        : style === 'lily'
          ? [{ count: Math.round(options.petals ?? 6), tilt: 1.05, length: radius * 1.3, width: radius * 0.26, camber: 0.6, offset: 0 }]
          : [
            { count: Math.round(options.petals ?? 8), tilt: 1.18 * bloom + 0.16, length: radius, width: radius * 0.52, camber: 0.95, offset: 0 },
            { count: Math.max(4, Math.round((options.petals ?? 8) * 0.75)), tilt: 0.8 * bloom + 0.2, length: radius * 0.7, width: radius * 0.5, camber: 1.15, offset: 0.4 },
            { count: Math.max(3, Math.round((options.petals ?? 8) * 0.5)), tilt: 0.42 * bloom + 0.22, length: radius * 0.42, width: radius * 0.44, camber: 1.4, offset: 0.8 },
          ];

  for (const ring of rings) {
    const plan = planRepeatedUnits(ring.count, 22, petalBudget / Math.max(1, rings.length), 3);
    const petalLength = ring.length * (style === 'tulip' || style === 'rose' ? 1 : 0.55 + 0.55 * bloom);
    for (let index = 0; index < plan.modeled; index += 1) {
      const angle = (index / ring.count) * Math.PI * 2 + ring.offset + range(rng, -0.08, 0.08);
      const petal = blade({
        length: Math.max(0.006, petalLength),
        width: ring.width,
        widest: style === 'daisy' ? 0.42 : 0.62,
        camber: ring.camber,
        droop: style === 'daisy' ? -0.12 : 0.28,
        twist: range(rng, -0.25, 0.25),
        segments: 3,
        across: 2,
      });
      attach(builder, petal, petalMaterial,
        [leanTop[0], stemHeight, leanTop[2]], angle, ring.tilt, range(rng, -0.2, 0.2));
    }
  }

  // The eye: a domed disc for a daisy, a tight boss for a rose, stamens for a
  // tulip and a lily.
  if (style === 'daisy' || style === 'rose') {
    const eye = sphere(radius * (style === 'daisy' ? 0.3 : 0.26), {
      widthSegments: 10, heightSegments: 5, phiLength: Math.PI * 0.5, texel: 0.05,
    });
    eye.scale(1, style === 'daisy' ? 0.72 : 0.95, 1);
    attach(builder, eye, style === 'daisy' ? 'petal-warm' : 'petal-warm', [leanTop[0], stemHeight, leanTop[2]]);
  } else {
    const stamens = planRepeatedUnits(6, 10, Math.max(40, petalBudget * 0.2), 3);
    for (let index = 0; index < stamens.modeled; index += 1) {
      const angle = (index / stamens.modeled) * Math.PI * 2 + 0.3;
      const filament = cylinder(0, radius * 0.022, radius * 0.72, { radialSegments: 4, caps: false, texel: 0.04 });
      attach(builder, filament, 'petal-warm',
        [leanTop[0] + Math.cos(angle) * radius * 0.12, stemHeight + radius * 0.05, leanTop[2] + Math.sin(angle) * radius * 0.12],
        angle, range(rng, 0.12, 0.4));
      const anther = sphere(radius * 0.055, { widthSegments: 5, heightSegments: 3, texel: 0.03 });
      attach(builder, anther, 'petal-warm',
        [leanTop[0] + Math.cos(angle) * radius * 0.2, stemHeight + radius * 0.72, leanTop[2] + Math.sin(angle) * radius * 0.2]);
    }
  }
  fitHeight(builder, height, 1.5);
  return builder;
}

/** A clump of flowers sharing one patch of ground, as they actually grow. */
export function flowerCluster(options: FlowerOptions & { count?: number; spread?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 43);
  const builder = new MeshBuilder();
  const count = Math.max(1, Math.round(options.count ?? 5));
  const spread = Math.max(0.05, options.spread ?? 0.28);
  const budget = budgetOf(options.quality, options.budget);
  const style = options.style ?? 'daisy';
  // A flower cannot go below about 200 triangles and still have petals, a stem
  // and leaves; pricing it lower just builds more flowers than were paid for.
  const plan = planChildren(count, 200, budget);
  for (let index = 0; index < plan.modeled; index += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = index === 0 ? 0 : spread * Math.sqrt(range(rng, 0.2, 1));
    const single = flower({
      ...options,
      height: (options.height ?? 0.42) * range(rng, 0.7, 1.15),
      radius: (options.radius ?? 0.06) * range(rng, 0.75, 1.2),
      style: chance(rng, 0.15) ? pick<FlowerStyle>(rng, ['daisy', 'rose', 'tulip', 'lily'], style) : style,
      seed: (options.seed ?? 43) + index * 53 + 9,
      budget: plan.each,
    });
    single.translate(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    builder.add(single);
  }
  return builder;
}

/* ------------------------------------------------------------------ fungi */

export type MushroomStyle = 'toadstool' | 'amanita' | 'oyster' | 'morel' | 'puffball' | 'shelf';

export interface MushroomOptions {
  /** Ground to the top of the cap, in metres. */
  height?: number;
  capRadius?: number;
  style?: MushroomStyle;
  seed?: number;
  gills?: boolean;
  /** The annulus left on the stipe as the veil tears. */
  ring?: boolean;
  spots?: boolean;
  /** Volva: the sack at the base, which is what identifies an amanita. */
  volva?: boolean;
  quality?: Quality;
  budget?: number;
  capMaterial?: string;
  fleshMaterial?: string;
}

/**
 * One mushroom, built as a cap shell over a turned stipe.
 *
 * The cap is a single lathe traversed from the stipe outward along the
 * underside, around the rim, and inward to the apex of the dome. That order is
 * not cosmetic: `lathe` derives each normal by rotating the profile tangent, so
 * this traversal is the one that leaves the dome facing up and the gill surface
 * facing down. Traversed the other way, the cap would be inside out and vanish
 * from every angle but one.
 */
export function mushroom(options: MushroomOptions = {}): MeshBuilder {
  const seed = options.seed ?? 47;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const style = options.style ?? 'toadstool';
  const height = Math.max(0.03, options.height ?? 0.12);
  const capRadius = Math.max(0.012, options.capRadius ?? height * (
    style === 'puffball' ? 0.55 : style === 'oyster' ? 0.78 : style === 'morel' ? 0.34 : 0.58
  ));
  const budget = budgetOf(options.quality, options.budget);
  const capMaterial = options.capMaterial ?? (style === 'morel' ? 'fungus-bruised' : 'fungus');
  const fleshMaterial = options.fleshMaterial ?? 'fungus-pale';
  const stipeRadius = capRadius * (style === 'puffball' ? 0 : style === 'oyster' ? 0.12 : 0.17);
  const capHeight = style === 'puffball' ? height : height * (style === 'morel' ? 0.52 : style === 'amanita' ? 0.34 : 0.3);
  // A bracket fungus has no stipe at all: it grows straight out of the bark, so
  // it is built near the ground and its caller rotates it onto the trunk.
  const stipeHeight = style === 'shelf'
    ? capHeight * 0.45
    : Math.max(0.004, height - capHeight);
  // A cap is a lathe, so its cost is segments × profile points. Both fall with
  // the budget: fewer segments first, then a coarser profile, then no warts.
  const rich = budget >= 520;
  const segments = Math.max(6, Math.min(20, Math.round(Math.sqrt(Math.max(60, budget)) * 0.62)));

  if (style === 'puffball') {
    // No stipe and no gills: one closed ball sitting on the ground, slightly
    // flattened, with a warty surface.
    const body = sphere(height * 0.52, { widthSegments: 14, heightSegments: 10, texel: 0.08, radii: [capRadius, height * 0.5, capRadius] });
    fracture(body, { amplitude: capRadius * 0.09, frequency: 22, seed, facets: true, preserveBase: true, recompute: true });
    body.translate(0, height * 0.5, 0);
    builder.add(body, undefined, fleshMaterial);
    const seated = builder.bounds();
    if (seated.min[1] !== 0) builder.translate(0, -seated.min[1], 0);
    return builder;
  }

  if (style === 'shelf') {
    // A bracket fungus: a fan growing out of a trunk, so it is built sideways
    // and its underside is flat. Callers rotate it onto the bark.
    const profile: Vec2[] = [];
    const steps = 6;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      profile.push([capRadius * t, -capHeight * 0.35 * Math.pow(1 - t, 1.4)]);
    }
    for (let index = steps; index >= 0; index -= 1) {
      const t = index / steps;
      profile.push([capRadius * t * 0.985, capHeight * 0.55 * Math.pow(t, 0.7) - capHeight * 0.35 * Math.pow(1 - t, 1.4)]);
    }
    const shelf = lathe(profile, { segments: rich ? 12 : 8, angle: Math.PI * 1.15, texel: 0.07, caps: false });
    shelf.translate(0, stipeHeight, 0);
    builder.add(shelf, undefined, capMaterial);
    const shelfBounds = builder.bounds();
    if (shelfBounds.min[1] !== 0) builder.translate(0, -shelfBounds.min[1], 0);
    return builder;
  }

  // ---- stipe: turned, so it swells at the base and narrows under the cap ----
  if (stipeRadius > 0.001) {
    const profile: Vec2[] = [];
    const steps = rich ? 6 : 4;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const swell = style === 'amanita' ? 1.55 - 0.75 * t : style === 'oyster' ? 1.2 - 0.4 * t : 1.3 - 0.45 * t;
      profile.push([stipeRadius * swell * (1 + 0.05 * Math.sin(t * 7 + seed)), stipeHeight * t]);
    }
    const stipe = lathe(profile, { segments, texel: 0.06, caps: false });
    builder.add(stipe, undefined, fleshMaterial);
  }

  // ---- volva and annulus ----
  if (rich && (options.volva ?? style === 'amanita')) {
    const sackProfile: Vec2[] = [];
    for (let index = 0; index <= 5; index += 1) {
      const t = index / 5;
      sackProfile.push([stipeRadius * (1.5 + 1.1 * Math.sin(t * Math.PI * 0.9)), stipeHeight * 0.16 * t]);
    }
    const sack = lathe(sackProfile, { segments: Math.max(8, segments - 2), texel: 0.05, caps: false });
    builder.add(sack, undefined, fleshMaterial);
  }
  if (rich && (options.ring ?? style === 'amanita')) {
    const ringProfile: Vec2[] = [];
    const ringY = stipeHeight * range(rng, 0.55, 0.72);
    for (let index = 0; index <= 4; index += 1) {
      const t = index / 4;
      ringProfile.push([stipeRadius * (1.05 + 1.5 * Math.pow(t, 0.8)), ringY - stipeHeight * 0.09 * t]);
    }
    const skirt = lathe(ringProfile, { segments: Math.max(8, segments - 2), texel: 0.04, caps: false });
    builder.add(skirt, undefined, fleshMaterial);
  }

  // ---- cap ----
  const capY = stipeHeight;
  if (style === 'morel') {
    // A honeycombed egg: a skirt that closes over the top of the stipe, widest
    // just below the middle, rounded to an apex. The radius ripples so the pits
    // are real geometry, and faceting afterwards makes them read as pits rather
    // than as smooth bumps. Traversed bottom-up, which is what leaves the
    // outside facing out; the bottom cap closes the skirt onto the stipe.
    const profile: Vec2[] = [];
    const steps = 12;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const outline = Math.pow(Math.sin(Math.PI * (0.18 + 0.82 * t)), 0.72);
      const pits = 1 + 0.16 * Math.sin(t * 34 + seed);
      profile.push([Math.max(0, capRadius * outline * pits), capY + (height - capY) * t]);
    }
    const morel = lathe(profile, { segments: Math.max(10, segments), texel: 0.05, caps: true });
    fracture(morel, { amplitude: capRadius * 0.1, frequency: 30, seed: seed + 3, facets: true, recompute: true });
    builder.add(morel, undefined, capMaterial);
    return builder;
  }

  // The gills slope down and outward from the stipe to the rim, so the rim sits
  // `underside` above the lowest point of the cap and the dome rises from there.
  // Together they add up to exactly `height`.
  const underside = capHeight * (style === 'oyster' ? 0.3 : style === 'amanita' ? 0.16 : 0.22);
  const rimY = capY + underside;
  const dome = Math.max(capHeight * 0.05, capHeight - underside);
  const innerRadius = Math.max(0.0015, stipeRadius * 1.15);
  const profile: Vec2[] = [];
  const underSteps = rich ? 4 : 2;
  for (let index = 0; index <= underSteps; index += 1) {
    const t = index / underSteps;
    const r = innerRadius + (capRadius - innerRadius) * Math.pow(t, 0.85);
    profile.push([r, rimY + underside * (1 - t)]);
  }
  // The underside loop already ended on the rim, so the dome starts one step in.
  // Repeating the rim point would add a zero-height strip of slivers.
  // rimY + dome === height, so the crown never overshoots what was asked for.
  const domeSteps = rich ? (style === 'toadstool' ? 5 : 6) : 3;
  for (let index = 1; index <= domeSteps; index += 1) {
    const t = index / domeSteps;
    const r = capRadius * Math.pow(Math.cos(t * Math.PI * 0.5), style === 'amanita' ? 1.35 : 0.92);
    const y = rimY + dome * Math.pow(Math.sin(t * Math.PI * 0.5), style === 'oyster' ? 0.6 : 0.85);
    profile.push([Math.max(0, r), y]);
  }
  const cap = lathe(profile, { segments: Math.max(10, segments + 2), texel: 0.06, caps: false });
  if (style === 'oyster') {
    // Oyster caps are off-centre and fan-shaped: squash one axis and tilt. The
    // tilt has to pivot on the cap's own rim line — rotating a part that already
    // sits at `rimY` would swing it around the origin and off the stipe.
    cap.scale(1, 1, 0.78);
    cap.translate(0, -rimY, 0);
    cap.rotateZ(range(rng, -0.3, 0.3));
    cap.translate(0, rimY, 0);
  }
  fracture(cap, { amplitude: capRadius * 0.035, frequency: 16, seed: seed + 7, recompute: true });
  builder.add(cap, undefined, capMaterial);

  // ---- gills: radial plates under the cap ----
  if (options.gills ?? style !== 'oyster') {
    const wanted = style === 'amanita' ? 22 : 16;
    const plan = planRepeatedUnits(wanted, 12, Math.max(36, budget * 0.3), rich ? 6 : 0);
    const gillLength = capRadius - innerRadius;
    for (let index = 0; index < plan.modeled; index += 1) {
      const angle = (index / plan.modeled) * Math.PI * 2;
      const depth = underside * 0.8 + capRadius * 0.04;
      const gill = box(0.0016, depth, gillLength * 0.98);
      gill.translate(0, 0, innerRadius + gillLength * 0.49);
      gill.rotateY(angle);
      gill.translate(0, rimY - depth * 0.5, 0);
      builder.add(gill, undefined, fleshMaterial);
    }
  }

  // ---- warts on an amanita cap: the veil remnants ----
  if (rich && (options.spots ?? style === 'amanita')) {
    const plan = planRepeatedUnits(11, 26, Math.max(60, budget * 0.2), 4);
    for (let index = 0; index < plan.modeled; index += 1) {
      const t = range(rng, 0.12, 0.85);
      const angle = range(rng, 0, Math.PI * 2);
      const r = capRadius * Math.pow(Math.cos(t * Math.PI * 0.5), 0.92) * 0.97;
      const y = rimY + dome * Math.pow(Math.sin(t * Math.PI * 0.5), 0.85);
      const wart = sphere(capRadius * range(rng, 0.07, 0.12), { widthSegments: 6, heightSegments: 4, texel: 0.03 });
      wart.scale(1, 0.42, 1);
      const normal: Vec3 = [Math.cos(angle) * 0.6, 1, Math.sin(angle) * 0.6];
      attach(builder, wart, fleshMaterial, [Math.cos(angle) * r, y, Math.sin(angle) * r], angle,
        Math.atan2(Math.hypot(normal[0], normal[2]), normal[1]) * 0.5);
    }
  }
  return builder;
}

/** A fairy ring or a rotting-log cluster of mushrooms at varied growth stages. */
/**
 * A cluster of mushrooms at varied growth stages.
 *
 * `fairyRing` arranges them on a circle, which is how a mycelium fruits; with it
 * off they scatter through the patch, which is how a rotting log fruits.
 */
export function mushroomCluster(options: MushroomOptions & { count?: number; spread?: number; fairyRing?: boolean }): MeshBuilder {
  const rng = detailRng(options.seed ?? 53);
  const builder = new MeshBuilder();
  const count = Math.max(1, Math.round(options.count ?? 6));
  const spread = Math.max(0.04, options.spread ?? 0.3);
  const budget = budgetOf(options.quality, options.budget);
  const height = options.height ?? 0.12;
  // The cheapest honest mushroom is a cap over a stipe: about 200 triangles.
  const plan = planChildren(count, 200, budget);
  for (let index = 0; index < plan.modeled; index += 1) {
    const angle = (index / plan.modeled) * Math.PI * 2 + range(rng, -0.25, 0.25);
    const ringed = options.fairyRing ?? true;
    const distance = ringed ? spread * range(rng, 0.72, 1) : spread * Math.sqrt(range(rng, 0, 1));
    const growth = range(rng, 0.45, 1.25);
    const single = mushroom({
      ...options,
      height: height * growth,
      capRadius: (options.capRadius ?? height * 0.58) * growth * range(rng, 0.8, 1.15),
      seed: (options.seed ?? 53) + index * 61 + 5,
      budget: plan.each,
      ring: options.ring ?? chance(rng, 0.4),
      spots: chance(rng, 0.5),
    });
    single.translate(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    builder.add(single);
  }
  return builder;
}

/* ------------------------------------------------------------- ferns, reeds */

export interface FernOptions {
  /** Ground to the tip of the tallest frond, in metres. */
  height?: number;
  fronds?: number;
  seed?: number;
  /** 0 = an unfurled frond, 1 = a fiddlehead still in its crozier. */
  curl?: number;
  /** Pinnae per frond before the budget cuts in. */
  pinnae?: number;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/**
 * One frond: a rachis swept along a curve that arcs out and then droops, with a
 * pair of pinnae at each station whose length follows a profile — short at the
 * base, longest a third of the way up, tapering to the tip.
 *
 * That profile is the whole recognisability of a fern. Uniform pinnae read as a
 * feather; the tapered ladder reads as a frond.
 */
export function fernFrond(options: {
  length: number;
  pinnae?: number;
  curl?: number;
  seed?: number;
  droop?: number;
  material?: string;
  budget?: number;
}): MeshBuilder {
  const seed = options.seed ?? 59;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const length = Math.max(0.05, options.length);
  const curl = Math.min(1, Math.max(0, options.curl ?? 0));
  const droop = options.droop ?? 0.42;
  const material = options.material ?? 'foliage';
  const budget = Math.max(60, options.budget ?? qualityTriangles('medium'));
  // The rachis is the irreducible cost of a frond — every station is a ring of
  // five points around the sweep — so a poor frond gets a coarser curve rather
  // than fewer pinnae. Fewer pinnae would change what the frond looks like;
  // fewer stations only changes how smoothly it bends.
  const stations = budget > 900 ? 9 : budget > 450 ? 6 : 4;
  const rachisCost = stations * 12 + 14;

  // The rachis spine. Without curl it arcs outward and sags at the tip; with
  // curl the tip coils back on itself, which is what a crozier does.
  const spine: Vec3[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    if (curl > 0.01 && t > 1 - curl * 0.42) {
      const s = (t - (1 - curl * 0.42)) / (curl * 0.42);
      const coilAngle = s * Math.PI * 1.9 * curl;
      const coilRadius = length * 0.075 * curl * (1 - s * 0.35);
      const base = spine[spine.length - 1] ?? ([0, 0, 0] as Vec3);
      spine.push([
        base[0] + Math.sin(coilAngle) * coilRadius * 0.35,
        base[1] + Math.cos(coilAngle) * coilRadius - coilRadius * 0.2,
        base[2],
      ]);
      continue;
    }
    const reach = length * 0.32 * Math.pow(t, 1.6);
    spine.push([reach, length * t - droop * length * Math.pow(t, 2.4), 0]);
  }
  const rachis = sweep(spine, {
    texel: 0.06,
    resample: 1,
    section: (t) => circle(Math.max(0.0012, length * 0.014 * (1 - 0.7 * t)), 5),
    caps: true,
  });
  builder.add(rachis, undefined, material);

  // Pinnae: pairs of blades, each a serrated comb so the leaflets read.
  const wanted = Math.max(3, Math.round(options.pinnae ?? Math.round(length / 0.035)));
  // One unit is a pair of pinnae: two blades of eight triangles each.
  const plan = planRepeatedUnits(wanted, 16, Math.max(32, budget - rachisCost), stations > 5 ? 4 : 2);
  for (let index = 0; index < plan.modeled; index += 1) {
    const t = 0.06 + (index / plan.modeled) * 0.88;
    const stationIndex = Math.min(spine.length - 1, Math.max(0, Math.round(t * stations)));
    const origin = spine[stationIndex]!;
    // Longest a third of the way up, tapering to both ends.
    const profile = Math.pow(Math.sin(Math.PI * (0.18 + 0.82 * t)), 0.85);
    const pinnaLength = length * 0.3 * profile;
    if (pinnaLength < 0.006) continue;
    for (const side of [-1, 1] as const) {
      const pinna = blade({
        length: pinnaLength,
        width: pinnaLength * 0.2,
        widest: 0.28,
        camber: 0.3,
        droop: range(rng, 0.15, 0.4),
        segments: 2,
        across: 2,
        serrate: 0.55,
      });
      // Pinnae lie nearly perpendicular to the rachis and alternate slightly.
      attach(builder, pinna, material, [...origin] as Vec3, side > 0 ? 0.25 : Math.PI - 0.25,
        Math.PI * 0.5 - side * range(rng, 0.1, 0.4), side * range(rng, -0.3, 0.3));
    }
  }
  return builder;
}

/** A fern crown: fronds radiating from a central rootstock, outer ones lower. */
export function fern(options: FernOptions = {}): MeshBuilder {
  const seed = options.seed ?? 61;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.08, options.height ?? 0.7);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'foliage';
  const wanted = Math.max(3, Math.round(options.fronds ?? Math.round(4 + height * 5)));
  // A frond's floor is its rachis plus two pairs of pinnae.
  const plan = planChildren(wanted, 150, budget);

  // A short rootstock, so the fronds emerge from something rather than a point.
  const stock = cylinder(height * 0.045, height * 0.06, height * 0.09, { radialSegments: 7, texel: 0.05 });
  fracture(stock, { amplitude: height * 0.008, frequency: 30, seed: seed + 1, recompute: true });
  stock.translate(0, height * 0.045, 0);
  builder.add(stock, undefined, 'bark');

  const perFrond = Math.max(90, plan.each - Math.ceil(90 / plan.modeled));
  for (let index = 0; index < plan.modeled; index += 1) {
    // Outer fronds are longer and lie flatter, which gives the crown its vase.
    const t = index / Math.max(1, plan.modeled - 1);
    const yaw = index * 2.399963 + range(rng, -0.2, 0.2);
    const tilt = range(rng, 0.42, 0.95) + t * 0.25;
    const frondLength = height * range(rng, 0.7, 1.05) * (1 - 0.18 * Math.abs(t - 0.5) * 2);
    const frond = fernFrond({
      length: frondLength,
      pinnae: options.pinnae,
      curl: chance(rng, 0.18) ? range(rng, 0.5, 1) : (options.curl ?? 0) * range(rng, 0, 0.4),
      seed: seed + index * 71 + 13,
      droop: range(rng, 0.3, 0.55) + tilt * 0.2,
      material,
      budget: perFrond,
    });
    attach(builder, frond, material, [0, height * 0.07, 0], yaw, tilt);
  }
  fitHeight(builder, height, 2.2);
  return builder;
}

export interface ReedOptions {
  height?: number;
  stalks?: number;
  seed?: number;
  /** The flowering head; without it a reed is just a tall grass blade. */
  heads?: boolean;
  spread?: number;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/** A reed or rush: hollow stalks with sheathing leaves and a cigar seed head. */
export function reed(options: ReedOptions = {}): MeshBuilder {
  const seed = options.seed ?? 67;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.15, options.height ?? 1.6);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'reed';
  const spread = Math.max(0.02, options.spread ?? height * 0.14);
  const wanted = Math.max(1, Math.round(options.stalks ?? Math.round(3 + height * 2)));
  // A stalk is its culm, two or three sheathing leaves and a seed head; the head
  // alone is a lathe of eighty triangles, so it sets the floor.
  const plan = planChildren(wanted, 200, budget);
  const heads = options.heads ?? true;

  for (let index = 0; index < plan.modeled; index += 1) {
    const stalkSeed = seed + index * 83 + 17;
    const stalkRng = detailRng(stalkSeed);
    // The seed head rides on top of the stalk, so the stalk stops short enough
    // that stalk plus head still lands on the requested height.
    const stalkHeight = height * range(rng, 0.6, 0.82);
    const angle = range(rng, 0, Math.PI * 2);
    const distance = index === 0 ? 0 : spread * Math.sqrt(range(rng, 0.25, 1));
    const origin: Vec3 = [Math.cos(angle) * distance, 0, Math.sin(angle) * distance];
    const lean = range(rng, 0.03, 0.14);
    const spine = leaningSpine(stalkHeight, lean, range(rng, 0, Math.PI * 2), 5);

    const culm = sweep(spine, {
      texel: 0.14,
      section: (t) => circle(Math.max(0.004, height * 0.011 * (1 - 0.45 * t)), 7, 3, 0.05),
      caps: true,
    });
    culm.translate(origin[0], origin[1], origin[2]);
    builder.add(culm, undefined, material);

    // Sheathing leaves: long, narrow, drooping blades from the lower stalk.
    const leaves = planRepeatedUnits(intRange(stalkRng, 2, 4), 20, Math.max(60, budget / plan.modeled - 90), 1);
    for (let leafIndex = 0; leafIndex < leaves.modeled; leafIndex += 1) {
      const at = range(stalkRng, 0.1, 0.55);
      const leaf = blade({
        length: stalkHeight * range(stalkRng, 0.22, 0.38),
        width: stalkHeight * range(stalkRng, 0.02, 0.035),
        widest: 0.18,
        camber: 0.35,
        droop: range(stalkRng, 0.45, 0.8),
        segments: 3,
        across: 2,
      });
      const stationIndex = Math.min(spine.length - 1, Math.round(at * 5));
      const station = spine[stationIndex]!;
      // Reeds hold their leaves closer to the culm than grasses do; splaying them
      // past horizontal would make the clump twice as wide as it is tall.
      attach(builder, leaf, material,
        [origin[0] + station[0], station[1], origin[2] + station[2]],
        range(stalkRng, 0, Math.PI * 2), range(stalkRng, 0.5, 0.92));
    }

    if (!heads) continue;
    // The seed head: a tapering spike with a bristly surface.
    const headLength = stalkHeight * range(stalkRng, 0.14, 0.24);
    const headProfile: Vec2[] = [];
    for (let step = 0; step <= 5; step += 1) {
      const t = step / 5;
      const r = height * 0.021 * Math.pow(Math.sin(t * Math.PI * 0.92), 0.4) * (1 - 0.55 * Math.pow(t, 4));
      headProfile.push([Math.max(0.0015, r), headLength * t]);
    }
    const head = lathe(headProfile, { segments: 8, texel: 0.05, caps: false });
    const tip = spine[spine.length - 1]!;
    const below = spine[spine.length - 2]!;
    const tilt = Math.atan2(Math.hypot(tip[0] - below[0], tip[2] - below[2]), Math.max(1e-4, tip[1] - below[1]));
    attach(builder, head, 'thatch', [origin[0] + tip[0], tip[1] - headLength * 0.06, origin[2] + tip[2]],
      Math.atan2(tip[2] - below[2], tip[0] - below[0]), tilt);
  }
  fitHeight(builder, height, 1.6);
  return builder;
}

export interface BambooOptions {
  height?: number;
  culms?: number;
  seed?: number;
  /** How far apart the nodes are, as a fraction of the culm height. */
  nodeSpacing?: number;
  leaves?: boolean;
  spread?: number;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/**
 * A bamboo clump: hollow culms in segments between raised nodes, with leaf
 * sprays from the upper nodes.
 *
 * The nodes are the tell. A bamboo culm is a stack of tubes, each ending in a
 * ring slightly wider than the tube, and nothing else in a forest has that
 * rhythm. Modelling each ring as its own short lathe is a handful of triangles
 * and buys the whole silhouette.
 */
export function bamboo(options: BambooOptions = {}): MeshBuilder {
  const seed = options.seed ?? 71;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.4, options.height ?? 3.6);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'reed';
  const spread = Math.max(0.06, options.spread ?? height * 0.1);
  const wanted = Math.max(1, Math.round(options.culms ?? Math.round(3 + height * 0.8)));
  const spacing = Math.min(0.4, Math.max(0.08, options.nodeSpacing ?? 0.16));
  const nodes = Math.max(3, Math.round(1 / spacing));
  // A culm is its sweep (a ring of eight per node) plus a turned ring at every
  // node; together they are the plant's identifying rhythm and are never cut.
  // Leaf sprays are what the budget decides.
  const culmCost = nodes * 16 + nodes * 32;
  const plan = planChildren(wanted, culmCost + 60, budget);
  const leafBudget = Math.max(0, plan.each - culmCost);

  for (let index = 0; index < plan.modeled; index += 1) {
    const culmSeed = seed + index * 97 + 23;
    const culmRng = detailRng(culmSeed);
    // Leaves sprout above the top node, so the culm stops short of `height`.
    const culmHeight = height * range(rng, 0.7, 0.9);
    const baseRadius = height * range(rng, 0.014, 0.023);
    const angle = range(rng, 0, Math.PI * 2);
    const distance = index === 0 ? 0 : spread * Math.sqrt(range(rng, 0.3, 1));
    const originX = Math.cos(angle) * distance;
    const originZ = Math.sin(angle) * distance;
    const lean = range(rng, 0.02, 0.09);
    const leanDirection = range(rng, 0, Math.PI * 2);

    // One sweep for the whole culm, so the lean is continuous; the internodes
    // are then ringed individually, which is cheaper than stacking cylinders.
    const spine = leaningSpine(culmHeight, lean, leanDirection, nodes);
    const culm = sweep(spine, {
      texel: 0.22,
      section: (t) => circle(Math.max(0.004, baseRadius * (1 - 0.42 * Math.pow(t, 1.4))), 8),
      caps: true,
    });
    culm.translate(originX, 0, originZ);
    builder.add(culm, undefined, material);

    for (let node = 1; node <= nodes; node += 1) {
      const t = node / nodes;
      const point = spine[Math.min(spine.length - 1, node)]!;
      const radius = baseRadius * (1 - 0.42 * Math.pow(t, 1.4));
      const ring = cylinder(radius * 1.22, radius * 1.22, culmHeight * 0.018, { radialSegments: 8, texel: 0.06 });
      ring.translate(originX + point[0], point[1], originZ + point[2]);
      builder.add(ring, undefined, material);

      // Leaf sprays only from the upper nodes, where light reaches.
      if (options.leaves === false) continue;
      if (t < 0.45) continue;
      const sprays = planRepeatedUnits(intRange(culmRng, 2, 4), 32, Math.max(0, leafBudget / Math.max(1, nodes * 0.55)), 0);
      for (let spray = 0; spray < sprays.modeled; spray += 1) {
        const sprayAngle = range(culmRng, 0, Math.PI * 2);
        const leafCount = planRepeatedUnits(4, 8, 32, 2);
        for (let leafIndex = 0; leafIndex < leafCount.modeled; leafIndex += 1) {
          const leaf = blade({
            length: height * range(culmRng, 0.07, 0.13),
            width: height * range(culmRng, 0.008, 0.014),
            widest: 0.45,
            camber: 0.25,
            droop: range(culmRng, 0.35, 0.7),
            segments: 2,
            across: 2,
          });
          attach(builder, leaf, 'foliage-olive',
            [originX + point[0], point[1], originZ + point[2]],
            sprayAngle + leafIndex * 0.42 + range(culmRng, -0.2, 0.2),
            1.1 + range(culmRng, -0.25, 0.3));
        }
      }
    }
  }
  fitHeight(builder, height, 1.5);
  return builder;
}

/* ------------------------------------------------------------------- grass */

export interface GrassTuftOptions {
  height?: number;
  clumps?: number;
  blades?: number;
  seed?: number;
  spread?: number;
  seedHeads?: boolean;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/** A tussock: several clumps of blades, taller in the middle, some in seed. */
export function grassTuft(options: GrassTuftOptions = {}): MeshBuilder {
  const seed = options.seed ?? 73;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.04, options.height ?? 0.45);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'grass';
  const spread = Math.max(0.03, options.spread ?? height * 0.7);
  const clumps = Math.max(1, Math.round(options.clumps ?? Math.round(2 + height * 4)));
  // A clump is a `tuft`: eight blades, each a drooping strip of sixteen
  // triangles, plus the variance in blade count and length.
  const plan = planChildren(clumps, 150, budget);

  for (let index = 0; index < plan.modeled; index += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = index === 0 ? 0 : spread * Math.sqrt(range(rng, 0.2, 1));
    // The centre of the tussock is the tallest part; the edges trail off.
    const clumpHeight = height * (1 - 0.4 * (distance / spread)) * range(rng, 0.8, 1.12);
    const clump = tuft({
      height: Math.max(0.03, clumpHeight),
      blades: Math.max(4, Math.round((options.blades ?? 8) * range(rng, 0.7, 1.3))),
      radius: clumpHeight * range(rng, 0.14, 0.26),
      seed: seed + index * 101 + 7,
      width: clumpHeight * 0.05,
    });
    clump.rotateY(range(rng, 0, Math.PI * 2));
    clump.translate(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    builder.add(clump, undefined, material);

    if (!options.seedHeads) continue;
    if (!chance(rng, 0.45)) continue;
    const headHeight = clumpHeight * range(rng, 0.95, 1.2);
    const headProfile: Vec2[] = [];
    for (let step = 0; step <= 4; step += 1) {
      const t = step / 4;
      headProfile.push([Math.max(0.002, clumpHeight * 0.028 * Math.pow(Math.sin(t * Math.PI * 0.9), 0.5)), clumpHeight * 0.14 * t]);
    }
    const head = lathe(headProfile, { segments: 6, texel: 0.04, caps: false });
    attach(builder, head, 'thatch',
      [Math.cos(angle) * distance, headHeight * 0.88, Math.sin(angle) * distance],
      range(rng, 0, Math.PI * 2), range(rng, -0.2, 0.2));
  }
  // Budget guard: a tussock that could not afford all of its clumps still fills
  // its footprint with blades rather than leaving bare ground.
  if (plan.modeled < clumps) {
    const filler = tuft({ height: height * 0.7, blades: 6, radius: spread * 0.8, seed: seed + 991, width: height * 0.04 });
    builder.add(filler, undefined, material);
  }
  fitHeight(builder, height, 1.6);
  return builder;
}

/* ------------------------------------------------------------------ cacti */

export type CactusStyle = 'saguaro' | 'barrel' | 'pad' | 'column';

export interface CactusOptions {
  height?: number;
  radius?: number;
  style?: CactusStyle;
  arms?: number;
  pads?: number;
  seed?: number;
  /** Spines as real geometry; off by default because they cost more than they show. */
  spines?: boolean;
  flower?: boolean;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/**
 * A ribbed column with the fluting swept into its cross-section.
 *
 * Cactus ribs are not decoration: they are how the plant expands when it rains,
 * and they are also the only thing that gives a green cylinder a shading
 * gradient. Modelling them as a lobed section costs nothing extra over a circle.
 */
function ribbedColumn(options: {
  height: number;
  radius: number;
  ribs?: number;
  taper?: number;
  seed?: number;
  lean?: number;
  stations?: number;
  texel?: number;
}): MeshBuilder {
  const rng = detailRng(options.seed ?? 79);
  const ribs = Math.max(4, Math.round(options.ribs ?? 9));
  const taper = options.taper ?? 0.18;
  const stations = Math.max(4, Math.round(options.stations ?? 8));
  const lean = options.lean ?? 0;
  const spine = leaningSpine(options.height, lean, range(rng, 0, Math.PI * 2), stations);
  return sweep(spine, {
    texel: options.texel ?? 0.4,
    section: (t) => circle(options.radius * (1 - taper * Math.pow(t, 1.3)), ribs * 2, ribs, 0.14),
    caps: true,
  });
}

/** A cactus: saguaro with arms, barrel, prickly-pear pads, or a plain column. */
export function cactus(options: CactusOptions = {}): MeshBuilder {
  const seed = options.seed ?? 83;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const style = options.style ?? 'saguaro';
  const height = Math.max(0.15, options.height ?? (style === 'barrel' ? 0.6 : style === 'pad' ? 1.1 : 2.8));
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'cactus';
  const radius = Math.max(0.03, options.radius ?? height * (style === 'barrel' ? 0.42 : style === 'pad' ? 0.16 : 0.09));

  if (style === 'pad') {
    // Prickly pear: flattened ellipsoid pads joined at their edges, each one
    // rotated a little off the last so the plant fans outward.
    const wanted = Math.max(2, Math.round(options.pads ?? Math.round(3 + height)));
    const plan = planRepeatedUnits(wanted, 180, budget, 2);
    const padRadius = radius * range(rng, 1.5, 2.1);
    for (let index = 0; index < plan.modeled; index += 1) {
      const generation = index < 2 ? 0 : index < 4 ? 1 : 2;
      const padRadiusHere = padRadius * (1 - generation * 0.16);
      const pad = sphere(padRadiusHere, {
        widthSegments: 12, heightSegments: 8, texel: 0.3,
        radii: [padRadiusHere, padRadiusHere * 1.25, padRadiusHere * 0.26],
      });
      fracture(pad, { amplitude: padRadius * 0.035, frequency: 9, seed: seed + index * 29, recompute: true });
      const yaw = index * 2.1 + range(rng, -0.3, 0.3);
      const rise = padRadius * 1.25 * (1 + generation * 1.5);
      const offset = generation * padRadius * 0.85;
      attach(builder, pad, material,
        [Math.cos(yaw) * offset, Math.min(height, rise), Math.sin(yaw) * offset],
        yaw, range(rng, -0.35, 0.35) + generation * 0.12, range(rng, -0.5, 0.5));
    }
    if (options.flower) {
      const bloom = flower({ height: radius * 1.1, radius: radius * 0.6, style: 'rose', seed: seed + 5, petals: 7, budget: 260, petalMaterial: 'petal-warm' });
      bloom.translate(0, height * 0.86, 0);
      builder.add(bloom);
    }
    fitHeight(builder, height, 1.4);
    return builder;
  }

  if (style === 'barrel') {
    const body = ribbedColumn({ height, radius, ribs: Math.max(8, Math.round(radius * 40)), taper: 0.5, seed, stations: 7, texel: 0.3 });
    builder.add(body, undefined, material);
    // A woolly crown, which is where a barrel cactus flowers.
    const crown = sphere(radius * 0.55, { widthSegments: 10, heightSegments: 5, phiLength: Math.PI * 0.5, texel: 0.2 });
    crown.scale(1, 0.5, 1);
    crown.translate(0, height * 0.96, 0);
    builder.add(crown, undefined, 'wool');
    if (options.flower) {
      const ring = planRepeatedUnits(7, 90, Math.max(120, budget * 0.4), 3);
      for (let index = 0; index < ring.modeled; index += 1) {
        const angle = (index / ring.modeled) * Math.PI * 2;
        const bloom = flower({ height: radius * 0.8, radius: radius * 0.34, style: 'daisy', seed: seed + index * 13, petals: 9, budget: 150, petalMaterial: 'petal-warm' });
        attach(builder, bloom, 'petal-warm', [Math.cos(angle) * radius * 0.5, height * 0.9, Math.sin(angle) * radius * 0.5], angle, range(rng, -0.3, 0.1));
      }
    }
    fitHeight(builder, height, 1.4);
    return builder;
  }

  // Saguaro and plain column share a trunk; the saguaro adds elbows. The trunk
  // stops one crown radius short so the dome that rounds it off ends exactly at
  // `height` instead of a radius above it.
  const crownRadius = radius * 1.02;
  const column = ribbedColumn({
    height: Math.max(radius * 2, height - crownRadius), radius,
    ribs: Math.max(7, Math.round(radius * 26)), taper: 0.2, seed,
    lean: range(rng, 0.01, 0.05), stations: 10, texel: 0.35,
  });
  builder.add(column, undefined, material);
  const rounded = sphere(crownRadius, { widthSegments: 10, heightSegments: 5, phiLength: Math.PI * 0.5, texel: 0.3 });
  rounded.translate(0, height - crownRadius, 0);
  builder.add(rounded, undefined, material);

  if (style === 'saguaro') {
    const wanted = Math.max(0, Math.round(options.arms ?? intRange(rng, 1, 3)));
    const plan = planRepeatedUnits(wanted, 320, Math.max(200, budget * 0.6), 0);
    for (let index = 0; index < plan.modeled; index += 1) {
      const armRadius = radius * range(rng, 0.5, 0.66);
      const attachAt = height * range(rng, 0.3, 0.55);
      const yaw = index * 2.4 + range(rng, -0.4, 0.4);
      const out = radius * range(rng, 2.2, 3.4);
      // Attachment plus rise must stay under `height`, or the arm outgrows the
      // plant it belongs to.
      const up = height * range(rng, 0.2, 0.34);
      // An elbow: out from the trunk, a rounded bend, then up. Built as one
      // spine so the arm and the trunk read as a single continuous plant.
      const spine: Vec3[] = [
        [0, attachAt, 0],
        [Math.cos(yaw) * radius * 0.9, attachAt - armRadius * 0.4, Math.sin(yaw) * radius * 0.9],
        [Math.cos(yaw) * out, attachAt + armRadius * 0.25, Math.sin(yaw) * out],
        [Math.cos(yaw) * out * 1.02, attachAt + up * 0.55, Math.sin(yaw) * out * 1.02],
        [Math.cos(yaw) * out * 0.98, attachAt + up, Math.sin(yaw) * out * 0.98],
      ];
      const arm = sweep(spine, {
        texel: 0.35,
        resample: 3,
        section: (t) => circle(armRadius * (t > 0.92 ? 1 - (t - 0.92) * 4 : 1), 12, 7, 0.12),
        caps: true,
      });
      builder.add(arm, undefined, material);
      const tip = sphere(armRadius * 1.02, { widthSegments: 8, heightSegments: 4, phiLength: Math.PI * 0.5, texel: 0.25 });
      tip.translate(spine[4]![0], spine[4]![1], spine[4]![2]);
      builder.add(tip, undefined, material);
    }
  }

  if (options.spines) {
    // Spines in short whorls along the ribs. Only the near ones are modelled;
    // the rest are the texture's job.
    const whorls = planRepeatedUnits(Math.round(height / (radius * 2.4)), 42, Math.max(120, budget * 0.3), 3);
    for (let index = 0; index < whorls.modeled; index += 1) {
      const t = (index + 0.5) / whorls.modeled;
      const y = height * t * 0.94;
      const ringRadius = radius * (1 - 0.2 * Math.pow(t, 1.3));
      const around = planRepeatedUnits(6, 7, 42, 3);
      for (let spineIndex = 0; spineIndex < around.modeled; spineIndex += 1) {
        const angle = (spineIndex / around.modeled) * Math.PI * 2 + t * 2;
        const spinePart = prism({ sides: 3, radius: radius * 0.045, height: radius * 0.4, topScale: 0.05 });
        attach(builder, spinePart, 'bone',
          [Math.cos(angle) * ringRadius, y, Math.sin(angle) * ringRadius], angle, Math.PI * 0.5 - 0.35);
      }
    }
  }
  if (options.flower) {
    const crown = planRepeatedUnits(5, 120, Math.max(120, budget * 0.25), 2);
    for (let index = 0; index < crown.modeled; index += 1) {
      const angle = (index / crown.modeled) * Math.PI * 2;
      const bloom = flower({ height: radius * 1.4, radius: radius * 0.5, style: 'lily', seed: seed + index * 17, petals: 6, budget: 170, petalMaterial: 'petal-pale' });
      attach(builder, bloom, 'petal-pale', [Math.cos(angle) * radius * 0.4, height * 0.94, Math.sin(angle) * radius * 0.4], angle, range(rng, -0.4, 0.2));
    }
  }
  fitHeight(builder, height, 1.4);
  return builder;
}

/* ------------------------------------------------------------------- bushes */

export interface BushOptions {
  /** Overall height, in metres. */
  height?: number;
  radius?: number;
  seed?: number;
  /** How many main stems fan out from the base. */
  stems?: number;
  /** Leaf blobs per stem tip. */
  lobes?: number;
  berries?: boolean;
  /** Bare winter bush: stems only, no leaf clusters. */
  bare?: boolean;
  quality?: Quality;
  budget?: number;
  leafMaterial?: string;
  stemMaterial?: string;
}

/**
 * A bush: stems fanning from a single base, each crowned with leaf blobs.
 *
 * The difference between a bush and a small tree is that a bush has no trunk —
 * the stems start at the ground and divide immediately, so the mass is widest at
 * the bottom. Modelling the stems as real branches, rather than hiding them
 * inside the foliage, is what makes the silhouette break up against the sky.
 */
export function bush(options: BushOptions = {}): MeshBuilder {
  const seed = options.seed ?? 89;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.15, options.height ?? 1.2);
  const radius = Math.max(0.1, options.radius ?? height * 0.8);
  const budget = budgetOf(options.quality, options.budget);
  const leafMaterial = options.leafMaterial ?? 'foliage';
  const stemMaterial = options.stemMaterial ?? 'bark';
  const bare = options.bare ?? false;

  const stemCount = Math.max(2, Math.round(options.stems ?? intRange(rng, 4, 7)));
  // A stem is a `branch`, and a branch's cost is decided by its twigs long
  // before its segments: two twigs cost more than the limb they hang from.
  const stems = planChildren(stemCount, bare ? 120 : 200, budget);
  const twigBudget = stems.each * 0.42;
  const twigs = twigBudget > 340 ? 2 : twigBudget > 170 ? 1 : 0;
  const stemSegments = stems.each > 380 ? 5 : 4;
  const stemCost = branchCost(stemSegments, twigs);
  const blobCount = Math.max(1, Math.round(options.lobes ?? intRange(rng, 2, 4)));
  // Per stem: what is left of that stem's allowance once its own branch is paid
  // for. Multiplying by the stem count here would spend the same triangles once
  // per stem and blow the budget by exactly that factor.
  const leafBudget = bare ? 0 : Math.max(LEAF_TRIANGLES * 6, stems.each - stemCost);
  const blobs = bare ? { modeled: 0, each: 0 } : planChildren(blobCount, LEAF_TRIANGLES * 6, leafBudget);
  const leavesPerBlob = Math.max(6, Math.min(40, Math.round(blobs.each / LEAF_TRIANGLES)));

  for (let index = 0; index < stems.modeled; index += 1) {
    const yaw = (index / stems.modeled) * Math.PI * 2 + range(rng, -0.3, 0.3);
    const tilt = range(rng, 0.22, 0.62);
    // Stems are short relative to the bush: the crown is leaf blobs, and a stem
    // as long as the plant is tall would put them above the requested height.
    const stemLength = height * range(rng, 0.5, 0.72);
    const stem = branch({
      length: stemLength,
      radiusBase: height * range(rng, 0.022, 0.04),
      radiusTip: height * 0.012,
      curve: range(rng, 0.3, 0.75),
      seed: seed + index * 37 + 11,
      segments: stemSegments,
      twigs,
    });
    attach(builder, stem, stemMaterial, [Math.cos(yaw) * radius * 0.08, 0, Math.sin(yaw) * radius * 0.08], yaw, tilt);

    if (bare) continue;
    // Leaf blobs sit at and around the stem tip, so the crown is lumpy rather
    // than a ball: `leafCluster` already clumps its leaves into lobes.
    const tipReach = Math.sin(tilt) * stemLength * 0.72;
    const tipHeight = Math.cos(tilt * 0.5) * stemLength * 0.86;
    for (let blob = 0; blob < blobs.modeled; blob += 1) {
      const blobAngle = yaw + (blob / blobs.modeled) * Math.PI * 1.2 + range(rng, -0.4, 0.4);
      const blobRadius = radius * range(rng, 0.28, 0.42) * (1 - 0.15 * blob);
      const cluster = leafCluster({
        radius: blobRadius,
        leaves: leavesPerBlob,
        seed: seed + index * 53 + blob * 19 + 3,
        length: height * 0.075,
        width: height * 0.035,
        clumps: intRange(rng, 2, 4),
      });
      // A leaf blob reaches about its own radius past its centre, so its centre
      // is held that far below the crown line.
      cluster.translate(
        Math.cos(blobAngle) * tipReach * range(rng, 0.65, 1.1),
        Math.min(height - blobRadius * 1.2, Math.max(blobRadius * 0.6, tipHeight + range(rng, -0.12, 0.16) * height)),
        Math.sin(blobAngle) * tipReach * range(rng, 0.65, 1.1),
      );
      builder.add(cluster, undefined, blob % 2 === 0 ? leafMaterial : 'foliage-dark');
    }

    if (!options.berries) continue;
    const berryPlan = planRepeatedUnits(5, 26, Math.max(60, budget * 0.12), 2);
    for (let berry = 0; berry < berryPlan.modeled; berry += 1) {
      const angle = range(rng, 0, Math.PI * 2);
      const fruit = sphere(height * range(rng, 0.018, 0.03), { widthSegments: 6, heightSegments: 4, texel: 0.05 });
      attach(builder, fruit, 'petal',
        [Math.cos(angle) * radius * range(rng, 0.35, 0.75), Math.min(height * 0.9, tipHeight * range(rng, 0.55, 0.95)), Math.sin(angle) * radius * range(rng, 0.35, 0.75)]);
    }
  }
  fitHeight(builder, height, 1.35);
  return builder;
}

/** A clipped hedge run: dense, flat-topped, and square in section. */
export function hedge(options: {
  length: number;
  height?: number;
  depth?: number;
  seed?: number;
  posts?: boolean;
  quality?: Quality;
  budget?: number;
}): MeshBuilder {
  const seed = options.seed ?? 101;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const length = Math.max(0.4, options.length);
  const height = Math.max(0.2, options.height ?? 1.1);
  const depth = Math.max(0.2, options.depth ?? 0.6);
  const budget = budgetOf(options.quality, options.budget);

  // The body is a box rounded off by noise, then clothed in leaf blobs along
  // the top so the silhouette is not a straight line.
  const body = box(length, height * 0.88, depth, { bevel: depth * 0.22, bevelSegments: 1, texel: 0.5 });
  fracture(body, { amplitude: depth * 0.07, frequency: 3.4, seed, preserveBase: true, recompute: true });
  body.translate(0, height * 0.44, 0);
  builder.add(body, undefined, 'foliage-dark');

  const blobs = planChildren(Math.round(length / (depth * 0.9)), 130, Math.max(150, budget * 0.6));
  for (let index = 0; index < blobs.modeled; index += 1) {
    const at = length * ((index + 0.5) / blobs.modeled - 0.5);
    const blobRadius = depth * range(rng, 0.4, 0.56);
    const cluster = leafCluster({
      radius: blobRadius,
      leaves: Math.max(8, Math.min(40, Math.round(blobs.each / LEAF_TRIANGLES))),
      seed: seed + index * 43 + 5,
      length: height * 0.07,
      width: height * 0.03,
      clumps: 3,
    });
    // A clipped hedge has a top line, so the blobs are squashed and seated low
    // enough that their own reach finishes at `height` rather than above it.
    cluster.scale(1, 0.5, 1);
    cluster.translate(
      at + range(rng, -depth * 0.1, depth * 0.1),
      height * 0.88 - blobRadius * 0.35,
      range(rng, -depth * 0.1, depth * 0.1),
    );
    builder.add(cluster, undefined, 'foliage');
  }
  if (options.posts) {
    const posts = planRepeatedUnits(Math.round(length / 2.2) + 1, 60, Math.max(80, budget * 0.2), 2);
    for (let index = 0; index < posts.modeled; index += 1) {
      const at = length * ((index / Math.max(1, posts.modeled - 1)) - 0.5);
      // Stakes hold the hedge while it grows, so they stand just under the clip
      // line rather than proud of it.
      const stake = cylinder(depth * 0.06, depth * 0.075, height * 0.94, { radialSegments: 6, texel: 0.2 });
      stake.translate(at, height * 0.47, 0);
      builder.add(stake, undefined, 'wood-dark');
    }
  }
  return builder;
}

/* -------------------------------------------------------------- dead wood */

export interface TreeStumpOptions {
  /** Height of the cut above ground, in metres. */
  height?: number;
  radius?: number;
  seed?: number;
  roots?: number;
  /** New shoots from the collar, which is what a cut stump does next. */
  shoots?: boolean;
  /** A rotted core, open to the sky. */
  hollow?: number;
  moss?: boolean;
  quality?: Quality;
  budget?: number;
}

/**
 * A cut stump: a flared trunk, a sawn top with growth rings, and root shoulders.
 *
 * The cut face is where a stump is identified, so it is modelled rather than
 * textured: a shallow cone of fresh wood with rings raised as real steps, a
 * chamfered bark collar around it, and — when `hollow` is set — a rotted core
 * sunk below the surface.
 */
export function treeStump(options: TreeStumpOptions = {}): MeshBuilder {
  const seed = options.seed ?? 103;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.08, options.height ?? 0.5);
  const radius = Math.max(0.05, options.radius ?? height * 0.62);
  const budget = budgetOf(options.quality, options.budget);
  const hollow = Math.min(0.85, Math.max(0, options.hollow ?? 0));

  const body = trunk({
    height: height * 0.96,
    radiusBottom: radius,
    radiusTop: radius * 0.9,
    seed,
    fissures: 0.22,
    rootFlare: 0.4,
    segments: Math.max(8, Math.min(16, Math.round(budget / 120))),
    stations: 5,
  });
  builder.add(body, undefined, 'bark');

  // Root shoulders: wedges that carry the flare out into the ground.
  const wantedRoots = Math.max(0, Math.round(options.roots ?? intRange(rng, 3, 6)));
  const roots = planRepeatedUnits(wantedRoots, 40, Math.max(60, budget * 0.2), 2);
  for (let index = 0; index < roots.modeled; index += 1) {
    const angle = (index / roots.modeled) * Math.PI * 2 + range(rng, -0.3, 0.3);
    const reach = radius * range(rng, 1.15, 1.55);
    const root = prism({ sides: 4, radius: radius * range(rng, 0.16, 0.28), height: reach, topScale: 0.22 });
    root.scale(1, 1, 0.55);
    attach(builder, root, 'bark',
      [Math.cos(angle) * reach * 0.42, height * 0.12, Math.sin(angle) * reach * 0.42],
      angle, Math.PI * 0.5 - range(rng, 0.12, 0.3));
  }

  // ---- the cut face ----
  const topY = height * 0.96;
  const rings = planRepeatedUnits(6, 26, Math.max(60, budget * 0.25), 3);
  // Traversed from the bark inward. `lathe` derives each normal by rotating the
  // profile tangent, so an inward run across a nearly flat face is what leaves the
  // cut surface pointing up; traversed outward it would point down and the top of
  // the stump would disappear when seen from above.
  const faceProfile: Vec2[] = [];
  // The bark collar: the face meets the bark in a rounded arris, not a knife edge.
  faceProfile.push([radius * 1.01, topY - height * 0.075]);
  faceProfile.push([radius * 0.99, topY - height * 0.035]);
  const coreRadius = hollow > 0.01 ? radius * 0.9 * (1 - hollow) : 0;
  const faceOuter = radius * 0.94;
  for (let index = 0; index <= rings.modeled; index += 1) {
    const t = index / rings.modeled;
    const r = faceOuter + (coreRadius - faceOuter) * t;
    // Growth rings as small radial steps, so raking light reveals them.
    const step = (index % 2 === 0 ? 0 : 1) * height * 0.008 * (1 - t * 0.6);
    const y = topY + step - height * 0.012 * Math.pow(1 - t, 3);
    const last = index === rings.modeled && hollow <= 0.01;
    faceProfile.push([last ? 0 : Math.max(0.004, r), y]);
  }
  const face = lathe(faceProfile, { segments: Math.max(10, Math.min(20, Math.round(budget / 90))), texel: 0.18, caps: false });
  fracture(face, { amplitude: radius * 0.018, frequency: 12, seed: seed + 17, preserveBase: false, recompute: true });
  builder.add(face, undefined, hollow > 0.01 ? 'wood-dark' : 'wood-cut');

  if (hollow > 0.01) {
    // The inside of the shell, so looking down the hole shows rotted wood and a
    // floor of debris rather than seeing through to the sky. An open cylinder
    // faces away from its axis, so it is mirrored to face into the hole.
    const depth = height * hollow * 0.5;
    const wall = cylinder(coreRadius * 0.86, coreRadius, depth, { radialSegments: 12, caps: false, texel: 0.15 });
    wall.mirror('x');
    wall.translate(0, topY - depth * 0.5, 0);
    builder.add(wall, undefined, 'wood-dark');
    const floor = cylinder(coreRadius * 0.86, coreRadius * 0.86, Math.max(0.004, depth * 0.06), { radialSegments: 12, texel: 0.15 });
    floor.translate(0, topY - depth, 0);
    builder.add(floor, undefined, 'soil');
  }

  if (options.shoots ?? chance(rng, 0.6)) {
    const shootsPlan = planRepeatedUnits(intRange(rng, 3, 6), 40, Math.max(60, budget * 0.18), 2);
    for (let index = 0; index < shootsPlan.modeled; index += 1) {
      const angle = range(rng, 0, Math.PI * 2);
      const distance = radius * range(rng, 0.95, 1.5);
      // Coppice shoots stay lower than the stump that feeds them.
      const shoot = tuft({
        height: height * range(rng, 0.3, 0.72),
        blades: 4,
        radius: radius * 0.1,
        seed: seed + index * 23 + 5,
        width: height * 0.03,
      });
      shoot.translate(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
      builder.add(shoot, undefined, 'foliage');
    }
  }
  if (options.moss ?? chance(rng, 0.5)) {
    const mossPlan = planRepeatedUnits(3, 90, Math.max(60, budget * 0.12), 1);
    for (let index = 0; index < mossPlan.modeled; index += 1) {
      const angle = range(rng, 0, Math.PI * 2);
      const patch = sphere(radius * range(rng, 0.22, 0.36), { widthSegments: 8, heightSegments: 4, phiLength: Math.PI * 0.5, texel: 0.15 });
      fracture(patch, { amplitude: radius * 0.05, frequency: 14, seed: seed + index * 31, recompute: true });
      patch.scale(1, 0.32, 1);
      attach(builder, patch, 'moss',
        [Math.cos(angle) * radius * range(rng, 0.4, 0.95), topY * range(rng, 0.35, 0.98), Math.sin(angle) * radius * range(rng, 0.4, 0.95)],
        angle, range(rng, -1.3, -0.7));
    }
  }
  fitHeight(builder, height, 1.25, false);
  return builder;
}

export interface FallenLogOptions {
  /** Length along X, in metres. */
  length?: number;
  radius?: number;
  seed?: number;
  /** One end torn rather than sawn. */
  broken?: boolean;
  moss?: boolean;
  /** Branch stubs left on the top of the log. */
  stubs?: number;
  /** A strip of bark peeled off, exposing fresh wood. */
  peeled?: boolean;
  quality?: Quality;
  budget?: number;
}

/**
 * A fallen log lying along X, resting on the ground.
 *
 * A log on the forest floor is a habitat before it is an object: the butt end
 * keeps its root flare, one end is torn rather than cut, branch stubs stand up
 * along the top, bark peels away to show pale wood, and moss colonises the shady
 * side. Missing any of these makes it a brown cylinder on its side.
 */
export function fallenLog(options: FallenLogOptions = {}): MeshBuilder {
  const seed = options.seed ?? 107;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const length = Math.max(0.4, options.length ?? 3);
  const radius = Math.max(0.06, options.radius ?? length * 0.085);
  const budget = budgetOf(options.quality, options.budget);
  const broken = options.broken ?? true;
  const segments = Math.max(8, Math.min(18, Math.round(budget / 130)));

  // The log itself, built along Y and laid down, so the grain runs lengthwise.
  const spine: Vec3[] = [];
  const stations = 7;
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    // A fallen log sags under its own weight and never lies perfectly straight.
    spine.push([length * (t - 0.5), -Math.sin(t * Math.PI) * radius * 0.12, Math.sin(t * 4.2 + seed) * radius * 0.09]);
  }
  const log = sweep(spine, {
    texel: 0.55,
    resample: 1,
    section: (t) => circle(radius * (1.16 - 0.3 * t) * (1 + 0.05 * Math.sin(t * 9 + seed)), segments, 4, 0.035),
    caps: false,
  });
  fracture(log, { amplitude: radius * 0.05, frequency: 6, seed: seed + 3, recompute: true });
  log.translate(0, radius * 1.14, 0);
  builder.add(log, undefined, 'bark');

  // ---- the butt end: root flare still attached ----
  const buttProfile: Vec2[] = [];
  for (let index = 0; index <= 5; index += 1) {
    const t = index / 5;
    buttProfile.push([radius * (1.16 + 0.55 * Math.pow(1 - t, 1.6)), radius * 0.5 * t]);
  }
  const butt = lathe(buttProfile, { segments: Math.max(8, segments - 2), texel: 0.4, caps: false });
  butt.rotateZ(Math.PI * 0.5);
  butt.translate(-length * 0.5 - radius * 0.42, radius * 1.14, 0);
  builder.add(butt, undefined, 'bark');

  // ---- the broken end ----
  const tipX = length * 0.5;
  if (broken) {
    const splinters = planRepeatedUnits(intRange(rng, 4, 7), 24, Math.max(60, budget * 0.18), 3);
    for (let index = 0; index < splinters.modeled; index += 1) {
      const angle = range(rng, 0, Math.PI * 2);
      const distance = radius * range(rng, 0.1, 0.86);
      const splinter = prism({
        sides: 4,
        radius: radius * range(rng, 0.08, 0.19),
        height: radius * range(rng, 0.6, 1.7),
        topScale: 0.08,
      });
      attach(builder, splinter, 'wood-cut',
        [tipX + radius * 0.05, radius * 1.14 + Math.sin(angle) * distance, Math.cos(angle) * distance],
        range(rng, 0, Math.PI * 2), Math.PI * 0.5 + range(rng, -0.45, 0.45));
    }
    // The torn face, recessed behind the splinters.
    const face = cylinder(radius * 0.92, radius * 1.02, radius * 0.16, { radialSegments: Math.max(8, segments - 2), texel: 0.3 });
    fracture(face, { amplitude: radius * 0.06, frequency: 12, seed: seed + 11, recompute: true });
    face.rotateZ(Math.PI * 0.5);
    face.translate(tipX - radius * 0.02, radius * 1.14, 0);
    builder.add(face, undefined, 'wood-dark');
  } else {
    const face = cylinder(radius * 0.95, radius * 0.95, radius * 0.06, { radialSegments: Math.max(8, segments - 2), texel: 0.25 });
    face.rotateZ(Math.PI * 0.5);
    face.translate(tipX, radius * 1.14, 0);
    builder.add(face, undefined, 'wood-cut');
  }

  // ---- branch stubs along the top ----
  const wantedStubs = Math.max(0, Math.round(options.stubs ?? intRange(rng, 2, 5)));
  const stubs = planRepeatedUnits(wantedStubs, 70, Math.max(60, budget * 0.2), 1);
  for (let index = 0; index < stubs.modeled; index += 1) {
    const at = length * range(rng, -0.36, 0.36);
    const yaw = range(rng, -0.9, 0.9);
    // A stub stands proud of the bark by less than the log's own radius: long
    // enough to read, short enough that the log stays something you step over.
    const stubLength = radius * range(rng, 0.45, 0.95);
    const stub = cylinder(radius * 0.1, radius * 0.2, stubLength, { radialSegments: 6, texel: 0.2 });
    stub.translate(0, stubLength * 0.5, 0);
    fracture(stub, { amplitude: radius * 0.03, frequency: 10, seed: seed + index * 19, recompute: true });
    const stubTilt = range(rng, -0.45, 0.45);
    attach(builder, stub, 'bark', [at, radius * 1.78, 0], yaw, stubTilt);
    // The scar where the stub was broken off, at its tip.
    const scar = cylinder(radius * 0.11, radius * 0.11, radius * 0.04, { radialSegments: 6, texel: 0.1 });
    scar.translate(0, stubLength * 0.98, 0);
    attach(builder, scar, 'wood-cut', [at, radius * 1.78, 0], yaw, stubTilt);
  }

  if (options.peeled ?? chance(rng, 0.65)) {
    // Bark peeled back along the top: a shallow trough of pale wood with the
    // bark curling up at its edges.
    const peelLength = length * range(rng, 0.3, 0.6);
    const peel = cylinder(radius * 0.99, radius * 0.99, peelLength, {
      radialSegments: Math.max(6, segments - 4),
      arc: Math.PI * 0.55,
      texel: 0.3,
      caps: false,
    });
    peel.rotateZ(Math.PI * 0.5);
    peel.rotateX(range(rng, -0.4, 0.4));
    peel.translate(range(rng, -length * 0.15, length * 0.15), radius * 1.2, 0);
    builder.add(peel, undefined, 'wood-cut');
    for (const side of [-1, 1] as const) {
      const lip = cylinder(radius * 1.06, radius * 1.06, peelLength * 0.96, {
        radialSegments: Math.max(5, segments - 6), arc: Math.PI * 0.16, texel: 0.35, caps: false,
      });
      lip.rotateZ(Math.PI * 0.5);
      lip.rotateX(side * Math.PI * 0.27);
      lip.translate(range(rng, -length * 0.15, length * 0.15), radius * 1.24, 0);
      builder.add(lip, undefined, 'bark');
    }
  }

  if (options.moss ?? true) {
    const patches = planRepeatedUnits(intRange(rng, 3, 6), 90, Math.max(80, budget * 0.2), 2);
    for (let index = 0; index < patches.modeled; index += 1) {
      const at = length * range(rng, -0.42, 0.42);
      // Moss grows on the shaded upper side, following the curve of the bark.
      const roll = range(rng, -0.85, 0.85);
      const patch = sphere(radius * range(rng, 0.5, 0.95), { widthSegments: 9, heightSegments: 4, phiLength: Math.PI * 0.42, texel: 0.2 });
      fracture(patch, { amplitude: radius * 0.07, frequency: 12, seed: seed + index * 41, recompute: true });
      patch.scale(1.5, 0.34, 1);
      attach(builder, patch, 'moss',
        [at, radius * 1.14 + Math.cos(roll) * radius * 0.94, Math.sin(roll) * radius * 0.94],
        range(rng, 0, Math.PI * 2), roll);
    }
  }
  // Keep the log on the ground: the sweep sags, so seat it explicitly.
  const bounds = builder.bounds();
  if (bounds.min[1] > 0.001 || bounds.min[1] < -0.001) builder.translate(0, -bounds.min[1], 0);
  return builder;
}

export interface DeadTreeOptions {
  height?: number;
  seed?: number;
  limbs?: number;
  /** Broken snags sticking out of the trunk, as woodpeckers leave them. */
  snags?: boolean;
  /** A few stubborn leaves clinging to the crown. */
  leaves?: number;
  quality?: Quality;
  budget?: number;
  material?: string;
}

/** A standing dead tree: bare limbs, a broken crown, and weathered grey wood. */
export function deadTree(options: DeadTreeOptions = {}): MeshBuilder {
  const seed = options.seed ?? 109;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.6, options.height ?? 6);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'wood-weathered';
  const radius = height * 0.035;

  const body = trunk({
    height: height * range(rng, 0.82, 0.94),
    radiusBottom: radius * 1.9,
    radiusTop: radius * 0.55,
    seed,
    fissures: 0.3,
    rootFlare: 0.3,
    segments: Math.max(7, Math.min(14, Math.round(budget / 200))),
    stations: 6,
  });
  builder.add(body, undefined, material);

  const wantedLimbs = Math.max(2, Math.round(options.limbs ?? intRange(rng, 5, 9)));
  // Limbs take most of the budget, and a limb's floor is a bare four-segment
  // branch with no twigs: below that it is a stick, not a limb.
  const limbs = planChildren(wantedLimbs, branchCost(4, 0), Math.max(180, budget * 0.62));
  const limbTwigs = limbs.each > branchCost(5, 2) ? 2 : limbs.each > branchCost(5, 1) ? 1 : 0;
  const limbSegments = limbs.each > branchCost(5, 0) ? 5 : 4;
  for (let index = 0; index < limbs.modeled; index += 1) {
    const t = 0.34 + (index / limbs.modeled) * 0.6;
    const yaw = index * 2.399963 + range(rng, -0.35, 0.35);
    const limbLength = height * (1 - t * 0.55) * range(rng, 0.32, 0.58);
    const limb = branch({
      length: limbLength,
      radiusBase: radius * (1.5 - t) * range(rng, 0.7, 1.1),
      radiusTip: radius * 0.12,
      curve: range(rng, 0.25, 0.85),
      seed: seed + index * 47 + 13,
      segments: limbSegments,
      twigs: limbTwigs,
    });
    // Dead limbs reach out and slightly up, then the twigs droop.
    attach(builder, limb, material,
      [Math.cos(yaw) * radius * 0.5, height * t * 0.92, Math.sin(yaw) * radius * 0.5],
      yaw, range(rng, 0.75, 1.35));
  }

  if (options.snags ?? true) {
    const snags = planRepeatedUnits(intRange(rng, 2, 5), 60, Math.max(80, budget * 0.15), 1);
    for (let index = 0; index < snags.modeled; index += 1) {
      const yaw = range(rng, 0, Math.PI * 2);
      const at = height * range(rng, 0.25, 0.8);
      const snagLength = radius * range(rng, 1.6, 4);
      const snag = cylinder(radius * 0.06, radius * 0.34, snagLength, { radialSegments: 5, texel: 0.15 });
      snag.translate(0, snagLength * 0.5, 0);
      fracture(snag, { amplitude: radius * 0.05, frequency: 12, seed: seed + index * 29, recompute: true });
      attach(builder, snag, material,
        [Math.cos(yaw) * radius * 0.8, at, Math.sin(yaw) * radius * 0.8], yaw, Math.PI * 0.5 + range(rng, -0.4, 0.25));
    }
  }

  // The crown is broken off, leaving a splintered top rather than a point.
  const crownY = height * 0.86;
  const splinters = planRepeatedUnits(5, 22, Math.max(50, budget * 0.08), 3);
  for (let index = 0; index < splinters.modeled; index += 1) {
    const angle = (index / splinters.modeled) * Math.PI * 2;
    const splinter = prism({ sides: 3, radius: radius * range(rng, 0.18, 0.4), height: radius * range(rng, 1.2, 2.4), topScale: 0.05 });
    attach(builder, splinter, material,
      [Math.cos(angle) * radius * 0.4, crownY, Math.sin(angle) * radius * 0.4], angle, range(rng, -0.35, 0.35));
  }

  const clinging = Math.max(0, Math.round(options.leaves ?? 0));
  if (clinging > 0) {
    const clusters = planRepeatedUnits(clinging, 200, Math.max(120, budget * 0.2), 1);
    for (let index = 0; index < clusters.modeled; index += 1) {
      const yaw = range(rng, 0, Math.PI * 2);
      const at = height * range(rng, 0.5, 0.88);
      const cluster = leafCluster({
        radius: height * range(rng, 0.05, 0.09),
        leaves: 14,
        seed: seed + index * 61 + 7,
        length: height * 0.035,
        width: height * 0.02,
        clumps: 2,
      });
      attach(builder, cluster, 'foliage-olive',
        [Math.cos(yaw) * height * 0.14, at, Math.sin(yaw) * height * 0.14], yaw);
    }
  }
  fitHeight(builder, height, 1.4);
  return builder;
}

/** Leaf litter: a scatter of flat fallen leaves over a patch of ground. */
export function leafLitter(options: {
  radius?: number;
  leaves?: number;
  seed?: number;
  quality?: Quality;
  budget?: number;
  material?: string;
}): MeshBuilder {
  const seed = options.seed ?? 113;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.1, options.radius ?? 1);
  const budget = budgetOf(options.quality, options.budget);
  const material = options.material ?? 'foliage-olive';
  const wanted = Math.max(3, Math.round(options.leaves ?? Math.round(radius * 26)));
  const plan = planRepeatedUnits(wanted, 14, budget, 3);
  for (let index = 0; index < plan.modeled; index += 1) {
    const angle = range(rng, 0, Math.PI * 2);
    const distance = radius * Math.sqrt(range(rng, 0, 1));
    const size = radius * range(rng, 0.05, 0.11);
    const leaf = blade({
      length: size * 2,
      width: size * 0.85,
      widest: 0.42,
      camber: 0.5,
      // A leaf on the ground curls a little at the tip; droop would drive it
      // through the ground plane the patch is meant to lie on.
      droop: range(rng, -0.12, 0.16),
      lobes: chance(rng, 0.5) ? intRange(rng, 2, 4) : 0,
      lobeDepth: 0.35,
      segments: 2,
      across: 2,
    });
    // Fallen leaves lie on the ground, curled, at every bearing.
    attach(builder, leaf, material,
      [Math.cos(angle) * distance, size * range(rng, 0.05, 0.18), Math.sin(angle) * distance],
      range(rng, 0, Math.PI * 2), Math.PI * 0.5 + range(rng, -0.3, 0.3), range(rng, -0.5, 0.5));
  }
  const litter = builder.bounds();
  if (litter.min[1] < 0) builder.translate(0, -litter.min[1], 0);
  return builder;
}
