import { describe, expect, it } from 'vitest';
import { planPhotoRequests } from './photoRequests';
import { unknownTopics } from './unknownResearch';
import type { TopicResearch } from './unknownResearch';
const topic = (term: string): TopicResearch => ({ term, articles:[], images: [{ title: 'File:X.png', url:'https://commons.wikimedia.org/wiki/File:X.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.png/240px-X.png', author:'a', license_name:'CC BY 4.0', license_url:'https://creativecommons.org/licenses/by/4.0/', query:term }], wikiError:null, imageError:null });
describe('multiple photo requests', () => {
  it('plans distinct unknowns and explicit counts, without inventing a count for another item', () => {
    const text='بيت و 3 فيل و2 زرافة وطائر';
    expect(unknownTopics(text).terms).toEqual(['فيل','زرافة','طائر']);
    const plan=planPhotoRequests(text,['فيل','زرافة','طائر'].map(topic));
    expect(plan.requests.map((item) => [item.topic.term, item.count])).toEqual([['فيل',3],['زرافة',2],['طائر',1]]);
    expect(plan.warnings).toEqual([]);
  });
  it('refuses unsupported relations, sizes, ambiguous counts, repeated references and missing images', () => {
    expect(planPhotoRequests('بيت وفيل يمين شجرة',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('فيل كبير',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('فيل 3',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('فيل وفيل',[topic('فيل')]).requests).toEqual([]);
    const none={ ...topic('فيل'), images:[] };
    expect(planPhotoRequests('فيل',[none]).warnings.join()).toContain('لم أجد صوراً');
    expect(planPhotoRequests('فيلين',[topic('فيلين')]).requests).toEqual([]);
  });
  it('plans a clear relation to one known object, and refuses reversed or ambiguous relations', () => {
    expect(planPhotoRequests('فيل يمين البيت',[topic('فيل')]).requests[0]?.relation).toEqual({ assetId:'house', direction:'right' });
    expect(planPhotoRequests('بيت يمين فيل',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('فيل بين البيت وشجرة',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('1000 فيل',[topic('فيل')]).requests).toEqual([]);
    expect(planPhotoRequests('big elephant',[topic('elephant')]).requests).toEqual([]);
  });
  it('does not drop unknown topics beyond 400 characters', () => {
    const text = 'بيت '.repeat(110) + 'وفيل وزرافة';
    expect(unknownTopics(text).terms).toEqual(['فيل','زرافة']);
  });
});
