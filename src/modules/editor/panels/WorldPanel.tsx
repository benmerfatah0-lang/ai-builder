import { useEditor } from '../store';
import { countObjects } from '../../../core/world-plan/factory';
import { Icon } from '../../../ui/Icon';
import {
  ColorField,
  Field,
  Section,
  SelectField,
  SliderField,
  Toggle,
} from '../../../ui/controls';

const TERRAIN_OPTIONS = [
  { value: 'hills', label: 'Rolling hills' },
  { value: 'flat', label: 'Flat plane' },
  { value: 'mountains', label: 'Mountains' },
  { value: 'dunes', label: 'Dunes' },
  { value: 'islands', label: 'Islands' },
];

export function WorldPanel({
  onOpenLibrary,
  storageKind,
}: {
  onOpenLibrary: () => void;
  storageKind: 'indexeddb' | 'memory';
}) {
  const { state, dispatch } = useEditor();
  const { plan } = state;
  const counts = countObjects(plan);
  const waterEnabled = plan.terrain.waterLevel !== null;

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>World</h2>
          <p>Shape the terrain and atmosphere. Everything is saved in this browser.</p>
        </div>
        <button type="button" className="btn btn-small" onClick={onOpenLibrary}>
          <Icon name="folder" size={15} /> Worlds
        </button>
      </div>

      {state.saveState === 'error' && (
        <div className="callout callout-warning" style={{ marginBottom: 10 }}>
          <Icon name="alert" size={16} />
          <span>
            Autosave failed: {state.saveError ?? 'unknown storage error'}. Export the project file
            to keep your work.
          </span>
        </div>
      )}

      <Section title="Terrain" icon="mountain">
        <SelectField
          label="Landform"
          value={plan.terrain.style}
          options={TERRAIN_OPTIONS}
          onChange={(style) =>
            dispatch({ type: 'updateTerrain', patch: { style: style as typeof plan.terrain.style } })
          }
        />
        <SliderField
          label="Size"
          value={plan.terrain.size}
          min={32}
          max={512}
          step={8}
          onChange={(size) => dispatch({ type: 'updateTerrain', patch: { size } })}
          format={(value) => `${Math.round(value)} u`}
        />
        <SliderField
          label="Height"
          value={plan.terrain.heightScale}
          min={0}
          max={40}
          step={0.5}
          onChange={(heightScale) => dispatch({ type: 'updateTerrain', patch: { heightScale } })}
          format={(value) => `${Math.round(value * 10) / 10} u`}
        />
        <Toggle
          label="Water surface"
          checked={waterEnabled}
          onChange={(enabled) =>
            dispatch({
              type: 'updateTerrain',
              patch: { waterLevel: enabled ? (plan.terrain.waterLevel ?? 0.5) : null },
            })
          }
        />
        {waterEnabled && (
          <SliderField
            label="Water level"
            value={plan.terrain.waterLevel ?? 0}
            min={-20}
            max={30}
            step={0.1}
            onChange={(waterLevel) => dispatch({ type: 'updateTerrain', patch: { waterLevel } })}
            format={(value) => `${Math.round(value * 10) / 10} u`}
          />
        )}
        <div className="field-grid">
          <ColorField
            label="Low ground"
            value={plan.terrain.palette.low}
            onChange={(low) =>
              dispatch({ type: 'updateTerrain', patch: { palette: { ...plan.terrain.palette, low } } })
            }
          />
          <ColorField
            label="High ground"
            value={plan.terrain.palette.high}
            onChange={(high) =>
              dispatch({ type: 'updateTerrain', patch: { palette: { ...plan.terrain.palette, high } } })
            }
          />
        </div>
        <p className="hint-text">
          Terrain edits do not move existing objects. Use “Snap to ground” in the inspector after
          reshaping.
        </p>
      </Section>

      <Section title="Environment" icon="sun">
        <div className="field-grid">
          <ColorField
            label="Sky"
            value={plan.environment.skyColor}
            onChange={(skyColor) => dispatch({ type: 'updateEnvironment', patch: { skyColor } })}
          />
          <ColorField
            label="Fog"
            value={plan.environment.fogColor}
            onChange={(fogColor) => dispatch({ type: 'updateEnvironment', patch: { fogColor } })}
          />
        </div>
        <SliderField
          label="Sun elevation"
          value={plan.environment.sunElevation}
          min={0}
          max={90}
          step={1}
          onChange={(sunElevation) =>
            dispatch({ type: 'updateEnvironment', patch: { sunElevation } })
          }
          format={(value) => `${Math.round(value)}°`}
        />
        <SliderField
          label="Sun direction"
          value={plan.environment.sunAzimuth}
          min={0}
          max={360}
          step={1}
          onChange={(sunAzimuth) => dispatch({ type: 'updateEnvironment', patch: { sunAzimuth } })}
          format={(value) => `${Math.round(value)}°`}
        />
        <SliderField
          label="Sun intensity"
          value={plan.environment.sunIntensity}
          min={0}
          max={4}
          step={0.05}
          onChange={(sunIntensity) =>
            dispatch({ type: 'updateEnvironment', patch: { sunIntensity } })
          }
        />
        <SliderField
          label="Ambient light"
          value={plan.environment.ambientIntensity}
          min={0}
          max={3}
          step={0.05}
          onChange={(ambientIntensity) =>
            dispatch({ type: 'updateEnvironment', patch: { ambientIntensity } })
          }
        />
        <SliderField
          label="Fog density"
          value={plan.environment.fogDensity}
          min={0}
          max={0.02}
          step={0.0002}
          onChange={(fogDensity) =>
            dispatch({ type: 'updateEnvironment', patch: { fogDensity } })
          }
          format={(value) => value.toFixed(4)}
        />
      </Section>

      <Section title="Project" icon="info" defaultOpen={false}>
        <dl className="stats-list">
          <div>
            <dt>Objects</dt>
            <dd>{counts.total ?? 0}</dd>
          </div>
          <div>
            <dt>Seed</dt>
            <dd className="mono">{plan.seed}</dd>
          </div>
          <div>
            <dt>Schema</dt>
            <dd>WorldPlan v{plan.schemaVersion}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>{storageKind === 'indexeddb' ? 'This browser' : 'Session memory'}</dd>
          </div>
        </dl>
        {plan.description && <p className="hint-text">{plan.description}</p>}
        <Field>
          <span className="hint-text mono">ID: {plan.id}</span>
        </Field>
      </Section>
    </div>
  );
}
