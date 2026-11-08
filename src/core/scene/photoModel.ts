import * as THREE from 'three';
import type { PhotoModel } from '../world-plan/schema';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Bounded render cache: repeated copies and transient construction frames often
// use identical silhouettes. Return clones so disposing a scene cannot corrupt it.
const smoothCache = new Map<string, { geometry: THREE.BufferGeometry; bytes: number }>();
let smoothCacheBytes = 0;
const MAX_SMOOTH_CACHE_BYTES = 4 * 1024 * 1024;
function cachedSmoothGeometry(model: PhotoModel, cells: PhotoModel['cells']): THREE.BufferGeometry {
  const key = `${model.width}x${model.height}:` + cells.map((c) => `${c.x},${c.y},${c.depth},${c.color}`).join(';');
  const cached = smoothCache.get(key);
  if (cached) { smoothCache.delete(key); smoothCache.set(key, cached); return cached.geometry.clone(); }
  const geometry = buildSmoothPhotoModelGeometry(model, cells);
  const bytes = Object.values(geometry.attributes).reduce((sum, attribute) => sum + attribute.array.byteLength, 0) + (geometry.index?.array.byteLength ?? 0);
  if (cells.length && bytes <= MAX_SMOOTH_CACHE_BYTES) {
    while (smoothCache.size >= 12 || smoothCacheBytes + bytes > MAX_SMOOTH_CACHE_BYTES) {
      const first = smoothCache.entries().next().value as [string, { geometry: THREE.BufferGeometry; bytes:number }] | undefined;
      if (!first) break;
      smoothCache.delete(first[0]); smoothCacheBytes -= first[1].bytes; first[1].geometry.dispose();
    }
    smoothCache.set(key, { geometry, bytes }); smoothCacheBytes += bytes;
    return geometry.clone();
  }
  return geometry;
}

/** Build a smooth or voxel-like colored shell; depth and the mirrored back are guesses. */
export function buildPhotoModelGeometry(model: PhotoModel, cells = model.cells): THREE.BufferGeometry {
  if (model.meshStyle === 'smooth' && model.mode !== 'full-image-slab') return cachedSmoothGeometry(model, cells);
  const unit = 4 / Math.max(model.width, model.height);
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const indexedCube = new THREE.BoxGeometry(1, 1, 1);
  const cube = indexedCube.toNonIndexed();
  indexedCube.dispose();
  const p = cube.getAttribute('position'), n = cube.getAttribute('normal');
  for (const cell of cells) {
    const depth = unit * (0.8 + cell.depth * 0.45);
    const x = (cell.x + 0.5 - model.width / 2) * unit;
    const y = (model.height - cell.y - 0.5) * unit;
    const color = new THREE.Color(cell.color);
    for (let i = 0; i < p.count; i++) {
      positions.push(x + p.getX(i) * unit, y + p.getY(i) * unit, p.getZ(i) * depth);
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      colors.push(color.r, color.g, color.b);
    }
  }
  cube.dispose();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A bounded, interpolated double-sided height field with rounded silhouette edges.
 * This is still a symmetric guess from one view, not recovered 3D geometry. */
function buildSmoothPhotoModelGeometry(model: PhotoModel, cells: PhotoModel['cells']): THREE.BufferGeometry {
  const width = model.width, height = model.height, unit = 4 / Math.max(width, height);
  const lookup = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, { ...cell, rgb: new THREE.Color(cell.color) }]));
  type Point = { x: number; y: number; coverage: number };
  const sampleCache = new Map<string, { coverage:number; depth:number; r:number; g:number; b:number }>();
  const sample = (x: number, y: number) => {
    const key = `${x},${y}`;
    const cached = sampleCache.get(key);
    if (cached) return cached;
    const ix = Math.floor(x - .5), iy = Math.floor(y - .5), fx = x - .5 - ix, fy = y - .5 - iy;
    let coverage = 0, depth = 0, r = 0, g = 0, b = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const cell = lookup.get(`${ix + dx},${iy + dy}`);
      if (!cell) continue;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      coverage += weight; depth += cell.depth * weight;
      r += cell.rgb.r * weight; g += cell.rgb.g * weight; b += cell.rgb.b * weight;
    }
    const div = coverage || 1;
    const value = { coverage, depth: depth/div, r:r/div, g:g/div, b:b/div };
    sampleCache.set(key, value);
    return value;
  };
  const positions: number[] = [], colors: number[] = [];
  const threshold = .5;
  const vertexCache = new Map<string, {x:number; y:number; z:number; r:number; g:number; b:number}>();
  const vertex = (point: Point, back: boolean) => {
    const key = `${point.x},${point.y},${back}`;
    const cached = vertexCache.get(key);
    if (cached) return cached;
    const s = sample(point.x, point.y);
    const inflate = Math.max(0, Math.min(1, (s.coverage - threshold) * 2));
    const depth = unit * (.08 + (.32 + s.depth * .225) * inflate);
    const value = { x:(point.x - width/2)*unit, y:(height-point.y)*unit, z:back ? -depth : depth, r:s.r, g:s.g, b:s.b };
    vertexCache.set(key,value);
    return value;
  };
  type V = ReturnType<typeof vertex>;
  const triangle = (a: V, b: V, c: V) => {
    // Drop exact degeneracies created when an iso-line passes through a grid vertex.
    const abx=b.x-a.x, aby=b.y-a.y, abz=b.z-a.z, acx=c.x-a.x, acy=c.y-a.y, acz=c.z-a.z;
    if (Math.hypot(aby*acz-abz*acy, abz*acx-abx*acz, abx*acy-aby*acx) < 1e-9) return;
    for (const p of [a,b,c]) { positions.push(p.x,p.y,p.z); colors.push(p.r,p.g,p.b); }
  };
  const cut = (a: Point, b: Point): Point => {
    const t = (threshold-a.coverage)/(b.coverage-a.coverage);
    return { x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t, coverage:threshold };
  };
  const patch = (points: Point[]) => {
    const poly: Point[] = [];
    for (let i=0; i<3; i++) {
      const a=points[i]!, b=points[(i+1)%3]!, ai=a.coverage > threshold, bi=b.coverage > threshold;
      if (ai) poly.push(a);
      if (ai !== bi) poly.push(cut(a,b));
    }
    if (poly.length < 3) return;
    for (let i=1; i+1<poly.length; i++) {
      triangle(vertex(poly[0]!,false),vertex(poly[i]!,false),vertex(poly[i+1]!,false));
      triangle(vertex(poly[0]!,true),vertex(poly[i+1]!,true),vertex(poly[i]!,true));
    }
    for (let i=0; i<poly.length; i++) {
      const a=poly[i]!, b=poly[(i+1)%poly.length]!;
      if (Math.abs(a.coverage-threshold)>1e-8 || Math.abs(b.coverage-threshold)>1e-8) continue;
      const af=vertex(a,false), ab=vertex(a,true), bf=vertex(b,false), bb=vertex(b,true);
      triangle(af,ab,bb); triangle(af,bb,bf);
    }
  };
  // Twice the input resolution; bounded to at most 51×51 quads for a phone.
  for (let y=-1; y<height*2+1; y++) for (let x=-1; x<width*2+1; x++) {
    const point = (xx:number, yy:number): Point => ({ x:xx/2, y:yy/2, coverage:sample(xx/2,yy/2).coverage });
    const a=point(x,y), b=point(x,y+1), c=point(x+1,y+1), d=point(x+1,y);
    patch([a,b,c]); patch([a,c,d]);
  }
  const raw = new THREE.BufferGeometry();
  raw.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
  raw.setAttribute('color', new THREE.Float32BufferAttribute(colors,3));
  const geometry = mergeVertices(raw, 1e-5); raw.dispose();
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

export function photoModelDimensions(model: PhotoModel): [number, number, number] {
  const unit = 4 / Math.max(model.width, model.height);
  return [model.width * unit, model.height * unit, unit * (0.8 + Math.max(...model.cells.map((cell) => cell.depth)) * 0.45)];
}
