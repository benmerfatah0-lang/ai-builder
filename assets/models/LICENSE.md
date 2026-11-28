# 3D models

Everything embedded in `src/game-map/models/generated.ts` — and therefore in
`map-3d.html` — is **CC0 1.0 Universal** (public domain dedication) from two
creators. CC0 asks for nothing: no attribution, no conditions on redistribution.
The credit is kept here, and in the generated module's header, because a
public-domain dedication is worth honouring out loud.

## Quaternius — <https://quaternius.com/>

| Pack | Models |
| --- | --- |
| `crops_pack` | Wheat_4, Corn_1, Pumpkin_1, Carrot_1, Lettuce_1, Flower_2, Rice_2, BushBerries_1, Beet_2, Grass_1, Tomato_2 |
| `animals_pack` | Cow, Bull, Alpaca, Donkey, Horse, Husky, ShibaInu, Fox, Deer |
| `farm-animals` | Sheep, Pig |
| `simple_nature_pack` | Tree1/2/3, Bush2, Rock2 |
| `medieval_village_pack` | Well, Hay, MarketStand_1, Mill (the silo) |

Sources: <https://github.com/trebeljahr/quaternius-showcase> (`public/glb/`,
whose `LICENSES.md` marks every pack CC0-1.0) and
<https://github.com/tilakpatell/tilakverse-assets> (`quaternius/farm-animals`,
OBJ exports only — the pack ships in no glTF form).

## Kenney — <https://www.kenney.nl/>

| Kit | Models |
| --- | --- |
| `fantasy-town` | the modular wall, roof, door, window and chimney pieces the cottages are assembled from, plus the windmill |
| `castle` / `nature` / `survival` | downloaded while judging the kits; nothing from them ships |

Source: <https://github.com/shorepine/kenney> (`3d/fantasy-town`), a mirror of
Kenney's own archives; each kit's `LICENSE.txt` says CC0.

Kenney's kits carry no per-material colours: every face points into one shared
`Textures/colormap.png`. `tools/meshPack.mjs` samples that atlas at each
triangle's centroid and bakes the result into vertex colours, which is what lets
a Kenney house use the same packed blob format as a Quaternius one.

## What was changed

- `tools/meshPack.mjs` bakes node transforms into vertices, drops animation,
  skinning, UVs and normals, quantises positions to 16 bits, welds coincident
  vertices and — for atlas-textured kits — bakes the texture colour per face.
- `tools/objPack.mjs` reads the OBJ + MTL animal exports into the same triangle
  form (colours are the MTL `Kd` factors).
- `tools/compose.mjs` assembles whole cottages from Kenney's modular pieces on
  the kit's own 1-unit grid, so a building ships as one mesh and one draw call.
- `tools/buildModels.mjs` writes the result as base64 into a generated
  TypeScript module; `src/game-map/models/pack.ts` reads it at runtime.

Nothing was re-licensed: the derived bytes stay CC0.
