import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import type {
  Terrain,
  TerrainStyle,
  Transform,
  WorldEnvironment,
  WorldObject,
  WorldPlan,
} from '../../core/world-plan/schema';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { createId } from '../../core/utils/id';

const HISTORY_LIMIT = 60;

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface ObjectPatch {
  name?: string;
  transform?: Partial<Transform>;
  visible?: boolean;
  locked?: boolean;
  color?: string;
  trunkColor?: string;
  roofColor?: string;
}

export interface EditorState {
  plan: WorldPlan;
  selectedId: string | null;
  past: WorldPlan[];
  future: WorldPlan[];
  /** Monotonic counter of plan mutations; drives autosave. */
  revision: number;
  saveState: SaveState;
  saveError: string | null;
}

export type EditorAction =
  | { type: 'replacePlan'; plan: WorldPlan; recordHistory?: boolean }
  | { type: 'renameWorld'; name: string }
  | { type: 'updateEnvironment'; patch: Partial<WorldEnvironment> }
  | { type: 'updateTerrain'; patch: Partial<Terrain> }
  | { type: 'addObject'; object: WorldObject; select?: boolean }
  | { type: 'updateObject'; id: string; patch: ObjectPatch }
  | { type: 'removeObject'; id: string }
  | { type: 'duplicateObject'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setSaveState'; status: SaveState; error?: string | null };

export function createInitialEditorState(plan: WorldPlan): EditorState {
  return {
    plan,
    selectedId: null,
    past: [],
    future: [],
    revision: 0,
    saveState: 'idle',
    saveError: null,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function touch(plan: WorldPlan): WorldPlan {
  return { ...plan, updatedAt: nowIso() };
}

function commit(state: EditorState, plan: WorldPlan, selectedId = state.selectedId): EditorState {
  return {
    ...state,
    plan: touch(plan),
    selectedId,
    past: [...state.past, state.plan].slice(-HISTORY_LIMIT),
    future: [],
    revision: state.revision + 1,
    saveState: 'pending',
    saveError: null,
  };
}

function finiteOr(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampPosition(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    finiteOr(Number(value[0]), fallback[0], -2000, 2000),
    finiteOr(Number(value[1]), fallback[1], -2000, 2000),
    finiteOr(Number(value[2]), fallback[2], -2000, 2000),
  ];
}

function clampScale(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    finiteOr(Number(value[0]), fallback[0], 0.05, 100),
    finiteOr(Number(value[1]), fallback[1], 0.05, 100),
    finiteOr(Number(value[2]), fallback[2], 0.05, 100),
  ];
}

function hexOr(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

export function applyObjectPatch(object: WorldObject, patch: ObjectPatch): WorldObject {
  const next = { ...object } as WorldObject & {
    trunkColor?: string;
    roofColor?: string;
  };

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim().slice(0, 80);
    next.name = trimmed || object.name;
  }
  if (patch.visible !== undefined) next.visible = Boolean(patch.visible);
  if (patch.locked !== undefined) next.locked = Boolean(patch.locked);
  if (patch.color !== undefined) next.color = hexOr(patch.color, next.color);

  if (patch.trunkColor !== undefined && 'trunkColor' in next) {
    next.trunkColor = hexOr(patch.trunkColor, next.trunkColor ?? '#4b3521');
  }
  if (patch.roofColor !== undefined && 'roofColor' in next) {
    next.roofColor = hexOr(patch.roofColor, next.roofColor ?? '#7a4d3c');
  }

  if (patch.transform) {
    const current = next.transform;
    const candidate = patch.transform;
    next.transform = {
      position: clampPosition(candidate.position, current.position),
      rotationY: finiteOr(candidate.rotationY, current.rotationY, -360, 360),
      scale: clampScale(candidate.scale, current.scale),
    };
  }

  return next;
}

const TERRAIN_STYLES: TerrainStyle[] = ['flat', 'hills', 'mountains', 'dunes', 'islands'];

function updateTerrain(plan: WorldPlan, patch: Partial<Terrain>): WorldPlan {
  const current = plan.terrain;
  const candidate = patch;
  return {
    ...plan,
    terrain: {
      style:
        candidate.style && TERRAIN_STYLES.includes(candidate.style)
          ? candidate.style
          : current.style,
      size: Math.round(finiteOr(candidate.size, current.size, 32, 512)),
      resolution: Math.round(finiteOr(candidate.resolution, current.resolution, 16, 256)),
      heightScale: finiteOr(candidate.heightScale, current.heightScale, 0, 200),
      // Only touch water when the patch actually mentions it; a style or size
      // change must not silently turn water on.
      waterLevel:
        candidate.waterLevel === undefined
          ? current.waterLevel
          : candidate.waterLevel === null
            ? null
            : finiteOr(candidate.waterLevel, current.waterLevel ?? 0, -200, 200),
      palette: {
        low: hexOr(candidate.palette?.low, current.palette.low),
        high: hexOr(candidate.palette?.high, current.palette.high),
      },
    },
  };
}

function updateEnvironment(plan: WorldPlan, patch: Partial<WorldEnvironment>): WorldPlan {
  const current = plan.environment;
  return {
    ...plan,
    environment: {
      skyColor: hexOr(patch.skyColor, current.skyColor),
      fogColor: hexOr(patch.fogColor, current.fogColor),
      fogDensity: finiteOr(patch.fogDensity, current.fogDensity, 0, 1),
      sunColor: hexOr(patch.sunColor, current.sunColor),
      sunAzimuth: finiteOr(patch.sunAzimuth, current.sunAzimuth, 0, 360),
      sunElevation: finiteOr(patch.sunElevation, current.sunElevation, 0, 90),
      sunIntensity: finiteOr(patch.sunIntensity, current.sunIntensity, 0, 4),
      ambientIntensity: finiteOr(patch.ambientIntensity, current.ambientIntensity, 0, 3),
    },
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'replacePlan': {
      const record = action.recordHistory ?? true;
      return {
        ...state,
        plan: action.plan,
        selectedId: null,
        past: record ? [...state.past, state.plan].slice(-HISTORY_LIMIT) : [],
        future: [],
        revision: state.revision + 1,
        saveState: 'pending',
        saveError: null,
      };
    }

    case 'renameWorld': {
      const name = action.name.trim().slice(0, 80) || 'Untitled World';
      if (name === state.plan.name) return state;
      return commit(state, { ...state.plan, name });
    }

    case 'updateEnvironment': {
      return commit(state, updateEnvironment(state.plan, action.patch));
    }

    case 'updateTerrain': {
      return commit(state, updateTerrain(state.plan, action.patch));
    }

    case 'addObject': {
      if (state.plan.objects.length >= MAX_WORLD_OBJECTS) return state;
      if (state.plan.objects.some((object) => object.id === action.object.id)) return state;
      return commit(
        state,
        { ...state.plan, objects: [...state.plan.objects, action.object] },
        action.select === false ? state.selectedId : action.object.id,
      );
    }

    case 'updateObject': {
      const object = state.plan.objects.find((entry) => entry.id === action.id);
      if (!object) return state;
      const updated = applyObjectPatch(object, action.patch);
      return commit(state, {
        ...state.plan,
        objects: state.plan.objects.map((entry) => (entry.id === action.id ? updated : entry)),
      });
    }

    case 'removeObject': {
      if (!state.plan.objects.some((entry) => entry.id === action.id)) return state;
      return commit(
        state,
        { ...state.plan, objects: state.plan.objects.filter((entry) => entry.id !== action.id) },
        state.selectedId === action.id ? null : state.selectedId,
      );
    }

    case 'duplicateObject': {
      const object = state.plan.objects.find((entry) => entry.id === action.id);
      if (!object || state.plan.objects.length >= MAX_WORLD_OBJECTS) return state;
      const clone: WorldObject = {
        ...object,
        id: createId('obj'),
        name: `${object.name} copy`.slice(0, 80),
        transform: {
          ...object.transform,
          position: [
            object.transform.position[0] + 2,
            object.transform.position[1],
            object.transform.position[2] + 2,
          ],
        },
      };
      return commit(
        state,
        { ...state.plan, objects: [...state.plan.objects, clone] },
        clone.id,
      );
    }

    case 'select': {
      if (action.id === state.selectedId) return state;
      if (action.id !== null && !state.plan.objects.some((entry) => entry.id === action.id)) {
        return state;
      }
      return { ...state, selectedId: action.id };
    }

    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        plan: touch(previous),
        selectedId: previous.objects.some((entry) => entry.id === state.selectedId)
          ? state.selectedId
          : null,
        past: state.past.slice(0, -1),
        future: [state.plan, ...state.future].slice(0, HISTORY_LIMIT),
        revision: state.revision + 1,
        saveState: 'pending',
        saveError: null,
      };
    }

    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        plan: touch(next),
        selectedId: next.objects.some((entry) => entry.id === state.selectedId)
          ? state.selectedId
          : null,
        past: [...state.past, state.plan].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        revision: state.revision + 1,
        saveState: 'pending',
        saveError: null,
      };
    }

    case 'setSaveState': {
      return {
        ...state,
        saveState: action.status,
        saveError: action.error ?? null,
      };
    }

    default:
      return state;
  }
}

interface EditorContextValue {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function EditorProvider({
  children,
  initialPlan,
}: {
  children: ReactNode;
  initialPlan: WorldPlan;
}) {
  const [state, dispatch] = useReducer(editorReducer, initialPlan, createInitialEditorState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (!value) throw new Error('useEditor must be used inside <EditorProvider>');
  return value;
}

export function useSelectedObject(): WorldObject | null {
  const { state } = useEditor();
  if (!state.selectedId) return null;
  return state.plan.objects.find((object) => object.id === state.selectedId) ?? null;
}
