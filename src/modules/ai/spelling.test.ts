import { describe, expect, it } from 'vitest';
import { correctBuildSpelling } from './spelling';
import { interpretPromptLocally } from './promptInterpreter';
import { editWorldByText } from './worldEdit';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';

describe('limited explicit spelling corrections', () => {
  it('corrects listed typos and makes corrections visible without mutating original prompt', () => {
    const result = correctBuildSpelling('قرية فيها نهرر يمر وسط القريية');
    expect(result.text).toBe('قرية فيها نهر يمر وسط القرية');
    expect(result.changes).toHaveLength(2);
    const interpreted = interpretPromptLocally('قرية فيها نهرر يمر وسط القريية');
    expect(interpreted.intent.villageRiver).toBe(true);
    expect(interpreted.intent.prompt).toContain('نهرر');
    expect(interpreted.notes?.join()).toContain('تصحيح إملائي');
  });
  it('only auto-corrects addition commands, never destructive edits', () => {
    const plan = createEmptyWorldPlan({ seed: 7 });
    const result = editWorldByText(plan, [], 'أضف شجررة');
    expect(result.plan.objects.some((o) => o.kind === 'tree')).toBe(true);
    expect(result.message).toContain('شجررة');
    expect(() => editWorldByText(result.plan, [], 'احذف الشجررة')).toThrow();
    expect(result.plan.objects).toHaveLength(1);
    expect(correctBuildSpelling('فراشة').text).toBe('فراشة');
    expect(correctBuildSpelling('vvillage with a rivver').text).toBe('village with a river');
    expect(correctBuildSpelling('tree').text).toBe('tree');
    expect(correctBuildSpelling('البررج').text).toBe('البرج');
  });
});
