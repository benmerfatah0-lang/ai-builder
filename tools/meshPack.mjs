/**
 * Flattens a glTF scene into one welded, vertex-coloured triangle mesh and packs
 * it into a compact binary blob.
 *
 * Why not ship the GLB as-is: three's `GLTFLoader` is ~50 KB of code, and the
 * models carry a scene graph, a material table, a skeleton and 32-bit floats for
 * what the map only ever draws as a still prop. So everything the renderer does
 * not consume is resolved here, at build time:
 *
 *   - node transforms are baked into the vertices (they matter: Quaternius
 *     geometry is authored in centimetres under a node scaled by 100),
 *   - every primitive's flat colour moves onto the vertices, so a whole model
 *     becomes a single geometry with a single draw call,
 *   - positions become 16-bit, normalised to the model's bounding box,
 *   - vertices that share a quantised position *and* a colour are welded.
 *
 * Some packs (Kenney's kits) have no per-material colour at all: every face
 * points into one shared `colormap.png` atlas. Those are baked too — the atlas is
 * sampled at each triangle's centroid and the result becomes the triangle's
 * vertex colour, which is why a Kenney house ends up with the same blob layout as
 * a Quaternius one.
 *
 * No normals (the loader recomputes flat ones), no UVs, no skin, no animation.
 * The 5.82 MB source set lands around 0.4 MB and needs no loader on the page.
 *
 * The blob layout is the contract with `src/game-map/models/pack.ts`:
 *
 *   u32  vertexCount
 *   u32  indexCount
 *   u16 x3 per vertex   positions, quantised to [0, 65535]
 *   u8  x3 per vertex   colour, the glTF base colour factor, linear space
 *   u16 per index       triangles
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_TYPE = {
  5120: { read: (b, o) => b.readInt8(o), size: 1, max: 127 },
  5121: { read: (b, o) => b.readUInt8(o), size: 1, max: 255 },
  5122: { read: (b, o) => b.readInt16LE(o), size: 2, max: 32767 },
  5123: { read: (b, o) => b.readUInt16LE(o), size: 2, max: 65535 },
  5125: { read: (b, o) => b.readUInt32LE(o), size: 4, max: 4294967295 },
  5126: { read: (b, o) => b.readFloatLE(o), size: 4, max: 1 },
};

/** Reads a GLB file into its JSON and BIN parts. */
export function openGlb(path) {
  const glb = readFileSync(path);
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength;
  const binLength = glb.readUInt32LE(binStart);
  const bin = glb.subarray(binStart + 8, binStart + 8 + binLength);
  return { json, bin, dir: dirname(path) };
}

/**
 * Decodes an image from a glTF to straight RGBA bytes.
 *
 * Kenney ships its atlas as a sidecar PNG next to the model, relative to the GLB;
 * embedded images sit in the BIN chunk. Both end up here, because a texture the
 * packer cannot read is a model that would bake out flat white.
 */
async function loadImage(json, bin, index, dir) {
  const image = json.images?.[index];
  if (!image) return null;
  let bytes;
  if (image.bufferView !== undefined) {
    const view = json.bufferViews?.[image.bufferView];
    if (!view) return null;
    const start = view.byteOffset ?? 0;
    bytes = bin.subarray(start, start + view.byteLength);
  } else if (image.uri?.startsWith('data:')) {
    bytes = Buffer.from(image.uri.slice(image.uri.indexOf(',') + 1), 'base64');
  } else if (image.uri) {
    bytes = readFileSync(join(dir, decodeURIComponent(image.uri)));
  } else return null;
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** sRGB byte to linear float: the blob stores linear, `vertexColors` expects linear. */
const srgbToLinear = (value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Nearest sample of an atlas with repeat wrapping, as linear RGB. */
function sampleAtlas(atlas, u, v) {
  const x = Math.floor(((u % 1) + 1) % 1 * atlas.width) % atlas.width;
  const y = Math.floor(((v % 1) + 1) % 1 * atlas.height) % atlas.height;
  const offset = (y * atlas.width + x) * atlas.channels;
  return [
    srgbToLinear(atlas.data[offset]),
    srgbToLinear(atlas.data[offset + 1]),
    srgbToLinear(atlas.data[offset + 2]),
  ];
}

/** glTF node -> column-major 4x4 matrix. */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Column-major 4x4 multiply, `a * b`. */
function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[column * 4 + row] =
        a[row] * b[column * 4] +
        a[4 + row] * b[column * 4 + 1] +
        a[8 + row] * b[column * 4 + 2] +
        a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

/** Reads an accessor into a flat Float64Array of component-tuples. */
function readAccessor(json, bin, index) {
  const accessor = json.accessors?.[index];
  if (!accessor || accessor.sparse || accessor.bufferView === undefined) return null;
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const components = COMPONENTS[accessor.type];
  const type = COMPONENT_TYPE[accessor.componentType];
  if (!components || !type) return null;
  const stride = view.byteStride ?? components * type.size;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const data = new Float64Array(accessor.count * components);
  const scale = accessor.normalized && accessor.componentType !== 5126 ? 1 / type.max : 1;
  for (let vertex = 0; vertex < accessor.count; vertex += 1) {
    for (let axis = 0; axis < components; axis += 1) {
      data[vertex * components + axis] =
        type.read(bin, start + vertex * stride + axis * type.size) * scale;
    }
  }
  return { data, components, count: accessor.count };
}

/** Reads an index accessor into a Uint32Array. */
function readIndices(json, bin, index) {
  const accessor = json.accessors?.[index];
  if (!accessor || accessor.sparse) return null;
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const type = COMPONENT_TYPE[accessor.componentType];
  if (!type) return null;
  const stride = view.byteStride ?? type.size;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Uint32Array(accessor.count);
  for (let i = 0; i < accessor.count; i += 1) out[i] = type.read(bin, start + i * stride);
  return out;
}

/**
 * Every triangle of a glTF scene in scene space, tagged with a linear-space colour.
 *
 * @returns {{ triangles: { p: number[], colour: number[] }[], stats: object }}
 */
export async function flattenScene(json, bin, dir = '.') {
  const materials = (json.materials ?? []).map((mat) => {
    const factor = mat.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const source = mat.pbrMetallicRoughness?.baseColorTexture?.index;
    const image = source === undefined ? undefined : json.textures?.[source]?.source;
    return {
      colour: [clamp(factor[0]), clamp(factor[1]), clamp(factor[2])],
      alpha: factor[3] ?? 1,
      image,
    };
  });

  // Decode each atlas once, not once per primitive.
  const atlases = new Map();
  for (const material of materials) {
    if (material.image === undefined || atlases.has(material.image)) continue;
    atlases.set(material.image, await loadImage(json, bin, material.image, dir));
  }
  const nodes = json.nodes ?? [];
  const triangles = [];
  let skipped = 0;

  const visit = (index, parent, depth) => {
    const node = nodes[index];
    if (!node || depth > 64) return;
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
        if (prim.mode !== undefined && prim.mode !== 4) {
          skipped += 1;
          continue;
        }
        const material = materials[prim.material ?? -1] ?? { colour: [0.8, 0.8, 0.8], alpha: 1 };
        const read = readAccessor(json, bin, prim.attributes?.POSITION);
        if (!read || read.components !== 3 || material.alpha < 0.95) {
          skipped += 1;
          continue;
        }
        const atlas = material.image === undefined ? null : atlases.get(material.image);
        const uv = atlas ? readAccessor(json, bin, prim.attributes?.TEXCOORD_0) : null;
        const order = prim.indices !== undefined ? readIndices(json, bin, prim.indices) : null;
        const count = read.count;
        const vertices = new Float64Array(count * 3);
        for (let vertex = 0; vertex < count; vertex += 1) {
          const x = read.data[vertex * 3];
          const y = read.data[vertex * 3 + 1];
          const z = read.data[vertex * 3 + 2];
          vertices[vertex * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
          vertices[vertex * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
          vertices[vertex * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
        }
        const total = order ? order.length : count;
        for (let t = 0; t + 2 < total; t += 3) {
          const i0 = order ? order[t] : t;
          const i1 = order ? order[t + 1] : t + 1;
          const i2 = order ? order[t + 2] : t + 2;
          if (i0 === i1 || i1 === i2 || i0 === i2) continue;
          if (i0 >= count || i1 >= count || i2 >= count) continue;
          // Atlas colour is read at the centroid: Kenney's colormap is a grid of
          // flat cells, one per face, so the middle of a triangle is inside its
          // own cell and never on a seam.
          const colour = uv
            ? sampleAtlas(
                atlas,
                (uv.data[i0 * 2] + uv.data[i1 * 2] + uv.data[i2 * 2]) / 3,
                (uv.data[i0 * 2 + 1] + uv.data[i1 * 2 + 1] + uv.data[i2 * 2 + 1]) / 3,
              )
            : material.colour;
          triangles.push({
            p: [
              vertices[i0 * 3], vertices[i0 * 3 + 1], vertices[i0 * 3 + 2],
              vertices[i1 * 3], vertices[i1 * 3 + 1], vertices[i1 * 3 + 2],
              vertices[i2 * 3], vertices[i2 * 3 + 1], vertices[i2 * 3 + 2],
            ],
            colour,
          });
        }
      }
    }
    for (const child of node.children ?? []) visit(child, matrix, depth + 1);
  };

  for (const root of json.scenes?.[json.scene ?? 0]?.nodes ?? []) visit(root, IDENTITY, 0);
  if (!triangles.length) {
    const children = new Set(nodes.flatMap((node) => node.children ?? []));
    nodes.forEach((_, index) => {
      if (!children.has(index)) visit(index, IDENTITY, 0);
    });
  }
  return { triangles, stats: { triangles: triangles.length, skipped } };
}

const clamp = (value) => Math.min(1, Math.max(0, value));

/**
 * Welds, quantises and packs a flattened scene.
 *
 * Welding is exact: a vertex is shared only when its quantised position and its
 * colour both match, so no shading information can move between two parts of a
 * model. That matters because the colour lives on the vertex now.
 */
export function packScene({ triangles }) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const triangle of triangles) {
    for (let i = 0; i < 9; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        box.min[axis] = Math.min(box.min[axis], triangle.p[i + axis]);
        box.max[axis] = Math.max(box.max[axis], triangle.p[i + axis]);
      }
    }
  }
  // A zero-size axis (a flat rail, a decal) would divide by zero, so every axis
  // keeps a floor. The floor is far below one 16-bit step at map scale.
  const size = [0, 1, 2].map((axis) => Math.max(box.max[axis] - box.min[axis], 1e-4));
  const quantise = (value, axis) =>
    Math.max(0, Math.min(65535, Math.round(((value - box.min[axis]) / size[axis]) * 65535)));

  const lookup = new Map();
  const positions = [];
  const colours = [];
  const indices = [];
  const colourKey = (colour) =>
    `${Math.round(colour[0] * 255)},${Math.round(colour[1] * 255)},${Math.round(colour[2] * 255)}`;

  for (const triangle of triangles) {
    const key = colourKey(triangle.colour);
    for (let corner = 0; corner < 3; corner += 1) {
      const qx = quantise(triangle.p[corner * 3], 0);
      const qy = quantise(triangle.p[corner * 3 + 1], 1);
      const qz = quantise(triangle.p[corner * 3 + 2], 2);
      const id = `${qx}:${qy}:${qz}:${key}`;
      let slot = lookup.get(id);
      if (slot === undefined) {
        slot = positions.length / 3;
        if (slot > 65535) throw new Error('packed model exceeds 65535 welded vertices');
        lookup.set(id, slot);
        positions.push(qx, qy, qz);
        colours.push(
          Math.round(triangle.colour[0] * 255),
          Math.round(triangle.colour[1] * 255),
          Math.round(triangle.colour[2] * 255),
        );
      }
      indices.push(slot);
    }
  }

  const vertexCount = positions.length / 3;
  const total = 8 + vertexCount * 6 + vertexCount * 3 + indices.length * 2;
  const buffer = Buffer.alloc(total);
  buffer.writeUInt32LE(vertexCount, 0);
  buffer.writeUInt32LE(indices.length, 4);
  let cursor = 8;
  for (let i = 0; i < positions.length; i += 1) {
    buffer.writeUInt16LE(positions[i], cursor);
    cursor += 2;
  }
  for (let i = 0; i < colours.length; i += 1) {
    buffer.writeUInt8(colours[i], cursor);
    cursor += 1;
  }
  for (let i = 0; i < indices.length; i += 1) {
    buffer.writeUInt16LE(indices[i], cursor);
    cursor += 2;
  }

  return {
    data: buffer.toString('base64'),
    bytes: total,
    bounds: {
      min: box.min.map(round4),
      max: box.max.map(round4),
      size: size.map(round4),
      height: round4(box.max[1] - box.min[1]),
      footprint: round4(Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2])),
    },
    triangles: indices.length / 3,
    vertices: vertexCount,
  };
}

const round4 = (value) => Math.round(value * 10000) / 10000;
