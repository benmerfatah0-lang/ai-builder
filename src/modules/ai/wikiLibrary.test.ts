import { describe, expect, it } from 'vitest';
import { applySavedWikiArticle, readWikiLibrary, removeWikiArticle, safeWikiUrl, saveWikiArticle, WIKI_LIBRARY_KEY, WIKI_LIBRARY_LIMIT } from './wikiLibrary';
import { interpretPromptLocally } from './promptInterpreter';

function storage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, setItem: (key, value) => { data.set(key, value); } };
}
const source = { title: 'واحة', url: 'https://ar.wikipedia.org/wiki/واحة', content: 'الواحة منطقة في الصحراء.' };

describe('user-selected Wikipedia notebook', () => {
  it('saves, updates, limits and deletes references locally', () => {
    const local = storage();
    saveWikiArticle(local, source);
    saveWikiArticle(local, { ...source, content: 'صحراء' });
    expect(readWikiLibrary(local)).toEqual([{ ...source, content: 'صحراء' }]);
    for (let i = 0; i < WIKI_LIBRARY_LIMIT; i++) saveWikiArticle(local, { ...source, url: `https://en.wikipedia.org/wiki/Article_${i}`, title: `Article ${i}` });
    expect(readWikiLibrary(local)).toHaveLength(WIKI_LIBRARY_LIMIT);
    expect(readWikiLibrary(local).some((item) => item.url === source.url)).toBe(false);
    expect(removeWikiArticle(local, 'https://en.wikipedia.org/wiki/Article_0')).toHaveLength(WIKI_LIBRARY_LIMIT - 1);
  });
  it('rejects unsafe sources and does not overwrite corrupt local storage', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.com/wiki/a', 'https://ar.wikipedia.org.evil.com/wiki/a', 'https://ar.wikipedia.org:8443/wiki/a', 'https://user@ar.wikipedia.org/wiki/a', 'https://ar.wikipedia.org/wiki/a?x=1']) expect(safeWikiUrl(url)).toBe(false);
    const local = storage(); local.setItem(WIKI_LIBRARY_KEY, '{bad');
    expect(() => saveWikiArticle(local, source)).toThrow();
    expect(local.getItem(WIKI_LIBRARY_KEY)).toBe('{bad');
  });
  it('applies a single unambiguous terrain hint without changing the requested assets or explicit biome', () => {
    const original = interpretPromptLocally('بيت و 3 شجرات', { seed: 17 }).intent;
    const inferred = applySavedWikiArticle(original, source);
    expect(inferred.intent.biome).toBe('desert');
    expect(inferred.intent.summary).toContain('Desert');
    expect(inferred.intent.assets).toEqual(original.assets);
    expect(inferred.intent.counts).toEqual(original.counts);
    expect(inferred.intent.seed).toBe(17);
    expect(applySavedWikiArticle(interpretPromptLocally('بيت في غابة').intent, source).intent.biome).toBe('forest');
    expect(applySavedWikiArticle(interpretPromptLocally('بيت في مرج').intent, source).intent.biome).toBe('meadow');
    expect(applySavedWikiArticle(original, { ...source, content: 'صحراء وجبال' }).intent.biome).toBe('meadow');
    expect(applySavedWikiArticle(original, { ...source, title: 'قلعة', content: 'بناء تاريخي' }).intent.biome).toBe('meadow');
  });
});
