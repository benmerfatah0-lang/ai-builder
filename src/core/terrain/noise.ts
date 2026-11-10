/**
 * Deterministic noise primitives for the procedural landscape engine.
 *
 * Everything here is a pure function of integer coordinates and a seed: the same
 * seed on any platform produces the same world, which is what makes generated
 * landscapes reproducible, exportable and safe to re-sample later (walking,
 * placement, regional regeneration). No external libraries, no paid services,
 * no floating-point drift between calls: only integer hashing and arithmetic.
 */

/** Stable 32-bit integer hash → [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Stable 3D hash → [0, 1), used for cave volumes. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = Math.imul(h ^ (h >>> 17), 2246822519);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smoother C2 interpolant; removes the visible grid creases of smoothstep. */
export function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Bilinear value noise in [-1, 1]. Cheap; good for masks and detail. */
export function valueNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const top = lerp(hash2(seed, x0, y0), hash2(seed, x0 + 1, y0), fx);
  const bottom = lerp(hash2(seed, x0, y0 + 1), hash2(seed, x0 + 1, y0 + 1), fx);
  return lerp(top, bottom, fy) * 2 - 1;
}

const GRADIENTS: readonly [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.70710678, 0.70710678], [-0.70710678, 0.70710678],
  [0.70710678, -0.70710678], [-0.70710678, -0.70710678],
];

function gradientAt(seed: number, x: number, y: number): [number, number] {
  const index = Math.floor(hash2(seed, x, y) * GRADIENTS.length) % GRADIENTS.length;
  return GRADIENTS[index] ?? [1, 0];
}

/**
 * Perlin-style gradient noise in roughly [-1, 1].
 *
 * Preferred over value noise for elevation: it has no axis-aligned banding, so
 * ridges, valleys and coastlines read as natural rather than as a grid.
 */
export function gradientNoise2(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const u = quintic(dx);
  const v = quintic(dy);

  const contribution = (ix: number, iy: number): number => {
    const [gx, gy] = gradientAt(seed, x0 + ix, y0 + iy);
    return gx * (dx - ix) + gy * (dy - iy);
  };

  const top = lerp(contribution(0, 0), contribution(1, 0), u);
  const bottom = lerp(contribution(0, 1), contribution(1, 1), u);
  // 1/√2 · normalisation keeps the result inside roughly [-1, 1].
  return lerp(top, bottom, v) * 1.4142135;
}

export interface FractalOptions {
  octaves?: number;
  lacunarity?: number;
  gain?: number;
  /** Shift applied per octave so octaves never align. */
  seedStep?: number;
}

/** Fractal Brownian motion over gradient noise, in roughly [-1, 1]. */
export function fbm(seed: number, x: number, y: number, options: FractalOptions = {}): number {
  const { octaves = 4, lacunarity = 2.03, gain = 0.5, seedStep = 0x9e3779b1 } = options;
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = (seed + Math.imul(octave + 1, seedStep)) >>> 0;
    sum += gradientNoise2(octaveSeed, x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal in [0, 1].
 *
 * Inverting the absolute value turns smooth hills into sharp creases, which is
 * how real mountain ranges look: long ridges with spurs and deep cols.
 */
export function ridged(seed: number, x: number, y: number, options: FractalOptions & { offset?: number; sharpness?: number } = {}): number {
  const { octaves = 5, offset = 1, sharpness = 2 } = options;
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  let weight = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = (seed + Math.imul(octave + 1, 0x85ebca6b)) >>> 0;
    let signal = offset - Math.abs(gradientNoise2(octaveSeed, x * frequency, y * frequency));
    signal *= signal;
    // Weight successive octaves by the previous one so ridges stay connected.
    signal *= weight;
    weight = clamp(signal * 2, 0, 1);
    sum += signal * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  const value = norm > 0 ? sum / norm : 0;
  return clamp01(Math.pow(value, sharpness));
}

/**
 * Domain warping: feed noise into the coordinates of other noise.
 *
 * This is what breaks up repetition and produces curved spurs, meandering
 * valleys and irregular coastlines instead of straight blobby hills.
 */
export function warped(seed: number, x: number, y: number, strength: number, octaves = 4): [number, number] {
  const qx = fbm(seed + 101, x, y, { octaves });
  const qy = fbm(seed + 202, x + 5.2, y + 1.3, { octaves });
  return [x + qx * strength, y + qy * strength];
}

export interface CellularResult {
  /** Distance to the nearest feature point, 0..~1. */
  f1: number;
  /** Distance to the second nearest, for cell borders. */
  f2: number;
  /** Coordinates of the nearest feature point, for stable cell identity. */
  cellX: number;
  cellY: number;
}

/**
 * Worley / cellular noise with jittered lattice points.
 *
 * `f1` gives rounded cells (island cores, biome regions, crater fields) and
 * `f2 - f1` gives the borders between them, which is exactly the mask used for
 * natural biome transitions and rock formations.
 */
export function cellular2(seed: number, x: number, y: number): CellularResult {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let cellX = ix;
  let cellY = iy;
  for (let ox = -1; ox <= 1; ox += 1) {
    for (let oy = -1; oy <= 1; oy += 1) {
      const cx = ix + ox;
      const cy = iy + oy;
      const jitterX = hash2(seed + 31, cx, cy);
      const jitterY = hash2(seed + 57, cx, cy);
      const px = cx + 0.5 + (jitterX - 0.5) * 0.86;
      const py = cy + 0.5 + (jitterY - 0.5) * 0.86;
      const distance = Math.hypot(px - x, py - y);
      if (distance < f1) {
        f2 = f1;
        f1 = distance;
        cellX = cx;
        cellY = cy;
      } else if (distance < f2) {
        f2 = distance;
      }
    }
  }
  return { f1, f2: Number.isFinite(f2) ? f2 : f1 + 1, cellX, cellY };
}

/** Trilinear value noise in [-1, 1] for subterranean volumes (caves). */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);
  const fz = smoothstep(z - z0);
  const plane = (dz: number): number => {
    const top = lerp(hash3(seed, x0, y0, z0 + dz), hash3(seed, x0 + 1, y0, z0 + dz), fx);
    const bottom = lerp(hash3(seed, x0, y0 + 1, z0 + dz), hash3(seed, x0 + 1, y0 + 1, z0 + dz), fx);
    return lerp(top, bottom, fy);
  };
  return lerp(plane(0), plane(1), fz) * 2 - 1;
}

/** Fractal 3D noise in [-1, 1]; two octaves is enough for cave galleries. */
export function fbm3(seed: number, x: number, y: number, z: number, octaves = 2): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise3((seed + Math.imul(octave + 1, 0x9e3779b1)) >>> 0, x * frequency, y * frequency, z * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}
