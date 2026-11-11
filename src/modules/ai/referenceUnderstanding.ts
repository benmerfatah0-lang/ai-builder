import { findAssetMentions, normalizeAssetText, parseAssetRequests } from './assetRequests';
import { analyzeImageReference } from './onlineInterpreter';
import type { ResearchReport } from './unknownResearch';
import { dictionaryPage } from './dictionary';
import type { ImageReference } from './imageReferences';
import type { WorldPlan } from '../../core/world-plan/schema';

export interface Approximation {
  term: string;
  rewritten: string;
  articleTitle: string;
  articleUrl: string;
  sourceKind?: 'dictionary';
  assetId?: string;
  assetLabel?: string;
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

// The lead definition can suggest an existing broad asset class, never a new shape.
// Restrict this fallback to exact article titles and a short, affirmative definition.
const broadClasses = [
  { id: 'tree', label: 'شجرة', alias: 'شجرة', ar: 'شجر(?:ة|ه)', en: 'tree' },
  { id: 'boulder', label: 'صخرة', alias: 'صخرة', ar: 'صخر(?:ة|ه)', en: 'rock|stone' },
  { id: 'tower', label: 'برج', alias: 'برج', ar: 'برج', en: 'tower' },
  { id: 'bridge', label: 'جسر', alias: 'جسر', ar: 'جسر', en: 'bridge' },
  { id: 'wood-fence', label: 'سياج', alias: 'سياج', ar: 'سياج|سور', en: 'fence' },
  { id: 'lantern', label: 'فانوس', alias: 'فانوس', ar: 'فانوس', en: 'lantern' },
  { id: 'sphere', label: 'كرة', alias: 'كرة', ar: 'كر(?:ة|ه)', en: 'sphere|ball' },
] as const;

/** Conservative fallback when no image is available. Unsupported or ambiguous text is refused. */
export function matchReferenceApproximation(prompt: string, report: ResearchReport): Omit<Approximation, 'color' | 'imageError'> | null {
  const house = matchHouseApproximation(prompt, report);
  if (house) return house;
  if (report.truncated || report.topics.length !== 1) return null;
  const topic = report.topics[0]!;
  // Do not silently replace an available image with a catalog guess.
  if (topic.images.length) return null;
  const article = topic.articles.find((item) => clean(item.title) === clean(topic.term));
  const lead = article ? normalizeAssetText(article.content).split(/[.!؟\n]/u)[0]!.slice(0, 400) : '';
  const safeLead = !/(?:(?<![\p{L}])(?:ليس|ليست|ليسا|ليسوا|غير)(?![\p{L}])|\b(?:not|never)\b)/iu.test(lead);
  if (article && !safeLead) return null;
  const sense = topic.dictionary?.complete && topic.dictionary.entries.length === 1 ? topic.dictionary.entries[0] : undefined;
  const candidates = broadClasses.map((asset) => {
    const arabic = new RegExp(`(?:هو|هي|عباره عن|نوع من)\\s+(?:(?:نوع من|شجره من|من انواع)\\s+)?(?:${asset.ar})(?![\\p{L}\\p{N}_])`, 'iu');
    const english = new RegExp(`\\b(?:is|are)\\s+(?:(?:an?|the|small|large|simple|traditional|type|of)\\s+){0,5}(?:${asset.en})\\b`, 'iu');
    const dictionary = new RegExp(`^(?:(?:a|an) )?(?:(?:small|large|simple|traditional) )?(?:${asset.en})[.]?$`, 'i');
    const fromArticle = Boolean(lead && safeLead && (arabic.test(lead) || english.test(lead)));
    const fromDictionary = Boolean(sense && /^noun$/i.test(sense.partOfSpeech) && dictionary.test(sense.definition.trim()));
    return { asset, fromArticle, fromDictionary };
  }).filter((entry) => entry.fromArticle || entry.fromDictionary);
  // Multiple conflicting interpretations cannot safely choose an asset.
  if (candidates.length !== 1) return null;
  const { asset, fromArticle } = candidates[0]!;
  const normal = normalizeAssetText(prompt);
  if (findAssetMentions(normal).some((mention) => mention.id === asset.id)) return null;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(و?)(?:ال)?${escape(normalizeAssetText(topic.term))}(?![\\p{L}\\p{N}_])`, 'gu');
  if ([...normal.matchAll(pattern)].length !== 1) return null;
  const rewritten = normal.replace(pattern, (_whole, conjunction: string) => `${conjunction}${asset.alias}`);
  const requests = parseAssetRequests(rewritten, true);
  if (!requests || requests.filter((item) => item.assetId === asset.id).length !== 1) return null;
  return { term: topic.term, rewritten, assetId: asset.id, assetLabel: asset.label,
    articleTitle: fromArticle ? article!.title : topic.term,
    articleUrl: fromArticle ? article!.url : dictionaryPage(topic.term),
    ...(!fromArticle ? { sourceKind: 'dictionary' as const } : {}) };
}

export function containsApproximation(plan: WorldPlan, match: Approximation): boolean {
  switch (match.assetId) {
    case undefined: return plan.objects.some((o) => o.kind === 'building' && o.variant === 'house');
    case 'tree': return plan.objects.some((o) => o.kind === 'tree');
    case 'boulder': return plan.objects.some((o) => o.kind === 'rock');
    case 'tower': return plan.objects.some((o) => o.kind === 'building' && o.variant === 'tower');
    case 'bridge': return plan.objects.some((o) => o.kind === 'bridge');
    case 'wood-fence': return plan.objects.some((o) => o.kind === 'fence');
    case 'lantern': return plan.objects.some((o) => o.kind === 'lantern');
    case 'sphere': return plan.objects.some((o) => o.kind === 'primitive' && o.primitive === 'sphere');
    default: return false;
  }
}

export async function analyzeApproximation(match: Omit<Approximation, 'color' | 'imageError'>): Promise<Approximation> {
  if (!match.image) return match;
  try { return { ...match, color: await analyzeImageReference(match.image) }; }
  catch (error) { return { ...match, imageError: error instanceof Error ? error.message : 'تعذّر تحليل الصورة.' }; }
}

export function hasExplicitColor(prompt: string): boolean {
  return /احمر|حمراء|ازرق|زرقاء|اخضر|خضراء|اصفر|صفراء|ابيض|بيضاء|اسود|سوداء|بني|بنفسجي|برتقالي|\b(?:red|blue|green|yellow|white|black|brown|purple|orange)\b/iu.test(normalizeAssetText(prompt));
}
