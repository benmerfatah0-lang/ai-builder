# WorldPlan v1 — Document Reference

WorldPlan is the single source of truth for a world. Terrain, objects, colours,
lighting and the seed that generated them all live in one validated JSON
document. The editor, generator, persistence layer and exporters all operate on
this format.

- Zod source of truth: `src/core/world-plan/schema.ts`
- Runtime validation / migration: `src/core/world-plan/migrate.ts`
- Generated JSON Schema: [`worldplan.schema.json`](./worldplan.schema.json)
- Current version: **2** (Phase 2; v1 documents migrate automatically)
- File extension: `.world.json`
- Coordinates: right-handed **Y-up**, 1 unit ≈ 1 metre (convention, not enforced)
- Colours: `#rrggbb`
- IDs: `^[A-Za-z0-9_-]+$`, max 80 characters
- Maximum objects: **1500**, maximum groups: **200**, maximum nesting: **8 levels**

---

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `2` | yes | Literal. Bumped on breaking changes. |
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
| `kind` | discriminator | One of the kinds below. |

### Common kind fields

| Kind | Extra fields | Allowed values |
| --- | --- | --- |
| `primitive` | `primitive`, `color` | `box`, `sphere`, `cylinder`, `cone`, `torus`, `plane` |
| `tree` | `variant`, `color` (foliage), `trunkColor` | `pine`, `broadleaf`, `palm`, `cactus` |
| `rock` | `variant`, `color` | `boulder`, `crag` |
| `building` | `variant`, `color` (walls), `roofColor` | `house`, `tower`, `ruin` |
| `lantern` | `color` | Emissive lamp prop |

All geometry is procedural at runtime; the document stores parameters, not meshes
or textures. This is why projects are small and can be regenerated anywhere.

---

## Transform semantics

`transform` is **local**: it is applied after the parent group's transform. The
editor computes world transforms on demand (`worldTransformOf` in
`src/core/world-plan/hierarchy.ts`) and converts between spaces when grouping,
ungrouping or reparenting, so nodes never jump visually.

The renderer, the inspector's “World space” section and game-engine exporters all
agree because they use the same parent-chain composition.

## Example document

```json
{
  "schemaVersion": 2,
  "id": "world_dfef0517b869",
  "name": "Example World",
  "description": "",
  "seed": 123456,
  "createdAt": "2026-10-20T19:17:13.331Z",
  "updatedAt": "2026-10-20T19:17:13.331Z",
  "environment": {
    "skyColor": "#8fb8d8",
    "fogColor": "#adc6d6",
    "fogDensity": 0.0022,
    "sunColor": "#fff2dc",
    "sunAzimuth": 220,
    "sunElevation": 52,
    "sunIntensity": 2.2,
    "ambientIntensity": 0.55
  },
  "groups": [
    {
      "nodeType": "group",
      "id": "grp_village",
      "name": "Village",
      "parentId": null,
      "transform": {
        "position": [2, 0, 2],
        "rotation": [0, 20, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false
    }
  ],
  "terrain": {
    "style": "islands",
    "size": 160,
    "resolution": 128,
    "heightScale": 9,
    "waterLevel": 0.5,
    "palette": {
      "low": "#7e9164",
      "high": "#c7bb8d"
    }
  },
  "objects": [
    {
      "id": "obj_palm_1",
      "name": "Palm",
      "parentId": "grp_village",
      "transform": {
        "position": [4, 1.82, -3],
        "rotation": [0, 4.21, 0],
        "scale": [0.83, 1.34, 1.11]
      },
      "visible": true,
      "locked": false,
      "kind": "tree",
      "variant": "palm",
      "color": "#4e7e46",
      "trunkColor": "#8a6b45"
    },
    {
      "id": "obj_lantern_1",
      "name": "Lantern",
      "parentId": null,
      "transform": {
        "position": [-6, 0.4, 2],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false,
      "kind": "lantern",
      "color": "#ffc46b",
      "material": { "roughness": 0.4, "emissiveIntensity": 1.4 }
    }
  ]
}
```

---

## Validation

```ts
import { validateWorldPlan } from './src/core/world-plan/schema';
import { parseWorldPlan, serializeWorldPlan } from './src/core/world-plan/migrate';

const result = validateWorldPlan(untrusted);
if (!result.success) {
  console.error(result.issues); // [{ path: 'terrain.size', message: 'Too big: ...' }]
}

const plan = parseWorldPlan(untrusted); // migrates then validates; throws on failure
const json = serializeWorldPlan(plan);  // validates, stable pretty-print
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

A file that is not a world document at all (no `schemaVersion`) is still rejected
with a clear message.

---

## Rules and invariants

1. `schemaVersion` must match the current version after migrations.
2. The document must validate against the Zod schema **and** the structural
   hierarchy checks before storage or export.
3. IDs are unique across groups and objects; generated IDs are deterministic,
   manually added nodes use random IDs. Editing a node never changes its ID.
4. `parentId` must point to an existing **group** (or null). Cycles and nesting
   deeper than 8 levels are rejected.
5. Numbers must be finite; colours must be six-digit hex; transforms are clamped
   by the editor reducer before validation.
6. At most 1500 objects and 200 groups per plan.
7. Generation is deterministic for `(prompt interpretation, seed)`; metadata
   (document ID and timestamps) is intentionally not deterministic.
8. Hidden nodes and their subtrees are excluded from the viewport and GLB export
   (unless an export option explicitly includes them).
9. A locked node (or any locked ancestor) rejects transform edits and deletion.

---

## Versioning and migrations

### v1 → v2 (Phase 2)

- `transform.rotationY` became `transform.rotation: [x, y, z]`
  (v1 `rotationY` → `[0, rotationY, 0]`).
- Every node gained `parentId` (default `null`).
- The document gained `groups` (default `[]`).
- Objects gained an optional `material` block.

Migration is automatic when a v1 file is opened, saved or imported; v2 files
load unchanged.

`src/core/world-plan/migrate.ts` contains:

```ts
const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1ToV2,
};
```

Loading flow: read `schemaVersion` → reject missing/newer versions → apply
migrations in order → validate current schema → strip unknown fields.

Policy:

- **Patch/minor additions** (new optional fields, new object kinds accepted by the
  current union) may stay within v1 if old documents still validate.
- **Breaking changes** (renamed/removed fields, changed semantics) require a new
  version constant, a migration from the previous version, regenerated JSON
  Schema and updated docs/tests.
- Never silently reinterpret old data; fail with a clear message if a migration is
  unavailable.
