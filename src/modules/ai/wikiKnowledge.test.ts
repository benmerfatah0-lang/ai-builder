import { describe, expect, it } from 'vitest';
import { applyWikiKnowledge, summarizeKnowledge } from './wikiKnowledge';
import { interpretPromptLocally } from './promptInterpreter';
const payload = {
  version: 1, cursor: 1, status: 'learning',
  classes: { desert: { docs: 1, tokens: { 'واحات': 1, oasis: 1 } }, forest: { docs: 0, tokens: {} },
    mountains: { docs: 0, tokens: {} }, island: { docs: 0, tokens: {} } },
  sources: [{ label: 'desert', title: 'واحة', url: 'https://ar.wikipedia.org/wiki/واحة' }],
};
describe('learned Wikipedia vocabulary', () => {
  it('uses learned associations for an otherwise unknown word without losing assets or seed', () => {
    const data = summarizeKnowledge(payload)!;
    const original = interpretPromptLocally('بيت في الواحات', { seed: 17 }).intent;
    expect(original.biome).toBe('meadow');
    const updated = applyWikiKnowledge(original, data);
    expect(updated.used).toBe(true);
    expect(updated.intent.biome).toBe('desert');
    expect(updated.intent.assets).toEqual(original.assets);
    expect(updated.intent.seed).toBe(17);
    expect(updated.intent.prompt).toBe('بيت في الواحات');
  });
  it('does not override an explicit biome, or a farm', () => {
    const data = summarizeKnowledge(payload)!;
    for (const text of ['بيت في الغابة بالقرب من الواحات', 'مزرعة في الواحات', 'مرج قرب الواحات']) {
      const intent = interpretPromptLocally(text, { seed: 1 }).intent;
      expect(applyWikiKnowledge(intent, data).used).toBe(false);
    }
  });
  it('rejects unsafe links and arbitrary learned tokens', () => {
    expect(summarizeKnowledge({ ...payload, sources: [{ ...payload.sources[0], url: 'https://evil.example/wiki/x' }] })).toBeNull();
    expect(summarizeKnowledge({ ...payload, classes: { ...payload.classes, desert: { docs: 1, tokens: { malware: 1 } } } })).toBeNull();
  });
});
