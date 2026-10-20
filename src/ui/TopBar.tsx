import { useEffect, useRef, useState } from 'react';
import type { WorldPlan } from '../core/world-plan/schema';
import type { SaveState } from '../modules/editor/store';
import { Icon } from './Icon';
import { IconButton } from './controls';
import { ExportMenu } from './ExportMenu';

interface TopBarProps {
  plan: WorldPlan;
  saveState: SaveState;
  saveError: string | null;
  storageKind: 'indexeddb' | 'memory';
  canUndo: boolean;
  canRedo: boolean;
  onRename: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenLibrary: () => void;
  onNewWorld: () => void;
  onImport: () => void;
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

const SAVE_LABELS: Record<SaveState, string> = {
  idle: 'Local project',
  pending: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Saved locally',
  error: 'Save failed',
};

function WorldName({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState(name);

  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name);
  };

  return (
    <input
      className="world-name-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(name);
          event.currentTarget.blur();
        }
      }}
      maxLength={80}
      aria-label="World name"
      spellCheck={false}
    />
  );
}

export function TopBar({
  plan,
  saveState,
  saveError,
  storageKind,
  canUndo,
  canRedo,
  onRename,
  onUndo,
  onRedo,
  onOpenLibrary,
  onNewWorld,
  onImport,
  notify,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const saveTitle =
    saveState === 'error'
      ? saveError ?? 'The project could not be saved to this browser.'
      : saveState === 'saved'
        ? 'Autosaved to this browser (IndexedDB)'
        : SAVE_LABELS[saveState];

  return (
    <header className="topbar">
      <div className="brand" title="AI World Builder">
        <span className="brand-mark">
          <Icon name="cube" size={18} />
        </span>
        <span className="brand-text">
          World<span>Builder</span>
        </span>
      </div>

      <div className="topbar-main">
        <WorldName name={plan.name} onRename={onRename} />
        <span
          className={`save-status save-${saveState}`}
          title={saveTitle}
          aria-live="polite"
        >
          <span className={`save-dot ${saveState}`} />
          <span className="save-label">{SAVE_LABELS[saveState]}</span>
        </span>
      </div>

      <div className="topbar-actions">
        <div className="btn-group hide-mobile">
          <IconButton icon="undo" label="Undo (Ctrl/Cmd+Z)" onClick={onUndo} disabled={!canUndo} />
          <IconButton
            icon="redo"
            label="Redo (Ctrl/Cmd+Shift+Z)"
            onClick={onRedo}
            disabled={!canRedo}
          />
        </div>

        <ExportMenu plan={plan} notify={notify} />

        <div className="menu-anchor" ref={menuRef}>
          <IconButton
            icon="menu"
            label="Project menu"
            onClick={() => setMenuOpen((value) => !value)}
            active={menuOpen}
          />
          {menuOpen && (
            <div className="popover topbar-popover" role="menu">
              <button
                type="button"
                className="menu-item"
                disabled={!canUndo}
                onClick={() => { onUndo(); setMenuOpen(false); }}
              >
                <Icon name="undo" size={16} /> Undo
                <span className="menu-shortcut">Ctrl Z</span>
              </button>
              <button
                type="button"
                className="menu-item"
                disabled={!canRedo}
                onClick={() => { onRedo(); setMenuOpen(false); }}
              >
                <Icon name="redo" size={16} /> Redo
                <span className="menu-shortcut">⇧ Ctrl Z</span>
              </button>
              <div className="menu-divider" />
              <button type="button" className="menu-item" onClick={() => { onOpenLibrary(); setMenuOpen(false); }}>
                <Icon name="folder" size={16} /> World library
              </button>
              <button type="button" className="menu-item" onClick={() => { onNewWorld(); setMenuOpen(false); }}>
                <Icon name="plus" size={16} /> New world
              </button>
              <button type="button" className="menu-item" onClick={() => { onImport(); setMenuOpen(false); }}>
                <Icon name="upload" size={16} /> Import project…
              </button>
              <div className="menu-divider" />
              <button
                type="button"
                className="menu-item"
                onClick={() => { onOpenLibrary(); setMenuOpen(false); }}
              >
                <Icon name="info" size={16} />
                {storageKind === 'indexeddb' ? 'Stored in this browser' : 'Temporary session only'}
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
