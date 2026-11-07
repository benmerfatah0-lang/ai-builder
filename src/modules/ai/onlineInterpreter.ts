import { z } from 'zod';
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
  const searched = forceSearch || /ابحث|بحث|ويكيبيديا|معلم حقيقي|مكان حقيقي|landmark|wikipedia|search/i.test(prompt);
  const notes = ['المساعد يفهم كلمات محدودة فقط، وليس نموذج لغة عاماً. الأشكال الجديدة إجرائية وليست نماذج متعلّمة من مواقع الإنترنت.'];
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
    searched, sources: sources.map(({ title, url }) => ({ title, url })), notes };
}
