import { MeshBuilder, type Vec2, type Vec3 } from '../mesh';
import { arch, box, cylinder, extrude, lathe, prism, sphere, sweep } from '../primitives';
import {
  BEVELLED_BOX_TRIANGLES, BOX_TRIANGLES, CORBEL_TRIANGLES, crenellations, dentils, door, framedPanel, planks,
  planRepeatedUnits, roofPanel, ridgeCap, stoneWall, stringCourse, windowUnit, corbel, detailRng,
  type MasonryStyle, type Quality, type RoofStyle,
} from '../detail';
import { chance, intRange, pick, range, type Rng } from '../../generation/rng';

/**
 * Architectural shell parts: walls with real openings, roofs with real pitches,
 * and the mouldings that make a building look built rather than extruded.
 *
 * Openings are not holes punched in a surface. A wall face is assembled from
 * piers, a lintel and a sill around each door and window, exactly as a mason
 * builds it, so every reveal casts its own shadow and the lintel visibly carries
 * the wall above it.
 *
 * Coordinates: a wall face runs along X, rises along Y from y = 0, and is
 * centred on z = 0. Roofs sit on the XZ plane with the ridge along X.
 */

export interface Opening {
  kind: 'door' | 'window' | 'arch' | 'slit' | 'gate' | 'shopfront';
  /** Position of the opening's centre across the face, in metres from its middle. */
  at?: number;
  /** Or as a fraction of the face length, when `at` is omitted. */
  atFraction?: number;
  width: number;
  height: number;
  /** Height of the opening's base above the floor. */
  sill?: number;
  style?: string;
  /** Build the joinery (door leaf, glazing bars) as well as the opening. */
  fitted?: boolean;
  /** Surround the opening with dressed stone. */
  surround?: boolean;
}

export interface WallFaceOptions {
  length: number;
  height: number;
  thickness?: number;
  openings?: readonly Opening[];
  style?: MasonryStyle | 'plaster' | 'timber';
  /** Material id for the wall surface; the caller assigns it. */
  seed?: number;
  budget?: number;
  /** Base course that sheds water off the wall foot. */
  plinth?: boolean;
  /** Timber framing over the plaster, as in a medieval town house. */
  framing?: boolean;
  ruin?: number;
}

/**
 * One wall face, assembled around its openings.
 *
 * The wall is built as solid piers between openings, a lintel over each, and a
 * sill under each window — so the geometry says where the load goes. A flat panel
 * with a dark rectangle painted on it never survives close inspection.
 */
export function wallFace(options: WallFaceOptions): MeshBuilder {
  const rng = detailRng(options.seed ?? 211);
  const builder = new MeshBuilder();
  const length = Math.max(0.4, options.length);
  const height = Math.max(0.6, options.height);
  const thickness = Math.max(0.1, options.thickness ?? 0.4);
  const openings = [...(options.openings ?? [])].sort((a, b) => centreOf(a, length) - centreOf(b, length));
  const budget = Math.max(240, options.budget ?? 1400);

  const masonryStyle: MasonryStyle | null =
    options.style === 'plaster' || options.style === 'timber' || !options.style ? null : options.style;

  /** A plain stretch of wall between two x positions. */
  const stretch = (from: number, to: number, base: number, top: number, depth: number, offsetZ = 0) => {
    const width = to - from;
    if (width <= 0.02 || top - base <= 0.02) return;
    if (masonryStyle) {
      const part = stoneWall({
        width,
        height: top - base,
        thickness: depth,
        style: masonryStyle,
        seed: (options.seed ?? 211) + Math.round(from * 13),
        budget: budget * 0.7,
        ruin: options.ruin,
      });
      part.translate((from + to) / 2, base, offsetZ);
      builder.add(part);
      return;
    }
    const panel = box(width, top - base, depth, { bevel: 0.01, bevelSegments: 1 });
    panel.translate((from + to) / 2, base + (top - base) / 2, offsetZ);
    builder.add(panel);
  };

  if (openings.length === 0) {
    stretch(-length / 2, length / 2, 0, height, thickness);
  } else {
    let cursor = -length / 2;
    for (const opening of openings) {
      const centre = centreOf(opening, length);
      const half = Math.max(0.2, opening.width) / 2;
      const left = Math.max(-length / 2, centre - half);
      const right = Math.min(length / 2, centre + half);
      const sill = opening.kind === 'door' || opening.kind === 'gate' ? 0 : Math.max(0.05, opening.sill ?? 0.9);
      const head = Math.min(height - 0.1, sill + opening.height);
      // Pier to the left of the opening.
      stretch(cursor, left, 0, height, thickness);
      // Below the sill and above the head.
      if (sill > 0.02) stretch(left, right, 0, sill, thickness);
      if (head < height - 0.02) stretch(left, right, head, height, thickness);
      // Lintel: a dressed beam that visibly carries the wall above the opening.
      const lintelDepth = thickness * 1.12;
      const lintelHeight = Math.min(0.28, Math.max(0.14, height - head));
      if (head + lintelHeight <= height + 0.01) {
        const lintel = box(right - left + 0.24, lintelHeight, lintelDepth, { bevel: 0.02, bevelSegments: 1 });
        lintel.translate(centre, head + lintelHeight / 2 - 0.02, 0);
        builder.add(lintel);
      }
      if (opening.surround) {
        for (const side of [-1, 1]) {
          const jamb = box(0.14, head - sill, thickness * 1.1, { bevel: 0.02, bevelSegments: 1 });
          jamb.translate(centre + side * (half + 0.07), sill + (head - sill) / 2, 0);
          builder.add(jamb);
        }
        if (sill > 0.05) {
          const sillStone = box(right - left + 0.28, 0.1, thickness * 1.3, { bevel: 0.02, bevelSegments: 1 });
          sillStone.translate(centre, sill - 0.03, thickness * 0.1);
          builder.add(sillStone);
        }
      }
      if (opening.fitted !== false) {
        const fitted = fitOpening(opening, right - left, head - sill, thickness, rng);
        fitted.translate(centre, sill + (head - sill) / 2, 0);
        builder.add(fitted);
      }
      cursor = Math.max(cursor, right);
    }
    stretch(cursor, length / 2, 0, height, thickness);
  }

  if (options.plinth) {
    const plinthHeight = Math.min(0.45, height * 0.14);
    const plinthPart = box(length + 0.12, plinthHeight, thickness + 0.14, { bevel: 0.03, bevelSegments: 1 });
    plinthPart.translate(0, plinthHeight / 2, 0);
    builder.add(plinthPart);
  }

  if (options.framing || options.style === 'timber') {
    builder.add(timberFrame(length, height, thickness, options.seed ?? 211, budget * 0.3));
  }
  return builder;
}

function centreOf(opening: Opening, length: number): number {
  if (typeof opening.at === 'number') return Math.max(-length / 2, Math.min(length / 2, opening.at));
  const fraction = opening.atFraction ?? 0;
  return -length / 2 + length * Math.max(0, Math.min(1, fraction));
}

/** The joinery that fills an opening: a door leaf, a window unit or an arch. */
function fitOpening(opening: Opening, width: number, height: number, thickness: number, rng: Rng): MeshBuilder {
  switch (opening.kind) {
    case 'door':
    case 'gate': {
      const leaf = door({
        width: width * 0.96,
        height: height * 0.98,
        thickness: Math.min(0.09, thickness * 0.28),
        style: opening.kind === 'gate' ? 'iron' : (opening.style as 'plank' | 'frame' | 'iron') ?? 'plank',
        seed: intRange(rng, 1, 9999),
      });
      leaf.translate(0, -height / 2, 0);
      return leaf;
    }
    case 'window':
    case 'shopfront': {
      const unit = windowUnit({
        width: width * 0.94,
        height: height * 0.94,
        depth: thickness * 0.7,
        style: (opening.style as 'mullion' | 'lattice' | 'shutter') ?? (opening.kind === 'shopfront' ? 'lattice' : 'mullion'),
        glass: true,
        surround: false,
      });
      return unit;
    }
    case 'arch': {
      const part = arch({
        span: width,
        rise: Math.min(height * 0.5, width * 0.5),
        thickness: Math.min(0.35, height * 0.22),
        depth: thickness * 0.9,
        style: 'round',
        voussoirs: true,
        segments: 18,
      });
      part.translate(0, -height / 2, 0);
      return part;
    }
    case 'slit':
    default: {
      // A splayed slit: narrow outside, wider inside, as an arrow loop is cut.
      const part = box(width * 0.9, height * 0.95, thickness * 0.5);
      return part;
    }
  }
}

/**
 * Timber framing over a plastered wall.
 *
 * Posts, a sill beam, a head beam and diagonal braces: the black-and-white
 * skeleton that reads as "medieval town" from any angle. It stands slightly proud
 * of the plaster so it casts the shadow that makes it legible.
 */
export function timberFrame(length: number, height: number, thickness: number, seed: number, budget: number): MeshBuilder {
  const rng = detailRng(seed);
  const builder = new MeshBuilder();
  const member = Math.max(0.09, Math.min(0.18, thickness * 0.32));
  const proud = member * 0.35;
  const z = thickness / 2 + proud / 2;
  const timber = (width: number, depth: number, x: number, y: number, angle = 0) => {
    const part = box(width, depth, member, { bevel: member * 0.12, bevelSegments: 1 });
    if (angle) part.rotateZ(angle);
    part.translate(x, y, z);
    builder.add(part);
  };
  // Sill and head beams.
  timber(length, member, 0, member / 2);
  timber(length, member, 0, height - member / 2);
  // Corner posts and intermediates.
  const posts = planRepeatedUnits(Math.max(2, Math.round(length / 1.6)) + 1, BOX_TRIANGLES, budget, 2).modeled;
  for (let index = 0; index < posts; index += 1) {
    const x = -length / 2 + (length * index) / Math.max(1, posts - 1);
    timber(member, height, x, height / 2);
  }
  // A mid rail on tall walls.
  if (height > 2.6) timber(length, member * 0.8, 0, height * 0.46);
  // Diagonal braces in alternate bays — the frame's actual stiffening.
  const bays = Math.max(1, posts - 1);
  for (let index = 0; index < bays; index += 1) {
    if (!chance(rng, 0.6)) continue;
    const x0 = -length / 2 + (length * index) / bays;
    const x1 = -length / 2 + (length * (index + 1)) / bays;
    const bayWidth = x1 - x0 - member * 2;
    const bayHeight = height * (height > 2.6 ? 0.42 : 0.86) - member * 2;
    const braceLength = Math.hypot(bayWidth, bayHeight);
    const angle = Math.atan2(bayHeight, bayWidth) * (index % 2 === 0 ? 1 : -1);
    const brace = box(braceLength, member * 0.8, member, { bevel: member * 0.1, bevelSegments: 1 });
    brace.rotateZ(angle);
    brace.translate((x0 + x1) / 2, member + bayHeight / 2 + (height > 2.6 ? 0 : 0), z);
    builder.add(brace);
  }
  return builder;
}

/* ------------------------------------------------------------------ roofs */

/* ------------------------------------------------------------------ roofs */

/**
 * Orientation of a sloped roof face.
 *
 * A face is described by the direction its ridge runs (`row`) and how steeply it
 * falls away from that ridge (`pitch`). Every roof in this file — gable, hip,
 * lean-to, cone — is assembled from faces, and one helper places geometry on
 * them, so the trigonometry is derived once and checked in one test instead of
 * being re-invented (and re-fumbled) per shape.
 */
export interface SlopeFace {
  /** Unit vector along the ridge; the face falls away to the right of it. */
  row: Vec3;
  /** Angle from horizontal, in radians. */
  pitch: number;
  /** A point on the ridge line. */
  origin: Vec3;
}

/**
 * Builds a face from its ridge point and the point directly below the eave.
 *
 * The two points fix both the ridge direction and the pitch, which is how a
 * caller thinks about a roof anyway: "the ridge is here, the eave is there".
 */
export function faceFrom(ridge: Vec3, eave: Vec3): SlopeFace {
  const dx = eave[0] - ridge[0];
  const dz = eave[2] - ridge[2];
  const dy = eave[1] - ridge[1];
  const run = Math.max(1e-4, Math.hypot(dx, dz));
  // The face must fall away to the right of its ridge direction, so the ridge
  // vector is chosen perpendicular to the fall rather than either of its two
  // possible signs.
  const fall: Vec3 = [dx / run, 0, dz / run];
  const row: Vec3 = [fall[2], 0, -fall[0]];
  return { row, pitch: Math.atan2(-dy, run), origin: ridge };
}

/**
 * Lays one course of roofing units along a slope.
 *
 * Used where a rectangular panel cannot follow the surface — a hip face, which
 * is a trapezoid, and a cone, whose courses shrink toward the apex. Each unit is
 * a small slab tilted onto the slope, so courses overlap the way tiles do and
 * cast the shadow lines that make a roof read as covered rather than painted.
 */
export function courseRow(
  builder: MeshBuilder,
  from: Vec3,
  to: Vec3,
  pitch: number,
  unit: { width: number; thickness?: number; length: number },
  material?: string,
): number {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const span = Math.hypot(dx, dz);
  if (span < 0.02 || unit.width <= 0.01) return 0;
  const thickness = unit.thickness ?? 0.028;
  // rotateX(-pitch) tilts the unit onto the slope about its own row axis; the
  // following rotateY swings that row to face `from` → `to`.
  const yaw = Math.atan2(-dz, dx);
  const count = Math.max(1, Math.round(span / unit.width));
  const width = span / count;
  for (let index = 0; index < count; index += 1) {
    const t = (index + 0.5) / count;
    const part = box(width * 0.94, thickness, unit.length);
    part.rotateX(-pitch);
    part.rotateY(yaw);
    part.translate(
      from[0] + dx * t,
      from[1] + (to[1] - from[1]) * t + thickness * 0.5,
      from[2] + dz * t,
    );
    builder.add(part, undefined, material);
  }
  return count;
}

export interface GableRoofOptions {
  /** Span across the gable, along X: the direction the roof falls. */
  width: number;
  /** Length of the building, along Z: the direction the ridge runs. */
  depth: number;
  /** Pitch in radians from horizontal; 0.62 ≈ 35°. */
  pitch?: number;
  overhang?: number;
  style?: RoofStyle;
  seed?: number;
  budget?: number;
  /** Ridge cap, fascia boards and barge boards. */
  trim?: boolean;
  /** Dormers along the slope. */
  dormers?: number;
  /** Fills the gable ends with wall triangles; false leaves an open roof. */
  gableWall?: boolean;
  wallThickness?: number;
}

/**
 * A pitched gable roof: two sloped panels, a ridge and gable ends.
 *
 * Pitch is a physical parameter here, not a styling knob. Below roughly 30° wind
 * drives rain back up under tiles, which is why a northern tile roof is steep and
 * a desert roof is flat — so the requested pitch is honoured exactly and the
 * ridge height follows from it as `(width / 2) · tan(pitch)`.
 *
 * The roof sits on y = 0 at the eaves, spans `width` across X and `depth` along
 * Z, overhanging both by `overhang`.
 */
export function gableRoof(options: GableRoofOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.5, options.width);
  const depth = Math.max(0.5, options.depth);
  const pitch = Math.max(0.12, Math.min(1.35, options.pitch ?? 0.62));
  const overhang = Math.max(0, options.overhang ?? Math.min(0.5, width * 0.07));
  const style = options.style ?? 'pan';
  const budget = Math.max(320, options.budget ?? 1600);
  const half = width / 2;
  const rise = half * Math.tan(pitch);
  const run = half / Math.cos(pitch);
  /** Ridge-to-eave distance along the slope, overhang included. */
  const slopeLength = run + overhang;
  const panelLength = depth + overhang * 2;

  for (const side of [-1, 1] as const) {
    // roofPanel lies flat with its ridge at z = 0 and its eave at
    // z = slopeLength + overhang. rotateX(pitch) lifts the far edge onto the
    // slope, rotateY(±π/2) turns the ridge to run along Z, and the result puts
    // the eave at x = side·(half + overhang·cos pitch), y = −(rise +
    // overhang·sin pitch) — so translating up by that y seats it exactly.
    const panel = roofPanel({
      width: panelLength,
      // roofPanel adds `overhang` to `slopeLength` itself, so the run passed
      // here stops at the wall line.
      slopeLength: run,
      overhang,
      style,
      seed: (options.seed ?? 223) + (side > 0 ? 0 : 7),
      budget: budget / 2,
    });
    panel.rotateX(pitch);
    panel.rotateY(side * Math.PI / 2);
    panel.translate(0, rise + overhang * Math.sin(pitch), 0);
    builder.add(panel);
  }

  if (options.gableWall !== false) {
    const wallThickness = Math.max(0.08, options.wallThickness ?? 0.34);
    const triangle: Vec2[] = [[-half, 0], [half, 0], [0, rise]];
    for (const side of [-1, 1] as const) {
      const gable = extrude(triangle, { depth: wallThickness, bevel: 0.015, bevelSegments: 1 });
      gable.translate(0, 0, side * (depth / 2) - (side > 0 ? wallThickness / 2 : -wallThickness / 2));
      builder.add(gable);
    }
  }

  if (options.trim !== false) {
    const ridge = ridgeCap({ length: panelLength, radius: Math.min(0.16, width * 0.03), seed: options.seed ?? 223 });
    ridge.rotateY(Math.PI / 2);
    ridge.translate(0, rise + 0.02, 0);
    builder.add(ridge);

    // Fascia boards hang off each eave; barge boards follow each rake.
    for (const side of [-1, 1] as const) {
      const eaveX = side * (half + overhang * Math.cos(pitch));
      const eaveY = -overhang * Math.sin(pitch);
      const fascia = box(0.06, 0.24, panelLength).translate(eaveX, eaveY - 0.08, 0);
      builder.add(fascia);
      for (const end of [-1, 1] as const) {
        // The rake runs from the eave corner up to the ridge, so the board is
        // centred on that line and turned to its angle: π − pitch on the +X
        // side, because the board climbs as x falls.
        const barge = box(slopeLength, 0.07, 0.06);
        barge.rotateZ(side * (Math.PI - pitch));
        barge.translate(eaveX / 2, (rise - overhang * Math.sin(pitch)) / 2, end * (depth / 2 + overhang));
        builder.add(barge);
      }
    }
  }

  const dormers = Math.max(0, Math.round(options.dormers ?? 0));
  for (let index = 0; index < dormers; index += 1) {
    for (const side of [-1, 1] as const) {
      if (dormers > 2 && side < 0 && index % 2 === 1) continue;
      const t = dormers === 1 ? 0.5 : (index + 0.5) / dormers;
      const z = -depth / 2 + depth * t;
      const dormerWidth = Math.min(1.2, (depth / dormers) * 0.62);
      // Sit the dormer 45% of the way down the slope from the ridge.
      const along = run * 0.45;
      const dormer = dormerUnit({ width: dormerWidth, height: Math.min(0.95, rise * 0.5), depth: 0.75, style, seed: (options.seed ?? 223) + index * 11 + side });
      dormer.rotateZ(-side * pitch);
      dormer.translate(side * along * Math.cos(pitch), rise - along * Math.sin(pitch), z);
      builder.add(dormer);
    }
  }
  return builder;
}

/** A dormer: a box with a window and its own small pitched roof, standing on a slope. */
export function dormerUnit(options: { width: number; height?: number; depth?: number; style?: RoofStyle; seed?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.4, options.width);
  const height = Math.max(0.35, options.height ?? 0.85);
  const depth = options.depth ?? 0.7;
  const cheek = box(width, height, depth, { bevel: 0.015, bevelSegments: 1 }).translate(0, height / 2, -depth / 2);
  builder.add(cheek);
  const glazing = windowUnit({ width: width * 0.62, height: height * 0.66, depth: 0.1, style: 'mullion', surround: true });
  glazing.translate(0, height * 0.52, 0.02);
  builder.add(glazing);
  const roof = gableRoof({
    width: width * 1.3,
    depth: depth * 1.12,
    pitch: 0.72,
    style: options.style ?? 'shingle',
    overhang: 0.07,
    budget: 420,
    seed: options.seed ?? 229,
    trim: false,
    gableWall: true,
    wallThickness: 0.08,
  });
  roof.translate(0, height, -depth / 2);
  builder.add(roof);
  return builder;
}

/** A single-slope roof: a porch, a shed, a lean-to against a wall. */
export function leanToRoof(options: {
  width: number;
  /** Horizontal distance from the high (wall) edge to the eave. */
  depth: number;
  pitch?: number;
  style?: RoofStyle;
  overhang?: number;
  seed?: number;
  budget?: number;
  /** Adds a fascia and a wall flashing board. */
  trim?: boolean;
}): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.5, options.width);
  const depth = Math.max(0.4, options.depth);
  const pitch = Math.max(0.1, Math.min(1.2, options.pitch ?? 0.35));
  const overhang = Math.max(0, options.overhang ?? 0.18);
  const run = depth / Math.cos(pitch);
  const panel = roofPanel({
    width: width + overhang * 2,
    // roofPanel adds the overhang to the slope it is given, so the run here
    // stops at the eave line of the shed, not past it.
    slopeLength: run,
    style: options.style ?? 'shingle',
    seed: options.seed ?? 281,
    budget: Math.max(280, options.budget ?? 900),
    overhang,
  });
  // roofPanel's ridge is at z = 0 and its eave at z = run + overhang, flat in
  // the XZ plane. A single rotateX(pitch) is all a lean-to needs: it leaves the
  // ridge along X and drops the eave to y = −(run + overhang)·sin(pitch),
  // z = (run + overhang)·cos(pitch) — the wall edge stays on y = 0, which is
  // where the caller puts it.
  panel.rotateX(pitch);
  builder.add(panel);
  if (options.trim !== false) {
    const eaveY = -(run + overhang) * Math.sin(pitch);
    const eaveZ = (run + overhang) * Math.cos(pitch);
    const fascia = box(width + overhang * 2, 0.2, 0.07).translate(0, eaveY - 0.09, eaveZ);
    builder.add(fascia);
    // Flashing closes the joint against the wall it leans on.
    const flashing = box(width + overhang * 2, 0.14, 0.12).translate(0, 0.05, -0.05);
    builder.add(flashing);
  }
  return builder;
}

export interface HipRoofOptions {
  width: number;
  depth: number;
  pitch?: number;
  overhang?: number;
  style?: RoofStyle;
  seed?: number;
  budget?: number;
  trim?: boolean;
}

/**
 * A hipped roof: four faces meeting at a short ridge, as on towers and on houses
 * in exposed places where wind gets at every side.
 *
 * The volume is one lofted solid from the eave rectangle to the ridge line, so
 * the hips are real arrises that catch light. All four faces carry the same pitch,
 * which fixes the ridge length at `max(span) − min(span)` — a hip roof's ridge is
 * not a free parameter, it is what equal pitches imply.
 *
 * Courses are laid with `courseRow` rather than as rectangular panels, because a
 * hip face is a trapezoid: a panel would overhang the arris at one end and leave
 * a gap at the other.
 */
export function hipRoof(options: HipRoofOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.6, options.width);
  const depth = Math.max(0.6, options.depth);
  const pitch = Math.max(0.15, Math.min(1.3, options.pitch ?? 0.58));
  const overhang = Math.max(0, options.overhang ?? Math.min(0.45, width * 0.06));
  const eaveW = width / 2 + overhang;
  const eaveD = depth / 2 + overhang;
  const short = Math.min(eaveW, eaveD);
  const long = Math.max(eaveW, eaveD);
  const rise = short * Math.tan(pitch);
  const ridgeHalf = Math.max(0, long - short);
  const budget = Math.max(300, options.budget ?? 1500);
  const alongZ = eaveD >= eaveW;
  const ridge: [Vec3, Vec3] = alongZ
    ? [[0, rise, -ridgeHalf], [0, rise, ridgeHalf]]
    : [[-ridgeHalf, rise, 0], [ridgeHalf, rise, 0]];
  const eaveRing: Vec3[] = [[-eaveW, 0, -eaveD], [eaveW, 0, -eaveD], [eaveW, 0, eaveD], [-eaveW, 0, eaveD]];
  // The ridge line is a degenerate "ring" of four points (two doubled) so the
  // loft closes into a wedge instead of a hole.
  const ridgeRing: Vec3[] = [ridge[0], ridge[1], ridge[1], ridge[0]];

  const solid = new MeshBuilder();
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    const a = eaveRing[index]!;
    const b = eaveRing[next]!;
    const c = ridgeRing[next]!;
    const d = ridgeRing[index]!;
    const corners = [a, d, c, b];
    const ring = corners.map((corner) => solid.vertex(corner, [(corner[0] + corner[2]) * 0.5, corner[1]], [0, 1, 0]));
    solid.quad(ring[0]!, ring[1]!, ring[2]!, ring[3]!);
  }
  const topRing = ridgeRing.map((corner) => solid.vertex(corner, [corner[0], corner[2]], [0, 1, 0]));
  solid.quad(topRing[0]!, topRing[1]!, topRing[2]!, topRing[3]!);
  const bottomRing = eaveRing.map((corner) => solid.vertex(corner, [corner[0], corner[2]], [0, -1, 0]));
  solid.quad(bottomRing[0]!, bottomRing[1]!, bottomRing[2]!, bottomRing[3]!);
  solid.computeNormals();
  builder.add(solid);

  // Courses over the four faces. Each face is a trapezoid from its eave edge to
  // its slice of the ridge; rows interpolate between them and shrink as they climb.
  // Courses and units-per-course are reduced separately: dropping rows first
  // keeps every course full width, so a cheaper roof still covers the building
  // instead of leaving a band of bare rafters round the middle.
  const unitBudget = Math.max(BOX_TRIANGLES * 16, budget - 160);
  const slopeRun = short / Math.cos(pitch);
  // Cutting the course count is the wrong economy: fewer courses means longer
  // units, and a two-metre slab tilted to the pitch hangs half a metre past the
  // eave. So the course count has a floor set by the slope itself, the units
  // along each course absorb the budget, and a roof that still does not fit
  // carries the texture instead of wearing roof-sized slabs.
  const courses = Math.max(3, Math.min(14, Math.round(slopeRun / 0.42)), Math.ceil(slopeRun / 0.6));
  const wantedPerCourse = Math.max(4, Math.round((long * 2) / 0.45));
  let perCourse = wantedPerCourse;
  while (courses * perCourse * 4 * BOX_TRIANGLES > unitBudget && perCourse > 4) perCourse -= 1;
  const textured = courses * perCourse * 4 * BOX_TRIANGLES > unitBudget;
  const lengthPerCourse = slopeRun / courses;
  // Each face is named by its eave edge and the slice of ridge above it. The
  // order of the two eave points decides which way `courseRow` tilts a unit, so
  // it is settled below by asking which order points up the slope — getting it
  // wrong hangs every course off the eave instead of laying it on the roof.
  const faces = orientFaces(
    alongZ
      ? [
        // Two trapezoids on the long sides, two triangles on the short ends: the
        // ridge collapses to a point where the roof is narrower than it is long.
        { eave: [[-eaveW, 0, -eaveD], [-eaveW, 0, eaveD]] as [Vec3, Vec3], ridge: [ridge[0], ridge[1]] as [Vec3, Vec3] },
        { eave: [[eaveW, 0, eaveD], [eaveW, 0, -eaveD]] as [Vec3, Vec3], ridge: [ridge[1], ridge[0]] as [Vec3, Vec3] },
        { eave: [[eaveW, 0, -eaveD], [-eaveW, 0, -eaveD]] as [Vec3, Vec3], ridge: [ridge[0], ridge[0]] as [Vec3, Vec3] },
        { eave: [[-eaveW, 0, eaveD], [eaveW, 0, eaveD]] as [Vec3, Vec3], ridge: [ridge[1], ridge[1]] as [Vec3, Vec3] },
      ]
      : [
        { eave: [[-eaveW, 0, -eaveD], [-eaveW, 0, eaveD]] as [Vec3, Vec3], ridge: [ridge[0], ridge[0]] as [Vec3, Vec3] },
        { eave: [[eaveW, 0, eaveD], [eaveW, 0, -eaveD]] as [Vec3, Vec3], ridge: [ridge[1], ridge[1]] as [Vec3, Vec3] },
        { eave: [[eaveW, 0, -eaveD], [-eaveW, 0, -eaveD]] as [Vec3, Vec3], ridge: [ridge[1], ridge[0]] as [Vec3, Vec3] },
        { eave: [[-eaveW, 0, eaveD], [eaveW, 0, eaveD]] as [Vec3, Vec3], ridge: [ridge[0], ridge[1]] as [Vec3, Vec3] },
      ],
  );
  if (!textured) {
    for (const face of faces) {
      for (let course = 0; course < courses; course += 1) {
        // Centred in its own band, so the eave course overhangs the eave by a
        // tile's worth rather than by half its own length.
        const t = (course + 0.5) / courses;
        courseRow(
          builder,
          lerp3(face.eave[0], face.ridge[0], t),
          lerp3(face.eave[1], face.ridge[1], t),
          pitch,
          { width: (long * 2) / perCourse, length: lengthPerCourse * 1.35, thickness: options.style === 'thatch' ? 0.09 : 0.03 },
        );
      }
    }
  }

  if (options.trim !== false) {
    const ridgeCapPart = ridgeCap({ length: ridgeHalf * 2 + 0.12, radius: Math.min(0.14, short * 0.05), seed: options.seed ?? 227 });
    if (!alongZ) ridgeCapPart.rotateY(Math.PI / 2);
    ridgeCapPart.translate(0, rise + 0.02, 0);
    builder.add(ridgeCapPart);
    // Hip rolls: a rounded board swept along each of the four hips. Sweeping
    // beats tilting a box, because a hip is a 3D line that is neither level nor
    // plumb — a box can only be aligned to one of those at a time.
    // The four hips are exactly the pairs the loft used: eave corner to the
    // ridge end above it. Taking them from the loft keeps the roll on the arris
    // even when a face is a triangle with two hips of its own.
    for (let index = 0; index < 4; index += 1) {
      const roll = sweep([eaveRing[index]!, ridgeRing[index]!], { section: () => hipRollSection(), caps: true, resample: 0 });
      builder.add(roll);
    }
    // Fascia boards along all four eaves.
    const eaveEdges: [Vec3, Vec3][] = [
      [[-eaveW, 0, -eaveD], [eaveW, 0, -eaveD]],
      [[eaveW, 0, -eaveD], [eaveW, 0, eaveD]],
      [[eaveW, 0, eaveD], [-eaveW, 0, eaveD]],
      [[-eaveW, 0, eaveD], [-eaveW, 0, -eaveD]],
    ];
    for (const [a, b] of eaveEdges) {
      const length = distance3(a, b);
      const yaw = Math.atan2(b[0] - a[0], b[2] - a[2]);
      const board = box(0.07, 0.22, length).translate(0, -0.09, 0);
      board.rotateY(yaw);
      board.translate((a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2);
      builder.add(board);
    }
  }
  return builder;
}

type RoofFace = { eave: [Vec3, Vec3]; ridge: [Vec3, Vec3] };

/**
 * Orders each face's eave points so that `courseRow` tilts up toward the ridge.
 *
 * `courseRow` lifts the units to the left of its row direction, so the row must
 * run with the ridge on that side. Rather than hard-code four sign conventions
 * that quietly break when the roof is wider than it is deep, the correct order is
 * derived from the face's own geometry.
 */
function orientFaces(faces: readonly RoofFace[]): RoofFace[] {
  return faces.map((face) => {
    const dx = face.eave[1][0] - face.eave[0][0];
    const dz = face.eave[1][2] - face.eave[0][2];
    const length = Math.max(1e-6, Math.hypot(dx, dz));
    // Left of the row direction, in the XZ plane.
    const leftX = -dz / length;
    const leftZ = dx / length;
    const toRidgeX = (face.ridge[0][0] + face.ridge[1][0]) / 2 - (face.eave[0][0] + face.eave[1][0]) / 2;
    const toRidgeZ = (face.ridge[0][2] + face.ridge[1][2]) / 2 - (face.eave[0][2] + face.eave[1][2]) / 2;
    const toward = leftX * toRidgeX + leftZ * toRidgeZ;
    return toward >= 0
      ? { eave: face.eave, ridge: face.ridge }
      : { eave: [face.eave[1], face.eave[0]], ridge: [face.ridge[1], face.ridge[0]] };
  });
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function distance3(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** A hip roll's cross-section: a shallow half-round standing proud of the tiles. */
function hipRollSection(): Vec2[] {
  return [[-0.07, -0.02], [0.07, -0.02], [0.055, 0.05], [-0.055, 0.05]];
}

export interface DomeOptions {
  radius: number;
  /** Rise of the crown; a hemisphere is `radius`, a saucer is less. */
  height?: number;
  thickness?: number;
  /** Ribs, as a lead or tile dome has. */
  ribs?: number;
  /** A lantern (small cupola) at the crown. */
  lantern?: boolean;
  seed?: number;
  segments?: number;
}

/**
 * A dome: a shell of revolution with ribs and an optional lantern.
 *
 * The profile is a slightly pointed ogee rather than a circular arc, because that
 * is what masonry domes actually build to — a pointed section carries its own
 * weight into the drum with less hoop thrust than a hemisphere does.
 */
export function dome(options: DomeOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const radius = Math.max(0.2, options.radius);
  const height = Math.max(0.1, options.height ?? radius * 0.95);
  const thickness = Math.max(0.03, options.thickness ?? radius * 0.09);
  const segments = Math.max(10, Math.round(options.segments ?? 20));
  const stations = 9;
  const outer: Vec2[] = [];
  const inner: Vec2[] = [];
  for (let index = 0; index <= stations; index += 1) {
    const angle = (index / stations) * Math.PI / 2;
    const r = Math.cos(angle) * radius;
    const y = Math.pow(Math.sin(angle), 0.86) * height;
    outer.push([r, y]);
    inner.push([Math.max(0, r - thickness), Math.max(0, y - thickness)]);
  }
  builder.add(lathe(outer, { segments, caps: false }));
  // The inner surface has to face the room, and the only thing that decides which
  // way a lathe faces is the direction its profile is traversed: downward faces
  // in toward the axis. `mirror` cannot do this — mirroring a surface of
  // revolution moves the geometry but leaves its normals pointing away from the
  // axis, so a mirrored inner dome is culled from inside and you see straight
  // through the shell.
  builder.add(lathe([...inner].reverse(), { segments, caps: false }));
  // The rim closes the shell so it reads as a thickness, not a floating surface.
  const rim = cylinder(radius, radius - thickness, thickness * 0.7, { radialSegments: segments, caps: false });
  builder.add(rim);

  const ribs = Math.max(0, Math.round(options.ribs ?? 0));
  for (let index = 0; index < ribs; index += 1) {
    const angle = (index / ribs) * Math.PI * 2;
    const spine: Vec3[] = outer.map((point) => [
      Math.cos(angle) * (point[0] + thickness * 0.45),
      point[1] + thickness * 0.25,
      Math.sin(angle) * (point[0] + thickness * 0.45),
    ]);
    // A rib follows the dome's curvature, so it is swept along the profile
    // rather than tilted into place: a straight prism only touches at one point.
    const rib = sweep(spine, {
      section: () => ribSection(Math.max(0.035, thickness * 0.5)),
      caps: true,
      resample: 0,
    });
    builder.add(rib);
  }
  if (options.lantern) {
    const lanternRadius = radius * 0.2;
    const drumHeight = height * 0.3;
    const drum = cylinder(lanternRadius, lanternRadius * 1.12, drumHeight, { radialSegments: 10 });
    drum.translate(0, height + drumHeight / 2, 0);
    builder.add(drum);
    const cap = prism({ sides: 10, radius: lanternRadius * 1.3, height: height * 0.34, topScale: 0, caps: true });
    cap.translate(0, height + drumHeight, 0);
    builder.add(cap);
    const finial = sphere(lanternRadius * 0.24, { widthSegments: 7, heightSegments: 5 });
    finial.translate(0, height + drumHeight + height * 0.34, 0);
    builder.add(finial);
  }
  return builder;
}

/** A rib's cross-section: a rounded strip standing proud of the shell. */
function ribSection(half: number): Vec2[] {
  return [[-half, -half * 0.7], [half, -half * 0.7], [half * 0.8, half * 0.9], [-half * 0.8, half * 0.9]];
}

export interface ConicalRoofOptions {
  radius: number;
  height?: number;
  style?: RoofStyle;
  seed?: number;
  budget?: number;
  finial?: boolean;
  /** Courses of roofing; more courses read better close up and cost more. */
  courses?: number;
}

/**
 * A conical roof for a round tower.
 *
 * Courses shrink toward the apex because a cone's radius does — laying
 * full-width courses over a cone is how a model ends up with tiles floating off
 * the surface. Each course is placed with `courseRow`, tangential to the ring at
 * its height and tilted to the cone's slope, which is constant at
 * `atan(height / radius)`.
 */
export function conicalRoof(options: ConicalRoofOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const radius = Math.max(0.2, options.radius);
  const height = Math.max(0.2, options.height ?? radius * 1.5);
  const style = options.style ?? 'shingle';
  const segments = Math.max(10, Math.round(radius * 14));
  const pitch = Math.atan2(height, radius);
  const wantedCourses = options.courses ?? Math.max(3, Math.min(12, Math.round(height / 0.5)));
  const courses = planRepeatedUnits(wantedCourses * segments, BOX_TRIANGLES, options.budget ?? 1200, wantedCourses * 3).modeled;
  const courseRise = height / courses;
  const courseLength = courseRise / Math.cos(pitch) * 1.35;
  const thickness = style === 'thatch' ? 0.1 : 0.03;

  for (let course = 0; course < courses; course += 1) {
    const t = course / courses;
    const ringRadius = radius * (1 - t);
    const y = height * t;
    const units = Math.max(4, Math.round(segments * (1 - t)));
    // Break the ring into unit arcs; each is laid along its chord.
    for (let index = 0; index < units; index += 1) {
      const stagger = (course % 2) * 0.5;
      const a0 = ((index + stagger) / units) * Math.PI * 2;
      const a1 = ((index + 1 + stagger) / units) * Math.PI * 2;
      const from: Vec3 = [Math.cos(a0) * ringRadius, y, Math.sin(a0) * ringRadius];
      const to: Vec3 = [Math.cos(a1) * ringRadius, y, Math.sin(a1) * ringRadius];
      const count = courseRow(builder, from, to, pitch, {
        width: Math.max(0.06, (Math.PI * 2 * ringRadius) / units / 3),
        length: courseLength,
        thickness,
      });
      void count;
    }
  }
  if (options.finial !== false) {
    const spike = prism({ sides: 5, radius: radius * 0.05, height: height * 0.16, topScale: 0, caps: true });
    spike.translate(0, height, 0);
    builder.add(spike);
    const ball = sphere(radius * 0.07, { widthSegments: 7, heightSegments: 5 });
    ball.translate(0, height + height * 0.02, 0);
    builder.add(ball);
  }
  return builder;
}

export function flatRoof(options: { width: number; depth: number; parapet?: number; thickness?: number; seed?: number; style?: MasonryStyle; budget?: number; walkway?: boolean }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.6, options.width);
  const depth = Math.max(0.6, options.depth);
  const thickness = options.thickness ?? 0.16;
  const parapet = options.parapet ?? 0.85;
  const deck = box(width, thickness, depth, { bevel: 0.02, bevelSegments: 1 });
  deck.translate(0, thickness / 2, 0);
  builder.add(deck);
  // A slight fall toward the middle, so water finds the drain.
  const fall = box(width * 0.9, 0.03, depth * 0.9);
  fall.translate(0, thickness + 0.01, 0);
  builder.add(fall);
  if (parapet > 0.05) {
    const walls = [
      { w: width + thickness, d: thickness, x: 0, z: -depth / 2 },
      { w: width + thickness, d: thickness, x: 0, z: depth / 2 },
      { w: thickness, d: depth, x: -width / 2, z: 0 },
      { w: thickness, d: depth, x: width / 2, z: 0 },
    ];
    for (const wall of walls) {
      const part = stoneWall({
        width: wall.w,
        height: parapet,
        thickness: wall.d,
        style: options.style ?? 'adobe',
        seed: options.seed ?? 239,
        budget: (options.budget ?? 900) / 4,
      });
      part.translate(wall.x, thickness, wall.z);
      if (wall.w === thickness) part.rotateY(Math.PI / 2);
      builder.add(part);
    }
    // A coping sheds rain off the parapet top.
    for (const wall of walls) {
      const coping = box(wall.w + 0.06, 0.07, wall.d + 0.1, { bevel: 0.015, bevelSegments: 1 });
      coping.translate(wall.x, thickness + parapet + 0.03, wall.z);
      builder.add(coping);
    }
  }
  return builder;
}

/* --------------------------------------------------------------- features */

/** A chimney: a stack with a corbelled cap and a pot. */
export function chimney(options: { width?: number; depth?: number; height?: number; seed?: number; style?: MasonryStyle; pots?: number }): MeshBuilder {
  const rng = detailRng(options.seed ?? 241);
  const builder = new MeshBuilder();
  const width = options.width ?? 0.7;
  const depth = options.depth ?? 0.5;
  const height = options.height ?? 1.6;
  const stack = stoneWall({ width, height, thickness: depth, style: options.style ?? 'brick', seed: options.seed ?? 241, budget: 500 });
  builder.add(stack);
  const corbel = box(width + 0.16, 0.1, depth + 0.16, { bevel: 0.02, bevelSegments: 1 }).translate(0, height + 0.05, 0);
  builder.add(corbel);
  const cap = box(width + 0.1, 0.14, depth + 0.1, { bevel: 0.025, bevelSegments: 1 }).translate(0, height + 0.17, 0);
  builder.add(cap);
  const pots = Math.max(0, Math.round(options.pots ?? (width > 0.55 ? 2 : 1)));
  for (let index = 0; index < pots; index += 1) {
    const x = pots === 1 ? 0 : -width / 4 + (width / 2) * (index / Math.max(1, pots - 1));
    const pot = cylinder(width * 0.14, width * 0.17, height * 0.22, { radialSegments: 8 });
    pot.translate(x, height + 0.24 + height * 0.11, range(rng, -depth * 0.1, depth * 0.1));
    builder.add(pot);
    const lip = cylinder(width * 0.18, width * 0.16, 0.05, { radialSegments: 8 });
    lip.translate(x, height + 0.24 + height * 0.22, 0);
    builder.add(lip);
  }
  return builder;
}

/** A porch: two posts, a lintel and a small pitched roof over a door. */
export function porch(options: { width?: number; depth?: number; height?: number; seed?: number; style?: RoofStyle; posts?: 'timber' | 'stone' | 'column' }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = options.width ?? 1.8;
  const depth = options.depth ?? 1.2;
  const height = options.height ?? 2.4;
  const postStyle = options.posts ?? 'timber';
  for (const side of [-1, 1]) {
    const x = side * (width / 2 - 0.12);
    if (postStyle === 'column') {
      const shaft = cylinder(0.14, 0.16, height - 0.3, { radialSegments: 12, ripple: 0.03 });
      shaft.translate(x, (height - 0.3) / 2 + 0.12, depth / 2 - 0.14);
      builder.add(shaft);
      const base = box(0.42, 0.14, 0.42, { bevel: 0.02, bevelSegments: 1 }).translate(x, 0.07, depth / 2 - 0.14);
      const capital = box(0.4, 0.16, 0.4, { bevel: 0.025, bevelSegments: 1 }).translate(x, height - 0.2, depth / 2 - 0.14);
      builder.add(base);
      builder.add(capital);
      continue;
    }
    if (postStyle === 'stone') {
      const pier = stoneWall({ width: 0.32, height, thickness: 0.32, style: 'ashlar', seed: 251, budget: 300 });
      pier.translate(x, 0, depth / 2 - 0.16);
      builder.add(pier);
      continue;
    }
    const post = box(0.16, height, 0.16, { bevel: 0.02, bevelSegments: 1 }).translate(x, height / 2, depth / 2 - 0.1);
    builder.add(post);
    const brace = box(0.5, 0.1, 0.1, { bevel: 0.015, bevelSegments: 1 });
    brace.rotateZ(side * 0.7);
    brace.translate(x - side * 0.22, height - 0.42, depth / 2 - 0.1);
    builder.add(brace);
  }
  const lintel = box(width + 0.2, 0.18, depth + 0.3, { bevel: 0.025, bevelSegments: 1 }).translate(0, height - 0.09, depth / 2 - 0.15);
  builder.add(lintel);
  // A porch roof is a lean-to: high against the wall, falling to the posts. A
  // gable here would need a ridge running out from the facade, which is a
  // different building.
  const roof = leanToRoof({ width: width + 0.5, depth: depth + 0.35, pitch: 0.42, style: options.style ?? 'shingle', overhang: 0.14, budget: 700, seed: options.seed ?? 257, trim: true });
  roof.translate(0, height, -depth * 0.45);
  builder.add(roof);
  return builder;
}

/** A balcony with a balustrade, brackets and a handrail. */
export function balcony(options: { width?: number; depth?: number; seed?: number; balusters?: number; style?: 'stone' | 'timber' | 'iron' }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = options.width ?? 2.2;
  const depth = options.depth ?? 0.9;
  const style = options.style ?? 'stone';
  const deckThickness = 0.14;
  const deck = box(width, deckThickness, depth, { bevel: 0.02, bevelSegments: 1 }).translate(0, deckThickness / 2, depth / 2);
  builder.add(deck);
  const brackets = Math.max(2, Math.round(width / 0.9));
  for (let index = 0; index < brackets; index += 1) {
    const x = -width / 2 + (width * (index + 0.5)) / brackets;
    const part = corbel({ depth: depth * 0.85, width: 0.26, height: 0.4 });
    part.rotateX(Math.PI / 2);
    part.translate(x, -0.28, depth * 0.5);
    builder.add(part);
  }
  const railHeight = 0.95;
  const balusters = planRepeatedUnits(
    Math.max(4, Math.round(options.balusters ?? width / 0.13)),
    style === 'iron' ? 24 : BOX_TRIANGLES,
    700,
    4,
  ).modeled;
  for (let index = 0; index <= balusters; index += 1) {
    const x = -width / 2 + (width * index) / balusters;
    // A turned baluster stands from y = 0 to y = railHeight, while a box or a
    // bar is centred on its height — so the two need different seat heights.
    const part = style === 'stone'
      ? lathe([[0.05, 0], [0.07, 0.06], [0.045, 0.3], [0.055, 0.55], [0.04, 0.78], [0.06, railHeight]], { segments: 8 })
      : style === 'iron'
        ? box(0.025, railHeight, 0.025)
        : box(0.06, railHeight, 0.05, { bevel: 0.008, bevelSegments: 1 });
    part.translate(x, deckThickness + (style === 'stone' ? 0 : railHeight / 2), depth - 0.08);
    builder.add(part);
  }
  for (const side of [-1, 1]) {
    const part = style === 'stone'
      ? box(0.12, railHeight, depth, { bevel: 0.015, bevelSegments: 1 })
      : box(0.08, railHeight, depth * 0.94, { bevel: 0.012, bevelSegments: 1 });
    part.translate(side * (width / 2 - 0.06), deckThickness + railHeight / 2, depth / 2);
    builder.add(part);
  }
  const handrail = box(width, 0.09, 0.16, { bevel: 0.02, bevelSegments: 1 }).translate(0, deckThickness + railHeight + 0.04, depth - 0.08);
  builder.add(handrail);
  for (const side of [-1, 1]) {
    const rail = box(0.16, 0.09, depth, { bevel: 0.02, bevelSegments: 1 }).translate(side * (width / 2 - 0.08), deckThickness + railHeight + 0.04, depth / 2);
    builder.add(rail);
  }
  return builder;
}

/** An arcade: a run of arches on columns, for cloisters and market halls. */
export function arcade(options: { length: number; height?: number; bays?: number; depth?: number; seed?: number; style?: 'round' | 'pointed'; budget?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(1.5, options.length);
  const height = options.height ?? 3.4;
  const bays = Math.max(1, Math.round(options.bays ?? Math.max(2, length / 2.6)));
  const depth = options.depth ?? 0.5;
  const bayWidth = length / bays;
  const columnHeight = height * 0.52;
  const springing = columnHeight;
  const archHeight = height - springing;
  for (let index = 0; index <= bays; index += 1) {
    const x = -length / 2 + bayWidth * index;
    const shaft = cylinder(depth * 0.28, depth * 0.32, columnHeight - 0.34, { radialSegments: 12, ripple: 0.02 });
    shaft.translate(x, 0.2 + (columnHeight - 0.34) / 2, 0);
    builder.add(shaft);
    const base = box(depth * 0.9, 0.2, depth * 0.9, { bevel: 0.025, bevelSegments: 1 }).translate(x, 0.1, 0);
    const capital = box(depth * 0.86, 0.16, depth * 0.86, { bevel: 0.03, bevelSegments: 1 }).translate(x, columnHeight - 0.06, 0);
    builder.add(base);
    builder.add(capital);
    const abacus = box(depth * 1, 0.1, depth * 1, { bevel: 0.02, bevelSegments: 1 }).translate(x, columnHeight + 0.05, 0);
    builder.add(abacus);
  }
  for (let index = 0; index < bays; index += 1) {
    const centre = -length / 2 + bayWidth * (index + 0.5);
    const span = bayWidth - depth * 0.7;
    const rise = Math.min(archHeight * 0.72, span * (options.style === 'pointed' ? 0.7 : 0.5));
    const part = arch({
      span,
      rise,
      thickness: depth * 0.55,
      depth,
      style: options.style ?? 'round',
      voussoirs: true,
      segments: 18,
    });
    part.translate(centre, springing + 0.1, 0);
    builder.add(part);
    // Spandrel: the wall between the arch and the cornice above it.
    const spandrelTop = height;
    const spandrel = box(bayWidth, Math.max(0.1, spandrelTop - springing - rise - 0.2), depth * 0.9);
    spandrel.translate(centre, springing + rise + 0.1 + Math.max(0.1, spandrelTop - springing - rise - 0.2) / 2, 0);
    builder.add(spandrel);
  }
  const cornice = box(length + 0.2, 0.22, depth + 0.2, { bevel: 0.03, bevelSegments: 1 }).translate(0, height + 0.11, 0);
  builder.add(cornice);
  return builder;
}

/** A cornice course: dentils under a projecting slab, crowning a facade. */
export function cornice(options: { length: number; depth?: number; seed?: number; dentils?: boolean; modillions?: boolean }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.4, options.length);
  const depth = options.depth ?? 0.42;
  if (options.dentils !== false) {
    const part = dentils({ length: length * 0.98, unit: 0.17, height: 0.12, depth: depth * 0.6 });
    part.translate(0, 0, -depth * 0.1);
    builder.add(part);
  }
  if (options.modillions) {
    const count = Math.max(2, Math.round(length / 1.1));
    for (let index = 0; index < count; index += 1) {
      const x = -length / 2 + (length * (index + 0.5)) / count;
      const part = corbel({ depth: depth * 0.9, width: 0.24, height: 0.22 });
      part.rotateX(Math.PI / 2);
      part.translate(x, 0.1, depth * 0.2);
      builder.add(part);
    }
  }
  const slab = box(length, 0.14, depth, { bevel: 0.025, bevelSegments: 1 }).translate(0, 0.19, depth * 0.06);
  builder.add(slab);
  const fascia = box(length, 0.1, depth * 0.7).translate(0, 0.09, -depth * 0.1);
  builder.add(fascia);
  return builder;
}

/** A floor slab with joists showing, for balconies, porches and interiors. */
export function floorSlab(options: { width: number; depth: number; thickness?: number; joists?: boolean; seed?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(0.4, options.width);
  const depth = Math.max(0.4, options.depth);
  const thickness = options.thickness ?? 0.14;
  const deck = planks({ width, height: depth, thickness, count: Math.max(3, Math.round(depth / 0.22)), horizontal: true, seed: options.seed ?? 263, battens: false });
  deck.rotateX(-Math.PI / 2);
  deck.translate(0, thickness, 0);
  builder.add(deck);
  const beam = box(width, thickness, depth, { bevel: 0.015, bevelSegments: 1 }).translate(0, thickness / 2, 0);
  builder.add(beam);
  if (options.joists !== false) {
    const count = Math.max(2, Math.round(width / 0.6));
    for (let index = 0; index < count; index += 1) {
      const x = -width / 2 + (width * (index + 0.5)) / count;
      const joist = box(0.12, thickness * 1.5, depth * 0.98, { bevel: 0.012, bevelSegments: 1 });
      joist.translate(x, -thickness * 0.6, 0);
      builder.add(joist);
    }
  }
  return builder;
}

/** Battlements running around a rectangular wall top, corners included. */
export function parapetRun(options: { width: number; depth: number; thickness?: number; height?: number; seed?: number; style?: 'square' | 'stepped' | 'pointed' | 'round'; walkway?: boolean }): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(1, options.width);
  const depth = Math.max(1, options.depth);
  const thickness = options.thickness ?? 0.45;
  const height = options.height ?? 0.75;
  for (const side of [-1, 1]) {
    const run = crenellations({ length: width, height, thickness, style: options.style ?? 'square', seed: options.seed ?? 269 });
    run.translate(0, 0, side * (depth / 2 - thickness / 2));
    builder.add(run);
  }
  for (const side of [-1, 1]) {
    const run = crenellations({ length: Math.max(0.4, depth - thickness * 2), height, thickness, style: options.style ?? 'square', seed: (options.seed ?? 269) + 5 });
    run.rotateY(Math.PI / 2);
    run.translate(side * (width / 2 - thickness / 2), 0, 0);
    builder.add(run);
  }
  if (options.walkway) {
    const walk = box(width - thickness * 2, 0.08, depth - thickness * 2);
    walk.translate(0, -0.04, 0);
    builder.add(walk);
  }
  return builder;
}

/** A tower shaft: round or square, battered (sloping) with a plinth and string courses. */
export function towerShaft(options: {
  height: number;
  radius: number;
  shape?: 'round' | 'square' | 'octagon';
  batter?: number;
  courses?: number;
  seed?: number;
  style?: MasonryStyle;
  budget?: number;
  windows?: number;
  door?: boolean;
}): MeshBuilder {
  const rng = detailRng(options.seed ?? 271);
  const builder = new MeshBuilder();
  const height = Math.max(1, options.height);
  const radius = Math.max(0.5, options.radius);
  const shape = options.shape ?? 'round';
  const batter = Math.max(0, Math.min(0.4, options.batter ?? 0.08));
  const budget = Math.max(400, options.budget ?? 2200);
  const sides = shape === 'square' ? 4 : 8;
  const radialSegments = Math.max(10, Math.round(radius * 9));
  const slits = Math.max(0, Math.round(options.windows ?? 0));
  // A course costs its drum, its string-course band and its slits. When the
  // budget is short the shaft gets fewer, taller courses rather than stopping
  // halfway up: a coarse tower still stands, a truncated one does not.
  const perCourse = (shape === 'round' ? radialSegments * 8 : sides * 4) + slits * BEVELLED_BOX_TRIANGLES;
  const wantedCourses = Math.max(2, Math.round(options.courses ?? Math.max(3, height / 3)));
  const courses = planRepeatedUnits(wantedCourses, perCourse, budget - BOX_TRIANGLES * 2, 2).modeled;
  const courseHeight = height / courses;

  for (let course = 0; course < courses; course += 1) {
    const t = course / courses;
    const nextT = (course + 1) / courses;
    const radiusBottom = radius * (1 - batter * t);
    const radiusTop = radius * (1 - batter * nextT);
    const y = course * courseHeight;
    if (shape === 'round') {
      const drum = cylinder(radiusTop, radiusBottom, courseHeight, { radialSegments, heightSegments: 1, wobble: 0.012, wobbleSeed: course + 3 });
      drum.translate(0, y + courseHeight / 2, 0);
      builder.add(drum);
    } else {
      // A tapered prism per course, so the batter shows in every stone run.
      const drum = prism({ sides, radius: radiusBottom, height: courseHeight, topScale: radiusTop / radiusBottom, caps: false });
      drum.rotateY(Math.PI / sides);
      drum.translate(0, y, 0);
      builder.add(drum);
    }
    // A string course marks each floor and breaks the shaft's shadow.
    if (course > 0) {
      const band = shape === 'round'
        ? cylinder(radiusBottom * 1.06, radiusBottom * 1.08, 0.16, { radialSegments })
        : prism({ sides, radius: radiusBottom * 1.1, height: 0.16, topScale: 1, caps: true });
      if (shape !== 'round') band.rotateY(Math.PI / sides);
      band.translate(0, y + 0.08, 0);
      builder.add(band);
    }
    // Arrow slits, staggered so they never line up in a vertical seam.
    if (slits > 0 && course > 0) {
      const angle = (course / courses) * Math.PI * 2 + range(rng, -0.4, 0.4);
      for (let index = 0; index < slits; index += 1) {
        const slitAngle = angle + (index / Math.max(1, slits)) * Math.PI * 2;
        const slit = box(0.12, courseHeight * 0.5, radiusBottom * 0.5, { bevel: 0.02, bevelSegments: 1 });
        slit.rotateY(-slitAngle);
        slit.translate(Math.cos(slitAngle) * radiusBottom * 0.94, y + courseHeight * 0.5, Math.sin(slitAngle) * radiusBottom * 0.94);
        builder.add(slit);
      }
    }
  }

  // A sloping plinth at the foot: it sheds water and stops a siege engine.
  const plinthHeight = Math.min(1.1, height * 0.12);
  if (shape === 'round') {
    const plinth = cylinder(radius * 1.02, radius * (1 + batter) * 1.22, plinthHeight, { radialSegments: radialSegments + 2 });
    plinth.translate(0, plinthHeight / 2, 0);
    builder.add(plinth);
  } else {
    const plinth = prism({ sides, radius: radius * 1.16, height: plinthHeight, topScale: 0.9, caps: true });
    plinth.rotateY(Math.PI / sides);
    builder.add(plinth);
  }
  if (options.door) {
    const doorway = door({ width: Math.min(1.3, radius * 0.9), height: 2.15, style: 'arched', seed: options.seed ?? 271 });
    doorway.translate(0, 0, radius * (1 - batter * 0.2) - 0.06);
    builder.add(doorway);
    const surround = arch({ span: doorwayWidth(radius) + 0.5, rise: 1.2, thickness: 0.28, depth: 0.3, style: 'round', voussoirs: true, segments: 14 });
    surround.translate(0, 2.15, radius * (1 - batter * 0.2) - 0.02);
    builder.add(surround);
  }
  return builder;
}

function doorwayWidth(radius: number): number {
  return Math.min(1.3, radius * 0.9);
}

/** A machicolation: the corbelled gallery that lets a defender drop things. */
export function machicolation(options: { radius?: number; width?: number; depth?: number; height?: number; seed?: number; round?: boolean; budget?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const height = options.height ?? 0.85;
  const budget = options.budget ?? 1200;
  if (options.round) {
    const radius = Math.max(1, options.radius ?? 3);
    const corbels = planRepeatedUnits(Math.max(8, Math.round(radius * 5)), CORBEL_TRIANGLES, budget, 8).modeled;
    for (let index = 0; index < corbels; index += 1) {
      const angle = (index / corbels) * Math.PI * 2;
      const part = corbel({ depth: 0.42, width: 0.26, height: 0.36 });
      part.rotateY(-angle + Math.PI);
      part.translate(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      builder.add(part);
    }
    const ring = cylinder(radius + 0.42, radius + 0.42, height, { radialSegments: Math.max(14, corbels), caps: false });
    ring.translate(0, height / 2 + 0.3, 0);
    builder.add(ring);
    const inner = cylinder(radius + 0.1, radius + 0.1, height * 0.9, { radialSegments: Math.max(12, corbels), caps: false });
    inner.translate(0, height / 2 + 0.3, 0);
    builder.add(inner);
    const walk = cylinder(radius + 0.44, radius + 0.44, 0.1, { radialSegments: Math.max(14, corbels) });
    walk.translate(0, height + 0.35, 0);
    builder.add(walk);
    // Merlons follow the ring, each yawed to its own radius.
    const merlonCount = planRepeatedUnits(Math.max(8, Math.round(radius * 4)), BOX_TRIANGLES, budget * 0.3, 8).modeled;
    for (let index = 0; index < merlonCount; index += 1) {
      const angle = (index / merlonCount) * Math.PI * 2;
      const merlon = box(0.42, 0.62, 0.3, { bevel: 0.03, bevelSegments: 1 });
      merlon.rotateY(-angle);
      merlon.translate(Math.cos(angle) * (radius + 0.42), height + 0.4 + 0.31, Math.sin(angle) * (radius + 0.42));
      builder.add(merlon);
    }
    return builder;
  }
  const width = Math.max(1, options.width ?? 6);
  const depth = Math.max(1, options.depth ?? 6);
  for (const side of [-1, 1]) {
    const run = corbelRun({ length: width, seed: options.seed ?? 277, budget: budget / 4 });
    run.translate(0, 0, side * (depth / 2 + 0.1));
    builder.add(run);
    const wallPart = stoneWall({ width: width + 0.8, height, thickness: 0.4, style: 'ashlar', seed: (options.seed ?? 277) + side, budget: budget / 3 });
    wallPart.translate(0, height / 2 + 0.34, side * (depth / 2 + 0.3));
    builder.add(wallPart);
    const merlons = crenellations({ length: width + 0.8, height: 0.55, thickness: 0.4, seed: (options.seed ?? 277) + 3 });
    merlons.translate(0, height + 0.34, side * (depth / 2 + 0.3));
    builder.add(merlons);
  }
  return builder;
}

/** A run of corbels under a projecting wall walk. */
export function corbelRun(options: { length: number; seed?: number; budget?: number; spacing?: number }): MeshBuilder {
  const builder = new MeshBuilder();
  const length = Math.max(0.6, options.length);
  const wanted = Math.max(2, Math.round(length / (options.spacing ?? 0.8)));
  const count = planRepeatedUnits(wanted, CORBEL_TRIANGLES, options.budget ?? 900, 2).modeled;
  for (let index = 0; index < count; index += 1) {
    const x = -length / 2 + (length * (index + 0.5)) / count;
    const part = corbel({});
    part.rotateX(Math.PI / 2);
    part.translate(x, -0.4, 0);
    builder.add(part);
  }
  return builder;
}

/** Re-exports so components can import everything architectural from one place. */
export { arch, box, cylinder, extrude, lathe, prism, sphere, stoneWall, stringCourse, framedPanel, planks, roofPanel, ridgeCap, crenellations, dentils, corbel, door, windowUnit, pick, range, chance };
export type { Quality };
