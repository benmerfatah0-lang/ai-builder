import { describe, expect, it } from 'vitest';
import {
  MAX_PARSED_COUNT,
  detectLanguage,
  globalNegations,
  isNegated,
  normalizePlannerText,
  parseNumberFromTokens,
  quantityHint,
  refineNegations,
  scanTerms,
  tokenize,
  withdrawnNegations,
} from './normalize';

describe('normalizePlannerText', () => {
  it('folds the Arabic spellings users actually type', () => {
    // ة is deliberately kept: the lexicon lists both ة and ه spellings.
    expect(normalizePlannerText('قَريةٌ')).toBe('قرية');
    expect(normalizePlannerText('شُجرة')).toBe('شجرة');
    expect(normalizePlannerText('بئر')).toBe('بير');
    expect(normalizePlannerText('سماء')).toBe('سما');
    expect(normalizePlannerText('شاطئ')).toBe('شاطي');
    expect(normalizePlannerText('جزء')).toBe('جز');
    expect(normalizePlannerText('غــــــــابة')).toBe('غابة');
    expect(normalizePlannerText('آثار وأطلال')).toBe('اثار واطلال');
  });

  it('converts Arabic-Indic digits and folds case and whitespace', () => {
    expect(normalizePlannerText('١٢ شجرة')).toBe('12 شجرة');
    expect(normalizePlannerText('۳ خانه')).toBe('3 خانه');
    expect(normalizePlannerText('  Pine   Forest ')).toBe('pine forest');
  });
});

describe('tokenize', () => {
  it('keeps offsets into the normalized text', () => {
    const tokens = tokenize('قلعة فوق جبل');
    expect(tokens.map((token) => token.text)).toEqual(['قلعة', 'فوق', 'جبل']);
    expect(tokens[0]).toMatchObject({ start: 0, end: 4 });
    expect(normalizePlannerText('قلعة فوق جبل').slice(tokens[2]!.start, tokens[2]!.end)).toBe('جبل');
  });
});

describe('detectLanguage', () => {
  it('separates Arabic, English and mixed descriptions', () => {
    expect(detectLanguage('قرية تحيط ببحيرة')).toBe('ar');
    expect(detectLanguage('a village around a lake')).toBe('en');
    expect(detectLanguage('قرية village حول بحيرة')).toBe('mixed');
  });
});

describe('parseNumberFromTokens', () => {
  it('reads digits, Arabic-Indic digits, words and compounds', () => {
    expect(parseNumberFromTokens(['7'])).toBe(7);
    // Digits reach the parser already normalized, as `tokenize` produces them.
    expect(parseNumberFromTokens(tokenize(normalizePlannerText('٧ شجرة')).map((token) => token.text).slice(0, 1))).toBe(7);
    expect(parseNumberFromTokens(['seven'])).toBe(7);
    expect(parseNumberFromTokens(['سبعة'])).toBe(7);
    expect(parseNumberFromTokens(['عشرين'])).toBe(20);
    expect(parseNumberFromTokens(['five', 'hundred'])).toBe(500);
    expect(parseNumberFromTokens(['two', 'dozen'])).toBe(24);
    expect(parseNumberFromTokens(['a', 'couple', 'of'])).toBe(2);
  });

  it('caps absurd numbers and ignores plain words', () => {
    expect(parseNumberFromTokens(['999999'])).toBe(MAX_PARSED_COUNT);
    expect(parseNumberFromTokens(['castle'])).toBeUndefined();
    expect(parseNumberFromTokens([])).toBeUndefined();
  });
});

describe('scanTerms', () => {
  it('matches Arabic prefixes and prefers the longest term', () => {
    const text = normalizePlannerText('الغابة والصنوبر في الجبال');
    const ids = scanTerms(text).map((match) => match.entry.id);
    expect(ids).toContain('forest');
    expect(ids).toContain('pine');
    expect(ids).toContain('mountains');
    // "pine forest" wins over "forest" where both would match.
    expect(scanTerms(normalizePlannerText('pine forest')).map((match) => match.entry.id)).toContain('forest');
  });

  it('matches English plurals without overlapping matches', () => {
    const matches = scanTerms(normalizePlannerText('two castles and three houses'));
    expect(matches.map((match) => match.entry.id)).toEqual(['castle', 'house']);
    expect(matches.every((match, index) => index === 0 || match.start >= matches[index - 1]!.end)).toBe(true);
  });

  it('recognises feminine material adjectives', () => {
    expect(scanTerms(normalizePlannerText('قلعة حجرية')).map((match) => match.entry.id)).toContain('stone-mat');
    expect(scanTerms(normalizePlannerText('بيوت خشبية')).map((match) => match.entry.id)).toContain('wood-mat');
  });
});

describe('negation', () => {
  it('detects a marker directly before a term', () => {
    const text = normalizePlannerText('غابة بدون أشجار');
    const trees = scanTerms(text).find((match) => match.entry.id === 'tree')!;
    expect(isNegated(text, 0, trees.start)).toBe(true);
    const english = normalizePlannerText('forest without trees');
    const englishTrees = scanTerms(english).find((match) => match.entry.id === 'tree')!;
    expect(isNegated(english, 0, englishTrees.start)).toBe(true);
    expect(isNegated(english, 0, english.indexOf('without'))).toBe(false);
  });

  it('collects globally negated terms from a phrase', () => {
    expect(globalNegations(normalizePlannerText('عالم بدون ماء وأشجار'))).toEqual(expect.arrayContaining(['water', 'tree']));
    expect(globalNegations(normalizePlannerText('no rivers, no bridges'))).toEqual(expect.arrayContaining(['river', 'bridge']));
    expect(globalNegations(normalizePlannerText('قرية هادئة'))).toEqual([]);
  });

  it('narrows a negation to the species the phrase actually named', () => {
    // "بدون أشجار نخيل" excludes palms, not every tree.
    expect(refineNegations(['tree', 'palm'])).toEqual(['palm']);
    expect(withdrawnNegations(['tree', 'palm'])).toEqual(['tree']);
    expect(refineNegations(['tree'])).toEqual(['tree']);
    expect(refineNegations(['water', 'lake'])).toEqual(['water', 'lake']);
    expect(globalNegations(normalizePlannerText('غابة بدون أشجار نخيل'))).toEqual(['palm']);
    expect(globalNegations(normalizePlannerText('غابة بدون أشجار'))).toEqual(['tree']);
  });
});

describe('quantityHint', () => {
  it('reads vague quantities on both sides of a term', () => {
    const many = normalizePlannerText('عشرات الأشجار');
    const manyMatch = scanTerms(many).find((match) => match.entry.id === 'tree')!;
    expect(quantityHint(many, manyMatch.start, manyMatch.end)).toBe('many');

    const some = normalizePlannerText('بعض البيوت');
    const someMatch = scanTerms(some).find((match) => match.entry.id === 'house')!;
    expect(quantityHint(some, someMatch.start, someMatch.end)).toBe('some');

    const plain = normalizePlannerText('بيت');
    const plainMatch = scanTerms(plain)[0]!;
    expect(quantityHint(plain, plainMatch.start, plainMatch.end)).toBeUndefined();
  });
});
