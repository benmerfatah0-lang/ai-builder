import { describe, expect, it } from 'vitest';
import { initialMapTraining, loadMapTraining, saveMapTraining, removeMapTraining, applyMapTraining, scoreTrainingMap, trainMapStep } from './mapTrainer';
import { interpretPromptLocally } from './promptInterpreter';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';

function storage() {
  const items = new Map<string, string>();
  return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); }, removeItem: (key: string) => { items.delete(key); } };
}
describe('bounded self-training for map layout densities', () => {
  it('runs synthetic trials deterministically, adopts some improvements and persists them', () => {
    let model = initialMapTraining();
    for (let i = 0; i < 28; i++) model = trainMapStep(model);
    expect(model.attempts).toBe(28);
    expect(model.accepted).toBeGreaterThan(0);
    expect(Object.values(model.weights).every((v) => v >= 0.65 && v <= 1.35)).toBe(true);
    let second = initialMapTraining();
    for (let i = 0; i < 28; i++) second = trainMapStep(second);
    expect(second).toEqual(model);
    const store = storage(); saveMapTraining(store, model);
    expect(loadMapTraining(store)).toEqual(model);
    removeMapTraining(store); expect(loadMapTraining(store)).toEqual(initialMapTraining());
  });
  it('affects general scenes but preserves explicit assets, numbers and farm templates', () => {
    const model = { ...initialMapTraining(), weights: { trees: 1.3, rocks: 0.8, buildings: 1.2 } };
    const general = interpretPromptLocally('forest landscape', { seed: 4 }).intent;
    const changed = applyMapTraining(general, model);
    expect(changed.counts.trees).toBeGreaterThan(general.counts.trees);
    expect(changed.counts.rocks).toBeLessThan(general.counts.rocks);
    expect(generateWorldPlanWithReport(changed).validation.valid).toBe(true);
    for (const prompt of ['forest with 8 trees', 'forest with three trees', 'بيت وشجرة', 'مزرعة قمح']) {
      const intent = interpretPromptLocally(prompt, { seed: 2 }).intent;
      expect(applyMapTraining(intent, model)).toEqual(intent);
    }
  });
  it('pauses safely, rejects corrupt storage, and scores invalid plans badly', () => {
    const paused = { ...initialMapTraining(), enabled: false };
    expect(trainMapStep(paused)).toEqual(paused);
    const store = storage(); store.setItem('world-builder-map-trainer-v1', '{"weights":{"trees":999}}');
    expect(loadMapTraining(store)).toEqual(initialMapTraining());
    const report = generateWorldPlanWithReport(interpretPromptLocally('meadow', { seed: 3 }).intent);
    expect(scoreTrainingMap({ ...report, validation: { ...report.validation, valid: false } })).toBe(-100);
    expect(() => saveMapTraining({ setItem() { throw new Error('full'); } }, paused)).toThrow('full');
  });
});
