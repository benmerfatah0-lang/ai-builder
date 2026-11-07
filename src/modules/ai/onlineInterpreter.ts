import { z } from 'zod';
import { interpretPromptLocally } from './promptInterpreter';
import type { AssetRequest } from './assetRequests';
import type { InterpretOptions, PromptInterpretation } from './types';

import { ASSETS, DIRECTIONS, BIOMES, TIMES, SCALES, STYLES, DENSITIES, createOnlineRequest } from './onlineRequest';

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


export type GeminiModel = 'gemini-2.5-flash' | 'gemini-2.5-flash-lite';

function httpError(status: number): string {
  if (status === 400 || status === 401 || status === 403) return 'تعذّر استخدام مفتاح Gemini أو الميزة في حسابك. راجع المفتاح وصلاحيات الحساب.';
  if (status === 404) return 'النموذج غير متاح لهذا الحساب. جرّب النموذج الآخر أو راجع النماذج المتاحة في Google AI Studio.';
  if (status === 429) return 'تم بلوغ حد الاستخدام. انتظر أو راجع الحصة المجانية في Google AI Studio.';
  return `تعذّر الاتصال بخدمة Gemini (رمز ${status}). حاول مجدداً.`;
}

/** Gemini uses a free tier when the user's project and model qualify. */
export async function interpretOnline(
  prompt: string,
  apiKey: string,
  options: InterpretOptions = {},
  model: GeminiModel = 'gemini-2.5-flash',
): Promise<PromptInterpretation> {
  if (!apiKey.trim()) throw new Error('أدخل مفتاح Gemini API داخل التطبيق لتفعيل البحث والإنشاء.');
  if (model !== 'gemini-2.5-flash' && model !== 'gemini-2.5-flash-lite') throw new Error('النموذج غير مدعوم.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey.trim() },
      body: JSON.stringify(createOnlineRequest(prompt)), signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال. تحقّق من الإنترنت وحاول مجدداً.');
    throw new Error('تعذّر الاتصال بالإنترنت أو بخدمة Gemini. تحقّق من الاتصال وحاول مجدداً.');
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(httpError(response.status));
  const envelope = z.object({
    candidates: z.array(z.object({
      finishReason: z.string().optional(),
      content: z.object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() }).passthrough()) }).optional(),
      groundingMetadata: z.object({
        webSearchQueries: z.array(z.string()).optional(),
        groundingChunks: z.array(z.object({ web: z.object({ uri: z.string().optional(), title: z.string().optional() }).optional() }).passthrough()).optional(),
      }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough();
  const parsedEnvelope = envelope.safeParse(await response.json().catch(() => null));
  const candidate = parsedEnvelope.success ? parsedEnvelope.data.candidates?.[0] : undefined;
  if (!candidate || (candidate.finishReason && candidate.finishReason !== 'STOP')) throw new Error('لم يكتمل رد Gemini. جرّب وصفاً أبسط أو أعد المحاولة.');
  const text = candidate.content?.parts.filter((part) => !part.thought).map((part) => part.text ?? '').join('').trim() ?? '';
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try { raw = JSON.parse(json); }
  catch { throw new Error('لم تُرجع الخدمة مخططاً صالحاً للعالم. حاول مجدداً.'); }
  const sources: { title: string; url: string }[] = [];
  for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
    try {
      const url = new URL(chunk.web?.uri ?? '');
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !sources.some((item) => item.url === url.href)) {
        sources.push({ url: url.href, title: chunk.web?.title?.slice(0, 120) || url.hostname });
      }
    } catch { /* Ignore invalid links from the service. */ }
    if (sources.length >= 8) break;
  }
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
    providerId: 'gemini-web', providerLabel: 'Gemini', offline: false,
    sources, notes, searched: Boolean(candidate.groundingMetadata?.webSearchQueries?.length),
  };
}
