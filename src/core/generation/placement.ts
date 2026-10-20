import type { WorldObject } from '../world-plan/schema';

/**
 * Lightweight spatial checks for procedural placement.
 *
 * The generator places a handful of large, ordered structures first (buildings,
 * fields, lanes, the river) and then packs vegetation around them. Instead of
 * pairwise checks against every object (which gets expensive for hundreds of
 * trees), footprints go into a uniform grid.
 */

export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface FootprintEntry {
  footprint: Footprint;
  label: string;
  /** Blocking footprints reject new placements; decor does not. */
  blocking: boolean;
}

const CELL_SIZE = 8;

function cellRange(min: number, max: number): [number, number] {
  return [Math.floor(min / CELL_SIZE), Math.floor(max / CELL_SIZE)];
}

export function footprintFromRect(
  x: number,
  z: number,
  width: number,
  depth: number,
  rotationDeg = 0,
): Footprint {
  const radians = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  // Conservative axis-aligned bounds of the rotated rectangle.
  const halfX = (width * cos + depth * sin) / 2;
  const halfZ = (width * sin + depth * cos) / 2;
  return { minX: x - halfX, maxX: x + halfX, minZ: z - halfZ, maxZ: z + halfZ };
}

export function footprintFromPoints(
  points: readonly [number, number, number][],
  width: number,
): Footprint {
  if (points.length === 0) return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0]);
    maxX = Math.max(maxX, point[0]);
    minZ = Math.min(minZ, point[2]);
    maxZ = Math.max(maxZ, point[2]);
  }
  const half = width / 2;
  return { minX: minX - half, maxX: maxX + half, minZ: minZ - half, maxZ: maxZ + half };
}

export function footprintsOverlap(
  a: Footprint,
  b: Footprint,
  margin = 0,
): boolean {
  return (
    a.minX < b.maxX + margin &&
    a.maxX > b.minX - margin &&
    a.minZ < b.maxZ + margin &&
    a.maxZ > b.minZ - margin
  );
}

export function footprintFromObject(object: WorldObject, margin = 0): Footprint | null {
  const { position, rotation, scale } = object.transform;
  const meta = object.meta;
  if (meta.collision?.shape === 'none') return null;
  const [width, , depth] = meta.dimensions;
  const box = footprintFromRect(
    position[0],
    position[2],
    Math.max(0.2, width * scale[0]),
    Math.max(0.2, depth * scale[2]),
    rotation[1],
  );
  return {
    minX: box.minX - margin,
    maxX: box.maxX + margin,
    minZ: box.minZ - margin,
    maxZ: box.maxZ + margin,
  };
}

export class PlacementLedger {
  private readonly cells = new Map<string, FootprintEntry[]>();

  add(footprint: Footprint, label: string, blocking = true): void {
    const entry: FootprintEntry = { footprint, label, blocking };
    const [x0, x1] = cellRange(footprint.minX, footprint.maxX);
    const [z0, z1] = cellRange(footprint.minZ, footprint.maxZ);
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const key = `${x}:${z}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(entry);
        else this.cells.set(key, [entry]);
      }
    }
  }

  /** First blocking entry overlapping `footprint`, or null when free. */
  collide(footprint: Footprint, margin = 0): FootprintEntry | null {
    const [x0, x1] = cellRange(footprint.minX - margin, footprint.maxX + margin);
    const [z0, z1] = cellRange(footprint.minZ - margin, footprint.maxZ + margin);
    const seen = new Set<FootprintEntry>();
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const bucket = this.cells.get(`${x}:${z}`);
        if (!bucket) continue;
        for (const entry of bucket) {
          if (!entry.blocking || seen.has(entry)) continue;
          seen.add(entry);
          if (footprintsOverlap(footprint, entry.footprint, margin)) return entry;
        }
      }
    }
    return null;
  }

  isFree(footprint: Footprint, margin = 0): boolean {
    return this.collide(footprint, margin) === null;
  }
}
