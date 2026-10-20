import { Icon } from '../../ui/Icon';
import { ALL_AXES, type AxisFilter, type TransformSpace, type TransformTool } from './Viewport';

interface ViewportToolbarProps {
  tool: TransformTool;
  space: TransformSpace;
  snap: boolean;
  showGrid: boolean;
  axes: AxisFilter;
  selectionCount: number;
  onToolChange: (tool: TransformTool) => void;
  onSpaceChange: (space: TransformSpace) => void;
  onSnapChange: (snap: boolean) => void;
  onGridChange: (showGrid: boolean) => void;
  onAxesChange: (axes: AxisFilter) => void;
}

const AXES: { id: keyof AxisFilter; label: string }[] = [
  { id: 'x', label: 'X' },
  { id: 'y', label: 'Y' },
  { id: 'z', label: 'Z' },
];

const TOOLS: { id: TransformTool; label: string; shortcut: string }[] = [
  { id: 'translate', label: 'Move', shortcut: 'G' },
  { id: 'rotate', label: 'Rotate', shortcut: 'R' },
  { id: 'scale', label: 'Scale', shortcut: 'S' },
];

export function ViewportToolbar({
  tool,
  space,
  snap,
  showGrid,
  axes,
  selectionCount,
  onToolChange,
  onSpaceChange,
  onSnapChange,
  onGridChange,
  onAxesChange,
}: ViewportToolbarProps) {
  const toggleAxis = (axis: keyof AxisFilter) => {
    const next = { ...axes, [axis]: !axes[axis] };
    // Never hide every handle: at least one axis must stay editable.
    if (!next.x && !next.y && !next.z) {
      onAxesChange(ALL_AXES);
      return;
    }
    onAxesChange(next);
  };

  return (
    <div className="viewport-toolbar" role="toolbar" aria-label="Transform tools">
      <div className="tool-group" role="group" aria-label="Transform mode">
        {TOOLS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`tool-button ${tool === entry.id ? 'is-active' : ''}`}
            onClick={() => onToolChange(entry.id)}
            aria-pressed={tool === entry.id}
            title={`${entry.label} (${entry.shortcut})`}
          >
            <Icon name={entry.id === 'translate' ? 'move' : entry.id} size={17} />
            <span className="tool-label">{entry.label}</span>
          </button>
        ))}
      </div>

      <span className="tool-divider" />

      <button
        type="button"
        className="tool-button tool-compact"
        onClick={() => onSpaceChange(space === 'world' ? 'local' : 'world')}
        title={`Transform space: ${space} (click to switch)`}
        aria-label={`Transform space: ${space}`}
      >
        <span className="space-badge">{space === 'world' ? 'W' : 'L'}</span>
      </button>

      <button
        type="button"
        className={`tool-button tool-compact ${snap ? 'is-active' : ''}`}
        onClick={() => onSnapChange(!snap)}
        aria-pressed={snap}
        title="Snap to 0.5 units / 15° / 0.1 scale"
        aria-label="Toggle snapping"
      >
        <Icon name="magnet" size={16} />
      </button>

      <button
        type="button"
        className={`tool-button tool-compact ${showGrid ? 'is-active' : ''}`}
        onClick={() => onGridChange(!showGrid)}
        aria-pressed={showGrid}
        title="Toggle grid"
        aria-label="Toggle grid"
      >
        <Icon name="grid" size={16} />
      </button>

      <div className="tool-group" role="group" aria-label="Axis constraint">
        {AXES.map((axis) => (
          <button
            key={axis.id}
            type="button"
            className={`tool-button tool-axis ${axes[axis.id] ? 'is-active' : ''} axis-${axis.id}`}
            onClick={() => toggleAxis(axis.id)}
            aria-pressed={axes[axis.id]}
            title={`Toggle ${axis.label} axis (${axis.label})`}
            aria-label={`Toggle ${axis.label} axis`}
          >
            {axis.label}
          </button>
        ))}
      </div>

      <span className="tool-selection" aria-live="polite">
        {selectionCount === 0 ? 'No selection' : selectionCount === 1 ? '1 selected' : `${selectionCount} selected`}
      </span>
    </div>
  );
}
