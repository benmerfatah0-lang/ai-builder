import type { Terrain } from '../world-plan/schema';

export interface TerrainSampler {
  /** World-space terrain height in Y units. */
  heightAt(x: number, z: number): number;
  /** 0..1 height ratio, for palette blending. */
  normalizedHeightAt(x: number, z: number): number;
  size: number;
}

function hash2(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Bilinear value noise in [-1, 1]. */
function valueNoise2D(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothstep(x - x0);
  const fy = smoothstep(y - y0);

  const n00 = hash2(seed, x0, y0);
  const n10 = hash2(seed, x0 + 1, y0);
  const n01 = hash2(seed, x0, y0 + 1);
  const n11 = hash2(seed, x0 + 1, y0 + 1);

  const top = lerp(n00, n10, fx);
  const bottom = lerp(n01, n11, fx);
  return lerp(top, bottom, fy) * 2 - 1;
}

/** Fractal brownian motion in roughly [-1, 1]. */
export function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;

  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = (seed + Math.imul(octave + 1, 0x9e3779b1)) >>> 0;
    sum += valueNoise2D(octaveSeed, x * frequency, y * frequency) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.05;
  }

  return norm > 0 ? sum / norm : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Build a pure, deterministic height function for a terrain description.
 * The same (terrain, seed) pair always yields the same world surface, which is
 * what makes generated worlds reproducible and exportable.
 */
export function createTerrainSampler(terrain: Terrain, seed: number): TerrainSampler {
  const { size, heightScale, style } = terrain;
  const half = size / 2;

  const heightAt = (x: number, z: number): number => {
    switch (style) {
      case 'flat':
        return 0;

      case 'hills': {
        const n = fbm(seed, x / 38, z / 38, 4);
        return n * heightScale * 0.62 + heightScale * 0.05;
      }

      case 'mountains': {
        const base = fbm(seed, x / 62, z / 62, 5);
        const ridge = 1 - Math.abs(base);
        const detail = fbm(seed + 991, x / 18, z / 18, 3) * 0.14;
        return Math.pow(ridge, 1.9) * heightScale * 1.15 + detail * heightScale - heightScale * 0.1;
      }

      case 'dunes': {
        const macro = fbm(seed, x / 70, z / 70, 3);
        const wave = Math.sin(x / 14 + macro * 4.2);
        const ripple = Math.sin((x + z) / 6.5 + macro * 2);
        return (
          (wave * 0.5 + 0.5) * heightScale * 0.38 +
          ripple * heightScale * 0.035 +
          macro * heightScale * 0.12
        );
      }

      case 'valley': {
        const winding = Math.sin(z / 47 + (seed % 17) * .1) * size * .08;
        const bank = smoothstep(clamp01(Math.abs(x - winding) / (size * .32)));
        const noise = fbm(seed, x / 45, z / 45, 4) * .1;
        return (bank * .9 + noise - .25) * heightScale;
      }
      case 'plateau': {
        const base = fbm(seed, x / 65, z / 65, 4);
        const level = smoothstep(clamp01((base + .25) * 2));
        return (level * .8 + fbm(seed + 91, x / 18, z / 18, 2) * .035 - .25) * heightScale;
      }
      case 'canyon': {
        const winding = Math.sin(z / 55 + (seed % 13) * .1) * size * .07;
        const distance = Math.abs(x - winding) / (size * .19);
        const walls = smoothstep(clamp01((distance - .3) * 2));
        return (walls * .9 + fbm(seed, x / 30, z / 30, 3) * .08 - .3) * heightScale;
      }
      case 'volcano': {
        const r = Math.hypot(x, z) / (size * .34);
        const mountain = Math.max(0, 1 - r);
        const crater = Math.exp(-Math.pow(r / .23, 2));
        return (mountain * .95 - crater * .6 + fbm(seed, x / 26, z / 26, 3) * .07) * heightScale;
      }
      case 'crater': {
        const r = Math.hypot(x, z) / (size * .25);
        const rim = Math.exp(-Math.pow((r - 1) / .23, 2)) * .48;
        const hollow = Math.exp(-Math.pow(r / .65, 4)) * .4;
        return (rim - hollow + fbm(seed, x / 32, z / 32, 3) * .06) * heightScale;
      }

      case 'islands': {
        const base = (fbm(seed, x / 46, z / 46, 4) + 1) / 2;
        const radial = Math.min(1, Math.sqrt(x * x + z * z) / half);
        const falloff = 1 - smoothstep(clamp01(radial * 1.12));
        return (base * 0.95 * falloff - 0.32) * heightScale;
      }

      default:
        return 0;
    }
  };

  const normalizedHeightAt = (x: number, z: number): number => {
    if (heightScale <= 0) return 0.5;
    return clamp01(0.5 + heightAt(x, z) / (heightScale * 2));
  };

  return { heightAt, normalizedHeightAt, size };
}
