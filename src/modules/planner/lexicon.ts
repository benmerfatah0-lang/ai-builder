import type { BiomeId, TimeOfDay, WorldDensity, WorldScale, WorldStyle } from '../ai/types';
import type { TerrainStyle } from '../../core/world-plan/schema';

/**
 * Bilingual lexicon for the advanced world planner.
 *
 * This is a *consolidated* vocabulary: it does not replace the keyword tables
 * inside `promptInterpreter.ts` (tier 0 keeps working verbatim), it widens what
 * the planner can name. Every term is matched against text normalized by
 * `normalizeAssetText` (lower-case, no diacritics, أإآ→ا, ى→ي, Arabic-Indic and
 * Persian digits → ASCII), so Arabic entries are written in normalized form and
 * the ة/ه variants are generated automatically.
 */

export type LexiconCategory =
  | 'biome'
  | 'landform'
  | 'water'
  | 'vegetation'
  | 'structure'
  | 'settlement'
  | 'prop'
  | 'animal'
  | 'weather'
  | 'time'
  | 'style'
  | 'architecture'
  | 'material'
  | 'scale'
  | 'density'
  | 'region';

export interface LexiconEntry {
  /** Stable planner id, e.g. `castle`, `on-mountain`. */
  id: string;
  category: LexiconCategory;
  /** Arabic terms, normalized form (no diacritics, ا for أإآ, ي for ى). */
  ar: string[];
  /** English terms, lower case. */
  en: string[];
  /** Value the term maps onto in an existing contract, when there is one. */
  biome?: BiomeId;
  terrain?: TerrainStyle;
  time?: TimeOfDay;
  scale?: WorldScale;
  density?: WorldDensity;
  style?: WorldStyle;
  /** Catalogue asset id, when the term can be realized offline today. */
  assetId?: string;
  /** True when the planner can name it but nothing local can build it yet. */
  unrealizable?: boolean;
}

/** Adds the common ة/ه spelling variants so both forms match. */
function ar(...terms: string[]): string[] {
  const out = new Set<string>();
  for (const term of terms) {
    out.add(term);
    // Users type ة and ه interchangeably; the lexicon accepts both.
    if (term.includes('ة')) out.add(term.replace(/ة/g, 'ه'));
    if (term.includes('ه') && !term.includes('ة')) out.add(term.replace(/ه/g, 'ة'));
    if (term.includes(' ')) continue;
    if (term.endsWith('ة') || term.endsWith('ه')) {
      // Sound feminine plural: "شجرة" → "شجرات", "بحيرة" → "بحيرات".
      out.add(`${term.slice(0, -1)}ات`);
      continue;
    }
    // Feminine agreement, which also covers nisba adjectives:
    // "صحراء واسعة", "قلعة كبيرة", "غابة متفرقة", "بيوت خشبية".
    out.add(`${term}ة`);
    out.add(`${term}ه`);
    // Duals ("بيتان", "برجين") and the tanween fatḥa spelling ("بيتاً", which
    // normalization leaves as "بيتا") — ordinary ways to write a noun.
    if (term.length >= 3 && !/(?:ان|ين|ون|ات|[ياىءي])$/u.test(term)) {
      out.add(`${term}ان`);
      out.add(`${term}ين`);
      out.add(`${term}ا`);
    }
  }
  return [...out];
}

export const LEXICON: LexiconEntry[] = [
  // ── Biomes ────────────────────────────────────────────────────────────────
  { id: 'meadow', category: 'biome', biome: 'meadow', ar: ar('مرج', 'مروج', 'سهل اخضر', 'سهول خضراء', 'ارض خضراء'), en: ['meadow', 'meadows', 'grassland', 'prairie', 'green field', 'green fields'] },
  { id: 'forest', category: 'biome', biome: 'forest', ar: ar('غابة', 'غابات', 'احراج', 'حرج'), en: ['forest', 'forests', 'woods', 'woodland', 'jungle', 'pine forest'] },
  { id: 'mountains', category: 'biome', biome: 'mountains', ar: ar('جبال', 'جبل', 'مرتفعات', 'قمة جبلية'), en: ['mountains', 'mountain', 'mountain range', 'alpine', 'highlands', 'peaks'] },
  { id: 'desert', category: 'biome', biome: 'desert', ar: ar('صحراء', 'بيداء', 'ارض قاحلة'), en: ['desert', 'deserts', 'arid land', 'sahara', 'wasteland'] },
  { id: 'island', category: 'biome', biome: 'island', ar: ar('جزيرة', 'جزر', 'ارخبيل'), en: ['island', 'islands', 'isle', 'archipelago', 'atoll'] },
  { id: 'ruins', category: 'biome', biome: 'ruins', ar: ar('اطلال', 'مدينة مهجورة', 'خرائب'), en: ['ruins', 'ruined city', 'abandoned city', 'wreckage'] },

  // ── Landforms (map onto the existing TerrainStyle enum) ───────────────────
  { id: 'flat-land', category: 'landform', terrain: 'flat', ar: ar('ارض مسطحة', 'مسطح', 'مستوي', 'سهل منبسط'), en: ['flat', 'flat land', 'plain', 'plains', 'level ground', 'flat plain'] },
  { id: 'hills', category: 'landform', terrain: 'hills', ar: ar('تلال', 'تل', 'هضاب صغيرة'), en: ['hills', 'hill', 'rolling hills', 'hillside', 'foothills'] },
  { id: 'mountain-terrain', category: 'landform', terrain: 'mountains', ar: ar('جبال وعرة', 'قمم', 'قمة جبل'), en: ['mountainous', 'mountain peak', 'summit', 'craggy peaks'] },
  { id: 'dunes', category: 'landform', terrain: 'dunes', ar: ar('كثبان', 'كثبان رملية', 'رمال'), en: ['dunes', 'sand dunes', 'sandy', 'sand sea'] },
  { id: 'islands-terrain', category: 'landform', terrain: 'islands', ar: ar('جزر متناثرة'), en: ['islets', 'small islands'] },
  { id: 'valley', category: 'landform', terrain: 'valley', ar: ar('وادي', 'وديان'), en: ['valley', 'valleys', 'dale', 'river valley'] },
  { id: 'plateau', category: 'landform', terrain: 'plateau', ar: ar('هضبة', 'هضاب'), en: ['plateau', 'mesa', 'tableland'] },
  { id: 'canyon', category: 'landform', terrain: 'canyon', ar: ar('اخدود', 'اخاديد', 'خوانق'), en: ['canyon', 'gorge', 'ravine', 'chasm'] },
  { id: 'volcano', category: 'landform', terrain: 'volcano', ar: ar('بركان', 'براكين'), en: ['volcano', 'volcanic'] },
  { id: 'crater', category: 'landform', terrain: 'crater', ar: ar('فوهة بركانية', 'فوهة'), en: ['crater', 'volcanic crater'] },

  // ── Water ─────────────────────────────────────────────────────────────────
  { id: 'sea', category: 'water', ar: ar('بحر', 'بحار', 'محيط'), en: ['sea', 'ocean', 'seaside', 'coast', 'coastline', 'shore', 'beach'] },
  { id: 'lake', category: 'water', ar: ar('بحيرة', 'بحيرات', 'بركة'), en: ['lake', 'lakes', 'pond', 'lagoon', 'pool'] },
  { id: 'river', category: 'water', ar: ar('نهر', 'انهار', 'جدول'), en: ['river', 'rivers', 'stream', 'brook', 'creek', 'watercourse'] },
  { id: 'water', category: 'water', ar: ar('ماء', 'مياه', 'مسطح مائي'), en: ['water', 'waters', 'water body'] },
  { id: 'oasis', category: 'water', ar: ar('واحة', 'واحات'), en: ['oasis'] },
  { id: 'marsh', category: 'water', ar: ar('مستنقع', 'اهوار', 'سبخة'), en: ['marsh', 'swamp', 'wetland', 'bog'] },

  // ── Vegetation ────────────────────────────────────────────────────────────
  { id: 'tree', category: 'vegetation', assetId: 'tree', ar: ar('شجرة', 'اشجار', 'شجر'), en: ['tree', 'trees'] },
  { id: 'pine', category: 'vegetation', assetId: 'pine', ar: ar('صنوبر', 'اشجار الصنوبر'), en: ['pine', 'pines', 'pine tree', 'pine trees', 'conifer'] },
  { id: 'palm', category: 'vegetation', assetId: 'palm', ar: ar('نخلة', 'نخيل'), en: ['palm', 'palms', 'palm tree', 'palm trees'] },
  { id: 'cactus', category: 'vegetation', assetId: 'cactus', ar: ar('صبار'), en: ['cactus', 'cacti'] },
  { id: 'bush', category: 'vegetation', assetId: 'bush', ar: ar('شجيرة', 'شجيرات'), en: ['bush', 'bushes', 'shrub', 'shrubs'] },
  { id: 'flower', category: 'vegetation', assetId: 'flower', ar: ar('زهرة', 'زهور', 'ورود'), en: ['flower', 'flowers', 'blossom', 'blossoms'] },
  { id: 'grass-tuft', category: 'vegetation', assetId: 'grass-tuft', ar: ar('عشب', 'حشائش'), en: ['grass', 'grasses', 'lawn', 'undergrowth'] },
  { id: 'fern', category: 'vegetation', assetId: 'fern', ar: ar('سرخس'), en: ['fern', 'ferns'] },
  { id: 'bamboo', category: 'vegetation', assetId: 'bamboo', ar: ar('خيزران'), en: ['bamboo'] },
  { id: 'reed', category: 'vegetation', assetId: 'reed', ar: ar('قصب'), en: ['reed', 'reeds'] },
  { id: 'mushroom', category: 'vegetation', assetId: 'mushroom', ar: ar('فطر', 'فطريات'), en: ['mushroom', 'mushrooms'] },
  { id: 'orchard', category: 'vegetation', ar: ar('بستان', 'مزرعة اشجار'), en: ['orchard', 'grove'] },
  { id: 'dead-tree', category: 'vegetation', assetId: 'dead-tree', ar: ar('شجرة يابسة', 'اشجار يابسة'), en: ['dead tree', 'dead trees'] },

  // ── Structures ────────────────────────────────────────────────────────────
  { id: 'house', category: 'structure', assetId: 'house', ar: ar('بيت', 'بيوت', 'منزل', 'منازل'), en: ['house', 'houses', 'home', 'homes', 'cottage', 'cottages', 'hut', 'huts'] },
  { id: 'castle', category: 'structure', assetId: 'castle', ar: ar('قلعة', 'قلاع'), en: ['castle', 'castles', 'fortress', 'fortresses', 'keep', 'citadel'] },
  { id: 'tower', category: 'structure', assetId: 'tower', ar: ar('برج', 'ابراج'), en: ['tower', 'towers'] },
  { id: 'watchtower', category: 'structure', assetId: 'watchtower', ar: ar('برج مراقبة', 'ابراج مراقبة', 'برج حراسة'), en: ['watchtower', 'watchtowers', 'watch tower'] },
  { id: 'ruin', category: 'structure', assetId: 'ruin', ar: ar('أطلال مبنى', 'بقايا مبنى'), en: ['ruin', 'ruins', 'ruined building'] },
  { id: 'barn', category: 'structure', assetId: 'barn', ar: ar('حظيرة'), en: ['barn', 'barns'] },
  { id: 'coop', category: 'structure', assetId: 'coop', ar: ar('قن دجاج'), en: ['chicken coop', 'coops'] },
  { id: 'windmill', category: 'structure', assetId: 'windmill', ar: ar('طاحونة هوائية'), en: ['windmill', 'windmills'] },
  { id: 'lighthouse', category: 'structure', assetId: 'lighthouse', ar: ar('منارة'), en: ['lighthouse', 'lighthouses'] },
  { id: 'shrine', category: 'structure', assetId: 'shrine', ar: ar('ضريح'), en: ['shrine', 'shrines', 'temple', 'temples'] },
  { id: 'gazebo', category: 'structure', assetId: 'gazebo', ar: ar('مظلة حديقة'), en: ['gazebo', 'gazebos', 'pavilion'] },
  { id: 'market-stall', category: 'structure', assetId: 'market-stall', ar: ar('كشك سوق'), en: ['market stall', 'market stalls', 'stall', 'stalls'] },
  { id: 'tent', category: 'structure', assetId: 'tent', ar: ar('خيمة', 'خيام'), en: ['tent', 'tents'] },
  { id: 'well', category: 'structure', assetId: 'well', ar: ar('بئر', 'ابار', 'بير'), en: ['well', 'wells', 'water well'] },
  { id: 'fountain', category: 'structure', assetId: 'fountain', ar: ar('نافورة'), en: ['fountain', 'fountains'] },
  { id: 'stone-arch', category: 'structure', assetId: 'stone-arch', ar: ar('قوس حجري'), en: ['stone arch', 'arch', 'arches'] },
  { id: 'bridge', category: 'structure', assetId: 'bridge', ar: ar('جسر', 'جسور'), en: ['bridge', 'bridges'] },
  { id: 'mine-entrance', category: 'structure', assetId: 'mine-entrance', ar: ar('منجم'), en: ['mine', 'mines', 'gold mine'] },
  { id: 'wall', category: 'structure', assetId: 'wood-fence', ar: ar('سور', 'سياج'), en: ['wall', 'walls', 'fence', 'fences', 'palisade'] },
  { id: 'column', category: 'structure', assetId: 'column', ar: ar('عمود حجري'), en: ['stone column', 'columns'] },

  // ── Settlements (multi-building concepts, realized through counts) ────────
  { id: 'village', category: 'settlement', ar: ar('قرية', 'قرى'), en: ['village', 'hamlet'] },
  { id: 'town', category: 'settlement', ar: ar('بلدة'), en: ['town'] },
  { id: 'city', category: 'settlement', ar: ar('مدينة', 'مدن'), en: ['city', 'cities', 'metropolis'] },
  { id: 'camp', category: 'settlement', ar: ar('مخيم'), en: ['camp', 'encampment'] },
  { id: 'farm', category: 'settlement', ar: ar('مزرعة'), en: ['farm', 'farmhouse', 'farmland'] },

  // ── Props ─────────────────────────────────────────────────────────────────
  { id: 'barrel', category: 'prop', assetId: 'barrel', ar: ar('برميل'), en: ['barrel', 'barrels'] },
  { id: 'crate', category: 'prop', assetId: 'crate', ar: ar('صندوق خشبي'), en: ['crate', 'crates', 'wooden box'] },
  { id: 'bench', category: 'prop', assetId: 'bench', ar: ar('مقعد'), en: ['bench', 'benches'] },
  { id: 'table', category: 'prop', assetId: 'table', ar: ar('طاولة'), en: ['table', 'tables'] },
  { id: 'chair', category: 'prop', assetId: 'chair', ar: ar('كرسي'), en: ['chair', 'chairs'] },
  { id: 'campfire', category: 'prop', assetId: 'campfire', ar: ar('نار مخيم'), en: ['campfire', 'fire pit'] },
  { id: 'signpost', category: 'prop', assetId: 'signpost', ar: ar('لوحة ارشاد'), en: ['signpost', 'signposts', 'sign'] },
  { id: 'flag', category: 'prop', assetId: 'flag', ar: ar('راية'), en: ['flag', 'flags', 'banner', 'banners'] },
  { id: 'wagon', category: 'prop', assetId: 'wagon', ar: ar('عربة نقل'), en: ['wagon', 'wagons', 'cart'] },
  { id: 'hay-bale', category: 'prop', assetId: 'hay-bale', ar: ar('كومة قش'), en: ['hay bale', 'hay bales', 'hay'] },
  { id: 'chest', category: 'prop', assetId: 'chest', ar: ar('صندوق كنز'), en: ['chest', 'treasure chest'] },
  { id: 'lantern', category: 'prop', assetId: 'lantern', ar: ar('فانوس', 'مصابيح'), en: ['lantern', 'lanterns', 'lamp', 'lamps'] },
  { id: 'road', category: 'prop', assetId: 'dirt-path', ar: ar('طريق', 'طرق', 'ممر'), en: ['road', 'roads', 'path', 'paths', 'trail', 'trails', 'lane', 'lanes'] },
  { id: 'wheat-field', category: 'prop', assetId: 'wheat-field', ar: ar('حقل قمح'), en: ['wheat field', 'wheat fields', 'field of wheat', 'crops'] },
  // "stone"/"stones" belong to the material entry: "stone houses" describes the
  // walls, not a pile of rocks.
  { id: 'rock', category: 'prop', assetId: 'boulder', ar: ar('صخرة', 'صخور'), en: ['rock', 'rocks', 'boulder', 'boulders'] },
  { id: 'crystal', category: 'prop', assetId: 'crystal', ar: ar('بلورات'), en: ['crystal', 'crystals'] },

  // ── Animals (named and counted; no local procedural builder yet) ──────────
  { id: 'horse', category: 'animal', unrealizable: true, ar: ar('حصان', 'خيول', 'فرس', 'احصنة'), en: ['horse', 'horses'] },
  { id: 'deer', category: 'animal', unrealizable: true, ar: ar('غزال', 'غزلان', 'ايل'), en: ['deer'] },
  { id: 'camel', category: 'animal', unrealizable: true, ar: ar('جمل', 'جمال', 'ابل'), en: ['camel', 'camels'] },
  { id: 'sheep', category: 'animal', unrealizable: true, ar: ar('خروف', 'غنم', 'خراف', 'اغنام'), en: ['sheep', 'lamb', 'lambs'] },
  { id: 'goat', category: 'animal', unrealizable: true, ar: ar('ماعز', 'معز'), en: ['goat', 'goats'] },
  { id: 'cow', category: 'animal', unrealizable: true, ar: ar('بقرة', 'بقر', 'ابقار'), en: ['cow', 'cows', 'cattle'] },
  { id: 'bird', category: 'animal', unrealizable: true, ar: ar('طائر', 'طيور'), en: ['bird', 'birds'] },
  { id: 'eagle', category: 'animal', unrealizable: true, ar: ar('نسر', 'نسور'), en: ['eagle', 'eagles'] },
  { id: 'wolf', category: 'animal', unrealizable: true, ar: ar('ذئب', 'ذئاب'), en: ['wolf', 'wolves'] },
  { id: 'fox', category: 'animal', unrealizable: true, ar: ar('ثعلب', 'ثعالب'), en: ['fox', 'foxes'] },
  { id: 'rabbit', category: 'animal', unrealizable: true, ar: ar('ارنب', 'ارانب'), en: ['rabbit', 'rabbits'] },
  { id: 'bear', category: 'animal', unrealizable: true, ar: ar('دب', 'دببة'), en: ['bear', 'bears'] },
  { id: 'fish', category: 'animal', unrealizable: true, ar: ar('سمك', 'اسماك'), en: ['fish', 'fishes'] },
  { id: 'elephant', category: 'animal', unrealizable: true, ar: ar('فيل', 'افيال'), en: ['elephant', 'elephants'] },
  { id: 'giraffe', category: 'animal', unrealizable: true, ar: ar('زرافة'), en: ['giraffe', 'giraffes'] },
  { id: 'monkey', category: 'animal', unrealizable: true, ar: ar('قرد', 'قرود'), en: ['monkey', 'monkeys'] },
  { id: 'chicken', category: 'animal', unrealizable: true, ar: ar('دجاجة', 'دجاج', 'ديك'), en: ['chicken', 'chickens', 'hen', 'hens'] },

  // ── Weather ───────────────────────────────────────────────────────────────
  { id: 'clear', category: 'weather', ar: ar('سماء صافية', 'جو صاف'), en: ['clear sky', 'cloudless', 'fair weather'] },
  { id: 'fog', category: 'weather', ar: ar('ضباب', 'ضبابي'), en: ['fog', 'foggy', 'mist', 'misty', 'haze'] },
  { id: 'rain', category: 'weather', ar: ar('مطر', 'ممطر'), en: ['rain', 'rainy', 'drizzle', 'storm rain'] },
  { id: 'storm', category: 'weather', ar: ar('عاصفة', 'رعد'), en: ['storm', 'stormy', 'thunder', 'thunderstorm'] },
  { id: 'snow', category: 'weather', ar: ar('ثلج', 'ثلوج', 'عاصفة ثلجية'), en: ['snow', 'snowy', 'blizzard', 'snowfall'] },
  { id: 'sandstorm', category: 'weather', ar: ar('عاصفة رملية'), en: ['sandstorm', 'dust storm'] },
  { id: 'wind', category: 'weather', ar: ar('رياح', 'عاصف الرياح'), en: ['windy', 'wind', 'gusty'] },
  { id: 'cloudy', category: 'weather', ar: ar('غائم', 'غيوم'), en: ['cloudy', 'overcast', 'clouds'] },
  { id: 'hot', category: 'weather', ar: ar('حار'), en: ['hot', 'scorching', 'heat'] },
  { id: 'cold', category: 'weather', ar: ar('بارد'), en: ['cold', 'freezing', 'frost'] },

  // ── Time of day ───────────────────────────────────────────────────────────
  { id: 'day', category: 'time', time: 'day', ar: ar('نهار', 'ظهر', 'صباح', 'ضحى'), en: ['day', 'daylight', 'noon', 'midday', 'morning'] },
  { id: 'sunset', category: 'time', time: 'sunset', ar: ar('غروب', 'شفق', 'عصر', 'فجر'), en: ['sunset', 'dusk', 'sunrise', 'dawn', 'golden hour', 'twilight', 'evening'] },
  { id: 'night', category: 'time', time: 'night', ar: ar('ليل', 'منتصف الليل', 'نجوم'), en: ['night', 'midnight', 'nighttime', 'starry', 'stars', 'moonlit'] },

  // ── Rendering style ───────────────────────────────────────────────────────
  { id: 'cartoon', category: 'style', style: 'cartoon', ar: ar('كرتوني'), en: ['cartoon', 'cartoony', 'stylized cartoon', 'low poly'] },
  { id: 'natural', category: 'style', style: 'natural', ar: ar('واقعي', 'طبيعي'), en: ['realistic', 'natural', 'photorealistic'] },
  { id: 'stylized', category: 'style', style: 'stylized', ar: ar('فني', 'مبتكر'), en: ['stylized', 'artistic'] },
  { id: 'fantasy', category: 'style', ar: ar('خيالي', 'اسطوري'), en: ['fantasy', 'magical', 'mythical', 'enchanted'] },

  // ── Architectural language ────────────────────────────────────────────────
  { id: 'medieval', category: 'architecture', ar: ar('قروسطي', 'طراز قروسطي', 'وسيط', 'عصور وسطى', 'طراز قديم'), en: ['medieval', 'mediaeval', 'middle ages', 'castle style'] },
  { id: 'ancient', category: 'architecture', ar: ar('قديم', 'اثري'), en: ['ancient', 'antique', 'prehistoric'] },
  { id: 'modern', category: 'architecture', ar: ar('حديث', 'عصري'), en: ['modern', 'contemporary', 'futuristic', 'sci-fi'] },
  { id: 'desert-arch', category: 'architecture', ar: ar('طراز صحراوي', 'مغربي', 'اندلسي'), en: ['desert style', 'moorish', 'andalusian', 'arabic style', 'ottoman'] },
  { id: 'gothic', category: 'architecture', ar: ar('قوطي'), en: ['gothic'] },
  { id: 'viking', category: 'architecture', ar: ar('شمالي', 'فايكنج'), en: ['viking', 'nordic', 'norse'] },
  { id: 'rustic', category: 'architecture', ar: ar('ريفي'), en: ['rustic', 'rural', 'farmhouse style'] },
  { id: 'ruined-arch', category: 'architecture', ar: ar('مهدم'), en: ['ruined', 'crumbling', 'broken down', 'weathered'] },

  // ── Materials / palette ───────────────────────────────────────────────────
  { id: 'stone-mat', category: 'material', ar: ar('حجر', 'حجري'), en: ['stone', 'rocky', 'granite', 'marble'] },
  { id: 'wood-mat', category: 'material', ar: ar('خشب', 'خشبي'), en: ['wood', 'wooden', 'timber'] },
  { id: 'brick-mat', category: 'material', ar: ar('طوب', 'قرميد', 'قرميدي', 'اجر'), en: ['brick', 'bricks', 'terracotta'] },
  { id: 'clay-mat', category: 'material', ar: ar('طين', 'لبن'), en: ['clay', 'adobe', 'mud brick', 'mudbrick'] },
  { id: 'sand-mat', category: 'material', ar: ar('رملي'), en: ['sand', 'sandstone'] },
  { id: 'metal-mat', category: 'material', ar: ar('معدن'), en: ['metal', 'steel', 'iron'] },
  { id: 'thatch-mat', category: 'material', ar: ar('قش'), en: ['thatch', 'thatched', 'straw roof'] },
  { id: 'snow-mat', category: 'material', ar: ar('ثلجي'), en: ['snow', 'icy', 'ice'] },
  { id: 'white-mat', category: 'material', ar: ar('ابيض'), en: ['white', 'pale'] },
  { id: 'dark-mat', category: 'material', ar: ar('اسود', 'داكن'), en: ['black', 'dark'] },
  { id: 'red-mat', category: 'material', ar: ar('احمر'), en: ['red', 'crimson'] },

  // ── Scale ─────────────────────────────────────────────────────────────────
  { id: 'tiny-world', category: 'scale', scale: 'small', ar: ar('صغير جدا', 'مصغر'), en: ['tiny', 'very small', 'miniature', 'compact'] },
  { id: 'small-world', category: 'scale', scale: 'small', ar: ar('صغير'), en: ['small', 'little', 'modest'] },
  { id: 'medium-world', category: 'scale', scale: 'medium', ar: ar('متوسط'), en: ['medium', 'mid-sized', 'average'] },
  { id: 'large-world', category: 'scale', scale: 'large', ar: ar('كبير', 'شاسع', 'واسع'), en: ['large', 'big', 'vast', 'expansive', 'huge', 'enormous', 'sweeping'] },
  { id: 'endless-world', category: 'scale', scale: 'large', ar: ar('لا نهائي', 'ممتد'), en: ['endless', 'limitless', 'infinite'] },

  // ── Density ───────────────────────────────────────────────────────────────
  { id: 'dense', category: 'density', density: 'dense', ar: ar('كثيف', 'مزدحم', 'وفير'), en: ['dense', 'thick', 'lush', 'abundant', 'crowded', 'packed', 'bustling'] },
  { id: 'normal-density', category: 'density', density: 'normal', ar: ar('متوسط الكثافة'), en: ['moderate', 'balanced'] },
  { id: 'sparse', category: 'density', density: 'sparse', ar: ar('متفرق', 'خفيف', 'قليل'), en: ['sparse', 'scattered', 'few', 'minimal', 'quiet'] },
  { id: 'empty', category: 'density', density: 'sparse', ar: ar('فارغ', 'خالي'), en: ['empty', 'barren', 'bare', 'desolate'] },

  // ── Regions / positions ───────────────────────────────────────────────────
  { id: 'north', category: 'region', ar: ar('شمال', 'شمالي'), en: ['north', 'northern'] },
  { id: 'south', category: 'region', ar: ar('جنوب', 'جنوبي'), en: ['south', 'southern'] },
  { id: 'east', category: 'region', ar: ar('شرق', 'شرقي'), en: ['east', 'eastern'] },
  { id: 'west', category: 'region', ar: ar('غرب', 'غربي'), en: ['west', 'western'] },
  { id: 'center', category: 'region', ar: ar('وسط', 'مركز', 'منتصف'), en: ['center', 'centre', 'middle', 'heart'] },
  { id: 'edge', category: 'region', ar: ar('حافة', 'طرف', 'حدود'), en: ['edge', 'border', 'outskirts', 'fringe', 'perimeter'] },
  { id: 'summit-region', category: 'region', ar: ar('قمة', 'اعلى'), en: ['summit', 'top', 'peak', 'crest'] },
  { id: 'base-region', category: 'region', ar: ar('سفح', 'اسفل', 'قاعدة'), en: ['foot', 'base', 'bottom'] },
  { id: 'slope-region', category: 'region', ar: ar('منحدر'), en: ['slope', 'hillside', 'slope side'] },
  { id: 'waterfront-region', category: 'region', ar: ar('ضفة', 'شاطئ'), en: ['bank', 'shore', 'waterfront', 'riverside', 'lakeside', 'beach'] },
];

const BY_ID = new Map(LEXICON.map((entry) => [entry.id, entry]));

export function lexiconEntry(id: string): LexiconEntry | undefined {
  return BY_ID.get(id);
}

export function entriesIn(category: LexiconCategory): LexiconEntry[] {
  return LEXICON.filter((entry) => entry.category === category);
}

/** Arabic label for an entry, used in Arabic-facing notices. */
export function labelFor(id: string): string {
  return BY_ID.get(id)?.ar[0] ?? BY_ID.get(id)?.en[0] ?? id;
}

/**
 * Terms the planner recognises but nothing local can build yet. Recognizing
 * them is still useful: they become explicit spec entries, counted and reported,
 * and they stop the description from being silently ignored.
 */
export function unrealizableIds(): string[] {
  return LEXICON.filter((entry) => entry.unrealizable).map((entry) => entry.id);
}
