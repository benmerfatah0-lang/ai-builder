import { z } from 'zod';

export const IMAGE_LIBRARY_KEY = 'worldforge-image-references-v1';
export const IMAGE_LIBRARY_LIMIT = 30;
const license = /^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/[1-4]\.0\/|publicdomain\/zero\/1\.0\/)$/;
function safeUrl(raw: string, kind: 'source' | 'thumbnail'): boolean {
  if (raw.length > 1200) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
    if (kind === 'source') return u.hostname === 'commons.wikimedia.org' && u.pathname.startsWith('/wiki/File:');
    return u.hostname === 'upload.wikimedia.org' && u.pathname.startsWith('/wikipedia/commons/thumb/') && u.pathname.includes('/240px-');
  } catch { return false; }
}
export const imageReferenceSchema = z.object({
  title: z.string().min(1).max(120), url: z.string().refine((url) => safeUrl(url, 'source')),
  thumbnail: z.string().refine((url) => safeUrl(url, 'thumbnail')),
  author: z.string().min(1).max(200), license_url: z.string().regex(license), license_name: z.string().min(1).max(200),
  query: z.string().min(1).max(400),
}).strict();
export type ImageReference = z.infer<typeof imageReferenceSchema>;

export function readImageReferences(storage: Storage): ImageReference[] {
  const raw = storage.getItem(IMAGE_LIBRARY_KEY);
  if (!raw) return [];
  if (raw.length > 150_000) throw new Error('بيانات مراجع الصور غير صالحة.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('بيانات مراجع الصور غير صالحة.'); }
  const parsed = z.array(imageReferenceSchema).max(IMAGE_LIBRARY_LIMIT).safeParse(value);
  if (!parsed.success || new Set(parsed.data.map((item) => item.url)).size !== parsed.data.length) throw new Error('بيانات مراجع الصور غير صالحة.');
  return parsed.data;
}
export function saveImageReference(storage: Storage, image: ImageReference): ImageReference[] {
  const reference = imageReferenceSchema.parse(image);
  const next = [reference, ...readImageReferences(storage).filter((item) => item.url !== reference.url)].slice(0, IMAGE_LIBRARY_LIMIT);
  storage.setItem(IMAGE_LIBRARY_KEY, JSON.stringify(next));
  return next;
}
export function removeImageReference(storage: Storage, url: string): ImageReference[] {
  const next = readImageReferences(storage).filter((item) => item.url !== url);
  storage.setItem(IMAGE_LIBRARY_KEY, JSON.stringify(next));
  return next;
}
export function sameImageQuery(a: string, b: string): boolean {
  const normal = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  return normal(a) === normal(b);
}
