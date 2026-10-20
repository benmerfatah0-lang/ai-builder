import { createTerrainSampler } from '../../../core/generation/terrain';
import { countObjects } from '../../../core/world-plan/factory';
import { useEditor, useSelectedObject, type ObjectPatch } from '../store';
import { Icon } from '../../../ui/Icon';
import {
  Badge,
  ColorField,
  NumberField,
  Section,
  TextField,
  Toggle,
} from '../../../ui/controls';
import { objectIcon } from './ObjectsPanel';

function EmptyInspector() {
  const { state } = useEditor();
  const counts = countObjects(state.plan);
  const created = new Date(state.plan.createdAt);

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>Inspector</h2>
          <p>Select an object to edit its transform and colors.</p>
        </div>
      </div>

      <div className="inspector-empty">
        <span className="empty-icon">
          <Icon name="cube" size={22} />
        </span>
        <strong>Nothing selected</strong>
        <p>Click any prop in the viewport, or pick one from the Objects panel.</p>
      </div>

      <Section title="World overview" icon="mountain" defaultOpen>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-value">{counts.total ?? 0}</span>
            <span className="stat-label">Objects</span>
          </div>
          <div className="stat">
            <span className="stat-value">{counts.trees ?? 0}</span>
            <span className="stat-label">Trees</span>
          </div>
          <div className="stat">
            <span className="stat-value">{counts.rocks ?? 0}</span>
            <span className="stat-label">Rocks</span>
          </div>
          <div className="stat">
            <span className="stat-value">{counts.buildings ?? 0}</span>
            <span className="stat-label">Buildings</span>
          </div>
        </div>
        <dl className="stats-list">
          <div>
            <dt>Landform</dt>
            <dd>{state.plan.terrain.style}</dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="mono">{state.plan.seed}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{Number.isNaN(created.getTime()) ? '—' : created.toLocaleDateString()}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Shortcuts" icon="info" defaultOpen={false}>
        <ul className="shortcut-list">
          <li><kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Z</kbd><span>Undo</span></li>
          <li><kbd>Shift</kbd> + <kbd>Ctrl</kbd> + <kbd>Z</kbd><span>Redo</span></li>
          <li><kbd>Delete</kbd><span>Remove selection</span></li>
          <li><kbd>F</kbd><span>Frame the world</span></li>
          <li><kbd>Esc</kbd><span>Deselect</span></li>
        </ul>
      </Section>
    </div>
  );
}

export function InspectorPanel({ onDeleted }: { onDeleted?: () => void }) {
  const { state, dispatch } = useEditor();
  const object = useSelectedObject();

  if (!object) return <EmptyInspector />;

  const locked = object.locked;
  const update = (patch: ObjectPatch) => {
    dispatch({ type: 'updateObject', id: object.id, patch });
  };

  const updatePosition = (index: 0 | 1 | 2, value: number) => {
    const position = [...object.transform.position] as [number, number, number];
    position[index] = value;
    update({ transform: { position } });
  };

  const updateScale = (index: 0 | 1 | 2, value: number) => {
    const scale = [...object.transform.scale] as [number, number, number];
    scale[index] = value;
    update({ transform: { scale } });
  };

  const snapToGround = () => {
    const sampler = createTerrainSampler(state.plan.terrain, state.plan.seed);
    const [x, , z] = object.transform.position;
    update({ transform: { position: [x, sampler.heightAt(x, z), z] } });
  };

  return (
    <div className="panel-scroll">
      <div className="inspector-head">
        <span className={`object-icon large kind-${object.kind}`}>
          <Icon name={objectIcon(object)} size={20} />
        </span>
        <div>
          <span className="inspector-kind">{object.kind}</span>
          <h2>{object.name}</h2>
        </div>
      </div>

      <div className="badge-row">
        {!object.visible && <Badge tone="neutral">Hidden</Badge>}
        {object.locked && <Badge tone="accent">Locked</Badge>}
        {object.visible && !object.locked && <Badge tone="success">Visible</Badge>}
      </div>

      <div className="split-actions">
        <Toggle
          label="Visible"
          checked={object.visible}
          onChange={(visible) => update({ visible })}
        />
        <Toggle
          label="Locked"
          checked={object.locked}
          onChange={(lockedValue) => update({ locked: lockedValue })}
        />
      </div>

      {locked && (
        <div className="callout callout-info">
          <Icon name="lock" size={16} />
          <span>Unlock this object to edit its name, colors or transform.</span>
        </div>
      )}

      <Section title="Identity" icon="info">
        <TextField
          label="Name"
          value={object.name}
          onCommit={(name) => update({ name })}
          disabled={locked}
        />
        <div className="kv-row">
          <span>Type</span>
          <strong>
            {object.kind}
            {'variant' in object ? ` · ${object.variant}` : ''}
            {'primitive' in object ? ` · ${object.primitive}` : ''}
          </strong>
        </div>
        <div className="kv-row">
          <span>Object ID</span>
          <span className="mono small">{object.id}</span>
        </div>
      </Section>

      {!locked && (
        <Section title="Appearance" icon="sliders">
          <ColorField label="Color" value={object.color} onChange={(color) => update({ color })} />
          {object.kind === 'tree' && (
            <ColorField
              label="Trunk"
              value={object.trunkColor}
              onChange={(trunkColor) => update({ trunkColor })}
            />
          )}
          {object.kind === 'building' && (
            <ColorField
              label="Roof"
              value={object.roofColor}
              onChange={(roofColor) => update({ roofColor })}
            />
          )}
        </Section>
      )}

      <Section title="Transform" icon="frame">
        <span className="field-label">Position</span>
        <div className="vector-grid">
          <NumberField label="X" value={object.transform.position[0]} disabled={locked} step={0.5} onCommit={(value) => updatePosition(0, value)} compact />
          <NumberField label="Y" value={object.transform.position[1]} disabled={locked} step={0.5} onCommit={(value) => updatePosition(1, value)} compact />
          <NumberField label="Z" value={object.transform.position[2]} disabled={locked} step={0.5} onCommit={(value) => updatePosition(2, value)} compact />
        </div>

        <NumberField
          label="Rotation Y"
          suffix="°"
          value={object.transform.rotationY}
          min={-360}
          max={360}
          disabled={locked}
          onCommit={(rotationY) => update({ transform: { rotationY } })}
        />

        <span className="field-label">Scale</span>
        <div className="vector-grid">
          <NumberField label="X" value={object.transform.scale[0]} min={0.05} step={0.1} disabled={locked} onCommit={(value) => updateScale(0, value)} compact />
          <NumberField label="Y" value={object.transform.scale[1]} min={0.05} step={0.1} disabled={locked} onCommit={(value) => updateScale(1, value)} compact />
          <NumberField label="Z" value={object.transform.scale[2]} min={0.05} step={0.1} disabled={locked} onCommit={(value) => updateScale(2, value)} compact />
        </div>

        <button type="button" className="btn btn-small full-width" onClick={snapToGround} disabled={locked}>
          <Icon name="mountain" size={15} /> Snap to ground
        </button>
      </Section>

      <div className="inspector-actions">
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'duplicateObject', id: object.id })}
        >
          <Icon name="copy" size={15} /> Duplicate
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={locked}
          onClick={() => {
            dispatch({ type: 'removeObject', id: object.id });
            onDeleted?.();
          }}
        >
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
    </div>
  );
}
