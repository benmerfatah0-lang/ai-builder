import { useMemo, useState } from 'react';
import {
  ASSET_LIBRARY,
  placementForNewObject,
  type AssetCategory,
  type AssetDefinition,
} from '../../../core/assets/catalog';
import { mulberry32 } from '../../../core/generation/rng';
import { createTerrainSampler } from '../../../core/generation/terrain';
import { MAX_WORLD_OBJECTS } from '../../../core/world-plan/schema';
import { useEditor } from '../store';
import { Icon, type IconName } from '../../../ui/Icon';
import { EmptyState } from '../../../ui/controls';

type Filter = 'all' | AssetCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'primitives', label: 'Shapes' },
  { id: 'nature', label: 'Nature' },
  { id: 'structures', label: 'Structures' },
  { id: 'lights', label: 'Lights' },
];

const CATEGORY_ICONS: Record<AssetCategory, IconName> = {
  primitives: 'cube',
  nature: 'tree',
  structures: 'layers',
  lights: 'sun',
};

export function AssetsPanel({
  notify,
  onAdded,
}: {
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onAdded?: () => void;
}) {
  const { state, dispatch } = useEditor();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const atLimit = state.plan.objects.length >= MAX_WORLD_OBJECTS;

  const assets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return ASSET_LIBRARY.filter((asset) => {
      const inFilter = filter === 'all' || asset.category === filter;
      const inQuery =
        !normalized ||
        asset.label.toLowerCase().includes(normalized) ||
        asset.description.toLowerCase().includes(normalized);
      return inFilter && inQuery;
    });
  }, [filter, query]);

  const addAsset = (asset: AssetDefinition) => {
    if (atLimit) {
      notify(`This world has reached the ${MAX_WORLD_OBJECTS}-object limit.`, 'danger');
      return;
    }
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const rng = mulberry32(seed);
    const sampler = createTerrainSampler(state.plan.terrain, state.plan.seed);
    const position = placementForNewObject(state.plan, sampler, rng);
    const object = asset.create(rng, position);
    const sameName = state.plan.objects.filter(
      (entry) => entry.name === object.name || entry.name.startsWith(`${object.name} `),
    ).length;
    if (sameName > 0) object.name = `${object.name} ${sameName + 1}`;
    dispatch({ type: 'addObject', object });
    notify(`${asset.label} added to the world.`, 'success');
    onAdded?.();
  };

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>Assets</h2>
          <p>Procedural primitives and nature props. Click to place.</p>
        </div>
      </div>

      <div className="search-field">
        <Icon name="search" size={15} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search assets"
          aria-label="Search assets"
        />
        {query && (
          <button type="button" className="clear-search" onClick={() => setQuery('')} aria-label="Clear search">
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      <div className="filter-row">
        {FILTERS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`chip ${filter === entry.id ? 'is-active' : ''}`}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {atLimit && (
        <div className="callout callout-warning">
          <Icon name="alert" size={16} />
          <span>Object limit reached. Delete objects to add more.</span>
        </div>
      )}

      {assets.length === 0 ? (
        <EmptyState icon="search" title="No assets found">
          Try another search term.
        </EmptyState>
      ) : (
        <div className="asset-grid">
          {assets.map((asset) => (
            <button
              type="button"
              key={asset.id}
              className="asset-card"
              onClick={() => addAsset(asset)}
              disabled={atLimit}
              title={asset.description}
            >
              <span className={`asset-glyph category-${asset.category}`}>
                <Icon name={CATEGORY_ICONS[asset.category]} size={18} />
              </span>
              <span className="asset-label">{asset.label}</span>
              <span className="asset-add">
                <Icon name="plus" size={12} />
              </span>
            </button>
          ))}
        </div>
      )}

      <p className="hint-text">
        Props are generated from geometry at runtime — no textures or external downloads.
      </p>
    </div>
  );
}
