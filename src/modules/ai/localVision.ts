/** Run the optional downloaded model in a dedicated worker, without uploading pixels. */
export function localSceneVision(source:HTMLImageElement, signal:AbortSignal):Promise<Uint8Array> {
  if(signal.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
  const context=canvas.getContext('2d',{willReadFrequently:true});
  if(!context)return Promise.reject(new Error('تعذّر قراءة الصورة للتحليل.'));
  context.drawImage(source,0,0,512,512);
  const image=context.getImageData(0,0,512,512), rgba=new Uint8Array(image.data);
  return new Promise((resolve,reject)=>{
    let worker:Worker;
    try{worker=new Worker(new URL('vision-worker.js',window.location.href));}catch{return reject(new Error('تعذّر بدء تحليل الصورة على هذا المتصفح.'));}
    let settled=false;
    const finish=(error?:Error,result?:Uint8Array)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);worker.terminate();if(error)reject(error);else resolve(result!);};
    const abort=()=>finish(new DOMException('Cancelled','AbortError'));
    const timer=window.setTimeout(()=>finish(new Error('استغرق التحليل أكثر من دقيقتين؛ لم يُنشأ العالم.')),120_000);
    worker.onerror=()=>finish(new Error('تعذّر تشغيل نموذج الرؤية؛ تحقق من تثبيت ملفاته ومن دعم المتصفح لـ WebAssembly.'));
    worker.onmessage=(event:MessageEvent<{type:string;labels?:ArrayBuffer;message?:string}>)=>{
      if(event.data.type==='error')return finish(new Error(event.data.message??'تعذّر تحليل الصورة.'));
      if(event.data.type==='result'&&event.data.labels instanceof ArrayBuffer){const labels=new Uint8Array(event.data.labels);if(labels.length===4096)return finish(undefined,labels);}
      finish(new Error('نتيجة نموذج الرؤية غير صالحة.'));
    };
    signal.addEventListener('abort',abort,{once:true});worker.postMessage({type:'analyze',rgba:rgba.buffer},[rgba.buffer]);
  });
}
