import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { WorldPlan } from '../../core/world-plan/schema';
import {
  addEnvironmentLights,
  clearObject3DGroup,
  createTerrainMesh,
  createWaterMesh,
  createWorldObjectGroup,
  disposeObject3D,
} from '../../core/scene/sceneBuilder';

interface ViewportProps {
  plan: WorldPlan;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  terrainGroup: THREE.Group;
  objectsGroup: THREE.Group;
  lightsGroup: THREE.Group;
  selectionBox: THREE.Box3Helper;
  frameWorld: () => void;
}

type Status = 'loading' | 'ready' | 'error';

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 980;
}

export function Viewport({ plan, selectedId, onSelect }: ViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const planRef = useRef(plan);
  const selectRef = useRef(onSelect);
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');

  planRef.current = plan;
  selectRef.current = onSelect;

  // Renderer, scene, camera, controls, and the animation loop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      setStatus('error');
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'WebGL is unavailable. Try enabling hardware acceleration.',
      );
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.domElement.classList.add('viewport-canvas');
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#9ab6c8');
    scene.fog = new THREE.FogExp2('#9ab6c8', 0.002);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 5000);
    camera.position.set(90, 70, 110);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 2;
    controls.maxDistance = 900;
    controls.screenSpacePanning = false;
    controls.zoomSpeed = 0.9;

    const terrainGroup = new THREE.Group();
    terrainGroup.name = 'terrain-layer';
    const objectsGroup = new THREE.Group();
    objectsGroup.name = 'objects-layer';
    const lightsGroup = new THREE.Group();
    lightsGroup.name = 'lights-layer';
    scene.add(terrainGroup, objectsGroup, lightsGroup);

    const selectionBox = new THREE.Box3Helper(new THREE.Box3(), '#e2703a');
    selectionBox.visible = false;
    selectionBox.renderOrder = 999;
    const boxMaterial = selectionBox.material as THREE.LineBasicMaterial;
    boxMaterial.depthTest = false;
    boxMaterial.transparent = true;
    boxMaterial.opacity = 0.95;
    scene.add(selectionBox);

    const frameWorld = () => {
      const current = planRef.current;
      const size = current.terrain.size;
      const isPortrait = camera.aspect < 1;
      const distance = size * (isPortrait ? 1.18 : 0.9);
      const height = Math.max(current.terrain.heightScale, 2);

      camera.fov = isPortrait ? 62 : 52;
      camera.position.set(distance * 0.62, height + size * (isPortrait ? 0.52 : 0.42), distance * 0.72);
      camera.near = 0.1;
      camera.far = Math.max(2000, size * 8);
      camera.updateProjectionMatrix();
      controls.target.set(0, height * 0.15, 0);
      controls.maxDistance = size * 2.6;
      controls.update();
    };

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    let animationFrame = 0;
    const animate = () => {
      animationFrame = window.requestAnimationFrame(animate);
      controls.update();
      if (selectionBox.visible) selectionBox.updateMatrixWorld();
      renderer.render(scene, camera);
    };
    animate();

    // Click / tap selection, distinguished from orbit drags.
    const raycaster = new THREE.Raycaster();
    let downX = 0;
    let downY = 0;
    let downTime = 0;

    const pick = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const pointer = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(objectsGroup.children, true);
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object;
        while (node && node !== objectsGroup) {
          const id = node.userData.worldObjectId as string | undefined;
          if (id) {
            selectRef.current(id);
            return;
          }
          node = node.parent;
        }
      }
      selectRef.current(null);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      downX = event.clientX;
      downY = event.clientY;
      downTime = performance.now();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const distance = Math.hypot(event.clientX - downX, event.clientY - downY);
      const duration = performance.now() - downTime;
      if (distance > 7 || duration > 700) return;
      pick(event.clientX, event.clientY);
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setStatus('error');
      setErrorMessage('The WebGL context was lost. Reload the page to restore the viewport.');
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);

    runtimeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      terrainGroup,
      objectsGroup,
      lightsGroup,
      selectionBox,
      frameWorld,
    };
    setStatus('ready');

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      controls.dispose();
      clearObject3DGroup(terrainGroup);
      clearObject3DGroup(objectsGroup);
      clearObject3DGroup(lightsGroup);
      disposeObject3D(selectionBox);
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = null;
    };
  }, []);

  // Terrain and water are rebuilt only when terrain data or the seed changes.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const current = planRef.current;
    clearObject3DGroup(runtime.terrainGroup);
    runtime.terrainGroup.add(createTerrainMesh(current, isMobileViewport() ? 128 : 192));
    const water = createWaterMesh(current);
    if (water) runtime.terrainGroup.add(water);
    runtime.controls.maxDistance = current.terrain.size * 2.6;
  }, [plan.terrain, plan.seed]);

  // Objects are rebuilt when the object list changes.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    clearObject3DGroup(runtime.objectsGroup);
    let pointLights = 0;
    const lightLimit = isMobileViewport() ? 6 : 12;
    for (const object of planRef.current.objects) {
      if (!object.visible) continue;
      const withLight = object.kind === 'lantern' && pointLights < lightLimit;
      if (withLight) pointLights += 1;
      runtime.objectsGroup.add(createWorldObjectGroup(object, withLight));
    }
  }, [plan.objects]);

  // Lighting, sky and fog react to environment changes.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const current = planRef.current;
    const environment = current.environment;
    runtime.scene.background = new THREE.Color(environment.skyColor);
    runtime.scene.fog = new THREE.FogExp2(environment.fogColor, environment.fogDensity);
    clearObject3DGroup(runtime.lightsGroup);
    addEnvironmentLights(runtime.lightsGroup, environment, current.terrain.size);
    runtime.lightsGroup.traverse((child) => {
      if (child instanceof THREE.DirectionalLight) {
        const size = isMobileViewport() ? 1024 : 2048;
        child.shadow.mapSize.set(size, size);
        // Force a new shadow map allocation with the new resolution.
        child.shadow.map?.dispose();
        child.shadow.map = null;
      }
    });
  }, [plan.environment, plan.terrain.size]);

  // Frame the whole world only when a different world is opened.
  useEffect(() => {
    runtimeRef.current?.frameWorld();
  }, [plan.id]);

  // Keep the selection outline in sync with the selection or object edits.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    if (!selectedId) {
      runtime.selectionBox.visible = false;
      return;
    }
    const group = runtime.objectsGroup.children.find(
      (child) => child.userData.worldObjectId === selectedId,
    );
    if (!group) {
      runtime.selectionBox.visible = false;
      return;
    }
    group.updateWorldMatrix(true, true);
    runtime.selectionBox.box.setFromObject(group);
    runtime.selectionBox.visible = !runtime.selectionBox.box.isEmpty();
  }, [selectedId, plan.objects]);

  useEffect(() => {
    const frame = () => runtimeRef.current?.frameWorld();
    window.addEventListener('worldbuilder:frame', frame);
    return () => window.removeEventListener('worldbuilder:frame', frame);
  }, []);

  const handleFrame = () => runtimeRef.current?.frameWorld();

  return (
    <div className="viewport" ref={containerRef}>
      <div className="viewport-hud viewport-hud-top">
        <span className="hud-pill">
          <span className="hud-dot" />
          {plan.objects.length} objects
        </span>
        <span className="hud-pill hud-pill-subtle">{plan.terrain.style}</span>
      </div>

      <div className="viewport-hud viewport-hud-actions">
        <button
          type="button"
          className="icon-btn glass"
          onClick={handleFrame}
          title="Frame the world (F)"
          aria-label="Frame the world"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
        </button>
      </div>

      <div className="viewport-hint">
        <span className="desktop-only">Drag to orbit · Right-drag to pan · Scroll to zoom · Click to select</span>
        <span className="mobile-only">Drag to orbit · Pinch to zoom · Tap to select</span>
      </div>

      {status === 'loading' && (
        <div className="viewport-status">
          <span className="spinner" /> Preparing viewport…
        </div>
      )}
      {status === 'error' && (
        <div className="viewport-status viewport-error">
          <strong>3D viewport unavailable</strong>
          <p>{errorMessage}</p>
          <p>Editing and project export still work.</p>
        </div>
      )}
    </div>
  );
}
