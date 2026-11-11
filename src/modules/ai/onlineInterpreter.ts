import { z } from 'zod';
import { dictionaryResponseSchema, isDictionaryWord, type DictionaryResponse } from './dictionary';
import { imageReferenceSchema, type ImageReference } from './imageReferences';
import { parseHouseKnowledge } from './houseKnowledge';
import { safeWikiUrl, wikiArticleSchema, type WikiArticle } from './wikiReference';
import { applyWikiKnowledge, summarizeKnowledge } from './wikiKnowledge';
import { interpretPromptLocally } from './promptInterpreter';
import type { InterpretOptions, PromptInterpretation } from './types';

/** The phone server mediates Wikipedia and Commons requests; planning remains local and rule-based. */
async function postJSON(path: string, body: object, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      if ((response.status === 404 || response.status === 501) && (['/api/image-search', '/api/image-analyze', '/api/image-pixels', '/api/translate-en', '/api/wiki-article', '/api/dictionary'].includes(path) || response.headers.get('X-World-Builder-Proxy') !== '1')) {
        throw new Error('شغّل خادم الهاتف الجديد world-builder-server.py بدلاً من الخادم القديم.');
      }
      if (path === '/api/image-analyze' || path === '/api/image-pixels') throw new Error(response.status === 503 ? 'تحليل الصور يحتاج python-pillow في Termux.' : 'تعذّر تحليل الصورة المصغرة.');
      if (path === '/api/dictionary') throw new Error('تعذّر الاتصال بقاموس ويكاموس.');
      throw new Error(path === '/api/image-search' ? 'تعذّر البحث في Wikimedia Commons. تحقّق من الإنترنت ثم حاول مجدداً.' : 'تعذّر الاتصال بويكيبيديا. تحقّق من الإنترنت ثم حاول مجدداً.');
    }
    return await response.json();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new Error('تعذّر الاتصال. تحقّق من تشغيل خادم الهاتف والإنترنت.');
    if (error instanceof SyntaxError) throw new Error('استجاب الخادم ببيانات غير صالحة.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
const offsetSchema = z.number().int().min(0).max(2147483647);
const searchResult = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })).max(20), next: offsetSchema.nullable().optional() });
export interface SearchPage<T> { results: T[]; next: number | null }
function checkedNext(next: number | null | undefined, offset: number): number | null {
  if (next == null) return null;
  if (next <= offset) throw new Error('استجاب المصدر بمؤشر متابعة غير صالح.');
  return next;
}

/** One page; consumers can keep requesting pages until the source stops. */
export async function searchWikiArticlePage(query: string, offset = 0, signal?: AbortSignal): Promise<SearchPage<WikiArticle>> {
  if (!query.trim() || query.length > 400 || !offsetSchema.safeParse(offset).success) throw new Error('اكتب موضوعاً للبحث لا يتجاوز 400 حرف.');
  const parsed = searchResult.safeParse(await postJSON('/api/search', { query: query.trim(), ...(offset ? { offset } : {}) }, signal));
  if (!parsed.success) throw new Error('استجابت ويكيبيديا ببيانات بحث غير صالحة.');
  const results = parsed.data.results.filter((item) => item.title.trim() && safeWikiUrl(item.url))
    .map((item) => ({ title: item.title.slice(0, 120), url: item.url, content: item.content.slice(0, 1200) }));
  return { results, next: checkedNext(parsed.data.next, offset) };
}
export async function searchWikiArticles(query: string): Promise<WikiArticle[]> {
  return (await searchWikiArticlePage(query)).results;
}

/** Read the beginning of an exact article, not only the search snippet. */
export async function readWikiArticle(title: string, signal?: AbortSignal): Promise<WikiArticle | null> {
  const parsed = z.object({ article: wikiArticleSchema.nullable() }).safeParse(await postJSON('/api/wiki-article', { query: title }, signal));
  if (!parsed.success) throw new Error('تعذّر قراءة مقدمة المقالة.');
  return parsed.data.article;
}

/** Linked English title, used only after an exact Arabic article match. */
export async function englishWikiTitle(title: string, signal?: AbortSignal): Promise<string | null> {
  const parsed = z.object({ title: z.string().min(1).max(120).nullable() }).safeParse(await postJSON('/api/translate-en', { query: title }, signal));
  if (!parsed.success) throw new Error('تعذّر قراءة رابط اللغة الإنجليزية.');
  return parsed.data.title;
}

/** Look up one word in the English Wiktionary's Arabic, French and English sections. */
export async function lookupDictionary(query: string, signal?: AbortSignal): Promise<DictionaryResponse> {
  if (!isDictionaryWord(query)) throw new Error('البحث المعجمي يقبل كلمة واحدة فقط.');
  const result = dictionaryResponseSchema.safeParse(await postJSON('/api/dictionary', { query }, signal));
  if (!result.success) throw new Error('استجاب القاموس ببيانات غير صالحة.');
  return result.data;
}

/** Analyze one Commons thumbnail in Termux; the server never retains image bytes. */
export async function analyzeImageReference(image: ImageReference): Promise<string> {
  const safe = imageReferenceSchema.parse(image);
  const response = await postJSON('/api/image-analyze', { url: safe.thumbnail });
  const parsed = z.object({ center_color: z.string().regex(/^#[0-9a-f]{6}$/) }).safeParse(response);
  if (!parsed.success) throw new Error('تعذّر تحليل بيانات الصورة.');
  return parsed.data.center_color;
}

/** Download a tiny bounded RGBA copy of a trusted Commons thumbnail. */
export async function readPhotoPixels(image: ImageReference): Promise<import('./photoModel').TinyImage> {
  const safe = imageReferenceSchema.parse(image);
  const parsed = z.object({ width: z.number().int().min(2).max(24), height: z.number().int().min(2).max(24), rgba: z.string().max(3072) }).strict().safeParse(await postJSON('/api/image-pixels', { url: safe.thumbnail }));
  if (!parsed.success) throw new Error('بيانات الصورة غير صالحة.');
  try {
    const bytes = Uint8Array.from(atob(parsed.data.rgba), (c) => c.charCodeAt(0));
    if (bytes.length !== parsed.data.width * parsed.data.height * 4) throw new Error();
    return { width: parsed.data.width, height: parsed.data.height, rgba: bytes };
  } catch { throw new Error('بيانات الصورة غير صالحة.'); }
}

/** Paged Commons search; only free-license, attributed thumbnails are accepted. */
export async function searchImageReferencePage(query: string, offset = 0, signal?: AbortSignal): Promise<SearchPage<ImageReference>> {
  const clean = query.trim();
  if (!clean || clean.length > 400 || !offsetSchema.safeParse(offset).success) throw new Error('اكتب موضوعاً للصور لا يتجاوز 400 حرف.');
  const raw = await postJSON('/api/image-search', { query: clean, ...(offset ? { offset } : {}) }, signal);
  const schema = z.object({ results: z.array(imageReferenceSchema.omit({ query: true })).max(15), next: offsetSchema.nullable().optional() });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error('استجاب مصدر الصور ببيانات غير صالحة.');
  const results = parsed.data.results.map((result) => ({ ...result, query: clean })).filter((image, index, all) => all.findIndex((item) => item.url === image.url) === index);
  return { results, next: checkedNext(parsed.data.next, offset) };
}
export async function searchImageReferences(query: string): Promise<ImageReference[]> {
  return (await searchImageReferencePage(query)).results;
}

export async function interpretOnline(prompt: string, options: InterpretOptions = {}, forceSearch = false, suppressImplicitSearch = false): Promise<PromptInterpretation> {
  const online = z.object({ online: z.literal(true) }).safeParse(await postJSON('/api/online', {}));
  if (!online.success) throw new Error('تعذّر التحقق من اتصال ويكيبيديا.');
  const result = interpretPromptLocally(prompt, options);
  let knowledge = null;
  try { knowledge = summarizeKnowledge(await postJSON('/api/knowledge', {})); } catch { /* Shown explicitly in notes below. */ }
  let houseLearning = null;
  try { houseLearning = parseHouseKnowledge(await postJSON('/api/house-learning', {})); } catch { /* Report below, not silently. */ }
  let usedKnowledge = false;
  if (knowledge) {
    const adjusted = applyWikiKnowledge(result.intent, knowledge);
    result.intent = adjusted.intent;
    usedKnowledge = adjusted.used;
  }
  const searched = forceSearch || (!suppressImplicitSearch && /ابحث|بحث|ويكيبيديا|معلم حقيقي|مكان حقيقي|landmark|wikipedia|search/i.test(prompt));
  const notes = [...(result.notes ?? []), 'المساعد يفهم كلمات محدودة فقط، وليس نموذج لغة عاماً. قد يتجاهل تفاصيل غير معروفة؛ راجع العناصر والتحذيرات. الأشكال إجرائية وليست نموذجاً عاماً لتحويل الصور إلى 3D.'];
  if (result.intent.assets?.some((asset) => asset.relation)) notes.push('الاتجاهات حسب محاور العالم، وليس اتجاه الكاميرا.');
  if (!houseLearning) notes.push('تعذّر قراءة حالة التدريب التجريبي لصور البيوت.');
  else if (houseLearning.status === 'missing_pillow') notes.push('تدريب الصور غير متاح؛ ثبّت python-pillow في Termux.');
  else if (houseLearning.status === 'unavailable') notes.push('تعذّر آخر تدريب للصور؛ تحقّق من الإنترنت أو التخزين.');
  if (!knowledge) notes.push('تعذّر قراءة حالة التعلم من ويكيبيديا في الخادم.');
  else if (knowledge.status === 'unavailable') notes.push('تعذّر تحديث التعلم من ويكيبيديا مؤخراً (الإنترنت أو التخزين)؛ يستخدم التطبيق المعلومات المحفوظة إن وجدت.');
  if (usedKnowledge) notes.push('استُخدمت ارتباطات كلمات تعلّمها التطبيق من مقتطفات ويكيبيديا لتقدير البيئة، وقد تخطئ.');
  let sources: { title: string; url: string; content: string }[] = [];
  if (searched) {
    const query = prompt.replace(/ابحث\s*(?:عن)?|(?:في|من)\s*ويكيبيديا|search\s*(?:for)?|wikipedia/gi, '').trim() || prompt;
    sources = await searchWikiArticles(query);
    // Search text is untrusted: only use a small, fixed vocabulary for biome hints.
    // An explicit biome in the user's own prompt always takes precedence.
    if (!/صحر|غاب|جزير|جبل|desert|forest|island|mountain/i.test(prompt)) {
      const text = sources.map((source) => source.content).join(' ');
      if (/صحراء|desert/i.test(text)) result.intent.biome = 'desert';
      else if (/جزيرة|island/i.test(text)) result.intent.biome = 'island';
      else if (/غابة|forest/i.test(text)) result.intent.biome = 'forest';
      else if (/جبل|mountain/i.test(text)) result.intent.biome = 'mountains';
      if (result.intent.biome !== 'meadow') notes.push('استُخدمت كلمة من نتائج ويكيبيديا لاختيار البيئة؛ تحقق من المصادر فقد تكون النتيجة تقريبية.');
    }
    if (!sources.length) notes.push('لم تظهر مصادر من ويكيبيديا لهذا البحث.');
  }
  return { ...result, providerId: 'tiny-shape-learner', providerLabel: 'المساعد الخفيف المحلي', offline: false,
    ...(houseLearning ? { houseLearning } : {}),
    searched, sources: sources.map(({ title, url }) => ({ title, url })), notes,
    ...(knowledge ? { wikiLearning: { status: knowledge.status, documents: knowledge.sources.length,
      sources: knowledge.sources.slice(-4).reverse().map(({ title, url }) => ({ title, url })), used: usedKnowledge } } : {}) };
}
