import { clamp, clamp01, lerp } from './noise';

/**
 * A square elevation grid — the working surface of the landscape engine.
 *
 * Every feature (ranges, canyons, volcanoes, erosion, rivers) is applied to this
 * grid once, and the renderer, the samplers, the placement code and the walk
 * navigation all read the *same* baked result through bilinear interpolation.
 * Baking once and sampling cheaply is what makes large, complex maps affordable:
 * a 512-unit world at 256 cells costs ~66k floats and every later query is a
 * handful of arithmetic operations.
 *
 * Coordinates: world space is centred on the origin, X/Z in [-size/2, size/2],
 * Y up. Grid indices run 0..cells inclusive, so a cell edge always has a sample.
 */
export class Heightfield {
  readonly size: number;
  readonly cells: number;
  readonly step: number;
  readonly data: Float32Array;
  readonly half: number;
  readonly side: number;

  constructor(size: number, cells: number, initial = 0) {
    this.size = Math.max(1, size);
    this.cells = Math.max(2, Math.round(cells));
    this.half = this.size / 2;
    this.side = this.cells + 1;
    this.step = this.size / this.cells;
    this.data = new Float32Array(this.side * this.side);
    if (initial !== 0) this.data.fill(initial);
  }

  index(ix: number, iz: number): number {
    return iz * this.side + ix;
  }

  /** Grid value with index clamping, so neighbours at the border stay defined. */
  at(ix: number, iz: number): number {
    const x = clamp(ix, 0, this.cells);
    const z = clamp(iz, 0, this.cells);
    return this.data[z * this.side + x] ?? 0;
  }

  set(ix: number, iz: number, value: number): void {
    if (ix < 0 || iz < 0 || ix > this.cells || iz > this.cells) return;
    this.data[iz * this.side + ix] = value;
  }

  add(ix: number, iz: number, delta: number): void {
    if (ix < 0 || iz < 0 || ix > this.cells || iz > this.cells) return;
    const index = iz * this.side + ix;
    this.data[index] = (this.data[index] ?? 0) + delta;
  }

  /** Multiplicative blend at a grid node, used by masks and falloffs. */
  blend(ix: number, iz: number, value: number, weight: number): void {
    if (weight <= 0) return;
    const t = clamp01(weight);
    const index = iz * this.side + ix;
    if (ix < 0 || iz < 0 || ix > this.cells || iz > this.cells) return;
    this.data[index] = lerp(this.data[index] ?? 0, value, t);
  }

  /** Fractional grid coordinates of a world position. */
  gridOf(x: number, z: number): [number, number] {
    return [(x + this.half) / this.step, (z + this.half) / this.step];
  }

  /** World coordinate of a grid node. */
  worldOf(ix: number, iz: number): [number, number] {
    return [-this.half + ix * this.step, -this.half + iz * this.step];
  }

  /**
   * Bilinear elevation in world units.
   *
   * Outside the map the border value is returned rather than 0 or NaN, so a
   * camera flying past the edge never drops objects through the world.
   */
  sample(x: number, z: number): number {
    const [gx, gz] = this.gridOf(x, z);
    const x0 = clamp(Math.floor(gx), 0, this.cells - 1);
    const z0 = clamp(Math.floor(gz), 0, this.cells - 1);
    const tx = clamp01(gx - x0);
    const tz = clamp01(gz - z0);
    const a = this.at(x0, z0);
    const b = this.at(x0 + 1, z0);
    const c = this.at(x0, z0 + 1);
    const d = this.at(x0 + 1, z0 + 1);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /**
   * Slope as rise over run (0 = flat, 1 = 45°, >1 = steeper than 45°).
   * Central differences on the baked grid, so it matches what is rendered.
   */
  slope(x: number, z: number): number {
    const delta = Math.max(this.step * 0.5, 0.001);
    const dx = this.sample(x + delta, z) - this.sample(x - delta, z);
    const dz = this.sample(x, z + delta) - this.sample(x, z - delta);
    return Math.hypot(dx, dz) / (2 * delta);
  }

  /** Unit surface normal, Y up. */
  normal(x: number, z: number): [number, number, number] {
    const delta = Math.max(this.step * 0.5, 0.001);
    const dx = (this.sample(x + delta, z) - this.sample(x - delta, z)) / (2 * delta);
    const dz = (this.sample(x, z + delta) - this.sample(x, z - delta)) / (2 * delta);
    const length = Math.hypot(dx, 1, dz) || 1;
    return [-dx / length, 1 / length, -dz / length];
  }

  /** Compass direction the surface faces, in radians (0 = +Z, π/2 = +X). */
  aspect(x: number, z: number): number {
    const delta = Math.max(this.step * 0.5, 0.001);
    const dx = this.sample(x + delta, z) - this.sample(x - delta, z);
    const dz = this.sample(x, z + delta) - this.sample(x, z - delta);
    return Math.atan2(-dx, -dz);
  }

  min(): number {
    let value = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.data.length; i += 1) value = Math.min(value, this.data[i] ?? value);
    return Number.isFinite(value) ? value : 0;
  }

  max(): number {
    let value = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.data.length; i += 1) value = Math.max(value, this.data[i] ?? value);
    return Number.isFinite(value) ? value : 0;
  }

  mean(): number {
    if (!this.data.length) return 0;
    let sum = 0;
    for (let i = 0; i < this.data.length; i += 1) sum += this.data[i] ?? 0;
    return sum / this.data.length;
  }

  /** Applies `fn(x, z, current)` to every grid node. */
  each(fn: (x: number, z: number, value: number, ix: number, iz: number) => number): void {
    for (let iz = 0; iz <= this.cells; iz += 1) {
      const z = -this.half + iz * this.step;
      for (let ix = 0; ix <= this.cells; ix += 1) {
        const x = -this.half + ix * this.step;
        const index = iz * this.side + ix;
        this.data[index] = fn(x, z, this.data[index] ?? 0, ix, iz);
      }
    }
  }

  /** Separable box blur, `passes` times — cheap smoothing for masks and talus. */
  blur(radiusCells = 1, passes = 1): void {
    if (radiusCells < 1 || passes < 1) return;
    const scratch = new Float32Array(this.data.length);
    for (let pass = 0; pass < passes; pass += 1) {
      // Horizontal.
      for (let iz = 0; iz <= this.cells; iz += 1) {
        for (let ix = 0; ix <= this.cells; ix += 1) {
          let sum = 0;
          let count = 0;
          for (let k = -radiusCells; k <= radiusCells; k += 1) {
            const x = ix + k;
            if (x < 0 || x > this.cells) continue;
            sum += this.data[iz * this.side + x] ?? 0;
            count += 1;
          }
          scratch[iz * this.side + ix] = count > 0 ? sum / count : 0;
        }
      }
      // Vertical, back into the field.
      for (let iz = 0; iz <= this.cells; iz += 1) {
        for (let ix = 0; ix <= this.cells; ix += 1) {
          let sum = 0;
          let count = 0;
          for (let k = -radiusCells; k <= radiusCells; k += 1) {
            const z = iz + k;
            if (z < 0 || z > this.cells) continue;
            sum += scratch[z * this.side + ix] ?? 0;
            count += 1;
          }
          this.data[iz * this.side + ix] = count > 0 ? sum / count : 0;
        }
      }
    }
  }

  clone(): Heightfield {
    const copy = new Heightfield(this.size, this.cells);
    copy.data.set(this.data);
    return copy;
  }
}

/**
 * A single-channel grid aligned with a `Heightfield`, used for masks: biome
 * weights, river corridors, beach bands, cliff faces, cave volume.
 */
export class Mask {
  readonly cells: number;
  readonly side: number;
  readonly data: Uint8Array | Float32Array;

  constructor(cells: number, floating = false) {
    this.cells = Math.max(2, Math.round(cells));
    this.side = this.cells + 1;
    this.data = floating ? new Float32Array(this.side * this.side) : new Uint8Array(this.side * this.side);
  }

  get(ix: number, iz: number): number {
    const x = clamp(ix, 0, this.cells);
    const z = clamp(iz, 0, this.cells);
    return this.data[z * this.side + x] ?? 0;
  }

  set(ix: number, iz: number, value: number): void {
    if (ix < 0 || iz < 0 || ix > this.cells || iz > this.cells) return;
    this.data[iz * this.side + ix] = value;
  }

  /** Nearest-node lookup in world coordinates. */
  atWorld(field: Heightfield, x: number, z: number): number {
    const [gx, gz] = field.gridOf(x, z);
    return this.get(Math.round(gx), Math.round(gz));
  }

  /**
   * Bilinear lookup in world coordinates.
   *
   * The renderer paints sand, rock and snow from these masks, and nearest-node
   * sampling would show the grid as a checkerboard on smooth slopes.
   */
  sample(field: Heightfield, x: number, z: number): number {
    const [gx, gz] = field.gridOf(x, z);
    const x0 = clamp(Math.floor(gx), 0, this.cells - 1);
    const z0 = clamp(Math.floor(gz), 0, this.cells - 1);
    const tx = clamp01(gx - x0);
    const tz = clamp01(gz - z0);
    const a = this.get(x0, z0);
    const b = this.get(x0 + 1, z0);
    const c = this.get(x0, z0 + 1);
    const d = this.get(x0 + 1, z0 + 1);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  any(): boolean {
    for (let i = 0; i < this.data.length; i += 1) if ((this.data[i] ?? 0) > 0) return true;
    return false;
  }

  count(): number {
    let total = 0;
    for (let i = 0; i < this.data.length; i += 1) if ((this.data[i] ?? 0) > 0) total += 1;
    return total;
  }
}
