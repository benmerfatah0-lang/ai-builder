# WorldPlan v1 — Document Reference

WorldPlan is the single source of truth for a world. Terrain, objects, colours,
lighting and the seed that generated them all live in one validated JSON
document. The editor, generator, persistence layer and exporters all operate on
this format.

- Zod source of truth: `src/core/world-plan/schema.ts`
- Runtime validation / migration: `src/core/world-plan/migrate.ts`
- Generated JSON Schema: [`worldplan.schema.json`](./worldplan.schema.json)
- Current version: **1**
- File extension: `.world.json`
- Coordinates: right-handed **Y-up**, 1 unit ≈ 1 metre (convention, not enforced)
- Colours: `#rrggbb`
- IDs: `^[A-Za-z0-9_-]+$`, max 80 characters
- Maximum objects: **1500**

---

## Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | yes | Literal. Bumped on breaking changes. |
| `id` | string | yes | Stable project ID. Unique in local storage. |
| `name` | string | yes | 1–80 characters. |
| `description` | string | yes | Up to 500 characters. Generation provenance is appended here. |
| `seed` | integer | yes | 0 – 4,294,967,295. Drives deterministic generation. |
| `createdAt` | ISO string | yes | Non-empty string; ISO-8601 by convention. |
| `updatedAt` | ISO string | yes | Updated on each mutation. |
| `environment` | object | yes | Sky, fog, sun and ambient settings. |
| `terrain` | object | yes | Landform and palette. |
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

## `WorldObject`

Every object has:

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique within the plan. Generated objects use deterministic IDs. |
| `name` | string | 1–80 characters; shown in the hierarchy. |
| `transform.position` | `[x, y, z]` | **Base/origin** of the object, in world units. |
| `transform.rotationY` | number | −360 – 360 degrees. |
| `transform.scale` | `[x, y, z]` | Each component > 0 (and ≤ 100 via editor clamping). |
| `visible` | boolean | Hidden objects are excluded from render and export. |
| `locked` | boolean | Prevents accidental edits in the UI. |
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

## Example document

```json
{
  "schemaVersion": 1,
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
      "transform": {
        "position": [4, 1.82, -3],
        "rotationY": 4.21,
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
      "transform": {
        "position": [-6, 0.4, 2],
        "rotationY": 0,
        "scale": [1, 1, 1]
      },
      "visible": true,
      "locked": false,
      "kind": "lantern",
      "color": "#ffc46b"
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

---

## Rules and invariants

1. `schemaVersion` must match the current version after migrations.
2. The document must validate against the Zod schema before storage or export.
3. Object IDs are unique within a plan; generated IDs are deterministic, manual
   additions use random IDs.
4. Numbers must be finite; colours must be six-digit hex; transforms are clamped
   by the editor reducer before validation.
5. At most 1500 objects per plan.
6. Generation is deterministic for `(prompt interpretation, seed)`; metadata
   (document ID and timestamps) is intentionally not deterministic.
7. Hidden objects are excluded from the viewport and GLB export (unless an export
   option explicitly includes them).

---

## Versioning and migrations

`src/core/world-plan/migrate.ts` contains:

```ts
const MIGRATIONS: Record<number, Migration> = {
  // 1: (doc) => ({ ...doc, schemaVersion: 2, ... }),
};
```

Loading flow: read `schemaVersion` → reject missing/newer versions → apply
migrations in order → validate current schema → strip unknown fields.

Policy:

- **Patch/minor additions** (new optional fields, new object kinds accepted by the
  current union) may stay within v1 if old documents still validate.
- **Breaking changes** (renamed/removed fields, changed semantics) require
  `WORLD_PLAN_SCHEMA_VERSION = 2`, a migration from v1, regenerated JSON Schema
  and updated docs/tests.
- Never silently reinterpret old data; fail with a clear message if a migration is
  unavailable.
