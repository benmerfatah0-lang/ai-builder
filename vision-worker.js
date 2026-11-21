/* PP-MobileSeg-Base (PaddleSeg, Apache-2.0), ADE20K labels, ONNX Runtime Web (MIT).
 * All image data stays on the device. Results are 64×64 semantic classes, not instance IDs. */
let session;
self.onmessage = async ({data}) => {
  if (data.type !== 'analyze') return;
  try {
    if (!session) {
      try { importScripts(new URL('vision/ort.wasm.min.js', self.location.href).href); }
      catch { throw new Error('نموذج الرؤية غير مثبت؛ شغّل python vision-setup.py ثم أعد المحاولة.'); }
      ort.env.wasm.wasmPaths = new URL('vision/', self.location.href).href;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const response = await fetch(new URL('vision/scene.onnx', self.location.href));
      if (!response.ok) throw new Error('نموذج الرؤية غير مثبت؛ شغّل أداة تثبيت الرؤية.');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== 23711565) throw new Error('ملف نموذج الرؤية غير مكتمل.');
      session = await ort.InferenceSession.create(new Uint8Array(bytes), {executionProviders:['wasm']});
    }
    const rgba=new Uint8Array(data.rgba), area=512*512;
    if (rgba.length!==area*4) throw new Error('بيانات الصورة غير صالحة.');
    const input=new Float32Array(area*3), mean=[.485,.456,.406], std=[.229,.224,.225];
    for(let p=0;p<area;p++) for(let c=0;c<3;c++) input[c*area+p]=(rgba[p*4+c]/255-mean[c])/std[c];
    const results=await session.run({[session.inputNames[0]]:new ort.Tensor('float32',input,[1,3,512,512])});
    const output=results[session.outputNames[0]];
    if(output.dims.length!==4 || output.dims[0]!==1 || output.dims[1]!==150 || output.dims[2]!==64 || output.dims[3]!==64) throw new Error('خرج نموذج الرؤية غير متوقع.');
    const labels=new Uint8Array(64*64), values=output.data;
    for(let p=0;p<labels.length;p++){let best=-Infinity,idx=0;for(let c=0;c<150;c++){const v=values[c*labels.length+p];if(v>best){best=v;idx=c;}}labels[p]=idx;}
    self.postMessage({type:'result',labels:labels.buffer},[labels.buffer]);
  } catch(error) { self.postMessage({type:'error',message:error instanceof Error?error.message:'تعذّر تشغيل نموذج الرؤية.'}); }
};
