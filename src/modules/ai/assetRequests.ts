import { EXPANDED_ASSETS } from '../../core/assets/expandedDefinitions';

/** A deliberately small, local vocabulary mapping descriptions to library IDs. */
export type AssetDirection = 'left' | 'right' | 'front' | 'behind' | 'near';
export interface AssetRequest {
  assetId: string;
  count: number;
  /** Optional central thumbnail colour for a clearly labelled approximate house. */
  referenceColor?: string;
  size?: 'small' | 'large' | 'tall' | 'wide';
  relation?: { target: number; direction: AssetDirection };
  /**
   * Preferred (x, z) positions in terrain units, one per instance, produced by
   * the advanced planner when it resolved a spatial relation ("a castle on top
   * of the mountain", "houses surrounding the lake"). Purely advisory: the
   * layout code still rejects water, overlap and out-of-bounds spots and falls
   * back to its own sampling, so requests without positions behave exactly as
   * before.
   */
  positions?: [number, number][];
  /** Logical region name recorded on `meta.region` for regional regeneration. */
  region?: string;
}

export interface AssetMatch { id: string; start: number; end: number; text: string }
const ALIASES: [string, string][] = [
  ...EXPANDED_ASSETS.map((asset): [string, string] => [asset.id, asset.aliases]),
  ['mine-entrance', 'gold mines?|mines?|منجمين|منجمان|مناجم|منجم'],
  ['mine-cart', 'mine carts?|mining carts?|carts?|عربات|عربة|عربه'],
  ['pickaxe', 'pickaxes?|معاول|معول'],
  ['excavator', 'excavators?|diggers?|حفارات|حفارة|حفاره'],
  ['chest', 'chests?|treasure chests?|صناديق|صندوق|صنديق'],
  ['pine', 'pine trees?|pines?|اشجار الصنوبر|شجر الصنوبر|صنوبر'],
  ['palm', 'palm trees?|palms?|نخلتين|نخلتان|نخيل|نخلة|نخله|نخل'],
  ['broadleaf', 'broadleaf trees?|broadleaf'],
  ['cactus', 'cact(?:us|i)|صبار'],
  ['bush', 'bush(?:es)?|shrubs?|شجيرات|شجيرة|شجيره'],
  ['tree', 'trees?|شجرتين|شجرتان|شجرات|اشجار|شجرة|شجره|شجر'],
  ['boulder', 'boulders?|rocks?|stones?|صخرتين|صخرتان|صخرات|صخور|صخرة|صخره|حجارة|حجاره'],
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
  ['barn', 'barns?|حظيرتين|حظيرتان|حظائر|حظيرة|حظيره'],
  ['coop', 'chicken coops?|coops?|اقنان|قن'],
  ['bridge', 'bridges?|جسرين|جسران|جسور|جسر'],
  ['wheat-field', 'wheat fields?|حقول قمح|حقل قمح'],
  ['wood-fence', 'fences?|اسوار|سياج|سور'],
  ['dirt-path', 'paths?|roads?|طرق|طريق|ممرات|ممر'],
];

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10,
  واحد: 1, واحدة: 1, واحده: 1, اثنين: 2, اثنان: 2, اثنتين: 2,
  ثلاث: 3, ثلاثة: 3, ثلاثه: 3, اربع: 4, اربعة: 4, اربعه: 4,
  خمس: 5, خمسة: 5, خمسه: 5, ست: 6, ستة: 6, سته: 6, سبع: 7, سبعة: 7, سبعه: 7, ثمان: 8, ثمانية: 8, ثمانيه: 8, تسع: 9, تسعة: 9, تسعه: 9, عشر: 10, عشرة: 10, عشره: 10, seven: 7, eight: 8, nine: 9,
};

export function normalizeAssetText(text: string): string {
  return text.toLowerCase().replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x6f0));
}

const NUMBER_WORDS = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|');
export function parseCountToken(token: string | undefined): number | undefined {
  if (!token) return undefined;
  if (WORD_NUMBERS[token] !== undefined) return WORD_NUMBERS[token];
  return /^\d{1,3}$/.test(token) ? Number(token) : undefined;
}
function countBefore(segment: string): number | undefined {
  const match = new RegExp(`(?:^|\\s)(?:و\\s*)?(\\d{1,3}|${NUMBER_WORDS})\\s*$`, 'u').exec(segment);
  return parseCountToken(match?.[1]);
}
function countAfter(segment: string): number | undefined {
  const match = new RegExp(`^\\s+(\\d{1,3}|${NUMBER_WORDS})(?=\\s*(?:$|و|,|،|\\.|and\\b))`, 'u').exec(segment);
  return parseCountToken(match?.[1]);
}
function sizeFor(before: string, after: string, hasPrevious = false): AssetRequest['size'] {
  const words = 'صغير(?:ه|ة)?|كبير(?:ه|ة)?|ضخم(?:ه|ة)?|طويل(?:ه|ة)?|عريض(?:ه|ة)?|واسع(?:ه|ة)?|small|tiny|little|large|big|huge|tall|wide|broad';
  // Arabic adjectives commonly follow their noun; do not reuse the previous
  // noun's trailing adjective as a modifier for the next noun.
  const prefix = hasPrevious ? before.replace(/^\s+(?:ال)?(?:صغير(?:ه|ة)?|كبير(?:ه|ة)?|ضخم(?:ه|ة)?|طويل(?:ه|ة)?|عريض(?:ه|ة)?|واسع(?:ه|ة)?)(?![\p{L}\p{N}_])/u, '') : before;
  const match = new RegExp(`^\\s+(?:ال)?(${words})(?![\\p{L}\\p{N}_])`, 'u').exec(after) ??
    new RegExp(`(?:^|\\s)(?:ال)?(${words})\\s*$`, 'u').exec(prefix);
  if (!match?.[1]) return undefined;
  const word = match[1];
  if (/صغير|small|tiny|little/.test(word)) return 'small';
  if (/طويل|tall/.test(word)) return 'tall';
  if (/عريض|واسع|wide|broad/.test(word)) return 'wide';
  return 'large';
}
export function directionBetween(text: string): AssetDirection | undefined {
  if (/يمين|right of|to the right/.test(text)) return 'right';
  if (/يسار|شمال|left of|to the left/.test(text)) return 'left';
  if (/امام|قدام|in front of/.test(text)) return 'front';
  if (/خلف|وراء|behind/.test(text)) return 'behind';
  if (/بجانب|بجوار|قرب|بالقرب|next to|near|beside/.test(text)) return 'near';
  return undefined;
}

/** Locate catalog nouns in the normalized input; no network or content execution. */
export function findAssetMentions(text: string): AssetMatch[] {
  const matches: AssetMatch[] = [];
  for (const [id, alternatives] of ALIASES) {
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:و?ب?ال|و?ب|و)?(?:${alternatives})(?![\\p{L}\\p{N}_])`, 'gu');
    for (const match of text.matchAll(regex)) {
      if (match.index === undefined) continue;
      matches.push({ id, start: match.index, end: match.index + match[0].length, text: match[0] });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const selected: AssetMatch[] = [];
  for (const match of matches) {
    if (!selected.some((other) => match.start < other.end && match.end > other.start)) selected.push(match);
  }
  return selected.sort((a, b) => a.start - b.start);
}

/** Parse a limited set of asset names, quantities and pairwise relations. */
export function parseAssetRequests(prompt: string, _forceExplicit = false): AssetRequest[] | undefined {
  const text = normalizeAssetText(prompt);
  const selected = findAssetMentions(text).filter((match) =>
    // "pine forest" names the biome, not one separately requested pine.
    !(match.id === 'pine' && /^(?:pine|pines)$/.test(match.text) && /^\s+(?:forest|woods|woodland)\b/.test(text.slice(match.end))));
  if (!selected.length) return undefined;

  const requests: AssetRequest[] = [];
  const kept: { match: AssetMatch; request: number }[] = [];
  for (const [index, match] of selected.entries()) {
    let between = text.slice(index ? selected[index - 1]!.end : 0, match.start);
    if (/(?:بدون|دون|بلا|لا|without|no)(?:\s+(?:a|an|the))?\s*(?:ال)?\s*$/u.test(between)) continue;
    // A suffix such as "شجرة أمامه" refers to the preceding object, not
    // the next noun. Do not turn it into a relation with the next object.
    const pronoun = /(?:يمين|يسار|امام|قدام|خلف|وراء|بجانب|بجوار)(?:ه|ها|هما)(?![\p{L}])/u;
    const previous = kept.at(-1);
    const previousPrevious = kept.at(-2);
    if (previous && previousPrevious && pronoun.test(between)) {
      const direction = directionBetween(between);
      if (direction && previous.request !== previousPrevious.request) requests[previous.request]!.relation = { target: previousPrevious.request, direction };
      between = between.replace(pronoun, '');
    }
    // A mountain is terrain here, not a discrete asset anchor. Never silently
    // attach its relation to the next recognised object.
    const direction = /جبل|جبال|mountain/i.test(between) ? undefined : directionBetween(between);
    const reference = direction && /^(?:و?ب?ال)/u.test(match.text)
      ? kept.find((entry) => entry.match.id === match.id && entry.request !== previous?.request)
      : undefined;
    let requestIndex: number;
    if (reference) {
      requestIndex = reference.request;
    } else {
      const after = text.slice(match.end, selected[index + 1]?.start ?? text.length);
      // A number immediately before an Arabic conjunction ("زهرة 3 ومقعد")
      // belongs to the preceding noun, not both nouns.
      const joinedNext = index > 0 && match.text.startsWith('و') &&
        findAssetMentions(match.text.slice(1)).some((candidate) => candidate.id === match.id && candidate.start === 0);
      const previousSuffix = joinedNext && new RegExp(`^\\s+(?:\\d{1,3}|${NUMBER_WORDS})\\s*$`, 'u').test(between);
      const number = (previousSuffix ? undefined : countBefore(between)) ?? countAfter(after);
      const plural = /(?:trees|pines|boulders|stones|rocks|houses|towers|lanterns|palms|cubes|spheres|flowers|mushrooms|ferns|reeds|crystals|castles|arches|wells|windmills|gazebos|tents|stalls|fountains|watchtowers|shrines|lighthouses|barrels|crates|benches|tables|chairs|campfires|signposts|flags|wagons|columns|زهور|ورود|فطريات|قلاع|اقواس|ابار|نوافير|خيام|براميل|مقاعد|طاولات|كراسي|رايات|اشجار|شجرات|بيوت|منازل|صخور|صخرات|فوانيس|نخيل|مكعبات|شجيرات|عربات|معاول|حفارات|صناديق|مناجم|حظائر|جسور|barns|bridges|carts|pickaxes|excavators|chests|mines)$/.test(match.text);
      const dual = /(?:تين|تان|لين|لان|جين|جان|يتين|يتان)$/.test(match.text);
      requestIndex = requests.length;
      requests.push({ assetId: match.id, count: number ?? (dual ? 2 : plural ? 3 : 1), size: sizeFor(between, after, index > 0) });
    }
    if (previous && direction && previous.request !== requestIndex) {
      if (direction === 'near' && !reference) requests[requestIndex]!.relation = { target: previous.request, direction };
      else requests[previous.request]!.relation = { target: requestIndex, direction };
    }
    kept.push({ match, request: requestIndex });
  }
  const last = kept.at(-1);
  const previous = kept.at(-2);
  if (last && previous && last.request !== previous.request) {
    const tail = text.slice(last.match.end);
    if (!/جبل|جبال|mountain/.test(text.slice(previous.match.end, last.match.start)) && /(?:يمين|يسار|امام|قدام|خلف|وراء|بجانب|بجوار)(?:ه|ها|هما)(?![\p{L}])/u.test(tail)) {
      const direction = directionBetween(tail);
      if (direction) requests[last.request]!.relation = { target: previous.request, direction };
    }
  }
  // A city with a mine needs buildings, even when the user didn't specify a count.
  // Keep explicit relations/counts and associate otherwise unplaced mining props with the mine.
  const mineIndex = requests.findIndex((request) => request.assetId === 'mine-entrance');
  if (mineIndex >= 0) {
    const noHouse = /(?:بدون|دون|بلا|without|no)\s+(?:ال)?(?:بيوت|منازل|بيت|منزل|houses?|homes?)/i.test(text);
    if (!noHouse && /(?:مدينه|مدينة|city|village|قريه)/i.test(text) && !requests.some((request) => request.assetId === 'house')) {
      requests.push({ assetId: 'house', count: 5, relation: { target: mineIndex, direction: 'near' } });
    }
    for (const [index, request] of requests.entries()) {
      if (index !== mineIndex && !request.relation && ['mine-cart', 'pickaxe', 'excavator', 'chest'].includes(request.assetId)) {
        request.relation = { target: mineIndex, direction: 'near' };
      }
    }
  }
  return requests.length ? requests : undefined;
}
