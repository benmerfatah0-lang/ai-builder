import { createTerrainSampler, type TerrainSampler } from '../../core/generation/terrain';
import { mulberry32, range, type Rng } from '../../core/generation/rng';
import type { Terrain } from '../../core/world-plan/schema';
import type { LakeSpec, PlacementSpec, RegionSelector, SpatialRelation, WorldSpec } from './worldSpec';

/**
 * Spatial layout resolution.
 *
 * Turns relational language ("a castle on top of a mountain", "a village
 * surrounding a lake", "a river passing through a forest", "houses connected by
 * roads") into concrete terrain-space positions and polylines.
 *
 * It reuses the existing `createTerrainSampler` and seeded `mulberry32`, so the
 * result is deterministic for a given (terrain, seed) pair and consistent with
 * the terrain the generators produce. Nothing here mutates the terrain.
 */

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type Position = [number, number];

export interface LayoutOptions {
  /** Minimum distance between two resolved positions of the same group. */
  minSpacing?: number;
  /** Keep away from the terrain edge by this margin. */
  margin?: number;
}

export class WorldLayout {
  private readonly sampler: TerrainSampler;
  private readonly rng: Rng;
  private readonly size: number;
  private readonly waterLevel: number | null;
  private readonly lake: LakeSpec | undefined;
  private readonly margin: number;
  private readonly minSpacing: number;

  constructor(terrain: Terrain, seed: number, lake: LakeSpec | undefined, options: LayoutOptions = {}) {
    this.sampler = createTerrainSampler(terrain, seed);
    this.rng = mulberry32((seed ^ 0x5f3a) >>> 0);
    this.size = terrain.size;
    this.waterLevel = terrain.waterLevel;
    this.lake = lake;
    this.margin = options.margin ?? Math.max(4, terrain.size * 0.06);
    this.minSpacing = options.minSpacing ?? Math.max(3, terrain.size * 0.03);
  }

  get terrainSize(): number {
    return this.size;
  }

  heightAt(x: number, z: number): number {
    return this.sampler.heightAt(x, z);
  }

  /** Usable area after the edge margin. */
  bounds(selector?: RegionSelector, inset = 0): Bounds {
    const half = this.size / 2 - this.margin - inset;
    const full: Bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };
    switch (selector) {
      case 'north': return { ...full, minZ: -half, maxZ: -half * 0.25 };
      case 'south': return { ...full, minZ: half * 0.25, maxZ: half };
      case 'west': return { ...full, minX: -half, maxX: -half * 0.25 };
      case 'east': return { ...full, minX: half * 0.25, maxX: half };
      case 'center': {
        const inner = half * 0.45;
        return { minX: -inner, maxX: inner, minZ: -inner, maxZ: inner };
      }
      // "Edge" regions keep the full bounds: the scatter spreads naturally and
      // `regionCenter('edge')` supplies a ring point when one is needed.
      case 'edge': return full;
      default: return full;
    }
  }

  /** Minimum separation the resolver tries to keep between positions. */
  get spacing(): number {
    return this.minSpacing;
  }

  private isDry(x: number, z: number, clearance = 0.35): boolean {
    if (this.waterLevel === null) return true;
    return this.sampler.heightAt(x, z) >= this.waterLevel + clearance;
  }

  /** Coarse height survey of a region, highest first. */
  private survey(area: Bounds, samples = 22): { x: number; z: number; y: number }[] {
    const points: { x: number; z: number; y: number }[] = [];
    for (let i = 0; i <= samples; i += 1) {
      for (let j = 0; j <= samples; j += 1) {
        const x = area.minX + ((area.maxX - area.minX) * i) / samples;
        const z = area.minZ + ((area.maxZ - area.minZ) * j) / samples;
        points.push({ x, z, y: this.sampler.heightAt(x, z) });
      }
    }
    return points;
  }

  /** Highest dry points, spread apart — "on top of the mountain". */
  highest(count: number, selector?: RegionSelector): Position[] {
    const area = this.bounds(selector);
    const sorted = this.survey(area).sort((a, b) => b.y - a.y);
    return this.spread(sorted, count);
  }

  /** Lowest points — valley floors, marshes, "at the foot of". */
  lowest(count: number, selector?: RegionSelector): Position[] {
    const area = this.bounds(selector);
    const sorted = this.survey(area).sort((a, b) => a.y - b.y);
    return this.spread(sorted.filter((point) => this.isDry(point.x, point.z)), count);
  }

  /** Points at a given fraction between the lowest and highest ground. */
  atElevation(count: number, ratio: number, selector?: RegionSelector): Position[] {
    const area = this.bounds(selector);
    const surveyed = this.survey(area);
    const values = surveyed.map((point) => point.y).sort((a, b) => a - b);
    const target = values[Math.min(values.length - 1, Math.max(0, Math.floor(ratio * (values.length - 1))))] ?? 0;
    const near = surveyed
      .filter((point) => this.isDry(point.x, point.z))
      .sort((a, b) => Math.abs(a.y - target) - Math.abs(b.y - target));
    return this.spread(near, count);
  }

  /** Shoreline points: just above the water line, or around the lake basin. */
  waterEdge(count: number): Position[] {
    if (this.lake) return this.ring([this.lake.x, this.lake.z], this.lake.radius * 1.25, count);
    if (this.waterLevel === null) return this.scatter(this.bounds(), count);
    const area = this.bounds();
    const level = this.waterLevel;
    const surveyed = this.survey(area, 26).filter((point) => {
      const delta = point.y - level;
      return delta > 0.2 && delta < Math.max(2.5, this.size * 0.02);
    });
    const chosen = this.spread(surveyed, count);
    return chosen.length ? chosen : this.scatter(area, count);
  }

  /** Even ring around a centre — "a village surrounding a lake". */
  ring(center: Position, radius: number, count: number, jitter = 0.12): Position[] {
    const points: Position[] = [];
    const safeRadius = Math.max(2, Math.min(radius, this.size / 2 - this.margin));
    for (let index = 0; index < count; index += 1) {
      const angle = (index / Math.max(1, count)) * Math.PI * 2 + range(this.rng, -jitter, jitter);
      const distance = safeRadius * (1 + range(this.rng, -jitter, jitter));
      const x = clamp(center[0] + Math.cos(angle) * distance, this.bounds());
      const z = clamp(center[1] + Math.sin(angle) * distance, this.bounds());
      points.push([x, z]);
    }
    return points;
  }

  /** Seeded rejection scatter inside bounds, above water. */
  scatter(area: Bounds, count: number, attemptsPerPoint = 40, minSpacing?: number): Position[] {
    const spacing = minSpacing ?? this.minSpacing;
    const chosen: Position[] = [];
    for (let attempt = 0; attempt < count * attemptsPerPoint && chosen.length < count; attempt += 1) {
      const x = range(this.rng, area.minX, area.maxX);
      const z = range(this.rng, area.minZ, area.maxZ);
      if (!this.isDry(x, z)) continue;
      if (chosen.some(([ox, oz]) => Math.hypot(ox - x, oz - z) < spacing)) continue;
      chosen.push([x, z]);
    }
    return chosen;
  }

  /** Straight sampled line — "a river passing through the forest". */
  line(from: Position, to: Position, samples = 9, wobble = 0.06): Position[] {
    const points: Position[] = [];
    for (let index = 0; index < samples; index += 1) {
      const t = index / (samples - 1);
      const x = from[0] + (to[0] - from[0]) * t;
      const z = from[1] + (to[1] - from[1]) * t;
      const perpendicular = index === 0 || index === samples - 1 ? 0 : range(this.rng, -wobble, wobble) * this.size;
      const dx = to[1] - from[1];
      const dz = -(to[0] - from[0]);
      const length = Math.hypot(dx, dz) || 1;
      points.push([
        clamp(x + (dx / length) * perpendicular, this.bounds()),
        clamp(z + (dz / length) * perpendicular, this.bounds()),
      ]);
    }
    return points;
  }

  midpoint(a: Position, b: Position): Position {
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }

  /** Nearest-neighbour ordering, then a terrain-following polyline. */
  chain(points: Position[], samplesPerSegment = 5): { ordered: Position[]; polyline: Position[] } {
    if (points.length < 2) return { ordered: [...points], polyline: [...points] };
    const remaining = [...points];
    const ordered: Position[] = [remaining.shift()!];
    while (remaining.length) {
      const last = ordered[ordered.length - 1]!;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [index, candidate] of remaining.entries()) {
        const distance = Math.hypot(candidate[0] - last[0], candidate[1] - last[1]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      ordered.push(remaining.splice(bestIndex, 1)[0]!);
    }
    const polyline: Position[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const segment = this.line(ordered[index]!, ordered[index + 1]!, samplesPerSegment, 0.02);
      polyline.push(...(index === 0 ? segment : segment.slice(1)));
    }
    return { ordered, polyline };
  }

  /** Offset from an anchor — near / left / right / front / behind. */
  anchorOffset(anchor: Position, direction: PlacementSpec['direction'], index: number, distance?: number): Position {
    const spacing = this.minSpacing * 1.6;
    const reach = distance ?? spacing * (1.6 + index * 0.55);
    const area = this.bounds();
    switch (direction) {
      case 'left': return [clamp(anchor[0] - reach, area), clamp(anchor[1] + range(this.rng, -2, 2), area)];
      case 'right': return [clamp(anchor[0] + reach, area), clamp(anchor[1] + range(this.rng, -2, 2), area)];
      case 'front': return [clamp(anchor[0] + range(this.rng, -2, 2), area), clamp(anchor[1] - reach, area)];
      case 'behind': return [clamp(anchor[0] + range(this.rng, -2, 2), area), clamp(anchor[1] + reach, area)];
      default: {
        const angle = range(this.rng, 0, Math.PI * 2);
        return [clamp(anchor[0] + Math.cos(angle) * reach, area), clamp(anchor[1] + Math.sin(angle) * reach, area)];
      }
    }
  }

  /** Centre of a named region, resolved against the real terrain. */
  regionCenter(selector: RegionSelector | undefined): Position {
    switch (selector) {
      case 'summit': return this.highest(1)[0] ?? [0, 0];
      case 'base': {
        const peak = this.highest(1)[0] ?? [0, 0];
        const foot = this.lowest(1);
        return foot.length ? this.midpoint(peak, foot[0]!) : peak;
      }
      case 'slope': return this.atElevation(1, 0.62)[0] ?? [0, 0];
      case 'waterfront': return this.waterEdge(1)[0] ?? [0, 0];
      case 'north': return [0, -this.size * 0.3];
      case 'south': return [0, this.size * 0.3];
      case 'east': return [this.size * 0.3, 0];
      case 'west': return [-this.size * 0.3, 0];
      case 'edge': return this.ring([0, 0], this.size * 0.4, 1)[0] ?? [0, 0];
      default: return [0, 0];
    }
  }

  /** Picks `count` well-separated candidates from a sorted survey. */
  private spread(points: { x: number; z: number }[], count: number): Position[] {
    const chosen: Position[] = [];
    const spacing = Math.max(this.minSpacing, this.size * 0.06);
    for (const point of points) {
      if (chosen.length >= count) break;
      if (!this.isDry(point.x, point.z)) continue;
      if (chosen.some(([x, z]) => Math.hypot(x - point.x, z - point.z) < spacing)) continue;
      chosen.push([point.x, point.z]);
    }
    if (chosen.length < count) {
      chosen.push(...this.scatter(this.bounds(), count - chosen.length));
    }
    return chosen.slice(0, count);
  }
}

function clamp(value: number, area: Bounds): number {
  return Math.min(area.maxX, Math.max(area.minX, value));
}

/**
 * Resolve every placement and relation in a spec to concrete positions.
 *
 * Returns a new spec (never mutates the input) with `positions` filled in and
 * each relation marked `resolved` or `unsupported` with an Arabic note.
 */
export function resolveLayout(spec: WorldSpec, terrain: Terrain): WorldSpec {
  const layout = new WorldLayout(terrain, spec.seed, spec.terrain.lake);
  const positions: Record<string, Position[]> = {};
  const notes: string[] = [];

  const boundsFor = (regionId?: string) => {
    const region = spec.regions.find((entry) => entry.id === regionId);
    return layout.bounds(region?.selector);
  };

  const placementFor = (target: { id: string; count: number; region?: string; placement?: PlacementSpec }): Position[] => {
    const placement = target.placement;
    const count = Math.max(1, target.count);
    if (placement?.positions?.length) return placement.positions.slice(0, count);
    switch (placement?.strategy) {
      case 'highest': return layout.highest(count, placement.region ? spec.regions.find((r) => r.id === placement.region)?.selector : undefined);
      case 'lowest': return layout.lowest(count);
      case 'water-edge': return layout.waterEdge(count);
      case 'ring': {
        const center = placement.anchor && positions[placement.anchor]?.[0]
          ? positions[placement.anchor]![0]!
          : spec.terrain.lake
            ? [spec.terrain.lake.x, spec.terrain.lake.z] as Position
            : layout.regionCenter(spec.regions.find((r) => r.id === placement.region)?.selector);
        return layout.ring(center, placement.radius ?? Math.max(6, terrain.size * 0.14), count);
      }
      case 'line': {
        const from = layout.regionCenter('west');
        const to = layout.regionCenter('east');
        return layout.line(from, to, count + 2).slice(0, count);
      }
      case 'midpoint': {
        const first = placement.anchor ? positions[placement.anchor]?.[0] : undefined;
        if (first) return layout.ring(first, terrain.size * 0.08, count);
        return layout.scatter(boundsFor(target.region), count);
      }
      case 'region-center': {
        const center = layout.regionCenter(spec.regions.find((r) => r.id === target.region)?.selector);
        return count === 1 ? [center] : layout.ring(center, Math.max(4, terrain.size * 0.06), count);
      }
      case 'anchor-offset': {
        const anchor = placement.anchor ? positions[placement.anchor]?.[0] : undefined;
        if (!anchor) return layout.scatter(boundsFor(target.region), count);
        const out: Position[] = [];
        for (let index = 0; index < count; index += 1) out.push(layout.anchorOffset(anchor, placement.direction ?? 'near', index));
        return out;
      }
      default:
        return layout.scatter(boundsFor(target.region), count);
    }
  };

  // Landmarks first: their positions become anchors for everything else.
  const orderedBuildings = [...spec.buildings].sort((a, b) => rankOf(b) - rankOf(a));
  for (const building of orderedBuildings) {
    positions[building.id] = placementFor(building);
  }
  for (const asset of spec.assets) {
    positions[asset.id] = placementFor(asset);
  }

  // Relations may re-position their subject after the anchors are known.
  const relations: SpatialRelation[] = spec.relations.map((relation) => {
    const subject = relation.subjectId;
    const anchor = relation.objectId;
    // A relation may be anchored to the land itself ("خيام عند الكثبان",
    // "بيوت عند البحيرة"). Those anchors are not objects, so their positions are
    // sampled from the terrain instead of looked up.
    const anchorPositions = positions[anchor] ?? terrainAnchorPositions(layout, anchor);
    const subjectTarget = spec.buildings.find((entry) => entry.id === subject) ?? spec.assets.find((entry) => entry.id === subject);
    if (!subjectTarget) {
      notes.push(`العلاقة «${relation.subject} ← ${relation.object}» لم تُنفَّذ: الطرف «${relation.subject}» ليس عنصراً يمكن وضعه.`);
      return { ...relation, status: 'unsupported' as const, note: 'الطرف المذكور في العلاقة غير موجود في المواصفات.' };
    }
    const count = subjectTarget.count;
    switch (relation.predicate) {
      case 'on-top-of': {
        const resolved = layout.highest(count);
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const, note: 'وُضع على أعلى نقاط التضاريس المتاحة.' };
      }
      case 'at-foot-of': {
        const peak = anchorPositions?.[0] ?? layout.highest(1)[0] ?? ([0, 0] as Position);
        const resolved: Position[] = [];
        for (let index = 0; index < count; index += 1) resolved.push(layout.anchorOffset(peak, 'near', index, terrain.size * 0.13));
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const, note: 'وُضع عند سفح أعلى نقطة.' };
      }
      case 'surrounding':
      case 'surrounded-by': {
        // Both mean "ring around the anchor"; the frame extractor already
        // normalizes the reversed Arabic/English phrasing.
        const center = anchorPositions?.[0] ?? layout.regionCenter('center');
        const resolved = layout.ring(center, Math.max(6, terrain.size * 0.15), count);
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const, note: `حلقة حول «${relation.object}».` };
      }
      case 'inside': {
        const area = boundsFor(spec.regions.find((region) => region.name === relation.object || region.id === relation.objectId)?.id);
        const resolved = layout.scatter(area, count);
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const };
      }
      case 'through':
      case 'across': {
        // A linear feature crossing a region: the polyline *is* the placement.
        const horizontal = relation.predicate === 'across';
        const from = layout.regionCenter(horizontal ? 'west' : 'north');
        const to = layout.regionCenter(horizontal ? 'east' : 'south');
        const polyline = layout.line(from, to, 11);
        positions[subject] = polyline;
        return { ...relation, resolved: polyline, polyline, status: 'resolved' as const, note: 'مسار يعبر المنطقة من طرف إلى طرف.' };
      }
      case 'connected-by': {
        const ordered = positions[subject] ?? layout.scatter(boundsFor(subjectTarget.region), count);
        const { polyline } = layout.chain(ordered);
        return { ...relation, resolved: ordered, polyline, status: 'resolved' as const, note: `طريق يربط ${ordered.length} مواقع.` };
      }
      case 'between': {
        const first = positions[anchor]?.[0] ?? layout.regionCenter('west');
        const second = relation.second ? positions[relation.second]?.[0] ?? layout.regionCenter('east') : layout.regionCenter('east');
        const resolved = count === 1
          ? [layout.midpoint(first, second)]
          : layout.line(first, second, count + 2).slice(1, count + 1);
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const };
      }
      case 'along': {
        const resolved = layout.waterEdge(count);
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const, note: 'على امتداد حافة الماء.' };
      }
      case 'near':
      case 'facing':
      case 'left-of':
      case 'right-of':
      case 'front-of':
      case 'behind': {
        const anchorPosition = anchorPositions?.[0];
        if (!anchorPosition) {
          notes.push(`تعذّر إيجاد مرجع «${relation.object}» لعلاقة ${relation.predicate}؛ استُخدم توزيع بديل.`);
          return { ...relation, status: 'unsupported' as const, note: 'المرجع غير موجود.' };
        }
        const direction = relation.predicate === 'near' || relation.predicate === 'facing'
          ? 'near'
          : relation.predicate === 'left-of' ? 'left'
            : relation.predicate === 'right-of' ? 'right'
              : relation.predicate === 'front-of' ? 'front' : 'behind';
        const resolved: Position[] = [];
        for (let index = 0; index < count; index += 1) resolved.push(layout.anchorOffset(anchorPosition, direction, index));
        positions[subject] = resolved;
        return { ...relation, resolved, status: 'resolved' as const };
      }
      default:
        return { ...relation, status: 'unsupported' as const };
    }
  });

  return { ...spec, positions, relations, notices: [...spec.notices, ...notes] };
}

/**
 * Positions for the synthetic anchors the solver emits when a relation refers to
 * water or relief rather than to a placeable object.
 */
function terrainAnchorPositions(layout: WorldLayout, anchorId: string): Position[] | undefined {
  switch (anchorId) {
    case 'terrain-summit':
      return layout.highest(1);
    case 'terrain-lake':
    case 'terrain-oasis':
    case 'terrain-marsh':
    case 'terrain-sea':
    case 'terrain-water':
      return layout.waterEdge(1);
    case 'terrain-river':
      return layout.line(layout.regionCenter('north'), layout.regionCenter('south'), 3);
    case 'terrain-area':
      return [layout.regionCenter('center')];
    default:
      return undefined;
  }
}

/** Landmarks and settlements are placed before the things that reference them. */
function rankOf(building: { kind: string; count: number }): number {
  const rank: Record<string, number> = {
    castle: 100, lighthouse: 90, watchtower: 85, tower: 80, shrine: 70, mine: 70,
    'mine-entrance': 70, 'stone-arch': 60, windmill: 55, fountain: 45, well: 45,
    'market-stall': 40, bridge: 38, barn: 35, house: 30, wall: 20, tent: 20,
    gazebo: 20, column: 15, ruin: 50,
  };
  return (rank[building.kind] ?? 10) + Math.min(9, building.count);
}
