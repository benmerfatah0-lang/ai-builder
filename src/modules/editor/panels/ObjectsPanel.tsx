import { useMemo, useState } from 'react';
import { useEditor } from '../store';
import type { WorldObject } from '../../../core/world-plan/schema';
import { Icon, type IconName } from '../../../ui/Icon';
import { EmptyState, IconButton } from '../../../ui/controls';

const KIND_ICONS: Record<WorldObject['kind'], IconName> = {
  primitive: 'cube',
  tree: 'tree',
  rock: 'mountain',
  building: 'layers',
  lantern: 'sun',
};

const KIND_LABELS: Record<WorldObject['kind'], string> = {
  primitive: 'Primitive',
  tree: 'Tree',
  rock: 'Rock',
  building: 'Building',
  lantern: 'Lantern',
};

export function objectSubtitle(object: WorldObject): string {
  switch (object.kind) {
    case 'primitive':
      return object.primitive;
    case 'tree':
    case 'rock':
    case 'building':
      return object.variant;
    case 'lantern':
      return 'light';
  }
}

export function objectIcon(object: WorldObject): IconName {
  return KIND_ICONS[object.kind];
}

export function ObjectsPanel({ onShowAssets }: { onShowAssets: () => void }) {
  const { state, dispatch } = useEditor();
  const [query, setQuery] = useState('');
  const { objects } = state.plan;

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const list = normalized
      ? objects.filter(
          (object) =>
            object.name.toLowerCase().includes(normalized) ||
            object.kind.includes(normalized),
        )
      : objects;
    return [...list].reverse();
  }, [objects, query]);

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>Objects</h2>
          <p>
            {objects.length} {objects.length === 1 ? 'object' : 'objects'} in this world
          </p>
        </div>
        <button type="button" className="btn btn-small" onClick={onShowAssets}>
          <Icon name="plus" size={15} /> Add
        </button>
      </div>

      <div className="search-field">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter by name or type"
          aria-label="Filter objects"
        />
        {query && (
          <button type="button" className="clear-search" onClick={() => setQuery('')} aria-label="Clear filter">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      {objects.length === 0 ? (
        <EmptyState icon="layers" title="This world is empty">
          Generate a world with the AI panel or add individual assets from the Assets tab.
        </EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState icon="search" title="No matches">
          Try a different name or object type.
        </EmptyState>
      ) : (
        <ul className="object-list">
          {filtered.map((object) => {
            const selected = object.id === state.selectedId;
            return (
              <li key={object.id}>
                <div className={`object-row ${selected ? 'is-selected' : ''} ${object.visible ? '' : 'is-hidden'}`}>
                  <button
                    type="button"
                    className="object-row-main"
                    onClick={() => dispatch({ type: 'select', id: object.id })}
                  >
                    <span className={`object-icon kind-${object.kind}`}>
                      <Icon name={KIND_ICONS[object.kind]} size={15} />
                    </span>
                    <span className="object-text">
                      <span className="object-name">{object.name}</span>
                      <span className="object-meta">
                        {KIND_LABELS[object.kind]} · {objectSubtitle(object)}
                        {object.locked && (
                          <>
                            {' '}
                            · <Icon name="lock" size={10} />
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <IconButton
                    icon={object.visible ? 'eye' : 'eyeOff'}
                    label={object.visible ? 'Hide object' : 'Show object'}
                    onClick={() =>
                      dispatch({
                        type: 'updateObject',
                        id: object.id,
                        patch: { visible: !object.visible },
                      })
                    }
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
