import { createRiver } from '../assets/structures';
import { footprintFromObject, footprintsOverlap, type Footprint } from './placement';
import { createTerrainSampler } from './terrain';
import { resampleSpine } from '../terrain/geometry';
import { isEffectivelyVisible, worldTransformOf } from '../world-plan/hierarchy';
import { MAX_WORLD_OBJECTS, type RiverObject, type WorldPlan } from '../world-plan/schema';

type Point = [number, number, number];
const WIDTH = 3.5;
const BANK = WIDTH + 1.1;

/** Construct a bounded ribbon that follows sampled terrain; it does not excavate. */
function makeRiverFromPath(plan: WorldPlan, path: [number, number][]): RiverObject {
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const total = path.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - path[i]![0], point[1] - path[i]![1]), 0);
  if (path.length > 60) throw new Error('مسار النهر معقد جداً؛ لم يتغير العالم.');
  let spacing = Math.max(2, total / Math.max(1, 63 - path.length));
  let divisions = path.slice(1).map((point, i) => Math.max(1, Math.ceil(Math.hypot(point[0] - path[i]![0], point[1] - path[i]![1]) / spacing)));
  while (divisions.reduce((a, b) => a + b, 1) > 64) {
    spacing *= 1.2;
    divisions = path.slice(1).map((point, i) => Math.max(1, Math.ceil(Math.hypot(point[0] - path[i]![0], point[1] - path[i]![1]) / spacing)));
  }
  const coordinates: [number, number][] = [path[0]!];
  for (let i = 0; i < divisions.length; i++) {
    const a = path[i]!, b = path[i + 1]!, n = divisions[i]!;
    for (let k = 1; k <= n; k++) coordinates.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  const side = BANK / 2;
  const baked = sampler.landscape;
  const points: Point[] = coordinates.map(([x, z]) => {
    if (baked) {
      // The engine already cut a channel here, so the ribbon lies *in* it: the
      // centre height plus a lift that keeps the wide edge clear of a bank.
      // Sampling the neighbourhood maximum instead would float it over the bed.
      const slope = sampler.slopeAt?.(x, z) ?? 0;
      return [x, sampler.heightAt(x, z) + 0.12 + Math.min(0.6, slope * side * 0.5), z];
    }
    return [x, Math.max(sampler.heightAt(x, z), sampler.heightAt(x - side, z), sampler.heightAt(x + side, z), sampler.heightAt(x, z - side), sampler.heightAt(x, z + side)) + 0.12, z];
  });
  const origin = points[0]!;
  const local: Point[] = points.map(([x, y, z]) => [x - origin[0], y - origin[1], z - origin[2]]);
  return createRiver(local, origin, { name: 'Village river', width: WIDTH, color: '#4f8ca5', region: 'village-water' });
}

export function makeTerrainRiver(plan: WorldPlan, axis: 'x' | 'z', center: number, start: number, end: number): RiverObject {
  return makeRiverFromPath(plan, axis === 'z' ? [[center, start], [center, end]] : [[start, center], [end, center]]);
}

/**
 * A ribbon that follows a channel the landscape engine actually carved.
 *
 * Returns `null` for a classic terrain, so callers fall back to the decorative
 * ribbon. Because the path is the drainage network itself, the water runs
 * downhill the whole way, its bed is below the ground on both banks, and it
 * cannot cut through a building: the engine kept a corridor clear when it carved.
 */
export function makeBakedRiver(plan: WorldPlan, index = 0): RiverObject | null {
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  const river = sampler.landscape?.rivers[index];
  if (!river || river.points.length < 2) return null;
  const total = river.points.slice(1).reduce(
    (sum, point, i) => sum + Math.hypot(point[0] - river.points[i]![0], point[1] - river.points[i]![1]),
    0,
  );
  // Keep the ribbon inside the 64-point budget the schema allows.
  const count = Math.max(8, Math.min(60, Math.round(total / Math.max(2, plan.terrain.size / 60))));
  const path = resampleSpine(river.points, count);
  if (path.length < 2) return null;
  const points: Point[] = path.map(([x, z]) => [x, sampler.heightAt(x, z) + 0.1, z]);
  const origin = points[0]!;
  const local: Point[] = points.map(([x, y, z]) => [x - origin[0], y - origin[1], z - origin[2]]);
  const width = Math.max(WIDTH, Math.min(14, river.width ?? plan.terrain.size * 0.02));
  return createRiver(local, origin, { name: 'نهر', width, color: '#4f8ca5', region: 'landscape-water' });
}

/** Bounded grid search for a polyline through the central region of the village. */
function routeAroundObjects(plan: WorldPlan, obstacles: Footprint[], bounds: { minX: number; maxX: number; minZ: number; maxZ: number }): RiverObject | null {
  const step = Math.max(2.5, plan.terrain.size / 64);
  const half = plan.terrain.size / 2 - BANK / 2 - 1;
  const minX = Math.max(-half, bounds.minX - 10), maxX = Math.min(half, bounds.maxX + 10);
  const minZ = Math.max(-half, bounds.minZ - 10), maxZ = Math.min(half, bounds.maxZ + 10);
  const nx = Math.floor((maxX - minX) / step) + 1, nz = Math.floor((maxZ - minZ) / step) + 1;
  if (nx < 2 || nz < 2 || nx * nz > 5000) return null;
  const expanded = obstacles.map((b) => ({ minX: b.minX - BANK / 2 - .8, maxX: b.maxX + BANK / 2 + .8, minZ: b.minZ - BANK / 2 - .8, maxZ: b.maxZ + BANK / 2 + .8 }))
    .filter((b) => footprintsOverlap(b, { minX, maxX, minZ, maxZ }));
  const xy = (id: number): [number, number] => [minX + (id % nx) * step, minZ + Math.floor(id / nx) * step];
  const blocked = new Uint8Array(nx * nz);
  for (let i = 0; i < blocked.length; i++) {
    const [x, z] = xy(i);
    blocked[i] = expanded.some((b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) ? 1 : 0;
  }
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const central = Array.from({ length: nx * nz }, (_, id) => id).filter((id) => {
    if (blocked[id]) return false;
    const [x,z] = xy(id);
    return Math.abs(x - cx) <= Math.max(2.5, (bounds.maxX - bounds.minX) * .3) && Math.abs(z - cz) <= Math.max(2.5, (bounds.maxZ - bounds.minZ) * .3);
  }).sort((a,b) => { const aa=xy(a), bb=xy(b); return Math.hypot(aa[0]-cx,aa[1]-cz)-Math.hypot(bb[0]-cx,bb[1]-cz); }).slice(0, 6);
  const find = (start: number, goal: number): number[] | null => {
    const costs = new Float64Array(nx * nz).fill(Infinity);
    const previous = new Int32Array(nx * nz).fill(-1);
    const closed = new Uint8Array(nx * nz);
    const open = [start]; costs[start] = 0;
    const heuristic = (id: number) => Math.abs(id % nx - goal % nx) + Math.abs(Math.floor(id / nx) - Math.floor(goal / nx));
    while (open.length) {
      open.sort((a,b) => costs[b]! + heuristic(b) - costs[a]! - heuristic(a));
      const current = open.pop()!;
      if (closed[current]) continue;
      if (current === goal) { const path = [goal]; while (path[0] !== start) path.unshift(previous[path[0]!]!); return path; }
      closed[current] = 1;
      const x = current % nx, z = Math.floor(current / nx);
      for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
        const xx=x+dx, zz=z+dz;
        if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
        const next=zz*nx+xx;
        if (blocked[next] || closed[next]) continue;
        const [ax,az]=xy(current), [bx,bz]=xy(next);
        const segment={ minX: Math.min(ax,bx)-.001, maxX: Math.max(ax,bx)+.001, minZ: Math.min(az,bz)-.001, maxZ: Math.max(az,bz)+.001 };
        if (expanded.some((b) => footprintsOverlap(segment, b))) continue;
        const cost=costs[current]!+1;
        if (cost < costs[next]!) { costs[next]=cost; previous[next]=current; open.push(next); }
      }
    }
    return null;
  };
  for (const axis of ['z', 'x'] as const) {
    if ((axis === 'z' ? bounds.maxX-bounds.minX : bounds.maxZ-bounds.minZ) < BANK + 2) continue;
    const crossMin = axis === 'z' ? bounds.minX : bounds.minZ, crossMax = axis === 'z' ? bounds.maxX : bounds.maxZ;
    const atEdge = (end: boolean) => Array.from({ length: axis === 'z' ? nx : nz }, (_, i) => axis === 'z' ? (end ? (nz-1)*nx+i : i) : i*nx+(end ? nx-1 : 0))
      .filter((id) => { const [x,z]=xy(id), cross=axis==='z'?x:z; return !blocked[id] && cross > crossMin && cross < crossMax; })
      .sort((a,b) => { const aa=xy(a),bb=xy(b); return Math.abs((axis==='z'?aa[0]:aa[1])-(axis==='z'?cx:cz))-Math.abs((axis==='z'?bb[0]:bb[1])-(axis==='z'?cx:cz)); })[0];
    const start=atEdge(false), end=atEdge(true);
    if (start === undefined || end === undefined) continue;
    for (const center of central) {
      const left=find(start,center), right=find(center,end);
      if (!left || !right) continue;
      const route=[...left, ...right.slice(1)].map(xy);
      const simplified: [number, number][] = [];
      for (const point of route) {
        while (simplified.length >= 2) {
          const a=simplified.at(-2)!, b=simplified.at(-1)!;
          if ((a[0] === b[0] && b[0] === point[0]) || (a[1] === b[1] && b[1] === point[1])) simplified.pop(); else break;
        }
        simplified.push(point);
      }
      if (simplified.length > 60) continue;
      const river = makeRiverFromPath(plan, simplified);
      const waterLevel = plan.terrain.waterLevel;
      if (waterLevel !== null && river.points.some((p) => p[1] + river.transform.position[1] <= waterLevel + .2)) continue;
      return river;
    }
  }
  return null;
}

/** Infer one house cluster, then try central straight corridors without moving existing objects. */
export function addRiverThroughVillage(plan: WorldPlan, selection: string[] = []): { plan: WorldPlan; message: string } {
  if (plan.objects.length >= MAX_WORLD_OBJECTS) throw new Error('وصل العالم إلى الحد الأقصى للعناصر؛ لم يُضف النهر.');
  if (plan.objects.some((object) => object.kind === 'river')) throw new Error('يوجد نهر بالفعل؛ لم أضف نهراً آخر تلقائياً.');
  const houses = plan.objects.filter((object) => object.kind === 'building' && object.variant === 'house' && isEffectivelyVisible(plan, object.id))
    .map((object) => ({ object, transform: worldTransformOf(plan, object.id) })).filter((entry) => entry.transform !== null);
  if (houses.length < 2) throw new Error('لم أجد بيتين ظاهرين لتقدير موقع القرية؛ لم يتغير العالم.');
  const clusters: typeof houses[] = [];
  const remaining = new Set(houses);
  while (remaining.size) {
    const first = remaining.values().next().value!;
    remaining.delete(first);
    const cluster = [first];
    for (let i = 0; i < cluster.length; i++) {
      const a = cluster[i]!.transform!.position;
      for (const other of remaining) {
        const b = other.transform!.position;
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) <= Math.min(50, plan.terrain.size * 0.3)) { remaining.delete(other); cluster.push(other); }
      }
    }
    if (cluster.length >= 2) clusters.push(cluster);
  }
  const chosen = clusters.length === 1 ? clusters[0] : clusters.find((cluster) => selection.length === 1 && cluster.some((entry) => entry.object.id === selection[0]));
  if (!chosen) throw new Error('لم أستطع تحديد تجمع بيوت واحد؛ اختر بيتاً في القرية المطلوبة ثم أعد الأمر.');
  const positions = chosen.map((entry) => entry.transform!.position);
  const minX = Math.min(...positions.map((p) => p[0])), maxX = Math.max(...positions.map((p) => p[0]));
  const minZ = Math.min(...positions.map((p) => p[2])), maxZ = Math.max(...positions.map((p) => p[2]));
  const half = plan.terrain.size / 2 - BANK / 2 - 1;
  const obstacles: Footprint[] = [];
  for (const object of plan.objects) {
    // Paths may cross the ribbon but no bridge is automatically built.
    if (object.kind === 'path' || object.kind === 'river') continue;
    const transform = worldTransformOf(plan, object.id);
    if (!transform) throw new Error('تعذّر تقدير موضع عنصر في العالم؛ لم يُضف النهر.');
    const footprint = footprintFromObject({ ...object, transform, meta: { ...object.meta, collision: { shape: 'box', blocking: true } } });
    if (footprint) obstacles.push(footprint);
  }
  for (const axis of ['z', 'x'] as const) {
    const minCross = axis === 'z' ? minX : minZ, maxCross = axis === 'z' ? maxX : maxZ;
    const minAlong = axis === 'z' ? minZ : minX, maxAlong = axis === 'z' ? maxZ : maxX;
    const middle = (minCross + maxCross) / 2;
    const span = maxCross - minCross;
    if (span < BANK + 2) continue;
    const start = Math.max(-half, minAlong - 8), end = Math.min(half, maxAlong + 8);
    if (end - start < 8) continue;
    for (const fraction of [0, -0.1, 0.1, -0.2, 0.2, -0.3, 0.3]) {
      const center = middle + span * fraction;
      if (Math.abs(center) > half || !positions.some((p) => (axis === 'z' ? p[0] : p[2]) < center) || !positions.some((p) => (axis === 'z' ? p[0] : p[2]) > center)) continue;
      const corridor = axis === 'z' ? { minX: center - BANK / 2, maxX: center + BANK / 2, minZ: start, maxZ: end } :
        { minX: start, maxX: end, minZ: center - BANK / 2, maxZ: center + BANK / 2 };
      if (obstacles.some((box) => footprintsOverlap(corridor, box, 0.6))) continue;
      const river = makeTerrainRiver(plan, axis, center, start, end);
      const waterLevel = plan.terrain.waterLevel;
      if (waterLevel !== null && river.points.some((p) => p[1] + river.transform.position[1] <= waterLevel + 0.2)) continue;
      const edited = { ...river, meta: { ...river.meta, status: 'edited' as const } };
      return { plan: { ...plan, objects: [...plan.objects, edited], updatedAt: new Date().toISOString() },
        message: 'أُضيف نهر زخرفي بين بيوت التجمع التقريبي. لا يحفر الأرض ولا يضيف جسراً؛ قد يتقاطع مع الطرق.' };
    }
  }
  const routed = routeAroundObjects(plan, obstacles, { minX, maxX, minZ, maxZ });
  if (routed) {
    const edited = { ...routed, meta: { ...routed.meta, status: 'edited' as const } };
    return { plan: { ...plan, objects: [...plan.objects, edited], updatedAt: new Date().toISOString() },
      message: 'أُضيف نهر زخرفي متعرج بين بيوت التجمع التقريبي. لا يحفر الأرض ولا يضيف جسراً؛ قد يتقاطع مع الطرق.' };
  }
  throw new Error('لم أجد ممراً آمناً بين البيوت؛ لم يتغير العالم. أفسح المساحة أو عدّل العناصر ثم حاول.');
}
