import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildPhotoModelGeometry } from '../../../core/scene/photoModel';
import type { PhotoModel } from '../../../core/world-plan/schema';
import type { ImageReference } from '../../ai/imageReferences';
import { photoToModel } from '../../ai/photoModel';
import { readPhotoPixels, searchImageReferencePage } from '../../ai/onlineInterpreter';
import type { TopicResearch } from '../../ai/unknownResearch';

function Preview({ model, rows }: { model: PhotoModel; rows: number }) {
  const host = useRef<HTMLDivElement>(null);
  const mesh = useRef<THREE.Mesh | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: false }); }
    catch { setUnavailable(true); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(Math.max(200, host.current.clientWidth), 240);
    host.current.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#172332');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x45546b, 2));
    const sun = new THREE.DirectionalLight(0xffffff, 2); sun.position.set(5,8,7); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, Math.max(200, host.current.clientWidth)/240, .1, 100);
    camera.position.set(6, 4.5, 8);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0,2,0); controls.update();
    const object = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .85 }));
    scene.add(object); mesh.current = object;
    let frame = 0;
    const render = () => { controls.update(); renderer.render(scene, camera); frame = requestAnimationFrame(render); }; render();
    return () => { cancelAnimationFrame(frame); controls.dispose(); object.geometry.dispose(); (object.material as THREE.Material).dispose(); renderer.dispose(); renderer.domElement.remove(); mesh.current = null; };
  }, []);
  useEffect(() => {
    if (!mesh.current) return;
    const old = mesh.current.geometry;
    mesh.current.geometry = buildPhotoModelGeometry(model, model.cells.filter((cell) => cell.y < rows));
    old.dispose();
  }, [model, rows]);
  return <><div ref={host} aria-label="معاينة المجسم ثلاثية الأبعاد" style={{ width: '100%', minHeight: unavailable ? 0 : 240, overflow: 'hidden', touchAction: 'none' }} />
    {unavailable && <p>معاينة WebGL غير متاحة على هذا الجهاز؛ يمكن متابعة البناء دون معاينة.</p>}</>;
}

/** User selects only if search returned multiple ambiguous candidates. */
export function PhotoStudio({ topic, onComplete, onCancel, cancelLabel = 'إغلاق الاستوديو' }: { topic: TopicResearch; onComplete: (model: PhotoModel) => void; onCancel: () => void; cancelLabel?: string }) {
  const [images, setImages] = useState(topic.images);
  const [next, setNext] = useState(topic.imageNext ?? null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState('');
  const pageRequest = useRef<AbortController | null>(null);
  const ambiguous = useRef(topic.images.length > 1 || topic.imageNext != null || topic.images.length === 0);
  const [selected, setSelected] = useState<ImageReference | null>(() => !ambiguous.current && topic.images.length === 1 ? topic.images[0]! : null);
  useEffect(() => () => pageRequest.current?.abort(), []);
  const loadMore = async () => {
    if (next === null || pageRequest.current) return;
    const request = new AbortController(); pageRequest.current = request; setPageBusy(true); setPageError('');
    try {
      const page = await searchImageReferencePage(topic.imageQuery ?? topic.term, next, request.signal);
      setImages((old) => [...old, ...page.results.filter((item) => !old.some((entry) => entry.url === item.url))]); setNext(page.next);
    } catch (error) { if (!request.signal.aborted) setPageError(error instanceof Error ? error.message : 'تعذّر تحميل المزيد.'); }
    finally { if (pageRequest.current === request) pageRequest.current = null; if (!request.signal.aborted) setPageBusy(false); }
  };
  const [model, setModel] = useState<PhotoModel | null>(null);
  const [rows, setRows] = useState(0);
  const [error, setError] = useState('');
  const [finished, setFinished] = useState(false);
  const [loading, setLoading] = useState(false);
  const complete = useRef(onComplete); complete.current = onComplete;
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setError(''); setModel(null); setRows(0); setLoading(true);
    void readPhotoPixels(selected).then((pixels) => {
      if (cancelled) return;
      const built = photoToModel(pixels, selected);
      setModel(built); setLoading(false);
    }).catch((reason: unknown) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : 'تعذّر قراءة الصورة.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [selected]);
  useEffect(() => {
    if (!model) return;
    let current = 0;
    const timer = window.setInterval(() => {
      current++;
      setRows(current);
      if (current >= model.height) { window.clearInterval(timer); setFinished(true); complete.current(model); }
    }, 70);
    return () => window.clearInterval(timer);
  }, [model]);
  return <section className="wiki-library" dir="rtl" aria-label="استوديو تقريب الصورة">
    <strong>استوديو بناء «{topic.term}»</strong>
    {topic.imageNotice && <p>{topic.imageNotice}</p>}
    <p>تقريب منخفض الدقة من شكل المقدمة؛ العمق والخلف متناظران تقديرياً ولا نعرف شكلهما الحقيقي. يحتاج صورة جسم واحد بخلفية شفافة أو موحدة؛ قد يفصلها خطأ.</p>
    {ambiguous.current && <div className="wiki-list"><span>النتائج ملتبسة؛ اختر الصورة الأقرب، ويفضّل أن تكون بخلفية بسيطة:</span>{images.map((image) => <button className="image-ref-card" type="button" key={image.url} onClick={() => setSelected(image)} disabled={finished} aria-pressed={selected?.url === image.url}>
      <img src={image.thumbnail} alt={image.title} loading="lazy" width="120" referrerPolicy="no-referrer"/><span>{image.title} · {image.author} · {image.license_name}</span>
    </button>)}
      {next !== null && <button type="button" className="btn btn-small" disabled={finished || pageBusy} onClick={() => void loadMore()}>{pageBusy ? 'جارٍ تحميل الصور…' : 'المزيد من الصور'}</button>}
      {pageError && <p role="alert" className="online-error">{pageError} يمكنك إعادة المحاولة.</p>}
      {!images.length && next === null && <p>لم تظهر صور بالتراخيص المدعومة.</p>}
    </div>}
    {selected && <p>الصورة: <a href={selected.url} target="_blank" rel="noopener noreferrer">{selected.title}</a> · {selected.author} · <a href={selected.license_url} target="_blank" rel="noopener noreferrer">{selected.license_name}</a></p>}
    {loading && <p role="status">أقرأ مصغّرة الصورة وأحاول فصل الجسم…</p>}
    {error && <p role="alert" className="online-error">{error} لم يُضف مجسم. اختر نتيجة أخرى أو أعد البحث بصورة مختلفة.</p>}
    {model && <><Preview model={model} rows={rows} /><p role="status">بناء طبقات الشكل: {Math.min(rows, model.height)} / {model.height} · اسحب لتدوير المعاينة</p></>}
    <button type="button" className="btn btn-small" onClick={onCancel}>{cancelLabel}</button>
  </section>;
}
