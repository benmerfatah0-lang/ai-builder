import { z } from 'zod';
import { interpretPromptLocally } from './promptInterpreter';
import type { AssetRequest } from './assetRequests';
import type { InterpretOptions, PromptInterpretation } from './types';

import { ASSETS, DIRECTIONS, BIOMES, TIMES, SCALES, STYLES, DENSITIES, createOnlineRequest, createSearchDecisionRequest } from './onlineRequest';

const planSchema = z.object({
  biome: z.enum(BIOMES), timeOfDay: z.enum(TIMES), water: z.boolean(),
  scale: z.enum(SCALES), style: z.enum(STYLES), density: z.enum(DENSITIES),
  assets: z.array(z.object({
    assetId: z.enum(ASSETS), count: z.number().int().min(1).max(100),
    direction: z.enum(DIRECTIONS).nullable(), target: z.number().int().min(0).nullable(),
  }).strict()).max(24),
  summary: z.string().min(1).max(300),
  limitations: z.array(z.string().min(1).max(300)).max(8),
}).strict();


type SearchResult = { title: string; url: string; content: string };
async function postJSON(url: string, body: object, service: string): Promise<unknown> {
  const controller = new AbortController();
  // Local generation on a phone can take several minutes.
  const timeout = setTimeout(() => controller.abort(), url === '/api/model' ? 600000 : 45000);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) {
      if ((response.status === 404 || response.status === 501) && response.headers.get('X-World-Builder-Proxy') !== '1') throw new Error('شغّل خادم الهاتف الجديد world-builder-server.py بدلاً من الخادم القديم.');
      if (service === 'النموذج المحلي') throw new Error('النموذج المحلي غير جاهز أو تعذّر تشغيله. تأكّد من بدء الخادم وانتظر تحميل النموذج.');
      throw new Error('تعذّر الاتصال بويكيبيديا. تحقّق من الإنترنت ثم حاول مجدداً.');
    }
    try { return await response.json(); }
    catch { throw new Error(`استجابت ${service} ببيانات غير صالحة.`); }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`انتهت مهلة ${service}. حاول وصفاً أبسط.`);
    if (error instanceof TypeError) throw new Error(`تعذّر الاتصال بـ ${service}. تحقّق من تشغيل خادم الهاتف والإنترنت.`);
    throw error;
  } finally { clearTimeout(timeout); }
}
async function localJSON(request: object): Promise<unknown> {
  const envelope = z.object({ choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.string().nullable().optional() }).passthrough(),
  }).passthrough()).min(1) }).passthrough().safeParse(await postJSON('/api/model', request, 'النموذج المحلي'));
  if (!envelope.success) throw new Error('استجاب النموذج المحلي ببيانات غير صالحة.');
  const choice = envelope.data.choices[0]!;
  if (choice.finish_reason && choice.finish_reason !== 'stop') throw new Error('لم يكتمل رد النموذج المحلي. حاول وصفاً أقصر.');
  try { return JSON.parse(choice.message.content ?? ''); }
  catch { throw new Error('لم يُرجع النموذج المحلي مخططاً صالحاً. حاول مجدداً.'); }
}
async function searchWiki(query: string): Promise<SearchResult[]> {
  const response = await postJSON('/api/search', { query }, 'ويكيبيديا');
  const envelope = z.object({ results: z.array(z.object({
    title: z.string(), url: z.string(), content: z.string(),
  }).passthrough()).max(20) }).passthrough().safeParse(response);
  if (!envelope.success) throw new Error('استجابت ويكيبيديا ببيانات بحث غير صالحة.');
  const sources: SearchResult[] = [];
  for (const item of envelope.data.results) {
    try {
      const url = new URL(item.url);
      if (url.protocol === 'https:' && (url.hostname === 'ar.wikipedia.org' || url.hostname === 'en.wikipedia.org') && !sources.some((source) => source.url === url.href)) {
        sources.push({ title: item.title.slice(0, 120) || url.hostname, url: url.href, content: item.content.slice(0, 1200) });
      }
    } catch { /* Never display unsafe links. */ }
    if (sources.length === 4) break;
  }
  return sources;
}

/** Require a live internet check; the local model decides if Wikipedia search is needed. */
export async function interpretOnline(
  prompt: string,
  options: InterpretOptions = {},
): Promise<PromptInterpretation> {
  await postJSON('/api/online', {}, 'ويكيبيديا');
  const decision = z.object({ query: z.string().trim().min(1).max(400).nullable() }).strict()
    .safeParse(await localJSON(createSearchDecisionRequest(prompt)));
  if (!decision.success) throw new Error('تعذّر تحديد حاجة الوصف للبحث. حاول مجدداً.');
  const searched = decision.data.query !== null;
  const references = searched ? await searchWiki(decision.data.query!) : [];
  const raw = await localJSON(createOnlineRequest(prompt, references));
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new Error('المخطط الذي أعادته الخدمة غير مدعوم. حاول وصفاً أبسط.');
  const data = parsed.data;
  if (data.assets.reduce((sum, asset) => sum + asset.count, 0) > 300) throw new Error('المخطط يحتوي عناصر كثيرة جداً. اطلب عدداً أقل.');
  const assets: AssetRequest[] = data.assets.map((asset, index) => {
    const valid = asset.direction !== null && asset.target !== null && asset.target < data.assets.length && asset.target !== index;
    return { assetId: asset.assetId, count: asset.count, ...(valid ? { relation: { target: asset.target!, direction: asset.direction! } } : {}) };
  });
  const local = interpretPromptLocally(`${data.biome} ${data.timeOfDay}${data.water ? ' water' : ''}`, options).intent;
  const original = interpretPromptLocally(prompt, options).intent;
  const notes = [...data.limitations];
  if (original.features?.farm) notes.push('للمزارع يُستخدم قالب المزرعة المتاح، وقد يختلف ترتيب عناصره عن المخطط المقترح.');
  if (data.assets.some((asset, index) => (asset.direction === null) !== (asset.target === null) || asset.target === index || (asset.target !== null && asset.target >= data.assets.length))) {
    notes.push('تعذّر فهم بعض علاقات المواضع، فاستُخدم توزيع بديل.');
  }
  return {
    intent: {
      ...local, prompt, name: original.name, seed: original.seed, biome: data.biome, timeOfDay: data.timeOfDay,
      water: data.water, scale: options.scale ?? data.scale, style: options.style ?? data.style,
      density: options.density ?? data.density, features: original.features,
      assets: assets.length ? assets : undefined, summary: data.summary,
      cues: assets.length ? assets.map((asset) => `${asset.count} ${asset.assetId}`) : [`biome: ${data.biome}`],
    },
    providerId: 'local-wikipedia', providerLabel: 'Qwen محلي + ويكيبيديا', offline: false,
    sources: references.map(({ title, url }) => ({ title, url })), notes, searched,
  };
}
