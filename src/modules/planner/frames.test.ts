import { describe, expect, it } from 'vitest';
import { extractFrames, unusedCategories } from './frames';

const mention = (description: string, id: string) =>
  extractFrames(description).mentions.find((entry) => entry.entry.id === id);

const relation = (description: string, predicate: string) =>
  extractFrames(description).relations.find((entry) => entry.predicate === predicate);

const labels = (description: string, predicate: string) => {
  const frames = extractFrames(description);
  const hit = frames.relations.find((entry) => entry.predicate === predicate);
  if (!hit) return undefined;
  const name = (id: string) => frames.mentions.find((mention) => mention.id === id)?.entry.id ?? '';
  return { subject: name(hit.subject), object: name(hit.object), via: hit.via ? name(hit.via) : undefined, second: hit.second ? name(hit.second) : undefined };
};

describe('counts', () => {
  it('reads explicit numbers in both languages, including Arabic teens', () => {
    expect(mention('ثلاثة أبراج مراقبة وخمسة عشر بيتاً', 'watchtower')).toMatchObject({ count: 3, countSource: 'explicit' });
    expect(mention('ثلاثة أبراج مراقبة وخمسة عشر بيتاً', 'house')).toMatchObject({ count: 15, countSource: 'explicit' });
    expect(mention('seven castles', 'castle')).toMatchObject({ count: 7, countSource: 'explicit' });
    expect(mention('twenty palm trees', 'palm')).toMatchObject({ count: 20, countSource: 'explicit' });
    expect(mention('عشرون نخلة وثلاث آبار', 'well')).toMatchObject({ count: 3, countSource: 'explicit' });
  });

  it('reads a number that follows the noun', () => {
    expect(mention('trees: 12', 'tree')).toMatchObject({ count: 12, countSource: 'explicit' });
  });

  it('recognises duals, sound plurals and broken plurals', () => {
    expect(mention('بيتان', 'house')).toMatchObject({ count: 2, countSource: 'dual' });
    expect(mention('ثلاث شجرات', 'tree')).toMatchObject({ count: 3, countSource: 'explicit' });
    expect(mention('بيوت', 'house')).toMatchObject({ count: 3, countSource: 'plural' });
    expect(mention('قلاع', 'castle')).toMatchObject({ count: 3, countSource: 'plural' });
    expect(mention('three castles', 'castle')).toMatchObject({ count: 3, countSource: 'explicit' });
    expect(mention('castles', 'castle')).toMatchObject({ count: 3, countSource: 'plural' });
  });

  it('falls back to vague quantities and then to one', () => {
    expect(mention('العديد من الأشجار', 'tree')).toMatchObject({ count: 12, countSource: 'quantity' });
    expect(mention('بعض الأشجار', 'tree')).toMatchObject({ count: 5, countSource: 'quantity' });
    expect(mention('قلعة', 'castle')).toMatchObject({ count: 1, countSource: 'default' });
    // An English article is not a count of one.
    expect(mention('a castle on a hill', 'castle')).toMatchObject({ count: 1, countSource: 'default' });
  });

  it('does not let a conjunction steal the previous number', () => {
    const frames = extractFrames('three deer and two wolves near a river');
    expect(frames.animals).toEqual([
      { id: 'deer', count: 3 },
      { id: 'wolf', count: 2 },
    ]);
  });
});

describe('modifiers', () => {
  it('attaches a material and a style to the noun they qualify', () => {
    const frames = extractFrames('مدينة قروسطية بمباني حجرية');
    expect(frames.mentions[0]).toMatchObject({ entry: { id: 'city' }, architecture: 'medieval', material: 'stone-mat' });
    expect(frames.materials).toEqual(['stone-mat']);
    expect(frames.architecture).toEqual(['medieval']);
  });

  it('keeps an adjective chain on the first noun', () => {
    const frames = extractFrames('قلعة حجرية قروسطية فوق جبل');
    const castle = frames.mentions.find((mention) => mention.entry.id === 'castle');
    const mountain = frames.mentions.find((mention) => mention.entry.id === 'mountains');
    expect(castle).toMatchObject({ material: 'stone-mat', architecture: 'medieval' });
    expect(mountain?.material).toBeUndefined();
    expect(mountain?.architecture).toBeUndefined();
  });

  it('never leaks a modifier across a conjunction', () => {
    const frames = extractFrames('غابة في الشمال وبحيرة في الوسط وجبل في الجنوب');
    expect(frames.mentions.map((mention) => [mention.entry.id, mention.region])).toEqual([
      ['forest', 'north'],
      ['lake', 'center'],
      ['mountains', 'south'],
    ]);
    expect(frames.regions.map((region) => [region.selector, region.biome])).toEqual([
      ['north', 'forest'],
      ['center', undefined],
      ['south', 'mountains'],
    ]);
  });

  it('assigns size adjectives in the direction the language uses', () => {
    // Arabic: the adjective follows its noun.
    expect(mention('عالم صغير فيه قرية كبيرة', 'village')?.size).toBe('large');
    expect(mention('قلعة كبيرة', 'castle')?.size).toBe('large');
    // English: the adjective precedes it, so the mountain is tall, not the castle.
    const frames = extractFrames('a castle on top of a tall mountain');
    expect(frames.mentions.find((mention) => mention.entry.id === 'mountains')?.size).toBe('tall');
    expect(frames.mentions.find((mention) => mention.entry.id === 'castle')?.size).toBeUndefined();
  });
});

describe('scale, density and time', () => {
  it('reads a world-level scale word', () => {
    expect(extractFrames('عالم صغير فيه قرية').scale).toBe('small');
    expect(extractFrames('a small world with a village').scale).toBe('small');
    expect(extractFrames('صحراء واسعة').scale).toBe('large');
    expect(extractFrames('a vast desert').scale).toBe('large');
  });

  it('refuses to resize the world because one object is small', () => {
    const frames = extractFrames('a small village around a lake');
    expect(frames.scale).toBeUndefined();
    expect(frames.scaleFromObject).toBe(true);
    expect(frames.mentions.find((mention) => mention.entry.id === 'village')?.size).toBe('small');
  });

  it('reads density, time of day, weather and style', () => {
    const night = extractFrames('ليل مع ضباب ومطر');
    expect(night.time).toBe('night');
    expect(night.weather).toEqual(['fog', 'rain']);
    expect(extractFrames('dense forest').density).toBe('dense');
    expect(extractFrames('غابة متفرقة').density).toBe('sparse');
    expect(extractFrames('cartoon style world').style).toBe('cartoon');
  });
});

describe('negation', () => {
  it('flags the negated mention and the negated term', () => {
    const frames = extractFrames('غابة بدون أشجار');
    expect(frames.mentions.find((mention) => mention.entry.id === 'tree')?.negated).toBe(true);
    expect(frames.negations).toContain('tree');
  });

  it('handles several negations in one sentence', () => {
    expect(extractFrames('بدون ماء ولا أشجار').negations).toEqual(expect.arrayContaining(['water', 'tree']));
    expect(extractFrames('no water, no trees').negations).toEqual(expect.arrayContaining(['water', 'tree']));
  });

  it('scopes a negation to the species the phrase named', () => {
    const frames = extractFrames('غابة بدون أشجار نخيل');
    expect(frames.negations).toEqual(['palm']);
    expect(frames.negationNotes.join(' ')).toContain('نخلة');
    // Both nouns of the phrase are negated at mention level, so neither is placed.
    expect(frames.mentions.filter((mention) => mention.negated).map((mention) => mention.entry.id)).toEqual(['tree', 'palm']);
  });

  it('does not read a negation out of an unrelated word', () => {
    // "صغير" contains "غير" and "north" contains "no".
    expect(extractFrames('عالم صغير فيه قرية كبيرة').negations).toEqual([]);
    expect(extractFrames('a village north of the lake').negations).toEqual([]);
  });
});

describe('spatial relations', () => {
  it('reads vertical relations in both languages', () => {
    expect(labels('قلعة فوق جبل', 'on-top-of')).toMatchObject({ subject: 'castle', object: 'mountains' });
    expect(labels('a castle on top of a mountain', 'on-top-of')).toMatchObject({ subject: 'castle', object: 'mountains' });
    expect(labels('a tower at the foot of the mountain', 'at-foot-of')).toMatchObject({ subject: 'tower', object: 'mountains' });
  });

  it('resolves an Arabic pronoun suffix back to the earlier noun', () => {
    // "وتحتها قرية": the village is below the mountain, not the reverse.
    expect(labels('جبل وتحتها قرية', 'at-foot-of')).toMatchObject({ subject: 'village', object: 'mountains' });
  });

  it('reads enclosure both ways round', () => {
    expect(labels('قرية تحيط ببحيرة', 'surrounding')).toMatchObject({ subject: 'village', object: 'lake' });
    expect(labels('a village surrounding a lake', 'surrounding')).toMatchObject({ subject: 'village', object: 'lake' });
    expect(labels('a lake surrounded by pine trees', 'surrounded-by')).toMatchObject({ subject: 'pine', object: 'lake' });
    expect(labels('بحيرة محاطة بأشجار', 'surrounded-by')).toMatchObject({ subject: 'tree', object: 'lake' });
  });

  it('reads crossing and containment', () => {
    expect(labels('نهر يعبر الغابة', 'through')).toMatchObject({ subject: 'river', object: 'forest' });
    expect(labels('a river crossing the forest', 'through')).toMatchObject({ subject: 'river', object: 'forest' });
    expect(labels('قلعة وسط الغابة', 'inside')).toMatchObject({ subject: 'castle', object: 'forest' });
  });

  it('does not invent an object for an adverbial "in the middle"', () => {
    expect(relation('بحيرة في الوسط وجبل في الجنوب', 'inside')).toBeUndefined();
  });

  it('reads a connector and keeps both ends of a "between"', () => {
    expect(labels('stone houses connected by dirt roads', 'connected-by')).toMatchObject({ subject: 'house', object: 'house', via: 'road' });
    expect(labels('البيوت تربطها طرق', 'connected-by')).toMatchObject({ subject: 'house', via: 'road' });
    expect(labels('برج بين قلعة وبحيرة', 'between')).toMatchObject({ subject: 'tower', object: 'castle', second: 'lake' });
  });

  it('reads direction and proximity', () => {
    expect(labels('بيت على يمين شجرة', 'right-of')).toMatchObject({ subject: 'house', object: 'tree' });
    expect(labels('a house to the left of a tower', 'left-of')).toMatchObject({ subject: 'house', object: 'tower' });
    expect(labels('خيام بجانب نهر', 'near')).toMatchObject({ subject: 'tent', object: 'river' });
    expect(labels('ثلاث خيام عند كثبان مرتفعة', 'near')).toMatchObject({ subject: 'tent', object: 'dunes' });
  });
});

describe('frames as a whole', () => {
  it('detects the language and keeps every understanding in one place', () => {
    const frames = extractFrames('A medieval castle on a mountain, no trees, at night, dense fog');
    expect(frames.language).toBe('en');
    expect(frames.architecture).toContain('medieval');
    expect(frames.negations).toContain('tree');
    expect(frames.time).toBe('night');
    expect(frames.weather).toContain('fog');
    expect(frames.density).toBe('dense');
    expect(frames.cues.length).toBeGreaterThanOrEqual(3);
  });

  it('reports which entity categories the description never used', () => {
    const unused = unusedCategories(extractFrames('قلعة فوق جبل'));
    expect(unused).toContain('animal');
    expect(unused).not.toContain('structure');
  });

  it('is deterministic', () => {
    const description = 'قرية تحيط ببحيرة ونهر يعبر الغابة';
    expect(extractFrames(description)).toEqual(extractFrames(description));
  });
});
