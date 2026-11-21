import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ARENAS,
  BOSSES,
  BRIDGES,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FENCES,
  FIELDS,
  LANDMARKS,
  REGIONS,
  ROADS,
  TREES,
  WATER,
} from './data';
import type { RegionId } from './types';
import { buildMapScene, type MapScene } from './scene';
import { buildOverlays, type OverlayHandle } from './overlays';
import { MapHud } from './ui/MapHud';
import { MapMinimap } from './ui/MapMinimap';
import { RegionPanel } from './ui/RegionPanel';
import { BossPanel } from './ui/BossPanel';
import { LegendPanel } from './ui/LegendPanel';
import { MapTopBar } from './ui/MapTopBar';
import { PaperMapView } from './ui/PaperMapView';
import { DesignSheet } from './ui/DesignSheet';
import { ExploreHud } from './ui/ExploreHud';
import { bindKeyboard, createExplorer, type ExploreHandle, type ExploreStatus } from './explore';
import './game-map.css';

/**
 * Interactive 3D game map for «زعتر والحضيرة العظمى».
 *
 * The map is a playable *design document*: orbit the diorama, click a region to
 * read its level-design notes, click a boss banner to see its melee design, and
 * toggle the progression route, checkpoints, arenas and cutaway views.
 */

type ViewMode = 'diorama' | 'top' | 'flythrough';

const CAMERA_HOME = new THREE.Vector3(196, 292, 340);
const TARGET_HOME = new THREE.Vector3(-8, 0, 4);

const VIEW_PRESETS: Record<string, { eye: THREE.Vector3; target: THREE.Vector3 }> = {
  overview: { eye: CAMERA_HOME, target: TARGET_HOME },
  start: { eye: new THREE.Vector3(24, 30, 178), target: new THREE.Vector3(0, 2, 118) },
  farm: { eye: new THREE.Vector3(44, 42, 118), target: new THREE.Vector3(14, 2, 34) },
  crops: { eye: new THREE.Vector3(-10, 42, 92), target: new THREE.Vector3(-62, 2, 50) },
  pens: { eye: new THREE.Vector3(24, 54, -22), target: new THREE.Vector3(-6, 2, -96) },
  finale: { eye: new THREE.Vector3(-14, 30, -84), target: new THREE.Vector3(-46, 2, -134) },
  top: { eye: new THREE.Vector3(0, 400, 16), target: new THREE.Vector3(0, 0, 4) },
};

export interface MapSelection {
  kind: 'region' | 'boss';
  id: string;
}

export interface GameMapProps {
  /** Renders the page chrome (top bar + tab bar). Off inside the tab view. */
  embedded?: boolean;
}

export function GameMap({ embedded = false }: GameMapProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapScene | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);

  // `?explore` (or `#explore`) boots straight into the walk mode, so a shared
  // link needs no second click.
  const startInExplore = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.has('explore') || window.location.hash === '#explore';
  }, []);

  const [selection, setSelection] = useState<MapSelection | null>({ kind: 'region', id: 'farm' });
  const [hovered, setHovered] = useState<string | null>(null);
  const [showRoute, setShowRoute] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showArenas, setShowArenas] = useState(true);
  const [showRegions, setShowRegions] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('diorama');
  const [mode, setMode] = useState<'3d' | 'paper' | 'design'>('3d');
  const [overlay, setOverlay] = useState<'none' | 'regions' | 'bosses'>('none');
  const [guideOpen, setGuideOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(startInExplore);
  const [webglFailed, setWebglFailed] = useState(false);
  const [selectedBoss, setSelectedBoss] = useState<string | null>(null);
  const [, setCameraTick] = useState(0);
  const [exploring, setExploring] = useState(startInExplore);
  // Mirrors document.fullscreenElement: the API can be denied, and the user can
  // leave fullscreen with Esc or a system gesture at any time.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [exploreStatus, setExploreStatus] = useState<ExploreStatus>({
    x: 0,
    z: 148,
    speed: 0,
    sprinting: false,
    regionName: 'حافّة الغابة',
    progress: 0,
    wading: false,
  });
  const [exploreHint, setExploreHint] = useState(true);
  const [discovered, setDiscovered] = useState<string | null>(null);
  const explorerRef = useRef<ExploreHandle | null>(null);
  const exploringRef = useRef(false);

  const goTo = useCallback((preset: string) => {
    const target = VIEW_PRESETS[preset];
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!target || !controls || !camera) return;
    camera.userData.flying = {
      from: camera.position.clone(),
      to: target.eye.clone(),
      targetFrom: controls.target.clone(),
      targetTo: target.target.clone(),
      t: 0,
    };
    setCameraTick((tick) => tick + 1);
  }, []);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const focusOn = useCallback(
    (x: number, z: number, height = 46) => {
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      if (!camera || !controls) return;
      const target = new THREE.Vector3(x, 0, z);
      camera.userData.flying = {
        from: camera.position.clone(),
        to: new THREE.Vector3(x + height * 0.7, height + 24, z + height * 0.9),
        targetFrom: controls.target.clone(),
        targetTo: target,
        t: 0,
      };
      setCameraTick((tick) => tick + 1);
    },
    [],
  );

  /* ------------------------------------------------------------- setup */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      // No WebGL 2 (old GPU, remote desktop, blocked context). Explore mode has
      // nothing to walk on, so fall back to the paper map — the whole design is
      // still readable there.
      setWebglFailed(true);
      setExploring(false);
      setMode('paper');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);
    renderer.domElement.classList.add('map-canvas');

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.background = new THREE.Color('#9fc4e0');
    scene.fog = new THREE.Fog('#dfe6dc', 380, 760);

    const camera = new THREE.PerspectiveCamera(32, mount.clientWidth / mount.clientHeight, 0.6, 1400);
    camera.position.copy(CAMERA_HOME);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(TARGET_HOME);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 26;
    controls.maxDistance = 560;
    controls.zoomSpeed = 0.8;
    controls.rotateSpeed = 0.7;
    controlsRef.current = controls;

    // Lights: sunset key + sky fill + warm bounce.
    const hemisphere = new THREE.HemisphereLight('#cfe4f2', '#6a7a4a', 1.15);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight('#ffe6bd', 2.35);
    sun.position.set(-150, 200, 120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -190;
    sun.shadow.camera.right = 190;
    sun.shadow.camera.top = 230;
    sun.shadow.camera.bottom = -230;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 620;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.5;
    scene.add(sun);
    const rim = new THREE.DirectionalLight('#ffc48f', 0.5);
    rim.position.set(160, 80, -180);
    scene.add(rim);

    const map = buildMapScene({
      water: WATER,
      roads: ROADS,
      fields: FIELDS,
      fences: FENCES,
      circleFences: CIRCLE_FENCES,
      trees: TREES,
      buildings: BUILDINGS,
      arenas: ARENAS,
      bosses: BOSSES,
      regions: REGIONS,
      bridges: BRIDGES,
      checkpoints: CHECKPOINTS,
    });
    mapRef.current = map;
    scene.add(map.root);

    const clock = new THREE.Clock();
    let frame = 0;
    let disposed = false;

    let lastExplorerTick = 0;

    const animate = () => {
      if (disposed) return;
      const elapsed = clock.getElapsedTime();
      const dt = Math.min(0.05, elapsed - lastExplorerTick || 0.016);
      lastExplorerTick = elapsed;
      map.update(elapsed);

      // Explore mode owns the camera while it is active; the orbit rig steps
      // aside so the two never fight over the same transform.
      if (exploringRef.current && explorerRef.current) {
        explorerRef.current.update(dt, elapsed);
      }
      const flying = camera.userData.flying as
        | { from: THREE.Vector3; to: THREE.Vector3; targetFrom: THREE.Vector3; targetTo: THREE.Vector3; t: number }
        | undefined;
      if (flying) {
        flying.t = Math.min(1, flying.t + 0.026);
        const ease = flying.t < 0.5 ? 2 * flying.t * flying.t : 1 - Math.pow(-2 * flying.t + 2, 2) / 2;
        camera.position.lerpVectors(flying.from, flying.to, ease);
        controls.target.lerpVectors(flying.targetFrom, flying.targetTo, ease);
        if (flying.t >= 1) {
          delete camera.userData.flying;
        }
      }
      if (!exploringRef.current) controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);

    /* -------------------------------------------------- pointer picking */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let downPosition: { x: number; y: number } | null = null;
    let hoverRaf = 0;

    const pick = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(map.root, true);
      return hits;
    };

    const resolveHit = (hits: THREE.Intersection[]): { kind: 'region' | 'boss'; id: string } | null => {
      for (const hit of hits) {
        // Skip the decorative backdrop (distant hills, horizon plane): walking
        // there is impossible, so a click must not resolve to a real region.
        let probe: THREE.Object3D | null = hit.object;
        let backdrop = false;
        while (probe) {
          if (probe.userData.decorative) { backdrop = true; break; }
          probe = probe.parent;
        }
        if (backdrop) continue;

        let node: THREE.Object3D | null = hit.object;
        while (node) {
          const bossId = node.userData.bossId as string | undefined;
          if (bossId) return { kind: 'boss', id: bossId };
          const regionId = node.userData.regionId as RegionId | undefined;
          if (regionId) return { kind: 'region', id: regionId };
          if (node.name.startsWith('boss-')) return { kind: 'boss', id: node.name.slice(5) };
          node = node.parent;
        }
        // Terrain / roads: resolve the nearest region centre.
        const point = hit.point;
        const region = REGIONS.slice()
          .sort((a, b) => Math.hypot(point.x - a.center[0], point.z - a.center[1]) - Math.hypot(point.x - b.center[0], point.z - b.center[1]))[0];
        if (region) return { kind: 'region', id: region.id };
      }
      return null;
    };

    const onPointerDown = (event: PointerEvent) => {
      downPosition = { x: event.clientX, y: event.clientY };
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!downPosition) return;
      const moved = Math.hypot(event.clientX - downPosition.x, event.clientY - downPosition.y);
      downPosition = null;
      if (moved > 6) return;
      const hits = pick(event);
      const resolved = resolveHit(hits);
      if (!resolved) return;
      setSelection(resolved);
      if (resolved.kind === 'boss') setSelectedBoss(resolved.id);
      else setSelectedBoss(null);
      setCollapsed(false);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const hits = pick(event);
        const resolved = resolveHit(hits);
        setHovered(resolved ? `${resolved.kind}:${resolved.id}` : null);
        renderer.domElement.style.cursor = resolved ? 'pointer' : 'grab';
      });
    };
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointermove', onPointerMove);

    const onResize = () => {
      if (!mount.clientWidth || !mount.clientHeight) return;
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(mount);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      controls.dispose();
      map.dispose();
      scene.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const entry of materials) entry?.dispose();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
    };
  }, []);


  /* ----------------------------------------------------- explore mode */
  useEffect(() => {
    exploringRef.current = exploring;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const map = mapRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !map) return;

    if (!exploring) {
      explorerRef.current?.dispose();
      explorerRef.current = null;
      if (controls) controls.enabled = true;
      return;
    }

    // Orbit is disabled: in explore mode the chase camera is authoritative.
    if (controls) controls.enabled = false;
    // Cancel any in-flight fly-to so the camera does not teleport mid-walk.
    delete camera.userData.flying;

    const explorer = createExplorer({
      heightAt: map.heightAt,
      scene,
      camera,
      onFirstMove: () => setExploreHint(false),
    });
    explorerRef.current = explorer;
    const unbind = bindKeyboard(() => explorer.intent);
    const keydown = (event: KeyboardEvent) => {
      if (event.code === 'KeyR' && !event.ctrlKey && !event.metaKey) {
        explorer.player.reset();
        explorer.snapCamera();
      }
    };
    window.addEventListener('keydown', keydown);

    // Poll the HUD at 10 Hz: enough to feel live, cheap enough not to thrash React.
    let lastCheckpoint: string | null = null;
    const timer = window.setInterval(() => {
      setExploreStatus(explorer.status());
      const checkpoint = explorer.nearestCheckpoint();
      if (checkpoint && checkpoint.id !== lastCheckpoint) {
        lastCheckpoint = checkpoint.id;
        setDiscovered(checkpoint.name);
        window.setTimeout(() => setDiscovered(null), 2600);
      }
    }, 100);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('keydown', keydown);
      unbind();
      explorer.dispose();
      explorerRef.current = null;
      if (controls) controls.enabled = true;
    };
  }, [exploring]);

  // One-key entry, so the reviewer never has to hunt for the button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.code !== 'KeyE' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (mode !== '3d') return;
      event.preventDefault();
      const next = !exploringRef.current;
      if (next) {
        setCollapsed(true);
        setExploreHint(true);
      }
      setExploring(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  /**
   * Takes the whole screen when explore mode starts.
   *
   * Two separate mechanisms, because neither works everywhere:
   *  - the Fullscreen API removes browser chrome on desktop and most Android
   *    browsers. It requires a user gesture in some browsers, so it is only
   *    attempted from the click/E handlers, and a rejection is ignored: being
   *    denied fullscreen must never stop the exploration.
   *  - a CSS class hides our own header, so even without the API the screen is
   *    the map and nothing else.
   */
  const enterFullscreen = useCallback(() => {
    const element = document.documentElement;
    if (document.fullscreenElement) return;
    const request = element.requestFullscreen?.bind(element);
    if (!request) return;
    // Safari on iPhone has no element fullscreen; the CSS fallback covers it.
    request({ navigationUI: 'hide' } as never).catch(() => {
      /* Denied or unsupported: the layout already fills the screen. */
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    if (!document.fullscreenElement) return;
    void document.exitFullscreen?.().catch(() => {
      /* Nothing to restore. */
    });
  }, []);

  const startExploring = useCallback(() => {
    setMode('3d');
    setCollapsed(true);
    setExploreHint(true);
    setExploring(true);
    enterFullscreen();
  }, [enterFullscreen]);

  const stopExploring = useCallback(() => {
    setExploring(false);
    setExploreHint(true);
    // Nothing is more confusing than exiting the map and still being stuck in
    // a chromeless window.
    exitFullscreen();
    // Hand the camera back to the orbit rig at the fox's last position.
    const explorer = explorerRef.current;
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (explorer && controls && camera) {
      controls.target.set(explorer.player.state.x, 0, explorer.player.state.z);
      camera.position.set(
        explorer.player.state.x + 60,
        80,
        explorer.player.state.z + 70,
      );
    }
  }, []);

  /* -------------------------------------------------- design overlays */
  const overlayRef = useRef<OverlayHandle | null>(null);
  useEffect(() => {
    const scene = sceneRef.current;
    const map = mapRef.current;
    if (!scene || !map) return;
    const overlay = buildOverlays({
      heightAt: map.heightAt,
      regions: REGIONS,
      arenas: ARENAS,
      bosses: BOSSES,
      showRoute,
      showArenas,
      showRegions,
      beacon:
        showLabels && selection?.kind === 'region'
          ? { center: REGIONS.find((region) => region.id === selection.id)?.center ?? [0, 0], color: '#fff1c4' }
          : null,
    });
    overlayRef.current = overlay;
    scene.add(overlay.group);
    let frame = 0;
    const start = performance.now();
    const tick = () => {
      overlay.animate((performance.now() - start) / 1000);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      scene.remove(overlay.group);
      overlay.dispose();
      overlayRef.current = null;
    };
  }, [showRoute, showArenas, showRegions, showLabels, selection]);

  /* ------------------------------------------------------- flythrough */
  const flythroughRef = useRef<number | null>(null);
  useEffect(() => {
    if (viewMode !== 'flythrough') return;
    const order = ['start', 'farm', 'crops', 'pens', 'finale'];
    let index = 0;
    const step = () => {
      goTo(order[index % order.length]!);
      index += 1;
    };
    step();
    const interval = window.setInterval(step, 7000);
    return () => {
      window.clearInterval(interval);
      if (flythroughRef.current) window.clearTimeout(flythroughRef.current);
    };
  }, [viewMode, goTo]);

  useEffect(() => {
    if (viewMode === 'top') goTo('top');
    else if (viewMode === 'diorama') goTo('overview');
  }, [viewMode, goTo]);

  const activeRegion = selection?.kind === 'region' ? REGIONS.find((region) => region.id === selection.id) : null;
  const activeBoss = selectedBoss ? BOSSES.find((boss) => boss.id === selectedBoss) : null;

  const handleRegionSelect = (regionId: RegionId) => {
    setSelection({ kind: 'region', id: regionId });
    setSelectedBoss(null);
    setCollapsed(false);
    const region = REGIONS.find((entry) => entry.id === regionId);
    if (region) focusOn(region.center[0], region.center[1], region.radius * 0.9);
  };

  const handleBossSelect = (bossId: string) => {
    const boss = BOSSES.find((entry) => entry.id === bossId);
    if (!boss) return;
    setSelection({ kind: 'boss', id: bossId });
    setSelectedBoss(bossId);
    setCollapsed(false);
    focusOn(boss.position[0], boss.position[1], 30);
  };

  const hoveredBossId = hovered?.startsWith('boss:') ? hovered.slice(5) : null;

  return (
    <div
      className={`map-app${embedded ? ' map-app--embedded' : ''}${exploring ? ' map-app--exploring' : ''}`}
      dir="rtl"
    >
      {!embedded && (
        <MapTopBar
          onGoTo={goTo}
          mode={mode}
          onMode={setMode}
          viewMode={viewMode}
          onViewMode={setViewMode}
          onToggleGuide={() => setGuideOpen((open) => !open)}
          overlay={overlay}
          onOverlay={setOverlay}
        />
      )}

      {mode === '3d' && !exploring && (
        <button type="button" className="explore-enter" onClick={startExploring}>
          <span className="explore-enter-mark">🦊</span>
          <span>
            <strong>استكشف الخريطة بزعتر</strong>
            <em>امشِ في المستوى · بلا قتال · مفتاح E</em>
          </span>
        </button>
      )}

      {webglFailed && (
        <div className="map-webgl-notice" role="status">
          <strong>جهازك لا يدعم WebGL 2</strong>
          <span>
            عرضنا لك الخريطة الورقية بدلًا من الديوراما ثلاثية الأبعاد — وضع الاستكشاف يحتاج
            تسريع الرسومات. جرّب متصفحًا آخر أو فعّل تسريع العتاد.
          </span>
          <button type="button" onClick={() => setWebglFailed(false)} aria-label="إغلاق" className="map-webgl-close">
            ✕
          </button>
        </div>
      )}

      {mode === 'paper' ? (
        <PaperMapView
          selectedRegion={activeRegion?.id ?? null}
          onRegionSelect={handleRegionSelect}
          onBossSelect={handleBossSelect}
          onOpen3D={() => setMode('3d')}
        />
      ) : mode === 'design' ? (
        <DesignSheet />
      ) : (
      <div className="map-stage">
        <div className="map-canvas-wrap">
          <div ref={mountRef} className="map-mount" />
          <div className="map-vignette" aria-hidden="true" />

          {embedded && (
            <div className="map-stage-toolbar">
              <button
                type="button"
                className={`map-chip${viewMode === 'diorama' ? ' is-active' : ''}`}
                onClick={() => setViewMode('diorama')}
              >
                🏔️ ديوراما
              </button>
              <button
                type="button"
                className={`map-chip${viewMode === 'top' ? ' is-active' : ''}`}
                onClick={() => setViewMode('top')}
              >
                🗺️ خريطة من أعلى
              </button>
              <button
                type="button"
                className={`map-chip${viewMode === 'flythrough' ? ' is-active' : ''}`}
                onClick={() => setViewMode((mode) => (mode === 'flythrough' ? 'diorama' : 'flythrough'))}
              >
                🎥 جولة
              </button>
              <span className="map-chip-divider" />
              <button
                type="button"
                className={`map-chip${showRoute ? ' is-active' : ''}`}
                onClick={() => setShowRoute((value) => !value)}
              >
                〰️ المسار
              </button>
              <button
                type="button"
                className={`map-chip${showRegions ? ' is-active' : ''}`}
                onClick={() => setShowRegions((value) => !value)}
              >
                ⬚ حدود المناطق
              </button>
              <button
                type="button"
                className={`map-chip${showArenas ? ' is-active' : ''}`}
                onClick={() => setShowArenas((value) => !value)}
              >
                ⚔️ الأرينات
              </button>
              <span className="map-chip-divider" />
              <button type="button" className="map-chip" onClick={() => setMode('paper')}>
                🗞️ الخريطة الورقية
              </button>
            </div>
          )}

          <MapHud
            bosses={BOSSES}
            regions={REGIONS}
            selectedBoss={selectedBoss}
            hoveredBoss={hoveredBossId}
            onBossSelect={handleBossSelect}
            onRegionSelect={handleRegionSelect}
          />

          <MapMinimap
            regions={REGIONS}
            bosses={BOSSES}
            checkpoints={CHECKPOINTS}
            landmarks={LANDMARKS}
            selection={selection}
            hovered={hovered}
            onRegionSelect={handleRegionSelect}
            onBossSelect={handleBossSelect}
          />

          <div className={`map-side${collapsed ? ' is-collapsed' : ''}`}>
            <button
              type="button"
              className="map-side-toggle"
              onClick={() => setCollapsed((value) => !value)}
              aria-label={collapsed ? 'إظهار اللوحة' : 'إخفاء اللوحة'}
            >
              {collapsed ? '◀' : '▶'}
            </button>
            {!collapsed && (
              <>
                {activeBoss ? (
                  <BossPanel boss={activeBoss} onClose={() => setSelectedBoss(null)} onRegion={() => handleRegionSelect(activeBoss.regionId)} />
                ) : (
                  <RegionPanel region={activeRegion ?? null} onBossSelect={handleBossSelect} />
                )}
                <LegendPanel
                  showRoute={showRoute}
                  showRegions={showRegions}
                  showArenas={showArenas}
                  showLabels={showLabels}
                  onRoute={setShowRoute}
                  onRegions={setShowRegions}
                  onArenas={setShowArenas}
                  onLabels={setShowLabels}
                  onGoTo={goTo}
                />
              </>
            )}
          </div>

          {exploring && (
            <ExploreHud
              status={exploreStatus}
              discovered={discovered}
              showHint={exploreHint}
              onStick={(forward, strafe) => {
                const explorer = explorerRef.current;
                if (!explorer) return;
                explorer.intent.forward = forward;
                explorer.intent.strafe = strafe;
              }}
              onJump={() => {
                const explorer = explorerRef.current;
                if (explorer) explorer.intent.jump = true;
              }}
              onSprint={(active) => {
                const explorer = explorerRef.current;
                if (explorer) explorer.intent.sprint = active;
              }}
              onReset={() => {
                explorerRef.current?.player.reset();
                explorerRef.current?.snapCamera();
              }}
              onExit={stopExploring}
              onFullscreen={enterFullscreen}
              isFullscreen={isFullscreen}
            />
          )}

          {!exploring && (
            <div className="map-stage-hint">
              اسحب للدوران · عجلة/إصبعان للتكبير · انقر منطقة أو بوسًا لقراءة التصميم
            </div>
          )}
        </div>
      </div>
      )}

      {guideOpen && <MapGuide onClose={() => setGuideOpen(false)} />}
    </div>
  );
}

/* ============================================================== guide modal */

function MapGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="map-guide-backdrop" onClick={onClose} role="presentation">
      <div className="map-guide" onClick={(event) => event.stopPropagation()}>
        <div className="map-guide-head">
          <div>
            <p className="map-kicker">دليل قراءة الخريطة</p>
            <h2>كيف تلعب هذه الخريطة قبل بناء اللعبة</h2>
          </div>
          <button type="button" className="map-icon-button" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>
        <div className="map-guide-grid">
          <section>
            <h3>🎯 ماذا ترى هنا</h3>
            <p>
              هذه ليست اللعبة، بل <strong>خريطة تصميم ثلاثية الأبعاد</strong> للحضيرة العظمى: أرضية كل منطقة،
              مبانيها، حقولها، ممراتها المائية، أرينات البوسات ونقاط الحفظ. كل ما تنقره يعرض ملاحظات المستوى
              وتصميم البوس — بالضبط الورقة التي يعمل عليها مصمّم المستويات قبل أن يبدأ بناء اللعبة.
            </p>
          </section>
          <section>
            <h3>🧭 المناطق الثلاث</h3>
            <p>
              من الشمال <strong>المزرعة</strong> (البيت والسوق والبئر)، غربها <strong>منطقة الزراعة</strong>
              (حقول وطاحونة وجرن)، وشمال النهر <strong>منطقة الحظائر</strong> (مراعٍ ودجاج وكباش)، وداخل الأخيرة
              <strong> قصر الحضيرة</strong> حيث البوس النهائي. اللفّة الكاملة تعود بك إلى نقطة حفظ، والاختصارات
              تقصّر الطريق بعد كل موت.
            </p>
          </section>
          <section>
            <h3>⚔️ البوسات الخمسة</h3>
            <p>
              ديك رومي حصّاد (غُبار)، ديك متغطرس (صيّاح)، بطة عجوز (بطبوط)، كبش (نطّاح)، ودجاجة ملكية
              (كلوكزيلا). انقر أي شعار بوس لتعرف مراحله وأسراره وتكتيك الهزيمة — كلها حيوانات مزرعة حقيقية،
              بلا سحر أو مسوخ.
            </p>
          </section>
          <section>
            <h3>🕹️ التحكّم</h3>
            <p>
              اسحب بالماوس أو بإصبع واحد للدوران، والعجلة أو إصبعان للتكبير، والزر الأيمن للتحريك. أزرار
              الأعلى تنقلك بين المناطق. «خريطة من أعلى» تعطيك مخططًا للقراءة مثل خريطة ورقية، و«جولة»
              تتنقّل تلقائيًا بين الأرينات.
            </p>
          </section>
        </div>
        <p className="map-guide-foot">الاتجاه: أعلى الشاشة شمالُ الحضيرة (قصر الملكة)، وأسفلها يبدأ زعتر رحلته. المخطط الورقي الكامل في تبويب «الخريطة الورقية».</p>
      </div>
    </div>
  );
}
