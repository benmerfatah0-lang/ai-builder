import { polygonMask, type MaskPoint } from './manualPhotoMask';

/** Crop a user outline in full-image coordinates before downsampling it to 24².
 * This does not recognize objects or recover their unseen surfaces. */
export function scenePhotoCrop(points: MaskPoint[], previewWidth: number, previewHeight: number, sourceWidth: number, sourceHeight: number) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || sourceWidth * sourceHeight > 16_000_000 || !Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) || previewWidth < 2 || previewHeight < 2 || points.length < 3 || points.length > 64 || points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||p.x<0||p.y<0||p.x>previewWidth||p.y>previewHeight)) throw new Error('تحديد الصورة غير صالح.');
  const left=Math.min(...points.map(p=>p.x)), right=Math.max(...points.map(p=>p.x));
  const top=Math.min(...points.map(p=>p.y)), bottom=Math.max(...points.map(p=>p.y));
  const x=left/previewWidth*sourceWidth, y=top/previewHeight*sourceHeight;
  const width=(right-left)/previewWidth*sourceWidth, height=(bottom-top)/previewHeight*sourceHeight;
  if(width<1 || height<1) throw new Error('التحديد صغير جداً؛ اختر مساحة أكبر.');
  const scale=24/Math.max(width,height);
  const pixelWidth=Math.max(2,Math.round(width*scale)), pixelHeight=Math.max(2,Math.round(height*scale));
  const relative=points.map(p=>({x:Math.max(0,Math.min(pixelWidth,(p.x-left)/(right-left)*pixelWidth)),y:Math.max(0,Math.min(pixelHeight,(p.y-top)/(bottom-top)*pixelHeight))}));
  const mask=polygonMask(pixelWidth,pixelHeight,relative);
  if(mask.reduce((sum,value)=>sum+value,0)<6) throw new Error('التحديد صغير جداً؛ أحط الجسم بنقاط أكثر.');
  return {x,y,width,height,pixelWidth,pixelHeight,mask};
}
