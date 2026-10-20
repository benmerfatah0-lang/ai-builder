# AI World Builder

A free-first, local-first 3D world editor for the browser. Describe a world in
text, inspect and edit it in a Three.js viewport, save it locally, and export it
as a project file or a glTF 2.0 model for Godot and Unity.

> **Phase 1 status:** the repository contained only a one-line README when this
> phase started, so this is a newly established foundation rather than a refactor
> of existing code. The full audit, architecture, risks and remaining work are in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## What works today

- **3D viewport** — Three.js WebGL renderer, orbit/pan/zoom, terrain, water,
  shadows, sky/fog, click/tap selection with an outline.
- **Procedural worlds** — five terrain styles (hills, flat, mountains, dunes,
  islands), seeded object scatter, settlements, ruins, lanterns, palms, cacti,
  biome palettes and day/sunset/night lighting.
- **Text-to-world generation** — a deterministic, fully offline interpreter maps
  descriptions to biomes, time of day, scale, water and object counts. The same
  description and seed rebuild the same world. The matched cues are shown in the
  UI, so behaviour is transparent.
- **Editor** — object hierarchy with search and visibility, asset library,
  numeric transforms, rotation, scale, colours, lock/visibility, duplicate,
  delete, snap-to-ground, undo/redo, keyboard shortcuts.
- **Local saving** — debounced autosave to IndexedDB, a multi-world library,
  in-app status, import/export of `.world.json` project files, and a session
  fallback when IndexedDB is blocked.
- **Export** — lossless WorldPlan JSON and binary glTF 2.0 (`.glb`) built from
  the same scene as the viewport. The glTF exporter is lazy-loaded.
- **Responsive UI** — desktop three-column layout and a mobile layout with a
  bottom dock, bottom sheet, touch orbit, safe-area handling and 16 px inputs.

No paid APIs, accounts, telemetry or remote assets are used. All generation,
rendering, saving and exporting happens in the browser.

### What is deliberately not there yet

This phase ships only verified foundations — no placeholder buttons or mock
features:

- The “AI” is currently a **rule-based offline interpreter**, not an LLM. A local
  LLM can implement the existing `PromptInterpreter` interface later.
- No transform gizmos, click-to-place, multi-select or terrain sculpting yet.
- GLB export has geometry/materials/vertex colours but no lights, colliders,
  LODs or native Godot/Unity project files.
- Terrain edits do not automatically move existing objects (per-object “Snap to
  ground” is available).
- The WebGL rendering path could not be visually tested in the development
  sandbox; real desktop/Android QA is the first remaining task.

Full risk list and roadmap: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start

Requirements: **Node.js 20.19+ or 22.12+** (Vite 7). No API keys or environment
variables are needed.

```bash
npm install
npm run dev        # http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview    # serves dist/ on http://localhost:4173
```

---

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server bound to `0.0.0.0`. |
| `npm run build` | Strict type-check, then production build to `dist/`. |
| `npm run preview` | Preview the production build. |
| `npm run typecheck` | `tsc --noEmit` with strict settings. |
| `npm test` | Vitest: schema, generation, persistence, export, store, DOM runtime. |
| `npm run test:watch` | Watch mode. |
| `npm run schema:export` | Regenerate `docs/worldplan.schema.json` from the Zod schema. |

---

## Project structure

```
src/
  app/                 React entry composition
  core/
    world-plan/        WorldPlan v1 schema, factory, migration, serialisation
    generation/        seeded RNG, terrain sampler, biomes, generator, starter
    assets/            procedural asset library + placement helpers
    persistence/       IndexedDB/memory repositories, project file I/O
    export/            glTF 2.0 (.glb) exporter + export target metadata
    scene/             shared Three.js scene builder (viewport + exporter)
    utils/             IDs, hashing, clamping
  modules/
    ai/                intent types, provider contract, offline interpreter
    editor/            reducer store, autosave, viewport, shell, panels
  ui/                  icons, controls, top bar, library dialog, export menu, toast
  styles/              design tokens + responsive CSS
  test/                Vitest setup (fake IndexedDB, GLB FileReader shim)
scripts/               schema export
docs/                  architecture report, WorldPlan reference, JSON Schema
```

Key design rule: the **WorldPlan document is the only source of truth**, and the
viewport and exporters share one scene builder. React never owns scene objects
outside the viewport component.

---

## Saving and backup

Worlds autosave to this browser's IndexedDB after ~0.65 s of inactivity and are
listed in the world library. Browser storage can be cleared by the user, the
browser or private mode, so use **Export → Project file** for anything important.
Project files are self-contained, versioned and re-importable; they are also the
way to move worlds between devices.

The document format is documented in [`docs/WORLDPLAN.md`](docs/WORLDPLAN.md),
with a generated JSON Schema at
[`docs/worldplan.schema.json`](docs/worldplan.schema.json).

---

## Exporting to Godot and Unity

**Export → 3D model** produces a binary glTF 2.0 file:

- **Godot 4** imports `.glb` natively (drag it into the project).
- **Unity** needs a free glTF importer package; the file is standard glTF 2.0.
- Materials use PBR metallic-roughness with vertex colours on the terrain.
- Lights, collision and LODs are not exported yet.

**Export → Project file** is the lossless format for re-opening in this editor.

---

## Tech stack

React 19 · TypeScript 5.9 · Vite 7 · Three.js r186 · Zod 4 · IndexedDB · Vitest ·
Testing Library · happy-dom · fake-indexeddb. All open source, no paid services.

---

## Verification (Phase 1)

- `npm run typecheck` — clean (strict, `noUncheckedIndexedAccess`).
- `npm test` — **41 tests / 6 files passing**, including a real binary GLB parse,
  IndexedDB CRUD, deterministic generation and DOM runtime flows on desktop and
  mobile viewport widths.
- `npm run build` — success. Initial gzip payload ≈ 265 kB; exporter is deferred.
- Dev and preview servers return HTTP 200 for all assets through a proxied host.
- Real WebGL/GPU and physical-device testing remains outstanding (see risks).

---

## Roadmap

Viewport gizmos and touch editing → performance (instancing/dirty updates) →
deeper procedural generation → optional local-LLM provider → asset pipeline →
native engine exports → PWA/offline install. Details and acceptance criteria are
tracked in the architecture report.
