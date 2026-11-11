import { describe, expect, it } from 'vitest';
import { hasExplicitColor, matchHouseApproximation, matchReferenceApproximation } from './referenceUnderstanding';
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
  it('only accepts one complete dictionary noun sense for an approximate house', () => {
    const entry = { language: 'fr' as const, partOfSpeech: 'Noun', definition: 'A small house.' };
    const dictionaryTopic = { ...topic, term: 'cabane', articles: [], dictionary: { entries: [entry], complete: true } };
    const report = { topics: [dictionaryTopic], truncated: false };
    expect(matchHouseApproximation('ajoute une cabane', report)?.rewritten).toBe('ajoute une بيت');
    expect(matchHouseApproximation('add cabane', report)?.sourceKind).toBe('dictionary');
    expect(matchHouseApproximation('add cabane', { ...report, topics: [{ ...dictionaryTopic, dictionary: { entries: [entry, { ...entry, definition: 'A place.' }], complete: true } }] })).toBeNull();
    expect(matchHouseApproximation('add cabane', { ...report, topics: [{ ...dictionaryTopic, dictionary: { entries: [entry], complete: false } }] })).toBeNull();
    expect(matchHouseApproximation('add cabane', { ...report, topics: [{ ...dictionaryTopic, dictionary: { entries: [{ ...entry, definition: 'A person in a small house.' }], complete: true } }] })).toBeNull();
    expect(matchHouseApproximation('add cabane', { ...report, topics: [{ ...dictionaryTopic, dictionary: { entries: [{ ...entry, partOfSpeech: 'Verb' }], complete: true } }] })).toBeNull();
  });

  it('maps an exact affirmative definition to a broad existing asset when no images were found', () => {
    const examples = [
      ['باوباب', 'الباوباب هي شجرة ضخمة', 'tree'],
      ['منارة', 'المنارة هي برج لإرشاد السفن', 'tower'],
      ['قنطرة', 'القنطرة هي جسر فوق نهر', 'bridge'],
      ['حصاة', 'الحصاة هي صخرة صغيرة', 'boulder'],
      ['خرزة', 'الخرزة هي كرة صغيرة', 'sphere'],
      ['beacon', 'A beacon is a tower used for navigation', 'tower'],
    ] as const;
    for (const [term, content, id] of examples) {
      const report = {topics:[{term, articles:[{title:term,url:'https://ar.wikipedia.org/wiki/x',content}], images:[], wikiError:null,imageError:null}],truncated:false};
      const match = matchReferenceApproximation(`أضف ${term}`, report);
      expect(match?.assetId, term).toBe(id);
      expect(parseAssetRequests(match!.rewritten, true)?.[0]?.assetId).toBe(id);
    }
  });
  it('refuses wrong titles, negation, polysemy, conflicting evidence, available images and unrelated definitions', () => {
    const base = {term:'باوباب',articles:[{title:'باوباب',url:'https://ar.wikipedia.org/wiki/x',content:'الباوباب هي شجرة كبيرة'}],images:[],wikiError:null,imageError:null};
    const lookup = (item: typeof base | (typeof base & {dictionary: {entries: {language:'en';partOfSpeech:string;definition:string}[];complete:boolean}})) => matchReferenceApproximation('أضف باوباب', {topics:[item], truncated:false});
    expect(lookup({...base,articles:[{...base.articles[0]!,title:'آخر'}]})).toBeNull();
    expect(lookup({...base,articles:[{...base.articles[0]!,content:'الباوباب ليست شجرة'}]})).toBeNull();
    expect(lookup({...base,articles:[{...base.articles[0]!,content:'الباوباب تعيش قرب شجرة'}]})).toBeNull();
    expect(lookup({...base,dictionary:{entries:[{language:'en',partOfSpeech:'Noun',definition:'A rock.'}],complete:true}})).toBeNull();
    expect(matchReferenceApproximation('أضف باوباب', {topics:[{...base,images:[{title:'File:x.jpg',url:'https://commons.wikimedia.org/wiki/File:x.jpg',thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/240px-x.jpg',author:'a',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0',query:'x'}]}],truncated:false})).toBeNull();
    expect(matchReferenceApproximation('شجرة وباوباب', {topics:[base],truncated:false})).toBeNull();
  });

});
