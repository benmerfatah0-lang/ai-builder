import { clamp } from './noise';

/**
 * Chunked generation and level of detail.
 *
 * A single `PlaneGeometry` for a whole map forces one resolution everywhere: to
 * see detail near the camera the entire map pays for it. Splitting the map into
 * chunks lets the renderer keep high resolution nearby and drop to a coarse grid
 * far away, and lets a large world be generated, edited and re-baked piece by
 * piece instead of all at once.
 *
 * This module is pure layout arithmetic — no three.js, no allocation per frame —
 * so the same numbers drive the renderer, the editor and the reports. Every
 * chunk samples the *same* baked heightfield, so LOD changes never move the
 * ground, and a small skirt hides the seams where two levels of detail meet.
 */

export interface LodBand {
  /** Beyond this distance from the camera a chunk drops to `cells`. */
  distance: number;
  /** Vertices per chunk edge at this level. */
  cells: number;
}

export interface ChunkSettings {
  /** Chunk edge length in world units. */
  size?: number;
  /** Distance bands, nearest first. */
  lod?: LodBand[];
  /** Apron depth in world units that hides seams between levels. */
  skirt?: number;
}

export interface ChunkSpec {
  id: string;
  /** Chunk coordinates, 0-based from the map's minimum corner. */
  cx: number;
  cz: number;
  /** World-space centre. */
  x: number;
  z: number;
  size: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  skirt: number;
}

export interface ChunkLayout {
  worldSize: number;
  chunkSize: number;
  count: number;
  perRow: number;
  skirt: number;
  lod: LodBand[];
  chunks: ChunkSpec[];
}

/** Sane defaults derived from the map size, so small maps are not over-split. */
export function defaultChunkSize(worldSize: number): number {
  return clamp(Math.round(worldSize / 4), 16, 128);
}

export function defaultLodBands(chunkSize: number): LodBand[] {
  return [
    { distance: chunkSize * 1.6, cells: 48 },
    { distance: chunkSize * 4, cells: 24 },
    { distance: chunkSize * 9, cells: 12 },
    { distance: Number.POSITIVE_INFINITY, cells: 6 },
  ];
}

/** Lays the map out as a grid of chunks. */
export function planChunks(worldSize: number, settings: ChunkSettings = {}): ChunkLayout {
  const size = Math.max(4, settings.size ?? defaultChunkSize(worldSize));
  const chunkSize = clamp(size, 4, Math.max(4, worldSize));
  const perRow = Math.max(1, Math.ceil(worldSize / chunkSize));
  // The grid covers the map exactly; the last column may be clipped.
  const lod = settings.lod && settings.lod.length > 0
    ? [...settings.lod].sort((a, b) => a.distance - b.distance)
    : defaultLodBands(chunkSize);
  const skirt = Math.max(0, settings.skirt ?? Math.max(chunkSize * 0.03, 0.6));
  const half = worldSize / 2;
  const chunks: ChunkSpec[] = [];

  for (let cz = 0; cz < perRow; cz += 1) {
    for (let cx = 0; cx < perRow; cx += 1) {
      const minX = -half + cx * chunkSize;
      const minZ = -half + cz * chunkSize;
      const maxX = Math.min(half, minX + chunkSize);
      const maxZ = Math.min(half, minZ + chunkSize);
      chunks.push({
        id: `chunk-${cx}-${cz}`,
        cx,
        cz,
        x: (minX + maxX) / 2,
        z: (minZ + maxZ) / 2,
        size: Math.max(maxX - minX, maxZ - minZ),
        minX,
        maxX,
        minZ,
        maxZ,
        skirt,
      });
    }
  }

  return { worldSize, chunkSize, count: chunks.length, perRow, skirt, lod, chunks };
}

/** Vertices per chunk edge at a given camera distance. */
export function lodCells(distance: number, lod: LodBand[]): number {
  for (const band of lod) {
    if (distance <= band.distance) return Math.max(2, band.cells);
  }
  const last = lod[lod.length - 1];
  return Math.max(2, last ? last.cells : 6);
}

/** Chunks inside `radius` of a point, sorted nearest first. */
export function chunksNear(layout: ChunkLayout, x: number, z: number, radius: number): ChunkSpec[] {
  const limit = Math.max(0, radius);
  return layout.chunks
    .map((chunk) => ({ chunk, distance: Math.hypot(chunk.x - x, chunk.z - z) }))
    .filter((item) => item.distance <= limit + item.chunk.size * 0.71)
    .sort((a, b) => a.distance - b.distance)
    .map((item) => item.chunk);
}

/** Chunk containing a world position, or null outside the map. */
export function chunkAt(layout: ChunkLayout, x: number, z: number): ChunkSpec | null {
  const half = layout.worldSize / 2;
  if (x < -half || z < -half || x > half || z > half) return null;
  const cx = clamp(Math.floor((x + half) / layout.chunkSize), 0, layout.perRow - 1);
  const cz = clamp(Math.floor((z + half) / layout.chunkSize), 0, layout.perRow - 1);
  return layout.chunks[cz * layout.perRow + cx] ?? null;
}

/** Vertex count for a chunk at a level of detail — used for budget reports. */
export function chunkVertices(cells: number): number {
  const side = Math.max(2, cells) + 1;
  return side * side;
}

/** Total vertices the map costs at a given camera distance. */
export function layoutVertexCount(layout: ChunkLayout, distance: number): number {
  const cells = lodCells(distance, layout.lod);
  return chunkVertices(cells) * layout.count;
}

/** A single flat mesh is cheaper than chunks until the map is genuinely large. */
export function shouldUseChunks(worldSize: number, resolution: number, settings: ChunkSettings = {}): boolean {
  const nodes = (Math.max(2, resolution) + 1) ** 2;
  const chunkSize = settings.size ?? defaultChunkSize(worldSize);
  const chunks = Math.max(1, Math.ceil(worldSize / chunkSize)) ** 2;
  // Chunks pay off when a flat mesh would need a lot of vertices, or when the
  // map is split into enough chunks for culling and LOD to matter.
  return nodes > 40000 || (chunks >= 9 && worldSize >= 160);
}
