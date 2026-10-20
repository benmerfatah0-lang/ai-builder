export type BiomeId = 'meadow' | 'forest' | 'mountains' | 'desert' | 'island' | 'ruins';
export type TimeOfDay = 'day' | 'sunset' | 'night';
export type WorldScale = 'small' | 'medium' | 'large';
export type WorldStyle = 'cartoon' | 'natural' | 'stylized';
export type WorldDensity = 'sparse' | 'normal' | 'dense';

/**
 * Concrete structures the planner should build. A plain biome prompt leaves
 * this undefined and runs the original scatter generator; a farm prompt fills it
 * in and runs the structured layout generator.
 */
export interface FarmFeatures {
  farm: boolean;
  farmhouse: boolean;
  barn: boolean;
  silo: boolean;
  coop: boolean;
  wheatFields: number;
  fences: boolean;
  dirtPaths: boolean;
  orchard: boolean;
  river: boolean;
  bridge: boolean;
  rocks: boolean;
  bushes: boolean;
  lanterns: boolean;
}

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
  /** Present when the prompt describes a structured farm scene. */
  features?: FarmFeatures;
  style?: WorldStyle;
  density?: WorldDensity;
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
  /** Optional explicit overrides from the AI panel. */
  style?: WorldStyle;
  scale?: WorldScale;
  density?: WorldDensity;
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
