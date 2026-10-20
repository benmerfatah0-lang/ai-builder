import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import {
  isGroup,
  type SceneNode,
  type Transform,
  type WorldPlan,
} from '../../core/world-plan/schema';
import {
  addEnvironmentLights,
  applyTransform,
  clearObject3DGroup,
  createGrid,
  createTerrainMesh,
  createWaterMesh,
  createWorldGroupObject,
  createWorldObjectGroup,
  disposeObject3D,
  findNodeObject,
  readTransform,
} from '../../core/scene/sceneBuilder';
import { isEffectivelyLocked, isEffectivelyVisible } from '../../core/world-plan/hierarchy';
import {
  WebGLUnavailableError,
  captureViewportPng,
  createViewportRenderer,
  downloadBlob,
  type RendererProfile,
} from '../../core/scene/renderer';
import { createSkyDome, placeSkyDome, type SkyHandle } from '../../core/scene/sky';
import { animateWater, type WaterAnimation } from '../../core/scene/water';
import { Icon } from '../../ui/Icon';

export type TransformTool = 'translate' | 'rotate' | 'scale';
export type TransformSpace = 'world' | 'local';

export type AxisFilter = { x: boolean; y: boolean; z: boolean };

export const ALL_AXES: AxisFilter = { x: true, y: true, z: true };

export interface ViewportProps {
  plan: WorldPlan;
  selection: string[];
  tool: TransformTool;
  space: TransformSpace;
  snap: boolean;
  showGrid: boolean;
  axes?: AxisFilter;
  onSelect: (id: string | null, additive: boolean) => void;
  onTransformCommit: (id: string, transform: Transform) => void;
  onTransformStart?: () => void;
}

interface Runtime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transformControls: TransformControls;
  terrainGroup: THREE.Group;
  objectsGroup: THREE.Group;
  lightsGroup: THREE.Group;
  overlayGroup: THREE.Group;
  sky: SkyHandle;
  frameWorld: () => void;
  frameSelection: (ids: string[]) => void;
  refreshOverlay: () => void;
}

type Status = 'loading' | 'ready' | 'error';

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 980;
}

export function Viewport({
  plan,
  selection,
  tool,
  space,
  snap,
  showGrid,
  axes,
  onSelect,
  onTransformCommit,
  onTransformStart,
}: ViewportProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const planRef = useRef(plan);
  const selectionRef = useRef(selection);
  const nodeObjectsRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const builtNodesRef = useRef<
    Map<
      string,
      { node: SceneNode; object3d: THREE.Object3D; parentId: string | null; withLight: boolean }
    >
  >(new Map());
  const callbacksRef = useRef({ onSelect, onTransformCommit, onTransformStart });
  const gizmoRef = useRef({ tool, space, snap });
  const [status, setStatus] = useState<Status>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [profile, setProfile] = useState<RendererProfile | null>(null);
  const [stats, setStats] = useState({ fps: 0, calls: 0, triangles: 0 });
  const [notice, setNotice] = useState('');
  const waterRef = useRef<WaterAnimation | null>(null);

  planRef.current = plan;
  selectionRef.current = selection;
  callbacksRef.current = { onSelect, onTransformCommit, onTransformStart };
  gizmoRef.current = { tool, space, snap };

  // Renderer, scene, camera, controls, gizmo and animation loop.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const narrow = isNarrowViewport();
    let renderer: THREE.WebGLRenderer;
    let rendererProfile: RendererProfile;
    try {
      ({ renderer, profile: rendererProfile } = createViewportRenderer(narrow));
    } catch (error) {
      setStatus('error');
      setErrorMessage(
        error instanceof WebGLUnavailableError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'WebGL is unavailable. Try enabling hardware acceleration.',
      );
      return;
    }
    setProfile(rendererProfile);

    renderer.domElement.classList.add('viewport-canvas');
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);

    try {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#9ab6c8');
    scene.fog = new THREE.FogExp2('#9ab6c8', 0.002);

    // Real shader sky: gradient + sun disc, kept in sync with the world lights.
    const sky = createSkyDome(planRef.current.environment);
    scene.add(sky.mesh);

    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 5000);
    camera.position.set(90, 70, 110);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.maxPolarAngle = Math.PI * 0.495;
    controls.minDistance = 1.5;
    controls.maxDistance = 900;
    controls.screenSpacePanning = false;
    controls.zoomSpeed = 0.9;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const terrainGroup = new THREE.Group();
    terrainGroup.name = 'terrain-layer';
    const objectsGroup = new THREE.Group();
    objectsGroup.name = 'objects-layer';
    const lightsGroup = new THREE.Group();
    lightsGroup.name = 'lights-layer';
    const overlayGroup = new THREE.Group();
    overlayGroup.name = 'overlay-layer';
    scene.add(terrainGroup, objectsGroup, lightsGroup, overlayGroup);

    // ---- Transform gizmo -------------------------------------------------
    const transformControls = new TransformControls(camera, renderer.domElement);
    transformControls.setSize(narrow ? 1.45 : 1.05);
    transformControls.setSpace('world');
    const gizmoHelper = transformControls.getHelper();
    gizmoHelper.name = 'transform-gizmo';
    gizmoHelper.renderOrder = 10;
    scene.add(gizmoHelper);

    // Set while a gizmo drag is in progress, so the following pointerup is not
    // mistaken for a click on the object underneath the handle.
    let gizmoInteraction = false;
    let overlayFrame = 0;

    transformControls.addEventListener('dragging-changed', (event) => {
      const dragging = Boolean((event as unknown as { value: boolean }).value);
      controls.enabled = !dragging;
      if (dragging) {
        gizmoInteraction = true;
        callbacksRef.current.onTransformStart?.();
      }
      container.classList.toggle('is-transforming', dragging);
    });

    transformControls.addEventListener('mouseUp', () => {
      const object = transformControls.object;
      const primary = selectionRef.current[selectionRef.current.length - 1];
      if (!object || !primary) return;
      callbacksRef.current.onTransformCommit(primary, readTransform(object));
      runtimeRef.current?.refreshOverlay();
    });

    transformControls.addEventListener('objectChange', () => {
      // Coalesce outline updates to one per animation frame while dragging.
      if (overlayFrame) return;
      overlayFrame = window.requestAnimationFrame(() => {
        overlayFrame = 0;
        runtimeRef.current?.refreshOverlay();
      });
    });

    // ---- Camera framing --------------------------------------------------
    const frameWorld = () => {
      const current = planRef.current;
      const size = current.terrain.size;
      const isPortrait = camera.aspect < 1;
      const distance = size * (isPortrait ? 1.16 : 0.9);
      const height = Math.max(current.terrain.heightScale, 2);

      camera.fov = isPortrait ? 62 : 52;
      camera.position.set(distance * 0.62, height + size * (isPortrait ? 0.5 : 0.4), distance * 0.72);
      camera.near = 0.1;
      camera.far = Math.max(2000, size * 8);
      camera.updateProjectionMatrix();
      controls.target.set(0, height * 0.12, 0);
      controls.maxDistance = size * 2.6;
      controls.update();
    };

    const frameSelection = (ids: string[]) => {
      const map = nodeObjectsRef.current;
      const box = new THREE.Box3();
      for (const id of ids) {
        const object = map.get(id) ?? findNodeObject(objectsGroup, id);
        if (!object) continue;
        object.updateWorldMatrix(true, true);
        box.expandByObject(object);
      }
      if (box.isEmpty()) {
        frameWorld();
        return;
      }

      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 0.8);
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const fit = radius / Math.sin(fov / 2);
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (direction.lengthSq() < 1e-6) direction.set(0.6, 0.55, 0.6).normalize();

      controls.target.copy(center);
      camera.position.copy(center.clone().add(direction.multiplyScalar(fit * 1.25)));
      camera.near = Math.max(0.05, radius / 500);
      camera.updateProjectionMatrix();
      controls.update();
    };

    const refreshOverlay = () => {
      clearObject3DGroup(overlayGroup);
      const ids = selectionRef.current;
      const map = nodeObjectsRef.current;
      const plan = planRef.current;
      ids.forEach((id, index) => {
        const object = map.get(id);
        if (!object) return;
        // A hidden node has no visible geometry, so an outline would float in space.
        if (!isEffectivelyVisible(plan, id)) return;
        object.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) return;
        const primary = index === ids.length - 1;
        const helper = new THREE.Box3Helper(box, primary ? '#f08a4b' : '#6d93f5');
        const helperMaterial = helper.material as THREE.LineBasicMaterial;
        helperMaterial.depthTest = false;
        helperMaterial.transparent = true;
        helperMaterial.opacity = primary ? 0.95 : 0.6;
        helper.renderOrder = 999;
        helper.name = `selection-outline-${id}`;
        overlayGroup.add(helper);
      });
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
    let frameCount = 0;
    let statsSince = performance.now();
    let lowFpsSamples = 0;
    // Adaptive resolution: step the pixel ratio down if the device cannot keep up
    // (common on older Android phones). It never goes back up, so it cannot oscillate.
    let qualityScale = 1;
    const startedAt = performance.now();
    const clock = new THREE.Clock();

    const animate = () => {
      animationFrame = window.requestAnimationFrame(animate);
      controls.update();

      const elapsed = clock.getElapsedTime();
      waterRef.current?.update(elapsed);
      placeSkyDome(sky, camera);
      renderer.render(scene, camera);

      frameCount += 1;
      const now = performance.now();
      if (now - statsSince >= 500) {
        const fps = Math.round((frameCount * 1000) / (now - statsSince));
        setStats({
          fps,
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
        });
        frameCount = 0;
        statsSince = now;

        // Ignore the first two seconds (shader compilation, first uploads).
        if (now - startedAt > 2000) {
          lowFpsSamples = fps < 28 ? lowFpsSamples + 1 : 0;
          if (lowFpsSamples >= 3 && qualityScale > 0.6) {
            lowFpsSamples = 0;
            qualityScale = Math.max(0.55, qualityScale - 0.15);
            renderer.setPixelRatio(
              Math.min(window.devicePixelRatio || 1, narrow ? 1.65 : 2) * qualityScale,
            );
            resize();
          }
        }
      }
    };
    animate();

    // ---- Picking ---------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    let downX = 0;
    let downY = 0;
    let downTime = 0;

    const pick = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
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
          if (id) return id;
          node = node.parent;
        }
      }
      return null;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      downX = event.clientX;
      downY = event.clientY;
      downTime = performance.now();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      if (gizmoInteraction) {
        gizmoInteraction = false;
        return;
      }
      if (transformControls.dragging || transformControls.axis !== null) return;
      const moved = Math.hypot(event.clientX - downX, event.clientY - downY);
      const duration = performance.now() - downTime;
      if (moved > 8 || duration > 800) return;
      const id = pick(event.clientX, event.clientY);
      const additive =
        event.pointerType !== 'touch' && (event.shiftKey || event.ctrlKey || event.metaKey);
      callbacksRef.current.onSelect(id, additive);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const id = pick(event.clientX, event.clientY);
      if (id) frameSelection([id]);
    };

    const onContextLost = (event: Event) => {
      // Preventing the default lets the browser restore the context automatically.
      event.preventDefault();
      setStatus('error');
      setErrorMessage(
        'The GPU context was lost (this can happen after a driver reset or when the tab ' +
          'was in the background for a long time). Waiting for the browser to restore it…',
      );
    };

    const onContextRestored = () => {
      setErrorMessage('');
      setStatus('ready');
      resize();
    };

    let noticeTimer = 0;
    const showNotice = (message: string) => {
      setNotice(message);
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => setNotice(''), 2600);
    };

    const onCapture = async () => {
      try {
        const blob = await captureViewportPng(renderer, scene, camera);
        const name = (planRef.current.name || 'world').replace(/[^a-z0-9-_]+/gi, '-');
        downloadBlob(blob, `${name}-viewport.png`);
        showNotice('Viewport PNG exported');
      } catch (error) {
        console.error('Could not capture the viewport.', error);
        showNotice('Could not save the image');
      }
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('dblclick', onDoubleClick);
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored);
    window.addEventListener('worldbuilder:capture', onCapture);

    runtimeRef.current = {
      renderer,
      scene,
      camera,
      controls,
      transformControls,
      terrainGroup,
      objectsGroup,
      lightsGroup,
      overlayGroup,
      sky,
      frameWorld,
      frameSelection,
      refreshOverlay,
    };
    setStatus('ready');

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('dblclick', onDoubleClick);
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('worldbuilder:capture', onCapture);
      if (overlayFrame) window.cancelAnimationFrame(overlayFrame);
      window.clearTimeout(noticeTimer);
      waterRef.current?.dispose();
      waterRef.current = null;
      scene.remove(sky.mesh);
      sky.dispose();
      transformControls.detach();
      transformControls.dispose();
      scene.remove(gizmoHelper);
      controls.dispose();
      clearObject3DGroup(terrainGroup);
      clearObject3DGroup(objectsGroup);
      clearObject3DGroup(lightsGroup);
      clearObject3DGroup(overlayGroup);
      renderer.dispose();
      // Release the GPU context now instead of waiting for GC: browsers cap the
      // number of live contexts, and the viewport is recreated on remount.
      try {
        renderer.forceContextLoss();
      } catch {
        /* ignore: context may already be gone */
      }
      renderer.domElement.remove();
      runtimeRef.current = null;
      nodeObjectsRef.current = new Map();
      builtNodesRef.current.clear();
    };
    } catch (error) {
      // Any failure while wiring controls must not take down the editor.
      console.error('Viewport setup failed.', error);
      try {
        renderer.dispose();
        renderer.domElement.remove();
      } catch {
        /* ignore secondary failures */
      }
      setStatus('error');
      setErrorMessage(
        error instanceof Error ? error.message : 'The 3D viewport could not start.',
      );
      return;
    }
  }, []);

  // Terrain, water and grid.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const current = planRef.current;
    waterRef.current?.dispose();
    waterRef.current = null;
    clearObject3DGroup(runtime.terrainGroup);
    runtime.terrainGroup.add(createTerrainMesh(current, isNarrowViewport() ? 128 : 192));
    const water = createWaterMesh(current);
    waterRef.current = water ? animateWater(water) : null;
    if (water) runtime.terrainGroup.add(water);
    if (showGrid) runtime.terrainGroup.add(createGrid(current));
    runtime.controls.maxDistance = current.terrain.size * 2.6;
  }, [plan.terrain, plan.seed, showGrid]);

  // Hierarchy-aware objects layer.
  //
  // The effect diffs the plan against the previously built graph: unchanged
  // nodes are reused, renamed/re-materialed/regenerated nodes are rebuilt on
  // their own, and only stale nodes are disposed. Regenerating one object or a
  // region therefore never rebuilds the whole world.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const current = planRef.current;
    const previous = builtNodesRef.current;
    const next = new Map<
      string,
      { node: SceneNode; object3d: THREE.Object3D; parentId: string | null; withLight: boolean }
    >();
    const all = [...current.groups, ...current.objects];
    const byId = new Map(all.map((node) => [node.id, node]));
    let pointLights = 0;
    const lightLimit = isNarrowViewport() ? 6 : 12;

    const ensureNode = (
      node: SceneNode,
      parent: THREE.Object3D,
      forceRebuild: boolean,
    ): THREE.Object3D => {
      const existing = previous.get(node.id);
      const desiredLight =
        !isGroup(node) && node.kind === 'lantern' && (existing?.withLight ?? pointLights < lightLimit);
      const canReuse =
        existing !== undefined &&
        !forceRebuild &&
        existing.node === node &&
        existing.parentId === node.parentId &&
        isGroup(node) === !('kind' in node) &&
        (!desiredLight || existing.withLight);

      if (canReuse) {
        const object3d = existing.object3d;
        applyTransform(object3d, node.transform);
        object3d.visible = isEffectivelyVisible(current, node.id);
        object3d.userData.worldLocked = isEffectivelyLocked(current, node.id);
        parent.add(object3d);
        if (existing.withLight) pointLights += 1;
        next.set(node.id, { ...existing, object3d });
        return object3d;
      }

      // Anything attached to the old node is disposed with it; descendants are
      // rebuilt because their Three.js objects no longer exist.
      if (existing) {
        existing.object3d.removeFromParent();
        disposeObject3D(existing.object3d);
      }

      let object3d: THREE.Object3D;
      let withLight = false;
      if (isGroup(node)) {
        object3d = createWorldGroupObject(node);
      } else {
        withLight = node.kind === 'lantern' && pointLights < lightLimit;
        if (withLight) pointLights += 1;
        object3d = createWorldObjectGroup(node, withLight);
      }
      parent.add(object3d);
      object3d.visible = isEffectivelyVisible(current, node.id);
      object3d.userData.worldLocked = isEffectivelyLocked(current, node.id);
      next.set(node.id, { node, object3d, parentId: node.parentId, withLight });
      return object3d;
    };

    const buildBranch = (node: SceneNode, parent: THREE.Object3D, forceRebuild: boolean) => {
      const rebuiltHere = ensureNode(node, parent, forceRebuild);
      const entry = next.get(node.id);
      const wasRebuilt =
        forceRebuild || !previous.get(node.id) || previous.get(node.id)?.object3d !== rebuiltHere;
      for (const child of all) {
        if (child.parentId === node.id) {
          buildBranch(child, rebuiltHere, wasRebuilt || entry?.object3d !== rebuiltHere);
        }
      }
    };

    for (const node of all) {
      if (node.parentId === null) buildBranch(node, runtime.objectsGroup, false);
    }

    // Ensure hierarchy order matches the plan (Three.js drawing order follows it).
    for (const node of all) {
      const entry = next.get(node.id);
      if (!entry) continue;
      const parentEntry = node.parentId ? next.get(node.parentId) : null;
      (parentEntry?.object3d ?? runtime.objectsGroup).add(entry.object3d);
    }

    // Dispose nodes that no longer exist in the plan.
    for (const [id, entry] of previous) {
      if (!next.has(id)) {
        entry.object3d.removeFromParent();
        disposeObject3D(entry.object3d);
      }
    }

    // A node whose parent vanished can no longer be reached from the roots.
    for (const node of all) {
      if (node.parentId !== null && !byId.has(node.parentId)) {
        const entry = next.get(node.id);
        entry?.object3d.removeFromParent();
      }
    }

    builtNodesRef.current = next;
    nodeObjectsRef.current = new Map(
      [...next.entries()].map(([id, entry]) => [id, entry.object3d]),
    );
    runtime.refreshOverlay();
  }, [plan.groups, plan.objects]);

  // Environment and lighting.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const current = planRef.current;
    const environment = current.environment;
    runtime.scene.background = new THREE.Color(environment.skyColor);
    runtime.scene.fog = new THREE.FogExp2(environment.fogColor, environment.fogDensity);
    runtime.sky.update(environment);
    clearObject3DGroup(runtime.lightsGroup);
    addEnvironmentLights(runtime.lightsGroup, environment, current.terrain.size);
    runtime.lightsGroup.traverse((child) => {
      if (child instanceof THREE.DirectionalLight) {
        const size = isNarrowViewport() ? 1024 : 2048;
        child.shadow.mapSize.set(size, size);
        child.shadow.map?.dispose();
        child.shadow.map = null;
      }
    });
  }, [plan.environment, plan.terrain.size]);

  // Gizmo mode / space / snapping.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const controls = runtime.transformControls;
    controls.setMode(tool);
    controls.setSpace(space);
    controls.translationSnap = snap ? 0.5 : null;
    controls.rotationSnap = snap ? THREE.MathUtils.degToRad(15) : null;
    controls.scaleSnap = snap ? 0.1 : null;
  }, [tool, space, snap]);

  // Axis constraint: X/Y/Z keys and toolbar buttons toggle gizmo handles.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const controls = runtime.transformControls;
    const filter = axes ?? ALL_AXES;
    controls.showX = filter.x;
    controls.showY = filter.y;
    controls.showZ = filter.z;
  }, [axes]);

  // Attach the gizmo to a single, editable primary selection.
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const controls = runtime.transformControls;
    const primary = selection.length === 1 ? selection[0] : null;
    const object = primary ? nodeObjectsRef.current.get(primary) : null;

    if (!primary || !object || isEffectivelyLocked(plan, primary)) {
      controls.detach();
      return;
    }
    if (!isEffectivelyVisible(plan, primary)) {
      controls.detach();
      return;
    }
    controls.attach(object);
    controls.setMode(tool);
    controls.setSpace(space);
  }, [selection, plan, tool, space]);

  // Frame a different world when one is opened.
  useEffect(() => {
    runtimeRef.current?.frameWorld();
  }, [plan.id]);

  // Frame requests from the toolbar and keyboard shortcuts.
  useEffect(() => {
    const frameWorld = () => runtimeRef.current?.frameWorld();
    const frameSelected = () =>
      runtimeRef.current?.frameSelection(selectionRef.current.length ? selectionRef.current : []);
    const focusSelected = () => {
      if (selectionRef.current.length > 0) frameSelected();
      else frameWorld();
    };
    window.addEventListener('worldbuilder:frame', frameWorld);
    window.addEventListener('worldbuilder:focus', focusSelected);
    return () => {
      window.removeEventListener('worldbuilder:frame', frameWorld);
      window.removeEventListener('worldbuilder:focus', focusSelected);
    };
  }, []);

  const handleFrame = () => {
    if (selection.length > 0) runtimeRef.current?.frameSelection(selection);
    else runtimeRef.current?.frameWorld();
  };

  const selectedCount = selection.length;

  return (
    <div className="viewport" ref={containerRef}>
      <div className="viewport-hud viewport-hud-top">
        <span className="hud-pill">
          <span className="hud-dot" />
          {plan.objects.length} objects
        </span>
        {plan.groups.length > 0 && (
          <span className="hud-pill hud-pill-subtle">
            {plan.groups.length} {plan.groups.length === 1 ? 'group' : 'groups'}
          </span>
        )}
        {selectedCount > 1 && (
          <span className="hud-pill hud-pill-accent">{selectedCount} selected</span>
        )}
        {profile && (
          <span
            className="hud-pill hud-pill-subtle viewport-gpu"
            title={
              `${profile.api === 'webgl2' ? 'WebGL 2' : 'WebGL'} · ${profile.gpu}` +
              ` · ${profile.vendor} · max texture ${profile.maxTextureSize}px`
            }
          >
            {profile.api === 'webgl2' ? 'WebGL 2' : 'WebGL'} · {stats.fps} fps · {stats.calls} draws
          </span>
        )}
      </div>

      <div className="viewport-hud viewport-hud-actions">
        <button
          type="button"
          className="icon-btn glass"
          onClick={handleFrame}
          title={selectedCount > 0 ? 'Frame selection (F)' : 'Frame world (F)'}
          aria-label={selectedCount > 0 ? 'Frame selection' : 'Frame world'}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-btn glass"
          onClick={() => window.dispatchEvent(new Event('worldbuilder:capture'))}
          title="Save a PNG of the current view"
          aria-label="Save viewport image"
        >
          <Icon name="camera" size={16} />
        </button>
      </div>

      {notice && <div className="viewport-notice">{notice}</div>}

      <div className="viewport-hint">
        <span className="desktop-only">
          Click to select · Shift-click to multi-select · G/R/S to transform · Drag to orbit ·
          Right-drag to pan · Scroll to zoom
        </span>
        <span className="mobile-only">
          Drag to orbit · Pinch to zoom · Tap to select · Use the toolbar to move, rotate or scale
        </span>
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
          <button
            type="button"
            className="btn btn-small"
            onClick={() => window.location.reload()}
          >
            <Icon name="redo" size={14} /> Retry
          </button>
        </div>
      )}
    </div>
  );
}
