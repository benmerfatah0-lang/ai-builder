import { describe, expect, it } from 'vitest';
import { applyWikiArticleHint, safeWikiUrl } from './wikiReference';
import { interpretPromptLocally } from './promptInterpreter';
const source = { title: 'واحة', url: 'https://ar.wikipedia.org/wiki/واحة', content: 'الواحة منطقة في الصحراء.' };
describe('Wikipedia reference hints', () => {
  it('rejects unsafe source links', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.com/wiki/a', 'https://ar.wikipedia.org.evil.com/wiki/a', 'https://ar.wikipedia.org:8443/wiki/a', 'https://user@ar.wikipedia.org/wiki/a', 'https://ar.wikipedia.org/wiki/a?x=1']) expect(safeWikiUrl(url)).toBe(false);
  });
  it('uses a single terrain hint without changing explicit biomes or requested assets', () => {
    const original = interpretPromptLocally('بيت و 3 شجرات', { seed: 17 }).intent;
    const inferred = applyWikiArticleHint(original, source);
    expect(inferred.intent.biome).toBe('desert');
    expect(inferred.intent.summary).toContain('Desert');
    expect(inferred.intent.assets).toEqual(original.assets);
    expect(inferred.intent.counts).toEqual(original.counts);
    expect(inferred.intent.seed).toBe(17);
    expect(applyWikiArticleHint(interpretPromptLocally('بيت في غابة').intent, source).intent.biome).toBe('forest');
    expect(applyWikiArticleHint(interpretPromptLocally('بيت في مرج').intent, source).intent.biome).toBe('meadow');
    expect(applyWikiArticleHint(original, { ...source, content: 'صحراء وجبال' }).intent.biome).toBe('meadow');
    expect(applyWikiArticleHint(original, { ...source, title: 'قلعة', content: 'بناء تاريخي' }).intent.biome).toBe('meadow');
  });
});
