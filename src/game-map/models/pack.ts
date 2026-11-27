/**
 * Unpacks the model blobs written by `tools/meshPack.mjs`.
 *
 * The models are baked, not loaded: no `GLTFLoader`, no scene graph, no network.
 * Each model is one welded, vertex-coloured triangle mesh, so it is one
 * `BufferGeometry`, one material and one draw call. That is also what makes the
 * crops cheap: a thousand wheat stalks are a thousand matrix pushes against a
 * geometry that ships once.
 *
 * Layout, all integers little-endian (see `tools/meshPack.mjs`):
 *
 *   u32   vertexCount
 *   u32   indexCount
 *   u16[] positions   x, y, z per vertex, quantised to [0, 65535]
 *   u8[]  colours     r, g, b per vertex, the glTF base colour factor
 *   u16[] indices     per triangle
 *
 * Positions come back in the model's own units. The vertex data is left
 * untouched while the *holder* shifts by the bounding-box origin, so the model's
 * base sits on y = 0 and its footprint is centred on the origin: drop it on
 * terrain at (x, z) and it stands up.
 */
import * as THREE from 'three';
import { MODELS, MODEL_NAMES, type ModelEntry } from './generated';

export type { ModelEntry };
export { MODELS, MODEL_NAMES };

/** A loaded model: one geometry, ready to clone or instance into the scene. */
export interface LoadedModel {
  /** Holder with the origin at the model's base, centred on its footprint. */
  group: THREE.Group;
  /** The single mesh, shared by every clone and instance. */
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Height in the model's own units. */
  height: number;
  /** Larger of width and depth, in the model's own units. */
  footprint: number;
  /** Width, height and depth, in its own units. */
  size: THREE.Vector3;
  triangles: number;
  vertices: number;
}

const cache = new Map<string, LoadedModel>();

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decodes base64 without `atob`.
 *
 * `atob` exists in every browser, but not in every bundler or worker context,
 * and a hand-rolled decoder costs forty lines and has no globals to depend on.
 */
export function decodeBase64(data: string): Uint8Array {
  const lookup = new Uint8Array(128);
  for (let index = 0; index < BASE64_CHARS.length; index += 1) {
    lookup[BASE64_CHARS.charCodeAt(index)] = index;
  }
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  const length = Math.floor((data.length / 4) * 3) - padding;
  const out = new Uint8Array(length);
  let write = 0;
  for (let index = 0; index < data.length; index += 4) {
    const a = lookup[data.charCodeAt(index)] ?? 0;
    const b = lookup[data.charCodeAt(index + 1)] ?? 0;
    const c = lookup[data.charCodeAt(index + 2)] ?? 0;
    const d = lookup[data.charCodeAt(index + 3)] ?? 0;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (write < length) out[write++] = (triple >> 16) & 0xff;
    if (write < length) out[write++] = (triple >> 8) & 0xff;
    if (write < length) out[write++] = triple & 0xff;
  }
  return out;
}

/** Unpacks one model blob into a geometry. */
export function unpackModel(entry: ModelEntry): LoadedModel {
  const bytes = decodeBase64(entry.data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vertexCount = view.getUint32(0, true);
  const indexCount = view.getUint32(4, true);
  const positionStart = 8;
  const colourStart = positionStart + vertexCount * 6;
  const indexStart = colourStart + vertexCount * 3;

  const { min, size } = entry.bounds;
  const positions = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    positions[vertex * 3] = min[0] + (view.getUint16(positionStart + vertex * 6, true) / 65535) * size[0];
    positions[vertex * 3 + 1] = min[1] + (view.getUint16(positionStart + vertex * 6 + 2, true) / 65535) * size[1];
    positions[vertex * 3 + 2] = min[2] + (view.getUint16(positionStart + vertex * 6 + 4, true) / 65535) * size[2];
  }
  const colours = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    colours[vertex * 3] = view.getUint8(colourStart + vertex * 3) / 255;
    colours[vertex * 3 + 1] = view.getUint8(colourStart + vertex * 3 + 1) / 255;
    colours[vertex * 3 + 2] = view.getUint8(colourStart + vertex * 3 + 2) / 255;
  }
  const indices = new Uint16Array(indexCount);
  for (let index = 0; index < indexCount; index += 1) {
    indices[index] = view.getUint16(indexStart + index * 2, true);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    // The colours in the blob are linear, which is what `vertexColors` expects.
    roughness: 0.93,
    metalness: 0,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `model-${entry.name}`;

  // Shift by the bounding-box origin instead of rewriting the shared vertex
  // data, so every clone keeps one geometry.
  const inner = new THREE.Group();
  inner.position.set(-(min[0] + size[0] / 2), -min[1], -(min[2] + size[2] / 2));
  inner.add(mesh);
  const holder = new THREE.Group();
  holder.name = `model-${entry.name}`;
  holder.add(inner);

  return {
    group: holder,
    geometry,
    material,
    height: size[1],
    footprint: Math.max(size[0], size[2]),
    size: new THREE.Vector3(size[0], size[1], size[2]),
    triangles: entry.triangles,
    vertices: vertexCount,
  };
}

/** Returns a cached model by name, or null when the name is not in the pack. */
export function getModel(name: string): LoadedModel | null {
  const cached = cache.get(name);
  if (cached) return cached;
  const entry = MODELS[name];
  if (!entry) return null;
  const model = unpackModel(entry);
  cache.set(name, model);
  return model;
}

/**
 * A fresh copy of a model, scaled to a target height and standing on y = 0.
 *
 * The clone shares geometry and material with the cache; only the transform is
 * new. That is the whole reason a packed model is one mesh: cloning is cheap.
 */
export function modelInstance(
  name: string,
  options: { height?: number; scale?: number; rotation?: number } = {},
): THREE.Group | null {
  const model = getModel(name);
  if (!model) return null;
  const instance = model.group.clone(true);
  const scale = options.scale ?? (options.height ? options.height / model.height : 1);
  instance.scale.setScalar(scale);
  instance.rotation.y = options.rotation ?? 0;
  return instance;
}

/** Geometry and material for instancing a model a few hundred times. */
export function modelPrototype(name: string): { geometry: THREE.BufferGeometry; material: THREE.Material } | null {
  const model = getModel(name);
  if (!model) return null;
  return { geometry: model.geometry, material: model.material };
}
