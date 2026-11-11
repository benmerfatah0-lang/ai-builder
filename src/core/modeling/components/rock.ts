import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { arch, box, cylinder, lathe, plane, prism } from '../primitives';
import { boulder, componentBudget, detailRng, displace, planChildren, tuft, type Quality } from '../detail';
import { fitHeight } from '../scale';
import { chance, intRange, pick, range, type Rng } from '../../generation/rng';
import { clamp01, fbm3, ridged } from '../../terrain/noise';

/**
 * Rock: everything the ground is made of, from a pebble apron to a cave mouth.
 *
 * Stone is the one material a builder never has to invent — it is already there,
 * and the whole craft is in taking it away. That gives this file its three rules,
 * which are why a generated cliff does not read as a textured box.
 *
 * 1. **Rock is faceted, never smooth.** A turned column shaded smoothly looks
 *    like a vase; the same column with nine azimuthal facets, flat shading and
 *    two noise scales looks like granite. Every mass here is built with few
 *    segments around and many stations up, then flat-shaded, because broken
 *    surfaces catch light on planes and that is what the eye reads as stone.
 * 2. **Water and frost do the detailing.** Talus sorts coarse to the toe of the
 *    apron, cracks run vertically because frost pries along the vertical, ledges
 *    survive where a harder bed outcrops, and a cave mouth is a hole in a face
 *    rather than a tunnel drawn on one. Each generator models the process that
 *    made the shape, so the shapes agree with each other across a landscape.
 * 3. **The budget buys facets, not coverage.** A cheap scree slope keeps its
 *    full extent and its full stone count and gives each stone fewer facets; a
 *    poor cairn is still a stack. Only when a single stone cannot be afforded at
 *    its cheapest does `planChildren` drop one, and it drops the far stones
 *    first, so the silhouette holds from where it is usually seen.
 *
 * Coordinates: metres, Y up, the base of the rock on y = 0, centred on X and Z —
 * except `caveMouth`, whose opening sits at the origin and whose mass runs away
 * from it, because a caller places that one at a `CaveEntrance.position`.
 */

/* --------------------------------------------------------------- plumbing */

/**
 * Triangles one faceted stone costs.
 *
 * A stone is a `boulder`, which is a sphere of `segments * 2` by `segments`
 * pushed around by noise: `2 * rows * (columns - 2)`. Displacement moves
 * vertices and flat shading re-derives normals, so neither changes the count —
 * the number of facets is the whole cost, and charging it exactly is what lets a
 * slope spend its allowance on stones instead of leaving a third of it unused.
 */
function stoneCost(segments: number): number {
  return 4 * segments * (segments - 1);
}

/**
 * The coarsest stone an allowance can buy.
 *
 * Inverting `stoneCost`: a stone of five facets — the floor `boulder` accepts —
 * is eighty triangles, and below that a stone stops being a stone and becomes a
 * spike. Eighteen facets is where a rock starts to read as a turned sphere, so
 * the ceiling is a shape limit rather than a budget one.
 *
 * The solve rounds down. Rounding to nearest buys one facet too many whenever the
 * allowance lands just under a step, and a field of forty stones each overspending
 * by six percent is a field that does not fit the budget it was given.
 */
function stoneSegments(budget: number): number {
  const solved = (1 + Math.sqrt(1 + Math.max(0, budget))) / 2;
  return Math.max(5, Math.min(18, Math.floor(solved + 1e-6)));
}

/**
 * Triangles one `blade` costs inside a `tuft`, and one three-blade tuft.
 *
 * `blade` is two columns fewer than its segments at each end, and `tuft` asks for
 * four segments across four columns, so a blade is 24 triangles rather than the
 * twelve a two-column blade costs. Charging twelve let a cliff ledge grow twice
 * the grass it had paid for.
 */
const BLADE_TRIANGLES = 24;
const TUFT_TRIANGLES = BLADE_TRIANGLES * 3;

/** Triangles a `rockMass` costs: a band of quads per station, a fan per cap. */
function massCost(segments: number, stations: number): number {
  return stations * segments * 2 + segments * 2;
}

/**
 * Facets and stations a rock mass of a given height can afford.
 *
 * Stations are decided by the height — one every half metre, which is the scale
 * at which bedding and frost cracks show — and the facets take whatever is left.
 * Facets give first, because a mass with eight facets and twelve stations still
 * reads as a broken block, while one with five facets and four reads as a brick.
 * Both are capped: past twenty-four facets a stone starts to look turned rather
 * than broken, and past twenty stations the noise is finer than the eye checks.
 * When even the floor does not fit, the floor is what is built.
 */
function massPlan(budget: number, height: number): { segments: number; stations: number } {
  const wanted = Math.max(5, Math.min(20, Math.round(Math.max(0.2, height) / 0.55)));
  for (let stations = wanted; stations >= 5; stations -= 1) {
    const segments = Math.floor(budget / (2 * stations + 2));
    if (segments >= 6) return { segments: Math.min(24, segments), stations };
  }
  return { segments: 6, stations: 5 };
}

export interface RockMassOptions {
  /** Across X. */
  width: number;
  /** Up Y, from y = 0. */
  height: number;
  /** Through Z. */
  depth: number;
  /** Azimuthal facets; low counts read as broken stone, high as a turned column. */
  segments?: number;
  /** Height stations; the noise needs vertices to push around. */
  stations?: number;
  seed?: number;
  /** 0 = water-worn, 1 = frost-shattered. */
  roughness?: number;
  /** Top radius as a fraction of the bottom: a battered face, or a spire. */
  taper?: number;
  /** Pull one side flat, so the mass reads as a face rather than a blob. */
  face?: 'none' | 'front' | 'top';
  /** Vertical frost cracking, in metres of relief. Defaults to follow roughness. */
  cracks?: number;
  /** Pinch the middle by this fraction: a hoodoo, or a waisted column. */
  waist?: number;
}

/**
 * A solid rock mass of given proportions, broken by noise and faceted.
 *
 * The construction is a lathe of few azimuthal segments and several height
 * stations, squashed into the box it has to fill. A lathe rather than a box
 * because a box has twelve vertices and displacement has nothing to work on, and
 * rather than a sphere because a mass that has to fill a wall-shaped volume
 * should start as one. It is closed and outward-facing from every angle, so a
 * viewer who walks around it never finds a hole.
 *
 * `face` is the part that turns a blob into geology: pulling the front half onto
 * an undulating plane gives a cliff its face, and pulling the top onto one gives
 * a tor its plateau. Both blend in over a fifth of the depth so the crease where
 * the face meets the flank is a soft one, as it is where a bed breaks off.
 */
function rockMass(options: RockMassOptions): MeshBuilder {
  const seed = options.seed ?? 17;
  const rng = detailRng(seed);
  const width = Math.max(0.1, options.width);
  const height = Math.max(0.1, options.height);
  const depth = Math.max(0.1, options.depth);
  const segments = Math.max(5, Math.round(options.segments ?? 9));
  const stations = Math.max(4, Math.round(options.stations ?? 8));
  const roughness = Math.min(1, Math.max(0, options.roughness ?? 0.6));
  const taper = Math.min(1, Math.max(0.12, options.taper ?? 0.72));
  const waist = Math.min(0.7, Math.max(0, options.waist ?? 0));
  const wobble = range(rng, 0, Math.PI * 2);
  const profile: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const t = index / stations;
    // A harder bed outcrops and a softer one washes out, so the taper carries a
    // low-frequency swell instead of being a cone: that is what makes the
    // silhouette of a crag recognisable against the sky.
    const swell = 1 + 0.17 * roughness * Math.sin(t * Math.PI * 2.3 + wobble);
    // A waist is what turns a column into a hoodoo: the cap rock shelters the
    // top of the spire, the foot is buried in its own debris, and the middle is
    // where the rain has had its way.
    const pinch = waist > 0 ? 1 - waist * Math.pow(Math.sin(t * Math.PI * 0.88), 1.4) : 1;
    const radius = (1 - Math.pow(t, 1.25) * (1 - taper)) * swell * pinch * range(rng, 0.93, 1.07);
    profile.push([Math.max(0.02, radius), height * t]);
  }
  const builder = lathe(profile, { segments, caps: true });
  builder.scale(width / 2, 1, depth / 2);
  // Squashing a lathe shears its normals; the displacement that follows pushes
  // along them, so they have to be true first or the mass leans into its own noise.
  builder.computeNormals();
  const scale = Math.max(0.1, Math.min(width, depth, height));
  // Lobes first so the silhouette breaks, then chips so the surface does. Both
  // preserve the base: a rock that does not meet the ground is floating, and no
  // amount of surface detail hides that.
  displace(builder, { amplitude: scale * 0.1 * roughness, frequency: 1.5 / scale, octaves: 2, seed, preserveBase: true });
  displace(builder, { amplitude: scale * 0.05 * roughness, frequency: 4.4 / scale, octaves: 3, seed: seed + 991, preserveBase: true });

  const crackAmount = options.cracks ?? roughness * scale * 0.13;
  if (crackAmount > 1e-4) {
    // Frost pries along the vertical, so the noise is sampled without Y: cracks
    // run the full height of the face and do not wander sideways into it.
    for (let index = 0; index < builder.vertexCount; index += 1) {
      const point = builder.positionAt(index);
      const normal = builder.normalAt(index);
      const value = ridged(seed + 5, (point[0] * 1.9) / scale, (point[2] * 1.9) / scale, { octaves: 3 });
      const amount = (value - 0.55) * crackAmount;
      builder.setPosition(index, [point[0] + normal[0] * amount, point[1], point[2] + normal[2] * amount]);
    }
  }

  const bounds = builder.bounds();
  const face = options.face ?? 'none';
  if (face === 'front') {
    // The face is set just inside the bulgiest point the noise left, and the
    // undulation is allowed to fall either side of it. Clamping the result to the
    // old maximum instead — which is the obvious way to write this — pins every
    // vertex the noise pushed furthest onto one plane, and the "face" that comes
    // out is a single horizontal band standing proud of a rounded mass, not a
    // cliff.
    const planeAt = bounds.max[2] - depth * 0.16;
    for (let index = 0; index < builder.vertexCount; index += 1) {
      const point = builder.positionAt(index);
      const blend = clamp01((point[2] - depth * 0.02) / (depth * 0.4));
      if (blend <= 1e-4) continue;
      const undulation = fbm3(seed + 31, point[0] * 1.3, point[1] * 1.3, 0, 2) * depth * 0.09;
      const target = planeAt + undulation;
      builder.setPosition(index, [point[0], point[1], point[2] + (target - point[2]) * blend]);
    }
  }
  if (face === 'top') {
    const topAt = height * 0.86;
    for (let index = 0; index < builder.vertexCount; index += 1) {
      const point = builder.positionAt(index);
      const blend = clamp01((point[1] - height * 0.6) / (height * 0.34));
      if (blend <= 1e-4) continue;
      const undulation = fbm3(seed + 47, point[0] * 1.1, 0, point[2] * 1.1, 2) * height * 0.05;
      builder.setPosition(index, [point[0], point[1] + (topAt + undulation - point[1]) * blend, point[2]]);
    }
  }
  builder.flatShade();
  builder.translate(0, -builder.bounds().min[1], 0);
  return builder;
}

/**
 * Deterministic scatter over a rectangle: a jittered grid, not uniform random.
 *
 * Uniform random clumps, and clumped stones read as a pile rather than a
 * scatter, while a rigid grid reads as paving. One jittered point per cell gives
 * an even spread with irregular spacing, which is how debris actually lands, and
 * it is stable under the seed so a world looks the same every time it is built.
 */
function scatter(rng: Rng, count: number, width: number, depth: number, jitter = 0.72): Vec2[] {
  const wanted = Math.max(1, Math.round(count));
  const columns = Math.max(1, Math.round(Math.sqrt((wanted * width) / Math.max(0.01, depth))));
  const rows = Math.max(1, Math.ceil(wanted / columns));
  const cells = columns * rows;
  const points: Vec2[] = [];
  for (let index = 0; index < wanted; index += 1) {
    // Stride through the grid instead of filling it row by row: a scatter that
    // could only afford half its stones still has to cover the whole extent, or a
    // poor boulder field is a pile at one end of an empty field.
    const cell = Math.min(cells - 1, Math.round((index * cells) / wanted));
    const row = Math.floor(cell / columns);
    const column = cell % columns;
    const x = -width / 2 + ((column + 0.5 + range(rng, -jitter, jitter) * 0.5) / columns) * width;
    const z = -depth / 2 + ((row + 0.5 + range(rng, -jitter, jitter) * 0.5) / rows) * depth;
    points.push([x, z]);
  }
  return points;
}

/**
 * A stone placed on a surface: yawed, sunk a little, and never below ground.
 *
 * `boulder` flattens its own bottom so the stone has somewhere to sit, and the
 * sink buries that flat so the stone meets the surface instead of balancing on
 * it. The clamp is what keeps a component's bounding box honest: a stone pushed
 * below y = 0 would sink the whole asset into the terrain it is placed on.
 */
function settle(part: MeshBuilder, rng: Rng, at: Vec3, sink: number): void {
  const bounds = part.bounds();
  part.rotateY(range(rng, 0, Math.PI * 2));
  const dropped = Math.max(0, at[1] - Math.min(sink, bounds.size[1] * 0.45));
  part.translate(at[0], dropped - bounds.min[1], at[2]);
}

/* ------------------------------------------------------------------- scree */

export type RockKind = 'granite' | 'sandstone' | 'limestone' | 'slate' | 'volcanic';

/** The surface a kind of rock is built from, and how rough it breaks. */
const ROCK_SURFACE: Record<RockKind, { material: string; roughness: number; debris: string }> = {
  granite: { material: 'granite', roughness: 0.72, debris: 'gravel' },
  sandstone: { material: 'sandstone', roughness: 0.54, debris: 'sand' },
  limestone: { material: 'stone-pale', roughness: 0.46, debris: 'gravel' },
  slate: { material: 'slate', roughness: 0.82, debris: 'gravel' },
  volcanic: { material: 'stone-rough', roughness: 0.9, debris: 'soil' },
};

export interface ScreeOptions {
  /** Across the slope, along X. */
  width: number;
  /** Run of the apron down the fall line, along Z. */
  depth: number;
  /**
   * Fall of the apron from the head (−Z) to the toe (+Z), in metres.
   *
   * This is the height of the *debris*, not of the asset: with `outcrop` on, the
   * bedrock the apron fell off stands proud of it, as it does in the field.
   */
  rise?: number;
  /** Stones wanted; the budget decides how many are modeled. */
  count?: number;
  /** Typical stone radius at the toe, where the coarse debris ends up. */
  stone?: number;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Bedrock breaking through the soil at the head of the apron. */
  outcrop?: boolean;
  /** Grass establishing on the toe, where the apron has stopped moving. */
  greenery?: boolean;
}

/**
 * A scree slope: an apron of loose debris below a rock face.
 *
 * Talus is graded, and the grading is the whole reason it reads as talus rather
 * than as scattered pebbles: blocks that break off the face tumble and roll to
 * the bottom of the slope, so the toe is coarse and the head is fine. Size
 * therefore rises with distance down the fall line, and the apron is thickest
 * where it has piled deepest.
 *
 * The debris lies on a sheet rather than floating in space, because an apron
 * seen from above is mostly the small stuff — the stones a budget cannot afford
 * to model individually. The sheet carries that with a height field, and its
 * edges fall away to nothing so it blends into the terrain instead of ending in
 * a straight line.
 */
export function scree(options: ScreeOptions): MeshBuilder {
  const seed = options.seed ?? 29;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = Math.max(0.5, options.width);
  const depth = Math.max(0.5, options.depth);
  const stone = Math.max(0.04, options.stone ?? Math.min(0.5, depth * 0.06));
  const kind = ROCK_SURFACE[options.kind ?? 'granite'];
  const budget = componentBudget(options.quality, options.budget);
  const rise = Math.max(0, options.rise ?? depth * 0.34);

  // The sheet is a quarter of the allowance at most: it is the fine debris, and
  // stones are what the eye counts, so they get the rest.
  const sheetShare = Math.min(budget * 0.26, 320);
  let columns = Math.max(3, Math.min(18, Math.round(width / 0.7)));
  let rows = Math.max(3, Math.min(18, Math.round(depth / 0.7)));
  while (columns * rows * 2 > sheetShare && columns > 3 && rows > 3) {
    if (columns >= rows) columns -= 1;
    else rows -= 1;
  }
  /** Fall of the apron at a point, in metres, matching the sheet exactly. */
  const surfaceAt = (x: number, z: number): number => {
    const fall = clamp01(0.5 - z / depth);
    // The edges thin out so the apron meets the terrain rather than stopping.
    const edge = Math.pow(clamp01(1 - Math.pow(Math.abs(x) / (width / 2), 3)), 0.6);
    const bumps = fbm3(seed, x * 0.85, 0, z * 0.85, 3) * rise * 0.16;
    return Math.max(0, rise * fall * (0.3 + 0.7 * edge) + bumps * edge);
  };
  const sheet = plane(width, depth, {
    widthSegments: columns,
    heightSegments: rows,
    height: surfaceAt,
  });
  builder.add(sheet, undefined, kind.debris);

  const greenShare = options.greenery ? Math.min(budget * 0.12, 700) : 0;
  const outcropShare = options.outcrop === false ? 0 : Math.min(budget * 0.2, massCost(6, 5) * 3);
  const stoneShare = Math.max(stoneCost(5), budget - sheetShare - outcropShare - greenShare);
  const wanted = Math.max(3, Math.round(options.count ?? Math.max(6, (width * depth) / (stone * stone * 26))));
  const plan = planChildren(wanted, stoneCost(5), stoneShare);
  const segments = stoneSegments(plan.each);
  const points = scatter(rng, plan.modeled, width * 0.94, depth * 0.94);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    // Coarse at the toe, fine at the head: the grading that makes it talus.
    const down = clamp01((point[1] + depth / 2) / depth);
    const radius = stone * (0.42 + down * 0.95) * range(rng, 0.6, 1.45);
    const shard = boulder({
      radius,
      seed: seed + 13 + index * 29 + Math.round(radius * 977),
      roughness: Math.min(1, kind.roughness + 0.12),
      segments,
      stretch: [range(rng, 0.8, 1.25), range(rng, 0.45, 0.8), range(rng, 0.8, 1.25)],
      sink: range(rng, 0.18, 0.34),
    });
    settle(shard, rng, [point[0], surfaceAt(point[0], point[1]), point[1]], radius * 0.3);
    builder.add(shard, undefined, kind.material);
  }

  if (outcropShare > 0) {
    // Bedrock still attached, at the head: the apron is what fell off it.
    const blocks = planChildren(3, massCost(6, 5), outcropShare);
    const mass = massPlan(blocks.each, rise * 1.4);
    for (let index = 0; index < blocks.modeled; index += 1) {
      const at = -depth * 0.42 + index * depth * 0.06;
      const part = rockMass({
        width: width * range(rng, 0.3, 0.5),
        height: rise * range(rng, 1.1, 1.7) + stone * 2,
        depth: depth * range(rng, 0.22, 0.34),
        segments: mass.segments,
        stations: mass.stations,
        roughness: kind.roughness,
        taper: range(rng, 0.5, 0.8),
        face: 'front',
        seed: seed + 101 + index * 37,
      });
      settle(part, rng, [range(rng, -width * 0.2, width * 0.2), surfaceAt(0, at) + rise * 0.24, at], rise * 0.1);
      builder.add(part, undefined, kind.material);
    }
  }

  if (greenShare > 0) {
    // Grass gets a foothold where the apron has stopped moving, which is the toe.
    const tufts = planChildren(Math.max(3, Math.round(width / 1.4)), TUFT_TRIANGLES, greenShare);
    const spots = scatter(rng, tufts.modeled, width * 0.86, depth * 0.4, 0.9);
    for (const spot of spots) {
      const z = spot[1] + depth * 0.28;
      const part = tuft({
        height: stone * range(rng, 1.6, 3.4),
        blades: Math.max(3, Math.min(9, Math.round(tufts.each / BLADE_TRIANGLES))),
        seed: seed + Math.round(z * 311) + Math.round(spot[0] * 97),
      });
      settle(part, rng, [spot[0], surfaceAt(spot[0], z), z], 0);
      builder.add(part, undefined, pick(rng, ['grass', 'moss'] as const, 'grass'));
    }
  }
  builder.translate(0, -builder.bounds().min[1], 0);
  return builder;
}

/* ------------------------------------------------------------- cliff face */

export interface CliffOptions {
  /** Across the face, along X. */
  width: number;
  /** Height of the face, from y = 0. */
  height: number;
  /** How far the mass stands proud of the terrain, along Z. */
  depth?: number;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Ledges modeled as real geometry, where a harder bed has survived. */
  ledges?: number;
  /** Things growing on those ledges. */
  greenery?: boolean;
  /** Flatten the summit into a plateau rather than leaving it peaked. */
  plateau?: boolean;
  /** 0 = a bare face, 1 = a mass shedding debris at its foot. */
  debris?: number;
}

/**
 * A cliff: a rock face standing proud of the ground it rises from.
 *
 * The face is battered — pulled onto an undulating plane — because that is the
 * one thing a viewer checks: a cliff has a front, and a mass that is equally
 * lumpy all round reads as a boulder however tall it is. Ledges are modeled as
 * solids and not painted on, because a ledge is where the light falls and where
 * anything alive up there has to stand, and a normal map cannot carry either.
 *
 * Bedding is horizontal and cracking is vertical, so the two noise scales are
 * sampled differently: the ledges are placed along the height, and the cracks
 * run up it.
 */
export function cliffFace(options: CliffOptions): MeshBuilder {
  const seed = options.seed ?? 41;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = Math.max(0.6, options.width);
  const height = Math.max(0.8, options.height);
  const depth = Math.max(0.4, options.depth ?? width * 0.42);
  const kind = ROCK_SURFACE[options.kind ?? 'granite'];
  const budget = componentBudget(options.quality, options.budget);

  // A ledge every two to three metres of face is what bedding actually looks
  // like; the budget then decides how many of them are solid.
  const wantedLedges = Math.max(0, Math.round(options.ledges ?? height / 2.6));
  const ledgeShare = Math.min(budget * 0.28, wantedLedges * 120);
  const debrisShare = Math.min(budget * 0.16, (options.debris ?? 0.5) * budget * 0.2);
  const massShare = Math.max(massCost(6, 5), budget - ledgeShare - debrisShare);
  const plan = massPlan(massShare, height);
  const mass = rockMass({
    width,
    height,
    depth,
    segments: plan.segments,
    stations: plan.stations,
    roughness: kind.roughness,
    taper: range(rng, 0.62, 0.86),
    face: 'front',
    seed,
  });
  builder.add(mass, undefined, kind.material);

  const bounds = builder.bounds();
  const frontZ = bounds.max[2];
  if (wantedLedges > 0 && ledgeShare > 0) {
    const ledges = planChildren(wantedLedges, 12, ledgeShare);
    for (let index = 0; index < ledges.modeled; index += 1) {
      // Bedding planes are horizontal but never level or evenly spaced: a ledge
      // survives where the bed is hard, and breaks off where it is not.
      const t = (index + range(rng, 0.18, 0.82)) / ledges.modeled;
      const at = height * (0.14 + t * 0.72);
      const length = width * range(rng, 0.3, 0.82);
      const thick = height * range(rng, 0.03, 0.075);
      const proud = depth * range(rng, 0.1, 0.3);
      // A plain box, because `fractureStone` is about to break every edge of it
      // anyway: a chamfer under displacement is 108 triangles buying nothing.
      const ledge = box(length, thick, proud, { texel: 0.5 });
      fractureStone(ledge, seed + 211 + index * 29, Math.min(thick, proud) * 0.35);
      ledge.rotateZ(range(rng, -0.05, 0.05));
      ledge.rotateY(range(rng, -0.12, 0.12));
      ledge.translate(range(rng, -width * 0.22, width * 0.22), at, frontZ - proud * 0.35);
      builder.add(ledge, undefined, kind.material);
      if (options.greenery && chance(rng, 0.62)) {
        const tufts = planChildren(intRange(rng, 2, 4), TUFT_TRIANGLES, Math.max(TUFT_TRIANGLES, ledges.each * 0.3));
        for (let grown = 0; grown < tufts.modeled; grown += 1) {
          const plant = tuft({
            height: height * range(rng, 0.03, 0.07),
            blades: Math.max(3, Math.min(8, Math.round(tufts.each / BLADE_TRIANGLES))),
            seed: seed + 977 + index * 53 + grown * 7,
          });
          plant.translate(
            range(rng, -length * 0.4, length * 0.4),
            at + thick * 0.5,
            frontZ - proud * range(rng, 0.2, 0.7),
          );
          builder.add(plant, undefined, pick(rng, ['moss', 'grass', 'foliage-olive'] as const, 'moss'));
        }
      }
    }
  }

  if (debrisShare > stoneCost(5)) {
    // The foot of a cliff is where its own history is lying.
    const stones = planChildren(Math.max(3, Math.round(width / 0.9)), stoneCost(5), debrisShare);
    const segments = stoneSegments(stones.each);
    const spots = scatter(rng, stones.modeled, width * 1.05, depth * 1.5, 0.85);
    for (const spot of spots) {
      const radius = Math.max(0.06, height * range(rng, 0.018, 0.05));
      const shard = boulder({
        radius,
        seed: seed + 401 + Math.round(spot[0] * 61) + Math.round(spot[1] * 37),
        roughness: Math.min(1, kind.roughness + 0.15),
        segments,
        stretch: [range(rng, 0.7, 1.3), range(rng, 0.4, 0.75), range(rng, 0.7, 1.3)],
        sink: range(rng, 0.2, 0.4),
      });
      settle(shard, rng, [spot[0], 0, spot[1] + depth * 0.4], radius * 0.4);
      builder.add(shard, undefined, kind.material);
    }
  }

  if (options.plateau) {
    // A flat summit: the harder bed that the rest of the mass was eroded off.
    const cap = rockMass({
      width: width * range(rng, 0.7, 0.95),
      height: height * 0.1,
      depth: depth * range(rng, 0.6, 0.9),
      segments: Math.max(5, plan.segments - 2),
      stations: 4,
      roughness: kind.roughness * 0.8,
      taper: 0.95,
      face: 'top',
      seed: seed + 613,
    });
    cap.translate(0, height * 0.92, range(rng, -depth * 0.06, depth * 0.06));
    builder.add(cap, undefined, kind.material);
  }

  fitHeight(builder, height, 1.35);
  return builder;
}

/**
 * Roughens a small solid: two noise scales and a flat shade.
 *
 * `fracture` in `detail` displaces along normals and then facets, but a ledge or
 * a capstone needs its amplitude in metres of relief relative to its own
 * thickness, or a thin slab gets pushed apart entirely.
 */
function fractureStone(part: MeshBuilder, seed: number, amount: number): void {
  if (amount <= 1e-4) return;
  displace(part, { amplitude: amount, frequency: 5.5, octaves: 2, seed, preserveBase: false });
  displace(part, { amplitude: amount * 0.5, frequency: 14, octaves: 2, seed: seed + 733, preserveBase: false });
  part.flatShade();
}

/* -------------------------------------------------------------- cave mouth */

export interface CaveMouthOptions {
  /** Radius of the opening, matching `CaveEntrance.radius`. */
  radius: number;
  /** How far the modeled throat runs in, matching `CaveEntrance.depth`. */
  depth?: number;
  /**
   * Compass heading into the hill, in degrees, exactly as `CaveEntrance.heading`
   * records it (0 = +Z, 90 = +X). A caller placing this at a surveyed entrance
   * passes the heading straight through and the mouth turns to face downhill.
   */
  heading?: number;
  /** Height of the rock face the mouth opens in. */
  face?: number;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Fallen rock across the floor of the mouth, and an apron in front of it. */
  debris?: boolean;
  /** Dripstone in the throat, where the budget can afford it. */
  formations?: boolean;
}

/**
 * A cave mouth: a real opening in a rock face, with a throat you can look down.
 *
 * The opening is not drawn, it is built — a ring of rock masses around a tube
 * whose walls face *in*. That facing is the part that is easy to get wrong: a
 * tube is outward-facing by construction, and mirroring one does not turn it
 * inside out, because a mirror moves the geometry and leaves the normals
 * pointing away from the axis. What faces a surface of revolution inward is
 * traversing its profile downward, so the throat is a descending lathe turned
 * onto its side, and the back wall that closes it is a disc wound the other way.
 *
 * Get it wrong and a player standing in the entrance sees the sky through the
 * back of their own cave.
 *
 * Unlike every other component here, this one is *not* centred on its bounding
 * box: the mouth sits at the origin and the mass runs away from it, because a
 * caller places it at a `CaveEntrance.position`, which is the mouth.
 */
export function caveMouth(options: CaveMouthOptions): MeshBuilder {
  const seed = options.seed ?? 53;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const radius = Math.max(0.25, options.radius);
  const throat = Math.max(radius * 1.4, options.depth ?? radius * 3.4);
  const faceHeight = Math.max(radius * 2.7, options.face ?? radius * 3.7);
  const kind = ROCK_SURFACE[options.kind ?? 'limestone'];
  const budget = componentBudget(options.quality, options.budget);
  // The floor of the opening sits a hair above the ground so the throat has a
  // sill to stand on and debris has somewhere to lie.
  const mouthY = radius * 1.04;
  const massDepth = throat * 1.2 + radius * 0.6;
  // `rockMass` sets a battered face just inside the front of its own depth —
  // about +0.34 of it — so placing the masses this far back lands every face at
  // roughly z = 0: one rock face, one hole.
  const frontZ = -massDepth * 0.34;
  const faceWidth = radius * 6.4;

  // The throat is the identity of the asset and is paid for first: a cave mouth
  // with a painted-on hole and a rich face is worse than the reverse.
  const throatSegments = Math.max(8, Math.min(20, Math.round(radius * 6 + 6)));
  const throatStations = 4;
  const throatCost = (throatStations - 1) * throatSegments * 2 + throatSegments * 2;
  const debrisShare = options.debris === false ? 0 : Math.min(budget * 0.14, 600);
  const formationShare = options.formations === false ? 0 : Math.min(budget * 0.12, 500);
  const faceShare = Math.max(massCost(5, 4) * 3, budget - throatCost - debrisShare - formationShare);

  const tube = new MeshBuilder();
  const passage: Vec2[] = [];
  for (let index = 0; index < throatStations; index += 1) {
    const t = index / (throatStations - 1);
    // A passage pinches as it goes in, and the pinch is what makes the far end
    // read as dark: the roof comes down and the walls close in.
    const bore = radius * (1 + 0.06 * Math.sin(t * Math.PI * 1.7) - t * 0.24) * range(rng, 0.98, 1.02);
    passage.push([Math.max(radius * 0.3, bore), -throat * t]);
  }
  // Mouth rim proud of the face, so no seam shows where the throat meets rock.
  passage.unshift([radius * 1.02, radius * 0.18]);
  tube.add(lathe(passage, { segments: throatSegments, caps: false }));
  // The far end, wound rim to centre so it faces back out of the hill.
  const far = passage[passage.length - 1]!;
  tube.add(lathe([[far[0], far[1]], [0, far[1]]], { segments: throatSegments }));
  tube.rotateX(Math.PI / 2);
  tube.translate(0, mouthY, 0);
  builder.add(tube, undefined, 'slate');
  // Sediment on the throat floor: dry caves are floored with what washed in. The
  // sheet is already flat in XZ, which is the plane the throat floor lies in —
  // standing it up would put a wall across the passage and lift the whole asset
  // off the ground when it is re-seated.
  const floor = plane(radius * 1.7, throat * 0.94, {
    widthSegments: 3,
    heightSegments: Math.max(2, Math.min(6, Math.round(throat / radius))),
    height: (x, z) => radius * 0.1 * (1 - Math.pow(Math.abs(x) / (radius * 0.85), 2)) + Math.abs(z) * 0.02,
  });
  floor.translate(0, mouthY - radius * 0.94, -throat * 0.47);
  builder.add(floor, undefined, 'soil');

  const masses = planChildren(4, massCost(6, 5), faceShare);
  const flankPlan = massPlan(masses.each, faceHeight);
  const flankWidth = (faceWidth / 2 - radius * 1.12) * 1.05;
  const flanks: [number, number][] = [
    [-(radius * 1.12 + flankWidth / 2), seed + 7],
    [radius * 1.12 + flankWidth / 2, seed + 149],
  ];
  for (const [at, flankSeed] of flanks) {
    const flank = rockMass({
      width: flankWidth,
      // Kept under the face height: the flanks are the same rock face as the
      // roof over the opening, and a flank that overshoots it by a tenth is a
      // peak standing behind a cave mouth that was surveyed flat.
      height: faceHeight * range(rng, 0.86, 0.99),
      depth: massDepth,
      segments: flankPlan.segments,
      stations: flankPlan.stations,
      roughness: kind.roughness,
      taper: range(rng, 0.66, 0.9),
      face: 'front',
      seed: flankSeed,
    });
    flank.translate(at, 0, frontZ);
    builder.add(flank, undefined, kind.material);
  }
  const roofHeight = Math.max(radius * 0.6, faceHeight - mouthY - radius);
  const roof = rockMass({
    width: radius * 3.4,
    height: roofHeight,
    depth: massDepth * 0.94,
    segments: Math.max(5, flankPlan.segments - 1),
    stations: Math.max(4, flankPlan.stations - 2),
    roughness: kind.roughness,
    taper: range(rng, 0.7, 0.95),
    face: 'front',
    seed: seed + 311,
  });
  roof.translate(0, mouthY + radius * 1.02, frontZ + massDepth * 0.02);
  builder.add(roof, undefined, kind.material);
  if (masses.modeled > 3) {
    // The hill the face belongs to, so the mouth is not a wall with a hole in it.
    // Its own face is battered onto a plane *behind* the end of the throat: a
    // hill that stands inside the passage closes the cave with pale rock in
    // front of the dark back wall, and looking in you see the hill's front
    // instead of the throat you were shown.
    const hillDepth = massDepth * 0.9;
    const hill = rockMass({
      width: faceWidth * 1.5,
      height: faceHeight * 0.86,
      depth: hillDepth,
      segments: Math.max(5, flankPlan.segments - 2),
      stations: Math.max(4, flankPlan.stations - 2),
      roughness: kind.roughness * 0.85,
      taper: range(rng, 0.55, 0.78),
      face: 'front',
      seed: seed + 617,
    });
    hill.translate(0, 0, -throat - radius * 0.25 - hillDepth * 0.34);
    builder.add(hill, undefined, kind.material);
  }

  if (debrisShare > stoneCost(5)) {
    // Entrances are half choked with what fell off them, and the apron outside
    // is the same debris that has travelled further.
    const stones = planChildren(Math.max(4, Math.round(radius * 5)), stoneCost(5), debrisShare);
    const segments = stoneSegments(stones.each);
    const spots = scatter(rng, stones.modeled, radius * 4.6, radius * 3.4, 0.8);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      // Anything inside the mouth lies on the throat floor; outside, on ground.
      const inside = spot[1] < radius * 0.4 && Math.abs(spot[0]) < radius * 0.9;
      const scale = inside ? 0.5 : 1;
      const stoneRadius = radius * range(rng, 0.08, 0.26) * scale;
      const shard = boulder({
        radius: stoneRadius,
        seed: seed + 907 + index * 17,
        roughness: 0.85,
        segments,
        stretch: [range(rng, 0.8, 1.3), range(rng, 0.4, 0.7), range(rng, 0.8, 1.3)],
        sink: range(rng, 0.2, 0.4),
      });
      const ground = inside ? mouthY - radius * 0.92 : 0;
      settle(shard, rng, [spot[0], ground, spot[1] + (inside ? -radius * 0.5 : radius * 1.5)], stoneRadius * 0.35);
      builder.add(shard, undefined, inside ? 'soil' : kind.debris);
    }
  }

  if (formationShare > 60) {
    const forms = planChildren(intRange(rng, 2, 5), 60, formationShare);
    for (let index = 0; index < forms.modeled; index += 1) {
      const along = -throat * range(rng, 0.22, 0.86);
      const hanging = chance(rng, 0.62);
      const length = radius * range(rng, 0.35, 0.95) * (hanging ? 1 : 0.7);
      const form = caveFormation({
        height: length,
        radius: radius * range(rng, 0.06, 0.14),
        kind: hanging ? 'stalactite' : 'stalagmite',
        seed: seed + 1213 + index * 41,
        budget: forms.each,
      });
      form.translate(
        range(rng, -radius * 0.5, radius * 0.5),
        hanging ? mouthY + radius * 0.9 : mouthY - radius * 0.92,
        along,
      );
      builder.add(form, undefined, 'stone-pale');
    }
  }

  builder.translate(0, -builder.bounds().min[1], 0);
  const heading = options.heading ?? 180;
  // The model is built with the hill behind it, so "into the hill" is compass
  // 180 by construction; turning it to the surveyed heading is the difference.
  if (Math.abs(heading - 180) > 1e-6) builder.rotateY(((heading - 180) * Math.PI) / 180);
  return builder;
}

/* --------------------------------------------------------------- monolith */

export type MonolithStyle = 'menhir' | 'hoodoo' | 'pillar' | 'tor';

export interface MonolithOptions {
  /** Height of the stone, from y = 0. */
  height: number;
  /** Footprint across X; defaults to a third of the height. */
  width?: number;
  /** Footprint through Z; defaults to a slab proportion of the width. */
  depth?: number;
  style?: MonolithStyle;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Lean off the vertical, in radians, the top tipping toward +X. */
  lean?: number;
  /** Lichen and moss on the shaded side and at the foot. */
  moss?: boolean;
  /** Carved grooves on the face that reads as the front. */
  runes?: boolean;
}

/**
 * A standing stone, in the four shapes erosion and people actually leave.
 *
 * A **menhir** is a slab a person set upright: battered, waisted nowhere, leaning
 * a few degrees because nobody ever got one plumb. A **hoodoo** is a spire with a
 * cap stone, pinched in the middle because the cap sheltered the top while the
 * rain took the waist. A **pillar** is basalt: hexagonal in section, near
 * vertical, and crossed by horizontal cooling joints rather than vertical frost
 * cracks. A **tor** is a stack of massive rounded blocks, which is what granite
 * does when it weathers along its own joints.
 *
 * Only the pillar is regular, and its regularity is the point — everything else
 * here is deliberately irregular, because a straight tapered column reads as
 * architecture no matter how much noise is on it.
 */
export function monolith(options: MonolithOptions): MeshBuilder {
  const seed = options.seed ?? 67;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.4, options.height);
  const style = options.style ?? 'menhir';
  const kind = ROCK_SURFACE[options.kind ?? (style === 'pillar' ? 'volcanic' : 'granite')];
  const budget = componentBudget(options.quality, options.budget);
  const width = Math.max(0.15, options.width ?? height * (style === 'tor' ? 0.62 : 0.34));
  const depth = Math.max(0.12, options.depth ?? width * (style === 'pillar' ? 0.94 : style === 'tor' ? 0.8 : 0.58));
  const mossShare = options.moss ? Math.min(budget * 0.1, 300) : 0;
  const runeShare = options.runes ? Math.min(budget * 0.14, 400) : 0;
  const stoneShare = Math.max(massCost(6, 5), budget - mossShare - runeShare);

  if (style === 'tor') {
    // A stack of blocks, each settled into the one below and yawed off it: the
    // joints are what make it read as weathered granite rather than a cairn, so
    // the blocks are wider and flatter and their edges stay sharp.
    const courses = Math.max(2, Math.round(height / Math.max(0.5, width * 0.55)));
    const blocks = planChildren(courses, stoneCost(5), stoneShare);
    let at = 0;
    for (let index = 0; index < blocks.modeled; index += 1) {
      const t = index / Math.max(1, blocks.modeled - 1);
      const blockHeight = (height / blocks.modeled) * range(rng, 0.82, 1.2);
      const shrink = 1 - t * 0.32;
      const block = boulder({
        radius: width * 0.5 * shrink,
        seed: seed + 131 + index * 43,
        roughness: 0.42,
        segments: stoneSegments(blocks.each),
        stretch: [range(rng, 1.1, 1.4), blockHeight / (width * shrink), range(rng, 0.95, 1.2)],
        sink: 0.06,
      });
      block.rotateY(range(rng, -0.4, 0.4));
      block.translate(range(rng, -width * 0.08, width * 0.08) * (1 - t), at, range(rng, -depth * 0.08, depth * 0.08));
      at += blockHeight * 0.86;
      builder.add(block, undefined, kind.material);
    }
  } else {
    // A pillar's identity is its horizontal joints, which need vertical
    // resolution to show at all, so it is planned against a taller mass than it
    // is: more stations, and the same facet count as any other stone.
    const plan = massPlan(stoneShare, style === 'pillar' ? height * 1.7 : height);
    const stone = rockMass({
      width,
      height,
      depth,
      segments: style === 'pillar' ? Math.max(6, Math.min(10, plan.segments)) : plan.segments,
      stations: plan.stations,
      roughness: style === 'pillar' ? kind.roughness * 0.4 : kind.roughness,
      taper: style === 'hoodoo' ? 0.42 : style === 'pillar' ? 0.93 : range(rng, 0.4, 0.66),
      waist: style === 'hoodoo' ? range(rng, 0.34, 0.5) : style === 'menhir' ? range(rng, 0, 0.12) : 0,
      face: 'front',
      seed,
    });
    if (style === 'pillar') {
      // Cooling joints are horizontal: basalt contracts toward its own axis as
      // it cools, so it cracks across the column and not along it.
      const joints = Math.max(2, Math.round(height / Math.max(0.35, height * 0.18)));
      for (let index = 0; index < stone.vertexCount; index += 1) {
        const point = stone.positionAt(index);
        const normal = stone.normalAt(index);
        const groove = Math.cos((point[1] / height) * Math.PI * 2 * joints);
        const amount = Math.pow(Math.max(0, groove), 6) * depth * 0.05;
        stone.setPosition(index, [point[0] - normal[0] * amount, point[1], point[2] - normal[2] * amount]);
      }
      stone.flatShade();
    }
    builder.add(stone, undefined, kind.material);
    if (style === 'hoodoo') {
      // The cap stone: a harder, flatter bed balanced on the spire, which is the
      // reason the spire is still there.
      const capPlan = planChildren(1, stoneCost(6), Math.max(stoneCost(6), stoneShare * 0.22));
      const cap = boulder({
        radius: width * 0.62,
        seed: seed + 811,
        roughness: 0.5,
        segments: stoneSegments(capPlan.each),
        stretch: [range(rng, 1.15, 1.45), range(rng, 0.3, 0.45), range(rng, 1.05, 1.3)],
        sink: 0.1,
      });
      cap.rotateY(range(rng, 0, Math.PI));
      cap.translate(0, height * 0.95, 0);
      builder.add(cap, undefined, pick(rng, ['stone-rough', 'sandstone'] as const, 'stone-rough'));
    }
    if (runeShare > 12) {
      // Carving is a groove, and a groove reads as a groove because it is in
      // shadow: a thin dark solid set into the face does that at any distance,
      // for a twentieth of what a real incision would cost.
      const strokes = planChildren(intRange(rng, 5, 9), 12, runeShare);
      const front = builder.bounds().max[2];
      for (let index = 0; index < strokes.modeled; index += 1) {
        const glyph = index % 3;
        const length = height * range(rng, 0.08, 0.17);
        const stroke = box(length * (glyph === 2 ? 0.3 : 1), length * (glyph === 2 ? 1 : 0.28), depth * 0.05);
        stroke.rotateZ(glyph === 0 ? 0 : glyph === 1 ? Math.PI / 2 : range(rng, -0.9, 0.9));
        stroke.translate(
          range(rng, -width * 0.22, width * 0.22),
          height * (0.42 + 0.34 * ((index * 0.37) % 1)),
          front - depth * 0.012,
        );
        builder.add(stroke, undefined, 'slate');
      }
    }
  }

  if (mossShare > TUFT_TRIANGLES) {
    // Moss holds on the shaded side and at the foot, where water stays.
    const patches = planChildren(intRange(rng, 3, 7), TUFT_TRIANGLES, mossShare);
    for (let index = 0; index < patches.modeled; index += 1) {
      const side = range(rng, 0, Math.PI * 2);
      const at = height * range(rng, 0.02, 0.42);
      const plant = tuft({
        height: Math.max(0.03, height * range(rng, 0.02, 0.05)),
        blades: Math.max(3, Math.min(7, Math.round(patches.each / BLADE_TRIANGLES))),
        radius: width * range(rng, 0.1, 0.22),
        seed: seed + 1601 + index * 23,
      });
      plant.translate(Math.cos(side) * width * 0.42, at, Math.sin(side) * depth * 0.42);
      builder.add(plant, undefined, pick(rng, ['moss', 'foliage-olive'] as const, 'moss'));
    }
  }

  const lean = options.lean ?? (style === 'tor' || style === 'pillar' ? 0 : range(rng, -0.05, 0.05));
  if (Math.abs(lean) > 1e-4) {
    // Lean about the foot, not about the world origin: rotating after seating
    // would swing the base sideways and lift it off the ground. Negated so a
    // positive lean tips the top toward +X, which is the direction a caller means
    // when it asks for one.
    builder.rotateZ(-lean);
    builder.translate(0, -builder.bounds().min[1], 0);
  }
  fitHeight(builder, height, style === 'hoodoo' ? 1.5 : 1.35, style === 'tor' ? false : true);
  return builder;
}

/* ----------------------------------------------------------- cave interior */

export type FormationKind = 'stalactite' | 'stalagmite' | 'column';

export interface CaveFormationOptions {
  /** Height of the formation, from y = 0. */
  height: number;
  /** Radius where it is thickest. */
  radius?: number;
  kind?: FormationKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Drip rings: the ridges left each time the water paused. */
  rings?: boolean;
}

/**
 * Dripstone: what a cave grows out of its own water.
 *
 * A stalagmite stands on the floor and a stalactite hangs from the roof, and the
 * two are the same shape built in opposite senses: both are widest where the
 * water arrives and taper to where the last drop fell. Both occupy y ∈ [0,
 * height] — a stalactite's attachment is at the top and its tip at y = 0, so a
 * caller hangs it by putting the ceiling at y = height. A column is the two
 * meeting, which is what happens given enough centuries.
 *
 * The profile is wobbled rather than smooth, and optionally ringed, because a
 * cone is the one shape dripstone never is.
 */
export function caveFormation(options: CaveFormationOptions): MeshBuilder {
  const seed = options.seed ?? 83;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.06, options.height);
  const radius = Math.max(0.015, options.radius ?? height * 0.14);
  const kind = options.kind ?? 'stalagmite';
  const budget = componentBudget(options.quality, options.budget);
  // A formation is lathes, so its whole cost is stations × facets × growths plus
  // the flare; stations buy the drip wobble and facets buy the roundness, and
  // roundness goes first. A column is two growths and has to pay for both.
  const stations = Math.max(4, Math.min(11, Math.round(height / Math.max(0.12, radius * 1.6))));
  const growths = kind === 'column' ? 2 : 1;
  const segments = Math.max(5, Math.min(14, Math.floor(budget / (growths * (stations - 1) * 2 + 4))));
  const rings = options.rings !== false && segments > 6 && stations > 5;

  /** One growth, from `from` to `to`, widest at `from`. */
  const growth = (from: number, to: number, offsetSeed: number): MeshBuilder => {
    const profile: Vec2[] = [];
    const steps = stations;
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const y = from + (to - from) * t;
      // Dripstone thickens where the water pauses and necks where it runs, so the
      // taper carries a wobble and, with rings, a repeating bead.
      const bead = rings ? 1 + 0.11 * Math.sin(t * Math.PI * 2 * Math.max(3, Math.round(stations * 0.8))) : 1;
      const taper = Math.pow(1 - t, 0.72);
      const wide = radius * (0.28 + 0.72 * taper) * bead * range(rng, 0.9, 1.1);
      profile.push([Math.max(radius * 0.05, wide) + (index === steps ? 0 : offsetSeed * 0), y]);
    }
    // A tip is a point, and a lathe with a radius of exactly zero skips its
    // quads, so the last station closes as a fan instead of collapsing.
    profile[profile.length - 1] = [radius * 0.05, to];
    return lathe(profile, { segments, caps: false });
  };

  if (kind === 'stalagmite') {
    builder.add(growth(0, height, 0), undefined, 'stone-pale');
  } else if (kind === 'stalactite') {
    // Widest at the ceiling, tapering down to the tip at y = 0.
    builder.add(growth(height, 0, 0), undefined, 'stone-pale');
  } else {
    const meet = height * range(rng, 0.42, 0.58);
    builder.add(growth(0, meet * 1.06, 0), undefined, 'stone-pale');
    builder.add(growth(height, meet * 0.94, 0), undefined, 'stone-pale');
  }
  // The foot of a standing formation flares where it meets the floor, and a
  // hanging one where it meets the roof: that is where the water spreads.
  const flare = prism({
    sides: segments,
    radius: radius * 1.32,
    height: Math.min(height * 0.16, radius * 1.5),
    topScale: 0.72,
    caps: true,
  });
  if (kind === 'stalactite') {
    flare.rotateX(Math.PI);
    flare.translate(0, height, 0);
  }
  builder.add(flare, undefined, 'stone-pale');
  displace(builder, { amplitude: radius * 0.22, frequency: 6 / Math.max(0.1, radius), octaves: 2, seed: seed + 17 });
  builder.flatShade();
  builder.translate(0, kind === 'stalactite' ? -height : -builder.bounds().min[1], 0);
  if (kind === 'stalactite') builder.translate(0, height, 0);
  return builder;
}

/* --------------------------------------------------------------- rock arch */

export interface RockArchOptions {
  /** Clear span between the feet, along X. */
  span: number;
  /** Rise of the underside of the span above the ground. */
  rise?: number;
  /** Thickness of the span band, from underside to crown. */
  thickness?: number;
  /** Width of the opening through Z: how deep the arch is to walk through. */
  depth?: number;
  /** 'arch' is a natural bridge of rock; 'bridge' carries a flat deck on top. */
  style?: 'arch' | 'bridge';
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

/**
 * A natural arch: a span of rock left standing after the rest of the fin eroded.
 *
 * The span is a real `arch` band, not a bent box, so the underside is a curve
 * with a constant thickness — scaling a copy would leave the haunches fat and
 * the crown thin, which is the giveaway of a faked arch. The feet are rock
 * masses the span beds into, because an arch standing on nothing is a lintel,
 * and a lintel is a thing people built.
 *
 * With `style: 'bridge'` a rubble deck is laid across the crown so the thing can
 * actually be crossed: a road that climbs over a natural bridge is one of the
 * reasons a world's paths look like they belong to it.
 */
export function rockArch(options: RockArchOptions): MeshBuilder {
  const seed = options.seed ?? 97;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const span = Math.max(0.8, options.span);
  const rise = Math.max(span * 0.24, options.rise ?? span * 0.52);
  const thickness = Math.max(0.12, options.thickness ?? span * 0.17);
  const depth = Math.max(0.3, options.depth ?? span * 0.42);
  const style = options.style ?? 'arch';
  const kind = ROCK_SURFACE[options.kind ?? 'sandstone'];
  const budget = componentBudget(options.quality, options.budget);
  const crown = rise + thickness;
  const deckShare = style === 'bridge' ? Math.min(budget * 0.16, 500) : 0;
  const footShare = Math.min(budget * 0.4, massCost(20, 14) * 2);
  // A span band costs eight triangles a segment and no more, so past twenty-two
  // segments the allowance has nowhere useful to go in the span itself; what is
  // left over is spent on rubble at the feet, which is where a real arch's
  // allowance would be anyway — the fin it was part of is lying there.
  const spanShare = Math.max(120, budget - deckShare - footShare);
  const segments = Math.max(6, Math.min(22, Math.floor(spanShare / (depth > span * 0.5 ? 7 : 9))));
  const spanCost = segments * 8 + 8;
  const rubbleShare = Math.max(0, budget - deckShare - footShare - spanCost);
  const band = arch({
    span,
    rise,
    thickness,
    depth,
    segments,
    style: 'round',
    voussoirs: false,
  });
  band.translate(0, 0, -depth / 2);
  // A natural arch is not smooth: the same two noise scales that break a boulder
  // break the span, at an amplitude that cannot close the opening it spans.
  fractureStone(band, seed, thickness * 0.16);
  builder.add(band, undefined, kind.material);

  if (footShare > massCost(6, 5)) {
    const feet = planChildren(2, massCost(6, 5), footShare);
    const plan = massPlan(feet.each, rise);
    for (const side of [-1, 1]) {
      const footWidth = span * range(rng, 0.24, 0.34);
      const foot = rockMass({
        width: footWidth,
        height: rise * range(rng, 0.86, 1.04),
        depth: depth * range(rng, 1.1, 1.5),
        segments: plan.segments,
        stations: plan.stations,
        roughness: kind.roughness,
        taper: range(rng, 0.55, 0.8),
        face: 'none',
        seed: seed + (side > 0 ? 223 : 419),
      });
      // Set outside the springing, so the fin the span was cut from is what the
      // span beds into and the opening stays open at ground level.
      foot.translate(side * (span / 2 + thickness * 0.5 + footWidth * 0.42), 0, 0);
      builder.add(foot, undefined, kind.material);
    }
  }

  if (deckShare > 0) {
    // A deck of what fell off the fin, laid flat enough to walk on.
    const deck = plane(span * 1.24, depth * 1.16, {
      widthSegments: Math.max(3, Math.min(10, Math.round(span / 0.7))),
      heightSegments: Math.max(2, Math.min(6, Math.round(depth / 0.9))),
      height: (x, z) => thickness * 0.16 * (1 - Math.pow(x / (span * 0.62), 2)) + fbm3(seed + 61, x, 0, z, 2) * thickness * 0.12,
    });
    deck.translate(0, crown + thickness * 0.05, 0);
    builder.add(deck, undefined, kind.debris);
    const stones = planChildren(Math.max(3, Math.round(span / 0.8)), stoneCost(5), deckShare * 0.6);
    const deckSegments = stoneSegments(stones.each);
    const spots = scatter(rng, stones.modeled, span * 1.1, depth * 0.9, 0.6);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      const stoneRadius = thickness * range(rng, 0.2, 0.5);
      const shard = boulder({
        radius: stoneRadius,
        seed: seed + 1571 + index * 19,
        roughness: 0.8,
        segments: deckSegments,
        stretch: [range(rng, 0.9, 1.4), range(rng, 0.35, 0.6), range(rng, 0.9, 1.4)],
        sink: 0.3,
      });
      settle(shard, rng, [spot[0], crown + thickness * 0.02, spot[1]], stoneRadius * 0.4);
      builder.add(shard, undefined, kind.material);
    }
  }
  if (rubbleShare > stoneCost(5)) {
    const rubble = planChildren(Math.max(3, Math.round(span / 0.7)), stoneCost(5), rubbleShare);
    const rubbleSegments = stoneSegments(rubble.each);
    const spots = scatter(rng, rubble.modeled, span * 1.5, depth * 2.2, 0.85);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      const stoneRadius = thickness * range(rng, 0.2, 0.62);
      const shard = boulder({
        radius: stoneRadius,
        seed: seed + 2131 + index * 23,
        roughness: 0.82,
        segments: rubbleSegments,
        stretch: [range(rng, 0.8, 1.3), range(rng, 0.35, 0.65), range(rng, 0.8, 1.3)],
        sink: range(rng, 0.24, 0.44),
      });
      // Debris collects at the feet of an arch, not under its crown: a rock fall
      // that choked the opening would make the thing it is modeling impassable,
      // and an arch a person cannot walk through is just a wall with a crack.
      const lateral = Math.max(span * 0.46, Math.abs(spot[0]));
      settle(shard, rng, [(spot[0] < 0 ? -1 : 1) * lateral, 0, spot[1]], stoneRadius * 0.5);
      builder.add(shard, undefined, pick(rng, [kind.material, kind.debris] as const, kind.material));
    }
  }
  fitHeight(builder, crown, 1.35);
  return builder;
}

/* ----------------------------------------------------------- stepping stones */

export interface SteppingStoneOptions {
  /** Length of the crossing, along Z. */
  length: number;
  /** Stones wanted; the budget decides how many are modeled. */
  count?: number;
  /** Typical stone radius. */
  stone?: number;
  /** Height of the treads above the ground, in metres. */
  tread?: number;
  /** How far the line wanders sideways, in metres. */
  wander?: number;
  /** 'river' stones are wet and dark; 'path' stones sit in dry ground. */
  style?: 'river' | 'path';
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
}

/**
 * A crossing: flat stones laid where someone needed to get over.
 *
 * The line wanders, because whoever laid it stepped where the footing was, not
 * where a ruler said. Treads are flat and roughly level but never quite — a
 * crossing whose stones are all the same height reads as paving — and each one
 * is bedded into the ground rather than balanced on it.
 *
 * River stones are darker and smoother: water polishes what it moves, and the
 * stones that stay wet grow a film that no dry stone has.
 */
export function steppingStones(options: SteppingStoneOptions): MeshBuilder {
  const seed = options.seed ?? 109;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const length = Math.max(0.6, options.length);
  const stone = Math.max(0.08, options.stone ?? Math.min(0.5, length * 0.11));
  const tread = Math.max(stone * 0.3, options.tread ?? stone * 0.62);
  const wander = Math.max(0, options.wander ?? stone * 0.9);
  const style = options.style ?? 'path';
  const kind = ROCK_SURFACE[options.kind ?? 'granite'];
  const budget = componentBudget(options.quality, options.budget);
  const material = style === 'river' ? 'slate' : kind.material;
  const chipShare = Math.min(budget * 0.18, 400);
  const stoneShare = Math.max(stoneCost(5), budget - chipShare);
  const wanted = Math.max(2, Math.round(options.count ?? Math.max(3, length / (stone * 2.6))));
  const plan = planChildren(wanted, stoneCost(5), stoneShare);
  const segments = stoneSegments(plan.each);

  let drift = 0;
  for (let index = 0; index < plan.modeled; index += 1) {
    const t = plan.modeled === 1 ? 0.5 : index / (plan.modeled - 1);
    const z = -length / 2 + t * length;
    // A crossing drifts sideways and does not return: whoever laid it was
    // working toward the far bank, not toward a centre line.
    drift = Math.max(-wander, Math.min(wander, drift + range(rng, -wander * 0.5, wander * 0.5)));
    const radius = stone * range(rng, 0.78, 1.24);
    // The tread height *is* the stone's height: lifting the stone by the tread
    // as well doubles it, and a crossing whose stones stand half a metre proud
    // of the water is a pile of blocks, not something anyone would walk on.
    const flat = (tread * range(rng, 0.88, 1.14)) / Math.max(0.2, radius * 2);
    const part = boulder({
      radius,
      seed: seed + 331 + index * 47,
      roughness: style === 'river' ? 0.34 : 0.62,
      segments,
      stretch: [range(rng, 1, 1.35), Math.max(0.24, flat), range(rng, 0.95, 1.3)],
      sink: range(rng, 0.24, 0.42),
    });
    settle(part, rng, [drift, 0, z], radius * 0.34);
    builder.add(part, undefined, material);
  }

  if (chipShare > stoneCost(5) && style === 'path') {
    // Gravel packed between the treads: what stops them walking apart.
    const chips = planChildren(Math.max(4, Math.round(length / (stone * 0.9))), stoneCost(5), chipShare);
    const chipSegments = stoneSegments(chips.each);
    const spots = scatter(rng, chips.modeled, stone * 3.4 + wander, length * 1.02, 0.9);
    for (let index = 0; index < spots.length; index += 1) {
      const spot = spots[index]!;
      const radius = stone * range(rng, 0.1, 0.26);
      const chip = boulder({
        radius,
        seed: seed + 1733 + index * 13,
        roughness: 0.8,
        segments: chipSegments,
        stretch: [range(rng, 0.8, 1.3), range(rng, 0.3, 0.55), range(rng, 0.8, 1.3)],
        sink: 0.42,
      });
      settle(chip, rng, [spot[0], 0, spot[1]], radius * 0.6);
      builder.add(chip, undefined, kind.debris);
    }
  }
  builder.translate(0, -builder.bounds().min[1], 0);
  return builder;
}

/* ------------------------------------------------------------------- cairn */

export interface CairnOptions {
  /** Height of the stack, from y = 0. */
  height: number;
  /** Radius of the base course. */
  base?: number;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** What the stack is marking: a mast, an upright stone, prayer flags, nothing. */
  marker?: 'none' | 'pole' | 'stone' | 'flags';
}

/**
 * A cairn: stones stacked so that they stay stacked.
 *
 * The rule a cairn follows is the rule of any dry stack — each course is smaller
 * than the one below, each stone sits into the hollow between two stones rather
 * than on top of one, and the whole thing leans nowhere. That is why the courses
 * here shrink in both radius and stone count, why each stone is yawed off its
 * neighbour, and why every stone is bedded down into the course under it instead
 * of balanced on it.
 *
 * A marker on the summit is what makes it a landmark rather than a pile: a mast
 * with flags is a pass in the mountains, an upright stone is a boundary.
 */
export function cairn(options: CairnOptions): MeshBuilder {
  const seed = options.seed ?? 127;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const height = Math.max(0.2, options.height);
  const base = Math.max(height * 0.16, options.base ?? height * 0.38);
  const kind = ROCK_SURFACE[options.kind ?? 'granite'];
  const marker = options.marker ?? 'none';
  const budget = componentBudget(options.quality, options.budget);
  const markerShare = marker === 'none' ? 0 : Math.min(budget * 0.18, 320);
  const stoneShare = Math.max(stoneCost(5) * 3, budget - markerShare);

  // Courses shrink by a fixed fraction, so the count follows the height and the
  // base radius rather than being asked for: a stack that does not taper falls.
  const courses = Math.max(2, Math.min(9, Math.round(height / Math.max(0.14, base * 0.72))));
  const courseHeight = height / courses;
  const wanted = Math.round(courses * 2.6 + 2);
  const plan = planChildren(wanted, stoneCost(5), stoneShare);
  const segments = stoneSegments(plan.each);
  let remaining = plan.modeled;
  let at = 0;
  // A course that cannot be paid for is a course that is not built: the stack
  // comes out shorter and `fitHeight` brings it back, which keeps the stone count
  // honest instead of quietly building past the allowance.
  for (let course = 0; course < courses && remaining > 0; course += 1) {
    const t = course / Math.max(1, courses - 1);
    const courseRadius = base * (1 - t * 0.78);
    // The summit is one stone; below it, stones ring the centre so each sits into
    // the hollow between two of the course underneath, which is what holds a dry
    // stack together.
    const ring = course === courses - 1 || remaining <= 2
      ? 1
      : Math.max(1, Math.min(5, Math.round(remaining / Math.max(1, courses - course))));
    const take = Math.min(ring, remaining);
    remaining -= take;
    for (let index = 0; index < take; index += 1) {
      const angle = (index / take) * Math.PI * 2 + range(rng, -0.3, 0.3) + course * 0.7;
      const distance = take === 1 ? 0 : courseRadius * range(rng, 0.34, 0.78);
      const radius = Math.max(0.04, courseRadius * range(rng, 0.42, 0.7));
      const stoneHeight = courseHeight * range(rng, 0.8, 1.08);
      const part = boulder({
        radius,
        seed: seed + 211 + course * 71 + index * 13,
        roughness: 0.66,
        segments,
        stretch: [range(rng, 1, 1.4), Math.max(0.28, stoneHeight / Math.max(0.1, radius * 1.6)), range(rng, 0.95, 1.3)],
        sink: 0.14,
      });
      // A stone's real height is whatever its facets and its noise made it, so it
      // is measured and brought to the course height. Letting each course drift
      // taller than planned is how a stack ends up a fifth over the height it was
      // asked for, which then has to be scaled back with its proportions wrong.
      const actual = part.bounds().size[1];
      if (actual > 1e-4) {
        part.scale(1, stoneHeight / actual, 1);
        part.flatShade();
      }
      // Bedded into the course below: dropped by a fraction of its own height so
      // it sits in a hollow rather than balancing on the stones under it.
      settle(part, rng, [Math.cos(angle) * distance, at, Math.sin(angle) * distance], radius * 0.5);
      builder.add(part, undefined, course === 0 ? kind.material : pick(rng, [kind.material, kind.debris] as const, kind.material));
    }
    at += courseHeight * 0.84;
  }

  if (marker === 'pole' || marker === 'flags') {
    // The marker is part of the height asked for, not extra on top of it: a mast
    // that doubles the stack is a flagpole with a cairn underneath, and it also
    // drives `fitHeight` past its clamp, which shrinks the stones to compensate.
    const poleHeight = height * range(rng, 0.3, 0.44);
    const pole = cylinder(height * 0.018, height * 0.026, poleHeight, { radialSegments: 5, caps: true, texel: 0.2 });
    pole.translate(0, height * 0.76 + poleHeight / 2, 0);
    builder.add(pole, undefined, 'wood-dark');
    if (marker === 'flags') {
      // A flag is a thin solid, not a sheet: a single plane is invisible from
      // behind it, and these are seen from every side of a pass.
      const flags = planChildren(intRange(rng, 3, 6), 12, Math.max(12, markerShare * 0.7));
      for (let index = 0; index < flags.modeled; index += 1) {
        const flag = box(height * range(rng, 0.12, 0.2), height * range(rng, 0.06, 0.11), height * 0.012);
        flag.rotateY(range(rng, 0, Math.PI * 2));
        flag.rotateZ(range(rng, -0.2, 0.2));
        flag.translate(0, height * 0.8 + poleHeight * range(rng, 0.3, 0.92), 0);
        builder.add(flag, undefined, pick(rng, ['fabric-linen', 'fabric-blue', 'petal-warm'] as const, 'fabric-linen'));
      }
    }
  }
  if (marker === 'stone') {
    const upright = prism({
      sides: intRange(rng, 4, 6),
      radius: base * range(rng, 0.2, 0.3),
      height: height * range(rng, 0.22, 0.34),
      topScale: range(rng, 0.2, 0.5),
      caps: true,
    });
    fractureStone(upright, seed + 911, base * 0.05);
    upright.rotateZ(range(rng, -0.08, 0.08));
    upright.translate(0, height * 0.86, 0);
    builder.add(upright, undefined, kind.material);
  }
  fitHeight(builder, height, 1.4);
  return builder;
}

/* ------------------------------------------------------------ boulder field */

export interface BoulderFieldOptions {
  /** Extent across X. */
  width: number;
  /** Extent through Z. */
  depth: number;
  /** Radius of the largest stone in the field. */
  stone?: number;
  /** Stones wanted; the budget decides how many are modeled. */
  count?: number;
  /** Bedrock outcrops standing proud of the debris, rather than loose stones. */
  outcrops?: number;
  kind?: RockKind;
  seed?: number;
  quality?: Quality;
  budget?: number;
  /** Grass and moss in the shelter of the stones. */
  greenery?: boolean;
}

/**
 * A boulder field: a wide scatter of loose stone over open ground.
 *
 * Unlike a scree slope there is no apron and no grading — this is rock that fell
 * a long time ago, or was left by ice, and has been weathering where it landed.
 * So the sizes follow a distribution rather than a position: a few masses, more
 * shards, and the ground between them left to the terrain underneath instead of
 * being covered by a sheet of its own.
 *
 * Outcrops are paid for first and are the reason a field reads as geology:
 * stones still attached to the bed tell you where the debris came from.
 */
export function boulderField(options: BoulderFieldOptions): MeshBuilder {
  const seed = options.seed ?? 139;
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const width = Math.max(1, options.width);
  const depth = Math.max(1, options.depth);
  const stone = Math.max(0.1, options.stone ?? Math.max(0.4, Math.min(width, depth) * 0.07));
  const kind = ROCK_SURFACE[options.kind ?? 'granite'];
  const budget = componentBudget(options.quality, options.budget);
  const wantedOutcrops = Math.max(0, Math.round(options.outcrops ?? Math.min(3, (width * depth) / 90)));
  const outcropShare = Math.min(budget * 0.3, wantedOutcrops * massCost(12, 8));
  const greenShare = options.greenery ? Math.min(budget * 0.1, 320) : 0;
  const stoneShare = Math.max(stoneCost(5), budget - outcropShare - greenShare);

  const wanted = Math.max(2, Math.round(options.count ?? Math.max(5, (width * depth) / (stone * stone * 34))));
  const plan = planChildren(wanted, stoneCost(5), stoneShare);
  const segments = stoneSegments(plan.each);
  const spots = scatter(rng, plan.modeled, width * 0.94, depth * 0.94, 0.8);
  for (let index = 0; index < spots.length; index += 1) {
    const spot = spots[index]!;
    // A field is a distribution, not a uniform size: a few masses carry the
    // silhouette and the rest are shards at their feet.
    const big = index % 5 === 0;
    const radius = stone * (big ? range(rng, 0.62, 1) : range(rng, 0.16, 0.5));
    const part = boulder({
      radius,
      seed: seed + 547 + index * 31,
      roughness: Math.min(1, kind.roughness + range(rng, -0.08, 0.18)),
      segments: big ? Math.min(18, segments + 2) : segments,
      stretch: [range(rng, 0.85, 1.3), range(rng, 0.5, 0.9), range(rng, 0.85, 1.3)],
      sink: range(rng, 0.16, 0.36),
    });
    settle(part, rng, [spot[0], 0, spot[1]], radius * 0.42);
    builder.add(part, undefined, big ? kind.material : pick(rng, [kind.material, kind.debris] as const, kind.material));
  }

  if (outcropShare > massCost(5, 4)) {
    const outcrops = planChildren(wantedOutcrops, massCost(6, 5), outcropShare);
    const outcropPlan = massPlan(outcrops.each, stone * 2.2);
    const places = scatter(rng, outcrops.modeled, width * 0.7, depth * 0.7, 0.5);
    for (let index = 0; index < places.length; index += 1) {
      const place = places[index]!;
      const outcrop = rockMass({
        width: stone * range(rng, 2.2, 4),
        height: stone * range(rng, 1.4, 2.8),
        depth: stone * range(rng, 1.8, 3.2),
        segments: outcropPlan.segments,
        stations: outcropPlan.stations,
        roughness: kind.roughness,
        taper: range(rng, 0.5, 0.8),
        face: chance(rng, 0.5) ? 'front' : 'top',
        seed: seed + 1901 + index * 67,
      });
      settle(outcrop, rng, [place[0], 0, place[1]], stone * 0.3);
      builder.add(outcrop, undefined, kind.material);
    }
  }

  if (greenShare > TUFT_TRIANGLES) {
    // Things grow in the shelter of a stone, on the side away from the wind.
    const tufts = planChildren(Math.max(3, Math.round((width * depth) / 12)), TUFT_TRIANGLES, greenShare);
    const places = scatter(rng, tufts.modeled, width * 0.88, depth * 0.88, 0.95);
    for (let index = 0; index < places.length; index += 1) {
      const place = places[index]!;
      const plant = tuft({
        height: stone * range(rng, 0.3, 0.8),
        blades: Math.max(3, Math.min(8, Math.round(tufts.each / BLADE_TRIANGLES))),
        seed: seed + 2213 + index * 11,
      });
      settle(plant, rng, [place[0], 0, place[1]], 0);
      builder.add(plant, undefined, pick(rng, ['grass', 'moss', 'foliage-olive'] as const, 'grass'));
    }
  }
  builder.translate(0, -builder.bounds().min[1], 0);
  return builder;
}
