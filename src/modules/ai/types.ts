export type BiomeId = 'meadow' | 'forest' | 'mountains' | 'desert' | 'island' | 'ruins';
export type TimeOfDay = 'day' | 'sunset' | 'night';
export type WorldScale = 'small' | 'medium' | 'large';

export interface WorldIntent {
  /** Original prompt, preserved for provenance. */
  prompt: string;
  name: string;
  seed: number;
  biome: BiomeId;
  timeOfDay: TimeOfDay;
  scale: WorldScale;
  settlement: boolean;
  water: boolean;
  counts: {
    trees: number;
    rocks: number;
    buildings: number;
    lanterns: number;
  };
  /** Human-readable list of cues the interpreter matched. */
  cues: string[];
  summary: string;
}

export interface PromptInterpretation {
  intent: WorldIntent;
  providerId: string;
  providerLabel: string;
  /** True when interpretation runs fully in the browser with no network calls. */
  offline: boolean;
}

export interface InterpretOptions {
  seed?: number;
}

/**
 * Contract for text-to-world intent providers. Phase 1 ships a deterministic
 * local provider; a future local-LLM provider can implement the same interface
 * without touching the editor or the generator.
 */
export interface PromptInterpreter {
  id: string;
  label: string;
  offline: boolean;
  interpret(prompt: string, options?: InterpretOptions): Promise<PromptInterpretation>;
}
