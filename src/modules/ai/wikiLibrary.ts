import { z } from 'zod';
import type { WorldIntent } from './types';
import { BIOME_PROFILES } from '../../core/generation/biomes';

// A small, user-selected notebook, not a copy of Wikipedia or a trained model.
export const WIKI_LIBRARY_KEY = 'worldforge-wiki-notebook-v1';
export const WIKI_LIBRARY_LIMIT = 40;
export const wikiArticleSchema = z.object({
  title: z.string().min(1).max(120),
  url: z.string().max(1200).refine(safeWikiUrl),
  content: z.string().max(1200),
}).strict();
export type WikiArticle = z.infer<typeof wikiArticleSchema>;

export function safeWikiUrl(url: string): boolean {
  if (url.length > 1200) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['ar.wikipedia.org', 'en.wikipedia.org'].includes(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port && parsed.pathname.startsWith('/wiki/') && !parsed.search && !parsed.hash;
  } catch { return false; }
}

export function readWikiLibrary(storage: Storage): WikiArticle[] {
  const raw = storage.getItem(WIKI_LIBRARY_KEY);
  if (!raw) return [];
  if (raw.length > 200_000) throw new Error('ملف مكتبة ويكيبيديا المحلية غير صالح؛ لم تُحذف بياناته.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('ملف مكتبة ويكيبيديا المحلية غير صالح؛ لم تُحذف بياناته.'); }
  const result = z.array(wikiArticleSchema).max(WIKI_LIBRARY_LIMIT).safeParse(parsed);
  if (!result.success || new Set(result.data.map((item) => item.url)).size !== result.data.length) throw new Error('ملف مكتبة ويكيبيديا المحلية غير صالح؛ لم تُحذف بياناته.');
  return result.data;
}

export function saveWikiArticle(storage: Storage, article: WikiArticle): WikiArticle[] {
  const entry = wikiArticleSchema.parse(article);
  const previous = readWikiLibrary(storage);
  const next = [entry, ...previous.filter((item) => item.url !== entry.url)].slice(0, WIKI_LIBRARY_LIMIT);
  storage.setItem(WIKI_LIBRARY_KEY, JSON.stringify(next));
  return next;
}

export function removeWikiArticle(storage: Storage, url: string): WikiArticle[] {
  const next = readWikiLibrary(storage).filter((item) => item.url !== url);
  storage.setItem(WIKI_LIBRARY_KEY, JSON.stringify(next));
  return next;
}

/** Only unambiguous fixed terrain words are used. Wikipedia prose is not executable instructions. */
export function applySavedWikiArticle(intent: WorldIntent, article: WikiArticle): { intent: WorldIntent; hint: string } {
  if (intent.features?.farm || intent.biome !== 'meadow' || /مرج|مروج|سهل|meadow|grassland|plain|savanna/i.test(intent.prompt)) {
    return { intent, hint: 'حُفظ اختيارك للمرجع، لكن بيئة الوصف الصريحة لم تتغير.' };
  }
  const text = `${article.title} ${article.content}`;
  const matches = [
    { biome: 'desert' as const, pattern: /صحراء|صحرائي|صحراوي|كثبان|واحة|\bdesert\b|\boasis\b/i },
    { biome: 'forest' as const, pattern: /غابة|غابات|أحراش|\bforest\b|\bwoodland\b/i },
    { biome: 'mountains' as const, pattern: /جبل|جبال|جبلي|\bmountain\b|\bmountains\b/i },
    { biome: 'island' as const, pattern: /جزيرة|جزر|أرخبيل|\bisland\b|\barchipelago\b/i },
  ].filter(({ pattern }) => pattern.test(text));
  if (matches.length !== 1) return { intent, hint: 'لم يستطع التطبيق استنتاج بيئة واحدة واضحة من المقتطف المحفوظ؛ لم تُغيّر بيئة الوصف.' };
  const biome = matches[0]!.biome;
  return { intent: { ...intent, biome,
    summary: intent.summary.replace(/^Meadow/, BIOME_PROFILES[biome].label),
    cues: [...intent.cues.map((cue) => cue.startsWith('biome: ') ? `biome: ${biome}` : cue), `saved Wikipedia terrain: ${biome}`] },
    hint: 'استُخدمت كلمة تضاريس من المرجع المحفوظ لتقدير البيئة فقط؛ تحقق من المصدر فقد يخطئ التقدير.' };
}
