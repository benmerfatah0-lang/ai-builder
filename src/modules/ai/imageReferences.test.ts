import { describe, expect, it } from 'vitest';
import { imageReferenceSchema } from './imageReferences';
const image = { title: 'File:Castle.jpg', url: 'https://commons.wikimedia.org/wiki/File:Castle.jpg',
  thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Castle.jpg/240px-Castle.jpg',
  author: 'Alice', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', license_name: 'CC BY-SA 4.0', query: 'قلعة' };
describe('Commons result validation', () => {
  it('accepts safe source metadata and rejects forged links and original uploads', () => {
    expect(imageReferenceSchema.safeParse(image).success).toBe(true);
    for (const entry of [{ ...image, url: 'https://commons.wikimedia.org.evil.example/wiki/File:x' },
      { ...image, thumbnail: 'https://evil.example/wikipedia/commons/thumb/a/240px-x.png' },
      { ...image, thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/a/original.jpg' },
      { ...image, license_url: 'https://evil.example/license' }]) expect(imageReferenceSchema.safeParse(entry).success).toBe(false);
  });
});
