# AI World Builder — Architecture Report (Phase 1 + Phase 2)

**Date:** 2026-10-20
**Branch:** `arena/98b7682d-ai-builder`
**Baseline commit:** `f6f4508` (repository contained only `README.md`)

---

## 1. Audit of the existing project

### What was actually in the repository

| Area | Finding |
| --- | --- |
| Frontend | **None.** No HTML, CSS, JavaScript, React or build config. |
| Backend | **None.** No server code, API routes, database or cloud config. |
| Rendering engine | **None.** No Three.js, Babylon.js, canvas or WebGL code. |
| Data storage | **None.** No schema, database, localStorage or IndexedDB usage. |
| Export functionality | **None.** No glTF, OBJ, Godot, Unity or JSON export code. |
| Tests / CI | **None.** No test runner, workflows or scripts. |
| Dependencies | **None.** No `package.json` or lockfile. |

The only tracked file was a one-line `README.md` (`# ai-builder`). All refs, all
branches and all git objects were inspected; there was no hidden or unmerged
application code.

### Consequence

There was nothing to preserve, refactor or build on. Phase 1 therefore
**establishes the foundation in this repository** rather than recreating an
existing app. If a different codebase was intended, it is not present in this
GitHub repository — Phase 1 should be re-run against that codebase before any
further work.

The foundation was still built under the requested constraints:

- no paid APIs or paid dependencies;
- no fabricated functionality — every feature listed below executes real code;
- modular architecture with explicit extension points;
- verified with type checking, unit tests, a DOM runtime test and a production build.

---

## 2. Stack

| Layer | Choice | Reason |
| --- | --- | --- |
| UI | **React 19 + TypeScript 5.9** | Requested architecture; strict typing (`strict`, `noUncheckedIndexedAccess`, `noUnused*`). |
| Bundler / dev server | **Vite 7** | Fast local dev, static production output, no server required. |
| 3D engine | **Three.js r186** (`WebGLRenderer`, `OrbitControls`) | Mature, free, browser/Android compatible, glTF exporter included. |
| Validation | **Zod 4** | Runtime validation for saves, imports, IndexedDB and future backends; can emit JSON Schema. |
| Local storage | **IndexedDB** via a small repository wrapper | Free, local, multi-world, no account; memory fallback for hardened browsers. |
| Export | **glTF 2.0 binary (.glb)** + WorldPlan JSON | Open standard; Godot 4 imports glTF natively, Unity via any free glTF importer. |
| Testing | **Vitest 3 + fake-indexeddb + happy-dom + Testing Library** | Unit, storage, GLB and DOM runtime tests without a paid service. |

All dependencies are open source and free. No network calls are made by the
application at runtime.

---

## 3. System architecture

```
                ┌────────────────────────────────────────────────┐
                │                   React UI                     │
                │  TopBar · Sidebar tabs · Inspector · Sheets    │
                └───────────────┬────────────────────────────────┘
                                │ actions
                                ▼
                ┌────────────────────────────────────────────────┐
  text prompt → │  PromptInterpreter (offline rules, interface)  │
                │      → WorldIntent (biome, time, counts)       │
                └───────────────┬────────────────────────────────┘
                                │
                                ▼
                ┌────────────────────────────────────────────────┐
                │ Procedural generator (seeded, deterministic)   │
                │ terrain sampler · scatter · village placement  │
                └───────────────┬────────────────────────────────┘
                                │
                                ▼
                ┌────────────────────────────────────────────────┐
                │        WorldPlan v1 (Zod schema + types)       │
                └───────┬───────────────────────────┬────────────┘
                        │                           │
          ┌─────────────▼────────────┐   ┌──────────▼───────────────┐
          │  Editor store (reducer)  │   │ Persistence / Export     │
          │  undo · redo · selection │   │ IndexedDB · .world.json  │
          │  autosave revision       │   │ glTF 2.0 (.glb)          │
          └─────────────┬────────────┘   └──────────┬───────────────┘
                        │                           │
                        ▼                           ▼
          ┌────────────────────────────────────────────────────────┐
          │ Shared scene builder (pure Three.js, no DOM/network)   │
          │ terrain mesh · water · archetype geometry · lights      │
          └───────────────┬───────────────────────┬────────────────┘
                          │                       │
                          ▼                       ▼
                 Live WebGL viewport       GLB exporter (lazy chunk)
                 (OrbitControls, picking)  (Godot / Unity)
```

### Module boundaries

| Module | Path | Responsibility |
| --- | --- | --- |
| World plan | `src/core/world-plan/schema.ts`, `factory.ts`, `migrate.ts` | Versioned Zod schema, factories, validation, migrations, serialisation. |
| Hierarchy | `src/core/world-plan/hierarchy.ts` | Groups, parents, world transforms, visibility/lock inheritance, reparent/group/ungroup/duplicate as pure functions. |
| Transform math | `src/core/world-plan/transformMath.ts` | Matrix compose/decompose and parent-relative conversion (degrees ↔ radians at the edge). |
| Generation | `src/core/generation/` | Seeded RNG, terrain sampling, biome profiles, deterministic world assembly, first-run starter. |
| Assets | `src/core/assets/catalog.ts` | Asset library descriptors and archetype factories. |
| Persistence | `src/core/persistence/` | IndexedDB/memory repositories, `.world.json` file import/export. |
| Export | `src/core/export/gltf.ts` | Binary glTF export + export target metadata. |
| Scene builder | `src/core/scene/sceneBuilder.ts` | Pure Three.js geometry/lights shared by viewport and exporter. |
| Renderer | `src/core/scene/renderer.ts` | WebGL 2 context creation with fallbacks, GPU capability profile, PNG capture. |
| Sky | `src/core/scene/sky.ts` | Procedural GLSL sky dome (gradient + sun) driven by the environment. |
| Water | `src/core/scene/water.ts` | Viewport-only animated ripple injected into the PBR water shader. |
| AI commands | `src/modules/ai/` | Intent types, provider contract, offline prompt interpreter. |
| Editor | `src/modules/editor/` | Reducer store, autosave, gizmo viewport, transform toolbar, hierarchy/inspector/asset/AI panels, workspace shell and keyboard shortcuts. |
| UI primitives | `src/ui/` | Icons, controls, top bar, export menu, world library, toast, media query. |
| App | `src/app/App.tsx` | Provider composition only. |

The generator, scene builder and exporters do **not** depend on React or the DOM
(except the browser download helpers). This keeps future server-side generation,
CLI export and testing straightforward.

---

## 4. Data flow

1. The user writes a description and a seed in the **AI panel**.
2. `localPromptInterpreter` (offline, deterministic) extracts biome, time of day,
   scale, water and object counts, and returns a `WorldIntent` plus matched cues.
3. `generateWorldPlan(intent)` computes terrain parameters, environment, and a
   deterministic object scatter using `mulberry32(seed)` and value-noise terrain.
   Only document metadata (IDs, timestamps) is non-deterministic.
4. The resulting `WorldPlan` is validated by the Zod schema and committed to the
   editor reducer (which records undo history).
5. The viewport builds terrain/water/objects with the same `sceneBuilder` used by
   the exporter. Selection is raycast against tagged meshes.
6. A debounced autosave writes the validated plan to IndexedDB. Exports produce a
   project JSON or a binary glTF file locally.

**Manual editing flow (Phase 2):**

1. A click/tap raycasts tagged meshes and dispatches `select`; the hierarchy
   panel dispatches the same action, so both stay in sync.
2. `TransformControls` attaches to the single unlocked selection. While dragging,
   orbit controls are disabled and a frame-coalesced outline refresh runs.
3. On gizmo release, `readTransform()` converts the Three.js object back into a
   `Transform` (radians → degrees, values rounded to 1 mm) and dispatches
   `setTransform`; the reducer sanitises it, updates the document and records undo.
4. Grouping/ungrouping/reparenting run in `hierarchy.ts` and rewrite children's
   local transforms with `transformRelativeTo`, so nothing moves on screen.
5. The viewport effect rebuilds only when the plan object identity changes; the
   inspector and tree re-render from the same document.

---

## 4b. Real-time rendering pipeline

The viewport is a WebGL 2 renderer, not a 2D or mock renderer:

1. `createViewportRenderer` asks Three.js for a context with antialiasing and
   `high-performance`; failures fall back to simpler attributes before reporting
   an actionable "WebGL 2 unavailable" error.
2. The renderer enables `PCFSoftShadowMap`, ACES filmic tone mapping, sRGB output
   and a capped device pixel ratio (2 desktop / 1.65 mobile).
3. A shader sky dome is drawn first (gradient + sun disc aligned with the
   directional light) and follows the camera inside the far plane.
4. The shared scene builder supplies terrain, water and world nodes, so the
   viewport and the exporter can never disagree about geometry.
5. Water receives a viewport-only GLSL ripple (`onBeforeCompile`) so exported
   glTF keeps a plain PBR material.
6. A `Clock` drives the water and sky each frame. Per-frame counters feed the
   HUD (FPS, draw calls) and an adaptive pixel-ratio step-down protects slower
   phones.

**Why this is verifiable without a GPU in CI:** context creation failure,
fallback ordering, GPU profile parsing, sky uniforms and water-shader injection
are unit-tested; the actual rasterised pixels still require a real browser (see
risks).

---

## 5. WorldPlan v2 schema

Defined in `src/core/world-plan/schema.ts`; reference and example in
[`docs/WORLDPLAN.md`](./WORLDPLAN.md). Generated JSON Schema:
[`docs/worldplan.schema.json`](./worldplan.schema.json) (`npm run schema:export`).

Top level:

```ts
{
  schemaVersion: 2,
  id, name, description, seed, createdAt, updatedAt,
  environment: { skyColor, fogColor, fogDensity, sunColor,
                 sunAzimuth, sunElevation, sunIntensity, ambientIntensity },
  terrain: { style, size, resolution, heightScale, waterLevel, palette },
  groups: WorldGroup[],     // max 200, nesting ≤ 8, nodeType: 'group'
  objects: WorldObject[]    // max 1500
}
```

Every node carries `id`, `name`, `parentId`, `visible`, `locked` and a local
`transform` (`position`, `rotation` in XYZ degrees, `scale`). Objects add a `kind`
discriminant (`primitive`, `tree`, `rock`, `building`, `lantern`) plus kind-specific
fields and an optional `material` (`roughness`, `metalness`, `emissiveIntensity`).

Versioning policy:

- `WORLD_PLAN_SCHEMA_VERSION = 2`.
- Missing/unknown/newer versions produce explicit errors.
- `MIGRATIONS` is keyed by source version; v2 adds `migrateV1ToV2`
  (`rotationY` → `[0, y, 0]`, `parentId: null`, `groups: []`). The loader runs
  migrations before validation and strips unknown fields.
- New optional fields can remain inside v2; breaking changes require a new version.
- `checkHierarchyIntegrity` rejects duplicate IDs, dangling parents, object
  parents, cycles and over-deep nesting before anything is saved.

---

## 6. Local-first saving strategy

| Mechanism | Details |
| --- | --- |
| Autosave | Every plan mutation bumps a `revision`; after 650 ms idle the whole validated plan is written to IndexedDB. A before-unload warning covers pending writes. |
| Library | IndexedDB object store `worlds` (keyPath `id`), with an `updatedAt` index. The world library lists, opens and deletes worlds. |
| Project file | `Download .world.json` produces stable, formatted, re-importable JSON. Import validates and migrates before loading. |
| Backup / transfer | Files are entirely local and can be moved by the user; there is no cloud dependency. |
| Fallback | If IndexedDB is unavailable (private mode, hardened webview), a memory repository is used and the UI explicitly warns that the session is temporary. |
| Failure surfacing | Save states are visible (`Unsaved`, `Saving`, `Saved locally`, `Save failed`); errors are also shown as toasts. |
| Import caveat | IDs are preserved on import. Re-importing a world with the same ID overwrites that library entry — import-as-copy is planned work. |

Verified with `fake-indexeddb` unit tests (CRUD, sort, invalid rejection) and a
DOM test that observes `Saved locally`.

---

## 7. Export

### Project JSON (`.world.json`)

Lossless document export. Includes environment, terrain, objects, seed, schema
version and generation provenance. Re-importable by the editor; can be validated
by any JSON Schema tool.

### 3D model (`.glb`, glTF 2.0)

- Generated from the **same scene builder as the viewport**.
- Contains terrain geometry with vertex colors, water plane, object meshes and
  standard/emissive materials.
- Loaded as a separate lazy bundle so it does not affect initial load.
- Verified in tests by parsing the GLB header, JSON chunk and `asset.version`.
- Godot 4 imports glTF natively. Unity requires a free glTF importer package.
- Not yet included: punctual lights, colliders, LODs, native `.tscn` /
  `.unitypackage` output. These are explicitly future work, not claimed as done.

---

## 8. Responsive layout

- **Desktop (≥ 981 px)**: top bar; left 288 px sidebar with five tabs
  (Scene / World / Assets / AI / Inspect); centre WebGL viewport with a floating
  transform toolbar (move/rotate/scale, world/local, snap, grid); right 300 px
  inspector column containing the scene tree and the transform/material inspector.
- **Mobile/tablet (≤ 980 px)**: full-height viewport, compact top bar, five-tab
  bottom dock (Scene / World / Assets / AI / Inspect), and a bottom sheet that
  hosts the same panels. The transform toolbar moves to the bottom centre; the
  sheet auto-opens the inspector when a node is tapped.
- Touch: OrbitControls uses `TOUCH.ROTATE` for one finger and `TOUCH.DOLLY_PAN`
  for two; `touch-action: none` avoids page scroll conflicts. Tap selection uses a
  movement/time threshold so orbiting does not select, and pointer events from a
  gizmo drag never select the mesh underneath.
- The gizmo scales itself down on narrow viewports and supports local/world space
  and snapping (0.5 units, 15°, 0.1 scale).
- Safe areas: `env(safe-area-inset-*)` applied to top bar, dock, sheet and toast;
  `100dvh` avoids mobile browser chrome overflow.
- Mobile text inputs use 16 px to prevent iOS focus zoom; controls have ≥ 44 px
  touch targets in the dock and adequate spacing elsewhere.
- The layout is exercised by a 390×844 happy-dom test (dock + sheet open/close).
  Real-device visual QA is still required (see risks).

---

## 9. Robustness and safety

- Every plan entering storage or leaving as JSON is schema-validated.
- All transform/environment/terrain patch values are finite, clamped and
  color-validated in the reducer; invalid colors are ignored.
- Object count capped at 1500, groups at 200, nesting at 8 levels; counts are
  clamped during generation.
- Imports use `parseWorldPlanLenient`: unreadable nodes are dropped with a
  warning, orphans are re-rooted and cycles broken, so one damaged object cannot
  destroy a project.
- No `dangerouslySetInnerHTML`, no remote assets, no API keys, no telemetry.
- Three.js geometries, materials, render targets and lights are disposed on
  scene rebuild/unmount; viewport has an explicit WebGL failure state.
- Seeded generation is deterministic and tested; the same prompt/seed rebuilds
  identical objects.

---

## 10. Verification results

Commands run on this branch:

```
npm run typecheck   # tsc --noEmit, strict — clean
npm test            # 87 tests in 11 files — all passed
npm run build       # tsc + vite build — success
npm run schema:export
npm run dev         # HTTP 200 via preview proxy host
npm run preview     # production build served, all chunks HTTP 200
```

**Tests (87/87 passing):**

| Area | Tests | What is covered |
| --- | --- | --- |
| Schema / versioning / repair | 13 | v2 validation, duplicate IDs, dangling parents, cycles, unknown kinds, v1→v2 migration, lenient repair |
| Generation / interpreter / terrain | 16 | determinism, biome detection, water percentile, clamping |
| Persistence / file format | 6 | IndexedDB CRUD and sort order, invalid-plan rejection, lossless JSON |
| Scene builder + GLB export | 11 | transform bridge, hierarchy nesting, visibility inheritance, grid, materials, real binary GLB |
| Hierarchy + transform math | 15 | group/ungroup/reparent world-preserving semantics, duplicate remapping, matrix round-trip |
| Editor reducer | 12 | selection modes, undo/redo, grouping history, locked nodes, clamping |
| Gizmo integration | 2 | TransformControls/OrbitControls mode, space, snap, axis constraints, attach/detach, touch config |
| WebGL bootstrap | 6 | context-failure error, sky shader/uniforms, camera-following dome, water-shader injection |
| DOM runtime | 4 | boot + generation + undo; full desktop acceptance workflow; reload restores the last world; mobile dock, sheet and axis controls |
| **End-to-end acceptance** | 1 | ground plane + cube + tree + house → edit → group → save to IndexedDB → reload → verify document **and** rendered scene graph |

**Build output:**

| Asset | Size | Gzip |
| --- | --- | --- |
| `index-*.js` | 381.29 kB | 115.67 kB |
| `three-vendor-*.js` | 546.06 kB | 137.43 kB |
| `validation-*.js` (Zod) | 92.54 kB | 26.39 kB |
| `react-vendor-*.js` | 11.88 kB | 4.20 kB |
| `GLTFExporter-*.js` (lazy) | 37.47 kB | 11.14 kB |
| `index-*.css` | 36.92 kB | 7.66 kB |

Initial payload is roughly 291 kB gzipped, with the exporter deferred.

**Runtime checks:**

- Dev server and production preview both returned 200 for the HTML, CSS and all
  JS chunks, including with a proxied `*.e2b.app` Host header (no host rejection,
  no `X-Frame-Options`).
- happy-dom runtime boot, asset add, AI generation, undo and autosave all passed.
- The full acceptance scenario runs through the real UI (add ground plane, cube,
  tree, house → select each → numeric move/rotate/scale → rename → group → save →
  reopen from the world library) and asserts the reloaded hierarchy.
- The gizmo's API contract (modes, spaces, snapping, attach/detach, touch config),
  the WebGL bootstrap error path, sky uniforms and the water shader injection are
  unit-tested; only the GPU rasterisation itself is untested.
- A real WebGL context is not available in this sandbox, so the viewport's GPU
  rendering path could **not** be executed here; the graceful-failure path was
  verified instead. Real browser/Android visual QA remains outstanding.

---

## 11. Actual code changes

The repository had only `README.md`. All files below are new in this phase.

```
.gitignore
index.html
package.json
package-lock.json
tsconfig.json
vite.config.ts
README.md                       (rewritten)
docs/ARCHITECTURE.md
docs/WORLDPLAN.md
docs/worldplan.schema.json      (generated)
scripts/exportSchema.ts
public/favicon.svg
src/main.tsx
src/app/App.tsx
src/app/App.smoke.test.tsx
src/styles/global.css
src/test/setup.ts
src/core/utils/id.ts
src/core/world-plan/schema.ts
src/core/world-plan/schema.test.ts
src/core/world-plan/factory.ts
src/core/world-plan/migrate.ts
src/core/generation/rng.ts
src/core/generation/terrain.ts
src/core/generation/biomes.ts
src/core/generation/generateWorld.ts
src/core/generation/starter.ts
src/core/generation/generation.test.ts
src/core/assets/catalog.ts
src/core/persistence/worldRepository.ts
src/core/persistence/projectFile.ts
src/core/persistence/persistence.test.ts
src/core/export/gltf.ts
src/core/export/export.test.ts
src/core/scene/sceneBuilder.ts
src/modules/ai/types.ts
src/modules/ai/promptInterpreter.ts
src/modules/editor/store.tsx
src/modules/editor/store.test.ts
src/modules/editor/useAutosave.ts
src/modules/editor/Viewport.tsx
src/modules/editor/Workspace.tsx
src/modules/editor/panels/WorldPanel.tsx
src/modules/editor/panels/AssetsPanel.tsx
src/modules/editor/panels/AiPanel.tsx
src/modules/editor/panels/InspectorPanel.tsx
src/ui/Icon.tsx
src/ui/controls.tsx
src/ui/TopBar.tsx
src/ui/ExportMenu.tsx
src/ui/WorldLibraryDialog.tsx
src/ui/useToast.ts
src/ui/useIsMobile.ts
```

Approximately 6,400 lines of TypeScript/TSX plus 2,350 lines of CSS and 800 lines of documentation.

### Phase 2 additions

New files:

```
src/core/world-plan/hierarchy.ts          # groups, parents, world transforms, reparent/group/ungroup
src/core/world-plan/transformMath.ts      # matrix compose/decompose, parent-relative conversion
src/core/world-plan/hierarchy.test.ts
src/core/scene/sceneBuilder.test.ts
src/modules/editor/ViewportToolbar.tsx
src/modules/editor/panels/HierarchyPanel.tsx
src/modules/editor/panels/nodeMeta.ts
src/modules/editor/transformControls.test.ts
src/core/scene/renderer.ts
src/core/scene/sky.ts
src/core/scene/water.ts
src/core/scene/webgl.test.ts
src/acceptance.test.ts
```

Substantially rewritten or extended:

```
src/core/world-plan/schema.ts             # v2: XYZ rotations, parentId, groups, material, integrity checks
src/core/world-plan/migrate.ts            # v1→v2 migration + lenient repair (parseWorldPlanLenient)
src/core/world-plan/factory.ts            # v2 empty plan
src/core/assets/catalog.ts                # parentId on every asset, "Ground plane" primitive
src/core/scene/sceneBuilder.ts            # hierarchy-aware build, applyTransform/readTransform, grid
src/core/persistence/projectFile.ts       # lenient file import
src/core/generation/generateWorld.ts      # v2 output
src/modules/editor/store.tsx              # multi-select, grouping, duplication, hierarchy actions
src/modules/editor/Viewport.tsx           # TransformControls gizmo, multi-select outlines, framing, touch
src/modules/editor/Workspace.tsx          # 3-column layout, inspector panel, shortcuts, save-now
src/modules/editor/panels/InspectorPanel.tsx  # local+world transforms, materials, group contents
src/ui/Icon.tsx, TopBar.tsx, controls.tsx, WorldLibraryDialog.tsx
src/styles/global.css                     # tree, toolbar, inspector and mobile sheet styling
docs/WORLDPLAN.md, docs/worldplan.schema.json, README.md
```

Removed: `src/modules/editor/panels/ObjectsPanel.tsx` (superseded by the
hierarchy tree, which shows the same data plus nesting, visibility and locks).

Notable implementation decisions:

- **No fake AI claim**: the panel is labelled as an offline rule-based
  interpreter. It produces real, deterministic worlds and reports matched cues.
  The `PromptInterpreter` interface is the seam for a future local LLM.
- **Shared scene builder** guarantees viewport/export parity and enables
  headless GLB tests.
- **Deterministic IDs** for generated objects make worlds diffable and tests
  meaningful, while document IDs stay random to avoid silent overwrites.
- **Zod-generated JSON Schema** gives external tooling a stable contract.
- **Hierarchy operations are pure functions on the document**, not on Three.js
  objects. The viewport only reads the document, so save/reopen and export can
  never drift from what the user sees.
- **World-preserving grouping**: `createGroupFromSelection` inserts an identity
  group at the root and rewrites children with `transformRelativeTo`, so visuals
  are unchanged at the moment of grouping.
- **`nodeType: 'group'` discriminant** separates groups from objects at the type
  level (objects are structurally similar, which otherwise defeats narrowing).
- **Rendering is a consumer, not the source of truth**: the shader sky and the
  water ripple live in the viewport only, so exports stay portable PBR.
- **The GPU is observable**: the HUD reads `renderer.info` and the
  `WEBGL_debug_renderer_info` extension, so "is this really rendering?" has a
  visible answer instead of a claim.

---

## 12. Risks and gaps

| Risk | Impact | Mitigation / next step |
| --- | --- | --- |
| No real GPU/browser test in this sandbox | Viewport visuals, shadows, touch orbit untested on real hardware | Run Playwright with Chromium + Android Chrome/manual device QA; add screenshot tests |
| Full object rebuild on any object change | Slider drags / large worlds may stutter, especially on phones | Dirty-object updates, `InstancedMesh`, geometry merging, LODs |
| Many draw calls at high object counts | Mobile frame rate falls | Instancing/merging; adaptive quality; lower point-light/shadow budgets |
| Terrain edits don't move existing objects | Objects can float or sink after reshaping | Add terrain-wide re-snap + a terrain height-change transaction |
| Gizmo rendering untested on real hardware | Handle sizes/overlap on high-DPI phones unverified | Real-device QA; per-device `setSize` tuning |
| Custom GLSL cannot be compiled in this sandbox | A shader syntax/API change could degrade sky or water on a real GPU | Shaders kept small and GLSL ES 1.00; sky failure still leaves the flat scene background; verify on device |
| WebGL 2 is required | Very old browsers/GPUs cannot open the viewport | Explicit capability message, retry button, all editing/persistence still works |
| Adaptive resolution lowers quality on slow devices | Blurrier image instead of stutter | Only steps down when FPS < 28 for 1.5 s; never oscillates |
| Numeric rotation edits create one history entry per keystroke | Undo may step through intermediate values | Coalesce history per field edit session |
| Shadows on large scenes | Mobile GPU cost with 1500 casters | Shadow camera fit, culling, lower shadow resolution on mobile |
| Rule-based interpreter, limited vocabulary | "AI" expectations may exceed actual capability | Add optional local LLM provider (WebLLM/Ollama) behind `PromptInterpreter`; keep offline fallback |
| Autosave debounce 650 ms | A hard close within that window can lose the last edit | Flush on pagehide/visibilitychange; save-blocked UX; export reminders |
| Browser storage eviction / private mode | Worlds can disappear | Memory fallback warning; project file export; future File System Access backup |
| Import preserves IDs | Re-import can overwrite an existing library entry | Import-as-copy / ID remap option |
| GLB lacks lights/colliders/native formats | Game engines need manual light/collision setup | Add glTF lights (`KHR_lights_punctual`), collider metadata, Godot/Unity project exporters |
| No thumbnails / search in world library | Library is plain at scale | Persist a generated preview thumbnail and tags |
| Slider edits create one history entry per tick | Undo can step through many intermediate values | Coalesce history per drag gesture |
| Group transforms are baked per child on ungroup | Very deep trees could accumulate rounding | Round to 1 mm; tested within 1e-3 |
| Mobile Safari may block async `.glb` downloads | Exported model may not save on some iOS versions | Add Web Share/file-handle fallback and test on iOS |
| Objective/automated visual regression absent | Styling regressions can slip through | Add Playwright screenshots; mobile viewport matrix |
| No PWA/offline install yet | App requires a server or local dev | Add service worker + manifest after feature stabilisation |

---

## 13. Remaining work (prioritised)

1. **Real-device verification** — desktop Chrome/Firefox/Safari and Android
   Chrome; capture screenshots; validate touch orbit and performance.
2. **Viewport interaction** — click-to-place assets on terrain, in-viewport drag
   selection box, terrain-wide snap, pivot modes. (Gizmos, multi-select,
   snapping, grouping, hierarchy and the inspector shipped in Phase 2.)
3. **Performance pass** — dirty updates, instancing/merging, adaptive shadow and
   pixel-ratio budgets; profile with 500+ objects.
4. **Generation depth** — rivers/roads, clustering, terrain sculpting, biome
   blending, regenerate-in-place from stored intent + seed.
5. **AI expansion** — optional local-LLM provider with schema-constrained output,
   prompt history and conversational edits; no paid API requirement.
6. **Asset pipeline** — more archetypes, material presets, optional user glTF
   asset import, thumbnails and a searchable library.
7. **Engine exports** — glTF lights, collider metadata, Godot scene/import
   settings, Unity-friendly packaging, LODs.
8. **Storage improvements** — import-as-copy, thumbnails/tags, pagehide flush,
   optional File System Access API backup.
9. **Quality** — Playwright E2E with WebGL, accessibility audit, error boundary,
   performance budgets and CI workflow.
10. **PWA** — manifest + service worker for installable offline use.

Phase 2 is intentionally limited to an editor that can be verified: every
transform operation, group operation and save/reopen path is covered by tests.
No placeholder buttons, mock exports or simulated AI results were shipped, and
Phase 3 has not been started (it is gated on desktop + Android acceptance).
