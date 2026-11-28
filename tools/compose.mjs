/**
 * Composes Kenney's modular fantasy-town pieces into whole buildings.
 *
 * The kit has no finished houses: it has 1×1×1 wall blocks, door and window
 * slabs that sit on a block's outer face, and roof tiles that cap a cell. That is
 * enough to build a village, but the map wants a *building* it can place, scale
 * and shadow — not fifteen boxes to reason about every frame.
 *
 * So houses are assembled here, at build time, and baked into one mesh by
 * `tools/buildModels.mjs`. The scene then treats a cottage exactly like a
 * Quaternius model: one geometry, one draw call, one entry in `generated.ts`.
 *
 * Recipes are written in kit units, on the kit's own grid:
 *
 *   x, z  cell centres, integers (a 2×2 house spans -0.5 and +0.5 in both axes)
 *   y     cell levels, 1 unit per storey
 *   ry    rotation about Y, in quarter turns
 *
 * `face` on a slab piece says which side of its cell it is pinned to; the kit
 * authors slabs on +X, so the other faces are that piece turned a quarter.
 */
import { openGlb, flattenScene } from './meshPack.mjs';

/** A piece placed in a recipe. */
const CELL = (piece, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) => ({ piece, x, y, z, ry, sx, sy, sz });

/**
 * A cottage, assembled from the kit's grid.
 *
 * `wall` picks the palette: the kit has two — a dark timber frame with a brown
 * plaster infill, and the same frame with a blue-grey one — plus matching door and
 * window slabs, which is what keeps the village from looking stamped out.
 *
 * The roof is a row of gable prisms along the long axis, stretched in Z to reach
 * the far wall: one prism per cell is 1.1 wide, so they meet at the ridge with a
 * small overlap instead of a seam.
 */
function cottage({ width, depth, storeys, wall = 'wood', roof = 'teal', chimney = false, porch = false }) {
  const pieces = [];
  const timber = wall === 'wood';
  const block = timber ? 'wall-wood-block' : 'wall-block';
  // Doors and windows are 10 cm slabs the kit pins to a cell's +X face, so they
  // are *added* to a wall block and turned to whichever face should show them.
  const doorPiece = timber ? 'wall-wood-door' : 'wall-door';
  const windowPiece = timber ? 'wall-wood-window-shutters' : 'wall-window-shutters';
  const centre = (index, count) => index - (count - 1) / 2;
  const doorIndex = Math.floor((width - 1) / 2);
  const FACE = { east: 0, south: 3, west: 2, north: 1 };

  for (let level = 0; level < storeys; level += 1) {
    for (let ix = 0; ix < width; ix += 1) {
      for (let iz = 0; iz < depth; iz += 1) {
        const x = centre(ix, width);
        const z = centre(iz, depth);
        pieces.push({ piece: block, x, y: level, z });
        const front = iz === depth - 1;
        const back = iz === 0;
        const leftEdge = ix === 0;
        const rightEdge = ix === width - 1;
        // Slabs sit 2 cm proud of the wall they are pinned to. Flush, their faces
        // land exactly on the block's face and the renderer has to choose between
        // two coplanar surfaces — which is the flickering frame you see if the
        // offset is left out.
        const proud = 0.02;
        if (front) {
          if (level === 0 && ix === doorIndex) {
            pieces.push({ piece: doorPiece, x, y: level, z: z + proud, ry: FACE.south });
          } else {
            pieces.push({ piece: windowPiece, x, y: level, z: z + proud, ry: FACE.south });
          }
        } else if (back && level > 0) {
          pieces.push({ piece: windowPiece, x, y: level, z: z - proud, ry: FACE.north });
        }
        // Side windows only on the top storey: a house with a grid of glazing on
        // every face reads as an office block from the air.
        if (level === storeys - 1 && storeys > 1) {
          if (rightEdge) pieces.push({ piece: windowPiece, x: x + proud, y: level, z, ry: FACE.east });
          if (leftEdge) pieces.push({ piece: windowPiece, x: x - proud, y: level, z, ry: FACE.west });
        }
      }
    }
  }

  // One gable prism per cell along the ridge, stretched across the depth: the
  // kit's tile is 1.1 wide, so neighbours meet at the ridge instead of seaming.
  const roofPiece = roof === 'red' ? 'roof-high-gable' : 'roof-gable';
  const roofDepth = depth * (roof === 'red' ? 0.98 : 1.05);
  for (let ix = 0; ix < width; ix += 1) {
    pieces.push({ piece: roofPiece, x: centre(ix, width), y: storeys, z: 0, sz: roofDepth });
  }

  if (chimney) pieces.push({ piece: 'chimney', x: -width / 2 + 0.5, y: storeys, z: -depth / 4 });
  if (porch) pieces.push({ piece: 'planks', x: 0, y: 0, z: depth / 2 + 0.35 });

  return { pieces };
}

/** The buildings the map places. Names are what `scene.ts` asks for. */
export const RECIPES = {
  /** Farmhouse: two storeys, wide, front door, chimney. */
  Cottage_House: cottage({ width: 3, depth: 2, storeys: 2, wall: 'wood', roof: 'teal', chimney: true, porch: true }),
  /** Cottage: one storey, red roof — the smaller villager homes. */
  Cottage_Small: cottage({ width: 2, depth: 2, storeys: 1, wall: 'wood', roof: 'red', chimney: true }),
  /** Plastered house: the blue-grey infill, for buildings that should read cooler. */
  Cottage_Plaster: cottage({ width: 3, depth: 2, storeys: 2, wall: 'block', roof: 'red' }),
  /** Long house: a barn-shaped body under one ridge. */
  Cottage_Long: cottage({ width: 4, depth: 2, storeys: 1, wall: 'wood', roof: 'teal' }),
  /** Tower: narrow and tall, for the gatehouse and the watchtower. */
  Cottage_Tower: cottage({ width: 2, depth: 2, storeys: 3, wall: 'block', roof: 'red' }),
  /** Barn: one long ridge, red, no upper floor. */
  Cottage_Barn: cottage({ width: 4, depth: 3, storeys: 1, wall: 'wood', roof: 'red' }),
  /** Hut: a single cell, for the dog house, the duck house and the tool shed. */
  Cottage_Hut: cottage({ width: 1, depth: 1, storeys: 1, wall: 'wood', roof: 'red' }),
};

/** The kit directory recipes read from; `buildModels.mjs` overrides it. */
export const KIT_DIR = process.env.KIT_DIR ?? '/tmp/kenney/3d/fantasy-town';

/**
 * Turns a recipe into a flat triangle list, ready for `packScene`.
 *
 * `dir` is the kit directory the recipes' piece names live in.
 */
export async function composeRecipe(recipe, dir) {
  const triangles = [];
  const cache = new Map();

  for (const entry of recipe.pieces) {
    const path = `${dir}/${entry.piece}.glb`;
    if (!cache.has(path)) {
      const { json, bin, dir: home } = openGlb(path);
      cache.set(path, await flattenScene(json, bin, home));
    }
    const source = cache.get(path);
    if (!source) continue;

    const ry = entry.ry ?? 0;
    const cos = Math.cos((ry * Math.PI) / 2);
    const sin = Math.sin((ry * Math.PI) / 2);
    for (const triangle of source.triangles) {
      const p = [];
      for (let corner = 0; corner < 3; corner += 1) {
        const x = triangle.p[corner * 3] * (entry.sx ?? 1);
        const y = triangle.p[corner * 3 + 1] * (entry.sy ?? 1);
        const z = triangle.p[corner * 3 + 2] * (entry.sz ?? 1);
        p.push(
          entry.x + x * cos + z * sin,
          entry.y + y,
          entry.z - x * sin + z * cos,
        );
      }
      triangles.push({ p, colour: triangle.colour });
    }
  }

  return { triangles };
}

/** Convenience for recipes: a placeable piece on the kit grid. */
export { CELL };
