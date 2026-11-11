import { useState } from 'react';
import { imageReferenceSchema, type ImageReference } from '../../ai/imageReferences';

/** Use the bounded same-origin phone proxy first. Direct Commons is a fallback for older servers. */
export function ReferenceThumbnail({ image, alt, eager = false }: { image: ImageReference; alt: string; eager?: boolean }) {
  const [mode, setMode] = useState<'proxy' | 'direct' | 'failed'>('proxy');
  const safe = imageReferenceSchema.safeParse(image);
  if (!safe.success || mode === 'failed') return <span className="image-thumbnail-error" role="img" aria-label={alt}>تعذّر عرض الصورة؛ افتح المصدر أو أعد تحميل الصور.</span>;
  const src = mode === 'proxy' ? `/api/image-thumbnail?url=${encodeURIComponent(safe.data.thumbnail)}` : safe.data.thumbnail;
  return <img src={src} alt={alt} loading={eager ? 'eager' : 'lazy'} referrerPolicy="no-referrer" onError={() => setMode((old) => old === 'proxy' ? 'direct' : 'failed')} />;
}
