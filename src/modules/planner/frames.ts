import { LEXICON, labelFor, type LexiconCategory, type LexiconEntry } from './lexicon';
import {
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
  type DescriptionLanguage,
  type TermMatch,
} from './normalize';
import type { AssetRequest } from '../ai/assetRequests';
import type { BiomeId, TimeOfDay, WorldDensity, WorldScale, WorldStyle } from '../ai/types';
import type { TerrainStyle } from '../../core/world-plan/schema';

/**
 * Semantic frames: the intermediate representation between raw description and
 * the structured `WorldSpec`.
 *
 * Extraction is a bounded grammar over the lexicon, not a general language
 * model: entities are located first, then quantities, modifiers and relational
 * connectives are attached to the nearest entities. Everything is deterministic
 * for a given input string.
 */

export type RelationPredicate =
  | 'on-top-of'
  | 'at-foot-of'
  | 'inside'
  | 'surrounding'
  | 'surrounded-by'
  | 'through'
  | 'across'
  | 'near'
  | 'between'
  | 'connected-by'
  | 'along'
  | 'facing'
  | 'left-of'
  | 'right-of'
  | 'front-of'
  | 'behind';

const ENTITY_CATEGORIES: LexiconCategory[] = [
  'biome', 'landform', 'water', 'vegetation', 'structure', 'settlement', 'prop', 'animal',
];

export interface MentionFrame {
  id: string;
  entry: LexiconEntry;
  text: string;
  start: number;
  end: number;
  count: number;
  countSource: 'explicit' | 'dual' | 'plural' | 'quantity' | 'default';
  size?: AssetRequest['size'];
  negated: boolean;
  /** Region modifier attached to this mention, e.g. `north`, `summit-region`. */
  region?: string;
  /** Architectural style modifier, e.g. `medieval`. */
  architecture?: string;
  /** Material modifier, e.g. `stone-mat`. */
  material?: string;
}

export interface RelationFrame {
  id: string;
  predicate: RelationPredicate;
  /** Mention id of the thing being placed. */
  subject: string;
  /** Mention id of the anchor. */
  object: string;
  /** For `connected-by`: the connector mention id (road, bridge, path). */
  via?: string;
  /** For `between`: the second anchor mention id. */
  second?: string;
  text: string;
}

export interface RegionFrame {
  id: string;
  name: string;
  selector: 'north' | 'south' | 'east' | 'west' | 'center' | 'edge' | 'summit' | 'base' | 'slope' | 'waterfront';
  biome?: BiomeId;
  landform?: TerrainStyle;
  mentions: string[];
}

export interface Frames {
  language: DescriptionLanguage;
  normalized: string;
  mentions: MentionFrame[];
  relations: RelationFrame[];
  /** Lexicon ids explicitly negated ("بدون شجر", "no water"), narrowed by species. */
  negations: string[];
  /**
   * Arabic explanation whenever a negation was narrowed — "بدون أشجار نخيل"
   * excludes palms, not every tree. Surfaced to the user so the reading of a
   * negative instruction is never silent.
   */
  negationNotes: string[];
  biomes: BiomeId[];
  landform?: TerrainStyle;
  water: string[];
  weather: string[];
  time?: TimeOfDay;
  /** Every time of day the description named, in order; two means a conflict. */
  times: TimeOfDay[];
  scale?: WorldScale;
  density?: WorldDensity;
  style?: WorldStyle;
  architecture: string[];
  materials: string[];
  regions: RegionFrame[];
  animals: { id: string; count: number }[];
  cues: string[];
  /**
   * True when a scale word was found but belongs to one object ("a small
   * village", "قلعة كبيرة") rather than to the world. The solver then refuses to
   * resize the terrain because of it.
   */
  scaleFromObject: boolean;
}

// ── Relational connectives ───────────────────────────────────────────────────

interface Connective {
  predicate: RelationPredicate;
  /** Reversed: the anchor is mentioned first ("محاطة بأشجار"). */
  reversed?: boolean;
  /** Text the connective may not directly follow, because it is then an adverb. */
  avoidAfter?: RegExp;
  patterns: string[];
}

const CONNECTIVES: Connective[] = [
  { predicate: 'on-top-of', patterns: ['on top of', 'atop', 'on the summit of', 'on the peak of', 'on the crest of', 'above', 'overlooking', 'علي قمة', 'على قمة', 'علي راس', 'فوق', 'اعلي', 'على اعلي'] },
  // English pronoun forms ("a lake at its foot") are deliberately absent: their
  // referent cannot be resolved without a parse tree, and a wrong relation is
  // worse than none. Arabic handles it through the pronoun suffix on "تحتها".
  { predicate: 'at-foot-of', patterns: ['at the foot of', 'at the base of', 'below', 'beneath', 'under', 'عند سفح', 'اسفل', 'تحت', 'عند قاعدة', 'في سفح', 'عند اقدام'] },
  { predicate: 'surrounded-by', reversed: true, patterns: ['surrounded by', 'encircled by', 'ringed by', 'bordered by', 'محاطة ب', 'محاط ب', 'محوط ب', 'تحيط به', 'يحيط بها'] },
  { predicate: 'surrounding', patterns: ['surrounding', 'encircling', 'circling', 'ringing', 'around', 'تحيط ب', 'يحيط ب', 'حول', 'محيط ب', 'تطوق'] },
  { predicate: 'connected-by', patterns: ['connected by', 'connected with', 'linked by', 'joined by', 'joined with', 'متصلة ب', 'متصل ب', 'مربوطة ب', 'مربوط ب', 'موصولة ب', 'تربطها', 'تربطها طرق'] },
  { predicate: 'through', patterns: ['passing through', 'running through', 'cutting through', 'through', 'across', 'crossing', 'عبر', 'خلال', 'يمر عبر', 'يمر في', 'يعبر', 'يخترق', 'مارا'] },
  { predicate: 'across', patterns: ['spanning', 'over', 'فوق النهر', 'يعبر النهر'] },
  { predicate: 'between', patterns: ['between', 'in between', 'بين'] },
  { predicate: 'along', patterns: ['along', 'alongside', 'علي طول', 'على طول', 'بمحاذاة', 'علي ضفاف', 'على ضفاف'] },
  // "قلعة وسط الغابة" is a relation; "بحيرة في الوسط" is an adverb with no
  // object, and inventing one would attach the lake to whatever comes next.
  { predicate: 'inside', avoidAfter: /(?:في|ب|بال|لل)\s*$/u, patterns: ['inside', 'within', 'in the middle of', 'وسط', 'داخل', 'في وسط'] },
  { predicate: 'facing', patterns: ['facing', 'looking at', 'مقابل', 'يطل علي', 'يطل على'] },
  { predicate: 'near', patterns: ['next to', 'beside', 'close to', 'adjacent to', 'near', 'بجانب', 'بجوار', 'بالقرب من', 'قرب', 'قريبا من', 'عند'] },
  { predicate: 'left-of', patterns: ['to the left of', 'left of', 'يسار'] },
  { predicate: 'right-of', patterns: ['to the right of', 'right of', 'يمين'] },
  { predicate: 'front-of', patterns: ['in front of', 'front of', 'امام', 'قدام'] },
  { predicate: 'behind', patterns: ['behind', 'خلف', 'وراء'] },
];

interface CompiledConnective {
  connective: Connective;
  regex: RegExp;
  length: number;
}

let compiledConnectives: CompiledConnective[] | null = null;

function connectives(): CompiledConnective[] {
  if (compiledConnectives) return compiledConnectives;
  const list: CompiledConnective[] = [];
  for (const connective of CONNECTIVES) {
    for (const raw of connective.patterns) {
      const pattern = normalizePlannerText(raw);
      if (!pattern) continue;
      const arabic = /[\u0600-\u06ff]/.test(pattern);
      const prefix = arabic ? '(?:و)?(?:ال)?' : '';
      list.push({
        connective,
        length: pattern.length,
        regex: new RegExp(
          `(?<![\\p{L}\\p{N}_])${prefix}${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\p{L}\\p{N}_]*)?`,
          'gu',
        ),
      });
    }
  }
  list.sort((a, b) => b.length - a.length);
  compiledConnectives = list;
  return list;
}

interface ConnectiveHit {
  connective: Connective;
  start: number;
  end: number;
  text: string;
}

function findConnectives(normalized: string): ConnectiveHit[] {
  const hits: ConnectiveHit[] = [];
  for (const compiled of connectives()) {
    compiled.regex.lastIndex = 0;
    for (const match of normalized.matchAll(compiled.regex)) {
      if (match.index === undefined) continue;
      if (compiled.connective.avoidAfter?.test(normalized.slice(Math.max(0, match.index - 8), match.index))) continue;
      hits.push({ connective: compiled.connective, start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: ConnectiveHit[] = [];
  for (const hit of hits) {
    if (!selected.some((other) => hit.start < other.end && hit.end > other.start)) selected.push(hit);
  }
  return selected;
}

// ── Extraction ───────────────────────────────────────────────────────────────

const DUAL = /(?:تين|تان|لين|لان|جين|جان|يتين|يتان)$/u;
const PLURAL_EN = /(?:s|es|ies|ves)$/u;
/** Sound Arabic plurals only; the dual suffix is checked first. */
const PLURAL_AR = /(?:ات|ين|ون|ان)$/u;
const SIZE_WORDS = 'صغير|صغيره|صغيرة|كبير|كبيره|كبيرة|ضخم|ضخمه|ضخمة|طويل|طويله|طويلة|عريض|واسع|small|tiny|little|large|big|huge|tall|wide|broad|massive|giant';

/**
 * Broken (irregular) Arabic plurals and collectives that the sound-plural
 * suffixes cannot catch: "بيوت", "قلاع", "جبال", "نخيل". Listed from the lexicon
 * so `البيوت` asks for several houses instead of one.
 */
const BROKEN_PLURAL_AR = new Set([
  'مروج', 'احراج', 'جزر', 'اطلال', 'خرائب', 'تلال', 'هضاب', 'قمم', 'وديان', 'اخاديد',
  'خوانق', 'براكين', 'بحار', 'انهار', 'جداول', 'مياه', 'اهوار', 'اشجار', 'نخيل', 'زهور',
  'ورود', 'حشائش', 'بيوت', 'منازل', 'قلاع', 'ابراج', 'خيام', 'جسور', 'قري', 'مدن',
  'مصابيح', 'طرق', 'صخور', 'جبال', 'رمال', 'بساتين',
  'غزلان', 'ذئاب', 'ثعالب', 'ارانب', 'دببة', 'اسماك', 'افيال', 'قرود', 'دجاج',
  'خراف', 'اغنام', 'احصنة', 'خيول', 'نسور', 'جمال', 'ابقار', 'بقر', 'غنم', 'طيور',
].map(normalizePlannerText));

/** Strips the conjunction/definite prefixes a match may carry ("والبيوت"). */
function stripArPrefix(text: string): string {
  return text.replace(/^(?:و|ف)(?:ال)?/u, '').replace(/^ال/u, '');
}

const FILLER_WORD = /^(?:and|of|from|the|a|an|و|في|من|على|علي|بين|مع)$/u;

const DEFAULT_MANY = 12;
const DEFAULT_SOME = 5;
const DEFAULT_PLURAL = 3;

/** Nouns that make an adjacent size adjective about the world, not one object. */
const WORLD_NOUN = /(?:عالم|خريطه|خريطة|منظر|مشهد|بيئه|بيئة|ساحه|ساحة|مساحه|مساحة|world|map|scene|level|environment|landscape|terrain)/u;

/**
 * "عالم صغير" and "a small world" resize the world; "a small village" and
 * "قرية صغيرة" describe one object. Only the first may set `frames.scale` —
 * otherwise every cottage would shrink the terrain.
 */
/** Adjectives on the land itself do describe the world: "صحراء واسعة", "vast desert". */
const WORLD_SCOPE_CATEGORIES: LexiconCategory[] = ['biome', 'landform'];

function isWorldLevelScale(normalized: string, match: TermMatch, entities: TermMatch[], language: DescriptionLanguage): boolean {
  const before = normalized.slice(Math.max(0, match.start - 30), match.start);
  const after = normalized.slice(match.end, match.end + 30);
  if (WORLD_NOUN.test(before) || WORLD_NOUN.test(after)) return true;

  const nearest = (side: 'before' | 'after'): TermMatch | undefined => {
    let found: TermMatch | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const entity of entities) {
      const onSide = side === 'before' ? entity.end <= match.start : entity.start >= match.end;
      if (!onSide) continue;
      const gap = side === 'before' ? match.start - entity.end : entity.start - match.end;
      if (gap < 0 || gap > MODIFIER_GAP || gap >= bestGap) continue;
      const between = side === 'before' ? normalized.slice(entity.end, match.start) : normalized.slice(match.end, entity.start);
      if (CLAUSE_BREAK.test(between)) continue;
      bestGap = gap;
      found = entity;
    }
    return found;
  };

  // The adjective qualifies the noun its language puts next to it: "قرية صغيرة"
  // (noun first), "a small village" (noun second). Only when that side is empty
  // may the other side decide, so "قلعة كبيرة فوق قمة جبل" describes the castle
  // and never resizes the mountain — or the world.
  const attached = nearest(language === 'en' ? 'after' : 'before') ?? nearest(language === 'en' ? 'before' : 'after');
  if (!attached) return true;
  return WORLD_SCOPE_CATEGORIES.includes(attached.entry.category);
}

const MODIFIER_CATEGORIES: LexiconCategory[] = ['material', 'architecture', 'region'];
const MODIFIER_GAP = 24;

/**
 * Attach material, architecture and region modifiers to the noun they qualify.
 *
 * Two rules keep this honest: a modifier belongs to the *nearest* mention in the
 * same phrase ("قلعة حجرية ... قرية" never makes the village stone), and a chain
 * of adjectives stays with the noun the chain started from ("قلعة حجرية
 * قروسطية" — both describe the castle, even though the mountain is closer to the
 * second one).
 */
function attachModifiers(normalized: string, mentions: MentionFrame[], modifiers: TermMatch[]): void {
  const chainable = modifiers
    .filter((modifier) => MODIFIER_CATEGORIES.includes(modifier.entry.category))
    .sort((a, b) => a.start - b.start);
  let previousModifier: TermMatch | undefined;
  let previousTarget: MentionFrame | undefined;
  for (const modifier of chainable) {
    const chained = previousModifier && previousTarget &&
      modifier.start - previousModifier.end <= 4 &&
      !CLAUSE_BREAK.test(normalized.slice(previousModifier.end, modifier.start));
    if (chained) {
      assignModifier(previousTarget!, modifier);
      previousModifier = modifier;
      continue;
    }
    let best: { mention: MentionFrame; gap: number } | null = null;
    for (const mention of mentions) {
      const follows = modifier.end <= mention.start;
      // A conjunction ("غابة في الشمال وبحيرة") starts a new phrase, so a
      // modifier before it belongs to the earlier noun only.
      if (follows && /^[وف]/u.test(mention.text)) continue;
      const gap = follows ? mention.start - modifier.end : modifier.start >= mention.end ? modifier.start - mention.end : -1;
      if (gap < 0 || gap > MODIFIER_GAP) continue;
      // Never across a comma or clause connective.
      const between = follows ? normalized.slice(modifier.end, mention.start) : normalized.slice(mention.end, modifier.start);
      if (CLAUSE_BREAK.test(between)) continue;
      if (!best || gap < best.gap) best = { mention, gap };
    }
    if (!best) {
      previousModifier = modifier;
      previousTarget = undefined;
      continue;
    }
    assignModifier(best.mention, modifier);
    previousModifier = modifier;
    previousTarget = best.mention;
  }
}

function assignModifier(mention: MentionFrame, modifier: TermMatch): void {
  if (modifier.entry.category === 'material' && !mention.material) mention.material = modifier.entry.id;
  if (modifier.entry.category === 'architecture' && !mention.architecture) mention.architecture = modifier.entry.id;
  if (modifier.entry.category === 'region' && !mention.region) mention.region = modifier.entry.id;
}

/** Punctuation or clause connectives that end a negation's scope. */
const CLAUSE_BREAK = /[،؛,.:;!?]|\b(?:لكن|بل|ثم|بينما|اما|غير ان|and|but|while|then|however)\b/u;
/** Only categories where a generic head plus a species is a single phrase. */
const NEGATION_SCOPE_CATEGORIES: LexiconCategory[] = ['vegetation', 'water'];

function inheritsNegation(gap: string, category: LexiconCategory, scope: { category: LexiconCategory }, distance: number): boolean {
  return NEGATION_SCOPE_CATEGORIES.includes(category) &&
    scope.category === category &&
    distance <= 24 &&
    !CLAUSE_BREAK.test(gap);
}

/**
 * An Arabic object-pronoun suffix on a connective ("فوقها", "تحتها", "عندها")
 * refers back to the *preceding* mention, so the thing being placed is the one
 * that follows: "قلعة وفوقها برج" puts the tower on the castle, not the reverse.
 */
const PRONOUN_SUFFIX = /(?:ها|هما|هم|هن|كم|كما|نا|ه)$/u;

const SIZE_WORD_RE = new RegExp(`(?:^|\\s)(?:ال)?(${SIZE_WORDS})(?![\\p{L}\\p{N}_])`, 'gu');

function sizeOf(word: string): AssetRequest['size'] {
  if (/صغير|small|tiny|little/.test(word)) return 'small';
  if (/طويل|tall/.test(word)) return 'tall';
  if (/عريض|واسع|wide|broad/.test(word)) return 'wide';
  return 'large';
}

/**
 * Attach size adjectives to the noun they qualify.
 *
 * Arabic puts the adjective *after* its noun ("قلعة كبيرة"), English *before* it
 * ("a tall mountain"), so each mention looks in its own language's direction
 * first. Without this, "عالم صغير فيه قرية كبيرة" would make the village small
 * and "a tall mountain" would make the castle tall.
 */
function attachSizes(normalized: string, mentions: MentionFrame[], language: DescriptionLanguage): void {
  const words: { start: number; end: number; size: AssetRequest['size'] }[] = [];
  SIZE_WORD_RE.lastIndex = 0;
  for (const match of normalized.matchAll(SIZE_WORD_RE)) {
    if (match.index === undefined) continue;
    const word = match[1];
    if (!word) continue;
    const start = match.index + match[0].indexOf(word);
    words.push({ start, end: start + word.length, size: sizeOf(word) });
  }
  if (!words.length) return;

  const claimed = new Set<number>();
  /** Distance from a mention to a size word on the given side, or -1. */
  const gapTo = (mention: MentionFrame, word: { start: number; end: number }, side: 'before' | 'after'): number => {
    // A conjunction ("...كبير وبحيرة") starts a new phrase: the adjective belongs
    // to the noun it is written next to, not to the one before the "and".
    if (side === 'before' && /^[وف]/u.test(mention.text)) return -1;
    const gap = side === 'before' ? mention.start - word.end : word.start - mention.end;
    if (gap < 0 || gap > MODIFIER_GAP) return -1;
    const between = side === 'before' ? normalized.slice(word.end, mention.start) : normalized.slice(mention.end, word.start);
    return CLAUSE_BREAK.test(between) ? -1 : gap;
  };

  // Two passes: every mention first claims an adjective on its own language's
  // side, and only then may it reach across. Otherwise "a castle on top of a
  // tall mountain" gives the mountain's height to the castle, which is merely
  // the closest noun on the wrong side of the word.
  const claim = (mention: MentionFrame, side: 'before' | 'after'): void => {
    let bestIndex = -1;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const [index, word] of words.entries()) {
      if (claimed.has(index)) continue;
      const gap = gapTo(mention, word, side);
      if (gap < 0 || gap >= bestGap) continue;
      bestIndex = index;
      bestGap = gap;
    }
    if (bestIndex < 0) return;
    claimed.add(bestIndex);
    if (!mention.size) mention.size = words[bestIndex]!.size;
  };
  const preferred: 'before' | 'after' = language === 'en' ? 'before' : 'after';
  const other: 'before' | 'after' = preferred === 'before' ? 'after' : 'before';
  for (const mention of mentions) claim(mention, preferred);
  for (const mention of mentions) {
    if (!mention.size) claim(mention, other);
  }
}

function countFor(normalized: string, tokens: ReturnType<typeof tokenize>, match: TermMatch, previousEnd: number): { count: number; source: MentionFrame['countSource'] } {
  const beforeTokens = tokens.filter((token) => token.end <= match.start && token.start >= previousEnd && match.start - token.end <= 26).slice(-3);
  const afterTokens = tokens.filter((token) => token.start >= match.end && token.start - match.end <= 26).slice(0, 3);
  // "three deer and two wolves": the leading conjunction is not part of a number.
  const beforeWords = beforeTokens.map((token) => token.text);
  while (beforeWords.length && FILLER_WORD.test(beforeWords[0]!)) beforeWords.shift();
  const before = parseNumberFromTokens(beforeWords);
  if (before !== undefined) return { count: before, source: 'explicit' };
  // "3 من الأشجار" / "trees: 3" — a number directly after the noun.
  const after = parseNumberFromTokens(afterTokens.map((token) => token.text).filter((token) => !/^(?:of|from|في|من)$/u.test(token)));
  if (after !== undefined) return { count: after, source: 'explicit' };
  const bare = stripArPrefix(match.text);
  // The masculine dual ends in "ان", which is ambiguous on its own ("حصان" is a
  // singular horse), so it only counts when removing it yields a known term.
  if (DUAL.test(bare) || isMasculineDual(match.entry, bare)) return { count: 2, source: 'dual' };
  // A stated quantity beats the plural default: "العديد من الأشجار" means many.
  const hint = quantityHint(normalized, match.start, match.end);
  if (hint === 'many') return { count: DEFAULT_MANY, source: 'quantity' };
  if (hint === 'some') return { count: DEFAULT_SOME, source: 'quantity' };
  if (PLURAL_EN.test(bare) || PLURAL_AR.test(bare) || BROKEN_PLURAL_AR.has(bare)) return { count: DEFAULT_PLURAL, source: 'plural' };
  return { count: 1, source: 'default' };
}

function isMasculineDual(entry: LexiconEntry, bare: string): boolean {
  if (!bare.endsWith('ان') || bare.length < 4) return false;
  const singular = bare.slice(0, -2);
  return entry.ar.some((term) => normalizePlannerText(term) === singular) ||
    entry.ar.some((term) => normalizePlannerText(term).endsWith('ه') && normalizePlannerText(term).slice(0, -1) === singular);
}

/** Extract every frame the planner understands from one description. */
export function extractFrames(description: string): Frames {
  const normalized = normalizePlannerText(description);
  const tokens = tokenize(normalized);
  const language = detectLanguage(description);
  const scanned = scanTerms(normalized);

  const entities = scanned.filter((match) => ENTITY_CATEGORIES.includes(match.entry.category));
  const connectiveHits = findConnectives(normalized);
  const insideConnective = (match: TermMatch) =>
    connectiveHits.some((hit) => match.start < hit.end && match.end > hit.start);
  // "on top of" / "عند سفح" contain the words "top" and "foot"; they are relation
  // connectives, not region modifiers, and must not invent summit/base regions.
  const modifiers = scanned.filter((match) => !ENTITY_CATEGORIES.includes(match.entry.category) && !insideConnective(match));

  const mentions: MentionFrame[] = [];
  let previousEnd = 0;
  let negationScope: { end: number; category: LexiconCategory } | null = null;
  for (const [index, match] of entities.entries()) {
    const windowStart = index ? entities[index - 1]!.end : 0;
    let negated = isNegated(normalized, windowStart, match.start);
    // "بدون أشجار نخيل": the negation covers the whole noun phrase, so the
    // species inherits it even though no marker sits directly before it.
    if (!negated && negationScope && inheritsNegation(normalized.slice(windowStart, match.start), match.entry.category, negationScope, match.start - negationScope.end)) {
      negated = true;
    }
    if (negated) negationScope = { end: match.end, category: match.entry.category };
    else if (negationScope && match.start - negationScope.end > 40) negationScope = null;
    const { count, source } = countFor(normalized, tokens, match, previousEnd);
    mentions.push({
      id: `m${index}`,
      entry: match.entry,
      text: match.text,
      start: match.start,
      end: match.end,
      count,
      countSource: source,
      negated,
    });
    previousEnd = match.end;
  }

  // Modifiers ("حجرية", "قروسطية", "الشمالي") attach to the *nearest* mention in
  // the same phrase only, so "قلعة حجرية ... قرية" never makes the village stone.
  attachModifiers(normalized, mentions, modifiers);
  attachSizes(normalized, mentions, language);

  const byId = new Map(mentions.map((mention) => [mention.id, mention]));
  const relations: RelationFrame[] = [];
  for (const hit of connectiveHits) {
    const previous = [...mentions].reverse().find((mention) => mention.end <= hit.start);
    // Arabic fuses a preposition with its noun ("تحيط ببحيرة"), and a connective
    // may carry a pronoun suffix ("فوقها"), so the greedy match can swallow the
    // very mention it relates. That mention is the object side of the relation.
    const inside = mentions.find((mention) => mention.start >= hit.start && mention.end <= hit.end && mention.id !== previous?.id);
    const next = inside ?? mentions.find((mention) => mention.start >= hit.end);
    const after = inside
      ? [inside, ...mentions.filter((mention) => mention.start >= hit.end)]
      : mentions.filter((mention) => mention.start >= hit.end);
    if (hit.connective.predicate === 'between') {
      if (!previous || after.length < 2) continue;
      relations.push({ id: `r${relations.length}`, predicate: 'between', subject: previous.id, object: after[0]!.id, second: after[1]!.id, text: hit.text });
      continue;
    }
    if (hit.connective.reversed) {
      // "a lake surrounded by trees": the anchor comes first.
      if (!previous || !next) continue;
      relations.push({ id: `r${relations.length}`, predicate: hit.connective.predicate, subject: next.id, object: previous.id, text: hit.text });
      continue;
    }
    if (hit.connective.predicate === 'connected-by') {
      // "البيوت تربطها طرق" / "houses connected by roads": the connector is the
      // mention the connective itself swallowed, or the next one.
      if (!previous) continue;
      const connector = inside ?? mentions.find((mention) => mention.start >= hit.end);
      if (!connector) continue;
      const partners = mentions.filter((mention) => mention.id !== previous.id && mention.entry.id === previous.entry.id);
      relations.push({
        id: `r${relations.length}`,
        predicate: 'connected-by',
        subject: previous.id,
        object: partners[0]?.id ?? previous.id,
        via: connector.id,
        text: hit.text,
      });
      continue;
    }
    if (!previous || !next) continue;
    const swapped = PRONOUN_SUFFIX.test(hit.text);
    relations.push({
      id: `r${relations.length}`,
      predicate: hit.connective.predicate,
      subject: swapped ? next.id : previous.id,
      object: swapped ? previous.id : next.id,
      text: hit.text,
    });
  }

  // Regions: a compass/position modifier plus the entity mentions it governs.
  const regions: RegionFrame[] = [];
  const regionTerms = modifiers.filter((modifier) => modifier.entry.category === 'region');
  for (const term of regionTerms) {
    const governed = mentions.filter((mention) => mention.region === term.entry.id);
    // The biome of a region is the biome *inside* it ("غابة في الشمال"), not the
    // nearest biome word anywhere in the description.
    const biome = governed.find((mention) => mention.entry.biome !== undefined)?.entry.biome;
    const landform = governed.find((mention) => mention.entry.terrain !== undefined)?.entry.terrain;
    regions.push({
      id: `region-${term.entry.id}`,
      name: term.entry.ar[0] ?? term.entry.id,
      selector: selectorFor(term.entry.id),
      ...(biome ? { biome } : {}),
      ...(landform ? { landform } : {}),
      mentions: governed.map((mention) => mention.id),
    });
  }

  const biomes = [...new Set(scanned.filter((match) => match.entry.biome && !isNegated(normalized, 0, match.start)).map((match) => match.entry.biome!))];
  const landformMatch = scanned.find((match) => match.entry.terrain && !isNegated(normalized, 0, match.start));
  const scaleCandidates = modifiers.filter((modifier) => modifier.entry.scale && !isNegated(normalized, 0, modifier.start));
  const scaleMatch = scaleCandidates.find((modifier) => isWorldLevelScale(normalized, modifier, entities, language));
  const scaleFromObject = !scaleMatch && scaleCandidates.length > 0;
  const densityMatch = modifiers.find((modifier) => modifier.entry.density && !isNegated(normalized, 0, modifier.start));
  const styleMatch = modifiers.find((modifier) => modifier.entry.style && !isNegated(normalized, 0, modifier.start));
  const timeMatches = modifiers.filter((modifier) => modifier.entry.time && !isNegated(normalized, 0, modifier.start));
  const times = [...new Set(timeMatches.map((modifier) => modifier.entry.time!))];
  const timeMatch = timeMatches[0];

  const animals: { id: string; count: number }[] = [];
  for (const mention of mentions) {
    if (mention.entry.category !== 'animal' || mention.negated) continue;
    const existing = animals.find((animal) => animal.id === mention.entry.id);
    if (existing) existing.count += mention.count;
    else animals.push({ id: mention.entry.id, count: mention.count });
  }

  const rawNegations = [
    ...new Set([
      ...mentions.filter((mention) => mention.negated).map((mention) => mention.entry.id),
      ...globalNegations(normalized),
    ]),
  ];
  const negations = refineNegations(rawNegations);
  const negationNotes = withdrawnNegations(rawNegations).map((generic) => {
    const species = rawNegations.filter((id) => id !== generic && id !== 'tree' && /pine|palm|cactus|fern|bamboo|dead-tree|reed|mushroom/.test(id));
    return `النفي «بدون ${labelFor(generic)}» قُيّد بـ«${species.map(labelFor).join('، ') || 'نوع محدد'}» لأن العبارة سمّت النوع؛ بقيت الأنواع الأخرى.`;
  });

  const cues = [
    ...mentions.map((mention) => `${mention.entry.id}${mention.count !== 1 ? `×${mention.count}` : ''}${mention.negated ? ' (negated)' : ''}`),
    ...relations.map((relation) => `${byId.get(relation.subject)?.entry.id ?? relation.subject} ${relation.predicate} ${byId.get(relation.object)?.entry.id ?? relation.object}`),
  ];

  return {
    language,
    normalized,
    mentions,
    relations,
    negations,
    biomes,
    ...(landformMatch?.entry.terrain ? { landform: landformMatch.entry.terrain } : {}),
    water: [...new Set(scanned.filter((match) => match.entry.category === 'water' && !isNegated(normalized, 0, match.start)).map((match) => match.entry.id))],
    weather: [...new Set(modifiers.filter((modifier) => modifier.entry.category === 'weather' && !isNegated(normalized, 0, modifier.start)).map((modifier) => modifier.entry.id))],
    ...(timeMatch?.entry.time ? { time: timeMatch.entry.time } : {}),
    times,
    ...(scaleMatch?.entry.scale ? { scale: scaleMatch.entry.scale } : {}),
    ...(densityMatch?.entry.density ? { density: densityMatch.entry.density } : {}),
    ...(styleMatch?.entry.style ? { style: styleMatch.entry.style } : {}),
    architecture: [...new Set(modifiers.filter((modifier) => modifier.entry.category === 'architecture').map((modifier) => modifier.entry.id))],
    materials: [...new Set(modifiers.filter((modifier) => modifier.entry.category === 'material').map((modifier) => modifier.entry.id))],
    regions,
    animals,
    cues,
    negationNotes,
    scaleFromObject,
  };
}

function selectorFor(id: string): RegionFrame['selector'] {
  switch (id) {
    case 'north': return 'north';
    case 'south': return 'south';
    case 'east': return 'east';
    case 'west': return 'west';
    case 'center': return 'center';
    case 'edge': return 'edge';
    case 'summit-region': return 'summit';
    case 'base-region': return 'base';
    case 'slope-region': return 'slope';
    case 'waterfront-region': return 'waterfront';
    default: return 'center';
  }
}

/** Lexicon entries that exist but were never used, for the interpretation report. */
export function unusedCategories(frames: Frames): LexiconCategory[] {
  const used = new Set(frames.mentions.map((mention) => mention.entry.category));
  return ENTITY_CATEGORIES.filter((category) => !used.has(category));
}

export { LEXICON };
