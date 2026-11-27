# 3D models

The low-poly models embedded in `src/game-map/models/generated.ts` (and therefore
in `map-3d.html`) are by **Quaternius**, released under **CC0 1.0 Universal**
(public domain dedication).

- Upstream: <https://quaternius.com/>
- Source of the files used here: <https://github.com/trebeljahr/quaternius-showcase>
  (`public/glb/`, whose `LICENSES.md` marks every pack CC0-1.0).

CC0 requires no attribution and imposes no conditions on redistribution, but the
credit is kept here and in the generated module's header because a public-domain
dedication is worth honouring out loud.

## Packs used

| Pack | Models |
| --- | --- |
| `medieval_village_pack` | House_1/2/3, Stable, Mill, Well, Barrel, Cart, Hay, Crate, Bench_1, MarketStand_1 |
| `animals_pack` | Cow, Bull, Alpaca, Donkey, Horse, Husky, ShibaInu, Fox, Deer |
| `crops_pack` | Wheat_4, Corn_1, Tomato_2, Pumpkin_1, Carrot_1, Lettuce_1, Flower_2, Rice_2, BushBerries_1, Beet_2, Grass_1 |
| `simple_nature_pack` | Tree1/2/3, Bush1/2/3, Rock1/2 |

## What was changed

`tools/buildModels.mjs` bakes each model's node transforms into its vertices,
drops animation, skinning, UVs and normals, quantises positions to 16 bits and
welds coincident vertices, then emits the result as base64 in a generated
TypeScript module. `tools/meshPack.mjs` is the packer; `src/game-map/models/pack.ts`
is the runtime reader. Nothing was re-licensed: the derived bytes stay CC0.
