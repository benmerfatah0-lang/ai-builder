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


interface ContentItem { type?: string; text?: string; annotations?: unknown[] }
interface OutputItem { type?: string; status?: string; content?: ContentItem[] }
interface ApiResponse { status?: string; output?: OutputItem[] }

function citations(output: OutputItem[]): { title: string; url: string }[] {
  const sources: { title: string; url: string }[] = [];
  for (const item of output) for (const content of item.content ?? []) {
    for (const annotation of content.annotations ?? []) {
      if (!annotation || typeof annotation !== 'object') continue;
      const data = annotation as Record<string, unknown>;
      // Responses annotations may expose the citation directly or nested.
      const nested = data.url_citation && typeof data.url_citation === 'object'
        ? data.url_citation as Record<string, unknown> : data;
      if (data.type !== 'url_citation' || typeof nested.url !== 'string') continue;
      try {
        const url = new URL(nested.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (sources.some((source) => source.url === url.href)) continue;
        sources.push({ title: typeof nested.title === 'string' ? nested.title.slice(0, 120) : url.hostname, url: url.href });
      } catch { /* Ignore invalid or unsafe URLs from the remote response. */ }
      if (sources.length >= 8) return sources;
    }
  }
  return sources;
}

function httpError(status: number): string {
  if (status === 401 || status === 403) return 'تعذّر التحقق من مفتاح API أو صلاحياته. راجع المفتاح وإعدادات الحساب.';
  if (status === 404) return 'النموذج غير متاح لهذا الحساب. راجع صلاحيات النموذج في OpenAI.';
  if (status === 429) return 'تم تجاوز حد الطلبات أو الرصيد. راجع حدود الاستخدام والفوترة ثم حاول مجدداً.';
  return `تعذّر الاتصال بخدمة الذكاء الاصطناعي (رمز ${status}). حاول مجدداً.`;
}

/** Sends the prompt directly to OpenAI. Storage of the key is controlled separately by the local vault. */
export async function interpretOnline(
  prompt: string,
  apiKey: string,
  options: InterpretOptions = {},
): Promise<PromptInterpretation> {
  if (!apiKey.trim()) throw new Error('أدخل مفتاح OpenAI API داخل التطبيق لتفعيل البحث والإنشاء.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000);
  let response: Response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
      body: JSON.stringify(createOnlineRequest(prompt)),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('انتهت مهلة الاتصال. تحقّق من الإنترنت وحاول مجدداً.');
    throw new Error('تعذّر الاتصال بالإنترنت أو بخدمة OpenAI. تحقّق من الاتصال وحاول مجدداً.');
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) throw new Error(httpError(response.status));
  let responseData: ApiResponse;
  try {
    const envelope = z.object({
      status: z.string().optional(),
      output: z.array(z.object({
        type: z.string().optional(), status: z.string().optional(),
        content: z.array(z.object({ type: z.string().optional(), text: z.string().optional(), annotations: z.array(z.unknown()).optional() }).passthrough()).optional(),
      }).passthrough()).optional(),
    }).passthrough();
    responseData = envelope.parse(await response.json());
  } catch { throw new Error('استجابت الخدمة ببيانات غير صالحة. حاول مجدداً.'); }
  if (responseData.status && responseData.status !== 'completed') throw new Error('لم يكتمل رد الذكاء الاصطناعي. حاول وصفاً أقصر أو أعد المحاولة.');
  const output = Array.isArray(responseData.output) ? responseData.output : [];
  const message = output.filter((item) => item.type === 'message').flatMap((item) => item.content ?? [])
    .find((item) => item.type === 'output_text' && typeof item.text === 'string');
  let raw: unknown;
  try { raw = JSON.parse(message?.text ?? ''); }
  catch { throw new Error('لم تُرجع الخدمة مخططاً صالحاً للعالم. حاول مجدداً.'); }
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
    providerId: 'openai-web', providerLabel: 'OpenAI', offline: false,
    sources: citations(output), notes,
    searched: output.some((item) => item.type === 'web_search_call' && item.status === 'completed'),
  };
}
