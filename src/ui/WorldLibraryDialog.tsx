import { useEffect, useState } from 'react';
import type { WorldSummary } from '../core/persistence/worldRepository';
import { Icon } from './Icon';

interface WorldLibraryDialogProps {
  open: boolean;
  worlds: WorldSummary[];
  currentId: string | null;
  storageKind: 'indexeddb' | 'memory';
  loading: boolean;
  onClose: () => void;
  onOpenWorld: (id: string) => void;
  onDuplicateWorld: (id: string) => void;
  onDeleteWorld: (id: string) => void;
  onNewWorld: () => void;
  onImport: () => void;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WorldLibraryDialog({
  open,
  worlds,
  currentId,
  storageKind,
  loading,
  onClose,
  onOpenWorld,
  onDuplicateWorld,
  onDeleteWorld,
  onNewWorld,
  onImport,
}: WorldLibraryDialogProps) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setPendingDelete(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal library-modal" role="dialog" aria-modal="true" aria-label="World library">
        <div className="modal-head">
          <div>
            <h2>World library</h2>
            <p className="modal-sub">
              Saved in this browser with IndexedDB. No account, no cloud.
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close library">
            <Icon name="close" size={18} />
          </button>
        </div>

        {storageKind === 'memory' && (
          <div className="callout callout-warning">
            <Icon name="alert" size={16} />
            <span>
              This browser blocked IndexedDB, so worlds only exist for this tab. Export a project
              file to keep your work.
            </span>
          </div>
        )}

        <div className="library-actions">
          <button type="button" className="btn" onClick={onNewWorld}>
            <Icon name="plus" size={16} /> New blank world
          </button>
          <button type="button" className="btn" onClick={onImport}>
            <Icon name="upload" size={16} /> Import .world.json
          </button>
        </div>

        <div className="library-list" aria-busy={loading}>
          {loading && <div className="library-empty"><span className="spinner" /> Loading worlds…</div>}
          {!loading && worlds.length === 0 && (
            <div className="library-empty">
              <Icon name="folder" size={22} />
              <p>No saved worlds yet. Start from a blank world or generate one with the AI panel.</p>
            </div>
          )}
          {!loading &&
            worlds.map((world) => {
              const isCurrent = world.id === currentId;
              return (
                <div className={`library-row ${isCurrent ? 'is-current' : ''}`} key={world.id}>
                  <button
                    type="button"
                    className="library-row-main"
                    aria-label={`Open ${world.name}`}
                    onClick={() => onOpenWorld(world.id)}
                  >
                    <span className="library-thumb">
                      <Icon name="mountain" size={18} />
                    </span>
                    <span className="library-row-text">
                      <strong>
                        {world.name}
                        {isCurrent && <span className="current-tag">open</span>}
                      </strong>
                      <small>
                        {world.objectCount} objects · updated {formatDate(world.updatedAt)}
                      </small>
                    </span>
                  </button>

                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onDuplicateWorld(world.id)}
                    aria-label={`Duplicate ${world.name}`}
                    title="Duplicate world"
                  >
                    <Icon name="copy" size={16} />
                  </button>

                  {pendingDelete === world.id ? (
                    <span className="delete-confirm">
                      <button
                        type="button"
                        className="btn btn-danger btn-small"
                        onClick={() => {
                          onDeleteWorld(world.id);
                          setPendingDelete(null);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-small"
                        onClick={() => setPendingDelete(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setPendingDelete(world.id)}
                      aria-label={`Delete ${world.name}`}
                      title="Delete world"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                </div>
              );
            })}
        </div>

        <div className="modal-foot">
          <span className="modal-foot-note">
            Tip: export a project file to back up worlds or move them to another device.
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
