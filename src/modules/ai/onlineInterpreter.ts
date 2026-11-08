import { z } from 'zod';
import { parseHouseKnowledge } from './houseKnowledge';
import { applyWikiKnowledge, summarizeKnowledge } from './wikiKnowledge';
import { interpretPromptLocally } from './promptInterpreter';
import type { InterpretOptions, PromptInterpretation } from './types';

/** Wikipedia is the only network source; all planning is rule-based on-device. */
async function postJSON(path: string, body: object): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      if ((response.status === 404 || response.status === 501) && response.headers.get('X-World-Builder-Proxy') !== '1') {
        throw new Error('شغّل خادم الهاتف الجديد world-builder-server.py بدلاً من الخادم القديم.');
      }
      throw new Error('تعذّر الاتصال بويكيبيديا. تحقّق من الإنترنت ثم حاول مجدداً.');
    }
    return await response.json();
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new Error('تعذّر الاتصال. تحقّق من تشغيل خادم الهاتف والإنترنت.');
    if (error instanceof SyntaxError) throw new Error('استجاب الخادم ببيانات غير صالحة.');
    throw error;
  } finally { clearTimeout(timeout); }
}
const searchResult = z.object({ results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })).max(20) });

export async function interpretOnline(prompt: string, options: InterpretOptions = {}, forceSearch = false): Promise<PromptInterpretation> {
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
  const searched = forceSearch || /ابحث|بحث|ويكيبيديا|معلم حقيقي|مكان حقيقي|landmark|wikipedia|search/i.test(prompt);
  const notes = ['المساعد يفهم كلمات محدودة فقط، وليس نموذج لغة عاماً. قد يتجاهل تفاصيل غير معروفة؛ راجع العناصر والتحذيرات. الأشكال إجرائية وليست نموذجاً عاماً لتحويل الصور إلى 3D.'];
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
    const parsed = searchResult.safeParse(await postJSON('/api/search', { query }));
    if (!parsed.success) throw new Error('استجابت ويكيبيديا ببيانات بحث غير صالحة.');
    sources = parsed.data.results.filter((item) => {
      try { const url = new URL(item.url); return url.protocol === 'https:' && ['ar.wikipedia.org', 'en.wikipedia.org'].includes(url.hostname); }
      catch { return false; }
    }).slice(0, 4).map((item) => ({ title: item.title.slice(0, 120), url: item.url, content: item.content.slice(0, 1200) }));
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
