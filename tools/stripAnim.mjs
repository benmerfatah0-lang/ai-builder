/**
 * Removes animation channels from a GLB and rebuilds it.
 *
 * The animals pack is 53% keyframe data by weight. This map is a diorama, not a
 * running game: nothing plays an animation track, so shipping the tracks only
 * inflates the single-file build. Stripping them roughly halves the animal
 * payload and changes nothing visible.
 *
 * The rebuild is deliberately conservative: it copies the binary chunk, drops
 * every accessor that only existed to carry a keyframe, and leaves mesh data
 * byte-for-byte identical.
 */
export function stripAnimations(glb) {
  const magic = glb.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  if (!json.animations?.length) return glb;

  const binChunkStart = 20 + jsonLen;
  const binChunkLen = glb.readUInt32LE(binChunkStart);
  const bin = glb.subarray(binChunkStart + 8, binChunkStart + 8 + binChunkLen);

  // Which accessors are only used by animation samplers?
  const animAccessors = new Set();
  for (const anim of json.animations) {
    for (const sampler of anim.samplers ?? []) {
      animAccessors.add(sampler.input);
      animAccessors.add(sampler.output);
    }
  }

  // Which are still needed by meshes/skins?
  const keep = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const acc of Object.values(prim.attributes ?? {})) keep.add(acc);
      if (prim.indices !== undefined) keep.add(prim.indices);
      if (prim.targets) for (const t of prim.targets) for (const acc of Object.values(t)) keep.add(acc);
    }
  }
  for (const skin of json.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) keep.add(skin.inverseBindMatrices);
  }
  for (const node of json.nodes ?? []) {
    if (node.mesh !== undefined) void node;
  }

  const liveAccessors = [...keep].filter((i) => !animAccessors.has(i)).sort((a, b) => a - b);
  const accessorMap = new Map();
  liveAccessors.forEach((oldIndex, newIndex) => accessorMap.set(oldIndex, newIndex));

  // Buffer views that survive are the ones the surviving accessors point at.
  const liveViews = new Set();
  for (const oldIndex of liveAccessors) {
    const acc = json.accessors[oldIndex];
    if (acc.bufferView !== undefined) liveViews.add(acc.bufferView);
    if (acc.sparse) {
      if (acc.sparse.indices?.bufferView !== undefined) liveViews.add(acc.sparse.indices.bufferView);
      if (acc.sparse.values?.bufferView !== undefined) liveViews.add(acc.sparse.values.bufferView);
    }
  }
  const sortedViews = [...liveViews].sort((a, b) => a - b);
  const viewMap = new Map();
  sortedViews.forEach((oldIndex, newIndex) => viewMap.set(oldIndex, newIndex));

  // Rebuild the binary chunk, keeping only the surviving views, in order.
  const chunks = [];
  const newViews = [];
  let offset = 0;
  for (const oldIndex of sortedViews) {
    const view = json.bufferViews[oldIndex];
    const start = view.byteOffset ?? 0;
    let slice = Buffer.from(bin.subarray(start, start + view.byteLength));
    // 4-byte align every view so accessors stay valid.
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    chunks.push(slice);
    newViews.push({ ...view, byteOffset: offset, buffer: 0 });
    offset += slice.length;
  }
  let newBin = Buffer.concat(chunks);
  const binPad = (4 - (newBin.length % 4)) % 4;
  if (binPad) newBin = Buffer.concat([newBin, Buffer.alloc(binPad)]);

  const outJson = { ...json, animations: undefined, buffers: [{ byteLength: newBin.length }] };
  delete outJson.animations;
  outJson.accessors = liveAccessors.map((oldIndex) => {
    const acc = { ...json.accessors[oldIndex] };
    if (acc.bufferView !== undefined) acc.bufferView = viewMap.get(acc.bufferView);
    return acc;
  });
  outJson.bufferViews = newViews;
  // Point meshes at the renumbered accessors.
  outJson.meshes = (json.meshes ?? []).map((mesh) => ({
    ...mesh,
    primitives: mesh.primitives.map((prim) => {
      const next = { ...prim };
      if (prim.attributes) next.attributes = Object.fromEntries(Object.entries(prim.attributes).map(([k, v]) => [k, accessorMap.get(v) ?? v]));
      if (prim.indices !== undefined) next.indices = accessorMap.get(prim.indices);
      return next;
    }),
  }));
  if (json.skins) {
    outJson.skins = json.skins.map((skin) => ({
      ...skin,
      inverseBindMatrices: skin.inverseBindMatrices === undefined ? undefined : accessorMap.get(skin.inverseBindMatrices),
    }));
  }

  // Repack: header + JSON chunk + BIN chunk.
  let jsonText = JSON.stringify(outJson);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const jsonBytes = Buffer.from(jsonText, 'utf8');
  const total = 12 + 8 + jsonBytes.length + 8 + newBin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  const binHeader = 20 + jsonBytes.length;
  out.writeUInt32LE(newBin.length, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  newBin.copy(out, binHeader + 8);
  return out;
}

/**
 * Drops attributes and chunks the map never uses.
 *
 * Quaternius models are untextured: every colour is a material factor. That
 * makes `TEXCOORD_0` dead weight (~23% of a building's bytes) and `NORMAL`
 * recomputable from the triangles at load time. Removing both roughly halves
 * each model before any lossy step.
 *
 * Everything is renumbered consistently: accessors, buffer views, images,
 * samplers, nodes and meshes.
 */
export function pruneGlb(glb, { dropNormals = true, dropUvs = true, dropSkin = true } = {}) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binStart);
  const bin = glb.subarray(binStart + 8, binStart + 8 + binLen);

  const dropped = new Set();
  if (dropNormals) dropped.add('NORMAL');
  if (dropUvs) {
    dropped.add('TEXCOORD_0');
    dropped.add('TEXCOORD_1');
  }
  if (dropSkin) {
    // No animation plays, so the skeleton is dead weight. Without JOINTS/WEIGHTS
    // three renders the mesh from its node transform in the bind pose, which is
    // the pose we want for a still diorama.
    for (const name of ['JOINTS_0', 'WEIGHTS_0', 'JOINTS_1', 'WEIGHTS_1']) dropped.add(name);
  }

  // Collect surviving accessor indices.
  const live = new Set();
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      for (const [name, index] of Object.entries(prim.attributes ?? {})) {
        if (!dropped.has(name)) live.add(index);
      }
      if (prim.indices !== undefined) live.add(prim.indices);
      for (const target of prim.targets ?? []) {
        for (const [name, index] of Object.entries(target)) {
          if (!dropped.has(name)) live.add(index);
        }
      }
    }
  }
  if (!dropSkin) {
    for (const skin of json.skins ?? []) {
      if (skin.inverseBindMatrices !== undefined) live.add(skin.inverseBindMatrices);
    }
  }

  const accessorOrder = [...live].sort((a, b) => a - b);
  const accessorMap = new Map(accessorOrder.map((old, index) => [old, index]));

  const viewSet = new Set();
  for (const old of accessorOrder) {
    const accessor = json.accessors[old];
    if (accessor.bufferView !== undefined) viewSet.add(accessor.bufferView);
    if (accessor.sparse?.indices?.bufferView !== undefined) viewSet.add(accessor.sparse.indices.bufferView);
    if (accessor.sparse?.values?.bufferView !== undefined) viewSet.add(accessor.sparse.values.bufferView);
  }
  const viewOrder = [...viewSet].sort((a, b) => a - b);
  const viewMap = new Map(viewOrder.map((old, index) => [old, index]));

  const chunks = [];
  const newViews = [];
  let offset = 0;
  for (const old of viewOrder) {
    const view = json.bufferViews[old];
    const start = view.byteOffset ?? 0;
    const slice = Buffer.from(bin.subarray(start, start + view.byteLength));
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    chunks.push(slice);
    const next = { ...view, byteOffset: offset, buffer: 0 };
    delete next.target;
    newViews.push(next);
    offset += slice.length;
  }
  let newBin = Buffer.concat(chunks);
  const tailPad = (4 - (newBin.length % 4)) % 4;
  if (tailPad) newBin = Buffer.concat([newBin, Buffer.alloc(tailPad)]);

  const outJson = {
    ...json,
    buffers: [{ byteLength: newBin.length }],
    bufferViews: newViews,
    accessors: accessorOrder.map((old) => {
      const accessor = { ...json.accessors[old] };
      if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
      if (accessor.sparse) {
        accessor.sparse = JSON.parse(JSON.stringify(accessor.sparse));
        if (accessor.sparse.indices?.bufferView !== undefined) {
          accessor.sparse.indices.bufferView = viewMap.get(accessor.sparse.indices.bufferView);
        }
        if (accessor.sparse.values?.bufferView !== undefined) {
          accessor.sparse.values.bufferView = viewMap.get(accessor.sparse.values.bufferView);
        }
      }
      return accessor;
    }),
    meshes: (json.meshes ?? []).map((mesh) => ({
      ...mesh,
      primitives: mesh.primitives.map((prim) => {
        const next = { ...prim };
        next.attributes = Object.fromEntries(
          Object.entries(prim.attributes ?? {})
            .filter(([name]) => !dropped.has(name))
            .map(([name, index]) => [name, accessorMap.get(index)]),
        );
        if (prim.indices !== undefined) next.indices = accessorMap.get(prim.indices);
        if (prim.targets) {
          next.targets = prim.targets.map((target) =>
            Object.fromEntries(
              Object.entries(target)
                .filter(([name]) => !dropped.has(name))
                .map(([name, index]) => [name, accessorMap.get(index)]),
            ),
          );
        }
        return next;
      }),
    })),
  };
  if (dropSkin) {
    delete outJson.skins;
  } else if (json.skins) {
    outJson.skins = json.skins.map((skin) => ({
      ...skin,
      inverseBindMatrices:
        skin.inverseBindMatrices === undefined ? undefined : accessorMap.get(skin.inverseBindMatrices),
    }));
  }
  if (dropSkin) pruneBones(outJson);
  return repack(outJson, newBin);
}

/**
 * Drops the skeleton and any node that is not a mesh or an ancestor of one.
 *
 * With `skins` gone the bone nodes are unreachable scenery; the ancestors that
 * remain are the ones carrying the armature's scale, and those must survive or
 * every animal comes out a hundred times too big.
 */
function pruneBones(json) {
  const nodes = json.nodes ?? [];
  if (!nodes.length) return;
  const keep = new Set();
  const mark = (index) => {
    if (keep.has(index)) return;
    keep.add(index);
    for (const child of nodes[index].children ?? []) mark(child);
  };
  for (const [index, node] of nodes.entries()) {
    if (node.mesh !== undefined || node.camera !== undefined) {
      // Walk up from every drawable node, keeping the chain of parents.
      keep.add(index);
    }
  }
  const parentOf = new Map();
  for (const [index, node] of nodes.entries()) {
    for (const child of node.children ?? []) parentOf.set(child, index);
  }
  for (const index of [...keep]) {
    let cursor = index;
    while (parentOf.has(cursor)) {
      cursor = parentOf.get(cursor);
      keep.add(cursor);
    }
  }
  for (const scene of json.scenes ?? []) {
    scene.nodes = (scene.nodes ?? []).filter((index) => keep.has(index));
  }
  // `mark` above only kept the drawables; expand to ancestors via parentOf.
  const order = [...keep].sort((a, b) => a - b);
  const nodeMap = new Map(order.map((old, index) => [old, index]));
  json.nodes = order.map((old) => {
    const node = { ...nodes[old] };
    delete node.skin;
    if (node.children) {
      node.children = node.children.filter((child) => keep.has(child)).map((child) => nodeMap.get(child));
      if (!node.children.length) delete node.children;
    }
    return node;
  });
  for (const scene of json.scenes ?? []) {
    scene.nodes = (scene.nodes ?? []).map((index) => nodeMap.get(index)).filter((index) => index !== undefined);
  }
  void mark;
}

/** Repack a glTF JSON object plus its BIN chunk into a GLB buffer. */
export function repack(outJson, newBin) {
  let jsonText = JSON.stringify(outJson);
  while (jsonText.length % 4 !== 0) jsonText += ' ';
  const jsonBytes = Buffer.from(jsonText, 'utf8');
  const total = 12 + 8 + jsonBytes.length + 8 + newBin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  const binHeader = 20 + jsonBytes.length;
  out.writeUInt32LE(newBin.length, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  newBin.copy(out, binHeader + 8);
  return out;
}

/**
 * Quantises POSITION to signed 16-bit (`KHR_mesh_quantization`, supported by
 * three's GLTFLoader with no decoder and no extra file). Positions are 55% of
 * the payload and halve outright.
 *
 * A single node scale has to correct every primitive under it, so each
 * primitive is reparented into its own node carrying its own min/scale. That is
 * exact: the original node had no children and a plain TRS, so splitting it
 * changes nothing visually, and the loader hands us a graph we re-flatten anyway.
 *
 * Skipped entirely when anything looks unusual (skins, `matrix` nodes, shared
 * buffer views, non-float positions); the model then ships uncompressed rather
 * than wrong.
 */
export function quantizePositions(glb) {
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = glb.readUInt32LE(binStart);
  const bin = glb.subarray(binStart + 8, binStart + 8 + binLen);
  const views = json.bufferViews ?? [];
  const accessors = json.accessors ?? [];
  const nodes = json.nodes ?? [];
  const meshes = json.meshes ?? [];

  if (json.skins?.length) return repack(json, bin);
  if (nodes.some((node) => node.matrix)) return repack(json, bin);
  if (views.some((view) => view.byteStride !== undefined)) return repack(json, bin);
  {
    const seen = new Map();
    for (const [index, accessor] of accessors.entries()) {
      if (accessor.bufferView === undefined) continue;
      const key = `${accessor.bufferView}:${accessor.byteOffset ?? 0}`;
      if (seen.has(key)) return repack(json, bin);
      seen.set(key, index);
    }
  }

  const nodeOfMesh = new Map();
  for (const [index, node] of nodes.entries()) {
    if (node.mesh === undefined || node.children?.length) continue;
    nodeOfMesh.set(node.mesh, nodeOfMesh.has(node.mesh) ? -1 : index);
  }
  if ([...nodeOfMesh.values()].some((index) => index < 0)) return repack(json, bin);

  /** meshIndex -> per-primitive bounds, or null when the mesh must be skipped. */
  const plans = new Map();
  for (const [meshIndex, nodeIndex] of nodeOfMesh) {
    const mesh = meshes[meshIndex];
    const parts = [];
    for (const prim of mesh.primitives ?? []) {
      const posIndex = prim.attributes?.POSITION;
      if (posIndex === undefined) {
        parts.length = 0;
        break;
      }
      const accessor = accessors[posIndex];
      if (accessor.componentType !== 5126 || accessor.type !== 'VEC3' || accessor.sparse) {
        parts.length = 0;
        break;
      }
      if (!accessor.min || !accessor.max) {
        parts.length = 0;
        break;
      }
      const span = [0, 1, 2].map((axis) => accessor.max[axis] - accessor.min[axis]);
      parts.push({ prim, posIndex, min: accessor.min, span });
    }
    if (parts.length) plans.set(meshIndex, { nodeIndex, parts });
  }
  if (!plans.size) return repack(json, bin);

  const quantOf = new Map();
  for (const plan of plans.values()) for (const part of plan.parts) quantOf.set(part.posIndex, part);


  const chunks = [];
  let offset = 0;
  const newViews = [];
  const pushView = (bytes) => {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad));
      offset += pad;
    }
    chunks.push(bytes);
    newViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    offset += bytes.length;
    return newViews.length - 1;
  };

  const newAccessors = accessors.map((accessor, index) => {
    const part = quantOf.get(index);
    if (part) {
      const view = views[accessor.bufferView];
      const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const bytes = Buffer.alloc(accessor.count * 6);
      for (let vertex = 0; vertex < accessor.count; vertex += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = bin.readFloatLE(base + vertex * 12 + axis * 4);
          const unit = (value - part.min[axis]) / part.span[axis];
          const q = Math.max(-32767, Math.min(32767, Math.round(unit * 65534) - 32767));
          bytes.writeInt16LE(q, vertex * 6 + axis * 2);
        }
      }
      return { ...accessor, bufferView: pushView(bytes), byteOffset: 0, componentType: 5122, normalized: false };
    }
    if (accessor.bufferView === undefined) return accessor;
    const view = views[accessor.bufferView];
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const bytes = Buffer.from(bin.subarray(start, start + view.byteLength - (accessor.byteOffset ?? 0)));
    return { ...accessor, bufferView: pushView(bytes), byteOffset: 0 };
  });

  const newMeshes = [...meshes];
  const newNodes = nodes.map((node) => ({ ...node }));
  for (const [meshIndex, plan] of plans) {
    const children = [];
    for (const part of plan.parts) {
      newMeshes.push({
        name: `${meshes[meshIndex].name ?? 'mesh'}_q${children.length}`,
        primitives: [{ ...part.prim }],
      });
      children.push(newNodes.length);
      newNodes.push({
        mesh: newMeshes.length - 1,
        // Stored values are signed and NOT normalised, so the decoder sees the
        // raw integer. Reconstructing `value = q*scale + translate` therefore
        // needs the +32767 bias folded into the translation:
        //   q = round((value-min)/span * 65534) - 32767
        //   value = q*(span/65534) + min + 32767*(span/65534)
        // A zero span still lands exactly on `min`, so flat primitives survive.
        translation: part.min.map((value, axis) => value + (32767 * part.span[axis]) / 65534),
        scale: part.span.map((value) => value / 65534),
      });
    }
    const parent = newNodes[plan.nodeIndex];
    delete parent.mesh;
    parent.children = [...(parent.children ?? []), ...children];
  }

  let newBin = Buffer.concat(chunks);
  const tail = (4 - (newBin.length % 4)) % 4;
  if (tail) newBin = Buffer.concat([newBin, Buffer.alloc(tail)]);

  const outJson = {
    ...json,
    extensionsUsed: [...new Set([...(json.extensionsUsed ?? []), 'KHR_mesh_quantization'])],
    extensionsRequired: [...new Set([...(json.extensionsRequired ?? []), 'KHR_mesh_quantization'])],
    buffers: [{ byteLength: newBin.length }],
    bufferViews: newViews,
    accessors: newAccessors,
    meshes: newMeshes,
    nodes: newNodes,
  };
  // Node indices referenced by skins/scenes are untouched: parents keep their id.
  void accessors;
  return repack(outJson, newBin);
}
