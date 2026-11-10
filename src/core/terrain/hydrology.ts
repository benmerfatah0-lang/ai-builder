import { clamp, clamp01, smoothstep } from './noise';
import { Heightfield, Mask } from './heightfield';
import type { FeatureContext } from './features';
import type { Vec2 } from './geometry';

/**
 * Hydrology: where water actually goes.
 *
 * Rivers are not drawn — they are *derived*. The pipeline is the standard one
 * used by real terrain tools:
 *
 * 1. **Priority flood** fills every depression so the surface has a defined
 *    downhill direction everywhere (lakes become flat, and the cells that had to
 *    be raised are recorded as water bodies).
 * 2. **D8 flow** picks the steepest descending neighbour for every node.
 * 3. **Flow accumulation** counts upstream nodes in descending-height order.
 * 4. **Channel extraction** keeps the cells whose accumulation exceeds a
 *    threshold and walks them downstream into polylines.
 * 5. **Carving** lowers the ground under those polylines with a channel profile
 *    and enforces a monotonic bed, so a river can never float above the terrain
 *    it runs through, and marks a keep-out corridor around it.
 *
 * Everything here is deterministic and free: no external service, no paid API.
 */

export interface FlowOptions {
  /** Accumulated upstream nodes needed before a cell counts as a channel. */
  threshold?: number;
}

export interface FlowField {
  /** Filled surface used for directions; depressions removed. */
  filled: Heightfield;
  /** Nodes that had to be raised by the fill, i.e. lake and pond beds. */
  flooded: Mask;
  /** Index of the downstream neighbour for each node, or -1 for sinks/outlets. */
  downstream: Int32Array;
  /** Upstream node count per node (each node contributes 1). */
  accumulation: Float32Array;
  /** Channel mask: cells whose accumulation clears the threshold. */
  channels: Mask;
  threshold: number;
}

/** Binary min-heap over node indices, keyed by height. */
class IndexHeap {
  private readonly keys: Float64Array;
  private readonly items: Int32Array;
  private length = 0;

  constructor(capacity: number, keys: Float64Array) {
    this.keys = keys;
    this.items = new Int32Array(capacity + 1);
  }

  get size(): number {
    return this.length;
  }

  push(index: number): void {
    if (this.length >= this.items.length) return;
    let i = this.length;
    this.length += 1;
    this.items[i] = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.keys[this.items[parent]!] ?? 0) <= (this.keys[this.items[i]!] ?? 0)) break;
      const swap = this.items[parent]!;
      this.items[parent] = this.items[i]!;
      this.items[i] = swap;
      i = parent;
    }
  }

  pop(): number {
    if (this.length === 0) return -1;
    const top = this.items[0]!;
    this.length -= 1;
    if (this.length > 0) {
      this.items[0] = this.items[this.length]!;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.length && (this.keys[this.items[left]!] ?? 0) < (this.keys[this.items[smallest]!] ?? 0)) smallest = left;
        if (right < this.length && (this.keys[this.items[right]!] ?? 0) < (this.keys[this.items[smallest]!] ?? 0)) smallest = right;
        if (smallest === i) break;
        const swap = this.items[smallest]!;
        this.items[smallest] = this.items[i]!;
        this.items[i] = swap;
        i = smallest;
      }
    }
    return top;
  }
}

const NEIGHBOURS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/**
 * Priority flood: raises every depression floor to its spill height.
 *
 * Deterministic and exact — a node is only ever raised to the height of the
 * water that would stand in it, so lakes come out flat and everything else is
 * left untouched.
 */
export function fillDepressions(field: Heightfield): { filled: Heightfield; flooded: Mask } {
  const filled = field.clone();
  const flooded = new Mask(field.cells);
  const nodes = filled.side * filled.side;
  const visited = new Uint8Array(nodes);
  const keys = new Float64Array(filled.data);
  const heap = new IndexHeap(nodes, keys);

  // Seed with the border: water can only leave the map through its edges.
  for (let i = 0; i <= field.cells; i += 1) {
    for (const index of [i, field.cells * filled.side + i, i * filled.side, i * filled.side + field.cells]) {
      if (visited[index]) continue;
      visited[index] = 1;
      heap.push(index);
    }
  }

  while (heap.size > 0) {
    const index = heap.pop();
    if (index < 0) break;
    const iz = Math.floor(index / filled.side);
    const ix = index - iz * filled.side;
    const height = keys[index]!;
    for (const [ox, oz] of NEIGHBOURS) {
      const nx = ix + ox;
      const nz = iz + oz;
      if (nx < 0 || nz < 0 || nx > filled.cells || nz > filled.cells) continue;
      const neighbour = nz * filled.side + nx;
      if (visited[neighbour]) continue;
      visited[neighbour] = 1;
      const current = keys[neighbour]!;
      if (current < height) {
        keys[neighbour] = height;
        flooded.set(nx, nz, 1);
      }
      heap.push(neighbour);
    }
  }

  for (let i = 0; i < nodes; i += 1) filled.data[i] = keys[i] ?? 0;
  return { filled, flooded };
}

/** D8 steepest-descent directions plus flow accumulation, in one pass. */
export function computeFlow(field: Heightfield, options: FlowOptions = {}): FlowField {
  const { filled, flooded } = fillDepressions(field);
  const side = filled.side;
  const nodes = side * side;
  const downstream = new Int32Array(nodes).fill(-1);
  const accumulation = new Float32Array(nodes);

  // Directions: the steepest neighbour, scaled by distance so diagonals are fair.
  for (let iz = 0; iz <= filled.cells; iz += 1) {
    for (let ix = 0; ix <= filled.cells; ix += 1) {
      const index = iz * side + ix;
      const height = filled.at(ix, iz);
      let bestSlope = 1e-6;
      let bestIndex = -1;
      for (const [ox, oz, distance] of NEIGHBOURS) {
        const nx = ix + ox;
        const nz = iz + oz;
        if (nx < 0 || nz < 0 || nx > filled.cells || nz > filled.cells) continue;
        const slope = (height - filled.at(nx, nz)) / (distance * filled.step);
        if (slope > bestSlope) {
          bestSlope = slope;
          bestIndex = nz * side + nx;
        }
      }
      downstream[index] = bestIndex;
    }
  }

  // Accumulation in descending height order: every node hands its total downstream.
  const order: number[] = new Array(nodes);
  for (let i = 0; i < nodes; i += 1) order[i] = i;
  const heights = filled.data;
  order.sort((a, b) => (heights[b] ?? 0) - (heights[a] ?? 0));
  accumulation.fill(1);
  for (let i = 0; i < nodes; i += 1) {
    const index = order[i]!;
    const next = downstream[index]!;
    if (next >= 0) accumulation[next] = (accumulation[next] ?? 0) + (accumulation[index] ?? 0);
  }

  const threshold = Math.max(8, Math.round(options.threshold ?? nodes * 0.0011));
  const channels = new Mask(filled.cells);
  for (let iz = 0; iz <= filled.cells; iz += 1) {
    for (let ix = 0; ix <= filled.cells; ix += 1) {
      if ((accumulation[iz * side + ix] ?? 0) >= threshold) channels.set(ix, iz, 1);
    }
  }

  return { filled, flooded, downstream, accumulation, channels, threshold };
}

export interface RiverPath {
  /** Grid nodes, upstream to downstream. */
  nodes: Array<[number, number]>;
  /** World-space polyline of the same path. */
  points: Vec2[];
  /** Peak accumulation along the path — a proxy for discharge. */
  discharge: number;
  /** True when the path came from following the flow field, not a drawn spine. */
  derived: boolean;
  /** Channel half width it was carved at, set by `carveRivers`. */
  width?: number;
}

/**
 * Walks the flow field downhill from `start`, collecting the channel.
 *
 * Walking downstream is what guarantees a realistic path: the river follows the
 * drainage network instead of a straight line between two anchors.
 */
export function traceDownstream(flow: FlowField, start: [number, number], minLength = 8, maxLength = 4096): RiverPath {
  const side = flow.filled.side;
  const nodes: Array<[number, number]> = [];
  const seen = new Set<number>();
  let ix = start[0] ?? 0;
  let iz = start[1] ?? 0;
  let discharge = 0;
  while (nodes.length < maxLength) {
    if (ix < 0 || iz < 0 || ix > flow.filled.cells || iz > flow.filled.cells) break;
    const index = iz * side + ix;
    if (seen.has(index)) break;
    seen.add(index);
    nodes.push([ix, iz]);
    discharge = Math.max(discharge, flow.accumulation[index] ?? 0);
    const next = flow.downstream[index]!;
    if (next < 0) break;
    iz = Math.floor(next / side);
    ix = next - iz * side;
  }
  if (nodes.length < minLength) return { nodes: [], points: [], discharge: 0, derived: true };
  return { nodes, points: nodes.map(([x, z]) => flow.filled.worldOf(x, z)), discharge, derived: true };
}

/** Grid node nearest to a world point whose accumulation clears `min`. */
export function nearestChannelNode(flow: FlowField, x: number, z: number, min: number, radiusCells?: number): [number, number] | null {
  const [gx, gz] = flow.filled.gridOf(x, z);
  const radius = Math.max(1, Math.round(radiusCells ?? flow.filled.cells * 0.16));
  const cx = Math.round(gx);
  const cz = Math.round(gz);
  let best: [number, number] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let iz = Math.max(0, cz - radius); iz <= Math.min(flow.filled.cells, cz + radius); iz += 1) {
    for (let ix = Math.max(0, cx - radius); ix <= Math.min(flow.filled.cells, cx + radius); ix += 1) {
      const accumulation = flow.accumulation[iz * flow.filled.side + ix] ?? 0;
      if (accumulation < min) continue;
      // Prefer strong channels that are also close to the anchor.
      const score = Math.hypot(ix - gx, iz - gz) - Math.log10(1 + accumulation) * 3;
      if (score < bestScore) {
        bestScore = score;
        best = [ix, iz];
      }
    }
  }
  return best;
}

export interface RiverExtraction {
  threshold: number;
  maxRivers: number;
  minLength?: number;
}

/** Reads the accumulation `steps` nodes downstream — a cheap size estimate. */
function probeDownstream(flow: FlowField, index: number, steps: number): number {
  let current = index;
  let best = flow.accumulation[current] ?? 0;
  const seen = new Set<number>();
  for (let i = 0; i < steps; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const next = flow.downstream[current]!;
    if (next < 0) break;
    current = next;
    best = Math.max(best, flow.accumulation[current] ?? 0);
  }
  return best;
}

/**
 * Finds the strongest drainage channels in the map.
 *
 * A river starts at a *channel head*: a cell that clears the accumulation
 * threshold while none of its neighbours feeds it from inside the channel
 * network. Heads are ranked by the discharge they reach a little way downstream,
 * then traced to the map edge. Paths that mostly retrace a stronger, already
 * chosen river are dropped, so a tributary never becomes a second river.
 */
export function extractRivers(flow: FlowField, options: RiverExtraction): RiverPath[] {
  const side = flow.filled.side;
  const minLength = Math.max(4, options.minLength ?? Math.round(flow.filled.cells * 0.14));
  const heads: Array<{ index: number; rank: number }> = [];

  for (let iz = 0; iz <= flow.filled.cells; iz += 1) {
    for (let ix = 0; ix <= flow.filled.cells; ix += 1) {
      const index = iz * side + ix;
      if (!flow.channels.get(ix, iz)) continue;
      const accumulation = flow.accumulation[index] ?? 0;
      let fedBy = 0;
      for (const [ox, oz] of NEIGHBOURS) {
        const nx = ix + ox;
        const nz = iz + oz;
        if (nx < 0 || nz < 0 || nx > flow.filled.cells || nz > flow.filled.cells) continue;
        const neighbour = nz * side + nx;
        if (!flow.channels.get(nx, nz)) continue;
        if ((flow.accumulation[neighbour] ?? 0) < accumulation) fedBy += 1;
      }
      if (fedBy > 0) continue;
      heads.push({ index, rank: probeDownstream(flow, index, 64) });
    }
  }
  heads.sort((a, b) => b.rank - a.rank);

  const used = new Uint8Array(side * side);
  const budget = Math.max(options.maxRivers * 4, options.maxRivers + 4);
  const kept: RiverPath[] = [];
  for (const head of heads.slice(0, budget)) {
    if (kept.length >= options.maxRivers) break;
    if (used[head.index]) continue;
    const iz = Math.floor(head.index / side);
    const ix = head.index - iz * side;
    const path = traceDownstream(flow, [ix, iz], minLength);
    if (path.nodes.length === 0) continue;
    let overlap = 0;
    for (const [nx, nz] of path.nodes) if (used[nz * side + nx]) overlap += 1;
    if (overlap > path.nodes.length * 0.5) continue;
    for (const [nx, nz] of path.nodes) used[nz * side + nx] = 1;
    kept.push(path);
  }
  return kept;
}

/**
 * Turns a described river spine into a real river.
 *
 * The first anchor is snapped to the nearest drainage channel and the path is
 * walked downhill from there, so a description like "a river from the mountains
 * to the lake" produces a river that obeys gravity. If the anchors sit on flat
 * ground with no drainage, the spine itself is used and its bed is forced to
 * descend, which still cannot float.
 */
export function riverFromSpine(flow: FlowField, spine: Vec2[], minLength = 6): RiverPath {
  const empty: RiverPath = { nodes: [], points: [], discharge: 0, derived: false };
  if (spine.length === 0) return empty;
  const [startX, startZ] = spine[0]!;
  const [gx, gz] = flow.filled.gridOf(startX, startZ);
  const anchor: [number, number] = [
    clamp(Math.round(gx), 0, flow.filled.cells),
    clamp(Math.round(gz), 0, flow.filled.cells),
  ];
  // 1. From the described source, straight downhill.
  const fromAnchor = traceDownstream(flow, anchor, minLength);
  if (fromAnchor.nodes.length > 0) return fromAnchor;
  // 2. From the nearest established drainage channel, if the source sits on a
  //    flat spot with nowhere to go.
  const snapped = nearestChannelNode(flow, startX, startZ, flow.threshold * 0.4);
  if (snapped) {
    const traced = traceDownstream(flow, snapped, minLength);
    if (traced.nodes.length > 0) return traced;
  }
  // 3. Shortest possible walk, so a described river is never silently dropped.
  const shortest = traceDownstream(flow, anchor, 2);
  if (shortest.nodes.length > 1) return shortest;
  // Fallback: follow the spine, snapping each node to the grid.
  const nodes: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const [x, z] of spine) {
    const [gx, gz] = flow.filled.gridOf(x, z);
    const ix = clamp(Math.round(gx), 0, flow.filled.cells);
    const iz = clamp(Math.round(gz), 0, flow.filled.cells);
    const key = `${ix},${iz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push([ix, iz]);
  }
  if (nodes.length < 2) return empty;
  return { nodes, points: nodes.map(([x, z]) => flow.filled.worldOf(x, z)), discharge: flow.threshold, derived: false };
}

export interface CarveSettings {
  /** Channel half width in world units. */
  width: number;
  /** Depth of the bed below the surrounding ground, in world units. */
  depth?: number;
  /** Minimum downhill drop between consecutive bed points. */
  minDrop?: number;
  /** Never dig deeper than this below the original ground. */
  maxDig?: number;
  /** Keep-out corridor half width for buildings and roads. */
  corridor?: number;
  /** Lower the mouth to this level so the river meets water instead of hanging. */
  mouthLevel?: number | null;
}

export interface CarveReport {
  rivers: number;
  nodes: number;
  deepest: number;
}

/**
 * Cuts channels into the ground.
 *
 * Two invariants are enforced here and relied on everywhere else:
 *
 * - **The bed never rises above the ground it replaces**, so a river can never
 *   float or cut a tunnel under a hill.
 * - **The bed descends monotonically downstream**, ending at or below the water
 *   level when one exists, so the mouth always joins the lake or sea.
 *
 * The surrounding cells are blended with a U-shaped channel profile (flat bed,
 * steep banks), and a corridor mask is marked so the planner keeps buildings and
 * roads out of the water.
 */
export function carveRivers(ctx: FeatureContext, paths: RiverPath[], settings: CarveSettings): CarveReport {
  const { field } = ctx;
  const report: CarveReport = { rivers: 0, nodes: 0, deepest: 0 };
  if (paths.length === 0) return report;
  const width = Math.max(field.step * 0.75, settings.width);
  const depth = Math.max(field.step * 0.25, settings.depth ?? Math.max(width * 0.28, field.size * 0.004));
  const minDrop = Math.max(0.002, settings.minDrop ?? field.step * 0.006);
  const maxDig = Math.max(depth * 1.5, settings.maxDig ?? depth * 6);
  const corridor = Math.max(width, settings.corridor ?? width * 2.4);
  const radiusCells = Math.max(1, Math.ceil(corridor / field.step));
  const mouthLevel = settings.mouthLevel ?? null;

  for (const path of paths) {
    if (path.nodes.length < 2) continue;
    report.rivers += 1;
    path.width = width;

    // Monotonic bed: start just below the ground, never go back up, never dig
    // deeper than `maxDig`, and sink to the water level at the mouth.
    const beds: number[] = [];
    let previous = Number.POSITIVE_INFINITY;
    for (let i = 0; i < path.nodes.length; i += 1) {
      const [ix, iz] = path.nodes[i]!;
      const ground = field.at(ix, iz);
      const target = Math.min(ground - depth * 0.45, previous - minDrop);
      const bed = Math.max(ground - maxDig, target);
      beds.push(Math.min(bed, ground));
      previous = beds[i]!;
    }
    if (mouthLevel !== null) {
      // Blend the last stretch down to the water level so the river joins it.
      const tail = Math.min(beds.length, Math.max(4, Math.round(beds.length * 0.18)));
      for (let k = 0; k < tail; k += 1) {
        const index = beds.length - 1 - k;
        const t = smoothstep(1 - k / tail);
        beds[index] = Math.min(beds[index]!, lerpSafe(beds[index]!, mouthLevel - depth * 0.25, t));
      }
    }

    // Widen slightly downstream: a real river grows as tributaries join it.
    for (let i = 0; i < path.nodes.length; i += 1) {
      const [ix, iz] = path.nodes[i]!;
      const growth = 1 + (i / Math.max(1, path.nodes.length - 1)) * 0.55;
      const bed = beds[i]!;
      report.nodes += 1;
      report.deepest = Math.max(report.deepest, field.at(ix, iz) - bed);

      for (let oz = -radiusCells; oz <= radiusCells; oz += 1) {
        const nz = iz + oz;
        if (nz < 0 || nz > field.cells) continue;
        for (let ox = -radiusCells; ox <= radiusCells; ox += 1) {
          const nx = ix + ox;
          if (nx < 0 || nx > field.cells) continue;
          const distance = Math.hypot(ox, oz) * field.step;
          // Corridor: buildings, roads and props keep out of the river valley.
          const corridorWeight = clamp01((corridor - distance) / Math.max(field.step, corridor * 0.55));
          if (corridorWeight > 0) ctx.corridor.set(nx, nz, Math.max(ctx.corridor.get(nx, nz), corridorWeight));
          if (distance > width * growth) continue;
          const t = clamp01(distance / Math.max(field.step * 0.5, width * growth));
          // U profile: flat bed in the middle, steep banks at the edge.
          const shape = smoothstep(t);
          const ground = field.at(nx, nz);
          const target = Math.min(ground, bed + shape * (ground - bed) * 0.92);
          field.set(nx, nz, Math.min(ground, target));
        }
      }
    }
  }
  return report;
}

function lerpSafe(a: number, b: number, t: number): number {
  const value = a + (b - a) * clamp01(t);
  return Number.isFinite(value) ? value : a;
}

export interface LakeRegion {
  /** Approximate centre in world space. */
  center: Vec2;
  /** Radius of the smallest circle covering the region. */
  radius: number;
  /** Water surface elevation. */
  level: number;
  cells: number;
  /** Mean depth below the water surface, in world units. */
  depth: number;
}

/**
 * Groups filled depressions into lakes.
 *
 * Used by the biome map (wetland and marsh around the shore), by the renderer
 * (a local water plane where the ocean does not reach) and by the planner, which
 * can then describe a lake by its actual position instead of guessing.
 */
export function findLakes(flow: FlowField, minCells = 12, original: Heightfield | null = null, minDepth = 0): LakeRegion[] {
  const field = flow.filled;
  const side = field.side;
  const seen = new Uint8Array(side * side);
  const lakes: LakeRegion[] = [];

  for (let iz = 0; iz <= field.cells; iz += 1) {
    for (let ix = 0; ix <= field.cells; ix += 1) {
      const index = iz * side + ix;
      if (seen[index] || !flow.flooded.get(ix, iz)) continue;
      seen[index] = 1;
      const stack: number[] = [index];
      const members: number[] = [];
      while (stack.length) {
        const current = stack.pop()!;
        members.push(current);
        const cz = Math.floor(current / side);
        const cx = current - cz * side;
        for (const [ox, oz] of NEIGHBOURS) {
          const nx = cx + ox;
          const nz = cz + oz;
          if (nx < 0 || nz < 0 || nx > field.cells || nz > field.cells) continue;
          const neighbour = nz * side + nx;
          if (seen[neighbour] || !flow.flooded.get(nx, nz)) continue;
          seen[neighbour] = 1;
          stack.push(neighbour);
        }
      }
      if (members.length < minCells) continue;
      let sumX = 0;
      let sumZ = 0;
      let level = Number.POSITIVE_INFINITY;
      let depthTotal = 0;
      let floorTotal = 0;
      for (const member of members) {
        const mz = Math.floor(member / side);
        const mx = member - mz * side;
        sumX += mx;
        sumZ += mz;
        level = Math.min(level, field.at(mx, mz));
        if (original) {
          depthTotal += field.at(mx, mz) - original.at(mx, mz);
          floorTotal += original.at(mx, mz);
        }
      }
      // A depression only counts as a lake if it actually holds water: flat ground
      // is filled by the algorithm too, and must not become a lake.
      if (original && minDepth > 0 && depthTotal / members.length < minDepth) continue;
      const centreX = sumX / members.length;
      const centreZ = sumZ / members.length;
      let radius = 0;
      for (const member of members) {
        const mz = Math.floor(member / side);
        const mx = member - mz * side;
        radius = Math.max(radius, Math.hypot(mx - centreX, mz - centreZ));
      }
      const [worldX, worldZ] = field.worldOf(Math.round(centreX), Math.round(centreZ));
      lakes.push({
        center: [worldX, worldZ],
        radius: radius * field.step,
        level: Number.isFinite(level) ? level : 0,
        cells: members.length,
        depth: original ? Math.max(0, level - floorTotal / members.length) : depthTotal / members.length,
      });
    }
  }
  return lakes.sort((a, b) => b.cells - a.cells);
}

/** Protect river beds and lake floors from erosion smoothing them away. */
export function protectionMask(flow: FlowField, ctx: FeatureContext): Uint8Array {
  const field = flow.filled;
  const protect = new Uint8Array(field.side * field.side);
  for (let iz = 0; iz <= field.cells; iz += 1) {
    for (let ix = 0; ix <= field.cells; ix += 1) {
      const index = iz * field.side + ix;
      if (flow.channels.get(ix, iz) || flow.flooded.get(ix, iz) || ctx.corridor.get(ix, iz) > 0.4) protect[index] = 1;
    }
  }
  return protect;
}
