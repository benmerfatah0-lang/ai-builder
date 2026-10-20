import { createTerrainSampler } from '../../../core/generation/terrain';
import { countObjects } from '../../../core/world-plan/factory';
import {
  getAncestors,
  getNode,
  isEffectivelyLocked,
  worldTransformOf,
} from '../../../core/world-plan/hierarchy';
import { isGroup, type Transform } from '../../../core/world-plan/schema';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import {
  Badge,
  ColorField,
  NumberField,
  Section,
  SelectField,
  SliderField,
  TextField,
  Toggle,
} from '../../../ui/controls';
import { nodeIcon, nodeTypeLabel, nodeSubtitle } from './nodeMeta';

const formatVector = (value: readonly number[]) =>
  value.map((entry) => Math.round(entry * 100) / 100).join(', ');

function EmptyInspector() {
  const { state } = useEditor();
  const counts = countObjects(state.plan);
  const created = new Date(state.plan.createdAt);

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>Inspector</h2>
          <p>Select an object to edit its transform, material and hierarchy.</p>
        </div>
      </div>

      <div className="inspector-empty">
        <span className="empty-icon">
          <Icon name="cube" size={22} />
        </span>
        <strong>Nothing selected</strong>
        <p>Click any prop in the viewport, or pick one from the scene tree.</p>
      </div>

      <Section title="World overview" icon="mountain" defaultOpen>
        <div className="stat-grid">
          <div className="stat">
            <span className="stat-value">{counts.total ?? 0}</span>
            <span className="stat-label">Objects</span>
          </div>
          <div className="stat">
            <span className="stat-value">{state.plan.groups.length}</span>
            <span className="stat-label">Groups</span>
          </div>
          <div className="stat">
            <span className="stat-value">{counts.trees ?? 0}</span>
            <span className="stat-label">Trees</span>
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
          <li><kbd>G</kbd> / <kbd>R</kbd> / <kbd>S</kbd><span>Move / rotate / scale</span></li>
          <li><kbd>Ctrl</kbd> + <kbd>G</kbd><span>Group selection</span></li>
          <li><kbd>Ctrl</kbd> + <kbd>D</kbd><span>Duplicate selection</span></li>
          <li><kbd>Delete</kbd><span>Remove selection</span></li>
          <li><kbd>F</kbd><span>Frame selection or world</span></li>
          <li><kbd>Esc</kbd><span>Deselect</span></li>
        </ul>
      </Section>
    </div>
  );
}

function MultiInspector() {
  const { state, dispatch } = useEditor();
  const nodes = state.selection
    .map((id) => getNode(state.plan, id))
    .filter((node): node is NonNullable<typeof node> => node !== null);
  const hasGroup = nodes.some((node) => isGroup(node));

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>{nodes.length} selected</h2>
          <p>Group them to move them together, or edit them one at a time.</p>
        </div>
      </div>

      <ul className="selection-list">
        {nodes.map((node) => (
          <li key={node.id}>
            <button
              type="button"
              className="selection-row"
              onClick={() => dispatch({ type: 'select', ids: [node.id], mode: 'replace' })}
            >
              <span className={`tree-icon ${isGroup(node) ? 'is-group' : `kind-${node.kind}`}`}>
                <Icon name={nodeIcon(node)} size={13} />
              </span>
              <span>{node.name}</span>
              <small>{nodeTypeLabel(node)}</small>
            </button>
          </li>
        ))}
      </ul>

      <div className="inspector-actions">
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'groupSelection' })}
        >
          <Icon name="folder" size={15} /> Group
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => dispatch({ type: 'duplicateSelection' })}
        >
          <Icon name="copy" size={15} /> Duplicate
        </button>
        <button
          type="button"
          className="btn"
          disabled={!hasGroup}
          onClick={() => {
            const group = nodes.find((node) => isGroup(node));
            if (group) dispatch({ type: 'ungroup', id: group.id });
          }}
        >
          <Icon name="layers" size={15} /> Ungroup
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => dispatch({ type: 'deleteSelection' })}
        >
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
    </div>
  );
}

function ParentSelect({ id }: { id: string }) {
  const { state, dispatch } = useEditor();
  const { plan } = state;
  const ancestors = getAncestors(plan, id).map((node) => node.id);
  const options = [
    { value: '__root__', label: 'World root' },
    ...plan.groups
      .filter((group) => group.id !== id && !ancestors.includes(group.id))
      .map((group) => ({ value: group.id, label: group.name })),
  ];
  const node = getNode(plan, id);
  const current = node?.parentId ?? '__root__';

  return (
    <SelectField
      label="Parent"
      value={current}
      options={options}
      onChange={(value) =>
        dispatch({ type: 'reparent', id, parentId: value === '__root__' ? null : value })
      }
    />
  );
}

function TransformSection({ id, transform, disabled }: { id: string; transform: Transform; disabled: boolean }) {
  const { state, dispatch } = useEditor();

  const commit = (next: Transform) => dispatch({ type: 'setTransform', id, transform: next });

  const setPosition = (index: 0 | 1 | 2, value: number) => {
    const position = [...transform.position] as [number, number, number];
    position[index] = value;
    commit({ ...transform, position });
  };

  const setRotation = (index: 0 | 1 | 2, value: number) => {
    const rotation = [...transform.rotation] as [number, number, number];
    rotation[index] = value;
    commit({ ...transform, rotation });
  };

  const setScale = (index: 0 | 1 | 2, value: number) => {
    const scale = [...transform.scale] as [number, number, number];
    scale[index] = value;
    commit({ ...transform, scale });
  };

  const snapToGround = () => {
    const world = worldTransformOf(state.plan, id);
    if (!world) return;
    const sampler = createTerrainSampler(state.plan.terrain, state.plan.seed);
    const groundY = sampler.heightAt(world.position[0], world.position[2]);
    // Work in world space so rotating or scaling a parent group cannot skew the snap.
    dispatch({
      type: 'setWorldTransform',
      id,
      transform: {
        ...world,
        position: [world.position[0], groundY, world.position[2]],
      },
    });
  };

  const reset = () => {
    commit({
      position: transform.position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  };

  return (
    <Section title="Transform" icon="frame">
      <span className="field-label">Position (local)</span>
      <div className="vector-grid">
        <NumberField label="X" ariaLabel="Position X" value={transform.position[0]} step={0.5} disabled={disabled} onCommit={(value) => setPosition(0, value)} compact />
        <NumberField label="Y" ariaLabel="Position Y" value={transform.position[1]} step={0.5} disabled={disabled} onCommit={(value) => setPosition(1, value)} compact />
        <NumberField label="Z" ariaLabel="Position Z" value={transform.position[2]} step={0.5} disabled={disabled} onCommit={(value) => setPosition(2, value)} compact />
      </div>

      <span className="field-label">Rotation (degrees)</span>
      <div className="vector-grid">
        <NumberField label="X" ariaLabel="Rotation X" value={transform.rotation[0]} step={5} min={-3600} max={3600} disabled={disabled} onCommit={(value) => setRotation(0, value)} compact />
        <NumberField label="Y" ariaLabel="Rotation Y" value={transform.rotation[1]} step={5} min={-3600} max={3600} disabled={disabled} onCommit={(value) => setRotation(1, value)} compact />
        <NumberField label="Z" ariaLabel="Rotation Z" value={transform.rotation[2]} step={5} min={-3600} max={3600} disabled={disabled} onCommit={(value) => setRotation(2, value)} compact />
      </div>

      <span className="field-label">Scale</span>
      <div className="vector-grid">
        <NumberField label="X" ariaLabel="Scale X" value={transform.scale[0]} min={0.05} step={0.1} disabled={disabled} onCommit={(value) => setScale(0, value)} compact />
        <NumberField label="Y" ariaLabel="Scale Y" value={transform.scale[1]} min={0.05} step={0.1} disabled={disabled} onCommit={(value) => setScale(1, value)} compact />
        <NumberField label="Z" ariaLabel="Scale Z" value={transform.scale[2]} min={0.05} step={0.1} disabled={disabled} onCommit={(value) => setScale(2, value)} compact />
      </div>

      <div className="inspector-button-row">
        <button type="button" className="btn btn-small" onClick={snapToGround} disabled={disabled}>
          <Icon name="mountain" size={15} /> Snap to ground
        </button>
        <button type="button" className="btn btn-small" onClick={reset} disabled={disabled}>
          <Icon name="undo" size={15} /> Reset rotate/scale
        </button>
      </div>
    </Section>
  );
}

export function InspectorPanel({ onDeleted }: { onDeleted?: () => void }) {
  const { state, dispatch } = useEditor();
  const { plan, selection } = state;

  if (selection.length > 1) return <MultiInspector />;

  const id = selection[0];
  const node = id ? getNode(plan, id) : null;
  if (!id || !node) return <EmptyInspector />;

  const groupNode = isGroup(node);
  const locked = isEffectivelyLocked(plan, id);
  const worldTransform = worldTransformOf(plan, id);
  const parents = getAncestors(plan, id);
  const children = [...plan.groups, ...plan.objects].filter((entry) => entry.parentId === id);

  return (
    <div className="panel-scroll">
      <div className="inspector-head">
        <span className={`object-icon large ${groupNode ? 'is-group' : `kind-${node.kind}`}`}>
          <Icon name={nodeIcon(node)} size={20} />
        </span>
        <div>
          <span className="inspector-kind">
            {nodeTypeLabel(node)}
            {!groupNode ? ` · ${nodeSubtitle(node)}` : ''}
          </span>
          <h2>{node.name}</h2>
        </div>
      </div>

      <div className="badge-row">
        {!node.visible && <Badge tone="neutral">Hidden</Badge>}
        {node.locked && <Badge tone="accent">Locked</Badge>}
        {node.visible && !node.locked && <Badge tone="success">Visible</Badge>}
        {groupNode && <Badge tone="neutral">{children.length} children</Badge>}
      </div>

      {parents.length > 0 && (
        <p className="parent-trail">
          {parents
            .slice()
            .reverse()
            .map((parent) => parent.name)
            .join(' / ')}
        </p>
      )}

      <div className="split-actions">
        <Toggle
          label="Visible"
          checked={node.visible}
          onChange={(visible) => dispatch({ type: 'setVisible', id, visible })}
        />
        <Toggle
          label="Locked"
          checked={node.locked}
          onChange={(lockedValue) => dispatch({ type: 'setLocked', id, locked: lockedValue })}
        />
      </div>

      {locked && (
        <div className="callout callout-info">
          <Icon name="lock" size={16} />
          <span>
            This {groupNode ? 'group' : 'object'} is locked. Unlock it (or an ancestor) to change its
            transform.
          </span>
        </div>
      )}

      <Section title="Identity" icon="info">
        <TextField
          label="Name"
          value={node.name}
          onCommit={(name) => dispatch({ type: 'renameNode', id, name })}
        />
        <div className="kv-row">
          <span>Type</span>
          <strong>{nodeTypeLabel(node)}</strong>
        </div>
        <ParentSelect id={id} />
        <div className="kv-row">
          <span>Object ID</span>
          <span className="mono small">{node.id}</span>
        </div>
      </Section>

      {!groupNode && (
        <Section title="Material" icon="sliders">
          <ColorField
            label="Base color"
            value={node.color}
            onChange={(color) => dispatch({ type: 'updateObject', id, patch: { color } })}
          />
          {node.kind === 'tree' && (
            <ColorField
              label="Trunk"
              value={node.trunkColor}
              onChange={(trunkColor) =>
                dispatch({ type: 'updateObject', id, patch: { trunkColor } })
              }
            />
          )}
          {node.kind === 'building' && (
            <ColorField
              label="Roof"
              value={node.roofColor}
              onChange={(roofColor) =>
                dispatch({ type: 'updateObject', id, patch: { roofColor } })
              }
            />
          )}
          <SliderField
            label="Roughness"
            value={node.material?.roughness ?? 0.86}
            min={0}
            max={1}
            step={0.02}
            onChange={(roughness) =>
              dispatch({ type: 'updateObject', id, patch: { material: { roughness } } })
            }
          />
          <SliderField
            label="Metalness"
            value={node.material?.metalness ?? 0}
            min={0}
            max={1}
            step={0.02}
            onChange={(metalness) =>
              dispatch({ type: 'updateObject', id, patch: { material: { metalness } } })
            }
          />
          {(node.kind === 'lantern' || node.material?.emissiveIntensity !== undefined) && (
            <SliderField
              label="Emission"
              value={node.material?.emissiveIntensity ?? 1}
              min={0}
              max={5}
              step={0.1}
              onChange={(emissiveIntensity) =>
                dispatch({ type: 'updateObject', id, patch: { material: { emissiveIntensity } } })
              }
            />
          )}
        </Section>
      )}

      <TransformSection id={id} transform={node.transform} disabled={locked} />

      {worldTransform && (
        <Section title="World space" icon="layers" defaultOpen={false}>
          <div className="kv-row">
            <span>Position</span>
            <span className="mono small">{formatVector(worldTransform.position)}</span>
          </div>
          <div className="kv-row">
            <span>Rotation</span>
            <span className="mono small">{formatVector(worldTransform.rotation)}</span>
          </div>
          <div className="kv-row">
            <span>Scale</span>
            <span className="mono small">{formatVector(worldTransform.scale)}</span>
          </div>
          <p className="hint-text">
            World values are computed from this node and {parents.length} parent
            {parents.length === 1 ? '' : 's'}. Edit the local transform above.
          </p>
        </Section>
      )}

      {groupNode && (
        <Section title="Contents" icon="folder" defaultOpen={false}>
          <p className="hint-text">
            {children.length === 0
              ? 'Deleting this group removes only the group itself.'
              : `Deleting this group also deletes its ${children.length} direct child${
                  children.length === 1 ? '' : 'ren'
                } and their descendants. Use Ungroup to keep them.`}
          </p>
          {children.length === 0 ? (
            <p className="hint-text">This group is empty. Drag objects in with the Parent menu.</p>
          ) : (
            <ul className="selection-list">
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    className="selection-row"
                    onClick={() => dispatch({ type: 'select', ids: [child.id], mode: 'replace' })}
                  >
                    <span className={`tree-icon ${isGroup(child) ? 'is-group' : `kind-${child.kind}`}`}>
                      <Icon name={nodeIcon(child)} size={13} />
                    </span>
                    <span>{child.name}</span>
                    <small>{nodeTypeLabel(child)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="inspector-actions">
        {groupNode ? (
          <button
            type="button"
            className="btn"
            disabled={locked}
            onClick={() => dispatch({ type: 'ungroup', id })}
          >
            <Icon name="layers" size={15} /> Ungroup
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => dispatch({ type: 'duplicateSelection' })}
          >
            <Icon name="copy" size={15} /> Duplicate
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          disabled={locked}
          onClick={() => {
            dispatch({ type: 'deleteNode', id });
            onDeleted?.();
          }}
        >
          <Icon name="trash" size={15} /> Delete
        </button>
      </div>
    </div>
  );
}
