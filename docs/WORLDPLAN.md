# WorldPlan v3 — Document Reference

WorldPlan is the single source of truth for a world. Terrain, objects, colours,
lighting, generation metadata and the seed that produced them all live in one
validated JSON document. The planner, generator, editor, persistence layer and
exporters all operate on this format.

- Zod source of truth: `src/core/world-plan/schema.ts`
- Runtime validation / migration: `src/core/world-plan/migrate.ts`
- Semantic validation and repair: `src/core/world-plan/validateScene.ts`
- Generation pipeline: `src/core/generation/{farm,generateWorld,regenerate}.ts`
- Generated JSON Schema: [`worldplan.schema.json`](./worldplan.schema.json)
- Current version: **3** (Phase 3; v1 and v2 documents migrate automatically)
- File extension: `.world.json`
- Coordinates: right-handed **Y-up**, 1 unit ≈ 1 metre (convention, not enforced)
- Colours: `#rrggbb`
- IDs: `^[A-Za-z0-9_-]+$`, max 80 characters
- Maximum objects: **1500**, maximum groups: **200**, maximum nesting: **8 levels**

---

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `3` | yes | Literal. Bumped on breaking changes. |
| `id` | string | yes | Stable project ID. Unique in local storage. |
| `name` | string | yes | 1–80 characters. |
| `description` | string | yes | Up to 500 characters. Generation provenance is appended here. |
| `seed` | integer | yes | 0 – 4,294,967,295. Drives deterministic generation. |
| `createdAt` | ISO string | yes | Non-empty string; ISO-8601 by convention. |
| `updatedAt` | ISO string | yes | Updated on each mutation. |
| `environment` | object | yes | Sky, fog, sun and ambient settings. |
| `terrain` | object | yes | Landform and palette. |
| `groups` | array | yes | Up to 200 `WorldGroup`s (transform-only containers). |
| `objects` | array | yes | Up to 1500 `WorldObject`s. May be empty. |

---

## `environment`

| Field | Type | Range | Meaning |
| --- | --- | --- | --- |
| `skyColor` | hex | — | Background colour and horizon. |
| `fogColor` | hex | — | Exponential-squared fog colour. |
| `fogDensity` | number | 0 – 1 | `0` disables fog; typical values 0.001–0.004. |
| `sunColor` | hex | — | Directional light colour. |
| `sunAzimuth` | number | 0 – 360 | Compass direction in degrees. |
| `sunElevation` | number | 0 – 90 | Height above the horizon in degrees. |
| `sunIntensity` | number | 0 – 4 | Directional light intensity. |
| `ambientIntensity` | number | 0 – 3 | Hemisphere/ambient light intensity. |

## `terrain`

| Field | Type | Range | Meaning |
| --- | --- | --- | --- |
| `style` | enum | `flat`, `hills`, `mountains`, `dunes`, `islands` | Height function used by renderer and generator. |
| `size` | number | 32 – 512 | Terrain width/depth in world units. |
| `resolution` | integer | 16 – 256 | Grid subdivisions per axis. Renderer caps it for shadows/export. |
| `heightScale` | number | 0 – 200 | Vertical amplitude. |
| `waterLevel` | number \| null | −200 – 200 | Absolute Y of the water surface. `null` = no water. |
| `palette.low` | hex | — | Vertex colour at the lowest terrain. |
| `palette.high` | hex | — | Vertex colour at the highest terrain. |

Terrain height is a pure function of `(style, size, heightScale, seed)` and is
**not** stored per-vertex. This keeps documents small and makes regeneration and
GLB export reproducible. Changing terrain parameters therefore does not move
existing objects; use “Snap to ground” in the inspector.

---

## `WorldGroup`

A transform-only container used to organise the scene and move several nodes
together. Groups never render on their own.

| Field | Type | Notes |
| --- | --- | --- |
| `nodeType` | `"group"` | Discriminant that separates groups from objects. |
| `id` | string | Unique within the plan. |
| `name` | string | 1–80 characters. |
| `parentId` | string \| null | Parent group id, or null for the scene root. |
| `transform` | object | Local transform, same shape as objects. |
| `visible` | boolean | Hiding a group hides its whole subtree. |
| `locked` | boolean | Locking a group locks its whole subtree. |

## `WorldObject`

Every object has:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the plan. Generated objects use deterministic IDs. |
| `name` | string | 1–80 characters; shown in the hierarchy. |
| `parentId` | string \| null | Parent **group** id, or null for the scene root. |
| `transform.position` | `[x, y, z]` | **Local** position (relative to the parent group). |
| `transform.rotation` | `[x, y, z]` | Local Euler rotation in degrees, XYZ order, −3600 – 3600. |
| `transform.scale` | `[x, y, z]` | Each component > 0 (editor clamps to 0.05 – 200). |
| `visible` | boolean | Hidden objects are excluded from render and export. |
| `locked` | boolean | Prevents accidental edits in the UI. |
| `material` | object? | Optional `roughness`, `metalness`, `emissiveIntensity` overrides (0–1 / 0–5). |
| `meta` | object | **Required in v3.** Generation metadata (below). |
| `kind` | discriminator | One of the kinds below. |

### `meta` — generation metadata

`meta` is what makes a generated object reproducible, re-rollable and
machine-checkable. It is required for every drawable object, including objects
added from the asset library.

| Field | Type | Notes |
| --- | --- | --- |
| `category` | enum | `structure`, `vegetation`, `rock`, `prop`, `field`, `path`, `water`, `fence`, `terrain`. |
| `geometry` | string | Geometry id, e.g. `building.barn`, `field.wheat`, `water.river`. Must be in the supported registry. |
| `dimensions` | `[w, h, d]` | Base size **before** the transform; all components > 0. Used for footprints. |
| `source` | enum | `procedural`, `library`, `manual`. |
| `status` | enum | `generated` until the user edits the object, then `edited`. |
| `role` | string? | Semantic role, e.g. `barn`, `crossing`, `windbreak`. |
| `seed` | integer? | Per-object variation seed, independent of the world seed. |
| `region` | string? | Logical region used by region regeneration, e.g. `fields`. |
| `placement` | object? | `{ anchor: 'ground' \| 'terrain' \| 'water', avoidOverlap: boolean }`. |
| `collision` | object? | `{ shape: 'box' \| 'none', blocking: boolean }`. Paths, rivers and fields opt out of blocking. |

Supported geometry ids: `primitive.*`, `tree.{pine,broadleaf,palm,cactus,bush}`,
`rock.{boulder,crag}`, `building.{house,tower,ruin,barn,coop}`,
`structure.{bridge,silo}`, `path.{dirt,stone,gravel}`,
`fence.{wood,stone,rail}`, `field.wheat`, `water.river`, `prop.lantern`.

### Kinds

| Kind | Extra fields | Allowed values |
| --- | --- | --- |
| `primitive` | `primitive`, `color` | `box`, `sphere`, `cylinder`, `cone`, `torus`, `plane` |
| `tree` | `variant`, `color` (foliage), `trunkColor` | `pine`, `broadleaf`, `palm`, `cactus`, `bush` |
| `rock` | `variant`, `color` | `boulder`, `crag` |
| `building` | `variant`, `color` (walls), `roofColor` | `house`, `tower`, `ruin`, `barn`, `coop` |
| `lantern` | `color` | Emissive lamp prop |
| `path` | `points`, `width`, `color`, `style` | `dirt`, `stone`, `gravel` |
| `river` | `points`, `width`, `color` | Water ribbon |
| `fence` | `points`, `height`, `style`, `postColor`, `railColor` | `wood`, `stone`, `rail` |
| `field` | `width`, `depth`, `rows`, `density`, `cropColor`, `soilColor`, `seed` | Instanced crop field |
| `bridge` | `length`, `width`, `deckColor`, `railColor` | Planked crossing |

`points` are polyline vertices in the object's **local** space (2–64 points).
The scene builder samples them and adds terrain-following geometry. All geometry
is procedural at runtime; the document stores parameters, not meshes or
textures. This is why projects are small and can be regenerated anywhere.

---

## Transform semantics

`transform` is **local**: it is applied after the parent group's transform. The
editor computes world transforms on demand (`worldTransformOf` in
`src/core/world-plan/hierarchy.ts`) and converts between spaces when grouping,
ungrouping or reparenting, so nodes never jump visually.

The renderer, the inspector's “World space” section and game-engine exporters all
agree because they use the same parent-chain composition.

## Example document

A trimmed farm document. Real plans contain ~100 objects; this shows one of each
generation shape.

```json
{
  "schemaVersion": 3,
  "id": "world_9f2c11a4",
  "name": "Cartoon Farm",
  "description": "Generated from: “a cartoon farm with a barn, wheat fields and fences”",
  "seed": 20261020,
  "createdAt": "2026-10-20T19:17:13.331Z",
  "updatedAt": "2026-10-20T19:17:13.331Z",
  "environment": {
    "skyColor": "#93c4e2",
    "fogColor": "#c6dce6",
    "fogDensity": 0.0019,
    "sunColor": "#fff3da",
    "sunAzimuth": 216,
    "sunElevation": 54,
    "sunIntensity": 2.15,
    "ambientIntensity": 0.62
  },
  "terrain": {
    "style": "hills",
    "size": 170,
    "resolution": 128,
    "heightScale": 2.6,
    "waterLevel": null,
    "palette": { "low": "#688a4b", "high": "#a8bd78" }
  },
  "groups": [
    {
      "nodeType": "group",
      "id": "grp_farmstead",
      "name": "Farmstead",
      "parentId": null,
      "transform": {
        "position": [0, 0, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false
    }
  ],
  "objects": [
    {
      "id": "obj_kg2_1",
      "name": "Barn",
      "parentId": "grp_farmstead",
      "transform": {
        "position": [-18, 0.62, 2],
        "rotation": [0, 90, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false,
      "kind": "building",
      "variant": "barn",
      "color": "#a4503f",
      "roofColor": "#5b4436",
      "meta": {
        "category": "structure",
        "geometry": "building.barn",
        "dimensions": [6.2, 5.4, 7.4],
        "source": "procedural",
        "status": "generated",
        "region": "farmstead",
        "placement": { "anchor": "terrain", "avoidOverlap": true },
        "collision": { "shape": "box", "blocking": true }
      }
    },
    {
      "id": "obj_kg2_7",
      "name": "Lane to the barn",
      "parentId": "grp_paths",
      "transform": {
        "position": [0, 0.4, 6],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false,
      "kind": "path",
      "points": [
        [0, 0, 0],
        [4, -0.02, -2.4],
        [12, 0.1, -4]
      ],
      "width": 2.8,
      "color": "#b3946b",
      "style": "dirt",
      "meta": {
        "category": "path",
        "geometry": "path.dirt",
        "dimensions": [22, 0.08, 2.8],
        "source": "procedural",
        "status": "generated",
        "region": "paths",
        "placement": { "anchor": "terrain", "avoidOverlap": false },
        "collision": { "shape": "none", "blocking": false }
      }
    },
    {
      "id": "obj_kg2_12",
      "name": "Wheat field (west)",
      "parentId": "grp_fields",
      "transform": {
        "position": [-12, 0.48, -26],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false,
      "kind": "field",
      "width": 18,
      "depth": 11,
      "rows": 8,
      "density": 0.92,
      "cropColor": "#dcb457",
      "soilColor": "#7c5f42",
      "seed": 2472883186,
      "meta": {
        "category": "field",
        "geometry": "field.wheat",
        "dimensions": [18, 1.1, 11],
        "source": "procedural",
        "status": "generated",
        "region": "fields",
        "placement": { "anchor": "terrain", "avoidOverlap": false },
        "collision": { "shape": "none", "blocking": false }
      }
    }
  ]
}
```

---

## Validation

Two layers run before a plan reaches the renderer:

1. **Structural** — `validateWorldPlan` (Zod + hierarchy checks) answers “is this
   a WorldPlan?”.
2. **Semantic** — `validateScenePlan` answers “can this world be built and does
   it make sense?”. It checks supported geometry ids, terrain bounds, solid
   overlaps, floating/buried objects, missing dependencies (a bridge without a
   river) and object-count limits.

```ts
import { validateWorldPlan } from './src/core/world-plan/schema';
import { parseWorldPlan, serializeWorldPlan } from './src/core/world-plan/migrate';
import { validateScenePlan, repairScenePlan } from './src/core/world-plan/validateScene';

const result = validateWorldPlan(untrusted);
if (!result.success) {
  console.error(result.issues); // [{ path: 'terrain.size', message: 'Too big: ...' }]
}

const plan = parseWorldPlan(untrusted); // migrate + validate; throws on failure
const scene = validateScenePlan(plan);
if (!scene.valid) console.error(scene.errors); // blocking issues
console.warn(scene.warnings);                 // recoverable notes

const repaired = repairScenePlan(plan); // drops unbuildable objects, reseats floaters
const json = serializeWorldPlan(repaired.plan);
```

For non-TypeScript tools:

```bash
npm run schema:export   # writes docs/worldplan.schema.json
```

The JSON Schema targets draft 2020-12 and uses `output` types (defaults resolved),
so external validators see required, fully-populated documents.

## Graceful repair

`parseWorldPlanLenient` (used by file import) tolerates partially damaged files:

- unreadable objects/groups are skipped and counted;
- nodes whose parent is missing are re-rooted;
- hierarchy cycles are broken;
- every repair is reported as a warning in the UI.

`repairScenePlan` (used by the generator/import pipeline) additionally:

- drops objects whose declared or derived geometry is unsupported;
- re-roots nodes whose parent group is missing;
- clamps objects back inside the terrain and reseats solids that float or sink;
- reports what it removed and moved.

A file that is not a world document at all (no `schemaVersion`) is still rejected
with a clear message.

---

## Generation pipeline

```
prompt
  → local interpreter (biome, style, scale, density, farm features, seed)
  → planner (structured farm layout, or the biome scatter generator)
  → WorldPlan v3
  → structural validation → semantic validation
  → safe repair (warnings only)
  → scene assembly (Three.js) → editable world
```

Both planners are deterministic: the same interpretation and seed rebuild the
same plan. Only document metadata (`id`, timestamps) is random. The farm planner
places buildings, fields, lanes, fences, water and vegetation in dependency order
and uses a uniform-grid collision ledger so solids never intersect and trees keep
clear of lanes and yards. Field crops, pebbles and bridge planks are instanced or
merged, so a 100-object farm stays inside a mobile GPU budget.

## Regeneration

Every object carries `meta.seed` and `meta.region`. The editor exposes two
operations that never rebuild the world:

- **Regenerate object** — re-rolls species/shape/palette/crop variation in place,
  preserving id, name, parent, transform and visibility.
- **Regenerate region** — re-rolls every object with the same `meta.region`
  (for example all of `fields` or `landscape`), preserving everything else.
  Locked objects are skipped.

The viewport diffs the plan against its built graph and rebuilds only the affected
nodes, so regeneration is a local operation in both the document and the scene.

---

## Rules and invariants

1. `schemaVersion` must match the current version after migrations.
2. Every drawable object has valid `meta`; `meta.geometry` must be in the registry.
3. The document must validate against the Zod schema **and** the structural
   hierarchy checks before storage or export.
4. IDs are unique across groups and objects; generated IDs are deterministic,
   manually added nodes use random IDs. Editing a node never changes its ID.
5. `parentId` must point to an existing **group** (or null). Cycles and nesting
   deeper than 8 levels are rejected.
6. Numbers must be finite; colours must be six-digit hex; transforms are clamped
   by the editor reducer before validation.
7. At most 1500 objects and 200 groups per plan.
8. Generation is deterministic for `(prompt interpretation, seed)`; metadata
   (document ID and timestamps) is intentionally not deterministic.
9. Hidden nodes and their subtrees are excluded from the viewport and GLB export
   (unless an export option explicitly includes them).
10. A locked node (or any locked ancestor) rejects transform edits, regeneration
    and deletion.
11. Regeneration preserves object identity and placement; it may change
    `meta.geometry`, `meta.seed` and the kind-specific visual fields.

---

## Versioning and migrations

### v1 → v2 (Phase 2)

- `transform.rotationY` became `transform.rotation: [x, y, z]`
  (v1 `rotationY` → `[0, rotationY, 0]`).
- Every node gained `parentId` (default `null`).
- The document gained `groups` (default `[]`).
- Objects gained an optional `material` block.

### v2 → v3 (Phase 3)

- Every drawable object gained required `meta` (category, geometry id, base
  dimensions, source, status, optional role/seed/region/placement/collision).
- Objects created before v3 are treated as `source: "library"` and
  `status: "edited"`, so they are never silently replaced by regeneration.
- New kinds `path`, `river`, `fence`, `field`, `bridge`; new variants `bush`,
  `barn`, `coop`; groups still have no `meta`.

Migration is automatic when a file is opened, saved or imported.

`src/core/world-plan/migrate.ts` contains:

```ts
const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1ToV2,
  2: migrateV2ToV3,
};
```

Loading flow: read `schemaVersion` → reject missing/newer versions → apply
migrations in order → validate current schema → run semantic checks → strip
unknown fields.

Policy:

- **Patch/minor additions** (new optional fields, new object kinds accepted by the
  current union) may stay within v3 if old documents still validate.
- **Breaking changes** (renamed/removed fields, changed semantics) require a new
  version constant, a migration from the previous version, regenerated JSON
  Schema and updated docs/tests.
- Never silently reinterpret old data; fail with a clear message if a migration is
  unavailable.
