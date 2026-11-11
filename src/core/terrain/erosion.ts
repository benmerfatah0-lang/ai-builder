import { mulberry32 } from '../generation/rng';
import { clamp, clamp01 } from './noise';
import type { Heightfield } from './heightfield';

/**
 * Erosion.
 *
 * Two cheap, well-known, entirely local algorithms give terrain its worn look:
 *
 * 1. **Hydraulic erosion by seeded droplets.** Each droplet carries water and
 *    sediment down the slope, eroding where it is fast and depositing where it
 *    slows. It cuts V-shaped rills, smooths sharp ridges and builds alluvial
 *    fans at the foot of slopes — the details that make generated mountains look
 *    old instead of freshly extruded.
 * 2. **Thermal (talus) erosion.** Material steeper than the angle of repose
 *    slides downhill. It rounds off cliffs' tops and piles scree at their base.
 *
 * Both are deterministic: every random draw comes from `mulberry32(seed)`, so a
 * world with the same seed and the same specification always erodes identically.
 * Neither allocates memory proportional to droplet count, so large maps stay
 * affordable.
 */

export interface HydraulicSettings {
  /** Number of droplets. Defaults scale with map resolution, not world size. */
  droplets?: number;
  /** How much a droplet keeps its heading; higher = straighter rills. */
  inertia?: number;
  /** Sediment a droplet can carry per unit slope and speed. */
  sedimentCapacity?: number;
  erosionRate?: number;
  depositionRate?: number;
  gravity?: number;
  /** Fraction of water lost per step; higher means shorter, sharper rills. */
  evaporation?: number;
  /** Below this slope a droplet cannot erode, only deposit. */
  minSlope?: number;
  maxLifetime?: number;
  /** Water radius used for the bilinear gradient, in grid cells. */
  radius?: number;
}

export interface ThermalSettings {
  /** Maximum stable height difference between neighbours, in world units. */
  talus?: number;
  passes?: number;
  /** Fraction of the excess moved per pass (0..1); lower is gentler. */
  strength?: number;
}

export interface ErosionSettings {
  hydraulic?: HydraulicSettings | null;
  thermal?: ThermalSettings | null;
  /** Skip nodes flagged in `protect` (river beds, cave mouths, carved floors). */
  protect?: Uint8Array | null;
}

export interface ErosionReport {
  eroded: number;
  deposited: number;
  droplets: number;
  thermalMoved: number;
}

/** Height and gradient of the bilinear surface at fractional grid coordinates. */
function sampleGradient(field: Heightfield, fx: number, fz: number): { height: number; gx: number; gz: number } {
  const x = clamp(fx, 0, field.cells);
  const z = clamp(fz, 0, field.cells);
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = x - ix;
  const tz = z - iz;
  const h00 = field.at(ix, iz);
  const h10 = field.at(ix + 1, iz);
  const h01 = field.at(ix, iz + 1);
  const h11 = field.at(ix + 1, iz + 1);
  return {
    height: h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz,
    gx: (h10 - h00) * (1 - tz) + (h11 - h01) * tz,
    gz: (h01 - h00) * (1 - tx) + (h11 - h10) * tx,
  };
}

/**
 * Default droplet count.
 *
 * Erosion detail is a property of the *land*, not of the grid it is baked on, so
 * the budget follows world area: a 512-unit map gets far more droplets than a
 * 96-unit one, but re-baking the same map at a finer resolution costs the same.
 * The cap keeps the largest maps interactive.
 */
export function defaultDropletCount(field: Heightfield): number {
  return clamp(Math.round((field.size * field.size) / 12), 1200, 26000);
}

export function hydraulicErosion(field: Heightfield, seed: number, settings: HydraulicSettings = {}, protect?: Uint8Array | null): { eroded: number; deposited: number } {
  const droplets = Math.max(0, Math.round(settings.droplets ?? defaultDropletCount(field)));
  if (droplets === 0) return { eroded: 0, deposited: 0 };
  const inertia = clamp(settings.inertia ?? 0.06, 0, 0.95);
  const capacityFactor = Math.max(0.1, settings.sedimentCapacity ?? 6);
  const erosionRate = clamp(settings.erosionRate ?? 0.32, 0, 1);
  const depositionRate = clamp(settings.depositionRate ?? 0.28, 0, 1);
  const gravity = Math.max(0.5, settings.gravity ?? 4);
  const evaporation = clamp(settings.evaporation ?? 0.005, 0, 0.2);
  const minSlope = Math.max(0.0005, settings.minSlope ?? 0.006);
  const maxLifetime = Math.max(8, Math.round(settings.maxLifetime ?? Math.max(24, field.cells * 0.22)));
  // Erosion strength is expressed per grid cell so it is resolution independent.
  const unitErosion = erosionRate / Math.max(1, maxLifetime) * 2.4;
  const unitDeposit = depositionRate / Math.max(1, maxLifetime) * 2.2;
  // Sediment is carried in world height units, scaled by the grid step so the
  // same settings behave the same at any resolution or map size.
  const capacityScale = field.step * 0.35;
  // Drag, a speed floor and a cap keep the simulation stable on terrain of any
  // steepness: a droplet always travels, and never reaches absurd velocities.
  const drag = 0.985;
  const minSpeed = 0.22;
  const maxSpeed = 6;

  const rng = mulberry32(seed >>> 0);
  let eroded = 0;
  let deposited = 0;

  for (let drop = 0; drop < droplets; drop += 1) {
    let fx = 1 + rng() * (field.cells - 2);
    let fz = 1 + rng() * (field.cells - 2);
    let vx = 0;
    let vz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;

    for (let step = 0; step < maxLifetime; step += 1) {
      const before = sampleGradient(field, fx, fz);
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      if (ix < 1 || iz < 1 || ix >= field.cells - 1 || iz >= field.cells - 1) break;
      if (protect && protect[iz * field.side + ix]) break;

      // Flow direction: downhill along the gradient, with inertia.
      const gradientX = -before.gx;
      const gradientZ = -before.gz;
      const gradientLength = Math.hypot(gradientX, gradientZ);
      if (gradientLength > 1e-6) {
        vx = vx * inertia + (gradientX / gradientLength) * (1 - inertia);
        vz = vz * inertia + (gradientZ / gradientLength) * (1 - inertia);
      } else {
        vx = (rng() - 0.5) * 0.2;
        vz = (rng() - 0.5) * 0.2;
      }
      const velocityLength = Math.hypot(vx, vz);
      if (velocityLength > 1e-6) {
        vx /= velocityLength;
        vz /= velocityLength;
      }

      const nx = fx + vx;
      const nz = fz + vz;
      if (nx < 1 || nz < 1 || nx >= field.cells - 1 || nz >= field.cells - 1) break;
      const after = sampleGradient(field, nx, nz);
      const heightDelta = after.height - before.height;
      // Rise over run for this step: dimensionless, so gravity behaves the same
      // on a 20-unit hill and a 200-unit mountain.
      const slopeDelta = heightDelta / field.step;

      speed = clamp(Math.sqrt(Math.max(0, speed * speed - slopeDelta * gravity)) * drag, minSpeed, maxSpeed);
      water = Math.max(0.05, water * (1 - evaporation));

      // Carrying capacity grows with slope and speed; a droplet over capacity
      // deposits, an under-capacity droplet erodes.
      const capacity = Math.max(-slopeDelta, minSlope) * speed * water * capacityFactor * capacityScale;
      const tx = fx - ix;
      const tz = fz - iz;
      let change = 0;
      if (sediment > capacity || heightDelta > 0) {
        const amount = heightDelta > 0
          ? Math.min(heightDelta, sediment)
          : (sediment - capacity) * unitDeposit;
        sediment -= amount;
        deposited += amount;
        change = amount;
      } else {
        const amount = Math.min((capacity - sediment) * unitErosion, capacity * 0.5);
        sediment += amount;
        eroded += amount;
        change = -amount;
      }

      // Distribute across the four surrounding nodes (bilinear), which keeps the
      // surface smooth instead of punching single-cell holes.
      field.add(ix, iz, change * (1 - tx) * (1 - tz));
      field.add(ix + 1, iz, change * tx * (1 - tz));
      field.add(ix, iz + 1, change * (1 - tx) * tz);
      field.add(ix + 1, iz + 1, change * tx * tz);

      fx = nx;
      fz = nz;
    }
  }
  return { eroded, deposited };
}

/**
 * Talus / thermal erosion.
 *
 * Any neighbour pair steeper than `talus` exchanges material until it is not.
 * Averaging from a snapshot each pass keeps the result order-independent, which
 * is what makes it deterministic across platforms.
 */
export function thermalErosion(field: Heightfield, settings: ThermalSettings = {}, protect?: Uint8Array | null): number {
  const talus = Math.max(0.001, settings.talus ?? field.step * 0.9);
  const passes = Math.max(0, Math.round(settings.passes ?? 3));
  const strength = clamp01(settings.strength ?? 0.42);
  if (passes === 0 || strength === 0) return 0;

  const neighbours: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let moved = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    const source = field.clone();
    for (let iz = 1; iz < field.cells; iz += 1) {
      for (let ix = 1; ix < field.cells; ix += 1) {
        const index = iz * field.side + ix;
        if (protect && protect[index]) continue;
        const centre = source.at(ix, iz);
        let excess = 0;
        let receivers = 0;
        for (const [ox, oz] of neighbours) {
          const nx = ix + ox;
          const nz = iz + oz;
          if (protect && protect[nz * field.side + nx]) continue;
          const difference = centre - source.at(nx, nz);
          // Diagonal neighbours tolerate more height difference.
          const limit = talus * (ox !== 0 && oz !== 0 ? 1.4142136 : 1);
          if (difference > limit) {
            excess += difference - limit;
            receivers += 1;
          }
        }
        if (excess <= 0 || receivers === 0) continue;
        const amount = excess * strength * 0.5;
        field.add(ix, iz, -amount);
        moved += amount;
        // Spread it over the downhill neighbours proportionally to their gap.
        let spread = 0;
        for (const [ox, oz] of neighbours) {
          const nx = ix + ox;
          const nz = iz + oz;
          if (protect && protect[nz * field.side + nx]) continue;
          const difference = centre - source.at(nx, nz);
          const limit = talus * (ox !== 0 && oz !== 0 ? 1.4142136 : 1);
          if (difference > limit) {
            const share = (difference - limit) / excess;
            field.add(nx, nz, amount * share);
            spread += share;
          }
        }
        // Conserve mass if floating point lost some.
        if (spread < 0.999 && spread > 0) field.add(ix, iz, amount * (1 - spread) * 0.5);
      }
    }
  }
  return moved;
}

/** Runs whichever passes the specification asks for, in a fixed order. */
export function erodeField(field: Heightfield, seed: number, settings: ErosionSettings = {}): ErosionReport {
  const report: ErosionReport = { eroded: 0, deposited: 0, droplets: 0, thermalMoved: 0 };
  if (settings.hydraulic !== null && settings.hydraulic !== undefined) {
    const result = hydraulicErosion(field, seed + 0x51ed2701, settings.hydraulic, settings.protect);
    report.eroded = result.eroded;
    report.deposited = result.deposited;
    report.droplets = Math.max(0, Math.round(settings.hydraulic.droplets ?? defaultDropletCount(field)));
  }
  if (settings.thermal !== null && settings.thermal !== undefined) {
    report.thermalMoved = thermalErosion(field, settings.thermal, settings.protect);
  }
  return report;
}
