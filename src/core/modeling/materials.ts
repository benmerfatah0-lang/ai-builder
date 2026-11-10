import * as THREE from 'three';
import { getModelTexture, type ModelTextureKind } from './textures';

/**
 * The shared surface library.
 *
 * A material id is a plain string carried in `MeshData.materials`, so geometry
 * stays renderable-agnostic and exportable, and the same id resolves to the same
 * cached `THREE.MeshStandardMaterial` everywhere. Two consequences the rest of
 * the pipeline depends on:
 *
 * 1. Identical ids share one material instance, so `mergeStaticMeshes` can
 *    collapse a whole castle into a handful of draw calls. Components therefore
 *    draw their colours from small palettes instead of randomising per part.
 * 2. `texel` is part of the surface, not of the model: it says how many metres
 *    of the real world one texture tile covers. Geometry multiplies its UVs by
 *    `1 / texel`, which is why a door frame and a curtain wall show brick of the
 *    same size. Consistent texel density is what makes separately generated
 *    assets look like one world.
 */

export interface SurfaceSpec {
  id: string;
  label: string;
  /** Arabic label, for the asset panels and for honest provenance reporting. */
  ar: string;
  texture: ModelTextureKind;
  /** Default tint, multiplied by the albedo map. */
  color: number;
  roughness: number;
  metalness: number;
  /** Metres of world surface covered by one texture tile. */
  texel: number;
  flatShading?: boolean;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
  emissive?: number;
  emissiveIntensity?: number;
  envMapIntensity?: number;
  /** Alpha cut-out, for leaves and fence slats that need to read as thin. */
  alphaTest?: number;
}

export const SURFACES: Record<string, SurfaceSpec> = {
  /* ---- masonry and earth ---- */
  'stone-rough': { id: 'stone-rough', label: 'Rough stone', ar: 'حجر خشن', texture: 'stone', color: 0x8d8579, roughness: 0.94, metalness: 0, texel: 1.1 },
  'stone-dressed': { id: 'stone-dressed', label: 'Dressed stone', ar: 'حجر مشذّب', texture: 'masonry', color: 0xb4a98f, roughness: 0.86, metalness: 0, texel: 1.6 },
  'stone-pale': { id: 'stone-pale', label: 'Pale limestone', ar: 'حجر جيري فاتح', texture: 'masonry', color: 0xd8cdb2, roughness: 0.84, metalness: 0, texel: 1.6 },
  granite: { id: 'granite', label: 'Granite', ar: 'غرانيت', texture: 'stone', color: 0x6f6a66, roughness: 0.88, metalness: 0.02, texel: 1.2 },
  sandstone: { id: 'sandstone', label: 'Sandstone', ar: 'حجر رملي', texture: 'masonry', color: 0xc08f5e, roughness: 0.9, metalness: 0, texel: 1.5 },
  brick: { id: 'brick', label: 'Fired brick', ar: 'طوب', texture: 'brick', color: 0xa8543c, roughness: 0.88, metalness: 0, texel: 1.2 },
  'brick-pale': { id: 'brick-pale', label: 'Pale brick', ar: 'طوب فاتح', texture: 'brick', color: 0xc9a882, roughness: 0.88, metalness: 0, texel: 1.2 },
  'concrete-block': { id: 'concrete-block', label: 'Concrete block', ar: 'بلوك خرساني', texture: 'block', color: 0x9a9a97, roughness: 0.92, metalness: 0, texel: 2 },
  concrete: { id: 'concrete', label: 'Concrete', ar: 'خرسانة', texture: 'stone', color: 0x8e8e8a, roughness: 0.93, metalness: 0, texel: 1.8 },
  marble: { id: 'marble', label: 'Polished marble', ar: 'رخام مصقول', texture: 'marble', color: 0xeae6dd, roughness: 0.28, metalness: 0.04, texel: 1.4, envMapIntensity: 1.1 },
  slate: { id: 'slate', label: 'Slate', ar: 'أردواز', texture: 'slate', color: 0x535a63, roughness: 0.7, metalness: 0.03, texel: 1.1 },
  plaster: { id: 'plaster', label: 'Lime plaster', ar: 'جص', texture: 'plaster', color: 0xe3d7bf, roughness: 0.92, metalness: 0, texel: 1.6 },
  'plaster-white': { id: 'plaster-white', label: 'Whitewash', ar: 'جير أبيض', texture: 'plaster', color: 0xf2ece0, roughness: 0.9, metalness: 0, texel: 1.6 },
  stucco: { id: 'stucco', label: 'Stucco', ar: 'قصارة', texture: 'stucco', color: 0xd6c3a3, roughness: 0.94, metalness: 0, texel: 1.4 },
  wattle: { id: 'wattle', label: 'Wattle and daub', ar: 'قضبان وطين', texture: 'wattle', color: 0xcbb694, roughness: 0.95, metalness: 0, texel: 1.5 },
  adobe: { id: 'adobe', label: 'Mud brick', ar: 'لبن', texture: 'stucco', color: 0xb08a5f, roughness: 0.97, metalness: 0, texel: 1.5 },
  paint: { id: 'paint', label: 'Painted surface', ar: 'سطح مطلي', texture: 'paint', color: 0xb9b2a4, roughness: 0.62, metalness: 0, texel: 1.4 },
  mortar: { id: 'mortar', label: 'Mortar', ar: 'ملاط', texture: 'plaster', color: 0xbdb6a6, roughness: 0.96, metalness: 0, texel: 0.9 },

  /* ---- timber ---- */
  'wood-oak': { id: 'wood-oak', label: 'Oak', ar: 'بلوط', texture: 'wood', color: 0x8a6134, roughness: 0.78, metalness: 0, texel: 1.2 },
  'wood-pine': { id: 'wood-pine', label: 'Pine', ar: 'صنوبر', texture: 'wood', color: 0xc39a5f, roughness: 0.8, metalness: 0, texel: 1.2 },
  'wood-dark': { id: 'wood-dark', label: 'Dark timber', ar: 'خشب داكن', texture: 'wood', color: 0x4e3620, roughness: 0.8, metalness: 0, texel: 1.2 },
  'wood-weathered': { id: 'wood-weathered', label: 'Weathered timber', ar: 'خشب متآكل', texture: 'plank', color: 0x7d7263, roughness: 0.92, metalness: 0, texel: 1.4 },
  'wood-painted': { id: 'wood-painted', label: 'Painted timber', ar: 'خشب مطلي', texture: 'plank', color: 0x6d7f6a, roughness: 0.66, metalness: 0, texel: 1.3 },
  plank: { id: 'plank', label: 'Planking', ar: 'ألواح', texture: 'plank', color: 0x9a7342, roughness: 0.82, metalness: 0, texel: 1.3 },
  log: { id: 'log', label: 'Log wall', ar: 'جذوع', texture: 'log', color: 0x8a6440, roughness: 0.9, metalness: 0, texel: 1.5 },
  bark: { id: 'bark', label: 'Bark', ar: 'لحاء', texture: 'bark', color: 0x5c4630, roughness: 0.96, metalness: 0, texel: 1 },
  'bark-birch': { id: 'bark-birch', label: 'Birch bark', ar: 'لحاء بتولا', texture: 'bark', color: 0xcfc6b4, roughness: 0.9, metalness: 0, texel: 1 },
  'bark-palm': { id: 'bark-palm', label: 'Palm fibre', ar: 'ليف النخيل', texture: 'bark', color: 0x8d7351, roughness: 0.95, metalness: 0, texel: 0.9 },

  /* ---- roofing ---- */
  'roof-tile': { id: 'roof-tile', label: 'Clay roof tile', ar: 'قرميد', texture: 'tile', color: 0xb0563a, roughness: 0.74, metalness: 0, texel: 1.1 },
  'roof-tile-grey': { id: 'roof-tile-grey', label: 'Grey roof tile', ar: 'قرميد رمادي', texture: 'tile', color: 0x7b7268, roughness: 0.78, metalness: 0, texel: 1.1 },
  'roof-slate': { id: 'roof-slate', label: 'Slate roof', ar: 'سقف أردواز', texture: 'slate', color: 0x4b5158, roughness: 0.72, metalness: 0.02, texel: 1 },
  thatch: { id: 'thatch', label: 'Thatch', ar: 'قش', texture: 'thatch', color: 0xc2a159, roughness: 0.98, metalness: 0, texel: 1.2 },
  shingle: { id: 'shingle', label: 'Wood shingle', ar: 'لوح خشبي', texture: 'shingle', color: 0x7a5c3c, roughness: 0.9, metalness: 0, texel: 1.1 },
  lead: { id: 'lead', label: 'Lead sheet', ar: 'رصاص', texture: 'metal', color: 0x6b6f73, roughness: 0.55, metalness: 0.8, texel: 1.4 },

  /* ---- metals ---- */
  'iron-wrought': { id: 'iron-wrought', label: 'Wrought iron', ar: 'حديد مطاوع', texture: 'metal', color: 0x3d3b39, roughness: 0.52, metalness: 0.85, texel: 0.8 },
  'iron-rusted': { id: 'iron-rusted', label: 'Rusted iron', ar: 'حديد صدئ', texture: 'riveted', color: 0x7a4a2c, roughness: 0.86, metalness: 0.42, texel: 1 },
  steel: { id: 'steel', label: 'Steel', ar: 'فولاذ', texture: 'metal', color: 0x9aa0a6, roughness: 0.3, metalness: 0.95, texel: 0.9, envMapIntensity: 1.2 },
  'steel-blade': { id: 'steel-blade', label: 'Blade steel', ar: 'فولاذ النصل', texture: 'metal', color: 0xc8ced4, roughness: 0.16, metalness: 1, texel: 0.5, envMapIntensity: 1.4 },
  brass: { id: 'brass', label: 'Brass', ar: 'نحاس أصفر', texture: 'metal', color: 0xc39b4a, roughness: 0.28, metalness: 0.95, texel: 0.7, envMapIntensity: 1.2 },
  copper: { id: 'copper', label: 'Copper', ar: 'نحاس', texture: 'hammered', color: 0xb06a3c, roughness: 0.34, metalness: 0.92, texel: 0.8 },
  'copper-patina': { id: 'copper-patina', label: 'Patinated copper', ar: 'نحاس مؤكسد', texture: 'hammered', color: 0x5f8f7a, roughness: 0.66, metalness: 0.6, texel: 0.9 },
  bronze: { id: 'bronze', label: 'Bronze', ar: 'برونز', texture: 'hammered', color: 0x8c6f3e, roughness: 0.38, metalness: 0.9, texel: 0.8 },
  gold: { id: 'gold', label: 'Gilt', ar: 'مذهّب', texture: 'metal', color: 0xd8b451, roughness: 0.2, metalness: 1, texel: 0.6, envMapIntensity: 1.5 },
  tin: { id: 'tin', label: 'Tin', ar: 'قصدير', texture: 'hammered', color: 0xb6b9bb, roughness: 0.36, metalness: 0.9, texel: 0.7 },
  chain: { id: 'chain', label: 'Chain', ar: 'سلسلة', texture: 'chain', color: 0x55524e, roughness: 0.5, metalness: 0.85, texel: 0.35 },
  riveted: { id: 'riveted', label: 'Riveted plate', ar: 'صفائح مسمّرة', texture: 'riveted', color: 0x5a5f63, roughness: 0.48, metalness: 0.88, texel: 1.2 },

  /* ---- soft goods ---- */
  leather: { id: 'leather', label: 'Leather', ar: 'جلد', texture: 'leather', color: 0x6b4326, roughness: 0.72, metalness: 0, texel: 0.7 },
  'leather-dark': { id: 'leather-dark', label: 'Black leather', ar: 'جلد أسود', texture: 'leather', color: 0x2f2620, roughness: 0.68, metalness: 0, texel: 0.7 },
  fabric: { id: 'fabric', label: 'Woven cloth', ar: 'قماش', texture: 'fabric', color: 0x8e3b34, roughness: 0.92, metalness: 0, texel: 0.8 },
  'fabric-linen': { id: 'fabric-linen', label: 'Linen', ar: 'كتان', texture: 'fabric', color: 0xd9cdb2, roughness: 0.94, metalness: 0, texel: 0.8 },
  'fabric-blue': { id: 'fabric-blue', label: 'Indigo cloth', ar: 'قماش نيلي', texture: 'fabric', color: 0x35507a, roughness: 0.92, metalness: 0, texel: 0.8 },
  velvet: { id: 'velvet', label: 'Velvet', ar: 'قطيفة', texture: 'fur', color: 0x6d1f2c, roughness: 0.98, metalness: 0, texel: 0.6 },
  rope: { id: 'rope', label: 'Rope', ar: 'حبل', texture: 'rope', color: 0xb39a68, roughness: 0.95, metalness: 0, texel: 0.4 },
  fur: { id: 'fur', label: 'Fur', ar: 'فراء', texture: 'fur', color: 0x6d5540, roughness: 0.97, metalness: 0, texel: 0.6 },
  'fur-white': { id: 'fur-white', label: 'White fur', ar: 'فراء أبيض', texture: 'fur', color: 0xd9d3c8, roughness: 0.97, metalness: 0, texel: 0.6 },
  wool: { id: 'wool', label: 'Wool', ar: 'صوف', texture: 'fur', color: 0xcfc4ae, roughness: 0.99, metalness: 0, texel: 0.5 },

  /* ---- organic ---- */
  bone: { id: 'bone', label: 'Bone', ar: 'عظم', texture: 'bone', color: 0xd9cdb0, roughness: 0.62, metalness: 0, texel: 0.5 },
  horn: { id: 'horn', label: 'Horn', ar: 'قرن', texture: 'horn', color: 0x6b5a3f, roughness: 0.55, metalness: 0.02, texel: 0.5 },
  scale: { id: 'scale', label: 'Scales', ar: 'حراشف', texture: 'scale', color: 0x4a6b4a, roughness: 0.5, metalness: 0.08, texel: 0.5 },
  'scale-dark': { id: 'scale-dark', label: 'Dark scales', ar: 'حراشف داكنة', texture: 'scale', color: 0x2c3138, roughness: 0.48, metalness: 0.1, texel: 0.5 },
  feather: { id: 'feather', label: 'Feathers', ar: 'ريش', texture: 'feather', color: 0x8d8578, roughness: 0.85, metalness: 0, texel: 0.4 },
  hide: { id: 'hide', label: 'Hide', ar: 'جلد حيوان', texture: 'leather', color: 0x8a6a4c, roughness: 0.88, metalness: 0, texel: 0.8 },
  foliage: { id: 'foliage', label: 'Foliage', ar: 'أوراق', texture: 'foliage', color: 0x4d7a35, roughness: 0.86, metalness: 0, texel: 0.7 },
  'foliage-dark': { id: 'foliage-dark', label: 'Dark foliage', ar: 'أوراق داكنة', texture: 'foliage', color: 0x2f5230, roughness: 0.88, metalness: 0, texel: 0.7 },
  'foliage-olive': { id: 'foliage-olive', label: 'Olive foliage', ar: 'أوراق زيتون', texture: 'foliage', color: 0x77804a, roughness: 0.9, metalness: 0, texel: 0.7 },
  'foliage-palm': { id: 'foliage-palm', label: 'Palm fronds', ar: 'سعف النخيل', texture: 'foliage', color: 0x5c7a3a, roughness: 0.88, metalness: 0, texel: 0.8 },
  grass: { id: 'grass', label: 'Grass', ar: 'عشب', texture: 'grass', color: 0x5f8b41, roughness: 0.92, metalness: 0, texel: 0.6 },
  moss: { id: 'moss', label: 'Moss', ar: 'طحلب', texture: 'grass', color: 0x4c6b34, roughness: 0.97, metalness: 0, texel: 0.4 },

  /* ---- glass, crystal, ground ---- */
  glass: { id: 'glass', label: 'Glass', ar: 'زجاج', texture: 'glass', color: 0xbcd2d8, roughness: 0.08, metalness: 0.1, texel: 1, transparent: true, opacity: 0.42, envMapIntensity: 1.6, side: THREE.DoubleSide },
  'glass-warm': { id: 'glass-warm', label: 'Lit glass', ar: 'زجاج مضاء', texture: 'glass', color: 0xffd79a, roughness: 0.2, metalness: 0, texel: 1, transparent: true, opacity: 0.6, emissive: 0xffb347, emissiveIntensity: 0.55 },
  crystal: { id: 'crystal', label: 'Crystal', ar: 'بلور', texture: 'crystal', color: 0x7fd4e8, roughness: 0.12, metalness: 0.2, texel: 0.8, transparent: true, opacity: 0.78, emissive: 0x2b7f9c, emissiveIntensity: 0.35, envMapIntensity: 1.5 },
  'crystal-violet': { id: 'crystal-violet', label: 'Violet crystal', ar: 'بلور بنفسجي', texture: 'crystal', color: 0xa06ce0, roughness: 0.14, metalness: 0.2, texel: 0.8, transparent: true, opacity: 0.8, emissive: 0x5a2b8c, emissiveIntensity: 0.4 },
  gem: { id: 'gem', label: 'Gemstone', ar: 'حجر كريم', texture: 'crystal', color: 0x2f7de0, roughness: 0.06, metalness: 0.1, texel: 0.3, envMapIntensity: 1.8 },
  ceramic: { id: 'ceramic', label: 'Glazed ceramic', ar: 'خزف', texture: 'ceramic', color: 0xd8d2c4, roughness: 0.24, metalness: 0.02, texel: 0.8 },
  'ceramic-blue': { id: 'ceramic-blue', label: 'Blue glazed tile', ar: 'قيشاني أزرق', texture: 'ceramic', color: 0x2f5f9c, roughness: 0.2, metalness: 0.04, texel: 0.7 },
  terracotta: { id: 'terracotta', label: 'Terracotta', ar: 'فخار', texture: 'ceramic', color: 0xb06a44, roughness: 0.72, metalness: 0, texel: 0.8 },
  rubber: { id: 'rubber', label: 'Rubber', ar: 'مطاط', texture: 'rubber', color: 0x232323, roughness: 0.88, metalness: 0, texel: 0.7 },
  sand: { id: 'sand', label: 'Sand', ar: 'رمل', texture: 'sand', color: 0xd9c48f, roughness: 0.96, metalness: 0, texel: 1.2 },
  soil: { id: 'soil', label: 'Soil', ar: 'تربة', texture: 'soil', color: 0x6b5138, roughness: 0.97, metalness: 0, texel: 1 },
  gravel: { id: 'gravel', label: 'Gravel', ar: 'حصى', texture: 'gravel', color: 0x8b8378, roughness: 0.95, metalness: 0, texel: 1 },
  cobble: { id: 'cobble', label: 'Cobblestone', ar: 'حجر مرصوف', texture: 'gravel', color: 0x77716a, roughness: 0.9, metalness: 0, texel: 1.4 },
};

export type SurfaceId = keyof typeof SURFACES | (string & {});

const FALLBACK: SurfaceSpec = {
  id: 'stone-rough',
  label: 'Rough stone',
  ar: 'حجر خشن',
  texture: 'stone',
  color: 0x9a938a,
  roughness: 0.9,
  metalness: 0,
  texel: 1.2,
};

/** Resolves a surface id, falling back to rough stone instead of throwing. */
export function getSurface(id: string | undefined | null): SurfaceSpec {
  if (!id) return FALLBACK;
  return SURFACES[id] ?? FALLBACK;
}

/** Metres per texture tile for a surface — the number geometry scales UVs by. */
export function surfaceTexel(id: string): number {
  return getSurface(id).texel;
}

export interface MaterialOverrides {
  /** Overrides the surface tint; use sparingly so materials stay shared. */
  color?: number | string;
  roughness?: number;
  metalness?: number;
  opacity?: number;
  flatShading?: boolean;
  emissive?: number;
  emissiveIntensity?: number;
  side?: THREE.Side;
}

const materials = new Map<string, THREE.MeshStandardMaterial>();

function keyOf(id: string, overrides: MaterialOverrides): string {
  const color = overrides.color === undefined ? '' : new THREE.Color(overrides.color as THREE.ColorRepresentation).getHexString();
  return [
    id,
    color,
    overrides.roughness ?? '',
    overrides.metalness ?? '',
    overrides.opacity ?? '',
    overrides.flatShading ? 'flat' : '',
    overrides.emissive ?? '',
    overrides.emissiveIntensity ?? '',
    overrides.side ?? '',
  ].join('|');
}

/**
 * The cached material for a surface id.
 *
 * Caching is what keeps draw calls down: `mergeStaticMeshes` groups by
 * `material.uuid`, so ten oak beams must resolve to one instance, not ten.
 */
export function getModelMaterial(id: string, overrides: MaterialOverrides = {}): THREE.MeshStandardMaterial {
  const key = keyOf(id, overrides);
  const cached = materials.get(key);
  if (cached) return cached;
  const spec = getSurface(id);
  const texture = getModelTexture(spec.texture);
  const material = new THREE.MeshStandardMaterial({
    name: key,
    color: new THREE.Color(overrides.color ?? spec.color),
    roughness: overrides.roughness ?? spec.roughness,
    metalness: overrides.metalness ?? spec.metalness,
    map: texture.map,
    normalMap: texture.normalMap,
    roughnessMap: texture.roughnessMap,
    normalScale: new THREE.Vector2(texture.normalScale, texture.normalScale),
    flatShading: overrides.flatShading ?? spec.flatShading ?? false,
    side: overrides.side ?? spec.side ?? THREE.FrontSide,
    transparent: spec.transparent ?? false,
    opacity: overrides.opacity ?? spec.opacity ?? 1,
    emissive: new THREE.Color(overrides.emissive ?? spec.emissive ?? 0x000000),
    emissiveIntensity: overrides.emissiveIntensity ?? spec.emissiveIntensity ?? 1,
    envMapIntensity: spec.envMapIntensity ?? 1,
    alphaTest: spec.alphaTest ?? 0,
  });
  materials.set(key, material);
  return material;
}

/** An ordered material array for a mesh's groups, ready for `THREE.Mesh`. */
export function materialsFor(ids: readonly string[]): THREE.Material[] {
  return ids.map((id) => getModelMaterial(id));
}

/** Every cached material instance, for tests and for export bookkeeping. */
export function cachedModelMaterials(): THREE.MeshStandardMaterial[] {
  return [...materials.values()];
}

/**
 * Small fixed palettes.
 *
 * Components must not invent a colour per part: each distinct tint is another
 * material and another draw call. Picking from a palette keeps a village to a
 * handful of surfaces while still varying house to house.
 */
export const PALETTES = {
  wallStone: ['stone-dressed', 'stone-pale', 'sandstone', 'granite', 'stone-rough'],
  wallPlaster: ['plaster', 'plaster-white', 'stucco', 'wattle', 'adobe'],
  wallBrick: ['brick', 'brick-pale', 'concrete-block'],
  timber: ['wood-oak', 'wood-dark', 'wood-pine', 'wood-weathered', 'wood-painted'],
  roof: ['roof-tile', 'roof-tile-grey', 'roof-slate', 'thatch', 'shingle', 'lead'],
  metal: ['iron-wrought', 'steel', 'brass', 'copper', 'tin', 'iron-rusted'],
  blade: ['steel-blade', 'steel', 'iron-wrought'],
  ground: ['soil', 'gravel', 'cobble', 'sand', 'grass'],
  foliage: ['foliage', 'foliage-dark', 'foliage-olive', 'foliage-palm'],
  cloth: ['fabric', 'fabric-linen', 'fabric-blue', 'velvet'],
  organic: ['bone', 'horn', 'hide', 'fur', 'wool', 'leather'],
  crystal: ['crystal', 'crystal-violet', 'gem', 'glass'],
} as const satisfies Record<string, readonly string[]>;

/** Deterministic pick from a palette, so a seed always yields the same surface. */
export function pickSurface(palette: readonly string[], roll: number): string {
  const list = palette.length ? palette : PALETTES.wallStone;
  const index = Math.abs(Math.floor(roll * list.length)) % list.length;
  return list[index]!;
}

/** A tint that varies within one surface without creating a new material id. */
export function tintVariant(base: number, roll: number, spread = 0.12): number {
  const color = new THREE.Color(base);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  const light = Math.max(0.08, Math.min(0.94, hsl.l + (roll - 0.5) * 2 * spread));
  color.setHSL(hsl.h, hsl.s, light);
  return color.getHex();
}
