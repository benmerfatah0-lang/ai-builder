import { z } from 'zod';
import type { ShapeModel } from './shapeLearner';
const vector = z.tuple([z.number().finite().min(0.55).max(1.8), z.number().finite().min(0.55).max(1.8),
  z.number().finite().min(0.55).max(1.8), z.number().finite().min(0.7).max(1.3)]);
const profile = z.object({ count: z.number().int().min(0).max(100), mean: vector }).strict();
const source = z.object({ title: z.string().max(120), url: z.string().max(1200), author: z.string().max(200), license_url: z.string().max(200) }).strict();
export const houseKnowledgeSchema = z.object({ version: z.literal(1), cursor: z.number().int().min(0).max(79),
  status: z.enum(['starting', 'learning', 'no_new_images', 'no_improvement', 'missing_pillow', 'unavailable']),
  samples: z.number().int().min(0).max(100), profiles: z.object({ default: profile, small: profile, tall: profile, wide: profile }).strict(),
  last_loss: z.number().finite().min(0).max(255).nullable(), sources: z.array(source).max(100),
}).strict();
export type HouseKnowledge = z.infer<typeof houseKnowledgeSchema>;
const licenseRegex = /^https?:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/[1-4]\.0\/|publicdomain\/zero\/1\.0\/)$/;
export function parseHouseKnowledge(value: unknown): HouseKnowledge | null {
  const parsed = houseKnowledgeSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (Object.values(data.profiles).reduce((n, p) => n + p.count, 0) !== data.samples || data.sources.length !== data.samples) return null;
  for (const source of data.sources) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.hostname !== 'commons.wikimedia.org' || url.username || url.password || url.port || !url.pathname.startsWith('/wiki/File:') || url.search || url.hash || !licenseRegex.test(source.license_url)) return null;
    } catch { return null; }
  }
  return data;
}
/** Merge online fits with the user's separately learned local shape average. */
export function applyHouseKnowledge(model: ShapeModel, data: HouseKnowledge, prompt: string): ShapeModel {
  const key = /\b(tall|towering)\b|طويل/i.test(prompt) ? 'tall' : /\b(wide|broad)\b|عريض/i.test(prompt) ? 'wide' : /\b(small|tiny|little)\b|صغير/i.test(prompt) ? 'small' : 'default';
  const preferred = data.profiles[key].count ? data.profiles[key] : data.profiles.default;
  if (!data.samples) return model;
  // If this caption group has no examples, fall back to the weighted corpus average.
  const learned = preferred.count ? preferred.mean : model.house.mean.map((_, i) =>
    Object.values(data.profiles).reduce((sum, p) => sum + p.mean[i]! * p.count, 0) / data.samples);
  const mean = model.house.mean.map((value, i) => (value + learned[i]!) / 2) as ShapeModel['house']['mean'];
  return { ...model, house: { ...model.house, mean } };
}
