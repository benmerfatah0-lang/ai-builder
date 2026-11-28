/**
 * Reads a Wavefront OBJ + MTL pair into the same triangle list the GLB reader
 * produces.
 *
 * Quaternius's farm-animal pack ships as FBX/OBJ only — no glTF — and its
 * colours are plain MTL materials, one `Kd` per group. That is exactly the
 * information this pipeline keeps (a flat colour per triangle), so the OBJ path
 * is thirty lines of parsing, not a conversion step with a Blender in the
 * middle.
 *
 * What is deliberately not supported: texture maps, smoothing groups, normals,
 * negative indices. The models we read have none of them, and the packer throws
 * away normals anyway.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Parses an MTL into `{ name: [r, g, b] }` in linear space (Blender writes Kd linear). */
function readMtl(path) {
  const colours = {};
  let current = null;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'newmtl') {
      current = parts.slice(1).join(' ');
      colours[current] = [0.8, 0.8, 0.8];
    } else if (parts[0] === 'Kd' && current) {
      colours[current] = [Number(parts[1]), Number(parts[2]), Number(parts[3])].map((value) =>
        Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0.8)),
      );
    }
  }
  return colours;
}

/** Reads an OBJ, resolving its MTL next to it. */
export function openObj(path) {
  const materialPath = (() => {
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((entry) => entry.trim().startsWith('mtllib'));
    return line ? join(dirname(path), line.trim().split(/\s+/)[1]) : null;
  })();
  let colours = {};
  try {
    if (materialPath) colours = readMtl(materialPath);
  } catch {
    colours = {};
  }

  const positions = [];
  const triangles = [];
  let colour = [0.8, 0.8, 0.8];

  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/);
      positions.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith('usemtl ')) {
      colour = colours[line.slice(7).trim()] ?? [0.8, 0.8, 0.8];
    } else if (line.startsWith('f ')) {
      const corners = line
        .slice(2)
        .trim()
        .split(/\s+/)
        .map((token) => Number.parseInt(token.split('/')[0], 10) - 1)
        .filter((index) => Number.isFinite(index) && index >= 0);
      // Fan triangulation: the packs only use triangles and quads.
      for (let corner = 1; corner + 1 < corners.length; corner += 1) {
        const ids = [corners[0], corners[corner], corners[corner + 1]];
        if (ids.some((id) => id * 3 + 2 >= positions.length)) continue;
        triangles.push({
          p: ids.flatMap((id) => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]]),
          colour,
        });
      }
    }
  }

  return { triangles };
}
