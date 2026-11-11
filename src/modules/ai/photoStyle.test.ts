import { describe, expect, it } from 'vitest';
import { photoStyleForTopic } from './photoStyle';
import { unknownTopics, type TopicResearch } from './unknownResearch';
import { planPhotoRequests } from './photoRequests';
const topic = (term:string):TopicResearch => ({ term, articles:[], images:[{title:'File:x.jpg',url:'https://commons.wikimedia.org/wiki/File:x.jpg',thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/x.jpg/250px-x.jpg',author:'a',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0',query:term}],wikiError:null,imageError:null });
describe('photo mesh style in descriptions', () => {
  it.each([['فيل ناعم','smooth'],['فيل سموث','smooth'],['فيل بكسلي','blocky'],['فيل بالبكسلات','blocky'],['voxel elephant','blocky'],['فيل بدون بكسلات','smooth'],['فيل','smooth']] as const)('reads %s', (prompt,style) => {
    const name=prompt.includes('elephant')?'elephant':'فيل';
    expect(unknownTopics(prompt).terms).toEqual([name]);
    expect(planPhotoRequests(prompt,[topic(name)]).requests[0]?.meshStyle).toBe(style);
  });
  it('handles separate styles and flags a contradictory single-subject request', () => {
    const prompt='عالم فيه فيل ناعم وزرافة بكسلية';
    expect(unknownTopics(prompt).terms).toEqual(['فيل','زرافة']);
    expect(planPhotoRequests(prompt,[topic('فيل'),topic('زرافة')]).requests.map((x)=>x.meshStyle)).toEqual(['smooth','blocky']);
    expect(photoStyleForTopic('فيل بكسلي وزرافة بدون بكسلات','فيل',2)).toBe('blocky');
    expect(unknownTopics('فيل بدون بكسلات وزرافة').terms).toEqual(['فيل','زرافة']);
    expect(unknownTopics('مجسم فيل ثلاثي الأبعاد ناعم').terms).toEqual(['فيل']);
    const conflict=planPhotoRequests('فيل ناعم بكسلي',[topic('فيل')]);
    expect(conflict.requests).toHaveLength(0); expect(conflict.warnings.join()).toMatch(/متعارض/);
  });
});
