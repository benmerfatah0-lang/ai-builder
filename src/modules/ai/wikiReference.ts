import { z } from 'zod';
import type { WorldIntent } from './types';
import { BIOME_PROFILES } from '../../core/generation/biomes';

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

/** Only unambiguous fixed terrain words are used. Wikipedia prose is not executable instructions. */
export function applyWikiArticleHint(intent: WorldIntent, article: WikiArticle): { intent: WorldIntent; hint: string } {
  if (intent.features?.farm || intent.biome !== 'meadow' || /مرج|مروج|سهل|meadow|grassland|plain|savanna/i.test(intent.prompt)) {
    return { intent, hint: 'لم تُغيّر بيئة الوصف الصريحة.' };
  }
  const text = `${article.title} ${article.content}`;
  const matches = [
    { biome: 'desert' as const, pattern: /صحراء|صحرائي|صحراوي|كثبان|واحة|\bdesert\b|\boasis\b/i },
    { biome: 'forest' as const, pattern: /غابة|غابات|أحراش|\bforest\b|\bwoodland\b/i },
    { biome: 'mountains' as const, pattern: /جبل|جبال|جبلي|\bmountain\b|\bmountains\b/i },
    { biome: 'island' as const, pattern: /جزيرة|جزر|أرخبيل|\bisland\b|\barchipelago\b/i },
  ].filter(({ pattern }) => pattern.test(text));
  if (matches.length !== 1) return { intent, hint: 'لم يستطع التطبيق استنتاج بيئة واحدة واضحة من المقتطف؛ لم تُغيّر بيئة الوصف.' };
  const biome = matches[0]!.biome;
  return { intent: { ...intent, biome,
    summary: intent.summary.replace(/^Meadow/, BIOME_PROFILES[biome].label),
    cues: [...intent.cues.map((cue) => cue.startsWith('biome: ') ? `biome: ${biome}` : cue), `Wikipedia terrain hint: ${biome}`] },
    hint: 'استُخدمت كلمة تضاريس من مقتطف ويكيبيديا لتقدير البيئة فقط؛ تحقق من المصدر فقد يخطئ التقدير.' };
}
