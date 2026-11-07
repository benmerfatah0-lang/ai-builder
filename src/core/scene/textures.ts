import * as THREE from 'three';

/** Small seamless, locally generated textures shared by every scene object. */
export type SurfaceTexture = 'grass' | 'sand' | 'stone' | 'masonry' | 'wood' | 'bark' | 'roof' | 'plaster' | 'soil' | 'foliage';
const SIZE = 128;
const cache = new Map<SurfaceTexture, THREE.DataTexture>();

function noise(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed * 101, 374761393) + Math.imul(y + seed * 71, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/**
 * Neutral grayscale maps preserve the colours chosen in the inspector. Power of
 * two dimensions, repeat wrapping and mipmaps keep them economical on phones.
 * The finite cache is intentional: individual scene nodes must not dispose a
 * map while another node is still using it. No network or canvas is needed.
 */
export function getSurfaceTexture(kind: SurfaceTexture): THREE.DataTexture {
  const cached = cache.get(kind);
  if (cached) return cached;
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const fine = noise(x, y, 7) - 0.5;
      const coarse = noise(Math.floor(x / 4), Math.floor(y / 4), 19) - 0.5;
      let value = 235;
      switch (kind) {
        case 'grass':
          value = 230 + fine * 26 + coarse * 18 + 5 * Math.sin((x + y * 2) * Math.PI / 8);
          break;
        case 'sand':
          value = 239 + fine * 20 + 5 * Math.sin((y + 2 * Math.sin(x * Math.PI / 16)) * Math.PI / 8);
          break;
        case 'stone':
          value = 234 + fine * 24 + coarse * 20;
          break;
        case 'masonry': {
          const row = Math.floor(y / 32);
          const joint = y % 32 < 2 || (x + (row % 2) * 32) % 64 < 2;
          value = (joint ? 188 : 236) + fine * 16 + coarse * 14;
          break;
        }
        case 'wood': {
          const seam = x % 32 < 2;
          value = (seam ? 188 : 235) + 9 * Math.sin(x * Math.PI / 4 + Math.sin(y * Math.PI / 16)) + fine * 13;
          break;
        }
        case 'bark':
          value = 224 + 15 * Math.sin(x * Math.PI / 4 + Math.sin(y * Math.PI / 16)) + coarse * 12 + fine * 12;
          break;
        case 'roof': {
          const row = Math.floor(y / 16);
          const seam = y % 16 < 2 || (x + (row % 2) * 8) % 16 < 1;
          value = (seam ? 188 : 237) + fine * 12 + coarse * 8;
          break;
        }
        case 'plaster':
          value = 238 + fine * 12 + coarse * 10;
          break;
        case 'soil':
          value = 229 + fine * 27 + coarse * 18 + 5 * Math.sin(x * Math.PI / 4);
          break;
        case 'foliage':
          value = 232 + fine * 14 + coarse * 18;
          break;
      }
      const shade = Math.max(0, Math.min(255, Math.round(value)));
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, SIZE, SIZE, THREE.RGBAFormat);
  texture.name = `procedural-${kind}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  const repeat = kind === 'grass' || kind === 'sand' ? 18 : kind === 'soil' ? 4 : 2;
  texture.repeat.set(repeat, repeat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 2;
  texture.needsUpdate = true;
  cache.set(kind, texture);
  return texture;
}
