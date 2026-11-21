import { describe, expect, it } from 'vitest';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';
import { interpretPromptLocally } from './promptInterpreter';
import { initialShapeModel } from './shapeLearner';
import { applyHouseKnowledge, parseHouseKnowledge } from './houseKnowledge';

const profile = (count = 0, mean = [1, 1, 1, 1]) => ({ count, mean });
const source = { title: 'File:Small house.png', author: 'An artist', url: 'https://commons.wikimedia.org/wiki/File:Small_house.png', license_url: 'https://creativecommons.org/licenses/by/4.0/' };
const knowledge = () => ({ version: 1, cursor: 1, samples: 1, status: 'learning', last_loss: 15, sources: [source], profiles: { default: profile(), small: profile(1, [1.6, .6, 1.5, 1.2]), tall: profile(), wide: profile() } });

describe('experimental Commons house fits', () => {
  it('validates all sources, counts and finite bounded dimensions', () => {
    expect(parseHouseKnowledge(knowledge())).not.toBeNull();
    expect(parseHouseKnowledge({ ...knowledge(), sources: [{ ...source, url: 'https://evil.example/wiki/File:x' }] })).toBeNull();
    expect(parseHouseKnowledge({ ...knowledge(), sources: [{ ...source, license_url: 'javascript:alert(1)' }] })).toBeNull();
    expect(parseHouseKnowledge({ ...knowledge(), samples: 2 })).toBeNull();
    expect(parseHouseKnowledge({ ...knowledge(), profiles: { ...knowledge().profiles, small: profile(1, [NaN, 1, 1, 1]) } })).toBeNull();
  });
  it('merges with personal training and changes generated house dimensions, without changing other categories', () => {
    const model = initialShapeModel();
    const snapshot = structuredClone(model);
    const fitted = applyHouseKnowledge(model, parseHouseKnowledge(knowledge())!, 'بيت صغير');
    expect(model).toEqual(snapshot);
    expect(fitted.tree).toEqual(model.tree);
    expect(fitted.rock).toEqual(model.rock);
    expect(fitted.house.mean[0]).toBeGreaterThan(model.house.mean[0]);
    const intent = interpretPromptLocally('بيت صغير', { seed: 44 }).intent;
    const before = generateWorldPlanWithReport({ ...intent, shapeModel: model }).plan.objects[0]!;
    const after = generateWorldPlanWithReport({ ...intent, shapeModel: fitted }).plan.objects[0]!;
    expect(after.transform.scale[0]).toBeGreaterThan(before.transform.scale[0]);
    expect(applyHouseKnowledge(model, parseHouseKnowledge(knowledge())!, 'بيت').house.mean[0]).toBeGreaterThan(model.house.mean[0]);
    const empty = { ...knowledge(), samples: 0, sources: [], profiles: { default: profile(), small: profile(), tall: profile(), wide: profile() } };
    expect(applyHouseKnowledge(model, parseHouseKnowledge(empty)!, 'بيت')).toBe(model);
  });
});
