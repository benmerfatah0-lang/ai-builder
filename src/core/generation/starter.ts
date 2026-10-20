import type { WorldPlan } from '../world-plan/schema';
import { interpretPromptLocally } from '../../modules/ai/promptInterpreter';
import { generateWorldPlan } from './generateWorld';

export const STARTER_PROMPT =
  'A quiet meadow with scattered pines, boulders and a lake at sunset';
export const STARTER_SEED = 20261020;

/**
 * The first-run world. It is produced by the real generator (not hard-coded
 * objects) and uses a fixed seed, so every install starts with the same scene.
 */
export function createStarterWorld(): WorldPlan {
  const interpretation = interpretPromptLocally(STARTER_PROMPT, { seed: STARTER_SEED });
  const plan = generateWorldPlan(interpretation.intent);
  return {
    ...plan,
    name: 'Welcome Meadow',
    description: 'A first-run example generated locally. Edit it, or generate your own world.',
  };
}
