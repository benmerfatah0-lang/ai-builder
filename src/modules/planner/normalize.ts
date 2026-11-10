import { normalizeAssetText, parseCountToken } from '../ai/assetRequests';
import { LEXICON, type LexiconEntry } from './lexicon';

/**
 * Text normalization, tokenizing and number parsing for the planner.
 *
 * Everything here is deterministic and dependency-free. The legacy helpers in
 * `assetRequests.ts` stay authoritative for the existing generators; this module
 * only *widens* them (more numerals, more spelling variants) for planner use.
 */

/** Superset of `normalizeAssetText`: also folds ؤ/ئ/ء, tatweel and whitespace. */
export function normalizePlannerText(text: string): string {
  return normalizeAssetText(text)
    .replace(/\u0640/g, '')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ء/g, '')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Token {
  text: string;
  start: number;
  end: number;
}

/** Word tokens over normalized text, keeping offsets into that normalized text. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (match.index === undefined) continue;
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

export function isArabic(text: string): boolean {
  return /[\u0600-\u06ff]/.test(text);
}

export type DescriptionLanguage = 'ar' | 'en' | 'mixed';

export function detectLanguage(text: string): DescriptionLanguage {
  const arabic = (text.match(/[\u0600-\u06ff]/gu) ?? []).length;
  const latin = (text.match(/[a-z]/giu) ?? []).length;
  if (arabic && latin) return 'mixed';
  return arabic ? 'ar' : 'en';
}

// ── Numbers ──────────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  a: 1, an: 1, couple: 2, few: 3, several: 4, dozen: 12,
  واحد: 1, واحدة: 1, واحده: 1, اثنين: 2, اثنان: 2, اثنتين: 2, ثنائي: 2,
  ثلاث: 3, ثلاثة: 3, ثلاثه: 3, اربع: 4, اربعة: 4, اربعه: 4,
  خمس: 5, خمسة: 5, خمسه: 5, ست: 6, ستة: 6, سته: 6,
  سبع: 7, سبعة: 7, سبعه: 7, ثمان: 8, ثمانية: 8, ثمانيه: 8,
  تسع: 9, تسعة: 9, تسعه: 9, عشر: 10, عشرة: 10, عشره: 10,
  احد: 1, احدي: 1, اثنا: 2, اربعين: 40,
  عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, اربعون: 40, خمسون: 50, خمسين: 50,
  ستون: 60, ستين: 60, سبعون: 70, سبعين: 70, ثمانون: 80, ثمانين: 80, تسعون: 90, تسعين: 90,
  مئة: 100, مائه: 100, ماية: 100, الف: 1000, الفي: 2000, الفين: 2000,
};

const MULTIPLIERS: Record<string, number> = { hundred: 100, thousand: 1000, dozen: 12, score: 20, مئة: 100, مائه: 100, الف: 1000 };
/** Indefinite articles that only count when nothing else follows ("a tree" = 1). */
const ARTICLES = new Set(['a', 'an']);

/** Largest count the planner will accept from a description. */
export const MAX_PARSED_COUNT = 100_000;

function unitValue(token: string): number | undefined {
  if (UNITS[token] !== undefined) return UNITS[token];
  return parseCountToken(token);
}

/**
 * Parse a number from a window of tokens. Handles digits, English and Arabic
 * word numbers and simple compounds ("seventeen", "twenty five", "two hundred",
 * "five hundred and twenty", "خمسة وعشرون", "ثلاثة عشر", "ثلاثمئة").
 */
export function parseNumberFromTokens(tokens: string[]): number | undefined {
  if (!tokens.length) return undefined;
  const compact = tokens.join('');
  if (/^\d{1,6}$/.test(compact)) return Math.min(Number(compact), MAX_PARSED_COUNT);

  let total = 0;
  let current = 0;
  let consumed = 0;
  let sawTeen = false;

  for (const [index, raw] of tokens.entries()) {
    const token = raw.replace(/^(?:و|و\s)/u, '');
    if (!token || token === 'and' || token === 'و') {
      if (consumed) continue;
      break;
    }
    // Arabic teens: "<unit> عشر" → unit + 10.
    const next = tokens[index + 1];
    // "a couple of", "two dozen": the article carries no value of its own when a
    // real number word follows it.
    if (ARTICLES.has(token) && next !== undefined && (unitValue(next) !== undefined || MULTIPLIERS[next] !== undefined)) continue;
    if (next && /^عشر/.test(next) && unitValue(token) !== undefined && (unitValue(token) ?? 0) < 10) {
      total += (unitValue(token) ?? 0) + 10;
      consumed = index + 2;
      sawTeen = true;
      continue;
    }
    if (sawTeen) break;
    const value = unitValue(token);
    const multiplier = MULTIPLIERS[token];
    if (multiplier !== undefined && current > 0) {
      total += current * multiplier;
      current = 0;
      consumed = index + 1;
      continue;
    }
    if (value === undefined) break;
    current += value;
    consumed = index + 1;
  }

  const result = total + current;
  if (!consumed || !Number.isFinite(result) || result <= 0) return undefined;
  return Math.min(Math.round(result), MAX_PARSED_COUNT);
}

/** Digits or a single number word, exactly as the legacy helper accepts them. */
export function parseSingleNumber(token: string | undefined): number | undefined {
  return token === undefined ? undefined : parseNumberFromTokens([token]);
}

// ── Term matching ────────────────────────────────────────────────────────────

export interface TermMatch {
  entry: LexiconEntry;
  text: string;
  start: number;
  end: number;
}

const AR_PREFIX = '(?:و)?(?:ف)?(?:ب)?(?:ال)?';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface CompiledTerm {
  entry: LexiconEntry;
  regex: RegExp;
  length: number;
}

let compiled: CompiledTerm[] | null = null;

function compiledTerms(): CompiledTerm[] {
  if (compiled) return compiled;
  const terms: CompiledTerm[] = [];
  for (const entry of LEXICON) {
    for (const raw of [...entry.ar, ...entry.en]) {
      const term = normalizePlannerText(raw);
      if (!term) continue;
      const prefix = /[\u0600-\u06ff]/.test(term) ? AR_PREFIX : '';
      terms.push({
        entry,
        length: term.length,
        regex: new RegExp(`(?<![\\p{L}\\p{N}_])${prefix}${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'gu'),
      });
    }
  }
  // Longest terms win, so "pine forest" beats "forest" and "برج مراقبة" beats "برج".
  terms.sort((a, b) => b.length - a.length);
  compiled = terms;
  return terms;
}

/**
 * Find every lexicon term in normalized text. Matches are non-overlapping and
 * ordered by position; the longest term at a position wins.
 */
export function scanTerms(normalized: string): TermMatch[] {
  const found: TermMatch[] = [];
  for (const term of compiledTerms()) {
    term.regex.lastIndex = 0;
    for (const match of normalized.matchAll(term.regex)) {
      if (match.index === undefined) continue;
      found.push({ entry: term.entry, text: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: TermMatch[] = [];
  for (const match of found) {
    if (!selected.some((other) => match.start < other.end && match.end > other.start)) selected.push(match);
  }
  return selected;
}

// ── Negation ─────────────────────────────────────────────────────────────────

// The lookbehind matters: "صغير" contains "غير" and "north" contains "no", and
// reading either as a negation would silently delete half the world.
// The lookbehind matters: "صغير" contains "غير" and "north" contains "no", and
// reading either as a negation would silently delete half the world. The
// conjunction prefix keeps "ولا أشجار" a negation.
const NEGATION = /(?<![\p{L}\p{N}_])[وف]?(?:بدون|دون|بلا|لا|ليس|ليست|غير|خال|خالي|خالية|صفر|من دون|لا يوجد|لا توجد|ما في|without|no|none|not|never|dont|don't|zero|free of|lacking|avoid|skip)\s*(?:a\s+|an\s+|the\s+|any\s+|ال)?\s*$/u;

/** True when a negation marker sits between `from` and the term at `start`. */
export function isNegated(normalized: string, from: number, start: number): boolean {
  const between = normalized.slice(from, start);
  return NEGATION.test(between);
}

/**
 * Species-level vegetation. When a negation phrase names both the generic head
 * and a species ("بدون أشجار نخيل" / "no palm trees"), the *species* is what the
 * user excluded; dropping every tree would be a misreading, so the generic term
 * is withdrawn by `refineNegations`.
 */
export const SPECIES_VEGETATION = ['pine', 'palm', 'cactus', 'fern', 'bamboo', 'dead-tree', 'reed', 'mushroom'];

const GENERIC_OF_SPECIES: Record<string, string> = { tree: 'vegetation' };

/**
 * Narrow a negation list: a generic term is dropped when one of its species was
 * negated alongside it in the same phrase.
 */
export function refineNegations(ids: string[]): string[] {
  const present = new Set(ids);
  const dropped: string[] = [];
  for (const generic of Object.keys(GENERIC_OF_SPECIES)) {
    if (!present.has(generic)) continue;
    if (SPECIES_VEGETATION.some((species) => present.has(species))) dropped.push(generic);
  }
  return ids.filter((id) => !dropped.includes(id));
}

/** Which generic terms `refineNegations` withdrew, for user-facing notices. */
export function withdrawnNegations(ids: string[]): string[] {
  const refined = new Set(refineNegations(ids));
  return ids.filter((id) => !refined.has(id));
}

/** Global negation that applies to the whole description, e.g. "لا ماء". */
export function globalNegations(normalized: string): string[] {
  const ids: string[] = [];
  const pattern = /(?<![\p{L}\p{N}_])[وف]?(?:بدون|دون|بلا|لا|غير|without|no|not|never)\s+(?:ال)?([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)?)/gu;
  for (const match of normalized.matchAll(pattern)) {
    const phrase = match[1];
    if (!phrase) continue;
    // Refine per phrase: "بدون أشجار نخيل" excludes palms, not every tree.
    ids.push(...refineNegations(scanTerms(phrase).map((term) => term.entry.id)));
  }
  return [...new Set(ids)];
}

/** Words that carry quantity meaning without an exact number. */
export function quantityHint(normalized: string, start: number, end: number): 'many' | 'some' | 'single' | undefined {
  const before = normalized.slice(Math.max(0, start - 40), start)
    .replace(/(?:\s+(?:من|في|على|علي|of|from|the|a|an))+\s*$/u, '');
  const after = normalized.slice(end, end + 40);
  if (/(?:كثير|العديد|عشرات|المئات|مئات|الاف|آلاف|many|lots of|a lot of|dozens|hundreds|thousands|numerous|countless|many of)\s*$/u.test(before) ||
      /^(?:\s*(?:كثير|كثيرة|العديد|عشرات|مئات|الاف))/u.test(after)) return 'many';
  if (/(?:بعض|عدة|قليل من|some|several|a few|few)\s*$/u.test(before)) return 'some';
  return undefined;
}
