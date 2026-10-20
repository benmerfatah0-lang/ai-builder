import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useEditor } from '../store';
import {
  buildHierarchy,
  isEffectivelyLocked,
  isEffectivelyVisible,
  type HierarchyEntry,
} from '../../../core/world-plan/hierarchy';
import { isGroup } from '../../../core/world-plan/schema';
import { Icon } from '../../../ui/Icon';
import { EmptyState, IconButton } from '../../../ui/controls';
import { nodeIcon, nodeSubtitle, nodeTypeLabel } from './nodeMeta';

interface RowModel {
  entry: HierarchyEntry;
  hasChildren: boolean;
}

function flattenVisible(
  entries: HierarchyEntry[],
  collapsed: Set<string>,
): RowModel[] {
  const rows: RowModel[] = [];
  const walk = (list: HierarchyEntry[]) => {
    for (const entry of list) {
      const hasChildren = entry.children.length > 0;
      rows.push({ entry, hasChildren });
      if (hasChildren && !collapsed.has(entry.node.id)) walk(entry.children);
    }
  };
  walk(entries);
  return rows;
}

function matchesQuery(entry: HierarchyEntry, query: string): boolean {
  if (!query) return true;
  const node = entry.node;
  const label = node.name.toLowerCase();
  const type = nodeTypeLabel(node).toLowerCase();
  const subtitle = nodeSubtitle(node).toLowerCase();
  return label.includes(query) || type.includes(query) || subtitle.includes(query);
}

/** Keep a matching node and all of its ancestors so the tree stays navigable. */
function filterEntries(entries: HierarchyEntry[], query: string): HierarchyEntry[] {
  if (!query) return entries;
  return entries
    .map((entry) => {
      const children = filterEntries(entry.children, query);
      if (children.length > 0 || matchesQuery(entry, query)) {
        return { ...entry, children };
      }
      return null;
    })
    .filter((entry): entry is HierarchyEntry => entry !== null);
}

export function HierarchyPanel({ onShowAssets }: { onShowAssets: () => void }) {
  const { state, dispatch } = useEditor();
  const { plan, selection } = state;
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const tree = filterEntries(buildHierarchy(plan), normalizedQuery);
    return flattenVisible(tree, normalizedQuery ? new Set() : collapsed);
  }, [plan, collapsed, normalizedQuery]);

  const primary = selection[selection.length - 1] ?? null;
  const selectedNodes = selection
    .map((id) => [...plan.groups, ...plan.objects].find((node) => node.id === id))
    .filter((node) => node !== undefined);
  const canGroup = selectedNodes.length > 0;
  const canUngroup = selectedNodes.some((node) => isGroup(node));
  const locked = primary ? isEffectivelyLocked(plan, primary) : false;

  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRowClick = (event: MouseEvent, id: string) => {
    if (event.shiftKey) {
      dispatch({ type: 'select', ids: [id], mode: 'add' });
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      dispatch({ type: 'select', ids: [id], mode: 'toggle' });
      return;
    }
    dispatch({ type: 'select', ids: [id], mode: 'replace' });
  };

  const startRename = (id: string, name: string) => {
    setRenaming({ id, draft: name });
    window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
  };

  const commitRename = () => {
    if (!renaming) return;
    const name = renaming.draft.trim();
    if (name) dispatch({ type: 'renameNode', id: renaming.id, name });
    setRenaming(null);
  };

  const totalNodes = plan.objects.length + plan.groups.length;

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>Scene</h2>
          <p>
            {plan.objects.length} {plan.objects.length === 1 ? 'object' : 'objects'}
            {plan.groups.length > 0 ? ` · ${plan.groups.length} groups` : ''}
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
          placeholder="Filter scene"
          aria-label="Filter scene"
        />
        {query && (
          <button
            type="button"
            className="clear-search"
            onClick={() => setQuery('')}
            aria-label="Clear filter"
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>

      {totalNodes === 0 ? (
        <EmptyState icon="layers" title="This world is empty">
          Generate a world with the AI panel or add assets from the Assets tab.
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState icon="search" title="No matches">
          Try a different name or type.
        </EmptyState>
      ) : (
        <ul className="tree" role="tree" aria-label="Scene hierarchy">
          {rows.map(({ entry, hasChildren }) => {
            const { node } = entry;
            const isGroupNode = isGroup(node);
            const isSelected = primary === node.id;
            const inSelection = selection.includes(node.id);
            const visible = isEffectivelyVisible(plan, node.id);
            const nodeLocked = isEffectivelyLocked(plan, node.id);
            const isRenaming = renaming?.id === node.id;

            return (
              <li
                key={node.id}
                role="treeitem"
                aria-label={`${node.name} (${nodeTypeLabel(node)})`}
                aria-selected={inSelection}
                aria-expanded={hasChildren ? !collapsed.has(node.id) : undefined}
              >
                <div
                  className={`tree-row ${isSelected ? 'is-primary' : ''} ${
                    inSelection ? 'is-selected' : ''
                  } ${visible ? '' : 'is-hidden'}`}
                  style={{ paddingLeft: 4 + entry.depth * 14 }}
                  tabIndex={0}
                  onMouseDown={(event) => handleRowClick(event, node.id)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      dispatch({
                        type: 'select',
                        ids: [node.id],
                        mode: event.shiftKey ? 'add' : 'replace',
                      });
                    }
                    if (event.key === 'F2') {
                      event.preventDefault();
                      startRename(node.id, node.name);
                    }
                  }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className="tree-toggle"
                      aria-label={collapsed.has(node.id) ? 'Expand group' : 'Collapse group'}
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={() => toggleCollapsed(node.id)}
                    >
                      <Icon
                        name="chevronDown"
                        size={12}
                        className={collapsed.has(node.id) ? 'collapsed' : ''}
                      />
                    </button>
                  ) : (
                    <span className="tree-toggle-spacer" />
                  )}

                  <span className={`tree-icon ${isGroupNode ? 'is-group' : `kind-${node.kind}`}`}>
                    <Icon name={nodeIcon(node)} size={14} />
                  </span>

                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="tree-rename"
                      value={renaming.draft}
                      maxLength={80}
                      aria-label={`Rename ${node.name}`}
                      onChange={(event) =>
                        setRenaming({ id: node.id, draft: event.target.value })
                      }
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') setRenaming(null);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                    />
                  ) : (
                    <span
                      className="tree-label"
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        startRename(node.id, node.name);
                      }}
                      title={`${node.name} · ${nodeTypeLabel(node)} · double-click to rename`}
                    >
                      {node.name}
                    </span>
                  )}

                  <span className="tree-actions">
                    {node.locked && <Icon name="lock" size={11} className="tree-lock" />}
                    <IconButton
                      icon={node.visible ? 'eye' : 'eyeOff'}
                      label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                      onClick={() =>
                        dispatch({ type: 'setVisible', id: node.id, visible: !node.visible })
                      }
                    />
                    <IconButton
                      icon={node.locked ? 'lock' : 'unlock'}
                      label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                      onClick={() =>
                        dispatch({ type: 'setLocked', id: node.id, locked: !node.locked })
                      }
                    />
                    <IconButton
                      icon="trash"
                      label={`Delete ${node.name}`}
                      danger
                      disabled={nodeLocked}
                      onClick={() => dispatch({ type: 'deleteNode', id: node.id })}
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="tree-footer">
        <button
          type="button"
          className="btn btn-small"
          disabled={!canGroup}
          onClick={() => dispatch({ type: 'groupSelection' })}
          title="Group selection (Ctrl/Cmd+G)"
        >
          <Icon name="folder" size={14} /> Group
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={!canUngroup}
          onClick={() => {
            const group = selectedNodes.find((node) => !('kind' in node));
            if (group) dispatch({ type: 'ungroup', id: group.id });
          }}
          title="Ungroup (Ctrl/Cmd+Shift+G)"
        >
          <Icon name="layers" size={14} /> Ungroup
        </button>
        <button
          type="button"
          className="btn btn-small"
          disabled={selection.length === 0}
          onClick={() => dispatch({ type: 'duplicateSelection' })}
          title="Duplicate (Ctrl/Cmd+D)"
        >
          <Icon name="copy" size={14} /> Duplicate
        </button>
        <button
          type="button"
          className="btn btn-small btn-danger"
          disabled={selection.length === 0 || locked}
          onClick={() => dispatch({ type: 'deleteSelection' })}
          title="Delete selection (Del)"
        >
          <Icon name="trash" size={14} /> Delete
        </button>
      </div>
    </div>
  );
}
