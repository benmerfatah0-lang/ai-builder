import { describe, expect, it } from 'vitest';
import { LEXICON, entriesIn, labelFor, lexiconEntry, unrealizableIds } from './lexicon';
import { normalizePlannerText, scanTerms } from './normalize';

describe('lexicon', () => {
  it('keeps ids unique and every entry reachable by at least one term', () => {
    const ids = LEXICON.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of LEXICON) {
      expect(entry.ar.length + entry.en.length).toBeGreaterThan(0);
      expect(lexiconEntry(entry.id)).toBe(entry);
    }
    expect(lexiconEntry('not-a-thing')).toBeUndefined();
  });

  it('groups entries by category', () => {
    expect(entriesIn('animal').length).toBeGreaterThan(3);
    expect(entriesIn('material').every((entry) => entry.category === 'material')).toBe(true);
    expect(entriesIn('biome').map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['meadow', 'forest', 'mountains', 'desert', 'island', 'ruins']),
    );
  });

  it('labels entries in Arabic first, and falls back to the id', () => {
    expect(labelFor('castle')).toBe('قلعة');
    expect(labelFor('lake')).toBe('بحيرة');
    expect(labelFor('missing-entry')).toBe('missing-entry');
  });

  it('marks animals as known but not buildable locally', () => {
    const unrealizable = unrealizableIds();
    expect(unrealizable).toContain('deer');
    expect(unrealizable.every((id) => lexiconEntry(id)?.unrealizable === true)).toBe(true);
    expect(unrealizable).not.toContain('castle');
  });

  it('carries generation hints on the entries that need them', () => {
    expect(lexiconEntry('forest')?.biome).toBe('forest');
    expect(lexiconEntry('mountain-terrain')?.terrain).toBe('mountains');
    expect(lexiconEntry('house')?.assetId).toBe('house');
    expect(lexiconEntry('large-world')?.scale).toBe('large');
    expect(lexiconEntry('night')?.time).toBe('night');
    expect(lexiconEntry('dense')?.density).toBe('dense');
  });
});

describe('lexicon surface forms', () => {
  const ids = (text: string) => scanTerms(normalizePlannerText(text)).map((match) => match.entry.id);

  it('matches the Arabic forms people actually type', () => {
    expect(ids('قلعة')).toContain('castle');
    expect(ids('قلاع')).toContain('castle');
    expect(ids('بيوت')).toContain('house');
    expect(ids('منازل')).toContain('house');
    expect(ids('آبار')).toContain('well');
    expect(ids('أبراج مراقبة')).toContain('watchtower');
    expect(ids('بحيرة')).toContain('lake');
    expect(ids('واحة')).toContain('oasis');
  });

  it('matches English singular, plural and multi-word terms', () => {
    expect(ids('a castle')).toContain('castle');
    expect(ids('two castles')).toContain('castle');
    expect(ids('pine forest')).toContain('forest');
    expect(ids('watch tower')).toContain('watchtower');
    expect(ids('stone arch')).toContain('stone-arch');
  });

  it('treats "stone" as a material, not as a boulder', () => {
    expect(ids('stone houses')).toEqual(expect.arrayContaining(['stone-mat', 'house']));
    expect(ids('stone houses')).not.toContain('rock');
    expect(ids('some rocks')).toContain('rock');
  });

  it('generates feminine adjective variants for materials and styles', () => {
    expect(ids('قلعة حجرية')).toContain('stone-mat');
    expect(ids('بيوت خشبية')).toContain('wood-mat');
    expect(ids('أسقف قرميدية')).toContain('brick-mat');
    expect(ids('مدينة قروسطية')).toContain('medieval');
  });
});
