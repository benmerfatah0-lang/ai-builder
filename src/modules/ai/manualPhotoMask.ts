export interface MaskPoint { x: number; y: number }
/** Rasterize a user's closed outline at image-pixel centers. No automatic recognition. */
export function polygonMask(width: number, height: number, points: MaskPoint[]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 24 || height > 24 || points.length < 3 || points.length > 64 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) throw new Error('حدد محيط الجسم بثلاث نقاط على الأقل.');
  const mask = new Uint8Array(width * height);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const px=x+.5, py=y+.5;
    let inside=false;
    for (let i=0,j=points.length-1;i<points.length;j=i++) {
      const a=points[i]!, b=points[j]!;
      if ((a.y>py)!==(b.y>py) && px < (b.x-a.x)*(py-a.y)/(b.y-a.y)+a.x) inside=!inside;
    }
    mask[y*width+x]=inside ? 1 : 0;
  }
  return mask;
}
