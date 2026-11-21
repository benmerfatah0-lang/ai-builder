/** A deliberately small list of common unambiguous typing mistakes, not a general spellchecker. */
const corrections: Record<string, string> = {
  نهرر: 'نهر', نههر: 'نهر', نهراا: 'نهرا',
  قريية: 'قرية', قرييه: 'قرية', قرييـة: 'قرية',
  شجررة: 'شجرة', شجرره: 'شجرة', شججرة: 'شجرة',
  اشججار: 'اشجار', صخخره: 'صخرة', صخخرة: 'صخرة',
  منززل: 'منزل', جسرر: 'جسر', جببل: 'جبل',
  الغاببة: 'الغابة', صحرراء: 'صحراء',
};
// Small construction vocabulary. Only a duplicated letter may be removed,
// and only if exactly one supported word remains; known words are never changed.
const supported = new Set('نهر نهرا قرية قريه شجرة شجره اشجار شجرتين بيت بيوت منزل منازل صخرة صخره صخور برج جسر فانوس صحراء غابة غابه قرى جبال جبل مزرعة مزرعه village river house tree forest mountain'.split(' '));

export interface SpellingResult { text: string; changes: { from: string; to: string }[] }
export function correctBuildSpelling(text: string): SpellingResult {
  const changes: SpellingResult['changes'] = [];
  const corrected = text.replace(/[\p{L}]+/gu, (word) => {
    const normalized = word.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
    // Only split common Arabic conjunction/article prefixes for explicitly listed typos.
    const variants: [string, string][] = [[normalized, '']];
    if (normalized.startsWith('و') && normalized.length > 3) variants.push([normalized.slice(1), 'و']);
    if (normalized.startsWith('ال') && normalized.length > 4) variants.push([normalized.slice(2), 'ال']);
    if (normalized.startsWith('وال') && normalized.length > 5) variants.push([normalized.slice(3), 'وال']);
    for (const [stem, prefix] of variants) {
      let match = corrections[stem];
      if (!match && !supported.has(stem) && stem.length >= 4) {
        const possible = new Set<string>();
        for (let i = 1; i < stem.length; i++) {
          if (stem[i] !== stem[i - 1]) continue;
          const candidate = stem.slice(0, i) + stem.slice(i + 1);
          if (supported.has(candidate)) possible.add(candidate);
        }
        if (possible.size === 1) match = [...possible][0];
      }
      if (match) {
        const to = prefix + match;
        changes.push({ from: word, to });
        return to;
      }
    }
    return word;
  });
  return { text: corrected, changes };
}
export function spellingNotice(changes: SpellingResult['changes']): string {
  return `تصحيح إملائي محدود: ${changes.map(({ from, to }) => `«${from}» ← «${to}»`).join('، ')}.`;
}
