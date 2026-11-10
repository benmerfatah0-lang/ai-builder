import { describe, expect, it } from 'vitest';
import { detectContradictions, resolveWithAnswers, type ClarificationAnswers } from './contradictions';
import { extractFrames } from './frames';

function detect(description: string, input: { requestedObjects?: number; hasHighGround?: boolean; hasWater?: boolean } = {}) {
  return detectContradictions({
    frames: extractFrames(description),
    requestedObjects: input.requestedObjects ?? 20,
    hasHighGround: input.hasHighGround ?? true,
    hasWater: input.hasWater ?? true,
  });
}

const ids = (description: string, input?: Parameters<typeof detect>[1]) =>
  detect(description, input).clarifications.map((item) => item.id);

describe('detectContradictions', () => {
  it('asks before dropping water the description also asked for', () => {
    const result = detect('بحيرة جميلة بدون ماء');
    expect(ids('بحيرة جميلة بدون ماء')).toContain('water-contradiction');
    const question = result.clarifications.find((item) => item.id === 'water-contradiction')!;
    expect(question.severity).toBe('blocking');
    expect(question.options.map((option) => option.id)).toEqual(['keep-water', 'drop-water']);
    expect(question.question).toContain('بحيرة');
  });

  it('asks about a forest with no trees, but not about one species', () => {
    expect(ids('غابة بدون أشجار')).toContain('forest-without-trees');
    expect(ids('غابة بدون أشجار نخيل')).not.toContain('forest-without-trees');
    expect(detect('غابة بدون أشجار نخيل').notices.join(' ')).toContain('نخلة');
  });

  it('refuses a dense pine forest in a desert, and softens the sparse case', () => {
    expect(ids('صحراء فيها غابة صنوبر كثيفة')).toContain('desert-dense-forest');
    const soft = detect('صحراء فيها غابة صنوبر');
    expect(soft.clarifications.map((item) => item.id)).not.toContain('desert-dense-forest');
    expect(soft.notices.join(' ')).toContain('نخيل');
  });

  it('asks about an island with no water', () => {
    expect(ids('جزيرة بدون ماء')).toContain('island-without-water');
  });

  it('asks when flat land is described together with mountains', () => {
    expect(ids('ارض مسطحة فيها جبال')).toContain('flat-and-mountainous');
  });

  it('warns when a landmark hangs on relief the description never mentioned', () => {
    expect(ids('a castle on top of a tall mountain', { hasHighGround: false })).toContain('anchor-missing-highground');
    expect(ids('a castle on top of a mountain', { hasHighGround: true })).not.toContain('anchor-missing-highground');
  });

  it('asks how to split two biomes that have no regions', () => {
    expect(ids('غابة وصحراء')).toContain('multiple-biomes');
    expect(ids('غابة في الشمال وصحراء في الجنوب')).not.toContain('multiple-biomes');
  });

  it('asks which time of day wins', () => {
    const result = detect('ليل ونهار');
    expect(result.clarifications.map((item) => item.id)).toContain('conflicting-time');
    expect(result.clarifications.find((item) => item.id === 'conflicting-time')!.question).toContain('ليل');
    expect(ids('ليل مع ضباب')).not.toContain('conflicting-time');
  });

  it('reports the object budget instead of failing silently', () => {
    const result = detect('عالم ضخم', { requestedObjects: 4000 });
    expect(result.clarifications.map((item) => item.id)).toContain('object-budget');
    expect(result.notices.join(' ')).toContain('1500');
    expect(detect('عالم ضخم', { requestedObjects: 40 }).clarifications.map((item) => item.id)).not.toContain('object-budget');
  });

  it('asks when a river must cross something while rivers are excluded', () => {
    expect(ids('نهر يعبر الغابة بدون انهار')).toContain('river-negated-but-crossed');
  });

  it('records animals as known but not buildable', () => {
    const result = detect('ثلاث غزلان وذئبان');
    expect(result.notices.join(' ')).toContain('غزال');
    expect(result.clarifications.filter((item) => item.severity === 'blocking')).toEqual([]);
  });

  it('writes every question in Arabic with a usable default', () => {
    const result = detect('غابة بدون أشجار');
    for (const item of result.clarifications) {
      expect(item.question.length).toBeGreaterThan(10);
      expect(item.reason.length).toBeGreaterThan(5);
      expect(item.options.map((option) => option.id)).toContain(item.defaultOption);
      expect(item.options.every((option) => option.label.length > 2)).toBe(true);
    }
  });
});

describe('resolveWithAnswers', () => {
  it('keeps a blocking question open until it is answered', () => {
    const clarifications = detect('غابة بدون أشجار').clarifications;
    const unanswered = resolveWithAnswers(clarifications, {});
    expect(unanswered.unansweredBlocking.map((item) => item.id)).toEqual(['forest-without-trees']);
    expect(unanswered.resolved).toEqual({});
  });

  it('accepts a valid answer and ignores an invented one', () => {
    const clarifications = detect('غابة بدون أشجار').clarifications;
    const answers: ClarificationAnswers = { 'forest-without-trees': 'keep-trees' };
    expect(resolveWithAnswers(clarifications, answers).unansweredBlocking).toEqual([]);
    expect(resolveWithAnswers(clarifications, answers).resolved['forest-without-trees']).toBe('keep-trees');

    const invented = resolveWithAnswers(clarifications, { 'forest-without-trees': 'burn-it' });
    expect(invented.unansweredBlocking.map((item) => item.id)).toEqual(['forest-without-trees']);
  });

  it('answers advisory questions with their default so generation never stalls', () => {
    const clarifications = detect('غابة وصحراء').clarifications;
    const resolved = resolveWithAnswers(clarifications, {});
    expect(resolved.unansweredBlocking).toEqual([]);
    expect(resolved.resolved['multiple-biomes']).toBe('first-dominant');
  });
});
