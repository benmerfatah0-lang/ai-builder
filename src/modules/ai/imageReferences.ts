import { z } from 'zod';

const license = /^https:\/\/creativecommons\.org\/(?:licenses\/(?:by|by-sa)\/[1-4]\.0\/|publicdomain\/zero\/1\.0\/)$/;
function safeUrl(raw: string, kind: 'source' | 'thumbnail'): boolean {
  if (raw.length > 1200) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return false;
    if (kind === 'source') return u.hostname === 'commons.wikimedia.org' && u.pathname.startsWith('/wiki/File:');
    if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(u.hostname) || /%2f|%5c|%00|%2e|\\/i.test(u.pathname)) return false;
    return /^\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+\/(?:20|40|60|120|240|250)px-[^/]+$/i.test(u.pathname);
  } catch { return false; }
}
export const imageReferenceSchema = z.object({
  title: z.string().min(1).max(120), url: z.string().refine((url) => safeUrl(url, 'source')),
  thumbnail: z.string().refine((url) => safeUrl(url, 'thumbnail')),
  author: z.string().min(1).max(200), license_url: z.string().regex(license), license_name: z.string().min(1).max(200),
  query: z.string().min(1).max(400),
}).strict();
export type ImageReference = z.infer<typeof imageReferenceSchema>;
