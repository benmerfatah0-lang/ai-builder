import { describe, expect, it, vi, afterEach } from 'vitest';
import { dictionaryPage, isDictionaryWord } from './dictionary';
import { lookupDictionary } from './onlineInterpreter';

afterEach(() => vi.unstubAllGlobals());
describe('bounded multilingual dictionary', () => {
  it('looks up one word and validates languages and the generated source link', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ entries: [
      { language: 'ar', partOfSpeech: 'Noun', definition: 'A house.' },
      { language: 'fr', partOfSpeech: 'Noun', definition: 'house' },
      { language: 'en', partOfSpeech: 'Noun', definition: 'A house.' },
    ], complete: true })));
    vi.stubGlobal('fetch', fetchMock);
    const result = await lookupDictionary('maison');
    expect(result.entries.map((item) => item.language)).toEqual(['ar', 'fr', 'en']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/dictionary');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).query).toBe('maison');
    expect(dictionaryPage('بيت')).toBe('https://en.wiktionary.org/wiki/%D8%A8%D9%8A%D8%AA');
    expect(isDictionaryWord('château')).toBe(true);
    for (const bad of ['two words', 'https://evil.org', '../x', 'a'.repeat(81)]) expect(isDictionaryWord(bad)).toBe(false);
    await expect(lookupDictionary('../x')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed data and explains network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"entries":[{"language":"de"}],"complete":true}')).mockResolvedValueOnce(new Response('', { status: 502 })));
    await expect(lookupDictionary('cabin')).rejects.toThrow('بيانات غير صالحة');
    await expect(lookupDictionary('cabin')).rejects.toThrow('تعذّر الاتصال بقاموس');
  });
});
