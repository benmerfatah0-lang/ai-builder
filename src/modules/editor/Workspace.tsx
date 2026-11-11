import { KeepAlive } from './KeepAlive';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import type { WorldPlan } from '../../core/world-plan/schema';
import { readWorldFile, readWorldFileLenient } from '../../core/persistence/projectFile';
import {
  createMemoryWorldRepository,
  getWorldRepository,
  setWorldRepository,
  type WorldRepository,
  type WorldSummary,
} from '../../core/persistence/worldRepository';
import { createStarterWorld } from '../../core/generation/starter';
import { createId } from '../../core/utils/id';
import { useEditor } from './store';
import { useMapTrainer } from './useMapTrainer';
import { useAutosave } from './useAutosave';
import {
  ALL_AXES,
  Viewport,
  type AxisFilter,
  type TransformSpace,
  type TransformTool,
} from './Viewport';
import { ViewportToolbar } from './ViewportToolbar';
import { ForgeHome } from './ForgeHome';
import { WorldPanel } from './panels/WorldPanel';
import { HierarchyPanel } from './panels/HierarchyPanel';
import { AssetsPanel } from './panels/AssetsPanel';
import { AiPanel } from './panels/AiPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { TopBar } from '../../ui/TopBar';
import { WorldLibraryDialog } from '../../ui/WorldLibraryDialog';
import { Icon, type IconName } from '../../ui/Icon';
import { useToast } from '../../ui/useToast';
import { useIsMobile } from '../../ui/useIsMobile';

type DesktopTab = 'world' | 'scene' | 'assets' | 'ai';
type MobilePanel = DesktopTab | 'inspector';

const DESKTOP_TABS: { id: DesktopTab; label: string; icon: IconName }[] = [
  { id: 'world', label: 'العالم', icon: 'sliders' },
  { id: 'scene', label: 'العناصر', icon: 'layers' },
  { id: 'assets', label: 'أشكال', icon: 'cube' },
  { id: 'ai', label: 'بناء وتعديل', icon: 'sparkles' },
];

const MOBILE_TABS: { id: MobilePanel; label: string; icon: IconName }[] = [
  ...DESKTOP_TABS,
  { id: 'inspector', label: 'الخصائص', icon: 'info' },
];

const PANEL_TITLES: Record<MobilePanel, string> = {
  world: 'العالم',
  scene: 'العناصر',
  assets: 'أشكال',
  ai: 'بناء وتعديل',
  inspector: 'الخصائص',
};

export function Workspace() {
  const { state, dispatch, constructionPreview } = useEditor();
  const mapTrainer = useMapTrainer();
  const [repository, setRepository] = useState<WorldRepository>(() => getWorldRepository());
  const [storageKind, setStorageKind] = useState<'indexeddb' | 'memory'>(
    () => getWorldRepository().kind,
  );
  const [ready, setReady] = useState(false);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [view, setView] = useState<'forge' | 'studio'>('forge');
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<DesktopTab>('ai');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>('ai');
  const [tool, setTool] = useState<TransformTool>('translate');
  const [space, setSpace] = useState<TransformSpace>('world');
  const [snap, setSnap] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [walkMode, setWalkMode] = useState(false);
  useEffect(() => { if (view !== 'studio') setWalkMode(false); }, [view]);
  useEffect(() => { setWalkMode(false); }, [state.plan.id]);
  const [axes, setAxes] = useState<AxisFilter>(ALL_AXES);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isMobile = useIsMobile();
  const { toast, notify } = useToast();

  useAutosave(state, dispatch, repository, ready);

  // Boot: open the most recent local world, or generate the starter world once.
  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      let activeRepository = getWorldRepository();
      let summaries: WorldSummary[] = [];

      try {
        summaries = await activeRepository.list();
      } catch (error) {
        console.error('IndexedDB unavailable, falling back to a temporary session.', error);
        activeRepository = createMemoryWorldRepository();
        setWorldRepository(activeRepository);
        if (cancelled) return;
        setRepository(activeRepository);
        setStorageKind('memory');
        setWorlds([]);
        dispatch({ type: 'replacePlan', plan: createStarterWorld(), recordHistory: false });
        notify(
          'Local storage is blocked. This world will last for this session only — export it to keep it.',
          'danger',
        );
        setReady(true);
        return;
      }

      if (cancelled) return;
      setWorlds(summaries);

      let plan: WorldPlan | null = null;
      if (summaries[0]) {
        try {
          plan = await activeRepository.load(summaries[0].id);
        } catch (error) {
          console.error('Could not open the most recent world.', error);
          notify('The last world could not be opened. Started a new world instead.', 'danger');
        }
      }

      if (cancelled) return;
      dispatch({
        type: 'replacePlan',
        plan: plan ?? createStarterWorld(),
        recordHistory: false,
      });
      setReady(true);
    };

    void boot();
    return () => {
      cancelled = true;
    };
    // Boot runs exactly once; repository and notify are stable singletons/hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshWorlds = useCallback(async () => {
    setLibraryLoading(true);
    try {
      setWorlds(await repository.list());
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'Could not read the world library.',
        'danger',
      );
    } finally {
      setLibraryLoading(false);
    }
  }, [repository, notify]);

  const openLibrary = useCallback(() => {
    setLibraryOpen(true);
    void refreshWorlds();
  }, [refreshWorlds]);

  // Keep the library in sync once an autosave lands (and after the first save).
  useEffect(() => {
    if (state.saveState === 'saved' && ready) void refreshWorlds();
  }, [state.saveState, ready, refreshWorlds]);

  const saveNow = useCallback(async () => {
    dispatch({ type: 'setSaveState', status: 'saving' });
    try {
      await repository.save(state.plan);
      dispatch({ type: 'setSaveState', status: 'saved' });
      notify('Project saved in this browser.', 'success');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The project could not be saved.';
      dispatch({ type: 'setSaveState', status: 'error', error: message });
      notify(message, 'danger');
    }
  }, [repository, state.plan, dispatch, notify]);

  const startNewWorld = useCallback(() => {
    const plan = createEmptyWorldPlan({ name: 'Untitled World' });
    dispatch({ type: 'replacePlan', plan });
    setLibraryOpen(false);
    setView('studio');
    setMobilePanel(null);
    notify('Blank world created.', 'success');
  }, [dispatch, notify]);

  const openWorld = async (id: string) => {
    try {
      const plan = await repository.load(id);
      if (!plan) {
        notify('That world could not be found.', 'danger');
        void refreshWorlds();
        return;
      }
      dispatch({ type: 'replacePlan', plan });
      setLibraryOpen(false);
      setView('studio');
      setMobilePanel(null);
      notify(`Opened “${plan.name}”.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open that world.', 'danger');
    }
  };

  const duplicateWorld = async (id: string) => {
    try {
      const source = await repository.load(id);
      if (!source) {
        notify('That world could not be found.', 'danger');
        return;
      }
      const now = new Date().toISOString();
      const copy: WorldPlan = {
        ...source,
        id: createId('world'),
        name: `${source.name} copy`.slice(0, 80),
        createdAt: now,
        updatedAt: now,
      };
      await repository.save(copy);
      await refreshWorlds();
      notify(`Duplicated “${source.name}”.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not duplicate that world.', 'danger');
    }
  };

  const deleteWorld = async (id: string) => {
    try {
      await repository.delete(id);
      await refreshWorlds();
      if (id === state.plan.id) {
        dispatch({
          type: 'replacePlan',
          plan: createEmptyWorldPlan({ name: 'Untitled World' }),
          recordHistory: false,
        });
        setMobilePanel(null);
        setLibraryOpen(false);
      }
      notify('World deleted.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not delete that world.', 'danger');
    }
  };

  const triggerImport = () => fileInputRef.current?.click();

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const plan = await readWorldFile(file);
      dispatch({ type: 'replacePlan', plan });
      setLibraryOpen(false);
      setView('studio');
      setMobilePanel(null);
      notify(`Imported “${plan.name}”.`, 'success');
    } catch (error) {
      // A damaged file may still be partially recoverable.
      try {
        const repaired = await readWorldFileLenient(file);
        dispatch({ type: 'replacePlan', plan: repaired.plan });
        setLibraryOpen(false);
        setView('studio');
        setMobilePanel(null);
        notify(
          repaired.warnings.length > 0
            ? `Imported with repairs: ${repaired.warnings.join(' ')}`
            : `Imported “${repaired.plan.name}”.`,
          repaired.warnings.length > 0 ? 'neutral' : 'success',
        );
      } catch {
        notify(error instanceof Error ? error.message : 'Could not import that file.', 'danger');
      }
    }
  };

  const handleSelect = useCallback(
    (id: string | null, additive: boolean) => {
      if (!id) {
        if (!additive) dispatch({ type: 'select', ids: [], mode: 'replace' });
        return;
      }
      dispatch({ type: 'select', ids: [id], mode: additive ? 'toggle' : 'replace' });
      if (isMobile) setMobilePanel((current) => current ?? 'inspector');
    },
    [dispatch, isMobile],
  );

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLElement &&
        (Boolean(target.closest('input, textarea, select')) || target.isContentEditable);

      if (event.key === 'Escape') {
        if (walkMode) { setWalkMode(false); return; }
        if (libraryOpen) {
          setLibraryOpen(false);
        } else if (mobilePanel) {
          setMobilePanel(null);
        } else if (state.selection.length > 0) {
          dispatch({ type: 'select', ids: [], mode: 'replace' });
        }
        return;
      }

      if (isTyping || libraryOpen) return;

      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (walkMode && !modifier) return;

      if (modifier && key === 's') {
        event.preventDefault();
        void saveNow();
        return;
      }
      if (modifier && key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (modifier && key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (modifier && key === 'g') {
        event.preventDefault();
        if (event.shiftKey) {
          const groupId = [...state.selection]
            .reverse()
            .find((id) => state.plan.groups.some((group) => group.id === id));
          if (groupId) dispatch({ type: 'ungroup', id: groupId });
        } else {
          dispatch({ type: 'groupSelection' });
        }
        return;
      }
      if (modifier && key === 'd') {
        event.preventDefault();
        dispatch({ type: 'duplicateSelection' });
        return;
      }
      if (modifier && key === 'a') {
        event.preventDefault();
        const ids = [...state.plan.groups, ...state.plan.objects].map((node) => node.id);
        dispatch({ type: 'select', ids, mode: 'replace' });
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection.length > 0) {
        event.preventDefault();
        dispatch({ type: 'deleteSelection' });
        return;
      }

      if (!modifier) {
        if (key === 'g') {
          setTool('translate');
          return;
        }
        if (key === 'r') {
          setTool('rotate');
          return;
        }
        if (key === 's') {
          setTool('scale');
          return;
        }
        if (key === 'f') {
          window.dispatchEvent(new Event('worldbuilder:focus'));
          return;
        }
        if (key === 'x' || key === 'y' || key === 'z') {
          setAxes((previous) => {
            const next = { ...previous, [key]: !previous[key as keyof AxisFilter] };
            // Always keep at least one axis editable.
            if (!next.x && !next.y && !next.z) return ALL_AXES;
            return next;
          });
          return;
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [
    dispatch,
    libraryOpen,
    walkMode,
    mobilePanel,
    saveNow,
    state.plan.groups,
    state.plan.objects,
    state.selection,
  ]);

  const renderPanel = (panel: DesktopTab | 'inspector') => {
    switch (panel) {
      case 'world':
        return <WorldPanel onOpenLibrary={openLibrary} storageKind={storageKind} />;
      case 'scene':
        return <HierarchyPanel onShowAssets={() => setActiveTab('assets')} />;
      case 'assets':
        return (
          <AssetsPanel
            notify={notify}
            onAdded={() => {
              if (isMobile) setMobilePanel(null);
            }}
          />
        );
      case 'ai':
        return <AiPanel notify={notify} mapTrainer={mapTrainer} />;
      case 'inspector':
        return (
          <InspectorPanel
            notify={notify}
            onDeleted={() => {
              if (isMobile) setMobilePanel(null);
            }}
          />
        );
    }
  };

  const toggleMobilePanel = (panel: MobilePanel) => {
    setMobilePanel((current) => (current === panel ? null : panel));
  };

  return (
    <div className="app-shell">
      <TopBar
        plan={state.plan}
        saveState={state.saveState}
        saveError={state.saveError}
        storageKind={storageKind}
        canUndo={state.past.length > 0}
        canRedo={state.future.length > 0}
        onRename={(name) => dispatch({ type: 'renameWorld', name })}
        onUndo={() => dispatch({ type: 'undo' })}
        onRedo={() => dispatch({ type: 'redo' })}
        onSaveNow={() => void saveNow()}
        onOpenLibrary={openLibrary}
        onNewWorld={startNewWorld}
        onImport={triggerImport}
        notify={notify}
      />

      <nav className="forge-navigation" aria-label="WorldForge navigation">
        <button type="button" className={view === 'forge' ? 'is-active' : ''} onClick={() => setView('forge')} aria-current={view === 'forge' ? 'page' : undefined}><Icon name="sparkles" size={16} /><span>إنشاء</span></button>
        <button type="button" onClick={openLibrary}><Icon name="folder" size={16} /><span>المكتبة</span></button>
        <button type="button" className={view === 'studio' ? 'is-active' : ''} onClick={() => setView('studio')} aria-current={view === 'studio' ? 'page' : undefined}><Icon name="cube" size={16} /><span>المحرر</span></button>
        {view === 'studio' && <button type="button" className="mobile-undo" disabled={!state.past.length} onClick={() => dispatch({type:'undo'})}><Icon name="undo" size={16} /><span>تراجع</span></button>}
      </nav>

      <KeepAlive active={view === 'forge'}><ForgeHome active={view === 'forge'} worlds={worlds} mapTrainer={mapTrainer} storageKind={storageKind} notify={notify} onOpenStudio={() => { setView('studio'); setMobilePanel(null); }} onOpenLibrary={openLibrary} onOpenWorld={(id) => void openWorld(id)} /></KeepAlive>
      <main hidden={view !== 'studio'} className={`workspace ${isMobile && mobilePanel ? 'has-sheet' : ''}`}>
        <aside className="sidebar desktop-only" aria-label="Editor panels">
          <nav className="panel-tabs" role="tablist">
            {DESKTOP_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`panel-tab ${activeTab === tab.id ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon name={tab.icon} size={16} />
                <span>{tab.label}</span>
              </button>
            ))}
          </nav>
          <div className="panel-content">
            {!isMobile && <KeepAlive active={view === 'studio' && activeTab === 'ai'}><AiPanel notify={notify} mapTrainer={mapTrainer} /></KeepAlive>}
            {activeTab !== 'ai' && renderPanel(activeTab)}
          </div>
        </aside>

        <section className="viewport-wrap" aria-label="3D viewport">
          {view === 'studio' && <Viewport
            plan={state.plan}
            constructionPreview={constructionPreview}
            selection={state.selection}
            tool={tool}
            space={space}
            snap={snap}
            showGrid={showGrid}
            walkMode={walkMode}
            onWalkModeChange={(enabled) => { setWalkMode(enabled); if (enabled) setMobilePanel(null); }}
            axes={axes}
            onSelect={handleSelect}
            onTransformCommit={(id, transform) =>
              dispatch({ type: 'setTransform', id, transform })
            }
          />}
          {!walkMode && <ViewportToolbar
            tool={tool}
            space={space}
            snap={snap}
            showGrid={showGrid}
            axes={axes}
            selectionCount={state.selection.length}
            onToolChange={setTool}
            onSpaceChange={setSpace}
            onSnapChange={setSnap}
            onGridChange={setShowGrid}
            onAxesChange={setAxes}
          />}
        </section>

        <aside className="inspector-panel desktop-only" aria-label="Inspector">
          <InspectorPanel notify={notify} />
        </aside>
      </main>

      {isMobile && (
        <div className="mobile-sheet" role="dialog" hidden={!mobilePanel || view !== 'studio'} aria-label={mobilePanel ? PANEL_TITLES[mobilePanel] : 'Editor panel'}>
          <div className="sheet-head">
            <span className="sheet-handle" />
            <h2>{mobilePanel ? PANEL_TITLES[mobilePanel] : ''}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMobilePanel(null)}
              aria-label="Close panel"
            >
              <Icon name="close" size={17} />
            </button>
          </div>
          <div className="sheet-body"><KeepAlive active={view === 'studio' && mobilePanel === 'ai'}><AiPanel notify={notify} mapTrainer={mapTrainer} onOpenStudio={() => setMobilePanel(null)} /></KeepAlive>{mobilePanel && mobilePanel !== 'ai' && renderPanel(mobilePanel)}</div>
        </div>
      )}

      {isMobile && (
        <nav className="mobile-dock" hidden={view !== 'studio'} aria-label="Editor panels">
          {MOBILE_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`dock-item ${mobilePanel === tab.id ? 'is-active' : ''}`}
              onClick={() => toggleMobilePanel(tab.id)}
              aria-pressed={mobilePanel === tab.id}
            >
              <Icon name={tab.icon} size={19} />
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      )}


      <WorldLibraryDialog
        open={libraryOpen}
        worlds={worlds}
        currentId={state.plan.id}
        storageKind={storageKind}
        loading={libraryLoading}
        onClose={() => setLibraryOpen(false)}
        onOpenWorld={(id) => void openWorld(id)}
        onDuplicateWorld={(id) => void duplicateWorld(id)}
        onDeleteWorld={(id) => void deleteWorld(id)}
        onNewWorld={startNewWorld}
        onImport={triggerImport}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="visually-hidden"
        onChange={(event) => void handleFile(event)}
        tabIndex={-1}
      />

      {toast && (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          <Icon
            name={toast.tone === 'danger' ? 'alert' : toast.tone === 'success' ? 'check' : 'info'}
            size={16}
          />
          <span>{toast.message}</span>
        </div>
      )}

      {!ready && (
        <div className="boot-screen">
          <span className="brand-mark large">
            <Icon name="cube" size={26} />
          </span>
          <span className="spinner" />
          <p>Opening your local worlds…</p>
        </div>
      )}
    </div>
  );
}
