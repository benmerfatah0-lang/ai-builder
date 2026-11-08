import { findAssetMentions, normalizeAssetText, parseCountToken } from './assetRequests';
import { lookupDictionary, searchImageReferences, searchWikiArticles } from './onlineInterpreter';
import type { ImageReference } from './imageReferences';
import type { WikiArticle } from './wikiReference';
import { isDictionaryWord, type DictionaryResponse } from './dictionary';
import type { Approximation } from './referenceUnderstanding';

// These are grammar words, supported modifiers and existing environment cues, not a general language model.
const canonical = (word: string) => word.replace(/ة/g, 'ه');
const known = new Set(`و او ثم مع في من علي الي عن ل ب امام قدام خلف وراء يمين يسار شمال بالقرب قرب بجانب بجوار
اصنع انشئ ابن ابني ابناء اريد اريدك صمم اعمل ضع اضف حرك لون كبر صغر احذف انقل اجعل غير
عالم عالما خريطه مشهد مكان بيئه مجسم العنصر المحدد المختار
صغير صغيره كبير كبيره ضخم ضخمه طويل طويله عريض عريضه واسع واسعه مرتفع مرتفعه قديم قديمه حديث حديثه جميل جميله
احمر حمراء ازرق زرقاء اخضر خضراء اصفر صفراء ابيض بيضاء اسود سوداء بني بنفسجي برتقالي
صحراء صحراوي صحراويه غابه غابات جبل جبال جزيره جزر استوائي استوائيه بحر بحيره نهر انهار وادي وديان واحة واحات رمال
مرج مروج سهل سهول مزرعه مزارع مدينه مدن قريه قري قرية حضاره اثار اطلال منجم ذهب عميق عميقه
نهار يوم ليل ليله صباح مساء غروب شروق شمس كثيف كثيفه قليل قليله عدد بدون دون بلا تحتوي تحتويه يوجد فيها فيه لها
ابحث بحث ويكيبيديا عند حول وسط علي سطح حقيقي حقيقيه عن شكل صور صورة صوره
create make build add put place move delete remove paint color colour enlarge shrink change a an the and or with in on at of to for from near next beside right left behind front above below
world map scene area landscape terrain small tiny little large big huge tall wide old new beautiful red blue green yellow white black brown purple orange
forest forests jungle desert deserts oasis oases mountain mountains island islands lake sea ocean river rivers meadow grassland plain farm city village ruins mine gold day night sunset sunrise dense sparse
cartoon natural stylized low poly farmhouse connected dirt wheat wheatfield grass bright sparse normal
search wikipedia real image pictures picture photo photos
crée creer créez construire construis fais fabrique ajouter ajoute place un une le la les des du de dans avec et ou sur pour pres près monde carte scene scène petit petite grand grande vieux vieille rouge bleu vert jaune blanc noir`.split(/\s+/u).map(canonical));
const NEGATIONS = new Set(['بدون', 'دون', 'بلا', 'without', 'no']);

/** Best-effort candidate extraction, including unknown nouns alongside known assets. */
export function unknownTopics(prompt: string): { terms: string[]; truncated: boolean } {
  const text = normalizeAssetText(prompt).slice(0, 400);
  const mentions = findAssetMentions(text);
  const terms: string[] = [];
  let phrase: string[] = [];
  let negateNext = false;
  let previous = '';
  const noConjunctionAfter = new Set('في من علي الي عن ل ب مع بجانب قرب اضف اصنع انشئ ابن ابني ضع اريد اريدك صمم اعمل حرك احذف لون كبر صغر'.split(' '));
  const flush = () => { if (phrase.length) terms.push(phrase.join(' ')); phrase = []; };
  for (const token of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = token[0];
    const start = token.index;
    if (mentions.some((item) => start < item.end && start + raw.length > item.start)) { previous = canonical(raw); flush(); negateNext = false; continue; }
    const word = canonical(raw);
    const stripped = word.startsWith('و') && word.length > 2 ? word.slice(1) : word;
    const bare = (value: string) => value.startsWith('ال') && value.length > 3 ? value.slice(2) : value.startsWith('لل') && value.length > 4 ? value.slice(2) : value;
    const prior = previous;
    previous = word;
    if (NEGATIONS.has(word)) { flush(); negateNext = true; continue; }
    if (/^\d+$/u.test(raw) || parseCountToken(raw) !== undefined || parseCountToken(stripped) !== undefined ||
        known.has(word) || known.has(bare(word)) || known.has(stripped) || known.has(bare(stripped)) || raw.length < 2) {
      flush();
      continue;
    }
    if (negateNext) { negateNext = false; flush(); continue; }
    const conjunction = raw.startsWith('و') && raw.length > 2 && prior && !noConjunctionAfter.has(prior);
    if (conjunction) flush();
    phrase.push(conjunction ? raw.slice(1) : raw);
    if (phrase.length === 3) flush();
  }
  flush();
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  return { terms: unique.slice(0, 2), truncated: unique.length > 2 };
}

export interface TopicResearch {
  term: string;
  articles: WikiArticle[];
  images: ImageReference[];
  wikiError: string | null;
  imageError: string | null;
  dictionary?: DictionaryResponse;
  dictionaryError?: string | null;
}
export interface ResearchReport { topics: TopicResearch[]; truncated: boolean; approximation?: Approximation }
export async function researchUnknown(prompt: string): Promise<ResearchReport> {
  const { terms, truncated } = unknownTopics(prompt);
  const topics = await Promise.all(terms.map(async (term): Promise<TopicResearch> => {
    const [wiki, images, dictionary] = await Promise.allSettled([searchWikiArticles(term), searchImageReferences(term),
      isDictionaryWord(term) ? lookupDictionary(term) : Promise.reject(new Error('البحث المعجمي يقبل كلمة واحدة فقط.'))]);
    const message = (reason: unknown) => reason instanceof Error ? reason.message : 'تعذّر الاتصال بالمصدر.';
    return { term, articles: wiki.status === 'fulfilled' ? wiki.value : [], images: images.status === 'fulfilled' ? images.value : [],
      wikiError: wiki.status === 'rejected' ? message(wiki.reason) : null, imageError: images.status === 'rejected' ? message(images.reason) : null,
      ...(dictionary.status === 'fulfilled' ? { dictionary: dictionary.value, dictionaryError: null } : { dictionaryError: message(dictionary.reason) }) };
  }));
  return { topics, truncated };
}
