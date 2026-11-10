import { labelFor } from './lexicon';
import type { WorldSpec } from './worldSpec';

/**
 * Arabic-facing rendering of a `WorldSpec` and its execution plan.
 *
 * The planner must be explainable: this is what the AI panel shows so a user can
 * see exactly what was understood, what was clamped, what was ignored and in
 * which order the world will be built — before anything is generated.
 */

export interface SpecSection {
  title: string;
  rows: { label: string; value: string }[];
}

const total = (list: { count: number }[]): number => list.reduce((sum, entry) => sum + entry.count, 0);

export function describeSpec(spec: WorldSpec): SpecSection[] {
  return [
    {
      title: 'أبعاد العالم',
      rows: [
        { label: 'المقاس', value: `${spec.dimensions.size} × ${spec.dimensions.size} وحدة` },
        { label: 'دقة التضاريس', value: `${spec.dimensions.resolution} × ${spec.dimensions.resolution}` },
        { label: 'المقياس', value: scaleLabel(spec.dimensions.scale) },
        { label: 'المساحة', value: `${spec.dimensions.areaUnitsSquared.toLocaleString('ar-EG')} وحدة مربعة` },
      ],
    },
    {
      title: 'التضاريس والماء',
      rows: [
        { label: 'شكل الأرض', value: terrainLabel(spec.terrain.style) },
        { label: 'أقصى ارتفاع', value: `${spec.terrain.heightScale} وحدة` },
        { label: 'الوعورة', value: `${Math.round(spec.terrain.roughness * 100)}%` },
        { label: 'الماء', value: spec.terrain.water ? 'موجود' : 'لا يوجد' },
        ...(spec.terrain.lake ? [{ label: 'بحيرة', value: `نصف قطر ${spec.terrain.lake.radius} · عمق ${spec.terrain.lake.depth}` }] : []),
        ...(spec.terrain.river ? [{ label: 'نهر', value: `شريط زخرفي بعرض ${spec.terrain.river.width} (لا يحفر مجرى)` }] : []),
      ],
    },
    {
      title: 'توزيع البيئات',
      rows: spec.biomes.map((zone) => ({
        label: labelFor(zone.biome),
        value: `${Math.round(zone.weight * 100)}%${zone.region ? ` · منطقة ${zone.region}` : ''}`,
      })),
    },
    {
      title: 'المناطق',
      rows: spec.regions.length
        ? spec.regions.map((region) => ({
          label: region.name,
          value: `${shapeLabel(region.shape)}${region.selector ? ` · ${selectorLabel(region.selector)}` : ''}${region.members.length ? ` · ${region.members.length} عنصر` : ''}`,
        }))
        : [{ label: '—', value: 'لم يُذكر تقسيم مكاني؛ العالم منطقة واحدة' }],
    },
    {
      title: 'المباني',
      rows: spec.buildings.length
        ? spec.buildings.map((building) => ({
          label: `${building.label} ×${building.count}`,
          value: [
            building.architecture ? `طراز ${labelFor(building.architecture)}` : '',
            building.material?.palette ? `مادة ${materialLabel(building.material.palette)}` : '',
            building.region ? `منطقة ${regionName(spec, building.region)}` : '',
            building.placement ? `موضع ${strategyLabel(building.placement.strategy)}` : '',
            building.realized === 'unrealized' ? 'لا باني محلياً' : '',
          ].filter(Boolean).join(' · ') || 'توزيع تلقائي',
        }))
        : [{ label: '—', value: 'لا مباني محددة' }],
    },
    {
      title: 'العناصر والنباتات',
      rows: [
        ...spec.assets.map((asset) => ({
          label: `${asset.label} ×${asset.count}`,
          value: [
            asset.region ? `منطقة ${regionName(spec, asset.region)}` : '',
            asset.placement ? `موضع ${strategyLabel(asset.placement.strategy)}` : '',
            asset.size ? `حجم ${sizeLabel(asset.size)}` : '',
          ].filter(Boolean).join(' · ') || 'توزيع تلقائي',
        })),
        { label: 'نثر النباتات', value: `${spec.counts.trees} شجرة · ${spec.counts.rocks} صخرة · ${spec.counts.lanterns} فانوس` },
      ],
    },
    {
      title: 'الحيوانات',
      rows: spec.animals.length
        ? spec.animals.map((animal) => ({ label: `${animal.label} ×${animal.count}`, value: 'معرّفة في المواصفات · لا باني محلياً بعد' }))
        : [{ label: '—', value: 'لم تُذكر حيوانات' }],
    },
    {
      title: 'المواد',
      rows: [
        { label: 'اللوح', value: materialLabel(spec.materials.palette) },
        { label: 'الجدران', value: spec.materials.wall ?? 'افتراضي' },
        { label: 'الأسقف', value: spec.materials.roof ?? 'افتراضي' },
        ...(spec.materials.roughness !== undefined ? [{ label: 'الخشونة', value: spec.materials.roughness.toFixed(2) }] : []),
        ...(spec.materials.metalness !== undefined ? [{ label: 'المعدنية', value: spec.materials.metalness.toFixed(2) }] : []),
      ],
    },
    {
      title: 'الإضاءة',
      rows: [
        { label: 'الوقت', value: timeLabel(spec.lighting.timeOfDay) },
        { label: 'شدة الشمس', value: `×${spec.lighting.sunIntensityScale.toFixed(2)}` },
        { label: 'الإضاءة المحيطية', value: `×${spec.lighting.ambientIntensityScale.toFixed(2)}` },
        ...(spec.lighting.sunElevation !== undefined ? [{ label: 'ارتفاع الشمس', value: `${spec.lighting.sunElevation}°` }] : []),
        ...(spec.lighting.requested.length ? [{ label: 'إشارات', value: spec.lighting.requested.join('، ') }] : []),
      ],
    },
    {
      title: 'البيئة والجو',
      rows: [
        { label: 'الطقس', value: spec.environment.weather.length ? spec.environment.weather.map(labelFor).join('، ') : 'صافٍ' },
        ...(spec.environment.season ? [{ label: 'الفصل', value: spec.environment.season }] : []),
        ...(spec.environment.fogDensity !== undefined ? [{ label: 'كثافة الضباب', value: spec.environment.fogDensity.toFixed(4) }] : []),
        ...(spec.environment.skyColor ? [{ label: 'لون السماء', value: spec.environment.skyColor }] : []),
        ...(spec.environment.style ? [{ label: 'الأسلوب', value: styleLabel(spec.environment.style) }] : []),
        ...(spec.environment.density ? [{ label: 'الكثافة', value: densityLabel(spec.environment.density) }] : []),
      ],
    },
    {
      title: 'العلاقات المكانية',
      rows: spec.relations.length
        ? spec.relations.map((relation) => ({
          label: `${relation.subject} ← ${relation.object}`,
          value: `${predicateLabel(relation.predicate)}${relation.via ? ` عبر ${relation.via}` : ''} · ${relation.status === 'resolved' ? `محلولة (${(relation.resolved?.length ?? relation.polyline?.length ?? 0)} نقطة)` : relation.status === 'unsupported' ? `لم تُحل${relation.note ? `: ${relation.note}` : ''}` : 'قيد الحل'}`,
        }))
        : [{ label: '—', value: 'لا علاقات مكانية صريحة' }],
    },
    {
      title: 'مواضع العناصر',
      rows: positionRows(spec),
    },
    {
      title: 'النفي والتعليمات السالبة',
      rows: spec.negations.length
        ? spec.negations.map((negation) => ({ label: `بدون ${negation.label}`, value: negation.applied ? 'طُبّق' : 'لم يُطبّق' }))
        : [{ label: '—', value: 'لا تعليمات سالبة' }],
    },
    {
      title: 'سعة المستند',
      rows: [
        { label: 'الحد الأقصى', value: `${spec.execution.budgets.maxObjects} عنصر` },
        { label: 'المطلوب', value: `${total(spec.buildings) + total(spec.assets)} عنصر صريح` },
        { label: 'المقدَّر بعد النثر', value: `${spec.execution.budgets.estimatedObjects} عنصر` },
        { label: 'احتياطي الوصلات', value: `${spec.execution.budgets.reservedForRelations} عنصر` },
      ],
    },
  ];
}

/** The user-facing name of a region, falling back to its id. */
function regionName(spec: WorldSpec, id: string): string {
  return spec.regions.find((region) => region.id === id)?.name ?? id;
}

function positionRows(spec: WorldSpec): { label: string; value: string }[] {
  const entries = Object.entries(spec.positions).slice(0, 12);
  if (!entries.length) return [{ label: '—', value: 'لم تُحل المواضع بعد' }];
  return entries.map(([id, positions]) => ({
    label: labelFor(id.replace(/^(?:a|b)-/, '')),
    value: positions.length
      ? positions.slice(0, 3).map(([x, z]) => `(${x.toFixed(1)}, ${z.toFixed(1)})`).join(' ') +
        (positions.length > 3 ? ` … ${positions.length} موضع` : '')
      : '—',
  }));
}

/** Ordered, dependency-checked execution steps for display. */
export function describeExecution(spec: WorldSpec): { order: number; title: string; detail: string; status: string }[] {
  return spec.execution.order.map((id, index) => {
    const step = spec.execution.steps.find((entry) => entry.id === id);
    return {
      order: index + 1,
      title: step?.title ?? id,
      detail: step?.detail ?? '',
      status: step?.status === 'done' ? 'تم' : step?.status === 'skipped' ? 'تُخطّي' : 'منتظر',
    };
  });
}

/** One-line Arabic summary of what the planner understood. */
export function summarizeSpec(spec: WorldSpec): string {
  const parts = [
    `${terrainLabel(spec.terrain.style)} ${spec.dimensions.size} وحدة`,
    labelFor(spec.primaryBiome),
    spec.buildings.length ? `${total(spec.buildings)} مبنى` : '',
    spec.assets.length ? `${total(spec.assets)} عنصر` : '',
    spec.counts.trees ? `${spec.counts.trees} شجرة` : '',
    spec.relations.length ? `${spec.relations.length} علاقة مكانية` : '',
    spec.environment.weather.length ? spec.environment.weather.map(labelFor).join('، ') : '',
    timeLabel(spec.lighting.timeOfDay),
  ];
  return parts.filter(Boolean).join(' · ');
}

export function describePreflight(spec: WorldSpec): string[] {
  return [
    ...spec.execution.preflight.errors.map((error) => `خطأ: ${error}`),
    ...spec.execution.preflight.warnings.map((warning) => `تحذير: ${warning}`),
  ];
}

/**
 * Arabic name of a material palette id.
 *
 * Palettes are stored without the lexicon's `-mat` suffix (`stone-mat` → `stone`),
 * so the label is looked up with the suffix restored; anything unknown is passed
 * through rather than silently renamed.
 */
export function materialLabel(palette: string | undefined): string {
  if (!palette) return 'من البيئة';
  const labelled = labelFor(`${palette}-mat`);
  return labelled === `${palette}-mat` ? labelFor(palette) : labelled;
}

function scaleLabel(scale: string): string {
  return scale === 'small' ? 'صغير' : scale === 'large' ? 'كبير' : 'متوسط';
}
export function terrainLabel(style: string): string {
  const map: Record<string, string> = {
    flat: 'أرض مسطحة', hills: 'تلال', mountains: 'جبال', dunes: 'كثبان رملية', islands: 'جزر',
    valley: 'وادي', plateau: 'هضبة', canyon: 'أخدود', volcano: 'بركان', crater: 'فوهة بركانية',
  };
  return map[style] ?? style;
}
function shapeLabel(shape: string): string {
  return shape === 'circle' ? 'دائرة' : shape === 'ring' ? 'حلقة' : shape === 'rect' ? 'مستطيل' : shape === 'band' ? 'شريط' : 'العالم كله';
}
function selectorLabel(selector: string): string {
  const map: Record<string, string> = {
    north: 'الشمال', south: 'الجنوب', east: 'الشرق', west: 'الغرب', center: 'الوسط',
    edge: 'الأطراف', summit: 'القمة', base: 'السفح', slope: 'المنحدر', waterfront: 'ضفة الماء',
  };
  return map[selector] ?? selector;
}
function strategyLabel(strategy: string): string {
  const map: Record<string, string> = {
    highest: 'أعلى نقطة', lowest: 'أخفض نقطة', ring: 'حلقة', scatter: 'نثر', line: 'خط عابر',
    'water-edge': 'حافة الماء', 'region-center': 'مركز المنطقة', 'anchor-offset': 'بجانب مرجع',
    midpoint: 'منتصف المسافة', chain: 'سلسلة مترابطة', explicit: 'موضع صريح',
  };
  return map[strategy] ?? strategy;
}
function predicateLabel(predicate: string): string {
  const map: Record<string, string> = {
    'on-top-of': 'فوق قمة', 'at-foot-of': 'عند سفح', inside: 'داخل', surrounding: 'يحيط بـ',
    'surrounded-by': 'محاط بـ', through: 'يعبر', across: 'يمتد فوق', near: 'بجانب',
    between: 'بين', 'connected-by': 'متصل بـ', along: 'على امتداد', facing: 'مقابل',
    'left-of': 'يسار', 'right-of': 'يمين', 'front-of': 'أمام', behind: 'خلف',
  };
  return map[predicate] ?? predicate;
}
function sizeLabel(size: string): string {
  return size === 'small' ? 'صغير' : size === 'large' ? 'كبير' : size === 'tall' ? 'طويل' : 'عريض';
}
export function timeLabel(time: string): string {
  return time === 'night' ? 'ليل' : time === 'sunset' ? 'غروب' : 'نهار';
}
function styleLabel(style: string): string {
  return style === 'cartoon' ? 'كرتوني' : style === 'natural' ? 'واقعي' : 'فني';
}
function densityLabel(density: string): string {
  return density === 'dense' ? 'كثيف' : density === 'sparse' ? 'متفرق' : 'عادي';
}
