import { normalizeAssetText } from './assetRequests';
import type { TopicResearch } from './unknownResearch';
import { dictionaryPage } from './dictionary';
import type { BiomeId } from './types';

export type TopicKind = 'terrain' | 'biome' | 'grass' | 'water' | 'animal' | 'structure' | 'unknown';
export const topicLabels: Record<TopicKind, string> = { terrain:'تضاريس', biome:'بايوم', grass:'أعشاب أو نباتات أرضية', water:'مسطح مائي', animal:'حيوان', structure:'منشأة', unknown:'غير مؤكّد' };
export interface TopicClassification { kind: TopicKind; source?: { title: string; url: string }; biome?: BiomeId; water?: 'standing' }
const clean = (s: string) => normalizeAssetText(s).replace(/ة/g, 'ه').trim().replace(/^ال/u, '').replace(/\s+/g, ' ');
// Applied to the subject's definition, not to incidental words elsewhere in a description.
const rules: { kind: Exclude<TopicKind, 'unknown'>; pattern: RegExp }[] = [
  { kind:'terrain', pattern:/^(?:تضاريس|شكل ارضي|معلم تضاريسي|جبل|تل|هضبه|وادي|اخدود|كثيب|بركان|سهل|plateau|mountain|volcano|landform|valley|canyon|dune)(?![\p{L}])/iu },
  { kind:'biome', pattern:/^(?:بايوم|منطقه حيويه|اقليم حيوي|نظام بيئي|بيئه|غابه|صحراء|forest|desert|biome|ecosystem)(?![\p{L}])/iu },
  { kind:'grass', pattern:/^(?:عشب|عشبه|حشيش|نبات عشبي|نبات عشبي معمر|حشائش|grass|herb|grassland plant)(?![\p{L}])/iu },
  { kind:'water', pattern:/^(?:مسطح مائي|مجرى مائي|نهر|بحيره|بحر|محيط|جدول|lake|river|sea|ocean|watercourse|body of water)(?![\p{L}])/iu },
  { kind:'animal', pattern:/^(?:حيوان|ثديي|ثدييات|طائر|زاحف|سمكه|حشره|animal|mammal|bird|reptile|fish|insect)(?![\p{L}])/iu },
  { kind:'structure', pattern:/^(?:مبني|منشاه|هيكل|بناء|برج|منزل|بيت|قصر|قلعه|جسر|building|structure|tower|house|castle|bridge)(?![\p{L}])/iu },
];
const biomeFor = (text: string): BiomeId | undefined => {
  if (/^(?:جبل|بركان|mountain|volcano)(?![\p{L}])/iu.test(text)) return 'mountains';
  if (/^(?:صحراء|كثيب|desert|dune)(?![\p{L}])/iu.test(text)) return 'desert';
  if (/^(?:غابه|forest)(?![\p{L}])/iu.test(text)) return 'forest';
  return undefined;
};
/** A rule-based category, only from an exact article and its initial definition (or a direct known name). */
export function classifyTopic(topic: TopicResearch): TopicClassification {
  if (topic.explicitKind) {
    const inferred = classifyTopic({ ...topic, explicitKind: undefined });
    return inferred.kind === topic.explicitKind ? inferred : { kind: topic.explicitKind };
  }
  const term = clean(topic.term);
  const article = topic.articles.find((a) => clean(a.title) === term);
  let definition = '';
  let negated = false;
  if (article) {
    const text = normalizeAssetText(article.content).replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
    const title = clean(topic.term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const initial = new RegExp(`^(?:an?\\s+)?(?:ال)?${title}(?![\\p{L}\\p{N}])\\s*[,،:–-]?\\s*`, 'iu');
    if (initial.test(text)) {
      definition = text.replace(initial, '').replace(/^\([^)]{0,100}\)\s*/u, '').replace(/^(?:(?:هو|هي|عباره عن|يعرف بانه|is|are)\s+){0,2}/iu, '')
        .replace(/^(?:(?:نوع من|من انواع|احد انواع|a type of|a kind of|an?|the)\s+){0,2}/iu, '').split(/[.!؟\n]/u)[0]!.trim();
      if (/^(?:ليس|ليست|غير|not|never)(?![\p{L}])/iu.test(definition)) { definition = ''; negated = true; }
    }
  }
  // A term which itself names a category is safe even without Wikipedia.
  if (negated) return { kind:'unknown' };
  const sense = topic.dictionary?.complete && topic.dictionary.entries.length === 1 ? topic.dictionary.entries[0] : undefined;
  const dictionary = sense && /^noun$/i.test(sense.partOfSpeech) ? sense.definition.trim().replace(/^(?:an? |the )?(?:(?:small|large|tropical|wild) )?/i, '') : '';
  let input = definition || dictionary || term;
  let matches = rules.filter((r) => r.pattern.test(input));
  let direct = false;
  // Some introductions define a volcano as an opening rather than a mountain;
  // a standalone well-known category name remains useful without guessing from prose.
  if (!matches.length) {
    const exact = rules.filter((r) => r.pattern.exec(term)?.[0] === term);
    if (exact.length === 1) { input = term; matches = exact; direct = true; }
  }
  if (matches.length !== 1) return { kind:'unknown' };
  const biome = biomeFor(input);
  const water = /^(?:بحيره|بحر|lake|sea)(?![\p{L}])/iu.test(input) ? 'standing' as const : undefined;
  return { kind: matches[0]!.kind, ...(!direct && article && definition ? { source:{ title:article.title, url:article.url } } : !direct && dictionary ? { source:{ title:topic.term, url:dictionaryPage(topic.term) } } : {}), ...(biome ? { biome } : {}), ...(water ? { water } : {}) };
}
export function isLandscapeKind(kind: TopicKind): boolean { return ['terrain','biome','grass','water'].includes(kind); }

/** Respect an explicit adjacent category in a single-topic prompt; never infer from unrelated context. */
export function explicitTopicKind(prompt: string, term: string, total: number): Exclude<TopicKind, 'unknown'> | undefined {
  if (total !== 1) return undefined;
  const text = clean(prompt), word = clean(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!word) return undefined;
  const categories: [Exclude<TopicKind, 'unknown'>, string][] = [
    ['terrain','تضاريس|تضاريسيه|landform|terrain'], ['biome','بايوم|منطقه حيويه|biome'],
    ['grass','اعشاب|عشب|نبات عشبي|grass'], ['water','مسطح مائي|مسطحات مائيه|body of water'],
    ['animal','حيوان|حيوانات|animal'], ['structure','منشاه|منشات|هيكل|استركشر|structure'],
  ];
  const matches = categories.filter(([, expression]) => {
    const category = `(?:ال)?(?:${expression})`;
    const topic = `(?:ال)?${word}`;
    return new RegExp(`(?<![\\p{L}])(?:${category}\\s+(?:(?:من نوع|نوع)\\s+)?${topic}|${topic}\\s+(?:من|نوع من)\\s+${category})(?![\\p{L}])`, 'iu').test(text);
  });
  return matches.length === 1 ? matches[0]![0] : undefined;
}
