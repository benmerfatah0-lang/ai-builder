import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  MAX_WORLD_OBJECTS,
  isGroup,
  type MaterialSettings,
  type SceneNode,
  type Terrain,
  type TerrainStyle,
  type Transform,
  type WorldEnvironment,
  type WorldObject,
  type WorldPlan,
} from '../../core/world-plan/schema';
import {
  regenerateObjectInPlan,
  regenerateRegion,
} from '../../core/generation/regenerate';
import {
  createGroupFromSelection,
  duplicateNodes,
  getNode,
  isEffectivelyLocked,
  removeNodes,
  renameNode,
  reparentNode,
  setNodeTransform,
  setNodeWorldTransform,
  setNodeVisible,
  setNodeLocked,
  ungroupNode,
} from '../../core/world-plan/hierarchy';
import { createId } from '../../core/utils/id';

const HISTORY_LIMIT = 80;

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export type SelectionMode = 'replace' | 'add' | 'toggle';

export interface ObjectPatch {
  name?: string;
  transform?: Partial<Transform>;
  visible?: boolean;
  locked?: boolean;
  color?: string;
  trunkColor?: string;
  roofColor?: string;
  /** Colour of the kind's secondary channel (roof, trunk, rails, soil). */
  secondaryColor?: string;
  material?: Partial<MaterialSettings>;
}

export interface EditorState {
  plan: WorldPlan;
  /** Selected node ids (objects or groups). The last entry is the primary. */
  selection: string[];
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
  | { type: 'setTransform'; id: string; transform: Transform }
  | { type: 'setWorldTransform'; id: string; transform: Transform }
  | { type: 'select'; ids: string[]; mode?: SelectionMode }
  | { type: 'renameNode'; id: string; name: string }
  | { type: 'setVisible'; id: string; visible: boolean }
  | { type: 'setLocked'; id: string; locked: boolean }
  | { type: 'groupSelection'; name?: string }
  | { type: 'ungroup'; id: string }
  | { type: 'reparent'; id: string; parentId: string | null }
  | { type: 'deleteSelection' }
  | { type: 'deleteNode'; id: string }
  | { type: 'duplicateSelection' }
  | { type: 'regenerateObject'; id: string }
  | { type: 'regenerateRegion'; region: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'setSaveState'; status: SaveState; error?: string | null };

export function createInitialEditorState(plan: WorldPlan): EditorState {
  return {
    plan,
    selection: [],
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

/** Mark an object as user-tweaked so future region rebuilds can respect it. */
function markEdited(object: WorldObject): WorldObject {
  if (object.meta.status === 'edited') return object;
  return { ...object, meta: { ...object.meta, status: 'edited' } };
}

function markEditedPlan(plan: WorldPlan, id: string): WorldPlan {
  const node = getNode(plan, id);
  if (!node || isGroup(node)) return plan;
  return {
    ...plan,
    objects: plan.objects.map((object) =>
      object.id === id ? markEdited(object) : object,
    ),
  };
}

function existingIds(plan: WorldPlan, ids: string[]): string[] {
  return ids.filter((id) => getNode(plan, id) !== null);
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

function commit(state: EditorState, plan: WorldPlan, selection?: string[]): EditorState {
  if (plan === state.plan) return state;
  const touched = touch(plan);
  return {
    ...state,
    plan: touched,
    selection: existingIds(touched, selection ?? state.selection),
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
    finiteOr(Number(value[0]), fallback[0], -5000, 5000),
    finiteOr(Number(value[1]), fallback[1], -5000, 5000),
    finiteOr(Number(value[2]), fallback[2], -5000, 5000),
  ];
}

function clampScale(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    finiteOr(Number(value[0]), fallback[0], 0.05, 200),
    finiteOr(Number(value[1]), fallback[1], 0.05, 200),
    finiteOr(Number(value[2]), fallback[2], 0.05, 200),
  ];
}

function clampRotation(
  value: unknown,
  fallback: [number, number, number],
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    finiteOr(Number(value[0]), fallback[0], -3600, 3600),
    finiteOr(Number(value[1]), fallback[1], -3600, 3600),
    finiteOr(Number(value[2]), fallback[2], -3600, 3600),
  ];
}

function hexOr(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : fallback;
}

export function applyTransformPatch(current: Transform, patch: Partial<Transform>): Transform {
  return {
    position: clampPosition(patch.position, current.position),
    rotation: clampRotation(patch.rotation, current.rotation),
    scale: clampScale(patch.scale, current.scale),
  };
}

export function applyMaterialPatch(
  current: MaterialSettings | undefined,
  patch: Partial<MaterialSettings>,
): MaterialSettings {
  return {
    roughness: finiteOr(patch.roughness, current?.roughness ?? 0.86, 0, 1),
    metalness: finiteOr(patch.metalness, current?.metalness ?? 0, 0, 1),
    emissiveIntensity: finiteOr(patch.emissiveIntensity, current?.emissiveIntensity ?? 1, 0, 5),
  };
}

export function applyObjectPatch(object: WorldObject, patch: ObjectPatch): WorldObject {
  const next = { ...object } as WorldObject & {
    trunkColor?: string;
    roofColor?: string;
    material?: MaterialSettings;
  };

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim().slice(0, 80);
    next.name = trimmed || object.name;
  }
  if (patch.visible !== undefined) next.visible = Boolean(patch.visible);
  if (patch.locked !== undefined) next.locked = Boolean(patch.locked);
  if (patch.color !== undefined) {
    // Fences, fields and bridges store their base colour in a named channel.
    if (next.kind === 'fence') next.postColor = hexOr(patch.color, next.postColor);
    else if (next.kind === 'field') next.cropColor = hexOr(patch.color, next.cropColor);
    else if (next.kind === 'bridge') next.deckColor = hexOr(patch.color, next.deckColor);
    else next.color = hexOr(patch.color, next.color);
  }
  if (patch.secondaryColor !== undefined) {
    if (next.kind === 'building') next.roofColor = hexOr(patch.secondaryColor, next.roofColor);
    else if (next.kind === 'tree') next.trunkColor = hexOr(patch.secondaryColor, next.trunkColor);
    else if (next.kind === 'fence' || next.kind === 'bridge') {
      next.railColor = hexOr(patch.secondaryColor, next.railColor);
    } else if (next.kind === 'field') {
      next.soilColor = hexOr(patch.secondaryColor, next.soilColor);
    }
  }

  if (patch.trunkColor !== undefined && 'trunkColor' in next) {
    next.trunkColor = hexOr(patch.trunkColor, next.trunkColor ?? '#4b3521');
  }
  if (patch.roofColor !== undefined && 'roofColor' in next) {
    next.roofColor = hexOr(patch.roofColor, next.roofColor ?? '#7a4d3c');
  }
  if (patch.material !== undefined) {
    next.material = applyMaterialPatch(next.material, patch.material);
  }
  if (patch.transform) {
    next.transform = applyTransformPatch(next.transform, patch.transform);
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
      // Only touch water when the patch mentions it.
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

function selectAction(
  state: EditorState,
  ids: string[],
  mode: SelectionMode,
): EditorState {
  const valid = existingIds(state.plan, ids);
  let next: string[];
  if (mode === 'replace') {
    next = unique(valid);
  } else if (mode === 'add') {
    next = unique([...state.selection, ...valid]);
  } else {
    const set = new Set(state.selection);
    for (const id of valid) {
      if (set.has(id)) set.delete(id);
      else set.add(id);
    }
    next = [...set];
  }
  if (next.length === state.selection.length && next.every((id, i) => id === state.selection[i])) {
    return state;
  }
  return { ...state, selection: next };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'replacePlan': {
      const record = action.recordHistory ?? true;
      return {
        ...state,
        plan: action.plan,
        selection: [],
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

    case 'updateEnvironment':
      return commit(state, updateEnvironment(state.plan, action.patch));

    case 'updateTerrain':
      return commit(state, updateTerrain(state.plan, action.patch));

    case 'addObject': {
      if (state.plan.objects.length >= MAX_WORLD_OBJECTS) return state;
      if (getNode(state.plan, action.object.id)) return state;
      const plan = { ...state.plan, objects: [...state.plan.objects, action.object] };
      return commit(state, plan, action.select === false ? state.selection : [action.object.id]);
    }

    case 'updateObject': {
      const object = state.plan.objects.find((entry) => entry.id === action.id);
      if (!object) return state;
      const patch = { ...action.patch };
      // Locked objects keep their transform; other edits (revealing, renaming) pass.
      if (patch.transform && isEffectivelyLocked(state.plan, action.id)) delete patch.transform;
      const updated = markEdited(applyObjectPatch(object, patch));
      if (updated === object) return state;
      return commit(state, {
        ...state.plan,
        objects: state.plan.objects.map((entry) => (entry.id === action.id ? updated : entry)),
      });
    }

    case 'setTransform': {
      const node = getNode(state.plan, action.id);
      if (!node) return state;
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const safe = applyTransformPatch(node.transform, action.transform);
      return commit(state, markEditedPlan(setNodeTransform(state.plan, action.id, safe), action.id));
    }

    case 'setWorldTransform': {
      const node = getNode(state.plan, action.id);
      if (!node) return state;
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const safe = applyTransformPatch(node.transform, action.transform);
      return commit(
        state,
        markEditedPlan(setNodeWorldTransform(state.plan, action.id, safe), action.id),
      );
    }

    case 'regenerateObject': {
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const result = regenerateObjectInPlan(state.plan, action.id);
      if (result.changed.length === 0) return state;
      return commit(state, result.plan);
    }

    case 'regenerateRegion': {
      const result = regenerateRegion(state.plan, action.region);
      if (result.changed.length === 0) return state;
      // Locked objects keep their authored look.
      const lockedIds = new Set(
        state.plan.objects
          .filter((object) => object.meta.region === action.region)
          .filter((object) => isEffectivelyLocked(state.plan, object.id))
          .map((object) => object.id),
      );
      if (lockedIds.size === 0) return commit(state, result.plan);
      const originals = new Map(
        state.plan.objects.map((object) => [object.id, object] as const),
      );
      const plan = {
        ...result.plan,
        objects: result.plan.objects.map((object) =>
          lockedIds.has(object.id) ? originals.get(object.id) ?? object : object,
        ),
      };
      return commit(state, plan);
    }

    case 'select':
      return selectAction(state, action.ids, action.mode ?? 'replace');

    case 'renameNode':
      return commit(state, renameNode(state.plan, action.id, action.name));

    case 'setVisible':
      return commit(state, setNodeVisible(state.plan, action.id, action.visible));

    case 'setLocked':
      return commit(state, setNodeLocked(state.plan, action.id, action.locked));

    case 'groupSelection': {
      const result = createGroupFromSelection(state.plan, state.selection, action.name);
      if (!result.groupId) return state;
      return commit(state, result.plan, [result.groupId]);
    }

    case 'ungroup': {
      const node = getNode(state.plan, action.id);
      if (!node || !isGroup(node)) return state;
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const plan = ungroupNode(state.plan, action.id);
      if (plan === state.plan) return state;
      return commit(
        state,
        plan,
        state.selection.filter((id) => id !== action.id),
      );
    }

    case 'reparent': {
      const node = getNode(state.plan, action.id);
      if (!node) return state;
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const plan = reparentNode(state.plan, action.id, action.parentId);
      return plan === state.plan ? state : commit(state, plan);
    }

    case 'deleteSelection': {
      const deletable = state.selection.filter(
        (id) => !isEffectivelyLocked(state.plan, id),
      );
      if (deletable.length === 0) return state;
      const plan = removeNodes(state.plan, deletable);
      if (plan === state.plan) return state;
      return commit(
        state,
        plan,
        state.selection.filter((id) => !deletable.includes(id)),
      );
    }

    case 'deleteNode': {
      if (isEffectivelyLocked(state.plan, action.id)) return state;
      const plan = removeNodes(state.plan, [action.id]);
      if (plan === state.plan) return state;
      return commit(
        state,
        plan,
        state.selection.filter((id) => id !== action.id),
      );
    }

    case 'duplicateSelection': {
      const result = duplicateNodes(state.plan, state.selection);
      if (result.newIds.length === 0) return state;
      return commit(state, result.plan, result.newIds);
    }

    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        plan: touch(previous),
        selection: existingIds(previous, state.selection),
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
        selection: existingIds(next, state.selection),
        past: [...state.past, state.plan].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        revision: state.revision + 1,
        saveState: 'pending',
        saveError: null,
      };
    }

    case 'setSaveState':
      return { ...state, saveState: action.status, saveError: action.error ?? null };

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

export function primarySelectionId(state: EditorState): string | null {
  return state.selection[state.selection.length - 1] ?? null;
}

export function usePrimaryNode(): SceneNode | null {
  const { state } = useEditor();
  const id = primarySelectionId(state);
  return id ? getNode(state.plan, id) : null;
}

export function useSelectedNodes(): SceneNode[] {
  const { state } = useEditor();
  return state.selection
    .map((id) => getNode(state.plan, id))
    .filter((node): node is SceneNode => node !== null);
}

/** Unique name helper used when adding objects or duplicating. */
export function nextAvailableName(plan: WorldPlan, base: string): string {
  const names = new Set([...plan.groups, ...plan.objects].map((node) => node.name));
  if (!names.has(base)) return base;
  let index = 2;
  while (names.has(`${base} ${index}`) && index < 10_000) index += 1;
  return `${base} ${index}`;
}

export { createId };
