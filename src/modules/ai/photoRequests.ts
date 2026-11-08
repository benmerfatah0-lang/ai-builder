import { directionBetween, findAssetMentions, normalizeAssetText, parseCountToken, type AssetDirection } from './assetRequests';
import type { TopicResearch } from './unknownResearch';

export interface PhotoRequest { topic: TopicResearch; count: number; relation?: { assetId: string; direction: AssetDirection } }
export interface PhotoRequestPlan { requests: PhotoRequest[]; warnings: string[] }

/** Conservative interpretation: distinct single mentions and explicit adjacent counts.
 * Spatial relations and other specifications are not silently ignored. */
export function planPhotoRequests(prompt: string, topics: TopicResearch[]): PhotoRequestPlan {
  const text = normalizeAssetText(prompt);
  const requests: PhotoRequest[] = [], warnings: string[] = [];
  const direction = directionBetween(text);
  const known = findAssetMentions(text);
  const complexRelation = /(?:فوق|تحت|داخل|خارج|بين|حول|علي سطح|above|below|inside|under|between|around)/iu.test(text);
  if ((complexRelation || (direction && (topics.length !== 1 || known.length !== 1))) && topics.length) {
    return { requests, warnings: ['لم تُنشأ العناصر المجهولة من الصور لأن علاقتها المكانية في هذا الوصف غير مضمونة؛ قسّم الطلب أو أضفها دون تحديد علاقة.'] };
  }
  const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const topic of topics) {
    const term = normalizeAssetText(topic.term).trim().replace(/^ال/u, '');
    if (!term || term.length > 400) { warnings.push(`تعذّر تحديد «${topic.term.slice(0,80)}» للإنشاء.`); continue; }
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:و?ال|و)?${escape(term)}(?![\\p{L}\\p{N}_])`, 'gu');
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) { warnings.push(`لم يُنشأ «${topic.term}»: تكرار أو موضع غير واضح.`); continue; }
    const match=matches[0]!, start=match.index!, end=start+match[0].length;
    let relation: PhotoRequest['relation'];
    if (direction) {
      const target = known[0]!;
      const gap = text.slice(end, target.start).trim();
      // Only “photo object right/left/in front/behind/near known object”.
      if (end > target.start || !/^(?:(?:علي|الى|في|to the|of the|the)\s+)*(?:يمين|يسار|شمال|امام|قدام|خلف|وراء|بجانب|بجوار|قرب|بالقرب|right of|left of|in front of|behind|next to|near|beside)(?:\s+(?:من|of|the))?$/u.test(gap)) {
        warnings.push(`لم يُنشأ «${topic.term}»: العلاقة المكانية غير واضحة.`); continue;
      }
      relation = { assetId: target.id, direction };
    }
    const before=text.slice(0,start), after=text.slice(end);
    const prev=before.match(/([\p{L}\p{N}]+)\s*$/u)?.[1];
    const next=after.match(/^\s+([\p{L}\p{N}]+)/u)?.[1];
    const number = (token: string | undefined) => parseCountToken(token) ?? (token?.startsWith('و') ? parseCountToken(token.slice(1)) : undefined);
    const count = number(prev);
    if (prev && /^و?\d+$/u.test(prev) && count === undefined) { warnings.push(`لم يُنشأ «${topic.term}»: العدد خارج النطاق المفهوم.`); continue; }
    if (next && !next.startsWith('و') && number(next) !== undefined) { warnings.push(`لم يُنشأ «${topic.term}»: ضع العدد قبل الاسم لتجنب اللبس.`); continue; }
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 1)) { warnings.push(`لم يُنشأ «${topic.term}»: العدد غير صالح.`); continue; }
    if (count === undefined && (/(?:ين|ان|ات)$/u.test(term) || /s$/iu.test(term))) { warnings.push(`لم يُنشأ «${topic.term}»: العدد أو صيغة الكلمة غير واضحة.`); continue; }
    if ((prev && /^(?:صغير(?:ه|ة)?|كبير(?:ه|ة)?|ضخم(?:ه|ة)?|طويل(?:ه|ة)?|عريض(?:ه|ة)?|احمر|ازرق|اخضر|اصفر|ابيض|اسود|بني|red|blue|green|small|large|big|tall|wide)$/iu.test(prev)) || /^(?:\s+)(?:ال)?(?:صغير(?:ة|ه)?|كبير(?:ة|ه)?|ضخم(?:ة|ه)?|طويل(?:ة|ه)?|عريض(?:ة|ه)?|احمر|ازرق|اخضر|اصفر|ابيض|اسود|بني|red|blue|green|small|large|big|tall|wide)(?![\p{L}])/iu.test(after)) {
      warnings.push(`لم يُنشأ «${topic.term}»: لم يُفهم الحجم أو اللون المطلوب من الصورة.`); continue;
    }
    if (!topic.images.length && topic.imageNext == null) { warnings.push(topic.imageError ? `تعذّر البحث عن صور «${topic.term}»؛ لم يُنشأ. ${topic.imageError}` : `لم أجد صوراً مناسبة لـ «${topic.term}»؛ لم يُنشأ.`); continue; }
    requests.push({ topic, count: count ?? 1, ...(relation ? { relation } : {}) });
  }
  return { requests, warnings };
}
