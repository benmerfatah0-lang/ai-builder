import { z } from 'zod';
import { interpretPromptLocally } from './promptInterpreter';
import type { WorldIntent } from './types';

const labels = ['desert', 'forest', 'mountains', 'island'] as const;
const category = z.object({ docs: z.number().int().min(0).max(200), tokens: z.record(z.string().max(32), z.number().int().min(0).max(200)) }).strict();
const source = z.object({ label: z.enum(labels), title: z.string().max(120), url: z.string().max(1200) }).strict();
export const knowledgeSchema = z.object({ version: z.literal(1), cursor: z.number().int().min(0).max(100),
  status: z.enum(['starting', 'learning', 'no_new_articles', 'unavailable', 'capacity']),
  classes: z.object({ desert: category, forest: category, mountains: category, island: category }).strict(),
  sources: z.array(source).max(200),
}).strict();
export type WikiKnowledge = z.infer<typeof knowledgeSchema>;

const vocabulary = new Set(['desert', 'deserts', 'arid', 'dune', 'dunes', 'oasis', 'oases', 'sand',
  'forest', 'forests', 'woodland', 'rainforest', 'canopy', 'jungle', 'mountain', 'mountains', 'alpine', 'summit', 'peak', 'canyon', 'cliff',
  'island', 'islands', 'archipelago', 'atoll', 'islet', 'coast', 'صحراء', 'صحراوي', 'قاحلة', 'رمال', 'كثبان', 'واحة', 'واحات',
  'غابة', 'غابات', 'احراش', 'ادغال', 'جبل', 'جبال', 'مرتفعات', 'قمة', 'قمم', 'جزيرة', 'جزر', 'ارخبيل', 'سواحل']);
function words(text: string): string[] {
  const normal = text.toLowerCase().replace(/[\u064b-\u065f\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
  return [...new Set((normal.match(/[\p{L}]+/gu) ?? []).map((word) => word.startsWith('ال') && word.length > 3 ? word.slice(2) : word).filter((word) => vocabulary.has(word)))];
}
function safeSource(url: string) {
  try { const u = new URL(url); return u.protocol === 'https:' && ['ar.wikipedia.org', 'en.wikipedia.org'].includes(u.hostname) && !u.username && !u.password && u.pathname.startsWith('/wiki/') && !u.search && !u.hash; }
  catch { return false; }
}
export function summarizeKnowledge(value: unknown) {
  const parsed = knowledgeSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  for (const label of labels) {
    const entry = data.classes[label];
    if (Object.entries(entry.tokens).some(([key, count]) => !vocabulary.has(key) || count > entry.docs)) return null;
  }
  if (data.sources.some((s) => !safeSource(s.url)) || labels.reduce((sum, label) => sum + data.classes[label].docs, 0) !== data.sources.length) return null;
  return data;
}

/** Use learned associations only if the normal interpreter has no clear biome. */
export function applyWikiKnowledge(intent: WorldIntent, data: WikiKnowledge): { intent: WorldIntent; used: boolean } {
  if (intent.biome !== 'meadow' || intent.features?.farm || /مرج|مروج|سهل|meadow|grassland|plain|savanna/i.test(intent.prompt)) return { intent, used: false };
  const features = words(intent.prompt);
  if (!features.length) return { intent, used: false };
  const scores = labels.map((label) => {
    const entry = data.classes[label];
    if (!entry.docs) return { label, score: 0 };
    const score = features.reduce((total, word) => total + (entry.tokens[word] ?? 0) / entry.docs, 0);
    return { label, score };
  }).sort((a, b) => b.score - a.score);
  if (!scores[0] || scores[0].score < 0.25 || (scores[1] && scores[0].score - scores[1].score < 0.15)) return { intent, used: false };
  const interpreted = interpretPromptLocally(`${intent.prompt} ${scores[0].label}`, {
    seed: intent.seed, scale: intent.scale, ...(intent.style ? { style: intent.style } : {}), ...(intent.density ? { density: intent.density } : {}),
  }).intent;
  // Do not reinterpret user-specified quantities or individual assets.
  const explicit = /[0-9٠-٩۰-۹]|\b(?:one|two|three|four|five|six|ten)\b|واحد|اثنين|اثنان|ثلاث|اربع|أربع|خمس|عشر/i.test(intent.prompt);
  return { used: true, intent: { ...interpreted, prompt: intent.prompt, name: intent.name,
    assets: intent.assets, ...(explicit ? { counts: intent.counts } : {}) } };
}
