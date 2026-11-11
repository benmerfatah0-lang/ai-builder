import { useState, type MouseEvent } from 'react';
import type { TinyImage } from '../../ai/photoModel';
import { polygonMask, type MaskPoint } from '../../ai/manualPhotoMask';

/** Touch-friendly outline over the already downloaded tiny image, with explicit confirmation. */
export function PhotoOutline({ image, onApply, onChange, imageUrl, cropFirst = false }: { image: TinyImage; onApply: (mask: Uint8Array, points: MaskPoint[]) => void; onChange?: () => void; imageUrl?: string; cropFirst?: boolean }) {
  const [points, setPoints] = useState<MaskPoint[]>([]);
  const [error, setError] = useState('');
  const tap = (event: MouseEvent<SVGSVGElement>) => {
    const bounds=event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height || points.length >= 64) return;
    const x=Math.max(0,Math.min(image.width,(event.clientX-bounds.left)/bounds.width*image.width));
    const y=Math.max(0,Math.min(image.height,(event.clientY-bounds.top)/bounds.height*image.height));
    setPoints((old)=>[...old,{x,y}]); setError(''); onChange?.();
  };
  return <div className="wiki-entry" dir="rtl">
    <strong>تحديد الجسم يدوياً</strong>
    <p>اضغط نقاطاً متتابعة حول حدود الجسم، ثم اضغط «بناء المحدد». سيُغلق الخط بين آخر نقطة وأول نقطة. البكسلات داخل الحدود تبقى، وقد تبقى خلفية داخلية؛ {cropFirst ? 'تُصغّر القصاصة بعد تحديدها.' : 'الصورة منخفضة الدقة.'}</p>
    <svg role="img" aria-label="صورة لتحديد حدود الجسم" viewBox={`0 0 ${image.width} ${image.height}`} onClick={tap}
      style={{ width:'100%', maxWidth:360, height:'auto', display:'block', margin:'auto', touchAction:'manipulation', background:'#aaa', cursor:'crosshair' }}>
      {imageUrl ? <image href={imageUrl} x="0" y="0" width={image.width} height={image.height} preserveAspectRatio="none" /> : Array.from({ length:image.width*image.height }, (_, i) => <rect key={i} x={i%image.width} y={Math.floor(i/image.width)} width="1" height="1" fill={`rgb(${image.rgba[i*4]},${image.rgba[i*4+1]},${image.rgba[i*4+2]})`} opacity={image.rgba[i*4+3]!/255} />)}
      {points.length > 1 && <polyline points={[...points, ...(points.length > 2 ? [points[0]!] : [])].map((p)=>`${p.x},${p.y}`).join(' ')} fill={points.length > 2 ? 'rgba(0,255,255,.16)' : 'none'} stroke="#00ffff" strokeWidth={Math.max(image.width,image.height)/120} />}
      {points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={Math.max(image.width,image.height)/65} fill="#ff2d55" stroke="white" strokeWidth=".08" />)}
    </svg>
    <p>{points.length} نقطة · حتى 64 نقطة.</p>
    <button type="button" className="btn btn-small" disabled={!points.length} onClick={() => { setPoints((old)=>old.slice(0,-1)); setError(''); onChange?.(); }}>تراجع عن آخر نقطة</button>{' '}
    <button type="button" className="btn btn-small" disabled={!points.length} onClick={() => { setPoints([]); setError(''); onChange?.(); }}>مسح التحديد</button>{' '}
    <button type="button" className="btn btn-small" disabled={points.length<3} onClick={() => { try { const mask=polygonMask(image.width,image.height,points); if (!cropFirst && mask.reduce((a,b)=>a+b,0)<6) throw new Error('التحديد صغير جداً؛ أحط الجسم بنقاط أكثر.'); onApply(mask, points); } catch(e) { setError(e instanceof Error ? e.message : 'التحديد غير صالح.'); } }}>بناء المحدد</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
