import { labelFor } from './lexicon';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import type { Frames } from './frames';
import type { Clarification } from './worldSpec';

/**
 * Contradiction detection and clarification.
 *
 * The planner never guesses silently: when a description asks for two things
 * that cannot both be true, it produces a `Clarification`. Blocking items stop
 * generation until the user answers (or explicitly accepts the default);
 * advisory items are resolved with their default and reported as notices.
 *
 * Every rule here is deterministic and explainable — the `reason` field says
 * exactly which two cues collided.
 */

export interface ContradictionInput {
  frames: Frames;
  /** Total objects the description asks for, before clamping. */
  requestedObjects: number;
  /** True when a mountain-like landform or biome is present. */
  hasHighGround: boolean;
  /** True when any water feature survived negation. */
  hasWater: boolean;
}

export interface ContradictionResult {
  clarifications: Clarification[];
  /** Auto-resolvable notices (advisory items resolved with their default). */
  notices: string[];
}

const WATER_IDS = ['sea', 'lake', 'river', 'water', 'oasis', 'marsh'];
const TREE_IDS = ['tree', 'pine', 'palm', 'cactus', 'bush', 'forest', 'orchard', 'fern', 'bamboo'];
/** Excluding any of these removes vegetation altogether, not just one species. */
const GENERIC_VEGETATION = ['tree', 'forest', 'orchard'];

function timeLabel(time: string): string {
  return time === 'night' ? 'ليل' : time === 'sunset' ? 'غروب' : 'نهار';
}

function clarification(
  id: string,
  severity: Clarification['severity'],
  question: string,
  options: [string, string][],
  defaultOption: string,
  reason: string,
): Clarification {
  return {
    id,
    severity,
    question,
    options: options.map(([optionId, label]) => ({ id: optionId, label })),
    defaultOption,
    reason,
  };
}

export function detectContradictions(input: ContradictionInput): ContradictionResult {
  const { frames, requestedObjects, hasHighGround, hasWater } = input;
  const clarifications: Clarification[] = [];
  const notices: string[] = [];
  const negated = new Set(frames.negations);
  const mentioned = new Set(frames.mentions.filter((mention) => !mention.negated).map((mention) => mention.entry.id));
  const biomes = frames.biomes;

  // 1. "بدون ماء" while a water body is described.
  const negatedWater = WATER_IDS.filter((id) => negated.has(id));
  const presentWater = WATER_IDS.filter((id) => mentioned.has(id));
  if (negatedWater.length && presentWater.length) {
    clarifications.push(clarification(
      'water-contradiction',
      'blocking',
      `طلبتَ عدم وجود ماء (${negatedWater.map(labelFor).join('، ')}) لكن الوصف يذكر ${presentWater.map(labelFor).join('، ')}. أيهما أعتمد؟`,
      [['keep-water', 'أبقِ الماء المذكور في الوصف'], ['drop-water', 'احذف الماء واعتمد أرضاً جافة']],
      'keep-water',
      'نفي الماء يتعارض مع ذكر مسطح مائي صريح.',
    ));
  }

  // 2. "غابة بدون أشجار". Only a *generic* exclusion contradicts a forest;
  // excluding one species ("بدون أشجار نخيل") leaves the forest intact.
  const negatedGenericVegetation = GENERIC_VEGETATION.filter((id) => negated.has(id));
  const negatedSpecies = TREE_IDS.filter((id) => negated.has(id) && !GENERIC_VEGETATION.includes(id));
  if (negatedGenericVegetation.length && (mentioned.has('forest') || biomes.includes('forest'))) {
    clarifications.push(clarification(
      'forest-without-trees',
      'blocking',
      `الوصف يطلب غابة بدون غطاء نباتي (${negatedGenericVegetation.map(labelFor).join('، ')}). الغابة بلا أشجار ليست غابة؛ ماذا أفعل؟`,
      [['keep-trees', 'أبقِ الأشجار (غابة عادية)'], ['no-trees', 'احذف الأشجار واجعلها أرضاً مفتوحة']],
      'no-trees',
      'نفي الأشجار يتعارض مع بيئة الغابة.',
    ));
  } else if (negatedSpecies.length && biomes.includes('forest')) {
    notices.push(`الغابة باقية؛ استُثني منها ${negatedSpecies.map(labelFor).join('، ')} فقط حسب طلبك.`);
  }

  // 3. Desert with dense forest vegetation.
  if (biomes.includes('desert') && (mentioned.has('pine') || mentioned.has('forest')) && frames.density === 'dense') {
    clarifications.push(clarification(
      'desert-dense-forest',
      'blocking',
      'صحراء بغابة صنوبر كثيفة غير ممكنة واقعياً. أيهما أولى؟',
      [['desert-oasis', 'صحراء مع واحة نخيل محدودة'], ['forest', 'اجعلها غابة معتدلة بدل الصحراء']],
      'desert-oasis',
      'بيئة الصحراء تتعارض مع غطاء نباتي كثيف لصنوبر.',
    ));
  } else if (biomes.includes('desert') && (mentioned.has('pine') || mentioned.has('forest'))) {
    notices.push('الصحراء مع أشجار صنوبر أو غابة غير معتادة؛ استُبدلت الصنوبريات بنخيل وواحات محدودة.');
  }

  // 4. Island without water.
  if (biomes.includes('island') && negatedWater.length) {
    clarifications.push(clarification(
      'island-without-water',
      'blocking',
      'جزيرة بدون ماء ليست جزيرة. أعتمد البحر حولها أم أجعلها أرضاً عادية؟',
      [['keep-sea', 'أبقِ البحر حول الجزيرة'], ['no-island', 'اجعلها أرضاً بلا محيط']],
      'keep-sea',
      'بيئة الجزيرة تتطلب ماءً محيطاً.',
    ));
  }

  // 5. Snow in a desert / heat with snow.
  if (frames.weather.includes('snow') && biomes.includes('desert')) {
    notices.push('الثلج في الصحراء نادر؛ خُفِّضت كثافة الضباب وأُبقي الغطاء الثلجي كتأثير إضاءة فقط.');
  }
  if (frames.weather.includes('hot') && frames.weather.includes('snow')) {
    clarifications.push(clarification(
      'hot-and-snow',
      'advisory',
      'الوصف يذكر الحر والثلج معاً. أيهما أعتمد للجو؟',
      [['cold', 'جو بارد مع ثلج'], ['hot', 'جو حار بلا ثلج']],
      'cold',
      'حالتا جو متعارضتان.',
    ));
  }

  // 6. Flat land together with mountains/peaks.
  const flatRequested = frames.landform === 'flat' || mentioned.has('flat-land');
  const highRequested = frames.landform === 'mountains' || mentioned.has('mountain-terrain') || biomes.includes('mountains');
  if (flatRequested && highRequested) {
    clarifications.push(clarification(
      'flat-and-mountainous',
      'blocking',
      'الوصف يطلب أرضاً مسطحة وجبالاً في الوقت نفسه. أيهما أساس التضاريس؟',
      [['mountains', 'جبال مع وادٍ مسطح'], ['flat', 'أرض مسطحة مع تلال منخفضة']],
      'mountains',
      'شكلان للتضاريس متعارضان في العالم نفسه.',
    ));
  }

  // 7. A relation anchored on a mountain that the description never mentions.
  const mountainAnchored = frames.relations.some((relation) =>
    (relation.predicate === 'on-top-of' || relation.predicate === 'at-foot-of') && !hasHighGround);
  if (mountainAnchored) {
    clarifications.push(clarification(
      'anchor-missing-highground',
      'advisory',
      'طلبٌ بوضع عنصر «فوق/عند سفح» شيء مرتفع دون ذكر جبل أو تلال. أضعه على أعلى نقطة في التضاريس الحالية؟',
      [['highest-point', 'نعم، على أعلى نقطة متاحة'], ['center', 'لا، ضعه في مركز العالم']],
      'highest-point',
      'المرجع المكاني غير موجود في الوصف.',
    ));
  }

  // 8. Two dominant biomes with no regional split.
  if (biomes.length > 1 && !frames.regions.length) {
    clarifications.push(clarification(
      'multiple-biomes',
      'advisory',
      `الوصف يذكر أكثر من بيئة (${biomes.map((biome) => labelFor(biome)).join('، ')}) دون تحديد أماكنها. كيف أوزعها؟`,
      [['first-dominant', `${labelFor(biomes[0]!)} بيئة أساسية والبقعة الثانية منطقة محدودة`], ['split', 'تقسيم العالم مناصفة بين البيئتين']],
      'first-dominant',
      'بيئتان رئيسيتان بلا فاصل مكاني.',
    ));
  }

  // 9. Conflicting times of day.
  const times = [...new Set(frames.times)];
  if (times.length > 1) {
    clarifications.push(clarification(
      'conflicting-time',
      'advisory',
      `ذكر الوصف أكثر من وقت (${times.map(timeLabel).join('، ')}). أيهما أعتمد للإضاءة؟`,
      [['first', 'الوقت المذكور أولاً'], ['day', 'نهار']],
      'first',
      'وقتان مختلفان في وصف واحد.',
    ));
  }

  // 10. More objects than the document can hold.
  if (requestedObjects > MAX_WORLD_OBJECTS) {
    clarifications.push(clarification(
      'object-budget',
      'advisory',
      `الوصف يطلب نحو ${requestedObjects} عنصراً، والحد الحالي للمستند ${MAX_WORLD_OBJECTS}. أوزّع الحد الأقصى بالتساوي أم أعطّي الأولوية للمعالم؟`,
      [['landmarks-first', 'الأولوية للمعالم والمباني ثم النباتات'], ['even', 'توزيع متناسب بين كل الفئات']],
      'landmarks-first',
      'العدد المطلوب يتجاوز سعة المستند.',
    ));
    notices.push(`قُلِّص العدد المطلوب (${requestedObjects}) إلى سعة المستند (${MAX_WORLD_OBJECTS}).`);
  }

  // 11. Water requested but negated only for one kind (sea vs lake).
  if (hasWater && negated.has('sea') && (mentioned.has('lake') || mentioned.has('river'))) {
    notices.push('لا بحر؛ أُبقيت البحيرات والأنهار الداخلية كما وردت في الوصف.');
  }

  // 12. A river that must pass through something, while rivers are negated.
  if (negated.has('river') && frames.relations.some((relation) => relation.predicate === 'through')) {
    clarifications.push(clarification(
      'river-negated-but-crossed',
      'blocking',
      'الوصف ينفي النهر ويطلب في الوقت نفسه عنصراً يعبر النهر. أعتمد نهراً أم أستبدله بطريق؟',
      [['road', 'استبدل النهر بطريق'], ['river', 'أبقِ النهر']],
      'road',
      'علاقة «عبر النهر» مع نفي النهر.',
    ));
  }

  // 13. Animals: recognized, but nothing local can build them.
  if (frames.animals.length) {
    notices.push(`الحيوانات المذكورة (${frames.animals.map((animal) => `${labelFor(animal.id)} ×${animal.count}`).join('، ')}) موثّقة في المواصفات، لكن لا يوجد باني إجرائي محلي لها بعد؛ يمكن الحصول على مجسماتها من المصادر المجانية عند تفعيلها.`);
  }

  return { clarifications, notices };
}

/** Applies an answered clarification to the frames the solver will consume. */
export interface ClarificationAnswers {
  [clarificationId: string]: string;
}

export function resolveWithAnswers(
  clarifications: Clarification[],
  answers: ClarificationAnswers,
): { resolved: Record<string, string>; unansweredBlocking: Clarification[] } {
  const resolved: Record<string, string> = {};
  const unansweredBlocking: Clarification[] = [];
  for (const item of clarifications) {
    const answer = answers[item.id];
    if (answer && item.options.some((option) => option.id === answer)) {
      resolved[item.id] = answer;
    } else if (item.severity === 'blocking') {
      unansweredBlocking.push(item);
    } else {
      resolved[item.id] = item.defaultOption;
    }
  }
  return { resolved, unansweredBlocking };
}
