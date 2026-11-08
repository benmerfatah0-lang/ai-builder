import { describe, expect, it } from 'vitest';
import { classifyTopic, explicitTopicKind } from './topicClassification';
import { planPhotoRequests } from './photoRequests';
import { unknownTopics } from './unknownResearch';
import type { TopicResearch } from './unknownResearch';
const topic = (term:string, content:string): TopicResearch => ({ term, articles:[{ title:term, url:'https://ar.wikipedia.org/wiki/x', content }], images:[{ title:'File:x.jpg', url:'https://commons.wikimedia.org/wiki/File:x.jpg', thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/250px-x.jpg',author:'a',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0',query:term }], wikiError:null, imageError:null });
describe('conservative research category routing', () => {
  it.each([
    ['بركان','البركان هو جبل ذو فوهة.','terrain'],
    ['تندرا','التندرا هي منطقة حيوية باردة.','biome'],
    ['زعتر','الزعتر هو نبات عشبي معمر.','grass'],
    ['بحيرة تانا','بحيرة تانا هي بحيرة في أفريقيا.','water'],
    ['كابيبارا','الكابيبارا هي حيوان من القوارض.','animal'],
    ['أكروبول','الأكروبول هو مبنى قديم.','structure'],
  ] as const)('classifies %s from the exact definition', (term, content, kind) => {
    const item=topic(term,content); expect(classifyTopic(item).kind).toBe(kind);
    expect(planPhotoRequests(`أضف ${term}`, [item]).requests.length).toBe(kind === 'animal' || kind === 'structure' ? 1 : 0);
  });
  it('does not mistake unrelated mentions and nonmatching articles for a definition', () => {
    const item=topic('كابيبارا','الكابيبارا تعيش قرب بحيرة وعلى جبل.');
    expect(classifyTopic(item).kind).toBe('unknown');
    expect(classifyTopic({...item, articles:[{...item.articles[0]!,title:'آخر',content:'الآخر هو جبل.'}]}).kind).toBe('unknown');
    expect(classifyTopic(topic('بركان','البركان ليس جبلاً.')).kind).toBe('unknown');
    expect(classifyTopic(topic('بركان','البركان هو فتحة في القشرة الأرضية.'))).toMatchObject({kind:'terrain',biome:'mountains'});
  });
  it('respects an explicit category next to one unknown topic, not unrelated or multiple subjects', () => {
    expect(unknownTopics('أضف تضاريس فوهة بركانية').terms).toEqual([]);
    expect(unknownTopics('أضف تضاريس كالديرا').terms).toEqual(['كالديرا']);
    expect(explicitTopicKind('أضف تضاريس فوهة بركانية','فوهة بركانيه',1)).toBe('terrain');
    expect(explicitTopicKind('أضف فيل في تضاريس','فيل',1)).toBeUndefined();
    expect(explicitTopicKind('أضف تضاريس فوهة','فوهة',2)).toBeUndefined();
  });
  it('uses only a single complete dictionary noun meaning, never a truncated or multiple meaning', () => {
    const base={...topic('tundra',''),articles:[]};
    const entry={language:'en' as const,partOfSpeech:'Noun',definition:'a biome of cold treeless plains'};
    const single={...base,dictionary:{entries:[entry],complete:true}};
    expect(classifyTopic(single)).toMatchObject({kind:'biome',source:{url:'https://en.wiktionary.org/wiki/tundra'}});
    expect(classifyTopic({...single,dictionary:{entries:[entry],complete:false}}).kind).toBe('unknown');
    expect(classifyTopic({...single,dictionary:{entries:[entry,entry],complete:true}}).kind).toBe('unknown');
  });

});
