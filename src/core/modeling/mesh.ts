import * as THREE from 'three';

/**
 * The mesh kernel of the modeling pipeline.
 *
 * Everything the pipeline builds — a staved barrel, a swept sword blade, a
 * lofted horse torso, a voussoir arch — is assembled here as plain typed arrays
 * with explicit normals, UVs and material slots. Two consequences matter:
 *
 * 1. Geometry stays a pure function of `(family, params, seed)`, so the
 *    WorldPlan document never stores vertices and a reload reproduces exactly
 *    the same model.
 * 2. The same data feeds the viewport, the LOD generator, the collision fitter
 *    and the OBJ/STL/GLB writers, so what you see is what exports.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** One material slot used by a run of triangles. Slots index `materials`. */
export interface MeshGroup {
  /** First index of the group. */
  start: number;
  /** Number of indices in the group (a multiple of 3). */
  count: number;
  /** Index into `MeshData.materials`. */
  material: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  groups: MeshGroup[];
  /** Material ids, one per slot. */
  materials: string[];
}

export interface MeshBounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
  center: Vec3;
}

export function emptyBounds(): MeshBounds {
  return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
}

export function boundsOf(data: MeshData): MeshBounds {
  if (data.positions.length === 0) return emptyBounds();
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < data.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = data.positions[index + axis]!;
      if (!Number.isFinite(value)) continue;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  if (!Number.isFinite(min[0])) return emptyBounds();
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
  };
}

/** True when every coordinate is finite and each index points at a vertex. */
export function isSane(data: MeshData): boolean {
  if (data.indices.length < 3) return false;
  for (let index = 0; index < data.positions.length; index += 1) {
    if (!Number.isFinite(data.positions[index]!)) return false;
  }
  for (let index = 0; index < data.normals.length; index += 1) {
    if (!Number.isFinite(data.normals[index]!)) return false;
  }
  for (let index = 0; index < data.uvs.length; index += 1) {
    if (!Number.isFinite(data.uvs[index]!)) return false;
  }
  const vertices = data.positions.length / 3;
  for (let index = 0; index < data.indices.length; index += 1) {
    const value = data.indices[index]!;
    if (!Number.isInteger(value) || value < 0 || value >= vertices) return false;
  }
  let covered = 0;
  for (const group of data.groups) {
    if (group.start < 0 || group.count <= 0 || group.start + group.count > data.indices.length) return false;
    if (group.material < 0 || group.material >= Math.max(1, data.materials.length)) return false;
    covered += group.count;
  }
  return covered === data.indices.length;
}

/**
 * Accumulates vertices, triangles and per-triangle material slots.
 *
 * Builders append primitives and components into one builder, then call
 * `build()` once. Groups are derived at build time from runs of equal material,
 * which is how a whole house ends up as one draw call per surface instead of one
 * per part.
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];
  /** One material slot per triangle, parallel to `indices` in steps of three. */
  private readonly triangleMaterials: number[] = [];
  private readonly materials: string[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  get materialCount(): number {
    return this.materials.length;
  }

  /** Index of a material id, appending a slot the first time it is seen. */
  materialSlot(id: string): number {
    const existing = this.materials.indexOf(id);
    if (existing >= 0) return existing;
    this.materials.push(id);
    return this.materials.length - 1;
  }

  /** Adds one vertex and returns its index. */
  vertex(point: Vec3, uv: Vec2 = [0, 0], normal: Vec3 = [0, 1, 0]): number {
    const index = this.positions.length / 3;
    this.positions.push(point[0], point[1], point[2]);
    this.normals.push(normal[0], normal[1], normal[2]);
    this.uvs.push(uv[0], uv[1]);
    return index;
  }

  /** Overwrites the UV of an existing vertex (caps re-plan their UVs). */
  setUv(index: number, uv: Vec2): void {
    this.uvs[index * 2] = uv[0];
    this.uvs[index * 2 + 1] = uv[1];
  }

  /** Overwrites the position of an existing vertex. */
  setPosition(index: number, point: Vec3): void {
    this.positions[index * 3] = point[0];
    this.positions[index * 3 + 1] = point[1];
    this.positions[index * 3 + 2] = point[2];
  }

  /** Reads back a position, for displacement and post-processing passes. */
  positionAt(index: number): Vec3 {
    return [this.positions[index * 3] ?? 0, this.positions[index * 3 + 1] ?? 0, this.positions[index * 3 + 2] ?? 0];
  }

  normalAt(index: number): Vec3 {
    return [this.normals[index * 3] ?? 0, this.normals[index * 3 + 1] ?? 1, this.normals[index * 3 + 2] ?? 0];
  }

  /** Every triangle's material slot, so passes can rebuild groups exactly. */
  materialOf(triangle: number): number {
    return this.triangleMaterials[triangle] ?? 0;
  }

  triangleCountAt(): number {
    return this.triangleMaterials.length;
  }

  triangle(a: number, b: number, c: number, material = 0): void {
    if (a === b || b === c || a === c) return;
    this.indices.push(a, b, c);
    this.triangleMaterials.push(material);
  }

  /** Two triangles `(a,b,c)` and `(a,c,d)`; the caller keeps the winding. */
  quad(a: number, b: number, c: number, d: number, material = 0): void {
    this.triangle(a, b, c, material);
    this.triangle(a, c, d, material);
  }

  /** Triangle fan from `apex` over an ordered ring; used for cones and caps. */
  fan(ring: readonly number[], apex: number, material = 0, flip = false): void {
    for (let index = 0; index + 1 < ring.length; index += 1) {
      const a = ring[index]!;
      const b = ring[index + 1]!;
      if (flip) this.triangle(apex, b, a, material);
      else this.triangle(apex, a, b, material);
    }
  }

  /**
   * Appends another mesh.
   *
   * `material` overrides every slot of the part (a whole component sharing one
   * surface); otherwise the part's material ids merge into this builder's slot
   * list, so two oak parts become one draw call.
   */
  add(part: MeshData | MeshBuilder, matrix?: THREE.Matrix4 | null, material?: string): this {
    const data = part instanceof MeshBuilder ? part.build() : part;
    if (data.indices.length === 0) return this;
    const base = this.positions.length / 3;
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : null;
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let index = 0; index < data.positions.length; index += 3) {
      point.set(data.positions[index]!, data.positions[index + 1]!, data.positions[index + 2]!);
      if (matrix) point.applyMatrix4(matrix);
      this.positions.push(point.x, point.y, point.z);
      normal.set(data.normals[index] ?? 0, data.normals[index + 1] ?? 1, data.normals[index + 2] ?? 0);
      if (normalMatrix) normal.applyMatrix3(normalMatrix);
      const length = Math.hypot(normal.x, normal.y, normal.z);
      if (length < 1e-6) normal.set(0, 1, 0);
      else normal.multiplyScalar(1 / length);
      this.normals.push(normal.x, normal.y, normal.z);
      this.uvs.push(data.uvs[(index / 3) * 2] ?? 0, data.uvs[(index / 3) * 2 + 1] ?? 0);
    }

    const slotCache = new Map<number, number>();
    const slotFor = (source: number): number => {
      const cached = slotCache.get(source);
      if (cached !== undefined) return cached;
      const id = material ?? data.materials[source] ?? 'default';
      const slot = this.materialSlot(id);
      slotCache.set(source, slot);
      return slot;
    };

    const materialOfIndex = (index: number): number => {
      for (const group of data.groups) {
        if (index >= group.start && index < group.start + group.count) return group.material;
      }
      return 0;
    };

    for (let index = 0; index < data.indices.length; index += 3) {
      const slot = slotFor(materialOfIndex(index));
      this.triangle(base + data.indices[index]!, base + data.indices[index + 1]!, base + data.indices[index + 2]!, slot);
    }
    return this;
  }

  /** Applies a matrix in place, to positions and normals. */
  transform(matrix: THREE.Matrix4): this {
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let index = 0; index < this.positions.length; index += 3) {
      point.set(this.positions[index]!, this.positions[index + 1]!, this.positions[index + 2]!).applyMatrix4(matrix);
      this.positions[index] = point.x;
      this.positions[index + 1] = point.y;
      this.positions[index + 2] = point.z;
      normal.set(this.normals[index]!, this.normals[index + 1]!, this.normals[index + 2]!).applyMatrix3(normalMatrix);
      const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
      this.normals[index] = normal.x / length;
      this.normals[index + 1] = normal.y / length;
      this.normals[index + 2] = normal.z / length;
    }
    return this;
  }

  translate(x: number, y: number, z: number): this {
    return this.transform(new THREE.Matrix4().makeTranslation(x, y, z));
  }

  /** Uniform when given one argument. */
  scale(x: number, y = x, z = y): this {
    return this.transform(new THREE.Matrix4().makeScale(x, y, z));
  }

  rotateX(angle: number): this {
    return this.transform(new THREE.Matrix4().makeRotationX(angle));
  }

  rotateY(angle: number): this {
    return this.transform(new THREE.Matrix4().makeRotationY(angle));
  }

  rotateZ(angle: number): this {
    return this.transform(new THREE.Matrix4().makeRotationZ(angle));
  }

  /** Mirrors across an axis and flips winding so normals stay outward. */
  mirror(axis: 'x' | 'y' | 'z'): this {
    const component = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    for (let index = 0; index < this.positions.length; index += 3) {
      this.positions[index + component] = -this.positions[index + component]!;
      this.normals[index + component] = -this.normals[index + component]!;
    }
    for (let index = 0; index < this.indices.length; index += 3) {
      const b = this.indices[index + 1]!;
      this.indices[index + 1] = this.indices[index + 2]!;
      this.indices[index + 2] = b;
    }
    return this;
  }

  bounds(): MeshBounds {
    return boundsOf(this.build());
  }

  /** Recomputes smooth normals from the triangles, area-weighted. */
  computeNormals(): this {
    const sums = new Float64Array(this.positions.length);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const face = new THREE.Vector3();
    for (let index = 0; index < this.indices.length; index += 3) {
      const ia = this.indices[index]! * 3;
      const ib = this.indices[index + 1]! * 3;
      const ic = this.indices[index + 2]! * 3;
      a.set(this.positions[ia]!, this.positions[ia + 1]!, this.positions[ia + 2]!);
      b.set(this.positions[ib]!, this.positions[ib + 1]!, this.positions[ib + 2]!);
      c.set(this.positions[ic]!, this.positions[ic + 1]!, this.positions[ic + 2]!);
      edge1.subVectors(b, a);
      edge2.subVectors(c, a);
      face.crossVectors(edge1, edge2);
      for (const offset of [ia, ib, ic]) {
        sums[offset] = (sums[offset] ?? 0) + face.x;
        sums[offset + 1] = (sums[offset + 1] ?? 0) + face.y;
        sums[offset + 2] = (sums[offset + 2] ?? 0) + face.z;
      }
    }
    for (let index = 0; index < this.normals.length; index += 3) {
      const x = sums[index] ?? 0;
      const y = sums[index + 1] ?? 0;
      const z = sums[index + 2] ?? 0;
      const length = Math.hypot(x, y, z);
      if (length < 1e-9) continue;
      this.normals[index] = x / length;
      this.normals[index + 1] = y / length;
      this.normals[index + 2] = z / length;
    }
    return this;
  }

  /** Drops vertices closer than `tolerance` and merges their indices. */
  weld(tolerance = 1e-4): this {
    if (this.positions.length === 0) return this;
    const cell = Math.max(1e-6, tolerance);
    const seen = new Map<string, number>();
    const remap = new Int32Array(this.vertexCount);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (let index = 0; index < this.vertexCount; index += 1) {
      const x = this.positions[index * 3]!;
      const y = this.positions[index * 3 + 1]!;
      const z = this.positions[index * 3 + 2]!;
      const u = this.uvs[index * 2]!;
      const v = this.uvs[index * 2 + 1]!;
      // UVs join the key: a box corner belongs to three faces with three UVs and
      // welding them together would smear every texture.
      const key = `${Math.round(x / cell)}|${Math.round(y / cell)}|${Math.round(z / cell)}|${u.toFixed(4)}|${v.toFixed(4)}`;
      const existing = seen.get(key);
      if (existing !== undefined) {
        remap[index] = existing;
        continue;
      }
      const next = positions.length / 3;
      seen.set(key, next);
      remap[index] = next;
      positions.push(x, y, z);
      normals.push(this.normals[index * 3]!, this.normals[index * 3 + 1]!, this.normals[index * 3 + 2]!);
      uvs.push(u, v);
    }
    this.positions.length = 0;
    this.normals.length = 0;
    this.uvs.length = 0;
    this.positions.push(...positions);
    this.normals.push(...normals);
    this.uvs.push(...uvs);
    for (let index = 0; index < this.indices.length; index += 1) {
      this.indices[index] = remap[this.indices[index]!] ?? 0;
    }
    this.dropDegenerate();
    return this;
  }

  /** Removes triangles whose indices collapsed onto each other after welding. */
  private dropDegenerate(): void {
    const indices: number[] = [];
    const materials: number[] = [];
    for (let index = 0; index < this.indices.length; index += 3) {
      const a = this.indices[index]!;
      const b = this.indices[index + 1]!;
      const c = this.indices[index + 2]!;
      if (a === b || b === c || a === c) continue;
      indices.push(a, b, c);
      materials.push(this.triangleMaterials[index / 3] ?? 0);
    }
    this.indices.length = 0;
    this.indices.push(...indices);
    this.triangleMaterials.length = 0;
    this.triangleMaterials.push(...materials);
  }

  /**
   * Splits every triangle onto its own three vertices with a face normal.
   *
   * Faceted shading is what makes rock read as rock and crystal as crystal: a
   * welded mesh smooths across a hard edge and turns a boulder into a blob. It
   * also lowers the triangle budget visibly at coarse LODs, where facets hide the
   * decimation.
   */
  flatShade(): this {
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const materials: number[] = [];
    const ax = new THREE.Vector3();
    const bx = new THREE.Vector3();
    const cx = new THREE.Vector3();
    const edge1 = new THREE.Vector3();
    const edge2 = new THREE.Vector3();
    const face = new THREE.Vector3();
    for (let triangle = 0; triangle < this.indices.length / 3; triangle += 1) {
      const first = this.indices[triangle * 3]!;
      const second = this.indices[triangle * 3 + 1]!;
      const third = this.indices[triangle * 3 + 2]!;
      const corners = [first, second, third];
      const at = (corner: number): [number, number, number] => [
        this.positions[corner * 3] ?? 0,
        this.positions[corner * 3 + 1] ?? 0,
        this.positions[corner * 3 + 2] ?? 0,
      ];
      ax.set(...at(first));
      bx.set(...at(second));
      cx.set(...at(third));
      edge1.subVectors(bx, ax);
      edge2.subVectors(cx, ax);
      face.crossVectors(edge1, edge2);
      if (face.lengthSq() < 1e-18) continue;
      face.normalize();
      const base = positions.length / 3;
      for (const corner of corners) {
        positions.push(this.positions[corner * 3]!, this.positions[corner * 3 + 1]!, this.positions[corner * 3 + 2]!);
        normals.push(face.x, face.y, face.z);
        uvs.push(this.uvs[corner * 2]!, this.uvs[corner * 2 + 1]!);
      }
      indices.push(base, base + 1, base + 2);
      materials.push(this.triangleMaterials[triangle] ?? 0);
    }
    this.positions.length = 0;
    this.normals.length = 0;
    this.uvs.length = 0;
    this.indices.length = 0;
    this.triangleMaterials.length = 0;
    this.positions.push(...positions);
    this.normals.push(...normals);
    this.uvs.push(...uvs);
    this.indices.push(...indices);
    this.triangleMaterials.push(...materials);
    return this;
  }

  /** Forces every triangle into one material slot. */
  assignMaterial(id: string): this {
    const slot = this.materialSlot(id);
    for (let index = 0; index < this.triangleMaterials.length; index += 1) this.triangleMaterials[index] = slot;
    return this;
  }

  build(): MeshData {
    const groups: MeshGroup[] = [];
    for (let triangle = 0; triangle < this.triangleMaterials.length; triangle += 1) {
      const material = this.triangleMaterials[triangle] ?? 0;
      const last = groups[groups.length - 1];
      if (last && last.material === material) last.count += 3;
      else groups.push({ start: triangle * 3, count: 3, material });
    }
    return {
      positions: new Float32Array(this.positions),
      normals: new Float32Array(this.normals),
      uvs: new Float32Array(this.uvs),
      indices: new Uint32Array(this.indices),
      groups,
      materials: [...this.materials],
    };
  }

  /** Three.js geometry with one draw group per material run. */
  toGeometry(): THREE.BufferGeometry {
    return geometryFromData(this.build());
  }
}

export function geometryFromData(data: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.clearGroups();
  for (const group of data.groups) geometry.addGroup(group.start, group.count, group.material);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Reads a THREE geometry (downloaded or cloud-generated) back into kernel data. */
export function dataFromGeometry(geometry: THREE.BufferGeometry, materialIds: string[] = ['default']): MeshData {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute('position') as THREE.BufferAttribute | undefined;
  const normal = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const uv = source.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const count = position?.count ?? 0;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = position?.getX(index) ?? 0;
    positions[index * 3 + 1] = position?.getY(index) ?? 0;
    positions[index * 3 + 2] = position?.getZ(index) ?? 0;
    normals[index * 3] = normal?.getX(index) ?? 0;
    normals[index * 3 + 1] = normal?.getY(index) ?? 1;
    normals[index * 3 + 2] = normal?.getZ(index) ?? 0;
    uvs[index * 2] = uv?.getX(index) ?? 0;
    uvs[index * 2 + 1] = uv?.getY(index) ?? 0;
  }
  const indices = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) indices[index] = index;
  if (source !== geometry) source.dispose();
  return {
    positions,
    normals,
    uvs,
    indices,
    groups: count ? [{ start: 0, count, material: 0 }] : [],
    materials: materialIds.length ? [...materialIds] : ['default'],
  };
}

/**
 * Triangulates a simple polygon (concave allowed, no holes) by ear clipping.
 *
 * Caps of extrusions and lofted sections need real triangulation: a fan from
 * vertex 0 folds over itself on any L-shaped or star-shaped profile. Returned
 * indices refer to the original point order.
 */
export function triangulatePolygon(points: readonly Vec2[]): number[] {
  const count = points.length;
  if (count < 3) return [];
  const clockwise = signedArea(points) < 0;
  const order: number[] = [];
  for (let index = 0; index < count; index += 1) order.push(index);
  if (clockwise) order.reverse();
  const triangles: number[] = [];
  const limit = count * count + 32;
  let guard = 0;
  while (order.length > 3 && guard < limit) {
    guard += 1;
    let clipped = false;
    for (let index = 0; index < order.length; index += 1) {
      const previous = order[(index + order.length - 1) % order.length]!;
      const current = order[index]!;
      const next = order[(index + 1) % order.length]!;
      if (!isEar(points, order, previous, current, next)) continue;
      triangles.push(previous, current, next);
      order.splice(index, 1);
      clipped = true;
      break;
    }
    // A self-touching profile can have no ear; stop rather than spin.
    if (!clipped) break;
  }
  if (order.length === 3) triangles.push(order[0]!, order[1]!, order[2]!);
  return triangles;
}

export function signedArea(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    total += a[0] * b[1] - b[0] * a[1];
  }
  return total / 2;
}

function isEar(points: readonly Vec2[], order: readonly number[], previous: number, current: number, next: number): boolean {
  const a = points[previous]!;
  const b = points[current]!;
  const c = points[next]!;
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (cross <= 1e-12) return false;
  for (const index of order) {
    if (index === previous || index === current || index === next) continue;
    if (pointInTriangle(points[index]!, a, b, c)) return false;
  }
  return true;
}

function pointInTriangle(point: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const side = (p: Vec2, q: Vec2, r: Vec2) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = side(point, a, b);
  const d2 = side(point, b, c);
  const d3 = side(point, c, a);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}
