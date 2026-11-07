/** A deliberately small, local vocabulary mapping descriptions to library IDs. */
export type AssetDirection = 'left' | 'right' | 'front' | 'behind' | 'near';
export interface AssetRequest {
  assetId: string;
  count: number;
  relation?: { target: number; direction: AssetDirection };
}

interface Match { id: string; start: number; end: number; text: string }
const ALIASES: [string, string][] = [
  ['pine', 'pine trees?|pines?|اشجار الصنوبر|شجر الصنوبر|صنوبر'],
  ['palm', 'palm trees?|palms?|نخلتين|نخلتان|نخيل|نخلة|نخله|نخل'],
  ['broadleaf', 'broadleaf trees?|broadleaf'],
  ['cactus', 'cact(?:us|i)|صبار'],
  ['bush', 'bush(?:es)?|shrubs?|شجيرات|شجيرة|شجيره'],
  ['tree', 'trees?|شجرتين|شجرتان|اشجار|شجرة|شجره|شجر'],
  ['boulder', 'boulders?|rocks?|stones?|صخور|صخرة|صخره|حجارة|حجاره'],
  ['crag', 'crags?'],
  ['house', 'houses?|homes?|بيتين|بيتان|منزلين|منزلان|بيوت|منازل|منزل|بيت|منزلا'],
  ['tower', 'towers?|برجين|برجان|ابراج|برج'],
  ['ruin', 'ruins?|اطلال'],
  ['lantern', 'lanterns?|lamps?|فوانيس|فانوس|مصابيح|مصباح'],
  ['box', 'cubes?|boxes?|مكعبات|مكعب'],
  ['sphere', 'spheres?|balls?|كرات|كرة|كره'],
  ['cylinder', 'cylinders?|اسطوانات|اسطوانة|اسطوانه'],
  ['cone', 'cones?|مخاريط|مخروط'],
  ['torus', 'rings?|حلقات|حلقة|حلقه'],
  ['wood-fence', 'fences?|اسوار|سياج|سور'],
  ['dirt-path', 'paths?|roads?|طرق|طريق|ممرات|ممر'],
];

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10,
  واحد: 1, واحدة: 1, واحده: 1, اثنين: 2, اثنان: 2, اثنتين: 2,
  ثلاث: 3, ثلاثة: 3, ثلاثه: 3, اربع: 4, اربعة: 4, اربعه: 4,
  خمس: 5, خمسة: 5, خمسه: 5, عشر: 10, عشرة: 10, عشره: 10,
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0));
}

function countBefore(segment: string): number | undefined {
  const match = /(?:^|\s)(\d{1,3}|one|two|three|four|five|six|ten|واحد|واحدة|واحده|اثنين|اثنان|اثنتين|ثلاث|ثلاثة|ثلاثه|اربع|اربعة|اربعه|خمس|خمسة|خمسه|عشر|عشرة|عشره)\s*$/u.exec(segment);
  if (!match?.[1]) return undefined;
  return WORD_NUMBERS[match[1]] ?? Number(match[1]);
}

function directionBetween(text: string): AssetDirection | undefined {
  if (/يمين|right of/.test(text)) return 'right';
  if (/يسار|شمال|left of/.test(text)) return 'left';
  if (/امام|قدام|in front of/.test(text)) return 'front';
  if (/خلف|وراء|behind/.test(text)) return 'behind';
  if (/بجانب|بجوار|قرب|بالقرب|next to|near|beside/.test(text)) return 'near';
  return undefined;
}

/** Parse a limited set of asset names, quantities and pairwise relations. */
export function parseAssetRequests(prompt: string): AssetRequest[] | undefined {
  const text = normalize(prompt);
  const matches: Match[] = [];
  for (const [id, alternatives] of ALIASES) {
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:و?ال|و)?(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'gu');
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue;
      matches.push({ id, start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  // Prefer longer, more specific matches (e.g. "palm trees" over "trees").
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: Match[] = [];
  for (const match of matches) {
    if (selected.some((other) => match.start < other.end && match.end > other.start)) continue;
    selected.push(match);
  }
  selected.sort((a, b) => a.start - b.start);
  if (!selected.length) return undefined;

  // Keep the established landscape planner for general English descriptions.
  // Explicit spatial instructions, Arabic asset descriptions and primitive
  // requests use this asset layout instead.
  const hasArabic = /[\u0600-\u06ff]/.test(text);
  const hasRelation = selected.some((m, i) => i > 0 && directionBetween(text.slice(selected[i - 1]!.end, m.start)));
  const hasSpecial = selected.some((m) => ['box', 'sphere', 'cylinder', 'cone', 'torus', 'wood-fence', 'dirt-path'].includes(m.id));
  if (!hasArabic && !hasRelation && !hasSpecial) return undefined;

  const requests: AssetRequest[] = [];
  const kept: Match[] = [];
  for (const [index, match] of selected.entries()) {
    const between = text.slice(index ? selected[index - 1]!.end : 0, match.start);
    if (/(?:بدون|دون|بلا|without|no)\s*(?:ال)?\s*$/u.test(between)) continue;
    const number = countBefore(between);
    const plural = /(?:trees|rocks|houses|towers|lanterns|palms|cubes|spheres|اشجار|بيوت|منازل|صخور|فوانيس|نخيل|مكعبات|شجيرات)$/.test(match.text);
    const dual = /(?:تين|تان|لين|لان|جين|جان|يتين|يتان)$/.test(match.text);
    requests.push({ assetId: match.id, count: number ?? (dual ? 2 : plural ? 3 : 1) });
    kept.push(match);
  }
  for (let i = 1; i < kept.length; i += 1) {
    const previous = kept[i - 1]!;
    const current = kept[i]!;
    const direction = directionBetween(text.slice(previous.end, current.start));
    if (!direction) continue;
    if (direction === 'near') requests[i]!.relation = { target: i - 1, direction };
    else requests[i - 1]!.relation = { target: i, direction };
  }
  return requests.length ? requests : undefined;
}
