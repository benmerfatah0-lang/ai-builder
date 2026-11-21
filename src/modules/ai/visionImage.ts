/** Decode only a user-supplied, bounded image; never upload it. */
export function loadVisionImage(file:File, signal:AbortSignal):Promise<{image:HTMLImageElement;release:()=>void}> {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type)||!file.size||file.size>12*1024*1024) return Promise.reject(new Error('اختر صورة JPEG أو PNG أو WebP لا تتجاوز 12 ميغابايت.'));
  if(signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(file), image=new Image();let settled=false;
    const cleanup=()=>{image.onload=null;image.onerror=null;signal.removeEventListener('abort',abort);};
    const fail=(error:Error)=>{if(settled)return;settled=true;cleanup();URL.revokeObjectURL(url);reject(error);};
    const abort=()=>fail(new DOMException('Cancelled','AbortError'));
    image.onload=()=>{
      if(settled)return;
      const w=image.naturalWidth,h=image.naturalHeight;
      if(!w||!h||w*h>16_000_000||Math.max(w/h,h/w)>12){fail(new Error('أبعاد الصورة كبيرة جداً أو غير مدعومة.'));return;}
      settled=true;cleanup();resolve({image,release:()=>URL.revokeObjectURL(url)});
    };
    image.onerror=()=>fail(new Error('تعذّر فتح الصورة.'));
    signal.addEventListener('abort',abort,{once:true});image.src=url;
  });
}
