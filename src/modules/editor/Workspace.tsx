import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import type { WorldPlan } from '../../core/world-plan/schema';
import { readWorldFile } from '../../core/persistence/projectFile';
import {
  createMemoryWorldRepository,
  getWorldRepository,
  setWorldRepository,
  type WorldRepository,
  type WorldSummary,
} from '../../core/persistence/worldRepository';
import { createStarterWorld } from '../../core/generation/starter';
import { useEditor } from './store';
import { useAutosave } from './useAutosave';
import { Viewport } from './Viewport';
import { WorldPanel } from './panels/WorldPanel';
import { ObjectsPanel } from './panels/ObjectsPanel';
import { AssetsPanel } from './panels/AssetsPanel';
import { AiPanel } from './panels/AiPanel';
import { InspectorPanel } from './panels/InspectorPanel';
import { TopBar } from '../../ui/TopBar';
import { WorldLibraryDialog } from '../../ui/WorldLibraryDialog';
import { Icon, type IconName } from '../../ui/Icon';
import { useToast } from '../../ui/useToast';
import { useIsMobile } from '../../ui/useIsMobile';

type DesktopTab = 'world' | 'objects' | 'assets' | 'ai';
type MobilePanel = DesktopTab | 'inspector';

const DESKTOP_TABS: { id: DesktopTab; label: string; icon: IconName }[] = [
  { id: 'world', label: 'World', icon: 'sliders' },
  { id: 'objects', label: 'Objects', icon: 'layers' },
  { id: 'assets', label: 'Assets', icon: 'cube' },
  { id: 'ai', label: 'AI', icon: 'sparkles' },
];

const MOBILE_TABS: { id: MobilePanel; label: string; icon: IconName }[] = [
  ...DESKTOP_TABS,
  { id: 'inspector', label: 'Inspect', icon: 'info' },
];

const PANEL_TITLES: Record<MobilePanel, string> = {
  world: 'World',
  objects: 'Objects',
  assets: 'Assets',
  ai: 'AI world',
  inspector: 'Inspector',
};

export function Workspace() {
  const { state, dispatch } = useEditor();
  const [repository, setRepository] = useState<WorldRepository>(() => getWorldRepository());
  const [storageKind, setStorageKind] = useState<'indexeddb' | 'memory'>(
    () => getWorldRepository().kind,
  );
  const [ready, setReady] = useState(false);
  const [worlds, setWorlds] = useState<WorldSummary[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<DesktopTab>('world');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null);
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

  const startNewWorld = useCallback(() => {
    const plan = createEmptyWorldPlan({ name: 'Untitled World' });
    dispatch({ type: 'replacePlan', plan });
    setLibraryOpen(false);
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
      setMobilePanel(null);
      notify(`Opened “${plan.name}”.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open that world.', 'danger');
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
      setMobilePanel(null);
      notify(`Imported “${plan.name}”.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not import that file.', 'danger');
    }
  };

  const handleSelect = (id: string | null) => {
    dispatch({ type: 'select', id });
    if (id && isMobile) setMobilePanel('inspector');
  };

  const handleGenerated = () => {
    if (isMobile) setMobilePanel(null);
  };

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLElement &&
        (Boolean(target.closest('input, textarea, select')) || target.isContentEditable);

      if (event.key === 'Escape') {
        if (libraryOpen) {
          setLibraryOpen(false);
        } else if (mobilePanel) {
          setMobilePanel(null);
        } else if (state.selectedId) {
          dispatch({ type: 'select', id: null });
        }
        return;
      }

      if (isTyping || libraryOpen) return;

      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedId) {
        const selected = state.plan.objects.find((object) => object.id === state.selectedId);
        if (selected?.locked) {
          notify('This object is locked. Unlock it before deleting.', 'danger');
          return;
        }
        event.preventDefault();
        dispatch({ type: 'removeObject', id: state.selectedId });
        return;
      }
      if (!modifier && event.key.toLowerCase() === 'f') {
        window.dispatchEvent(new Event('worldbuilder:frame'));
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dispatch, libraryOpen, mobilePanel, notify, state.plan.objects, state.selectedId]);

  const renderPanel = (panel: DesktopTab | 'inspector') => {
    switch (panel) {
      case 'world':
        return <WorldPanel onOpenLibrary={openLibrary} storageKind={storageKind} />;
      case 'objects':
        return <ObjectsPanel onShowAssets={() => setActiveTab('assets')} />;
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
        return <AiPanel notify={notify} onGenerated={handleGenerated} />;
      case 'inspector':
        return (
          <InspectorPanel
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
        onOpenLibrary={openLibrary}
        onNewWorld={startNewWorld}
        onImport={triggerImport}
        notify={notify}
      />

      <main className="workspace">
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
          <div className="panel-content">{renderPanel(activeTab)}</div>
        </aside>

        <section className="viewport-wrap" aria-label="3D viewport">
          <Viewport plan={state.plan} selectedId={state.selectedId} onSelect={handleSelect} />
        </section>

        <aside className="inspector-panel desktop-only" aria-label="Inspector">
          <InspectorPanel />
        </aside>
      </main>

      {isMobile && mobilePanel && (
        <div className="mobile-sheet" role="dialog" aria-label={PANEL_TITLES[mobilePanel]}>
          <div className="sheet-head">
            <span className="sheet-handle" />
            <h2>{PANEL_TITLES[mobilePanel]}</h2>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMobilePanel(null)}
              aria-label="Close panel"
            >
              <Icon name="close" size={17} />
            </button>
          </div>
          <div className="sheet-body">{renderPanel(mobilePanel)}</div>
        </div>
      )}

      {isMobile && (
        <nav className="mobile-dock" aria-label="Editor panels">
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
