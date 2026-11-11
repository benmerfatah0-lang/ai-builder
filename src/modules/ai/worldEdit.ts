/** Small, explicit and atomic text edits. This is not a general language model. */
import { addRiverThroughVillage } from '../../core/generation/villageRiver';
import { correctBuildSpelling, spellingNotice } from './spelling';
import { ASSET_LIBRARY } from '../../core/assets/catalog';
import { footprintFromObject, footprintFromRect, PlacementLedger } from '../../core/generation/placement';
import { mulberry32, range } from '../../core/generation/rng';
import { createTerrainSampler } from '../../core/generation/terrain';
import { hashString } from '../../core/utils/id';
import { isEffectivelyLocked, worldTransformOf } from '../../core/world-plan/hierarchy';
import { MAX_WORLD_OBJECTS, validateWorldPlan, type WorldObject, type WorldPlan } from '../../core/world-plan/schema';
import { directionBetween, findAssetMentions, normalizeAssetText, parseAssetRequests, parseCountToken, type AssetDirection, type AssetRequest } from './assetRequests';
import { applyShapeModel, type ShapeModel } from './shapeLearner';

type Position = [number, number, number];
export interface WorldEditResult { plan: WorldPlan; message: string }

export function matchesAsset(object: WorldObject, id: string): boolean {
  if (id === 'tree') return object.kind === 'tree' && ['pine', 'broadleaf', 'palm'].includes(object.variant);
  if (['pine', 'palm', 'broadleaf', 'cactus', 'bush'].includes(id)) return object.kind === 'tree' && object.variant === id;
  if (id === 'boulder') return object.kind === 'rock';
  if (id === 'crag') return object.kind === 'rock' && object.variant === 'crag';
  if (['house', 'tower', 'barn', 'coop', 'ruin'].includes(id)) return object.kind === 'building' && object.variant === id;
  if (id === 'bridge') return object.kind === 'bridge';
  if (id === 'wheat-field') return object.kind === 'field';
  if (id === 'lantern') return object.kind === 'lantern';
  if (id === 'wood-fence') return object.kind === 'fence';
  if (id === 'dirt-path') return object.kind === 'path';
  return object.kind === 'primitive' && object.primitive === id;
}

function resolve(plan: WorldPlan, id: string | undefined, selection: string[], exclude?: string): WorldObject {
  const candidates = plan.objects.filter((object) => object.id !== exclude && (!id || matchesAsset(object, id)));
  const selected = candidates.filter((object) => selection.includes(object.id));
  if (selected.length === 1) return selected[0]!;
  if (selected.length > 1 || candidates.length > 1) throw new Error('يوجد أكثر من عنصر مطابق. اختر العنصر المطلوب في المشهد أولاً.');
  if (!candidates.length) throw new Error('لم أجد العنصر المطلوب في العالم.');
  return candidates[0]!;
}

function ledgerFor(plan: WorldPlan, excludedId?: string): PlacementLedger {
  const ledger = new PlacementLedger();
  let cells = 0;
  const half = plan.terrain.size / 2;
  for (const item of plan.objects) {
    // Roads, rivers and ground slabs are meant to lie beneath other assets.
    if (item.id === excludedId || item.kind === 'path' || item.kind === 'river' || (item.kind === 'primitive' && item.primitive === 'plane')) continue;
    const transform = worldTransformOf(plan, item.id);
    if (!transform) continue;
    const footprint = footprintFromObject({ ...item, transform, meta: { ...item.meta, collision: { shape: 'box', blocking: true } } });
    if (!footprint) continue;
    if (![footprint.minX, footprint.maxX, footprint.minZ, footprint.maxZ].every(Number.isFinite)) throw new Error('تعذّر فحص أبعاد أحد العناصر؛ لم يتغير العالم.');
    const bounded = { minX: Math.max(-half, footprint.minX), maxX: Math.min(half, footprint.maxX), minZ: Math.max(-half, footprint.minZ), maxZ: Math.min(half, footprint.maxZ) };
    if (bounded.minX > bounded.maxX || bounded.minZ > bounded.maxZ) continue;
    cells += (Math.ceil((bounded.maxX - bounded.minX) / 8) + 2) * (Math.ceil((bounded.maxZ - bounded.minZ) / 8) + 2);
    if (cells > 100_000) throw new Error('المشهد مزدحم جداً للفحص على الهاتف؛ لم يتغير العالم.');
    ledger.add(bounded, item.name);
  }
  return ledger;
}

function fits(plan: WorldPlan, object: WorldObject, ledger: PlacementLedger): boolean {
  const [x, y, z] = object.transform.position;
  const [width, , depth] = object.meta.dimensions;
  const box = footprintFromRect(x, z, width * object.transform.scale[0], depth * object.transform.scale[2], object.transform.rotation[1]);
  const edge = plan.terrain.size / 2 - 1;
  if (box.minX < -edge || box.maxX > edge || box.minZ < -edge || box.maxZ > edge) return false;
  if (plan.terrain.waterLevel !== null && y < plan.terrain.waterLevel + 0.35) return false;
  return ledger.isFree(box, 0.5);
}

function place(plan: WorldPlan, object: WorldObject, ledger: PlacementLedger, rng: () => number, direction?: AssetDirection, anchor?: Position): Position | null {
  const sampler = createTerrainSampler(plan.terrain, plan.seed);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let x: number, z: number;
    if (anchor && direction) {
      if (direction === 'near' && attempt >= 48) break;
      const distance = 6 + Math.floor(attempt / 8) * 2 + range(rng, 0, 2);
      const offset = range(rng, -2, 2);
      if (direction === 'right') { x = anchor[0] + distance; z = anchor[2] + offset; }
      else if (direction === 'left') { x = anchor[0] - distance; z = anchor[2] + offset; }
      else if (direction === 'front') { x = anchor[0] + offset; z = anchor[2] - distance; }
      else if (direction === 'behind') { x = anchor[0] + offset; z = anchor[2] + distance; }
      else { const angle = range(rng, 0, 2 * Math.PI); x = anchor[0] + Math.cos(angle) * distance; z = anchor[2] + Math.sin(angle) * distance; }
    } else {
      const radius = plan.terrain.size * 0.38;
      x = range(rng, -radius, radius); z = range(rng, -radius, radius);
    }
    const position: Position = [x, sampler.heightAt(x, z), z];
    const candidate: WorldObject = { ...object, transform: { ...object.transform, position } };
    if (fits(plan, candidate, ledger)) return position;
  }
  return null;
}

function withSize(object: WorldObject, size: AssetRequest['size']): WorldObject {
  const factors = size === 'small' ? [.7, .7, .7] : size === 'large' ? [1.4, 1.4, 1.4] : size === 'tall' ? [1, 1.4, 1] : size === 'wide' ? [1.4, 1, 1.4] : [1, 1, 1];
  return { ...object, transform: { ...object.transform, scale: object.transform.scale.map((v, i) => v * factors[i]!) as Position } };
}

const COLORS: [RegExp, string, string][] = [
  [/احمر|حمراء|red/i, '#c94b48', 'أحمر'], [/ازرق|زرقاء|blue/i, '#4c85cb', 'أزرق'],
  [/اخضر|خضراء|green/i, '#5d9a57', 'أخضر'], [/اصفر|صفراء|yellow/i, '#e7c052', 'أصفر'],
  [/برتقالي|orange/i, '#df8b43', 'برتقالي'], [/ابيض|بيضاء|white/i, '#ede9e3', 'أبيض'],
  [/اسود|سوداء|black/i, '#282830', 'أسود'], [/بني|brown/i, '#8e6348', 'بني'],
  [/بنفسجي|purple/i, '#9463bc', 'بنفسجي'],
];

const COMMON_WORDS = new Set(('علي الي من عن في بجانب بجوار بالقرب قرب امام قدام خلف وراء يمين يسار شمال لي لليمين لليسار العنصر المحدد المختار واحد واحدة واحده اثنين اثنان اثنتين ثلاث ثلاثة ثلاثه اربع اربعة اربعه خمس خمسة خمسه ست ستة سته سبع سبعة سبعه ثمان ثمانية ثمانيه تسع تسعة تسعه عشر عشرة عشره one two three four five six seven eight nine ten the a an to of on at next near beside left right behind front in selected object item un une le la les').split(' '));
const SIZE_WORDS = /^(?:صغير(?:ه|ة)?|كبير(?:ه|ة)?|ضخم(?:ه|ة)?|طويل(?:ه|ة)?|عريض(?:ه|ة)?|واسع(?:ه|ة)?|small|tiny|little|large|big|huge|tall|wide|broad)$/u;
function validateCommandWords(text: string, verb: RegExp, action: string): number[] {
  const numbers: number[] = [];
  // Refuse unrecognized qualifiers rather than silently deleting or changing
  // the wrong item. Catalog nouns are removed using their original spans.
  const chars = text.split('');
  // Normalized Arabic and ASCII are single UTF-16 code units for this grammar.
  for (const mention of findAssetMentions(text)) for (let i = mention.start; i < mention.end; i++) chars[i] = ' ';
  const remainder = chars.join('').replace(verb, '');
  for (const token of remainder.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const word = token.startsWith('و') && token.length > 1 ? token.slice(1) : token;
    const number = parseCountToken(token) ?? parseCountToken(word);
    if (number !== undefined) { numbers.push(number); continue; }
    if (COMMON_WORDS.has(token) || COMMON_WORDS.has(word) || COMMON_WORDS.has(word.replace(/^ال/u, ''))) continue;
    const adjective = word.replace(/^(?:بال|ال)/u, '');
    if (action === 'add' && SIZE_WORDS.test(adjective)) continue;
    if (action === 'color' && COLORS.some(([pattern]) => new RegExp(`^(?:${pattern.source})$`, 'u').test(adjective))) continue;
    throw new Error(`لم أفهم «${token}» في هذا الأمر؛ لم يتغير العالم. استخدم الأوامر المعروضة.`);
  }
  return numbers;
}

/** Apply one supported command, or throw without changing the original world. */
export function editWorldByText(plan: WorldPlan, selection: string[], command: string, shapeModel?: ShapeModel, referenceColor?: string): WorldEditResult {
  const raw = normalizeAssetText(command.trim().replace(/\s+/g, ' '));
  // Only additions are auto-corrected; never guess words in destructive edits.
  const spelling = /^(?:اضف|اضيف|ضع|add|ajoute|ajouter|اصنع|انشئ|ابني|اعمل|صمم)\s/u.test(raw) ? correctBuildSpelling(raw) : { text: raw, changes: [] };
  const text = spelling.text;
  if (!text || text.length > 400) throw new Error('اكتب أمراً واحداً لا يتجاوز 400 حرف.');
  const riverCommand = /^(?:اضف|اضيف|ضع|اصنع|انشئ|ابني|اعمل|صمم)\s+(?:لي\s+)?(?:نهر|نهرا|النهر)\s+(?:(?:يمر|يمتد)\s+)?(?:(?:في|عبر)\s+)?(?:وسط|منتصف)\s+(?:ال)?(?:قريه|قرية)[.!؟]?$/u.test(text);
  if (riverCommand) {
    const result = addRiverThroughVillage(plan, selection);
    if (!validateWorldPlan(result.plan).success) throw new Error('لم يجتز النهر فحص العالم؛ لم يُطبّق.');
    return { ...result, message: `${result.message}${spelling.changes.length ? ` ${spellingNotice(spelling.changes)}` : ''}` };
  }
  const verbs: [RegExp, 'add' | 'delete' | 'grow' | 'shrink' | 'color' | 'move'][] = [
    [/^(?:اضف|اضيف|ضع|اصنع|انشئ|ابني|اعمل|صمم|add|ajoute|ajouter)\s/u, 'add'], [/^(?:احذف|ازل|امسح|delete|remove)\s/u, 'delete'],
    [/^(?:كبر|كبّر|زد حجم|enlarge)\s/u, 'grow'], [/^(?:صغر|صغّر|قلل حجم|shrink)\s/u, 'shrink'],
    [/^(?:لون|لوّن|غير لون|color|colour)\s/u, 'color'], [/^(?:حرك|حرّك|انقل|move)\s/u, 'move'],
  ];
  const action = verbs.find(([pattern]) => pattern.test(text))?.[1];
  if (!action) throw new Error('أمر غير مدعوم. ابدأ بـ: أضف، احذف، كبّر، صغّر، لوّن أو حرّك.');
  const remainder = text.replace(verbs.find(([pattern]) => pattern.test(text))![0], '');
  if (/(?:^|\s|و)(?:ثم|اضف|اضيف|اصنع|انشئ|ابني|اعمل|صمم|احذف|ازل|امسح|حرك|انقل|لون|كبر|صغر|add|ajoute|ajouter|delete|remove|move|color|colour|enlarge|shrink|and then)/u.test(remainder)) throw new Error('اكتب تعديلاً واحداً في كل مرة.');
  if (/(?:بدون|دون|بلا|except|without|جميع|كافه|كل|all|سقف|باب|نافذ|داخل|فوق|بين)/u.test(text)) throw new Error('هذا التفصيل غير مدعوم في التعديل النصي؛ لم يتغير العالم.');
  const numbers = validateCommandWords(text, verbs.find(([pattern]) => pattern.test(text))![0], action);
  if (action !== 'color' && COLORS.some(([pattern]) => pattern.test(text))) throw new Error('الألوان في أمر منفصل فقط، مثل «لوّن البيت أحمر».');
  const requests = parseAssetRequests(text, true) ?? [];
  if (numbers.length > 1 || (action !== 'add' && numbers.some((n) => n !== 1)) || (action === 'add' && numbers[0] !== undefined && numbers[0] !== requests[0]?.count)) throw new Error('استخدم عدداً واحداً واضحاً للعناصر المضافة فقط؛ لم يتغير العالم.');
  const selectedOnly = /المحدد|المختار|selected (?:object|item)/u.test(text);
  if (selectedOnly) {
    if (selection.length !== 1) throw new Error('اختر عنصراً واحداً في المشهد أولاً.');
    const selected = plan.objects.find((object) => object.id === selection[0]);
    if (!selected) throw new Error('اختر عنصراً واحداً في المشهد أولاً، وليس مجموعة.');
    const mentioned = action === 'add' ? requests[1]?.assetId : requests[0]?.assetId;
    if (mentioned && !matchesAsset(selected, mentioned)) throw new Error('العنصر المحدد لا يطابق العنصر المذكور في الأمر.');
    if (action === 'add' && !directionBetween(text)) throw new Error('حدد علاقة مع العنصر المحدد، مثل «أضف شجرة يمين العنصر المحدد».');
  }
  const rng = mulberry32((plan.seed ^ hashString(text) ^ plan.objects.length) >>> 0);
  let next: WorldPlan;
  let message: string;

  if (action === 'add') {
    if (!requests.length || requests.length > 2) throw new Error('حدد نوعاً واحداً لإضافته، ويمكن تحديد عنصر مرجعي واحد.');
    const item = requests[0]!;
    if (item.count < 1 || item.count > 20 || plan.objects.length + item.count > MAX_WORLD_OBJECTS) throw new Error('يمكن إضافة 1 إلى 20 عنصراً في كل أمر، ضمن حد العالم.');
    const direction = directionBetween(text);
    if (requests.length === 2 && requests[1]!.count !== 1) throw new Error('اختر عنصراً مرجعياً واحداً فقط.');
    if (requests.length === 2 && !direction) throw new Error('حدد علاقة واضحة مثل «يمين البيت»، أو أضف نوعاً واحداً في كل مرة.');
    if (direction && requests.length < 2 && !selectedOnly) throw new Error('حدد العنصر المرجعي، مثل «يمين البيت».');
    let anchor: Position | undefined;
    if (direction) {
      const reference = resolve(plan, requests[1]?.assetId, selection);
      anchor = worldTransformOf(plan, reference.id)?.position;
      if (!anchor) throw new Error('تعذّر تحديد موقع العنصر المرجعي.');
    }
    const id = item.assetId === 'tree' ? plan.terrain.style === 'dunes' ? 'cactus' : plan.terrain.style === 'islands' ? 'palm' : plan.terrain.style === 'mountains' ? 'pine' : 'broadleaf' : item.assetId;
    const asset = ASSET_LIBRARY.find((entry) => entry.id === id);
    if (!asset) throw new Error('هذا العنصر غير موجود في المكتبة.');
    const ledger = ledgerFor(plan);
    const added: WorldObject[] = [];
    for (let i = 0; i < item.count; i++) {
      const base = asset.create(rng, [0, 0, 0]);
      const shaped = shapeModel ? applyShapeModel(base, shapeModel, rng) : base;
      const colored = shaped.kind === 'building' && shaped.variant === 'house' && referenceColor && /^#[0-9a-f]{6}$/i.test(referenceColor) ? { ...shaped, color: referenceColor } : shaped;
      const object = withSize(colored, item.size);
      const position = place(plan, object, ledger, rng, direction, anchor);
      if (!position) throw new Error('لم أجد مساحة آمنة لكل العناصر المطلوبة؛ لم يتغير العالم.');
      const placed: WorldObject = { ...object, transform: { ...object.transform, position }, meta: { ...object.meta, status: 'edited' } };
      const [w, , d] = placed.meta.dimensions;
      ledger.add(footprintFromRect(position[0], position[2], w * placed.transform.scale[0], d * placed.transform.scale[2], placed.transform.rotation[1]), placed.name);
      added.push(placed);
    }
    next = { ...plan, objects: [...plan.objects, ...added] };
    message = `أُضيف ${added.length} من ${asset.label}${direction ? ' بالنسبة للعنصر المرجعي' : ''}.${id === 'bridge' ? ' الجسر عنصر زخرفي؛ لم يُنشأ نهر تحته تلقائياً.' : ''}`;
  } else {
    if ((!requests.length && !selectedOnly) || requests.length > (action === 'move' ? 2 : 1)) throw new Error('حدد عنصراً واحداً للتعديل أو اختره في المشهد.');
    if (requests[0] && requests[0].count !== 1) throw new Error('يمكن تعديل أو حذف عنصر واحد في كل أمر. اختر العنصر المطلوب.');
    const object = resolve(plan, requests[0]?.assetId, selection);
    if (isEffectivelyLocked(plan, object.id)) throw new Error('العنصر أو مجموعته مقفل؛ أزل القفل أولاً.');
    if (action === 'delete') {
      next = { ...plan, objects: plan.objects.filter((item) => item.id !== object.id) };
      message = `حُذف ${object.name}.`;
    } else if (action === 'color') {
      const colors = COLORS.filter(([pattern]) => pattern.test(text));
      if (colors.length !== 1) throw new Error('حدد لوناً واحداً معروفاً، مثل «لوّن البيت أحمر».');
      const [, color, label] = colors[0]!;
      let changed: WorldObject;
      if (object.kind === 'fence') changed = { ...object, postColor: color };
      else if (object.kind === 'field') changed = { ...object, cropColor: color };
      else if (object.kind === 'bridge') changed = { ...object, deckColor: color };
      else changed = { ...object, color };
      changed = { ...changed, meta: { ...changed.meta, status: 'edited' } };
      next = { ...plan, objects: plan.objects.map((item) => item.id === object.id ? changed : item) };
      message = `تغيّر اللون الأساسي لـ ${object.name} إلى ${label}.`;
    } else {
      if (object.parentId) throw new Error('حرّك أو غيّر حجم العناصر داخل المجموعات من لوحة Inspect حالياً.');
      let changed: WorldObject;
      if (action === 'move') {
        const direction = directionBetween(text);
        if (!direction || requests.length !== 2) throw new Error('اكتب مثلاً: حرّك البيت إلى يسار الشجرة.');
        if (requests[1]!.count !== 1) throw new Error('اختر عنصراً مرجعياً واحداً فقط.');
        const reference = resolve(plan, requests[1]!.assetId, selection, object.id);
        const anchor = worldTransformOf(plan, reference.id)?.position;
        if (!anchor) throw new Error('تعذّر تحديد موقع العنصر المرجعي.');
        const position = place(plan, object, ledgerFor(plan, object.id), rng, direction, anchor);
        if (!position) throw new Error('لم أجد موضعاً مناسباً؛ لم يتغير العالم.');
        changed = { ...object, transform: { ...object.transform, position } };
        message = `نُقل ${object.name} بالنسبة إلى ${reference.name}.`;
      } else {
        const factor = action === 'grow' ? 1.25 : 0.8;
        const scale = object.transform.scale.map((value) => value * factor) as Position;
        if (scale.some((v) => v < .05 || v > 10)) throw new Error('وصل العنصر إلى حد الحجم المدعوم.');
        changed = { ...object, transform: { ...object.transform, scale } };
        if (!fits(plan, changed, ledgerFor(plan, object.id))) throw new Error('الحجم الجديد يتداخل مع عنصر أو يخرج من الأرض؛ لم يتغير العالم.');
        message = `تغيّر حجم ${object.name} بنسبة ${action === 'grow' ? '25% زيادة' : '20% نقصان'}.`;
      }
      changed = { ...changed, meta: { ...changed.meta, status: 'edited' } };
      next = { ...plan, objects: plan.objects.map((item) => item.id === object.id ? changed : item) };
    }
  }
  next = { ...next, updatedAt: new Date().toISOString() };
  if (!validateWorldPlan(next).success) throw new Error('لم يجتز التعديل فحص العالم؛ لم يُطبّق.');
  return { plan: next, message: `${message}${spelling.changes.length ? ` ${spellingNotice(spelling.changes)}` : ''}` };
}
