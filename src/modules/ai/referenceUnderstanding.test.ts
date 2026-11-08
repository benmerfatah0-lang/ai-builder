import { describe, expect, it } from 'vitest';
import { hasExplicitColor, matchHouseApproximation } from './referenceUnderstanding';
import { parseAssetRequests } from './assetRequests';
import { interpretPromptLocally } from './promptInterpreter';
import { generateWorldPlanWithReport } from '../../core/generation/generateWorld';
const topic = { term: 'كوخ', articles: [{ title: 'كوخ', url: 'https://ar.wikipedia.org/wiki/كوخ', content: 'الكوخ هو منزل صغير.' }], images: [], wikiError: null, imageError: null };
describe('narrow Wikipedia-to-house approximation', () => {
  it('maps an exact subject with an explicit definition and preserves a count and reference', () => {
    const match = matchHouseApproximation('٢ كوخ يمين شجرة', { topics: [topic], truncated: false })!;
    const requests = parseAssetRequests(match.rewritten, true)!;
    expect(requests[0]?.assetId).toBe('house'); expect(requests[0]?.count).toBe(2);
    expect(requests[0]?.relation?.direction).toBe('right');
    const intent = interpretPromptLocally('٢ كوخ يمين شجرة', { seed: 16 }).intent;
    intent.assets = requests.map((item) => item.assetId === 'house' ? { ...item, referenceColor: '#a04020' } : item);
    const result = generateWorldPlanWithReport(intent);
    expect(result.validation.valid).toBe(true);
    const houses = result.plan.objects.filter((object) => object.kind === 'building' && object.variant === 'house');
    expect(houses).toHaveLength(2);
    expect(houses.every((object) => object.kind === 'building' && object.color === '#a04020')).toBe(true);
  });
  it('never infers from mismatched, ambiguous or non-defining text', () => {
    expect(matchHouseApproximation('كوخ', { topics: [{ ...topic, articles: [{ ...topic.articles[0]!, title: 'بيوت' }] }], truncated: false })).toBeNull();
    expect(matchHouseApproximation('فيل', { topics: [{ ...topic, term: 'فيل', articles: [{ ...topic.articles[0]!, title: 'فيل', content: 'فيل يعيش قرب منزل' }] }], truncated: false })).toBeNull();
    expect(matchHouseApproximation('كوخ', { topics: [{ ...topic, articles: [{ ...topic.articles[0]!, content: 'الكوخ ليس هو منزل.' }] }], truncated: false })).toBeNull();
    expect(hasExplicitColor('كوخ أحمر')).toBe(true);
    expect(matchHouseApproximation('بيت وكوخ', { topics: [topic], truncated: false })).toBeNull();
    expect(matchHouseApproximation('كوخ', { topics: [topic], truncated: true })).toBeNull();
    expect(matchHouseApproximation('كوخ', { topics: [topic, topic], truncated: false })).toBeNull();
  });
});
