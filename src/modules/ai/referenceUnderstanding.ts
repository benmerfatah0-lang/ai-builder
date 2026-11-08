import { findAssetMentions, normalizeAssetText, parseAssetRequests } from './assetRequests';
import { analyzeImageReference } from './onlineInterpreter';
import type { ResearchReport } from './unknownResearch';
import { dictionaryPage } from './dictionary';
import type { ImageReference } from './imageReferences';

export interface Approximation {
  term: string;
  rewritten: string;
  articleTitle: string;
  articleUrl: string;
  sourceKind?: 'dictionary';
  image?: ImageReference;
  color?: string;
  imageError?: string;
  applied?: boolean;
  colorApplied?: boolean;
}
const clean = (text: string) => normalizeAssetText(text).trim().replace(/^ال/u, '').replace(/\s+/g, ' ');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// This deliberately narrow pattern is a heuristic, not semantic understanding.
const houseDefinition = /(?:هو|هي|عباره عن|نوع من)\s+(?:(?:بيت|منزل)(?![\p{L}]))|\b(?:is|are)\s+(?:(?:an?|the|usually|typically|small|large|traditional|type|of)\s+){0,5}(?:house|home)\b/iu;

/** Only approximate a single unknown topic with a house after an exact title and definition match. */
export function matchHouseApproximation(prompt: string, report: ResearchReport): Omit<Approximation, 'color' | 'imageError'> | null {
  if (report.truncated || report.topics.length !== 1) return null;
  const topic = report.topics[0]!;
  const article = topic.articles.find((item) => clean(item.title) === clean(topic.term));
  const validArticle = article && !/ليس|ليست|\b(?:not|never)\b/iu.test(normalizeAssetText(article.content)) && houseDefinition.test(normalizeAssetText(article.content));
  // A single complete noun sense such as “a small house” is a very narrow
  // lexical fallback. Polysemy, other parts of speech and truncation are refused.
  const dictionary = topic.dictionary;
  const sense = dictionary?.complete && dictionary.entries.length === 1 ? dictionary.entries[0] : undefined;
  const validDictionary = sense && /^noun$/i.test(sense.partOfSpeech) && /^(?:(?:a|an) )?(?:(?:small|large|simple|traditional) )?(?:house|home|hut|cabin)[.]?$/i.test(sense.definition.trim());
  if (!validArticle && !validDictionary) return null;
  const normal = normalizeAssetText(prompt);
  // Do not merge an inferred house with a separately requested house.
  if (findAssetMentions(normal).some((mention) => mention.id === 'house')) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(و?)(?:ال)?${escape(topic.term)}(?![\\p{L}\\p{N}_])`, 'gu');
  const matches = [...normal.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const rewritten = normal.replace(pattern, (_whole, conjunction: string) => `${conjunction}بيت`);
  const assets = parseAssetRequests(rewritten, true);
  if (!assets || assets.filter((item) => item.assetId === 'house').length !== 1) return null;
  return { term: topic.term, rewritten, articleTitle: validArticle ? article.title : topic.term, articleUrl: validArticle ? article.url : dictionaryPage(topic.term), ...(!validArticle ? { sourceKind: 'dictionary' as const } : {}), ...(topic.images[0] ? { image: topic.images[0] } : {}) };
}

export async function analyzeApproximation(match: Omit<Approximation, 'color' | 'imageError'>): Promise<Approximation> {
  if (!match.image) return match;
  try { return { ...match, color: await analyzeImageReference(match.image) }; }
  catch (error) { return { ...match, imageError: error instanceof Error ? error.message : 'تعذّر تحليل الصورة.' }; }
}

export function hasExplicitColor(prompt: string): boolean {
  return /احمر|حمراء|ازرق|زرقاء|اخضر|خضراء|اصفر|صفراء|ابيض|بيضاء|اسود|سوداء|بني|بنفسجي|برتقالي|\b(?:red|blue|green|yellow|white|black|brown|purple|orange)\b/iu.test(normalizeAssetText(prompt));
}
