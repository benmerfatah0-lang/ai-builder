import * as THREE from 'three';

/**
 * WebGL bootstrap for the editor viewport.
 *
 * Three.js r186 renders through WebGL 2 only. This module:
 *  - creates the context with progressively simpler attributes so devices that
 *    reject antialiasing or `high-performance` still get a working viewport,
 *  - reports the real GPU and API so the UI can prove what is rendering,
 *  - configures colour management, tone mapping and shadows consistently.
 */

export interface RendererProfile {
  api: 'webgl2' | 'webgl1';
  gpu: string;
  vendor: string;
  antialias: boolean;
  maxTextureSize: number;
}

export class WebGLUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGLUnavailableError';
  }
}

const ATTEMPTS: THREE.WebGLRendererParameters[] = [
  { antialias: true, powerPreference: 'high-performance' },
  { antialias: true },
  { antialias: false, powerPreference: 'default', failIfMajorPerformanceCaveat: false },
];

function configure(renderer: THREE.WebGLRenderer, narrow: boolean): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, narrow ? 1.65 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.info.autoReset = true;
}

function readProfile(renderer: THREE.WebGLRenderer, antialias: boolean): RendererProfile {
  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_RENDERER_WEBGL: number;
    UNMASKED_VENDOR_WEBGL: number;
  } | null;

  const gpu = debug
    ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? 'Unknown GPU')
    : 'Browser-protected GPU';
  const vendor = debug
    ? String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? 'Unknown vendor')
    : 'Unknown vendor';

  const isWebGL2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

  return {
    api: isWebGL2 ? 'webgl2' : 'webgl1',
    gpu,
    vendor,
    antialias,
    maxTextureSize: renderer.capabilities.maxTextureSize,
  };
}

function explainFailure(error: unknown): string {
  const detail = error instanceof Error && error.message ? ` (${error.message})` : '';
  return (
    'This browser could not create a WebGL 2 context, which the 3D viewport needs. ' +
    'Enable hardware acceleration / WebGL in the browser settings and reload.' +
    detail
  );
}

export function createViewportRenderer(narrow: boolean): {
  renderer: THREE.WebGLRenderer;
  profile: RendererProfile;
} {
  let lastError: unknown = null;
  for (const attempt of ATTEMPTS) {
    try {
      const renderer = new THREE.WebGLRenderer(attempt);
      configure(renderer, narrow);
      return {
        renderer,
        profile: readProfile(renderer, attempt.antialias !== false),
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw new WebGLUnavailableError(explainFailure(lastError));
}

/**
 * Render once and grab the framebuffer as a PNG. Called synchronously after
 * `render`, so the drawing buffer is still intact without `preserveDrawingBuffer`
 * (which costs performance on every frame).
 */
export async function captureViewportPng(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): Promise<Blob> {
  renderer.render(scene, camera);
  const canvas = renderer.domElement;
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), 'image/png');
  });
  if (!blob) throw new Error('The browser could not encode the viewport image.');
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** True when the environment can plausibly create a WebGL 2 context. */
export function isWebGLAvailable(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (typeof WebGL2RenderingContext === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}
