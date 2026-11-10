import { clamp, clamp01, lerp, smoothstep } from './noise';

/** A point in world XZ space. */
export type Vec2 = [number, number];

/**
 * Polyline helpers shared by ridges, valleys, canyons, rivers and roads.
 *
 * Terrain features are described as spines because that is how they appear in
 * language ("a range running north to south", "a river crossing the forest") and
 * how they behave geometrically: everything else is a cross-section profile
 * applied as a function of distance to the spine.
 */

export function polylineLength(spine: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < spine.length; i += 1) {
    total += Math.hypot(spine[i]![0] - spine[i - 1]![0], spine[i]![1] - spine[i - 1]![1]);
  }
  return total;
}

/** Point at normalised position `t` (0..1) along a polyline. */
export function pointAt(spine: Vec2[], t: number): Vec2 {
  if (spine.length === 0) return [0, 0];
  if (spine.length === 1) return [...spine[0]!] as Vec2;
  const total = polylineLength(spine);
  const target = clamp01(t) * total;
  let travelled = 0;
  for (let i = 1; i < spine.length; i += 1) {
    const a = spine[i - 1]!;
    const b = spine[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (travelled + length >= target && length > 0) {
      const local = (target - travelled) / length;
      return [lerp(a[0], b[0], local), lerp(a[1], b[1], local)];
    }
    travelled += length;
  }
  return [...spine[spine.length - 1]!] as Vec2;
}

export interface SpineProjection {
  /** Perpendicular distance to the spine, in world units. */
  distance: number;
  /** Normalised position along the spine of the closest point, 0..1. */
  t: number;
  /** The closest point itself. */
  point: Vec2;
  /** Unit tangent at the closest point, for cross-sections and meanders. */
  tangent: Vec2;
}

/** Closest point on a polyline, with the tangent needed for cross-sections. */
export function projectOntoSpine(spine: Vec2[], x: number, z: number): SpineProjection {
  if (spine.length === 0) return { distance: Math.hypot(x, z), t: 0, point: [0, 0], tangent: [1, 0] };
  if (spine.length === 1) {
    const only = spine[0]!;
    return { distance: Math.hypot(x - only[0], z - only[1]), t: 0, point: [...only] as Vec2, tangent: [1, 0] };
  }
  const total = polylineLength(spine) || 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestT = 0;
  let bestPoint: Vec2 = [...spine[0]!] as Vec2;
  let bestTangent: Vec2 = [1, 0];
  let travelled = 0;
  for (let i = 1; i < spine.length; i += 1) {
    const a = spine[i - 1]!;
    const b = spine[i]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSquared = dx * dx + dz * dz;
    const length = Math.sqrt(lengthSquared);
    const local = lengthSquared > 0 ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSquared, 0, 1) : 0;
    const px = a[0] + dx * local;
    const pz = a[1] + dz * local;
    const distance = Math.hypot(x - px, z - pz);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestT = (travelled + length * local) / total;
      bestPoint = [px, pz];
      bestTangent = length > 0 ? [dx / length, dz / length] : [1, 0];
    }
    travelled += length;
  }
  return { distance: bestDistance, t: clamp01(bestT), point: bestPoint, tangent: bestTangent };
}

/**
 * Catmull-Rom resampling of a spine.
 *
 * A description gives two or three anchor points; a natural ridge or river needs
 * a smooth curve through them. Deterministic, and never invents endpoints.
 */
export function smoothSpine(spine: Vec2[], samplesPerSegment = 8, tension = 0): Vec2[] {
  if (spine.length < 3) return spine.map((point) => [...point] as Vec2);
  const count = spine.length;
  const c = clamp(tension, 0, 1);
  const out: Vec2[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const p0 = spine[Math.max(0, i - 1)]!;
    const p1 = spine[i]!;
    const p2 = spine[i + 1]!;
    const p3 = spine[Math.min(count - 1, i + 2)]!;
    // Cardinal-spline tangents; tension 0 is Catmull-Rom, 1 is straight lines.
    const m1x = (1 - c) * (p2[0] - p0[0]) / 2;
    const m1z = (1 - c) * (p2[1] - p0[1]) / 2;
    const m2x = (1 - c) * (p3[0] - p1[0]) / 2;
    const m2z = (1 - c) * (p3[1] - p1[1]) / 2;
    for (let k = 0; k < samplesPerSegment; k += 1) {
      const t = k / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      out.push([h00 * p1[0] + h10 * m1x + h01 * p2[0] + h11 * m2x, h00 * p1[1] + h10 * m1z + h01 * p2[1] + h11 * m2z]);
    }
  }
  out.push([...spine[count - 1]!] as Vec2);
  return out;
}

/** Resamples a polyline to at most `max` evenly spaced points. */
export function resampleSpine(spine: Vec2[], max: number): Vec2[] {
  if (spine.length <= max) return spine.map((point) => [...point] as Vec2);
  const out: Vec2[] = [];
  for (let i = 0; i < max; i += 1) out.push(pointAt(spine, i / (max - 1)));
  return out;
}

/** Offsets every point sideways along the local normal, for meanders. */
export function offsetSpine(spine: Vec2[], offsetAt: (t: number) => number): Vec2[] {
  const total = polylineLength(spine) || 1;
  let travelled = 0;
  return spine.map((point, index) => {
    const next = spine[Math.min(spine.length - 1, index + 1)]!;
    const previous = spine[Math.max(0, index - 1)]!;
    const dx = next[0] - previous[0];
    const dz = next[1] - previous[1];
    const length = Math.hypot(dx, dz) || 1;
    const t = clamp01(travelled / total);
    if (index < spine.length - 1) travelled += Math.hypot(next[0] - point[0], next[1] - point[1]);
    const amount = offsetAt(t);
    // Normal is the tangent rotated 90°.
    return [point[0] + (-dz / length) * amount, point[1] + (dx / length) * amount] as Vec2;
  });
}

/** Cross-section profiles, all returning 1 at the centre and 0 at the edge. */
export function profile(distance: number, width: number, shape: 'ridge' | 'valley' | 'canyon' | 'dome' | 'bowl'): number {
  if (width <= 0) return 0;
  const t = clamp01(distance / width);
  switch (shape) {
    case 'ridge': return Math.pow(1 - smoothstep(t), 1.35);
    case 'valley': return 1 - smoothstep(t);
    case 'canyon': return Math.pow(1 - smoothstep(Math.pow(t, 0.55)), 1.6);
    case 'dome': return 1 - t * t;
    case 'bowl': return Math.pow(1 - t * t, 1.4);
  }
}
