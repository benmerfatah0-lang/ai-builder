import { describe, expect, it } from 'vitest';
import { MAX_WORLD_OBJECTS } from '../../core/world-plan/schema';
import { interpretPromptLocally } from '../ai/promptInterpreter';
import { buildExecutionPlan } from './executionPlan';
import { executePlannerResult, planWorld } from './planner';
import { extractFrames } from './frames';
import { solveSpec } from './solve';
import { describeExecution, describePreflight, describeSpec, materialLabel, summarizeSpec, terrainLabel, timeLabel } from './specSummary';
import type { WorldSpec } from './worldSpec';

const BIG = 'قلعة حجرية كبيرة فوق قمة جبل، وتحتها قرية صغيرة تحيط ببحيرة، والبيوت تربطها طرق ترابية. بدون أشجار نخيل.';
const BIG_EN = 'A medieval castle on a mountain with stone houses connected by dirt roads, at sunset with fog';

const SECTIONS = [
  'أبعاد العالم', 'التضاريس والماء', 'توزيع البيئات', 'المناطق', 'المباني', 'العناصر والنباتات', 'الحيوانات',
  'المواد', 'الإضاءة', 'البيئة والجو', 'العلاقات المكانية', 'مواضع العناصر', 'النفي والتعليمات السالبة', 'سعة المستند',
];

function specFor(description: string, seed = 5): WorldSpec {
  return solveSpec(extractFrames(description), interpretPromptLocally(description, { seed }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every row of every section, flattened for whole-output assertions. */
function allText(spec: WorldSpec): string {
  return [
    ...describeSpec(spec).flatMap((section) => [section.title, ...section.rows.flatMap((row) => [row.label, row.value])]),
    ...describeExecution(spec).flatMap((step) => [step.title, step.detail, step.status]),
    summarizeSpec(spec),
    ...describePreflight(spec),
  ].join('\n');
}

describe('describeSpec: structure', () => {
  it('covers every part of the specification, in a fixed order', () => {
    expect(describeSpec(specFor(BIG)).map((section) => section.title)).toEqual(SECTIONS);
  });

  it('always has something to say in every section', () => {
    for (const description of [BIG, BIG_EN, 'عالم فارغ', 'صحراء فيها واحة']) {
      for (const section of describeSpec(specFor(description))) {
        expect(section.rows.length).toBeGreaterThan(0);
        for (const row of section.rows) {
          expect(row.label.length).toBeGreaterThan(0);
          expect(row.value.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('says plainly what was not mentioned instead of leaving a hole', () => {
    const empty = describeSpec(specFor('عالم فارغ'));
    const animals = empty.find((section) => section.title === 'الحيوانات')!;
    expect(animals.rows[0]!.value).toContain('لم تُذكر');
    expect(empty.find((section) => section.title === 'النفي والتعليمات السالبة')!.rows[0]!.value).toContain('لا تعليمات سالبة');
    expect(empty.find((section) => section.title === 'العلاقات المكانية')!.rows[0]!.value).toContain('لا علاقات');
  });
});

describe('describeSpec: it reports what the solver actually decided', () => {
  const spec = specFor(BIG);
  const rows = (title: string) => describeSpec(spec).find((section) => section.title === title)!.rows;

  it('states the world dimensions and their scale', () => {
    const dimensions = rows('أبعاد العالم');
    expect(dimensions[0]!.value).toBe(`${spec.dimensions.size} × ${spec.dimensions.size} وحدة`);
    expect(dimensions.find((row) => row.label === 'دقة التضاريس')!.value).toContain(String(spec.dimensions.resolution));
    expect(dimensions.find((row) => row.label === 'المساحة')!.value).toContain('وحدة مربعة');
  });

  it('states the terrain, its height and its water', () => {
    const terrain = rows('التضاريس والماء');
    expect(terrain[0]!.value).toBe('جبال');
    expect(terrain.find((row) => row.label === 'أقصى ارتفاع')!.value).toBe(`${spec.terrain.heightScale} وحدة`);
    expect(terrain.find((row) => row.label === 'الماء')!.value).toBe('موجود');
    expect(terrain.find((row) => row.label === 'بحيرة')!.value).toContain(String(spec.terrain.lake!.radius));
  });

  it('states biome weights that add up to a whole world', () => {
    const biomes = rows('توزيع البيئات');
    expect(biomes).toHaveLength(spec.biomes.length);
    expect(biomes.reduce((sum, row) => sum + Number.parseInt(row.value, 10), 0)).toBe(100);
  });

  it('states every building and element with its count and placement', () => {
    const buildings = rows('المباني');
    expect(buildings).toHaveLength(spec.buildings.length);
    expect(buildings[0]!.label).toBe(`${spec.buildings[0]!.label} ×${spec.buildings[0]!.count}`);
    expect(buildings[0]!.value).toContain('أعلى نقطة');
    expect(rows('العناصر والنباتات').find((row) => row.label === 'نثر النباتات')!.value)
      .toBe(`${spec.counts.trees} شجرة · ${spec.counts.rocks} صخرة · ${spec.counts.lanterns} فانوس`);
  });

  it('states the spatial relations and whether each one is solved yet', () => {
    const relations = rows('العلاقات المكانية');
    expect(relations).toHaveLength(spec.relations.length);
    expect(relations[0]!.value).toContain('فوق قمة');
    expect(relations.every((row) => row.value.includes('قيد الحل'))).toBe(true);

    const resolved = clone(spec);
    resolved.relations[0]!.status = 'resolved';
    resolved.relations[0]!.resolved = [[1, 2], [3, 4]];
    expect(describeSpec(resolved).find((section) => section.title === 'العلاقات المكانية')!.rows[0]!.value).toContain('محلولة (2 نقطة)');
  });

  it('states the negative instructions and whether they were applied', () => {
    const negations = rows('النفي والتعليمات السالبة');
    expect(negations).toHaveLength(1);
    expect(negations[0]).toEqual({ label: 'بدون نخلة', value: 'طُبّق' });
  });

  it('states the budget, and never claims more than the document holds', () => {
    const budget = rows('سعة المستند');
    expect(budget[0]!.value).toBe(`${MAX_WORLD_OBJECTS} عنصر`);
    expect(Number.parseInt(budget.find((row) => row.label === 'المقدَّر بعد النثر')!.value, 10)).toBeLessThanOrEqual(MAX_WORLD_OBJECTS);
    expect(budget.find((row) => row.label === 'احتياطي الوصلات')!.value).toContain('عنصر');
  });

  it('lists resolved positions once the layout has run', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    const positions = describeSpec(executed.spec).find((section) => section.title === 'مواضع العناصر')!.rows;
    expect(positions.length).toBeGreaterThan(0);
    expect(positions[0]!.value).toMatch(/\(-?\d+\.\d, -?\d+\.\d\)/u);
  });

  it('shows an animal as known but not buildable', () => {
    const animals = describeSpec(specFor('ثلاث غزلان وذئبان في غابة')).find((section) => section.title === 'الحيوانات')!.rows;
    expect(animals.map((row) => row.label)).toEqual(['غزال ×3', 'ذئب ×2']);
    expect(animals.every((row) => row.value.includes('لا باني محلياً'))).toBe(true);
  });
});

describe('the summary speaks Arabic, whatever language the description used', () => {
  const LATIN_WORD = /[A-Za-z]{2,}/g;

  it('never leaks an internal identifier into the Arabic report', () => {
    for (const description of [BIG, 'ثلاث غزلان وذئبان في غابة كثيفة', 'صحراء فيها واحة نخيل', 'عالم فارغ', 'غابة بدون أشجار']) {
      const text = allText(specFor(description));
      expect(text.match(LATIN_WORD) ?? []).toEqual([]);
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
    }
  });

  it('keeps only the words the user themselves wrote in another language', () => {
    // The subject and the connector of a relation are quoted from the
    // description, so an English description shows English there — and nowhere else.
    const text = allText(specFor(BIG_EN));
    const latin = text.match(LATIN_WORD) ?? [];
    expect(latin.every((word) => BIG_EN.toLowerCase().includes(word.toLowerCase()))).toBe(true);
    expect(text).toContain('غروب');
    expect(text).toContain('ضباب');
  });

  it('translates terrain, time and material identifiers', () => {
    expect(terrainLabel('mountains')).toBe('جبال');
    expect(terrainLabel('dunes')).toBe('كثبان رملية');
    expect(terrainLabel('not-a-style')).toBe('not-a-style');
    expect(timeLabel('night')).toBe('ليل');
    expect(timeLabel('sunset')).toBe('غروب');
    expect(timeLabel('day')).toBe('نهار');
    expect(materialLabel('stone')).toBe('حجر');
    expect(materialLabel('wood')).toBe('خشب');
    expect(materialLabel(undefined)).toBe('من البيئة');
    expect(materialLabel('unobtainium')).toBe('unobtainium');
  });
});

describe('summarizeSpec', () => {
  it('reads as one line of what the planner understood', () => {
    expect(summarizeSpec(specFor(BIG))).toBe('جبال 160 وحدة · جبال · 4 مبنى · 3 عنصر · 20 شجرة · 4 علاقة مكانية · نهار');
  });

  it('omits the parts the description did not ask for', () => {
    const summary = summarizeSpec(specFor('عالم فارغ'));
    expect(summary).not.toContain('مبنى');
    expect(summary).not.toContain('علاقة');
    expect(summary.split(' · ').length).toBeLessThan(summarizeSpec(specFor(BIG)).split(' · ').length);
  });

  it('mentions weather and time of day', () => {
    const summary = summarizeSpec(specFor('غابة في الليل مع ضباب'));
    expect(summary).toContain('ليل');
    expect(summary).toContain('ضباب');
  });
});

describe('describeExecution', () => {
  it('numbers every step in the order it will really run', () => {
    const steps = describeExecution(specFor(BIG));
    expect(steps).toHaveLength(16);
    expect(steps.map((step) => step.order)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
    expect(steps.map((step) => step.title)).toEqual(steps.map((step) => step.title));
    expect(steps.every((step) => step.status === 'منتظر')).toBe(true);
    expect(steps.every((step) => step.detail.length > 0)).toBe(true);
  });

  it('follows the dependency order, not the declaration order', () => {
    const spec = specFor(BIG);
    const steps = describeExecution(spec);
    const position = new Map(steps.map((step) => [step.title, step.order]));
    const byId = new Map(spec.execution.steps.map((step) => [step.id, step]));
    spec.execution.order.forEach((id, index) => {
      const step = byId.get(id)!;
      expect(steps[index]!.title).toBe(step.title);
      for (const dependency of step.dependsOn) {
        expect(position.get(byId.get(dependency)!.title)!).toBeLessThan(position.get(step.title)!);
      }
    });
  });

  it('reports what each step produced once the world is built', async () => {
    const executed = executePlannerResult(await planWorld(BIG, { seed: 5 }));
    const steps = describeExecution(executed.spec);
    expect(steps.every((step) => step.status === 'تم')).toBe(true);
    expect(steps.find((step) => step.title === 'تكوين التضاريس والماء')!.detail).toContain('جبال');
    expect(steps.find((step) => step.title === 'نثر النباتات والصخور')!.detail).toContain('شجرة');
    expect(steps.find((step) => step.title === 'تقرير التنفيذ')!.detail).toContain('تحذير');
  });
});

describe('describePreflight', () => {
  it('is silent when nothing stands in the way', () => {
    expect(describePreflight(specFor(BIG))).toEqual([]);
  });

  it('states blocking errors before warnings', () => {
    const spec = specFor('غابة بدون أشجار');
    const lines = describePreflight(spec);
    expect(lines[0]).toContain('خطأ:');
    expect(lines[0]).toContain('أسئلة حاجبة');
  });

  it('reports a request that does not fit the document', () => {
    const spec = clone(specFor(BIG));
    spec.counts.trees = MAX_WORLD_OBJECTS * 2;
    const lines = describePreflight({ ...spec, execution: buildExecutionPlan(spec) });
    expect(lines.some((line) => line.startsWith('تحذير:'))).toBe(true);
    expect(lines.join(' ')).toContain('سعة المستند');
  });

  it('reports animals that cannot be built yet', () => {
    const lines = describePreflight(specFor('ثلاث غزلان في غابة'));
    expect(lines.join(' ')).toContain('تحذير:');
    expect(lines.join(' ')).toContain('غزال');
  });
});
