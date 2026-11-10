import * as THREE from 'three';
import { MeshBuilder, triangulatePolygon, type Vec2, type Vec3 } from './mesh';

/**
 * Parametric solid primitives with real topology and real UVs.
 *
 * These are the vocabulary of the modeling pipeline: a barrel is a `lathe` of a
 * staved profile, a sword blade is a `sweep` of a lenticular section along a
 * tapered spine, a horse torso is a `loft` through anatomical stations, a bridge
 * is an `arch` of individual voussoirs. Nothing here is a cube dressed up as a
 * house.
 *
 * Every generator writes into material slot 0 and takes a `texel` density (world
 * units per texture tile). Components decide the material when they append a
 * part, so a 2 m wall and a 20 m curtain wall show mortar of the same size —
 * that shared texel density is what makes assets from different families look
 * like they belong to one world.
 */

export interface UvOptions {
  /** World units covered by one texture tile. Defaults to 1 m. */
  texel?: number;
  /** Multiplies the generated UVs, for atlas regions or deliberate stretch. */
  scale?: Vec2;
  offset?: Vec2;
}

const DEFAULT_TEXEL = 1;

function uvScale(options: UvOptions): Vec2 {
  const texel = Math.max(1e-3, options.texel ?? DEFAULT_TEXEL);
  const scale = options.scale ?? [1, 1];
  return [scale[0] / texel, scale[1] / texel];
}

function uvOffset(options: UvOptions): Vec2 {
  return options.offset ?? [0, 0];
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-9) return [0, 1, 0];
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export interface BoxOptions extends UvOptions {
  /** Chamfer size in world units; 0 keeps a sharp box. */
  bevel?: number;
  bevelSegments?: number;
  /** Drop a face, e.g. a floor slab that never shows its underside. */
  open?: 'bottom' | 'top';
}

/**
 * A box with optional chamfered edges.
 *
 * The bevel matters more than it sounds: a sharp 90° edge catches no light and
 * reads as cardboard, while a 2 cm chamfer gives every corner a specular line,
 * which is what makes furniture, doors and dressed stone look manufactured.
 */
export function box(width: number, height: number, depth: number, options: BoxOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const halfX = Math.max(1e-4, width) / 2;
  const halfY = Math.max(1e-4, height) / 2;
  const halfZ = Math.max(1e-4, depth) / 2;
  const bevel = Math.max(0, Math.min(options.bevel ?? 0, Math.min(halfX, halfY, halfZ) * 0.9));
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);

  if (bevel <= 1e-5) {
    // Six independent faces, each with its own UV origin so a wood grain runs
    // along the face instead of wrapping around corners.
    const faces: { normal: Vec3; corners: Vec3[]; span: Vec2; drop?: 'top' | 'bottom' }[] = [
      { normal: [0, 0, 1], corners: [[-halfX, -halfY, halfZ], [halfX, -halfY, halfZ], [halfX, halfY, halfZ], [-halfX, halfY, halfZ]], span: [width, height] },
      { normal: [0, 0, -1], corners: [[halfX, -halfY, -halfZ], [-halfX, -halfY, -halfZ], [-halfX, halfY, -halfZ], [halfX, halfY, -halfZ]], span: [width, height] },
      { normal: [1, 0, 0], corners: [[halfX, -halfY, halfZ], [halfX, -halfY, -halfZ], [halfX, halfY, -halfZ], [halfX, halfY, halfZ]], span: [depth, height] },
      { normal: [-1, 0, 0], corners: [[-halfX, -halfY, -halfZ], [-halfX, -halfY, halfZ], [-halfX, halfY, halfZ], [-halfX, halfY, -halfZ]], span: [depth, height] },
      { normal: [0, 1, 0], corners: [[-halfX, halfY, halfZ], [halfX, halfY, halfZ], [halfX, halfY, -halfZ], [-halfX, halfY, -halfZ]], span: [width, depth], drop: 'top' },
      { normal: [0, -1, 0], corners: [[-halfX, -halfY, -halfZ], [halfX, -halfY, -halfZ], [halfX, -halfY, halfZ], [-halfX, -halfY, halfZ]], span: [width, depth], drop: 'bottom' },
    ];
    for (const face of faces) {
      if (face.drop && options.open === face.drop) continue;
      const ring = face.corners.map((corner, index) => builder.vertex(
        corner,
        [ou + (index === 1 || index === 2 ? face.span[0] : 0) * su, ov + (index >= 2 ? face.span[1] : 0) * sv],
        face.normal,
      ));
      builder.quad(ring[0]!, ring[1]!, ring[2]!, ring[3]!);
    }
    return builder;
  }

  const ix = halfX - bevel;
  const iy = halfY - bevel;
  const iz = halfZ - bevel;
  const steps = Math.max(1, Math.round(options.bevelSegments ?? 2));

  const faceSpecs: { normal: Vec3; points: Vec3[]; span: Vec2; drop?: 'top' | 'bottom' }[] = [
    { normal: [0, 0, 1], points: [[-ix, -iy, halfZ], [ix, -iy, halfZ], [ix, iy, halfZ], [-ix, iy, halfZ]], span: [ix * 2, iy * 2] },
    { normal: [0, 0, -1], points: [[ix, -iy, -halfZ], [-ix, -iy, -halfZ], [-ix, iy, -halfZ], [ix, iy, -halfZ]], span: [ix * 2, iy * 2] },
    { normal: [1, 0, 0], points: [[halfX, -iy, iz], [halfX, -iy, -iz], [halfX, iy, -iz], [halfX, iy, iz]], span: [iz * 2, iy * 2] },
    { normal: [-1, 0, 0], points: [[-halfX, -iy, -iz], [-halfX, -iy, iz], [-halfX, iy, iz], [-halfX, iy, -iz]], span: [iz * 2, iy * 2] },
    { normal: [0, 1, 0], points: [[-ix, halfY, iz], [ix, halfY, iz], [ix, halfY, -iz], [-ix, halfY, -iz]], span: [ix * 2, iz * 2], drop: 'top' },
    { normal: [0, -1, 0], points: [[-ix, -halfY, -iz], [ix, -halfY, -iz], [ix, -halfY, iz], [-ix, -halfY, iz]], span: [ix * 2, iz * 2], drop: 'bottom' },
  ];
  for (const face of faceSpecs) {
    if (face.drop && options.open === face.drop) continue;
    const ring = face.points.map((point, index) => builder.vertex(
      point,
      [ou + (index === 1 || index === 2 ? face.span[0] : 0) * su, ov + (index >= 2 ? face.span[1] : 0) * sv],
      face.normal,
    ));
    builder.quad(ring[0]!, ring[1]!, ring[2]!, ring[3]!);
  }

  /**
   * Chamfer strips and corner patches are generated in a right-handed local
   * frame (U, V, W) instead of by flipping signs inside a fixed formula. Sign
   * flips are reflections, and a reflection silently reverses triangle winding:
   * half the box would render inside out. Taking W = U × V keeps every frame a
   * rotation of the canonical one, so one winding is correct everywhere.
   */
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const scaled = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
  const combine = (u: Vec3, v: Vec3, w: Vec3, cu: number, cv: number, cw: number): Vec3 => [
    u[0] * cu + v[0] * cv + w[0] * cw,
    u[1] * cu + v[1] * cv + w[1] * cw,
    u[2] * cu + v[2] * cv + w[2] * cw,
  ];
  const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
  const unit: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const inset: Record<'x' | 'y' | 'z', number> = { x: ix, y: iy, z: iz };
  const arcUv = (step: number) => ou + (step / steps) * (bevel * Math.PI) / 2 * su;

  // Twelve chamfer strips, each a quarter cylinder rolled along an edge.
  for (const axis of axes) {
    const sides = axes.filter((other) => other !== axis);
    const sideA = sides[0]!;
    const sideB = sides[1]!;
    const length = inset[axis] * 2;
    for (const sa of [1, -1]) {
      for (const sb of [1, -1]) {
        const u = scaled(unit[sideA], sa);
        const v = scaled(unit[sideB], sb);
        const w = cross(u, v);
        const centre = combine(u, v, w, inset[sideA], inset[sideB], 0);
        const near: number[] = [];
        const far: number[] = [];
        for (let step = 0; step <= steps; step += 1) {
          const phi = (step / steps) * (Math.PI / 2);
          const offset = combine(u, v, w, Math.cos(phi) * bevel, Math.sin(phi) * bevel, 0);
          const normal = normalize(offset);
          const from: Vec3 = [
            centre[0] + offset[0] - (w[0] * length) / 2,
            centre[1] + offset[1] - (w[1] * length) / 2,
            centre[2] + offset[2] - (w[2] * length) / 2,
          ];
          near.push(builder.vertex(from, [arcUv(step), ov], normal));
          far.push(builder.vertex([from[0] + w[0] * length, from[1] + w[1] * length, from[2] + w[2] * length], [arcUv(step), ov + length * sv], normal));
        }
        for (let step = 0; step < steps; step += 1) {
          builder.quad(near[step]!, near[step + 1]!, far[step + 1]!, far[step]!);
        }
      }
    }
  }

  // Eight corner patches, each an eighth of a sphere.
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        const u = scaled(unit.x, sx);
        // An odd number of negative signs is a reflection, so swap V and W to
        // recover a right-handed frame covering the same octant.
        const v = sx * sy * sz > 0 ? scaled(unit.y, sy) : scaled(unit.z, sz);
        const w = cross(u, v);
        const centre: Vec3 = [sx * ix, sy * iy, sz * iz];
        const rings: number[][] = [];
        for (let step = 0; step <= steps; step += 1) {
          const phi = (step / steps) * (Math.PI / 2);
          const ring: number[] = [];
          for (let around = 0; around <= steps; around += 1) {
            const theta = (around / steps) * (Math.PI / 2);
            const offset = combine(u, v, w, Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta));
            ring.push(builder.vertex(
              [centre[0] + offset[0] * bevel, centre[1] + offset[1] * bevel, centre[2] + offset[2] * bevel],
              [arcUv(around), arcUv(step)],
              offset,
            ));
          }
          rings.push(ring);
        }
        for (let step = 0; step < steps; step += 1) {
          // The last ring collapses onto the pole, so those quads are single
          // triangles; emitting both halves would add zero-area slivers.
          const pole = step + 1 === steps;
          for (let around = 0; around < steps; around += 1) {
            const a = rings[step]![around]!;
            const b = rings[step + 1]![around]!;
            const c = rings[step + 1]![around + 1]!;
            const d = rings[step]![around + 1]!;
            if (!pole) builder.triangle(a, b, c);
            builder.triangle(a, c, d);
          }
        }
      }
    }
  }
  return builder;
}

export interface CylinderOptions extends UvOptions {
  radialSegments?: number;
  heightSegments?: number;
  /** Cap the ends; leave open for tubes, hollow columns and pipe runs. */
  caps?: boolean | { top?: boolean; bottom?: boolean };
  /** Radial noise, for hand-thrown pots, rough logs and hammered metal. */
  wobble?: number;
  wobbleSeed?: number;
  /** Vertical noise bands, for bark and fluted stone. */
  ripple?: number;
  /** Sweep angle in radians; less than 2π gives an open shell (a barrel tile). */
  arc?: number;
}

/** Cylinder / truncated cone with a cylindrical UV unwrap. */
export function cylinder(radiusTop: number, radiusBottom: number, height: number, options: CylinderOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const radial = Math.max(3, Math.round(options.radialSegments ?? 16));
  const rows = Math.max(1, Math.round(options.heightSegments ?? 1));
  const caps = options.caps ?? true;
  const capTop = caps === true ? true : caps === false ? false : caps.top !== false;
  const capBottom = caps === true ? true : caps === false ? false : caps.bottom !== false;
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);
  const half = Math.max(1e-4, height) / 2;
  const wobble = Math.max(0, options.wobble ?? 0);
  const ripple = Math.max(0, options.ripple ?? 0);
  const seed = options.wobbleSeed ?? 1;

  const slope = (radiusBottom - radiusTop) / Math.max(1e-6, height);
  const normalY = slope / Math.sqrt(1 + slope * slope);
  const normalR = 1 / Math.sqrt(1 + slope * slope);

  const wobbleAt = (row: number, column: number, radius: number): number => {
    if (wobble <= 0 && ripple <= 0) return radius;
    const angle = (column / radial) * Math.PI * 2;
    const radialNoise = wobble > 0
      ? Math.sin(angle * 3 + row * 1.7 + seed * 12.9898) * 0.6 + Math.sin(angle * 7 - row * 2.3 + seed * 78.233) * 0.4
      : 0;
    const verticalNoise = ripple > 0 ? Math.sin(angle * 5 + seed * 3.1) * Math.cos(row * 2.4) : 0;
    return Math.max(1e-4, radius * (1 + radialNoise * wobble + verticalNoise * ripple));
  };

  const arc = Math.min(Math.PI * 2, Math.max(1e-3, options.arc ?? Math.PI * 2));
  const grid: number[][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const t = row / rows;
    const y = -half + height * t;
    const base = radiusBottom + (radiusTop - radiusBottom) * t;
    const ring: number[] = [];
    for (let column = 0; column <= radial; column += 1) {
      const angle = (column / radial) * arc;
      const radius = wobbleAt(row, column, base);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ring.push(builder.vertex(
        [cos * radius, y, sin * radius],
        // u follows arc length at the average radius, so a texture does not
        // compress on a thin neck and stretch on a wide belly.
        [ou + angle * Math.max(radiusTop, radiusBottom) * su, ov + (y + half) * sv],
        normalize([cos * normalR, normalY, sin * normalR]),
      ));
    }
    grid.push(ring);
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < radial; column += 1) {
      // Rows climb and columns turn counter-clockwise, so the outward face is
      // up-then-around, not around-then-up.
      builder.quad(grid[row]![column]!, grid[row + 1]![column]!, grid[row + 1]![column + 1]!, grid[row]![column + 1]!);
    }
  }

  const full = arc >= Math.PI * 2 - 1e-6;
  if (capTop && radiusTop > 1e-4 && full) {
    const apex = builder.vertex([0, half, 0], [ou + 0.5 * su, ov + height * sv + 0.5 * sv], [0, 1, 0]);
    const ring = grid[rows]!;
    for (let column = 0; column < radial; column += 1) builder.triangle(apex, ring[column + 1]!, ring[column]!);
  }
  if (capBottom && radiusBottom > 1e-4 && full) {
    const apex = builder.vertex([0, -half, 0], [ou + 0.5 * su, ov], [0, -1, 0]);
    const ring = grid[0]!;
    for (let column = 0; column < radial; column += 1) builder.triangle(apex, ring[column]!, ring[column + 1]!);
  }
  return builder;
}

export interface SphereOptions extends UvOptions {
  widthSegments?: number;
  heightSegments?: number;
  /** Radii per axis, for ellipsoids: animal torsos, eggs, domes, melons. */
  radii?: Vec3;
  thetaStart?: number;
  thetaLength?: number;
  /** Polar window; `phiLength: π/2` is a dome. */
  phiStart?: number;
  phiLength?: number;
}

/** UV sphere / ellipsoid / dome with correct ellipsoidal normals. */
export function sphere(radius: number, options: SphereOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const width = Math.max(3, Math.round(options.widthSegments ?? 20));
  const height = Math.max(2, Math.round(options.heightSegments ?? 14));
  const radii: Vec3 = options.radii ?? [radius, radius, radius];
  const thetaStart = options.thetaStart ?? 0;
  const thetaLength = Math.max(1e-3, options.thetaLength ?? Math.PI * 2);
  const phiStart = options.phiStart ?? 0;
  const phiLength = Math.max(1e-3, options.phiLength ?? Math.PI);
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);
  const average = (radii[0] + radii[1] + radii[2]) / 3;

  const grid: number[][] = [];
  for (let row = 0; row <= height; row += 1) {
    const phi = phiStart + (row / height) * phiLength;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const ring: number[] = [];
    for (let column = 0; column <= width; column += 1) {
      const theta = thetaStart + (column / width) * thetaLength;
      const x = sinPhi * Math.cos(theta);
      const y = cosPhi;
      const z = sinPhi * Math.sin(theta);
      // The normal of an ellipsoid is its gradient, not its position vector.
      const normal = normalize([x / Math.max(1e-6, radii[0]), y / Math.max(1e-6, radii[1]), z / Math.max(1e-6, radii[2])]);
      ring.push(builder.vertex(
        [x * radii[0], y * radii[1], z * radii[2]],
        [ou + (column / width) * thetaLength * average * su, ov + (row / height) * phiLength * average * sv],
        normal,
      ));
    }
    grid.push(ring);
  }
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const a = grid[row]![column]!;
      const b = grid[row]![column + 1]!;
      const c = grid[row + 1]![column + 1]!;
      const d = grid[row + 1]![column]!;
      // Pole rows are a single triangle, not two slivers sharing an edge.
      if (row !== 0 || phiStart > 1e-6) builder.triangle(a, b, d);
      if (row !== height - 1 || phiStart + phiLength < Math.PI - 1e-6) builder.triangle(b, c, d);
    }
  }
  return builder;
}

export interface LatheOptions extends UvOptions {
  segments?: number;
  /** Sweep angle; less than 2π leaves an open wedge (a hood, a scallop). */
  angle?: number;
  caps?: boolean;
  twist?: number;
}

/**
 * Surface of revolution from a profile of `(radius, height)` points.
 *
 * The workhorse for turned and thrown objects: barrels with a bilge, columns
 * with entasis, vases, urns, bottles, wheels, tower drums, domes, goblets and
 * cannon barrels. The profile carries the design; `segments` carries smoothness.
 */
export function lathe(profile: readonly Vec2[], options: LatheOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const points = profile.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length < 2) return builder;
  const segments = Math.max(3, Math.round(options.segments ?? 20));
  const angle = Math.min(Math.PI * 2, Math.max(1e-3, options.angle ?? Math.PI * 2));
  const caps = options.caps ?? false;
  const twist = options.twist ?? 0;
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);

  // Arc length along the profile, so a texture does not stretch across a
  // sharply curved neck.
  const lengths: number[] = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    total += Math.hypot(current[0] - previous[0], current[1] - previous[1]);
    lengths.push(total);
  }
  // Always one column more than segments: on a full revolution the last column
  // duplicates the first position but carries u = one full circumference, so the
  // seam quad keeps its texture instead of wrapping backwards.
  const columns = segments + 1;
  const reference = Math.max(...points.map((point) => Math.abs(point[0])), 1e-3);

  const grid: number[][] = [];
  for (let column = 0; column < columns; column += 1) {
    const theta = (column / segments) * angle + (twist * column) / segments;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const ring: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const radius = Math.max(0, points[index]![0]);
      const y = points[index]![1];
      const before = points[Math.max(0, index - 1)]!;
      const after = points[Math.min(points.length - 1, index + 1)]!;
      const dr = after[0] - before[0];
      const dy = after[1] - before[1];
      const tangent = Math.hypot(dr, dy) || 1;
      // Rotating the profile tangent by 90° gives the surface normal.
      const normal = normalize([cos * (dy / tangent), -(dr / tangent), sin * (dy / tangent)]);
      ring.push(builder.vertex(
        [cos * radius, y, sin * radius],
        [ou + (column / segments) * angle * reference * su, ov + lengths[index]! * sv],
        normal,
      ));
    }
    grid.push(ring);
  }

  for (let column = 0; column < segments; column += 1) {
    const next = column + 1;
    for (let index = 0; index + 1 < points.length; index += 1) {
      // A radius of zero on both sides is the axis itself: no surface there.
      // A profile point on the axis collapses one edge of the quad; emitting the
      // whole quad would add a zero-area triangle that shades as a dark speck.
      const a = grid[column]![index]!;
      const b = grid[column]![index + 1]!;
      const c = grid[next]![index + 1]!;
      const d = grid[next]![index]!;
      if (points[index]![0] <= 1e-5 && points[index + 1]![0] <= 1e-5) continue;
      if (points[index + 1]![0] > 1e-5) builder.triangle(a, b, c);
      if (points[index]![0] > 1e-5) builder.triangle(a, c, d);
    }
  }

  if (caps) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first[0] > 1e-5) {
      const apex = builder.vertex([0, first[1], 0], [ou + 0.5 * reference * su, ov], [0, -1, 0]);
      for (let column = 0; column < segments; column += 1) {
        builder.triangle(apex, grid[column]![0]!, grid[column + 1]![0]!);
      }
    }
    if (last[0] > 1e-5) {
      const apex = builder.vertex([0, last[1], 0], [ou + 0.5 * reference * su, ov + total * sv], [0, 1, 0]);
      for (let column = 0; column < segments; column += 1) {
        const top = points.length - 1;
        builder.triangle(apex, grid[column + 1]![top]!, grid[column]![top]!);
      }
    }
  }
  return builder;
}

export interface ExtrudeOptions extends UvOptions {
  /** Extrusion distance along +Z of the profile plane. */
  depth: number;
  /** Inward bevel at both ends, in world units. */
  bevel?: number;
  bevelSegments?: number;
  caps?: boolean;
  /** Rotates successive slices: spiral stairs, twisted columns, drills. */
  twist?: number;
  /** Scales successive slices about the centroid: obelisks, spires, funnels. */
  taper?: number;
  /** Bends the extrusion into an arc of `bend` radians: curved beams, scimitars. */
  bend?: number;
  slices?: number;
}

/**
 * Extrudes a closed 2D profile (in the XY plane) along +Z.
 *
 * Caps are triangulated by ear clipping, so L-shaped wall plans, star-shaped
 * bosses and crescent blades close correctly instead of folding over themselves.
 * With `slices`, `twist`, `taper` and `bend` one call also makes spiral stairs,
 * tapered obelisks and curved blades.
 */
export function extrude(profile: readonly Vec2[], options: ExtrudeOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const points = profile.filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length < 3) return builder;
  const depth = Math.max(1e-4, options.depth);
  const slices = Math.max(1, Math.round(options.slices ?? 1));
  const twist = options.twist ?? 0;
  const taper = options.taper ?? 0;
  const bend = options.bend ?? 0;
  const caps = options.caps ?? true;
  const bevel = Math.max(0, options.bevel ?? 0);
  const bevelSteps = bevel > 1e-5 ? Math.max(1, Math.round(options.bevelSegments ?? 1)) : 0;
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);

  const centroid: Vec2 = [0, 0];
  for (const point of points) {
    centroid[0] += point[0] / points.length;
    centroid[1] += point[1] / points.length;
  }
  // Smallest distance from the centroid to the outline bounds how far a bevel
  // can inset before the profile turns inside out.
  const inradius = Math.max(1e-4, Math.min(...points.map((point) => Math.hypot(point[0] - centroid[0], point[1] - centroid[1]))));
  const inset = Math.min(bevel, inradius * 0.8);

  const perimeter: number[] = [0];
  let total = 0;
  for (let index = 1; index <= points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index % points.length]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    perimeter.push(total);
  }

  const stations = slices + 1 + bevelSteps * 2;
  const rings: number[][] = [];
  const bevelFraction = inset / depth;
  for (let station = 0; station < stations; station += 1) {
    // Bevel stations crowd at both ends; the rest span the depth evenly.
    let t: number;
    let shrink = 1;
    if (bevelSteps > 0 && station < bevelSteps) {
      const step = station / bevelSteps;
      t = step * bevelFraction;
      shrink = 1 - (1 - step) * (inset / inradius) * 0.5;
    } else if (bevelSteps > 0 && station >= stations - bevelSteps) {
      const fromEnd = stations - 1 - station;
      const step = fromEnd / bevelSteps;
      t = 1 - step * bevelFraction;
      shrink = 1 - (1 - step) * (inset / inradius) * 0.5;
    } else {
      const middle = station - bevelSteps;
      const usable = 1 - bevelFraction * 2;
      t = bevelFraction + (middle / Math.max(1, slices)) * usable;
    }
    t = Math.min(1, Math.max(0, t));
    shrink *= 1 - taper * t;
    const angle = twist * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const bendRadius = Math.abs(bend) > 1e-6 ? depth / bend : Infinity;
    const ring: number[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const localX = (points[index]![0] - centroid[0]) * shrink;
      const localY = (points[index]![1] - centroid[1]) * shrink;
      const px = centroid[0] + localX * cos - localY * sin;
      const pyFlat = centroid[1] + localX * sin + localY * cos;
      const bendAngle = bend * t;
      const py = Number.isFinite(bendRadius) ? pyFlat + bendRadius * (1 - Math.cos(bendAngle)) : pyFlat;
      const pz = Number.isFinite(bendRadius) ? bendRadius * Math.sin(bendAngle) : t * depth;
      ring.push(builder.vertex([px, py, pz], [ou + perimeter[index]! * su, ov + t * depth * sv], [0, 0, 1]));
    }
    rings.push(ring);
  }

  for (let station = 0; station + 1 < rings.length; station += 1) {
    const current = rings[station]!;
    const next = rings[station + 1]!;
    for (let index = 0; index < points.length; index += 1) {
      const following = (index + 1) % points.length;
      builder.quad(current[index]!, current[following]!, next[following]!, next[index]!);
    }
  }

  if (caps) {
    const triangles = triangulatePolygon(points);
    const bottom = rings[0]!;
    const top = rings[rings.length - 1]!;
    // Cap UVs are planar in profile space, so a grain or a masonry pattern runs
    // continuously across the whole face instead of restarting per triangle.
    const planar: number[][] = [[], []];
    points.forEach((point, index) => {
      const uv: Vec2 = [ou + (point[0] - centroid[0]) * su, ov + (point[1] - centroid[1]) * sv];
      builder.setUv(bottom[index]!, uv);
      builder.setUv(top[index]!, uv);
      planar[0]!.push(index);
      planar[1]!.push(index);
    });
    for (let index = 0; index + 2 < triangles.length; index += 3) {
      const a = triangles[index]!;
      const b = triangles[index + 1]!;
      const c = triangles[index + 2]!;
      // The bottom cap faces -Z, so its winding is reversed.
      builder.triangle(bottom[c]!, bottom[b]!, bottom[a]!);
      builder.triangle(top[a]!, top[b]!, top[c]!);
    }
  }

  builder.computeNormals();
  return builder;
}

export interface Frame {
  position: Vec3;
  /** Unit tangent along the spine. */
  tangent: Vec3;
  /** Unit vector transported along the spine without twisting. */
  normal: Vec3;
  binormal: Vec3;
}

/**
 * Rotation-minimising frames along a polyline (parallel transport).
 *
 * A fixed "up" reference spins wildly wherever the spine turns back on itself,
 * which is exactly what a branch, a horn, a tail or a rope does. Carrying the
 * previous frame forward keeps the cross-section oriented continuously.
 */
export function spineFrames(spine: readonly Vec3[]): Frame[] {
  const frames: Frame[] = [];
  if (spine.length === 0) return frames;
  if (spine.length === 1) {
    frames.push({ position: [...spine[0]!], tangent: [0, 1, 0], normal: [1, 0, 0], binormal: [0, 0, 1] });
    return frames;
  }
  const tangentAt = (index: number): THREE.Vector3 => {
    const previous = spine[Math.max(0, index - 1)]!;
    const next = spine[Math.min(spine.length - 1, index + 1)]!;
    const tangent = new THREE.Vector3(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]);
    if (tangent.lengthSq() < 1e-12) tangent.set(0, 1, 0);
    return tangent.normalize();
  };
  const first = tangentAt(0);
  // Seed with the axis least aligned with the tangent to avoid a null cross.
  const seedAxis = Math.abs(first.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  let normal = new THREE.Vector3().crossVectors(first, seedAxis).normalize();
  if (normal.lengthSq() < 1e-9) normal.set(1, 0, 0);
  for (let index = 0; index < spine.length; index += 1) {
    const tangent = tangentAt(index);
    if (index > 0) {
      const previousTangent = new THREE.Vector3(...frames[index - 1]!.tangent);
      const carried = new THREE.Vector3(...frames[index - 1]!.normal);
      const axis = new THREE.Vector3().crossVectors(previousTangent, tangent);
      const sine = axis.length();
      if (sine > 1e-9) {
        axis.multiplyScalar(1 / sine);
        const cosine = Math.max(-1, Math.min(1, previousTangent.dot(tangent)));
        carried.applyAxisAngle(axis, Math.atan2(sine, cosine));
      }
      // Re-orthogonalising every step stops rounding error from accumulating.
      carried.addScaledVector(tangent, -carried.dot(tangent));
      normal = carried.lengthSq() < 1e-9 ? new THREE.Vector3(1, 0, 0) : carried.normalize();
    }
    const binormal = new THREE.Vector3().crossVectors(tangent, normal).normalize();
    frames.push({
      position: [...spine[index]!] as Vec3,
      tangent: tangent.toArray() as Vec3,
      normal: normal.toArray() as Vec3,
      binormal: binormal.toArray() as Vec3,
    });
  }
  return frames;
}

export interface SweepOptions extends UvOptions {
  /** Section profile in local (binormal, normal) space, given the station t. */
  section: (t: number, frame: Frame) => Vec2[];
  caps?: boolean;
  /** Intermediate stations per segment, by Catmull-Rom resampling. */
  resample?: number;
  twist?: number;
}

/**
 * Sweeps a varying cross-section along a 3D spine.
 *
 * Curved branches, spiral horns, ropes, tails, keels, scimitar blades and the
 * necks of animals are all one call away.
 */
export function sweep(spine: readonly Vec3[], options: SweepOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const points = resampleSpine(spine, options.resample ?? 0);
  if (points.length < 2) return builder;
  const frames = spineFrames(points);
  const caps = options.caps ?? true;
  const twist = options.twist ?? 0;
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);

  const distances: number[] = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    distances.push(total);
  }

  const rings: number[][] = [];
  let sectionSize = 0;
  frames.forEach((frame, index) => {
    const t = index / Math.max(1, frames.length - 1);
    const section = options.section(t, frame);
    if (section.length < 3) return;
    if (sectionSize === 0) sectionSize = section.length;
    if (section.length !== sectionSize) return;
    const angle = twist * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const around = perimeterOf(section);
    const ring = section.map((point, pointIndex) => {
      const localX = point[0] * cos - point[1] * sin;
      const localY = point[0] * sin + point[1] * cos;
      return builder.vertex(
        [
          frame.position[0] + frame.binormal[0] * localX + frame.normal[0] * localY,
          frame.position[1] + frame.binormal[1] * localX + frame.normal[1] * localY,
          frame.position[2] + frame.binormal[2] * localX + frame.normal[2] * localY,
        ],
        [ou + (pointIndex / section.length) * around * su, ov + distances[index]! * sv],
        frame.tangent,
      );
    });
    rings.push(ring);
  });
  if (rings.length < 2) return builder;

  for (let index = 0; index + 1 < rings.length; index += 1) {
    const current = rings[index]!;
    const next = rings[index + 1]!;
    for (let point = 0; point < sectionSize; point += 1) {
      const following = (point + 1) % sectionSize;
      // Along the spine first, then around the section: `binormal = tangent ×
      // normal` makes that order face outward for every transported frame.
      builder.quad(current[point]!, next[point]!, next[following]!, current[following]!);
    }
  }
  if (caps) {
    // The wall walks each ring forwards at the start and backwards at the end,
    // so the two caps fan in opposite directions.
    capRing(builder, rings[0]!, frames[0]!, false);
    capRing(builder, rings[rings.length - 1]!, frames[frames.length - 1]!, true);
  }
  builder.computeNormals();
  return builder;
}

function capRing(builder: MeshBuilder, ring: readonly number[], frame: Frame, flip: boolean): void {
  const apex = builder.vertex(frame.position, [0.5, 0.5], frame.tangent);
  // The fan has to close the loop: dropping the last spoke would leave a hole
  // wide enough to see through the model.
  for (let index = 0; index < ring.length; index += 1) {
    const following = ring[(index + 1) % ring.length]!;
    if (flip) builder.triangle(apex, following, ring[index]!);
    else builder.triangle(apex, ring[index]!, following);
  }
}

function perimeterOf(section: readonly Vec2[]): number {
  let total = 0;
  for (let index = 0; index < section.length; index += 1) {
    const a = section[index]!;
    const b = section[(index + 1) % section.length]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

/** Catmull-Rom resampling, so a four-point spine bends smoothly instead of kinking. */
export function resampleSpine(spine: readonly Vec3[], extraPerSegment: number): Vec3[] {
  if (extraPerSegment <= 0 || spine.length < 3) return spine.map((point) => [...point] as Vec3);
  const out: Vec3[] = [];
  const at = (index: number): Vec3 => spine[Math.max(0, Math.min(spine.length - 1, index))]!;
  for (let index = 0; index + 1 < spine.length; index += 1) {
    const p0 = at(index - 1);
    const p1 = at(index);
    const p2 = at(index + 1);
    const p3 = at(index + 2);
    const steps = extraPerSegment + 1;
    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const point: Vec3 = [0, 0, 0];
      for (let axis = 0; axis < 3; axis += 1) {
        point[axis] = 0.5 * (
          2 * p1[axis]! +
          (-p0[axis]! + p2[axis]!) * t +
          (2 * p0[axis]! - 5 * p1[axis]! + 4 * p2[axis]! - p3[axis]!) * t2 +
          (-p0[axis]! + 3 * p1[axis]! - 3 * p2[axis]! + p3[axis]!) * t3
        );
      }
      out.push(point);
    }
  }
  out.push([...spine[spine.length - 1]!] as Vec3);
  return out;
}

export interface LoftStation {
  position: Vec3;
  /** Closed section profile in local (binormal, normal) space. */
  profile: Vec2[];
  /** Roll about the spine, in radians. */
  roll?: number;
  scale?: number;
}

export interface LoftOptions extends UvOptions {
  caps?: boolean;
}

/**
 * Lofts a skin through a sequence of oriented cross-sections.
 *
 * This is how hulls, torsos, trunks with a root flare, wagon beds, bottle
 * bodies and animal necks are modeled: each station authors its own silhouette
 * instead of approximating it with scaled spheres.
 */
export function loft(stations: readonly LoftStation[], options: LoftOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const usable = stations.filter((station) => station.profile.length >= 3);
  if (usable.length < 2) return builder;
  const frames = spineFrames(usable.map((station) => station.position));
  const caps = options.caps ?? true;
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);

  const distances: number[] = [0];
  let total = 0;
  for (let index = 1; index < usable.length; index += 1) {
    const a = usable[index - 1]!.position;
    const b = usable[index]!.position;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    distances.push(total);
  }

  // Every station is resampled to the same count so the skin stitches without
  // degenerate triangles where one profile gains detail.
  const pointCount = Math.max(...usable.map((station) => station.profile.length));
  const rings: number[][] = [];
  usable.forEach((station, index) => {
    const frame = frames[index]!;
    const resampled = resampleClosed(station.profile, pointCount);
    const scale = station.scale ?? 1;
    const roll = station.roll ?? 0;
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const around = perimeterOf(resampled) * scale;
    rings.push(resampled.map((point, pointIndex) => {
      const localX = (point[0] * cos - point[1] * sin) * scale;
      const localY = (point[0] * sin + point[1] * cos) * scale;
      return builder.vertex(
        [
          frame.position[0] + frame.binormal[0] * localX + frame.normal[0] * localY,
          frame.position[1] + frame.binormal[1] * localX + frame.normal[1] * localY,
          frame.position[2] + frame.binormal[2] * localX + frame.normal[2] * localY,
        ],
        [ou + (pointIndex / pointCount) * around * su, ov + distances[index]! * sv],
        frame.tangent,
      );
    }));
  });

  for (let index = 0; index + 1 < rings.length; index += 1) {
    const current = rings[index]!;
    const next = rings[index + 1]!;
    for (let point = 0; point < pointCount; point += 1) {
      const following = (point + 1) % pointCount;
      builder.quad(current[point]!, next[point]!, next[following]!, current[following]!);
    }
  }
  if (caps) {
    capRing(builder, rings[0]!, frames[0]!, false);
    capRing(builder, rings[rings.length - 1]!, frames[frames.length - 1]!, true);
  }
  builder.computeNormals();
  return builder;
}

/** Evenly resamples a closed profile to exactly `count` points. */
export function resampleClosed(profile: readonly Vec2[], count: number): Vec2[] {
  if (profile.length === count) return [...profile];
  if (profile.length < 2 || count < 3) return [...profile];
  const lengths: number[] = [0];
  let total = 0;
  for (let index = 1; index <= profile.length; index += 1) {
    const a = profile[index - 1]!;
    const b = profile[index % profile.length]!;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(total);
  }
  if (total <= 1e-9) return Array.from({ length: count }, () => [...profile[0]!] as Vec2);
  const out: Vec2[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const target = (index / count) * total;
    while (cursor + 1 < lengths.length - 1 && lengths[cursor + 1]! < target) cursor += 1;
    const segmentLength = lengths[cursor + 1]! - lengths[cursor]!;
    const t = segmentLength > 1e-9 ? (target - lengths[cursor]!) / segmentLength : 0;
    const a = profile[cursor % profile.length]!;
    const b = profile[(cursor + 1) % profile.length]!;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

export interface TorusOptions extends UvOptions {
  radialSegments?: number;
  tubularSegments?: number;
  arc?: number;
}

/** Torus / ring / hoop: barrel bands, handles, halos, wheel rims, chain links. */
export function torus(radius: number, tube: number, options: TorusOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const radial = Math.max(3, Math.round(options.radialSegments ?? 10));
  const tubular = Math.max(3, Math.round(options.tubularSegments ?? 24));
  const arc = Math.min(Math.PI * 2, Math.max(1e-3, options.arc ?? Math.PI * 2));
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);
  const grid: number[][] = [];
  for (let index = 0; index <= tubular; index += 1) {
    const u = (index / tubular) * arc;
    const cosU = Math.cos(u);
    const sinU = Math.sin(u);
    const ring: number[] = [];
    for (let side = 0; side <= radial; side += 1) {
      const v = (side / radial) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);
      ring.push(builder.vertex(
        [(radius + tube * cosV) * cosU, tube * sinV, (radius + tube * cosV) * sinU],
        [ou + u * radius * su, ov + v * tube * sv],
        normalize([cosV * cosU, sinV, cosV * sinU]),
      ));
    }
    grid.push(ring);
  }
  for (let index = 0; index < tubular; index += 1) {
    for (let side = 0; side < radial; side += 1) {
      builder.quad(grid[index]![side]!, grid[index]![side + 1]!, grid[index + 1]![side + 1]!, grid[index + 1]![side]!);
    }
  }
  return builder;
}

export type ArchStyle = 'round' | 'segmental' | 'pointed' | 'flat';

export interface ArchOptions extends UvOptions {
  /** Clear span between the springing points. */
  span: number;
  /** Rise of the intrados above the springing line. */
  rise: number;
  /** Voussoir depth: distance from intrados to extrados. */
  thickness: number;
  /** Width of the arch into the screen. */
  depth: number;
  segments?: number;
  /** Emit each voussoir as its own solid, with a hairline bed joint. */
  voussoirs?: boolean;
  style?: ArchStyle;
}

/**
 * Arches: round, segmental, pointed (gothic) and flat lintels.
 *
 * With `voussoirs` each wedge is a separate solid, which is what a stone bridge
 * or a castle gate actually is — and what makes mortar lines fall where the
 * geometry says they should.
 */
export function arch(options: ArchOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const span = Math.max(0.2, options.span);
  const thickness = Math.max(0.05, options.thickness);
  const depth = Math.max(0.05, options.depth);
  const segments = Math.max(4, Math.round(options.segments ?? 24));
  const style = options.style ?? 'round';
  const half = span / 2;

  /**
   * Intrados point at parameter t ∈ [0,1] plus its unit outward normal, so the
   * extrados is a constant offset rather than a scaled copy (scaling would make
   * the haunches thicker than the crown, which no mason ever built).
   */
  const intrados = (t: number): { point: Vec2; normal: Vec2 } => {
    if (style === 'flat') {
      return { point: [-half + span * t, Math.max(0.05, options.rise)], normal: [0, 1] };
    }
    if (style === 'pointed') {
      // Two arcs of one radius meeting at a crown. Each arc's centre sits on the
      // springing line at ±c; requiring it to pass through both the near springing
      // and the crown gives c = (rise² − half²) / (2·half) and R = half + c. A
      // rise below half would make the arc bulge past the crown instead of
      // meeting it, so the construction is raised to a semicircular minimum —
      // which is what a pointed arch is anyway. Use 'segmental' for a flat arch.
      const rise = Math.max(0.05, options.rise, half);
      const c = (rise * rise - half * half) / (2 * half);
      const radius = half + c;
      const crown = Math.atan2(rise, -c);
      // t ∈ [0, ½] walks the left arc from its springing to the crown; the right
      // half is its mirror.
      const u = Math.min(t, 1 - t) * 2;
      const phi = Math.PI + (crown - Math.PI) * u;
      const sign = t <= 0.5 ? 1 : -1;
      // At the crown the two arcs meet at an angle, so a plain normal offset
      // would leave a notch. Lengthening the offset to R/rise mitres the joint
      // and the extrados comes to a point exactly above the intrados point.
      if (Math.abs(t - 0.5) < 1e-9) return { point: [0, rise] as Vec2, normal: [0, radius / rise] as Vec2 };
      return {
        point: [sign * (c + Math.cos(phi) * radius), Math.sin(phi) * radius],
        normal: [sign * Math.cos(phi), Math.sin(phi)],
      };
    }
    // Round and segmental arcs share one construction: a circle of radius R
    // centred below (segmental) or on (round) the springing line.
    const rise = Math.max(0.05, Math.min(options.rise, style === 'round' ? half : half * 0.98));
    const radius = style === 'round' ? half : (half * half + rise * rise) / (2 * rise);
    const centreY = style === 'round' ? 0 : rise - radius;
    const sweep = Math.asin(Math.max(-1, Math.min(1, half / radius)));
    const phi = -sweep + t * sweep * 2;
    const normal: Vec2 = [Math.sin(phi), Math.cos(phi)];
    return { point: [Math.sin(phi) * radius, centreY + Math.cos(phi) * radius], normal };
  };

  /**
   * The band between intrados and extrados over a parameter range is a closed
   * planar polygon, so the whole solid — cheeks, soffit, back and joints — comes
   * from one extrusion with planar cap UVs. That is what makes a mortar texture
   * line up with the stones on the arch face.
   */
  const band = (from: number, to: number): Vec2[] => {
    const steps = Math.max(2, Math.round(segments * (to - from)));
    const parameters: number[] = [];
    for (let step = 0; step <= steps; step += 1) parameters.push(from + ((to - from) * step) / steps);
    // A pointed crown is only a point if it is sampled; insert it when the band
    // straddles the middle.
    if (
      style === 'pointed' &&
      from < 0.5 - 1e-9 && to > 0.5 + 1e-9 &&
      !parameters.some((value) => Math.abs(value - 0.5) < 1e-9)
    ) {
      const at = parameters.findIndex((value) => value > 0.5);
      parameters.splice(at < 0 ? parameters.length : at, 0, 0.5);
    }
    const inner: Vec2[] = [];
    const outer: Vec2[] = [];
    for (const parameter of parameters) {
      const at = intrados(parameter);
      inner.push(at.point);
      outer.push([at.point[0] + at.normal[0] * thickness, at.point[1] + at.normal[1] * thickness]);
    }
    return [...inner, ...outer.reverse()];
  };

  if (options.voussoirs) {
    // An odd count puts a whole keystone on the crown, which is how an arch is
    // actually built and what makes the two halves read as voussoirs.
    const wanted = Math.max(3, Math.round(segments / 3));
    const count = wanted % 2 === 0 ? wanted + 1 : wanted;
    for (let index = 0; index < count; index += 1) {
      // A hairline gap reads as a bed joint even without a mortar texture.
      const pad = 0.008;
      builder.add(extrude(band(index / count + pad, (index + 1) / count - pad), { ...options, depth }));
    }
  } else {
    builder.add(extrude(band(0, 1), { ...options, depth }));
  }
  return builder;
}

export interface PrismOptions extends UvOptions {
  sides: number;
  radius: number;
  height: number;
  /** 0 = pyramid, 1 = prism; in between = a tapered tower or an obelisk. */
  topScale?: number;
  caps?: boolean;
}

/** Regular prism / pyramid: towers, spires, obelisks, crystals, nuts. */
export function prism(options: PrismOptions): MeshBuilder {
  const builder = new MeshBuilder();
  const sides = Math.max(3, Math.round(options.sides));
  const height = Math.max(1e-4, options.height);
  const radius = Math.max(1e-4, options.radius);
  const topScale = Math.max(0, options.topScale ?? 1);
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);
  const edge = 2 * radius * Math.sin(Math.PI / sides);

  const profile: Vec2[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (index / sides) * Math.PI * 2;
    profile.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  const slope = (radius - radius * topScale) / height;
  const normalY = slope / Math.sqrt(1 + slope * slope);
  const normalR = 1 / Math.sqrt(1 + slope * slope);

  const pointed = topScale <= 1e-4;
  const bottom: number[] = [];
  const top: number[] = [];
  for (let index = 0; index < sides; index += 1) {
    const point = profile[index]!;
    const next = profile[(index + 1) % sides]!;
    // Each side gets its own UV origin so a stone course reads across the face.
    const u = ou;
    const v = ov;
    const midNormal = normalize([(point[0] + next[0]) / 2, 0, (point[1] + next[1]) / 2]);
    const sideNormal: Vec3 = [midNormal[0] * normalR, normalY, midNormal[2] * normalR];
    const start = builder.vertex([point[0], 0, point[1]], [u, v], sideNormal);
    const following = builder.vertex([next[0], 0, next[1]], [u + edge * su, v], sideNormal);
    bottom.push(start);
    if (pointed) {
      // A pyramid shares one apex vertex per side; a collapsed ring would emit
      // zero-area triangles.
      const apex = builder.vertex([0, height, 0], [u + edge * su * 0.5, v + height * sv], sideNormal);
      top.push(apex);
      builder.triangle(start, apex, following);
      continue;
    }
    const startTop = builder.vertex([point[0] * topScale, height, point[1] * topScale], [u, v + height * sv], sideNormal);
    const followingTop = builder.vertex([next[0] * topScale, height, next[1] * topScale], [u + edge * su * topScale, v + height * sv], sideNormal);
    top.push(startTop);
    builder.quad(start, startTop, followingTop, following);
  }
  if (options.caps !== false) {
    // Caps get their own vertices: reusing the wall ring would make them inherit
    // the sloped side normals and shade as a dimple.
    const capRing = (y: number, scaleAt: number, normal: Vec3): number[] => profile.map((point) => builder.vertex(
      [point[0] * scaleAt, y, point[1] * scaleAt],
      [ou + point[0] * su, ov + point[1] * sv],
      normal,
    ));
    // The profile is a closed loop, so the fan needs `sides` triangles, not the
    // `sides - 1` an open fan would emit.
    const cap = (ring: number[], apex: number, flip: boolean) => {
      for (let index = 0; index < ring.length; index += 1) {
        const following = ring[(index + 1) % ring.length]!;
        if (flip) builder.triangle(apex, following, ring[index]!);
        else builder.triangle(apex, ring[index]!, following);
      }
    };
    if (!pointed) {
      cap(capRing(height, topScale, [0, 1, 0]), builder.vertex([0, height, 0], [ou, ov], [0, 1, 0]), true);
    }
    cap(capRing(0, 1, [0, -1, 0]), builder.vertex([0, 0, 0], [ou, ov], [0, -1, 0]), false);
  }
  return builder;
}

export interface PlaneOptions extends UvOptions {
  widthSegments?: number;
  heightSegments?: number;
  /** Displaces the plane by `height(x, z)`: cloth, water, tarps, sails, ground. */
  height?: (x: number, z: number) => number;
  /** 'xz' lies flat (default), 'xy' stands up like a wall or a sail. */
  orientation?: 'xz' | 'xy';
}

/** A subdivided plane that can carry a height field — sails, cloth, water, turf. */
export function plane(width: number, depth: number, options: PlaneOptions = {}): MeshBuilder {
  const builder = new MeshBuilder();
  const columns = Math.max(1, Math.round(options.widthSegments ?? 1));
  const rows = Math.max(1, Math.round(options.heightSegments ?? 1));
  const [su, sv] = uvScale(options);
  const [ou, ov] = uvOffset(options);
  const standing = options.orientation === 'xy';
  const grid: number[][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const ring: number[] = [];
    for (let column = 0; column <= columns; column += 1) {
      const x = -width / 2 + (column / columns) * width;
      const z = -depth / 2 + (row / rows) * depth;
      const lift = options.height ? options.height(x, standing ? z : z) : 0;
      const position: Vec3 = standing ? [x, z + lift, 0] : [x, lift, z];
      ring.push(builder.vertex(position, [ou + (x + width / 2) * su, ov + (standing ? z + depth / 2 : z + depth / 2) * sv], standing ? [0, 0, 1] : [0, 1, 0]));
    }
    grid.push(ring);
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = grid[row]![column]!;
      const b = grid[row]![column + 1]!;
      const c = grid[row + 1]![column + 1]!;
      const d = grid[row + 1]![column]!;
      if (standing) builder.quad(a, d, c, b);
      else builder.quad(a, b, c, d);
    }
  }
  if (options.height) builder.computeNormals();
  return builder;
}
