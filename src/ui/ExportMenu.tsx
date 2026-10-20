import { useEffect, useState } from 'react';
import type { WorldPlan } from '../core/world-plan/schema';
import { downloadWorldPlan } from '../core/persistence/projectFile';
import { downloadWorldGlb } from '../core/export/gltf';
import { Icon } from './Icon';

type Notify = (message: string, tone?: 'neutral' | 'success' | 'danger') => void;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ExportMenu({ plan, notify }: { plan: WorldPlan; notify: Notify }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'glb' | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const exportProject = () => {
    try {
      const filename = downloadWorldPlan(plan);
      notify(`Project downloaded: ${filename}`, 'success');
      setOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not download the project.', 'danger');
    }
  };

  const exportGlb = async () => {
    setBusy('glb');
    try {
      const result = await downloadWorldGlb(plan);
      notify(`3D model downloaded: ${result.filename} (${formatBytes(result.bytes)})`, 'success');
      setOpen(false);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not build the 3D model.', 'danger');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="export-menu">
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="download" size={16} />
        <span className="btn-label">Export</span>
        <Icon name="chevronDown" size={13} />
      </button>

      {open && (
        <>
          <button
            type="button"
            className="popover-backdrop"
            aria-label="Close export menu"
            onClick={() => setOpen(false)}
          />
          <div className="popover export-popover" role="menu">
            <div className="popover-heading">Export</div>

            <button type="button" className="export-item" role="menuitem" onClick={exportProject}>
              <span className="export-item-icon">
                <Icon name="layers" size={18} />
              </span>
              <span className="export-item-text">
                <strong>Project file</strong>
                <small>WorldPlan JSON v1 · lossless, re-importable</small>
              </span>
            </button>

            <button
              type="button"
              className="export-item"
              role="menuitem"
              onClick={exportGlb}
              disabled={busy !== null}
            >
              <span className="export-item-icon">
                <Icon name="cube" size={18} />
              </span>
              <span className="export-item-text">
                <strong>{busy === 'glb' ? 'Building .glb…' : '3D model (glTF 2.0)'}</strong>
                <small>For Godot 4 (native) or Unity (glTF importer)</small>
              </span>
              {busy === 'glb' && <span className="spinner small" />}
            </button>

            <p className="popover-note">
              Everything runs locally in your browser. No account or paid service is used.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
