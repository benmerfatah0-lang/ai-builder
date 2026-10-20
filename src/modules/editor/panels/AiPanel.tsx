import { useState } from 'react';
import { localPromptInterpreter } from '../../ai/promptInterpreter';
import { generateWorldPlan } from '../../../core/generation/generateWorld';
import type { PromptInterpretation } from '../../ai/types';
import { useEditor } from '../store';
import { Icon } from '../../../ui/Icon';
import { NumberField } from '../../../ui/controls';

const EXAMPLES = [
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
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<PromptInterpretation | null>(null);

  const generate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setGenerating(true);
    try {
      // Yield one frame so the button's busy state paints on slower phones.
      await new Promise((resolve) => window.setTimeout(resolve, 16));
      const interpretation = await localPromptInterpreter.interpret(text, { seed });
      const plan = generateWorldPlan(interpretation.intent);
      dispatch({ type: 'replacePlan', plan });
      setResult(interpretation);
      notify('New world generated. Undo restores the previous world.', 'success');
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
      <p className="hint-text">
        Same description + seed rebuilds the same layout, colors and placements.
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
          <div className="cue-list">
            {result.intent.cues.map((cue) => (
              <span className="cue" key={cue}>
                {cue}
              </span>
            ))}
          </div>
          <p className="hint-text">
            Seed {result.intent.seed} · {result.providerLabel} · {result.offline ? 'offline' : 'remote'}
          </p>
        </div>
      )}

      <div className="callout callout-info">
        <Icon name="info" size={16} />
        <span>
          This phase uses a deterministic rule-based interpreter: keywords map to biomes, times of
          day and object counts. No API key, no cost, no data leaves the browser. A local LLM can
          replace it behind the same interface later.
        </span>
      </div>
    </div>
  );
}
