import { useState } from 'react';
import { localPromptInterpreter } from '../../ai/promptInterpreter';
import { generateWorldPlanWithReport } from '../../../core/generation/generateWorld';
import type { PromptInterpretation } from '../../ai/types';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import { NumberField, SelectField } from '../../../ui/controls';
import type { WorldDensity, WorldScale, WorldStyle } from '../../ai/types';

const EXAMPLES = [
  'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths',
  'A small farm with a barn, one wheat field and a stream with a bridge',
  'A misty pine forest at night with lanterns',
  'A desert oasis village at sunset with palm trees',
  'A tropical island with palm trees and scattered ruins',
  'A snowy mountain range with an ancient temple',
  'A quiet meadow with boulders and a lake',
];

function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

export function AiPanel({
  notify,
  onGenerated,
}: {
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onGenerated?: () => void;
}) {
  const { dispatch } = useEditor();
  const [prompt, setPrompt] = useState('');
  const [seed, setSeed] = useState<number>(() => randomSeed());
  const [style, setStyle] = useState<WorldStyle | 'auto'>('auto');
  const [scale, setScale] = useState<WorldScale | 'auto'>('auto');
  const [density, setDensity] = useState<WorldDensity | 'auto'>('auto');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PromptInterpretation | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [stats, setStats] = useState<{ objects: number; groups: number } | null>(null);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerating(true);
    try {
      // Yield one frame so the button's busy state paints on slower phones.
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      const interpretation = await localPromptInterpreter.interpret(text, {
        seed,
        ...(style !== 'auto' ? { style } : {}),
        ...(scale !== 'auto' ? { scale } : {}),
        ...(density !== 'auto' ? { density } : {}),
      });
      const report = generateWorldPlanWithReport(interpretation.intent);
      if (!report.validation.valid) {
        const first = report.validation.errors[0]?.message ?? 'Unknown validation error.';
        throw new Error(`The generated plan is invalid: ${first}`);
      }
      dispatch({ type: 'replacePlan', plan: report.plan });
      setResult(interpretation);
      setNotes(report.warnings.slice(0, 8));
      setStats({ objects: report.plan.objects.length, groups: report.plan.groups.length });
      notify(
        report.warnings.length > 0
          ? `World generated with ${report.warnings.length} warning(s). Undo restores the previous world.`
          : 'New world generated. Undo restores the previous world.',
        'success',
      );
      onGenerated?.();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : 'World generation failed.',
        'danger',
      );
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="panel-scroll">
      <div className="panel-intro">
        <div>
          <h2>AI world</h2>
          <p>Describe a world. The local interpreter builds it in your browser.</p>
        </div>
      </div>

      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          className="prompt-input"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="A misty pine forest at night with lanterns…"
          rows={4}
          maxLength={400}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void generate();
            }
          }}
        />
      </label>

      <div className="example-list">
        <span className="field-label">Try an example</span>
        {EXAMPLES.map((example) => (
          <button
            type="button"
            className="prompt-example"
            key={example}
            onClick={() => setPrompt(example)}
          >
            {example}
          </button>
        ))}
      </div>

      <div className="seed-row">
        <NumberField
          label="Seed"
          value={seed}
          min={0}
          max={4294967295}
          step={1}
          onCommit={(value) => setSeed(Math.round(value))}
        />
        <button type="button" className="btn btn-small" onClick={() => setSeed(randomSeed())}>
          Reroll
        </button>
      </div>
      <div className="ai-controls">
        <SelectField
          label="Style"
          value={style}
          options={[
            { value: 'auto', label: 'Auto (from prompt)' },
            { value: 'cartoon', label: 'Cartoon low-poly' },
            { value: 'stylized', label: 'Stylized' },
            { value: 'natural', label: 'Natural' },
          ]}
          onChange={(value) => setStyle(value as WorldStyle | 'auto')}
        />
        <SelectField
          label="World size"
          value={scale}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'small', label: 'Small' },
            { value: 'medium', label: 'Medium' },
            { value: 'large', label: 'Large' },
          ]}
          onChange={(value) => setScale(value as WorldScale | 'auto')}
        />
        <SelectField
          label="Density"
          value={density}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'sparse', label: 'Sparse' },
            { value: 'normal', label: 'Normal' },
            { value: 'dense', label: 'Dense' },
          ]}
          onChange={(value) => setDensity(value as WorldDensity | 'auto')}
        />
      </div>
      <p className="hint-text">
        Same description, seed and overrides rebuild the same layout, colors and placements.
      </p>

      <button
        type="button"
        className="btn btn-primary generate-btn"
        onClick={() => void generate()}
        disabled={!prompt.trim() || generating}
      >
        {generating ? <span className="spinner small" /> : <Icon name="sparkles" size={17} />}
        {generating ? 'Building world…' : 'Generate world'}
      </button>
      <p className="hint-text">
        Generation creates a new world and keeps the current one in your library. Undo is available.
      </p>

      {result && (
        <div className="ai-result">
          <div className="ai-result-head">
            <span className="ai-result-icon">
              <Icon name="check" size={15} />
            </span>
            <strong>World generated</strong>
          </div>
          <p className="ai-summary">{result.intent.summary}</p>
          {stats && (
            <p className="hint-text">
              {stats.objects} objects · {stats.groups} groups · plan v3
            </p>
          )}
          <div className="cue-list">
            {result.intent.cues.map((cue) => (
              <span className="cue" key={cue}>
                {cue}
              </span>
            ))}
          </div>
          {notes.length > 0 && (
            <div className="ai-warnings">
              <span className="field-label">Warnings</span>
              <ul>
                {notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="hint-text">
            Seed {result.intent.seed} · {result.providerLabel} · {result.offline ? 'offline' : 'remote'}
          </p>
        </div>
      )}

      <div className="callout callout-info">
        <Icon name="info" size={16} />
        <span>
          The planner is deterministic and fully local: your prompt is parsed into a versioned
          WorldPlan, validated, then built by the procedural generator. Farm prompts run the
          structured layout planner (yard, lanes, fields, fences, orchard); other prompts use the
          scatter generator. No API key and no data leaves the browser.
        </span>
      </div>
    </div>
  );
}
