import { mulberry32 } from '../generation/rng';
import { clamp, clamp01, fbm3, smoothstep } from './noise';
import { Heightfield } from './heightfield';
import type { FeatureContext } from './features';
import type { LandscapeSpec } from '../world-plan/schema';
import type { Vec2 } from './geometry';

/**
 * Natural caves.
 *
 * A world built from a heightfield has no volume underground, so "a cave" is
 * delivered in the two forms that are actually useful:
 *
 * 1. **A carved entrance.** A passage is cut into a rock face: the ground above
 *    the passage is lowered to a floor plus headroom, the walls taper inwards
 *    with depth, and the mouth always faces downhill so it reads as an opening
 *    rather than a trench. The passage polyline is recorded, so the editor can
 *    place a cave mouth prop, keep roads out, and let the walk navigation drop
 *    the player inside.
 * 2. **A volumetric query.** `caveSolidAt` evaluates a 3-D fBm field, so any
 *    point in space can be asked whether it is rock or void. That is what a real
 *    cave system is made of, and it is available to future underground views and
 *    to the tests, which use it to prove the galleries connect.
 *
 * Entrances are chosen on steep, rocky, well-drained ground away from rivers and
 * from each other — deterministic from the seed, never random at runtime.
 */

export interface CaveSpec {
  id?: string;
  entrance?: Vec2;
  radius?: number;
  depth?: number;
  chambers?: number;
  heading?: number;
}

export interface CaveEntrance {
  id: string;
  position: Vec2;
  /** Floor elevation at the mouth. */
  elevation: number;
  /** Compass heading into the hill, in degrees (0 = +Z, 90 = +X). */
  heading: number;
  radius: number;
  depth: number;
  chambers: number;
  /** Passage centreline from the mouth inwards, in world space. */
  passage: Vec2[];
  /** Floor elevation along the passage. */
  floors: number[];
}

export interface CaveCarveOptions {
  /** Candidate mouths evaluated before the best are kept. */
  candidates?: number;
  /** Minimum distance between two entrances, in world units. */
  separation?: number;
  /** Maximum slope, as rise over run, accepted for a mouth. */
  maxSlope?: number;
}

const CHAMBER_SPACING = 0.62;

/**
 * Is this point rock or void?
 *
 * Two fBm octaves are combined so galleries are worm-like rather than blobby,
 * and the result is biased by depth below the surface: caves live under ground,
 * not in mid-air.
 */
export function caveSolidAt(
  seed: number,
  x: number,
  y: number,
  z: number,
  options: { scale?: number; threshold?: number; surface?: number; warp?: number } = {},
): boolean {
  const scale = Math.max(1, options.scale ?? 14);
  const threshold = options.threshold ?? 0.42;
  const warp = options.warp ?? 0.35;
  const nx = x / scale;
  const ny = y / scale;
  const nz = z / scale;
  // Domain-warp in Y so passages meander vertically as well as sideways.
  const galleries = fbm3(seed + 0x2f6e2b1, nx, ny + warp * Math.sin(nx * 2.1), nz, 3);
  const chambers = fbm3(seed + 0x5b3c1a7, nx * 0.55, ny * 0.55, nz * 0.55, 2);
  const voidness = Math.abs(galleries) * 0.65 + Math.abs(chambers) * 0.5;
  if (options.surface !== undefined) {
    // Above the surface there is nothing to hollow out.
    const depth = options.surface - y;
    if (depth < 0) return false;
    if (depth < scale * 0.35) return voidness > threshold + 0.25;
  }
  return voidness <= threshold;
}

/** Heads into the hill: the downhill direction, in degrees (0 = +Z). */
function downhillHeading(field: Heightfield, x: number, z: number): number {
  const delta = Math.max(field.step, field.size * 0.01);
  const dx = field.sample(x + delta, z) - field.sample(x - delta, z);
  const dz = field.sample(x, z + delta) - field.sample(x, z - delta);
  // The steepest descent is the negated gradient; atan2 gives 0 for +Z.
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}

/** Scores a candidate mouth: rock, steep, high, dry, and facing downhill. */
function scoreMouth(
  field: Heightfield,
  ctx: FeatureContext,
  ix: number,
  iz: number,
  waterLevel: number | null,
  taken: Vec2[],
  separation: number,
  maxSlope: number,
): number {
  const [x, z] = field.worldOf(ix, iz);
  const slope = field.slope(x, z);
  if (slope < 0.35 || slope > maxSlope) return -1;
  const rock = ctx.rock.get(ix, iz);
  if (rock < 0.25) return -1;
  if (ctx.corridor.get(ix, iz) > 0.25) return -1;
  const height = field.at(ix, iz);
  if (waterLevel !== null && height < waterLevel + Math.max(1, field.size * 0.012)) return -1;
  for (const other of taken) {
    if (Math.hypot(other[0] - x, other[1] - z) < separation) return -1;
  }
  // Prefer higher, rockier ground with a good slope but not a sheer wall.
  const heightScore = clamp01((height - field.min()) / Math.max(0.001, field.max() - field.min()));
  return rock * 1.4 + heightScore * 1.2 + clamp01(slope / maxSlope) * 0.8;
}

/**
 * Cuts one passage into the ground.
 *
 * The floor descends gently with depth, the passage narrows and its headroom
 * shrinks, and chambers widen it at regular intervals. Only ground *above* the
 * intended ceiling is removed, so the carve can never lift terrain or punch a
 * hole through a valley floor.
 */
function carvePassage(ctx: FeatureContext, cave: Required<Pick<CaveEntrance, 'position' | 'heading' | 'radius' | 'depth' | 'chambers'>>): { floors: number[]; passage: Vec2[] } {
  const { field } = ctx;
  const radian = (cave.heading * Math.PI) / 180;
  const dirX = Math.sin(radian);
  const dirZ = Math.cos(radian);
  const steps = Math.max(4, Math.round(cave.depth / Math.max(field.step * 0.75, 0.5)));
  const floors: number[] = [];
  const passage: Vec2[] = [];

  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const distance = t * cave.depth;
    const x = cave.position[0] + dirX * distance;
    const z = cave.position[1] + dirZ * distance;
    const ground = field.sample(x, z);
    // Floor sinks slowly inwards; chambers are wider and slightly flatter.
    const floor = ground - cave.radius * 0.55 - distance * 0.06;
    floors.push(floor);
    passage.push([x, z]);

    const chamberPhase = Math.cos((t / CHAMBER_SPACING) * Math.PI * 2 * cave.chambers);
    const widening = 1 + Math.max(0, chamberPhase) * 0.55;
    const width = cave.radius * widening * (1 - t * 0.35);
    const headroom = cave.radius * (0.85 + Math.max(0, chamberPhase) * 0.4) * (1 - t * 0.25);
    // The mouth is open to the sky and the roof closes over the passage a short
    // way in, so the entrance reads as a dark opening in the rock face.
    const opening = smoothstep(clamp01(t * 2.5));
    const ceiling = floor + headroom * opening;
    const reach = Math.max(1, Math.ceil(width / field.step));
    const [gx, gz] = field.gridOf(x, z);
    const cx = Math.round(gx);
    const cz = Math.round(gz);

    for (let oz = -reach; oz <= reach; oz += 1) {
      const iz = cz + oz;
      if (iz < 0 || iz > field.cells) continue;
      for (let ox = -reach; ox <= reach; ox += 1) {
        const ix = cx + ox;
        if (ix < 0 || ix > field.cells) continue;
        const offset = Math.hypot(ox, oz) * field.step;
        if (offset > width) continue;
        const current = field.at(ix, iz);
        if (current <= ceiling) continue;
        // Soft walls: full removal at the centre, tapering at the edge.
        const profile = smoothstep(clamp01(offset / Math.max(field.step * 0.5, width)));
        const target = Math.max(floor, current - (current - ceiling) * (1 - profile * 0.85));
        field.set(ix, iz, Math.min(current, target));
        ctx.carved.set(ix, iz, 1);
        ctx.rock.set(ix, iz, Math.max(ctx.rock.get(ix, iz), 1 - profile));
      }
    }
  }
  return { floors, passage };
}

/**
 * Places and carves every cave the description asks for.
 *
 * Given an entrance the cave is carved there; otherwise the engine searches the
 * baked surface for the best rock face and uses it, so "a cave in the mountains"
 * lands in the mountains without being told where.
 */
export function carveCaves(ctx: FeatureContext, landscape: LandscapeSpec, options: CaveCarveOptions = {}): CaveEntrance[] {
  const { field, seed } = ctx;
  const specs = landscape.caves ?? [];
  if (specs.length === 0) return [];
  const separation = Math.max(field.size * 0.08, options.separation ?? field.size * 0.14);
  const maxSlope = Math.max(0.6, options.maxSlope ?? 2.2);
  const candidateCount = Math.max(64, Math.round(options.candidates ?? field.cells * 6));
  const rng = mulberry32((seed + 0x3c1f5a97) >>> 0);
  const taken: Vec2[] = [];
  const entrances: CaveEntrance[] = [];

  specs.forEach((spec, index) => {
    const radius = clamp(spec.radius ?? Math.max(2, field.size * 0.014), 1, field.size * 0.2);
    const depth = clamp(spec.depth ?? radius * 5, radius, field.size * 0.9);
    const chambers = clamp(Math.round(spec.chambers ?? 2), 1, 8);
    const id = spec.id || `cave-${index + 1}`;

    let position: Vec2 | null = null;
    let heading = spec.heading ?? 0;

    if (spec.entrance) {
      const [gx, gz] = field.gridOf(spec.entrance[0], spec.entrance[1]);
      const ix = clamp(Math.round(gx), 1, field.cells - 1);
      const iz = clamp(Math.round(gz), 1, field.cells - 1);
      position = field.worldOf(ix, iz);
      heading = spec.heading ?? clamp(downhillHeading(field, position[0], position[1]), 0, 360);
    } else {
      // Seeded search for the best rock face not already used.
      let bestScore = -1;
      let best: [number, number] | null = null;
      for (let candidate = 0; candidate < candidateCount; candidate += 1) {
        const ix = 1 + Math.floor(rng() * (field.cells - 2));
        const iz = 1 + Math.floor(rng() * (field.cells - 2));
        const score = scoreMouth(field, ctx, ix, iz, ctx.waterLevel, taken, separation, maxSlope);
        if (score > bestScore) {
          bestScore = score;
          best = [ix, iz];
        }
      }
      if (!best || bestScore <= 0) return;
      position = field.worldOf(best[0], best[1]);
      heading = clamp(downhillHeading(field, position[0], position[1]), 0, 360);
    }

    const carved = carvePassage(ctx, { position, heading, radius, depth, chambers });
    taken.push(position);
    entrances.push({
      id,
      position,
      elevation: carved.floors[0] ?? field.sample(position[0], position[1]),
      heading,
      radius,
      depth,
      chambers,
      passage: carved.passage,
      floors: carved.floors,
    });
  });

  return entrances;
}
