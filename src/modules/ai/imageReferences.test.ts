import { describe, expect, it } from 'vitest';
import { imageReferenceSchema, IMAGE_LIBRARY_KEY, IMAGE_LIBRARY_LIMIT, readImageReferences, removeImageReference, sameImageQuery, saveImageReference } from './imageReferences';
function storage(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, setItem: (key, value) => { data.set(key, value); } };
}
const image = { title: 'File:Castle.jpg', url: 'https://commons.wikimedia.org/wiki/File:Castle.jpg',
  thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Castle.jpg/240px-Castle.jpg',
  author: 'Alice', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', license_name: 'CC BY-SA 4.0', query: 'قلعة' };
describe('bounded Commons image references', () => {
  it('saves references, deduplicates and evicts the oldest, not image bytes', () => {
    const local = storage();
    saveImageReference(local, image); saveImageReference(local, { ...image, query: 'Castle' });
    expect(readImageReferences(local)).toHaveLength(1);
    expect(readImageReferences(local)[0]?.query).toBe('Castle');
    for (let i = 0; i < IMAGE_LIBRARY_LIMIT; i++) saveImageReference(local, { ...image, url: `https://commons.wikimedia.org/wiki/File:${i}.jpg` });
    expect(readImageReferences(local)).toHaveLength(IMAGE_LIBRARY_LIMIT);
    expect(readImageReferences(local).some((item) => item.url === image.url)).toBe(false);
    expect(removeImageReference(local, 'https://commons.wikimedia.org/wiki/File:0.jpg')).toHaveLength(IMAGE_LIBRARY_LIMIT - 1);
  });
  it('rejects forged source, thumbnail and license URLs and preserves corrupt data', () => {
    for (const entry of [{ ...image, url: 'https://commons.wikimedia.org.evil.example/wiki/File:x' },
      { ...image, thumbnail: 'https://evil.example/wikipedia/commons/thumb/a/240px-x.png' },
      { ...image, thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/a/original.jpg' },
      { ...image, license_url: 'https://evil.example/license' }]) expect(imageReferenceSchema.safeParse(entry).success).toBe(false);
    const local = storage(); local.setItem(IMAGE_LIBRARY_KEY, '{broken');
    expect(() => saveImageReference(local, image)).toThrow();
    expect(local.getItem(IMAGE_LIBRARY_KEY)).toBe('{broken');
  });
  it('uses only exact normalized cached query matches', () => {
    expect(sameImageQuery('  Castle   Wall ', 'castle wall')).toBe(true);
    expect(sameImageQuery('castle', 'castle wall')).toBe(false);
  });
});
