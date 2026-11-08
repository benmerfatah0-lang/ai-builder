import { PhotoOutline } from './PhotoOutline';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildPhotoModelGeometry } from '../../../core/scene/photoModel';
import type { PhotoModel } from '../../../core/world-plan/schema';
import type { PhotoMeshStyle } from '../../ai/photoStyle';
import type { ImageReference } from '../../ai/imageReferences';
import { photoToModel, type TinyImage } from '../../ai/photoModel';
import { constructionStage, type PreparedConstruction, type ConstructionPreview } from '../constructionPreview';
import { Viewport } from '../Viewport';
import { ReferenceThumbnail } from './ReferenceThumbnail';
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
    mesh.current.geometry = buildPhotoModelGeometry(model, model.cells.filter((cell) => cell.y >= model.height - rows));
    old.dispose();
  }, [model, rows]);
  return <><div ref={host} aria-label="معاينة المجسم ثلاثية الأبعاد" style={{ width: '100%', minHeight: unavailable ? 0 : 240, overflow: 'hidden', touchAction: 'none' }} />
    {unavailable && <p>معاينة WebGL غير متاحة على هذا الجهاز؛ يمكن متابعة البناء دون معاينة.</p>}</>;
}

/** Candidate choice, actual placement preparation and a real, transient build preview. */
export function PhotoStudio({ topic, onComplete, onCancel, cancelLabel = 'إغلاق الاستوديو', onPrepare, onPreview, showMapPreview = false, initialMeshStyle = 'smooth' }: {
  initialMeshStyle?: PhotoMeshStyle; topic: TopicResearch; onComplete: (model: PhotoModel, prepared?: PreparedConstruction) => void; onCancel: () => void; cancelLabel?: string;
  onPrepare?: (model: PhotoModel) => PreparedConstruction; onPreview?: Dispatch<SetStateAction<ConstructionPreview | null>>; showMapPreview?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const progressRoot = useRef<HTMLDivElement>(null);
  useEffect(() => { root.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, []);
  const [images, setImages] = useState(topic.images);
  const [thumbnailRetry, setThumbnailRetry] = useState(0);
  const [next, setNext] = useState(topic.imageNext ?? null);
  const [pageBusy, setPageBusy] = useState(false), [pageError, setPageError] = useState('');
  const pageRequest = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<ImageReference | null>(null);
  useEffect(() => () => { pageRequest.current?.abort(); pageRequest.current = null; }, []);
  const loadMore = async () => {
    if (next === null || pageRequest.current) return;
    const request = new AbortController(); pageRequest.current = request; setPageBusy(true); setPageError('');
    try {
      const page = await searchImageReferencePage(topic.imageQuery ?? topic.term, next, request.signal);
      if (request.signal.aborted) return;
      setImages((old) => [...old, ...page.results.filter((item) => !old.some((entry) => entry.url === item.url))]); setNext(page.next);
    } catch (error) { if (!request.signal.aborted) setPageError(error instanceof Error ? error.message : 'تعذّر تحميل المزيد.'); }
    finally { if (pageRequest.current === request) pageRequest.current = null; if (!request.signal.aborted) setPageBusy(false); }
  };
  const [attempt, setAttempt] = useState(0);
  const autoPageTried = useRef(false);
  useEffect(() => {
    if (!autoPageTried.current && images.length === 0 && next !== null) { autoPageTried.current = true; void loadMore(); }
    return () => { autoPageTried.current = false; };
  }, []);
  const [model, setModel] = useState<PhotoModel | null>(null);
  const [prepared, setPrepared] = useState<PreparedConstruction | undefined>();
  const [pixels, setPixels] = useState<TinyImage | null>(null);
  const [rows, setRows] = useState(0), [error, setError] = useState('');
  const [canUseSlab, setCanUseSlab] = useState(false);
  const [meshStyle, setMeshStyle] = useState<PhotoMeshStyle>(initialMeshStyle);
  const [manualMode, setManualMode] = useState(false);
  const [showOutline, setShowOutline] = useState(false);
  const [finished, setFinished] = useState(false), [loading, setLoading] = useState(false);
  const complete = useRef(onComplete); complete.current = onComplete;
  const prepare = useRef(onPrepare); prepare.current = onPrepare;
  const preview = useRef(onPreview); preview.current = onPreview;
  const previewKey = useRef(`photo-${Math.random().toString(36).slice(2)}`);
  const build = (image: TinyImage, source: ImageReference, includeBackground = false, mask?: Uint8Array) => {
    let built: PhotoModel;
    try { built = photoToModel(image, source, includeBackground, mask, meshStyle); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذّر فصل الصورة.');
      setCanUseSlab(!includeBackground); setShowOutline(!includeBackground); setLoading(false); return;
    }
    try {
      const draft = prepare.current?.(built);
      setPrepared(draft); setModel(built); setRows(0); setError(''); setCanUseSlab(false); setShowOutline(false); setLoading(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'تعذّر تحديد موقع البناء.'); setCanUseSlab(false); setLoading(false);
    }
  };
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setError(''); setModel(null); setPrepared(undefined); setPixels(null); setCanUseSlab(false); setShowOutline(false); setRows(0); setLoading(true);
    void readPhotoPixels(selected).then((result) => {
      if (cancelled) return;
      setPixels(result);
      if (manualMode) { setShowOutline(true); setLoading(false); } else build(result, selected);
    }).catch((reason: unknown) => {
      if (!cancelled) { setError(reason instanceof Error ? reason.message : 'تعذّر قراءة الصورة.'); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [selected, attempt]);
  useEffect(() => { if (model) progressRoot.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, [model]);
  const stage = prepared && model ? constructionStage(prepared, rows, previewKey.current, topic.term, model.height) : null;
  useEffect(() => {
    if (!stage) return;
    preview.current?.(stage);
    const owner = stage.key;
    return () => { preview.current?.((previous) => previous?.key === owner ? null : previous); };
  }, [prepared, model, rows]);
  useEffect(() => {
    if (!model) return;
    let current = 0;
    const timer = window.setInterval(() => {
      current++;
      setRows(current);
      if (current >= model.height) { window.clearInterval(timer); setFinished(true); complete.current(model, prepared); }
    }, 90);
    return () => window.clearInterval(timer);
  }, [model, prepared]);
  return <section ref={root} className="wiki-library" dir="rtl" aria-label="استوديو تقريب الصورة">
    <strong>استوديو بناء «{topic.term}»</strong>
    {topic.imageNotice && <p>{topic.imageNotice}</p>}
    <p>تقريب منخفض الدقة؛ الخلف والعمق مفترضان، وليسا استعادة حقيقية. يحتاج الفصل صورة جسم واحد بخلفية شفافة أو موحدة.</p>
    <label className="field"><span>أسلوب المجسم (يُختار من الوصف عند ذكره، ويمكن تغييره قبل اختيار الصورة)</span><select aria-label="أسلوب المجسم" value={meshStyle} disabled={loading || !!model || finished} onChange={(event) => setMeshStyle(event.target.value as PhotoMeshStyle)}><option value="smooth">ناعم — سطح متصل وتقريبي</option><option value="blocky">بكسلي — مكعبات واضحة</option></select></label>
    <p>الناعم يلطّف الحدود والألوان لكنه لا يعرف حقيقة ظهر الجسم أو عمقه. أسلوب اللوح الكامل يبقى مسطحاً.</p>
    <label><input type="checkbox" checked={manualMode} onChange={(event) => setManualMode(event.target.checked)} disabled={loading || !!model || finished} /> أريد تحديد حدود الجسم يدوياً بعد اختيار الصورة</label>
    <div className="wiki-list"><span>لبدء البناء اضغط على الصورة الأقرب، ويفضّل أن تكون بخلفية بسيطة:</span>{images.map((image, index) => <div key={image.url}>
      <button className="image-ref-card" type="button" onClick={() => { if (selected?.url === image.url) setAttempt((old) => old + 1); else setSelected(image); }} disabled={finished} aria-pressed={selected?.url === image.url}>
        <ReferenceThumbnail key={thumbnailRetry} image={image} alt={image.title} eager={index < 4}/><span>{image.title} · {image.author} · {image.license_name}</span>
      </button>
      <a href={image.url} target="_blank" rel="noopener noreferrer">افتح صفحة الصورة في Wikimedia ↗</a>
    </div>)}
      {!!images.length && <button type="button" className="btn btn-small" onClick={() => setThumbnailRetry((old) => old + 1)}>إعادة تحميل الصور</button>}
      {next !== null && <button type="button" className="btn btn-small" disabled={finished || pageBusy} onClick={() => void loadMore()}>{pageBusy ? 'جارٍ تحميل الصور…' : 'المزيد من الصور'}</button>}
      {pageError && <p role="alert" className="online-error">{pageError} يمكنك إعادة المحاولة.</p>}
      {!images.length && <p>{next === null ? 'لم تظهر صور بالتراخيص المدعومة.' : 'لم تظهر صور مناسبة بعد؛ اضغط المزيد من الصور للبحث في الصفحة التالية.'}</p>}
    </div>
    {selected && <p>الصورة: <a href={selected.url} target="_blank" rel="noopener noreferrer">{selected.title}</a> · {selected.author} · <a href={selected.license_url} target="_blank" rel="noopener noreferrer">{selected.license_name}</a></p>}
    {loading && <p role="status">أقرأ مصغّرة الصورة وأحاول فصل الجسم…</p>}
    {error && <p role="alert" className="online-error">{error} لم يُضف مجسم. حدّد حدود الجسم يدوياً أدناه إن ظهرت الأداة، أو اختر صورة أخرى أو ألغِ البناء.</p>}
    {error && selected && <button type="button" className="btn btn-small" onClick={() => setAttempt((old) => old + 1)}>إعادة محاولة الصورة</button>}
    {showOutline && pixels && selected && <PhotoOutline key={`${selected.url}:${attempt}`} image={pixels} onApply={(mask) => build(pixels, selected, false, mask)} />}
    {canUseSlab && pixels && selected && <div><p>تعذّر فصل الجسم. يمكن بدلاً من ذلك إنشاء لوح مجسّم من الصورة كاملة، <strong>بما فيها الخلفية</strong>؛ ليس نموذجاً مفصولاً للجسم.</p>
      <button type="button" className="btn btn-small" onClick={() => build(pixels, selected, true)}>استخدم الصورة كاملة كلوح تقريبي</button></div>}
    {model && <div ref={progressRoot}>
      {showMapPreview && stage ? <div className="construction-map-preview" aria-label="معاينة البناء داخل الماب"><Viewport plan={stage.base} constructionPreview={stage} selection={[]} tool="translate" space="world" snap={false} showGrid={false} onSelect={() => {}} onTransformCommit={() => {}} /></div> : !onPreview && <Preview model={model} rows={rows} />}
      <p role="status">بناء طبقات الشكل في موضعه على الماب: {Math.min(rows, model.height)} / {model.height}. المعاينة مؤقتة حتى اكتمال الإدراج.</p>
    </div>}
    <button type="button" className="btn btn-small" onClick={onCancel}>{cancelLabel}</button>
  </section>;
}
